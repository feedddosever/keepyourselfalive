import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NetPosition, SettlementPlan } from "./types.js";

export type EpochStatus = "planned" | "broadcast" | "settled" | "failed";

export interface EpochRecord {
  epochId: string;
  idempotencyKey: string;
  status: EpochStatus;
  plan: SerializedPlan;
  executionId?: string;
  txHash?: string;
  error?: string;
  updatedAtMs: number;
}

interface SerializedPlan extends Omit<SettlementPlan, "total" | "payouts" | "carried"> {
  total: string;
  payouts: { recipient: string; amount: string }[];
  carried: { account: string; net: string }[];
}

function serialize(plan: SettlementPlan): SerializedPlan {
  return {
    ...plan,
    total: plan.total.toString(10),
    payouts: plan.payouts.map((p) => ({ recipient: p.recipient, amount: p.amount.toString(10) })),
    carried: plan.carried.map((c) => ({ account: c.account, net: c.net.toString(10) })),
  };
}

/**
 * Append-only epoch log on disk.
 *
 * This is the half of exactly-once that does not live in the idempotency key. The
 * key stops KeeperHub broadcasting a duplicate; the ledger stops this agent from
 * ever *asking* it to — and, after a crash between broadcast and confirmation,
 * tells the next run to resume polling an execution rather than plan a new one.
 */
export class EpochLedger {
  private records: Map<string, EpochRecord>;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.records = new Map();
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as EpochRecord[];
      for (const record of raw) this.records.set(record.epochId, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(epochId: string): EpochRecord | undefined {
    return this.records.get(epochId);
  }

  /** Epochs broadcast but never confirmed: resume these before planning anything new. */
  unresolved(): EpochRecord[] {
    return [...this.records.values()].filter((record) => record.status === "broadcast");
  }

  /** Balances the last settled epoch rolled forward, as the next epoch's opening. */
  carriedFrom(epochId: string): NetPosition[] {
    const record = this.records.get(epochId);
    if (!record) return [];
    return record.plan.carried.map((c) => ({ account: c.account, net: BigInt(c.net) }));
  }

  record(plan: SettlementPlan, idempotencyKey: string, patch: Partial<EpochRecord> & { status: EpochStatus }): EpochRecord {
    const existing = this.records.get(plan.epochId);
    if (existing && existing.idempotencyKey !== idempotencyKey) {
      throw new Error(
        `epoch ${plan.epochId} already recorded with a different onchain effect ` +
          `(${existing.idempotencyKey} vs ${idempotencyKey}); refusing to overwrite`,
      );
    }
    const record: EpochRecord = {
      ...existing,
      epochId: plan.epochId,
      idempotencyKey,
      plan: serialize(plan),
      ...patch,
      updatedAtMs: Date.now(),
    };
    this.records.set(plan.epochId, record);
    this.flush();
    return record;
  }

  private flush(): void {
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.records.values()], null, 2));
    renameSync(temp, this.path);
  }
}

export const defaultLedgerPath = join(process.cwd(), "state", "epochs.json");
