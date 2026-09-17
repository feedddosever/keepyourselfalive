import { describe, expect, it } from "vitest";
import { canonicalize, idempotencyKey } from "../src/idempotency.js";
import { planSettlement } from "../src/netting.js";
import type { SettlementConfig, TipEvent } from "../src/types.js";

const CONFIG: SettlementConfig = {
  chainId: 8453,
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  disperser: "0xD152f549545093347A162Dce210e7293f1452150",
  dustThreshold: 1n,
};

/** Deterministic PRNG so a failing case is reproducible from its seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

function randomTips(seed: number, count: number): TipEvent[] {
  const random = mulberry32(seed);
  const tips: TipEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(random() * 8) + 1;
    let to = Math.floor(random() * 8) + 1;
    if (to === from) to = (to % 8) + 1;
    tips.push({
      id: `tip-${i}`,
      from: address(from),
      to: address(to),
      amount: BigInt(Math.floor(random() * 10_000) + 1),
      castHash: `0xcast${i}`,
      timestampMs: 1_700_000_000_000 + i,
    });
  }
  return tips;
}

function shuffle(tips: readonly TipEvent[], seed: number): TipEvent[] {
  const random = mulberry32(seed);
  const out = [...tips];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("idempotency key", () => {
  it("is stable across ingestion order for 200 random epochs", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const tips = randomTips(seed, 25);
      const reference = planSettlement("epoch-1", tips, CONFIG);
      const reordered = planSettlement("epoch-1", shuffle(tips, seed * 7919), CONFIG);
      expect(idempotencyKey(reordered), `seed ${seed}`).toBe(idempotencyKey(reference));
      expect(reordered.payouts, `seed ${seed}`).toEqual(reference.payouts);
    }
  });

  it("excludes nonce, gas and wall-clock time from the hashed material", () => {
    const canonical = canonicalize(planSettlement("epoch-1", randomTips(42, 10), CONFIG));
    expect(canonical).not.toMatch(/nonce|gas|timestamp|\b17000000\d+/i);
  });

  it("ignores which tips composed an identical payout set", () => {
    const base = planSettlement("epoch-1", [
      { id: "a", from: address(1), to: address(2), amount: 100n, castHash: "0x1", timestampMs: 1 },
    ], CONFIG);
    const split = planSettlement("epoch-1", [
      { id: "b", from: address(1), to: address(2), amount: 60n, castHash: "0x2", timestampMs: 2 },
      { id: "c", from: address(1), to: address(2), amount: 40n, castHash: "0x3", timestampMs: 3 },
    ], CONFIG);
    expect(idempotencyKey(split)).toBe(idempotencyKey(base));
  });

  it.each([
    ["epoch id", (p: ReturnType<typeof planSettlement>) => ({ ...p, epochId: "epoch-2" })],
    ["chain id", (p: ReturnType<typeof planSettlement>) => ({ ...p, chainId: 84532 })],
    ["token", (p: ReturnType<typeof planSettlement>) => ({ ...p, token: address(99) })],
    ["disperser", (p: ReturnType<typeof planSettlement>) => ({ ...p, disperser: address(98) })],
    ["payout amount", (p: ReturnType<typeof planSettlement>) => ({
      ...p,
      payouts: [{ recipient: p.payouts[0]!.recipient, amount: p.payouts[0]!.amount + 1n }, ...p.payouts.slice(1)],
    })],
    ["recipient", (p: ReturnType<typeof planSettlement>) => ({
      ...p,
      payouts: [{ recipient: address(97), amount: p.payouts[0]!.amount }, ...p.payouts.slice(1)],
    })],
  ])("changes when the %s changes", (_label, mutate) => {
    const plan = planSettlement("epoch-1", randomTips(7, 12), CONFIG);
    expect(idempotencyKey(mutate(plan))).not.toBe(idempotencyKey(plan));
  });
});
