import { encodeFunctionData, getAddress } from "viem";
import type { SettlementPlan } from "./types.js";

export const DISPERSE_ABI = [
  {
    type: "function",
    name: "disperseToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "values", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

/** One batched transfer for the whole epoch, in the plan's canonical payout order. */
export function encodeSettlement(plan: SettlementPlan): `0x${string}` {
  if (plan.payouts.length === 0) {
    throw new Error(`epoch ${plan.epochId} has no payouts; nothing to broadcast`);
  }
  return encodeFunctionData({
    abi: DISPERSE_ABI,
    functionName: "disperseToken",
    args: [
      getAddress(plan.token),
      plan.payouts.map((payout) => getAddress(payout.recipient)),
      plan.payouts.map((payout) => payout.amount),
    ],
  });
}
