import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EpochLedger } from "../src/ledger.js";
import type { ContractCall, ExecutionStatus, KeeperHubClient } from "../src/keeperhub.js";
import { planSettlement } from "../src/netting.js";
import { resume, settleEpoch } from "../src/settle.js";
import type { SettlementConfig, TipEvent } from "../src/types.js";

const CONFIG: SettlementConfig = {
  chainId: 8453,
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  disperser: "0xD152f549545093347A162Dce210e7293f1452150",
  dustThreshold: 1n,
};

const TREASURY = "0x0000000000000000000000000000000000000001";
const ALICE = "0x000000000000000000000000000000000000000a";

const TIPS: TipEvent[] = [
  { id: "1", from: TREASURY, to: ALICE, amount: 5000n, castHash: "0x1", timestampMs: 1 },
  { id: "2", from: TREASURY, to: ALICE, amount: 2500n, castHash: "0x2", timestampMs: 2 },
];

class FakeKeeperHub implements KeeperHubClient {
  broadcasts: { key: string; call: ContractCall }[] = [];
  simulationOk = true;
  revertReason: string | undefined;
  private statuses = new Map<string, ExecutionStatus>();
  private byKey = new Map<string, string>();

  async simulate(): Promise<{ ok: boolean; revertReason?: string }> {
    return this.simulationOk
      ? { ok: true }
      : { ok: false, ...(this.revertReason ? { revertReason: this.revertReason } : {}) };
  }

  /** Mirrors KeeperHub's documented behaviour: a repeated key replays the first execution. */
  async execute(call: ContractCall, idempotencyKey: string): Promise<{ executionId: string }> {
    const seen = this.byKey.get(idempotencyKey);
    if (seen) return { executionId: seen };
    const executionId = `exec-${this.broadcasts.length + 1}`;
    this.broadcasts.push({ key: idempotencyKey, call });
    this.byKey.set(idempotencyKey, executionId);
    this.statuses.set(executionId, { state: "pending" });
    return { executionId };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    return this.statuses.get(executionId) ?? { state: "failed", error: "unknown execution" };
  }

  confirm(executionId: string, txHash: string): void {
    this.statuses.set(executionId, { state: "confirmed", txHash });
  }
}

function freshLedger(): EpochLedger {
  return new EpochLedger(join(mkdtempSync(join(tmpdir(), "netted-tips-")), "epochs.json"));
}

const noSleep = async () => {};

describe("settleEpoch", () => {
  it("broadcasts once and records the transaction hash", async () => {
    const client = new FakeKeeperHub();
    const ledger = freshLedger();
    const plan = planSettlement("epoch-1", TIPS, CONFIG);

    const settle = settleEpoch(plan, client, ledger, { sleep: noSleep, pollIntervalMs: 0 });
    await Promise.resolve();
    client.confirm("exec-1", "0xdeadbeef");
    const record = await settle;

    expect(client.broadcasts).toHaveLength(1);
    expect(record.status).toBe("settled");
    expect(record.txHash).toBe("0xdeadbeef");
    expect(record.plan.payouts).toEqual([{ recipient: ALICE, amount: "7500" }]);
  });

  it("does not broadcast when the simulation reverts", async () => {
    const client = new FakeKeeperHub();
    client.simulationOk = false;
    client.revertReason = "ERC20: transfer amount exceeds balance";
    const ledger = freshLedger();

    const record = await settleEpoch(planSettlement("epoch-1", TIPS, CONFIG), client, ledger, {
      sleep: noSleep,
    });

    expect(client.broadcasts).toHaveLength(0);
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/exceeds balance/);
  });

  it("re-running a settled epoch pays nothing further", async () => {
    const client = new FakeKeeperHub();
    const ledger = freshLedger();
    const plan = planSettlement("epoch-1", TIPS, CONFIG);

    const first = settleEpoch(plan, client, ledger, { sleep: noSleep, pollIntervalMs: 0 });
    await Promise.resolve();
    client.confirm("exec-1", "0xdeadbeef");
    await first;

    await settleEpoch(plan, client, ledger, { sleep: noSleep, pollIntervalMs: 0 });
    expect(client.broadcasts).toHaveLength(1);
  });

  it("a crash after broadcast resumes the execution instead of paying twice", async () => {
    const client = new FakeKeeperHub();
    const path = join(mkdtempSync(join(tmpdir(), "netted-tips-")), "epochs.json");
    const plan = planSettlement("epoch-1", TIPS, CONFIG);

    // First process: broadcasts, then dies before the transaction confirms.
    const crashing = new EpochLedger(path);
    await settleEpoch(plan, client, crashing, { sleep: noSleep, pollIntervalMs: 0, maxPolls: 1 });
    expect(crashing.get("epoch-1")?.status).toBe("broadcast");

    // The transaction lands while nothing is watching.
    client.confirm("exec-1", "0xfeedface");

    // Second process reads the same ledger from disk and resolves the epoch.
    const restarted = new EpochLedger(path);
    const resolved = await resume(client, restarted);

    expect(client.broadcasts).toHaveLength(1);
    expect(resolved[0]?.status).toBe("settled");
    expect(resolved[0]?.txHash).toBe("0xfeedface");
  });

  it("refuses to overwrite an epoch whose onchain effect changed", async () => {
    const ledger = freshLedger();
    const client = new FakeKeeperHub();
    const plan = planSettlement("epoch-1", TIPS, CONFIG);
    await settleEpoch(plan, client, ledger, { sleep: noSleep, pollIntervalMs: 0, maxPolls: 1 });

    const tampered = planSettlement("epoch-1", [...TIPS, {
      id: "3", from: TREASURY, to: ALICE, amount: 1n, castHash: "0x3", timestampMs: 3,
    }], CONFIG);

    await expect(
      settleEpoch(tampered, client, ledger, { sleep: noSleep, pollIntervalMs: 0, maxPolls: 1 }),
    ).rejects.toThrow(/different onchain effect/);
  });
});
