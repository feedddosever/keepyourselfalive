import { describe, expect, it } from "vitest";
import { LucidKeeperHubSettler } from "../src/lucid/settlement.js";
import {
  UnidentifiedPaymentError,
  UnverifiedSettlementError,
  type SettlementRequest,
} from "../src/lucid/types.js";
import type {
  ExecutionHandle,
  ExecutionStatus,
  KeeperHubClient,
  SettlementCall,
  SimulationResult,
} from "../src/keeperhub.js";

const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SELLER = "0x000000000000000000000000000000000000beef";

/** Format taken from Lucid's own payment-identifier tests. */
const PAYMENT_ID = "pay_fedcba0987654321";

function request(overrides: Partial<SettlementRequest> = {}): SettlementRequest {
  return {
    reconciliation: { paymentIdentifier: PAYMENT_ID, extensions: {} },
    entrypointKey: "summarize",
    kind: "invoke",
    chainId: 84532,
    token: TOKEN,
    payTo: SELLER,
    amount: "250000",
    ...overrides,
  };
}

/** Mirrors KeeperHub: a repeated key replays, and receipts carry `verified`. */
class FakeKeeperHub implements KeeperHubClient {
  broadcasts: { key: string; call: SettlementCall }[] = [];
  revertReason: string | undefined;
  verified: boolean | undefined = true;
  finalState: ExecutionStatus["state"] = "confirmed";
  pendingRounds = 0;
  private byKey = new Map<string, string>();

  async simulate(): Promise<SimulationResult> {
    return this.revertReason
      ? { ok: false, revertReason: this.revertReason, via: "keeperhub" }
      : { ok: true, gasEstimate: "57576", via: "keeperhub" };
  }

  async execute(call: SettlementCall, idempotencyKey: string): Promise<ExecutionHandle> {
    const seen = this.byKey.get(idempotencyKey);
    if (seen) return { executionId: seen, idempotencyEnforcedRemotely: true, replayed: true };
    const executionId = `exec-${this.broadcasts.length + 1}`;
    this.broadcasts.push({ key: idempotencyKey, call });
    this.byKey.set(idempotencyKey, executionId);
    return { executionId, idempotencyEnforcedRemotely: true, replayed: false };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    if (this.pendingRounds > 0) {
      this.pendingRounds -= 1;
      return { state: "pending" };
    }
    if (this.finalState === "failed") return { state: "failed", error: "reverted on chain" };
    return {
      state: "confirmed",
      txHash: `0x${executionId.padEnd(64, "0")}`,
      txLink: `https://sepolia.basescan.org/tx/0x${executionId}`,
      blockNumber: 46952003,
      gasUsedWei: "345456000000",
      ...(this.verified === undefined ? {} : { verified: this.verified }),
    };
  }
}

const noSleep = async () => {};
const settler = (client: KeeperHubClient) =>
  new LucidKeeperHubSettler(client, { sleep: noSleep, pollIntervalMs: 0 });

describe("settling a Lucid x402 payment", () => {
  it("uses Lucid's payment identifier verbatim as the idempotency key", async () => {
    const client = new FakeKeeperHub();
    await settler(client).settle(request());
    expect(client.broadcasts[0]?.key).toBe(PAYMENT_ID);
  });

  it("returns a settlement Lucid can finalize against", async () => {
    const settlement = await settler(new FakeKeeperHub()).settle(request());
    expect(settlement).toMatchObject({
      paymentIdentifier: PAYMENT_ID,
      entrypointKey: "summarize",
      verified: true,
      replayed: false,
      blockNumber: 46952003,
    });
    expect(settlement.txHash).toMatch(/^0x/);
  });

  it("transfers the priced amount to the seller", async () => {
    const client = new FakeKeeperHub();
    await settler(client).settle(request());
    expect(client.broadcasts[0]?.call.args).toEqual([SELLER, "250000"]);
  });
});

describe("a buyer retrying the same Idempotency-Key", () => {
  it("produces one transfer, not two", async () => {
    const client = new FakeKeeperHub();
    const first = await settler(client).settle(request());
    const retry = await settler(client).settle(request());

    expect(client.broadcasts).toHaveLength(1);
    expect(retry.txHash).toBe(first.txHash);
    expect(retry.replayed).toBe(true);
  });

  it("tells the caller it was already paid rather than paid again", async () => {
    const client = new FakeKeeperHub();
    await settler(client).settle(request());
    expect((await settler(client).settle(request())).replayed).toBe(true);
  });

  it("keeps settlements for different payments separate", async () => {
    const client = new FakeKeeperHub();
    await settler(client).settle(request());
    await settler(client).settle(
      request({ reconciliation: { paymentIdentifier: "pay_0123456789abcdef", extensions: {} } }),
    );
    expect(client.broadcasts).toHaveLength(2);
  });
});

describe("refusing to finalize", () => {
  it("refuses a payment with no identifier", async () => {
    const client = new FakeKeeperHub();
    await expect(
      settler(client).settle(request({ reconciliation: { extensions: {} } })),
    ).rejects.toBeInstanceOf(UnidentifiedPaymentError);
    expect(client.broadcasts).toHaveLength(0);
  });

  it("does not broadcast when the preflight would revert", async () => {
    const client = new FakeKeeperHub();
    client.revertReason = "ERC20: transfer amount exceeds balance";
    await expect(settler(client).settle(request())).rejects.toThrow(/exceeds balance/);
    expect(client.broadcasts).toHaveLength(0);
  });

  it("refuses a confirmed execution whose receipt is unverified", async () => {
    const client = new FakeKeeperHub();
    client.verified = false;
    await expect(settler(client).settle(request())).rejects.toThrow(/unverified/);
  });

  it("refuses a failed execution", async () => {
    const client = new FakeKeeperHub();
    client.finalState = "failed";
    await expect(settler(client).settle(request())).rejects.toBeInstanceOf(UnverifiedSettlementError);
  });

  it("reports a still-pending settlement as pending, never as failed", async () => {
    // Reporting failure would invite Lucid to settle the same payment again.
    const client = new FakeKeeperHub();
    client.pendingRounds = 99;
    await expect(
      new LucidKeeperHubSettler(client, { sleep: noSleep, maxPolls: 2 }).settle(request()),
    ).rejects.toThrow(/still pending/);
  });

  it("rejects a float amount that would break the idempotency binding", async () => {
    const client = new FakeKeeperHub();
    await expect(settler(client).settle(request({ amount: "0.25" }))).rejects.toThrow(/base units/);
    expect(client.broadcasts).toHaveLength(0);
  });
});
