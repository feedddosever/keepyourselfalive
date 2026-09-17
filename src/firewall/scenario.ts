import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceFirewall } from "./firewall.js";
import type { Intent } from "./intent.js";
import { LaneStore, type AuditEntry } from "./store.js";
import type {
  ExecutionHandle,
  ExecutionStatus,
  KeeperHubClient,
  SettlementCall,
  SimulationResult,
} from "../keeperhub.js";

export interface ScenarioStep {
  title: string;
  lines: string[];
  note?: string;
}

export interface ScenarioResult {
  steps: ScenarioStep[];
  audit: AuditEntry[];
  broadcasts: number;
  submitted: number;
}

/**
 * Stands in for KeeperHub so the admission decisions can be watched without an
 * API key. The decisions are the real ones — this only replaces the transport.
 */
class ScriptedKeeperHub implements KeeperHubClient {
  broadcasts = 0;
  gasEstimate = "50000";
  private statuses = new Map<string, ExecutionStatus>();
  private stuck = new Set<string>();

  async simulate(): Promise<SimulationResult> {
    return { ok: true, gasEstimate: this.gasEstimate, via: "keeperhub" };
  }

  async execute(_call: SettlementCall, _key: string): Promise<ExecutionHandle> {
    this.broadcasts += 1;
    const executionId = `exec-${this.broadcasts}`;
    this.statuses.set(executionId, { state: "pending" });
    return { executionId, idempotencyEnforcedRemotely: true };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    if (this.stuck.has(executionId)) return { state: "pending" };
    return this.statuses.get(executionId) ?? { state: "failed", error: "unknown" };
  }

  confirm(executionId: string): void {
    this.statuses.set(executionId, { state: "confirmed", txHash: `0x${executionId.padEnd(40, "0")}` });
  }

  wedge(executionId: string): void {
    this.stuck.add(executionId);
  }
}

const SENDER = "0x00000000000000000000000000000000000000f1";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function intent(id: string, submitter: string, writes: string[], extra: Partial<Intent> = {}): Intent {
  return {
    id,
    submitter,
    chainId: 84532,
    sender: SENDER,
    call: { contractAddress: TOKEN, functionName: "transfer", args: [id, "1"], abi: ABI },
    writes,
    submittedAtMs: Date.now(),
    ...extra,
  };
}

export async function runScenario(): Promise<ScenarioResult> {
  const client = new ScriptedKeeperHub();
  const store = new LaneStore(join(mkdtempSync(join(tmpdir(), "firewall-")), "lanes.json"));
  let clock = Date.now();
  const firewall = new NonceFirewall(store, client, { now: () => clock, stuckAfterMs: 60_000 });
  const steps: ScenarioStep[] = [];
  let submitted = 0;

  const lines: string[] = [];
  for (let i = 1; i <= 6; i += 1) {
    submitted += 1;
    lines.push(`agent-${i} → ${firewall.submit(intent(`payout-${i}`, `agent-${i}`, [`invoice-${i}`])).decision}`);
  }
  let actions = await firewall.drain();
  lines.push(`drain admitted ${actions.length}, broadcast count ${client.broadcasts}`);
  steps.push({
    title: "Six agents submit at once against one treasury key",
    lines,
    note: "Without the lease, all six would be assigned the same nonce and five payments would vanish.",
  });

  await firewall.drain();
  await firewall.drain();
  steps.push({
    title: "Draining again while the lease is held changes nothing",
    lines: [`broadcast count still ${client.broadcasts}`],
    note: "The lease is durable, so a restarted scheduler sees it too.",
  });

  client.confirm("exec-1");
  const resolved = (await firewall.poll()).map((a) => `${a.intentId} → ${a.decision}`);
  actions = await firewall.drain();
  steps.push({
    title: "The lease releases only when the transaction resolves",
    lines: [...resolved, `next admitted: ${actions[0]?.intentId}, broadcast count ${client.broadcasts}`],
    note: "Admission order is priority then intent hash — never arrival time.",
  });

  submitted += 2;
  firewall.submit(intent("rebalance-stale", "agent-7", ["pool:eth-usdc"], { submittedAtMs: clock }));
  const superseded = firewall.submit(
    intent("rebalance-fresh", "agent-7", ["pool:eth-usdc"], { submittedAtMs: clock + 1 }),
  );
  steps.push({
    title: "A stale intent is superseded by its own submitter's fresher one",
    lines: [`${superseded.decision}: dropped ${superseded.supersededIds?.join(", ")}`],
    note: "A different agent naming the same resource would queue, not cancel. One agent can never revoke another's work.",
  });

  client.gasEstimate = "1200000";
  submitted += 1;
  firewall.submit(intent("runaway", "agent-8", ["invoice-8"], { gasCeiling: 150_000n, priority: -5 }));
  client.confirm("exec-2");
  await firewall.poll();
  const rejected = (await firewall.drain()).map((a) => `${a.intentId} → ${a.decision} (${a.reason})`);
  steps.push({
    title: "A gas ceiling is enforced before broadcast, not after",
    lines: [...rejected, `broadcast count ${client.broadcasts} — the rejected intent never reached the chain`],
  });

  client.gasEstimate = "50000";
  await firewall.drain();
  client.wedge(`exec-${client.broadcasts}`);
  clock += 61_000;
  const quarantined = (await firewall.poll()).map((a) => `${a.intentId} → ${a.decision}`);
  submitted += 1;
  const refused = firewall.submit(intent("after-wedge", "agent-9", ["invoice-9"]));
  const before = client.broadcasts;
  await firewall.drain();
  steps.push({
    title: "A wedged transaction quarantines its lane instead of stacking nonces",
    lines: [
      ...quarantined,
      `new submission → ${refused.decision}`,
      `broadcast count ${client.broadcasts} (was ${before}) — nothing queued behind the wedge`,
    ],
    note: "Quarantine refuses admissions but does not release the lease: the wedged transaction may still land on its nonce.",
  });

  return { steps, audit: [...store.audit()], broadcasts: client.broadcasts, submitted };
}
