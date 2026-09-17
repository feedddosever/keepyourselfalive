import { describe, expect, it } from "vitest";
import { parseTip } from "../src/ingest/source.js";

const VALID = {
  id: "cast-1",
  from: "0x00000000000000000000000000000000000000F1",
  to: "0x000000000000000000000000000000000000000a",
  amount: "500000",
  castHash: "0xaaa1",
  timestampMs: 1_700_000_000_000,
};

describe("parseTip", () => {
  it("normalizes addresses so casing cannot split one account in two", () => {
    const tip = parseTip(VALID, "test");
    expect(tip.from).toBe("0x00000000000000000000000000000000000000f1");
    expect(tip.amount).toBe(500000n);
  });

  it("rejects a decimal amount rather than truncating it", () => {
    expect(() => parseTip({ ...VALID, amount: "0.5" }, "test")).toThrow(/base units/);
  });

  it("rejects a float-typed amount that would lose precision", () => {
    // Caught by the string check, before BigInt() could round it silently.
    expect(() => parseTip({ ...VALID, amount: 5e17 as unknown as string }, "test")).toThrow(/"amount"/);
  });

  it("rejects a malformed address instead of hashing it into a payout", () => {
    expect(() => parseTip({ ...VALID, to: "vitalik.eth" }, "test")).toThrow(/not an EVM address/);
  });

  it("names the offending location so a bad line is findable", () => {
    expect(() => parseTip({ ...VALID, id: "" }, "tips.jsonl:42")).toThrow(/tips\.jsonl:42/);
  });
});
