import type { KeeperHubClient, SettlementCall } from "../keeperhub.js";
import { compareIntents, intentHash, laneKey, writesOverlap, type Intent } from "./intent.js";
import type { AuditEntry, Decision, LaneStore } from "./store.js";

export interface FirewallOptions {
  /** An in-flight execution older than this quarantines its lane. */
  stuckAfterMs?: number;
  now?: () => number;
}

export interface SubmitResult {
  decision: "queued" | "duplicate" | "superseded" | "rejected-quarantined";
  reason?: string;
  /** Queued intents this submission displaced. */
  supersededIds?: string[];
}

export interface Action {
  laneKey: string;
  intentId: string;
  decision: Decision;
  reason?: string;
  executionId?: string;
  txHash?: string;
}

const DEFAULT_STUCK_AFTER_MS = 180_000;

/**
 * An admission gate in front of KeeperHub for agents that share a sender key.
 *
 * The problem it solves is not duplicate retries — KeeperHub's idempotency key
 * already covers those, which is why the nonce is deliberately excluded from it.
 * The problem is *distinct* intents submitted concurrently on one key. Each
 * broadcast is assigned a nonce from the key's current state; two that are
 * assigned before either lands get the same nonce, and one is silently dropped or
 * replaced depending on gas price. Both submitters see a successful submission.
 * One payment vanishes.
 *
 * The firewall makes that unrepresentable: at most one intent per lane may be in
 * flight, the lease is durable, and admission order is a pure function of the
 * queue rather than of arrival timing.
 */
export class NonceFirewall {
  private readonly stuckAfterMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: LaneStore,
    private readonly client: KeeperHubClient,
    options: FirewallOptions = {},
  ) {
    this.stuckAfterMs = options.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
  }

  submit(intent: Intent): SubmitResult {
    const key = laneKey(intent);
    const lane = this.store.lane(key);

    if (lane.quarantine) {
      return this.log(
        { laneKey: key, intentId: intent.id, decision: "rejected-quarantined", reason: lane.quarantine.reason },
        { decision: "rejected-quarantined", reason: lane.quarantine.reason },
      );
    }

    // A resubmission is not a second intent. Matching on the effect hash as well
    // as the id catches the same call queued twice under different ids.
    const hash = intentHash(intent);
    if (lane.inFlight?.intentId === intent.id || lane.inFlight?.intentHash === hash) {
      return { decision: "duplicate", reason: "already in flight" };
    }
    if (lane.queued.some((queued) => queued.id === intent.id || intentHash(queued) === hash)) {
      return { decision: "duplicate", reason: "already queued" };
    }

    // Supersession is restricted to the same submitter on purpose. A stale
    // rebalance from agent A should not execute after A's fresher one — but A
    // must never be able to cancel agent B's queued work by naming the same
    // resource, so overlapping writes across submitters serialize instead.
    const superseded = lane.queued.filter(
      (queued) =>
        queued.submitter === intent.submitter &&
        queued.submittedAtMs <= intent.submittedAtMs &&
        writesOverlap(queued, intent).length > 0,
    );
    for (const stale of superseded) {
      this.store.record({
        atMs: this.now(),
        laneKey: key,
        intentId: stale.id,
        decision: "superseded",
        reason: `superseded by ${intent.id} on ${writesOverlap(stale, intent).join(", ")}`,
      });
    }
    lane.queued = lane.queued.filter((queued) => !superseded.includes(queued));
    lane.queued.push(intent);
    this.store.record({ atMs: this.now(), laneKey: key, intentId: intent.id, decision: "queued" });
    this.store.flush();

    return superseded.length > 0
      ? { decision: "superseded", supersededIds: superseded.map((stale) => stale.id) }
      : { decision: "queued" };
  }

  /** Admits at most one intent per lane — the lease is exclusive by definition. */
  async drain(): Promise<Action[]> {
    const actions: Action[] = [];

    for (const key of this.store.laneKeys()) {
      const lane = this.store.lane(key);
      if (lane.quarantine || lane.inFlight || lane.queued.length === 0) continue;

      const next = [...lane.queued].sort(compareIntents)[0];
      if (!next) continue;

      const call = toCall(next);
      const simulation = await this.client.simulate(call);

      if (!simulation.ok) {
        actions.push(this.reject(key, next, "rejected-simulation", simulation.revertReason ?? "reverted"));
        continue;
      }
      if (next.gasCeiling !== undefined && simulation.gasEstimate !== undefined) {
        const estimate = BigInt(simulation.gasEstimate);
        if (estimate > next.gasCeiling) {
          actions.push(
            this.reject(key, next, "rejected-gas-ceiling", `${estimate} > ceiling ${next.gasCeiling}`),
          );
          continue;
        }
      }

      // The intent hash is the idempotency key: same effect, same key, replayed
      // rather than rebroadcast if this admission is retried.
      const handle = await this.client.execute(call, intentHash(next));
      lane.queued = lane.queued.filter((queued) => queued.id !== next.id);
      lane.inFlight = {
        intentId: next.id,
        intentHash: intentHash(next),
        executionId: handle.executionId,
        admittedAtMs: this.now(),
      };
      this.store.record({
        atMs: this.now(),
        laneKey: key,
        intentId: next.id,
        decision: "admitted",
        executionId: handle.executionId,
      });
      this.store.flush();
      actions.push({ laneKey: key, intentId: next.id, decision: "admitted", executionId: handle.executionId });
    }

    return actions;
  }

  /** Resolves in-flight executions and quarantines lanes whose lease has gone stale. */
  async poll(): Promise<Action[]> {
    const actions: Action[] = [];

    for (const key of this.store.laneKeys()) {
      const lane = this.store.lane(key);
      const inFlight = lane.inFlight;
      if (!inFlight) continue;

      const status = await this.client.status(inFlight.executionId);

      if (status.state === "pending") {
        if (this.now() - inFlight.admittedAtMs <= this.stuckAfterMs) continue;

        // Quarantine refuses new admissions; it does not clear the lease. The
        // transaction may still land, and releasing the lane here would admit a
        // second intent onto the same nonce — the exact failure being prevented.
        const reason = `execution ${inFlight.executionId} pending beyond ${this.stuckAfterMs}ms`;
        lane.quarantine = { reason, sinceMs: this.now(), intentId: inFlight.intentId };
        this.store.record({ atMs: this.now(), laneKey: key, intentId: inFlight.intentId, decision: "quarantined", reason });
        this.store.flush();
        actions.push({ laneKey: key, intentId: inFlight.intentId, decision: "quarantined", reason });
        continue;
      }

      const decision: Decision = status.state === "confirmed" ? "settled" : "failed";
      delete lane.inFlight;
      const entry: AuditEntry = {
        atMs: this.now(),
        laneKey: key,
        intentId: inFlight.intentId,
        decision,
        executionId: inFlight.executionId,
        ...(status.txHash ? { txHash: status.txHash } : {}),
        ...(status.error ? { reason: status.error } : {}),
      };
      this.store.record(entry);
      this.store.flush();
      actions.push({
        laneKey: key,
        intentId: inFlight.intentId,
        decision,
        executionId: inFlight.executionId,
        ...(status.txHash ? { txHash: status.txHash } : {}),
      });
    }

    return actions;
  }

  /** Operator override once a stuck execution has been resolved out of band. */
  clearQuarantine(key: string, note: string): void {
    const lane = this.store.lane(key);
    if (!lane.quarantine) return;
    delete lane.quarantine;
    delete lane.inFlight;
    this.store.record({ atMs: this.now(), laneKey: key, intentId: "-", decision: "queued", reason: `quarantine cleared: ${note}` });
    this.store.flush();
  }

  private reject(key: string, intent: Intent, decision: Decision, reason: string): Action {
    const lane = this.store.lane(key);
    lane.queued = lane.queued.filter((queued) => queued.id !== intent.id);
    this.store.record({ atMs: this.now(), laneKey: key, intentId: intent.id, decision, reason });
    this.store.flush();
    return { laneKey: key, intentId: intent.id, decision, reason };
  }

  private log(entry: Omit<AuditEntry, "atMs">, result: SubmitResult): SubmitResult {
    this.store.record({ atMs: this.now(), ...entry });
    this.store.flush();
    return result;
  }
}

function toCall(intent: Intent): SettlementCall {
  return {
    network: intent.chainId.toString(10),
    chainId: intent.chainId,
    contractAddress: intent.call.contractAddress,
    functionName: intent.call.functionName,
    args: intent.call.args,
    abi: intent.call.abi,
  };
}
