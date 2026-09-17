import { describe, expect, it } from "vitest";
import { buildContractCallBody } from "../src/adapters/body.js";
import type { SettlementCall } from "../src/keeperhub.js";

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

function call(args: readonly unknown[]): SettlementCall {
  return {
    network: "84532",
    chainId: 84532,
    contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    functionName: "transfer",
    args,
    abi: ABI,
  };
}

describe("contract call body", () => {
  it("uses the tool's snake_case argument names", () => {
    expect(Object.keys(buildContractCallBody(call(["0xabc", "1"]))).sort()).toEqual([
      "abi",
      "chain_id",
      "contract_address",
      "function_args",
      "function_name",
    ]);
  });

  it("encodes chain id as a decimal string and args as a JSON string", () => {
    const body = buildContractCallBody(call(["0xabc", "1000"]));
    expect(body.chain_id).toBe("84532");
    expect(body.function_args).toBe('["0xabc","1000"]');
  });

  it("is byte-identical when rebuilt from the same intent", () => {
    const first = buildContractCallBody(call(["0xabc", "1000"]));
    const second = buildContractCallBody(call(["0xabc", "1000"]));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("refuses a bigint rather than letting the body drift on retry", () => {
    expect(() => buildContractCallBody(call(["0xabc", 1000n]))).toThrow(/bigint reached/);
  });

  it("refuses a float, which re-serializes inconsistently", () => {
    // 0.1 vs 0.10 is the documented cause of idempotency_conflict.
    expect(() => buildContractCallBody(call(["0xabc", 0.1]))).toThrow(/non-integer number/);
  });

  it("passes a native value through verbatim", () => {
    const body = buildContractCallBody({ ...call([]), value: "0.0000001" });
    expect(body.value).toBe("0.0000001");
  });

  it("omits value entirely when there is none", () => {
    expect(buildContractCallBody(call([]))).not.toHaveProperty("value");
  });

  it("checks nested arguments, not just the top level", () => {
    expect(() => buildContractCallBody(call([["0xabc"], [1000n]]))).toThrow(/\[1\]\[0\]/);
  });
});
