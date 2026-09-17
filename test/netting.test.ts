import { describe, expect, it } from "vitest";
import { netTips, planSettlement } from "../src/netting.js";
import type { SettlementConfig, TipEvent } from "../src/types.js";

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000c";
const TREASURY = "0x0000000000000000000000000000000000000001";

const CONFIG: SettlementConfig = {
  chainId: 8453,
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  disperser: "0xD152f549545093347A162Dce210e7293f1452150",
  dustThreshold: 1000n,
};

function tip(id: string, from: string, to: string, amount: bigint): TipEvent {
  return { id, from, to, amount, castHash: `0x${id}`, timestampMs: 1_700_000_000_000 };
}

describe("netTips", () => {
  it("nets to zero across all accounts", () => {
    const positions = netTips([
      tip("1", TREASURY, A, 5000n),
      tip("2", TREASURY, B, 3000n),
      tip("3", A, B, 1000n),
    ]);
    expect(positions.reduce((sum, p) => sum + p.net, 0n)).toBe(0n);
  });

  it("cancels reciprocal tips instead of settling both legs", () => {
    const positions = netTips([tip("1", A, B, 5000n), tip("2", B, A, 3000n)]);
    expect(positions).toEqual([
      { account: A, net: -2000n },
      { account: B, net: 2000n },
    ]);
  });

  it("treats address casing as the same account", () => {
    const positions = netTips([tip("1", TREASURY, A.toUpperCase().replace("0X", "0x"), 5000n)]);
    expect(positions.find((p) => p.account === A)?.net).toBe(5000n);
  });

  it("rejects a repeated tip id rather than paying it twice", () => {
    expect(() => netTips([tip("1", A, B, 10n), tip("1", A, C, 20n)])).toThrow(/duplicate tip id/);
  });

  it("rejects non-positive amounts", () => {
    expect(() => netTips([tip("1", A, B, 0n)])).toThrow(/non-positive/);
  });
});

describe("planSettlement", () => {
  it("pays net creditors above dust and carries the rest forward", () => {
    const plan = planSettlement(
      "epoch-1",
      [tip("1", TREASURY, A, 5000n), tip("2", TREASURY, B, 400n)],
      CONFIG,
    );
    expect(plan.payouts).toEqual([{ recipient: A, amount: 5000n }]);
    expect(plan.total).toBe(5000n);
    expect(plan.carried).toEqual([
      { account: TREASURY, net: -5400n },
      { account: B, net: 400n },
    ]);
  });

  it("conserves value: payouts plus carried balances net to zero", () => {
    const plan = planSettlement(
      "epoch-1",
      [tip("1", TREASURY, A, 5000n), tip("2", TREASURY, B, 400n), tip("3", A, C, 1200n)],
      CONFIG,
    );
    const carried = plan.carried.reduce((sum, p) => sum + p.net, 0n);
    expect(plan.total + carried).toBe(0n);
  });

  it("accumulates sub-dust balances across epochs until they clear", () => {
    const first = planSettlement("epoch-1", [tip("1", TREASURY, B, 400n)], CONFIG);
    expect(first.payouts).toHaveLength(0);

    const second = planSettlement("epoch-2", [tip("2", TREASURY, B, 700n)], CONFIG, first.carried);
    expect(second.payouts).toEqual([{ recipient: B, amount: 1100n }]);
  });

  it("never lists a recipient twice in one batch", () => {
    const plan = planSettlement(
      "epoch-1",
      [tip("1", TREASURY, A, 5000n), tip("2", TREASURY, A, 6000n), tip("3", C, A, 2000n)],
      CONFIG,
    );
    expect(plan.payouts).toEqual([{ recipient: A, amount: 13000n }]);
  });
});
