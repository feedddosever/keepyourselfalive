import { buildSettlementCall } from "./calldata.js";
import { idempotencyKey } from "./idempotency.js";
import { assertCallMatchesPlan, type KeeperHubClient } from "./keeperhub.js";
import type { EpochLedger, EpochRecord } from "./ledger.js";
import type { SettlementPlan } from "./types.js";

export interface SettleOptions {
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resumes any epoch that was broadcast but never confirmed.
 *
 * Runs before planning, because a crash between broadcast and confirmation is the
 * one window in which a naive agent re-nets the same tips and pays them twice.
 */
export async function resume(
  client: KeeperHubClient,
  ledger: EpochLedger,
  options: SettleOptions = {},
): Promise<EpochRecord[]> {
  const resolved: EpochRecord[] = [];
  for (const record of ledger.unresolved()) {
    if (!record.executionId) continue;
    const status = await client.status(record.executionId);
    if (status.state === "pending") continue;
    const plan = deserialize(record);
    resolved.push(
      ledger.record(plan, record.idempotencyKey, {
        status: status.state === "confirmed" ? "settled" : "failed",
        ...(status.txHash ? { txHash: status.txHash } : {}),
        ...(status.error ? { error: status.error } : {}),
      }),
    );
  }
  return resolved;
}

/**
 * Simulate, then broadcast, then poll. A simulation that reverts aborts the epoch
 * without broadcasting, which is what keeps a bad netting run from costing gas.
 */
export async function settleEpoch(
  plan: SettlementPlan,
  client: KeeperHubClient,
  ledger: EpochLedger,
  options: SettleOptions = {},
): Promise<EpochRecord> {
  const { pollIntervalMs = 3000, maxPolls = 40, sleep = defaultSleep } = options;
  const key = idempotencyKey(plan);

  const existing = ledger.get(plan.epochId);
  if (existing?.status === "settled") return existing;

  const call = buildSettlementCall(plan);
  assertCallMatchesPlan(call, plan);

  const simulation = await client.simulate(call);
  if (!simulation.ok) {
    return ledger.record(plan, key, {
      status: "failed",
      error: `simulation reverted: ${simulation.revertReason ?? "unknown"}`,
    });
  }

  ledger.record(plan, key, { status: "planned" });
  const handle = await client.execute(call, key);
  ledger.record(plan, key, { status: "broadcast", executionId: handle.executionId });

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const status = await client.status(handle.executionId);
    if (status.state === "confirmed") {
      return ledger.record(plan, key, {
        status: "settled",
        executionId: handle.executionId,
        ...(status.txHash ? { txHash: status.txHash } : {}),
        ...(status.txLink ? { txLink: status.txLink } : {}),
      });
    }
    if (status.state === "failed") {
      return ledger.record(plan, key, {
        status: "failed",
        executionId: handle.executionId,
        error: status.error ?? "execution failed",
      });
    }
    await sleep(pollIntervalMs);
  }

  // Deliberately left as `broadcast`, not `failed`: the transaction may still land,
  // and only `resume` may decide its outcome.
  return ledger.record(plan, key, { status: "broadcast", executionId: handle.executionId });
}

function deserialize(record: EpochRecord): SettlementPlan {
  return {
    ...record.plan,
    total: BigInt(record.plan.total),
    payouts: record.plan.payouts.map((p) => ({ recipient: p.recipient, amount: BigInt(p.amount) })),
    carried: record.plan.carried.map((c) => ({ account: c.account, net: BigInt(c.net) })),
  };
}
