import { LucidKeeperHubSettler } from "../lucid/settlement.js";
import type { SettlementRequest } from "../lucid/types.js";
import type {
  ExecutionHandle,
  ExecutionStatus,
  KeeperHubClient,
  NativeTransfer,
  SettlementCall,
  SimulationResult,
} from "../keeperhub.js";

export type Step = { phase: string; detail: string; tone: "ok" | "warn" | "bad" | "dim" };

/**
 * A stand-in for KeeperHub that mirrors the behaviour the live API actually
 * showed: a repeated idempotency key replays the first execution, and receipts
 * carry a `verified` flag distinct from the execution's status.
 *
 * This runs the real `LucidKeeperHubSettler` from `src/lucid/settlement.ts` —
 * only the transport is replaced, so every decision on screen is the shipped
 * code's decision. The transactions it reports are the real ones, recorded.
 */
class DemoKeeperHub implements KeeperHubClient {
  transfers = 0;
  revertReason: string | undefined;
  verified = true;
  private byKey = new Map<string, string>();

  constructor(private readonly log: (step: Step) => void) {}

  async simulate(call: SettlementCall): Promise<SimulationResult> {
    return this.preflight(`${call.functionName} → ${short(call.contractAddress)}`);
  }

  async simulateTransfer(transfer: NativeTransfer): Promise<SimulationResult> {
    return this.preflight(`${transfer.amount} ETH → ${short(transfer.toAddress)}`);
  }

  private preflight(what: string): SimulationResult {
    if (this.revertReason) {
      this.log({ phase: "simulate", detail: `would revert — ${this.revertReason}`, tone: "bad" });
      return { ok: false, revertReason: this.revertReason, via: "keeperhub" };
    }
    this.log({ phase: "simulate", detail: `${what} — would not revert`, tone: "ok" });
    return { ok: true, gasEstimate: "49803", via: "keeperhub" };
  }

  async execute(call: SettlementCall, key: string): Promise<ExecutionHandle> {
    return this.broadcast(key);
  }

  async executeTransfer(_transfer: NativeTransfer, key: string): Promise<ExecutionHandle> {
    return this.broadcast(key);
  }

  private broadcast(key: string): ExecutionHandle {
    const seen = this.byKey.get(key);
    if (seen) {
      this.log({
        phase: "execute",
        detail: `idempotentReplay: true — key ${short(key)} already settled, nothing broadcast`,
        tone: "warn",
      });
      return { executionId: seen, idempotencyEnforcedRemotely: true, replayed: true };
    }
    this.transfers += 1;
    const executionId = "vvo8w7rcv76yxgb7slrsd";
    this.byKey.set(key, executionId);
    this.log({ phase: "execute", detail: `broadcast with idempotency_key = ${key}`, tone: "ok" });
    return { executionId, idempotencyEnforcedRemotely: true, replayed: false };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    if (!this.verified) {
      this.log({ phase: "receipt", detail: "confirmed, but verified: false", tone: "bad" });
      return { state: "confirmed", txHash: TX_HASH, verified: false };
    }
    this.log({
      phase: "receipt",
      detail: "verified: true · receiptStatus: success · block 46952279",
      tone: "ok",
    });
    return {
      state: "confirmed",
      txHash: TX_HASH,
      txLink: `https://sepolia.basescan.org/tx/${TX_HASH}`,
      blockNumber: 46952279,
      gasUsedWei: "364778139063",
      verified: true,
      receiptStatus: "success",
    };
  }
}

const TX_HASH = "0x7d8d48492ff9994b4950762b4be91ce5d068f79f5ae531b1b516865a36780359";

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export interface RunOptions {
  paymentIdentifier?: string;
  revertReason?: string;
  verified?: boolean;
}

export interface RunResult {
  steps: Step[];
  transfers: number;
  outcome: string;
  tone: "ok" | "warn" | "bad";
  txLink?: string;
}

/** One buyer session: settle, then settle again with the same identifier. */
export class Session {
  private steps: Step[] = [];
  private readonly client = new DemoKeeperHub((step) => this.steps.push(step));

  async run(options: RunOptions = {}): Promise<RunResult> {
    this.steps = [];
    this.client.revertReason = options.revertReason;
    this.client.verified = options.verified ?? true;

    const identifier = options.paymentIdentifier;
    this.steps.push({
      phase: "lucid",
      detail: identifier
        ? `reconcilePaymentIdentifier → ${identifier} (equals Idempotency-Key)`
        : "reconcilePaymentIdentifier → no identifier supplied",
      tone: identifier ? "ok" : "bad",
    });

    const request: SettlementRequest = {
      reconciliation: { ...(identifier ? { paymentIdentifier: identifier } : {}), extensions: {} },
      entrypointKey: "summarize",
      kind: "invoke",
      chainId: 84532,
      payTo: "0x000000000000000000000000000000000000bEEF",
      amount: "0.0000001",
    };

    try {
      const settlement = await new LucidKeeperHubSettler(this.client, {
        sleep: async () => {},
        pollIntervalMs: 0,
      }).settle(request);

      return {
        steps: this.steps,
        transfers: this.client.transfers,
        tone: settlement.replayed ? "warn" : "ok",
        outcome: settlement.replayed
          ? "Already paid. Lucid fulfils, and no second transfer was made."
          : "Settled. Lucid may fulfil the entrypoint.",
        txLink: `https://sepolia.basescan.org/tx/${settlement.txHash}`,
      };
    } catch (error) {
      this.steps.push({
        phase: "refused",
        detail: error instanceof Error ? error.message : String(error),
        tone: "bad",
      });
      return {
        steps: this.steps,
        transfers: this.client.transfers,
        tone: "bad",
        outcome: "Refused. Lucid does not fulfil, and nothing was charged.",
      };
    }
  }

  get transfers(): number {
    return this.client.transfers;
  }
}

declare global {
  interface Window {
    LucidDemo: { Session: typeof Session };
  }
}
window.LucidDemo = { Session };
