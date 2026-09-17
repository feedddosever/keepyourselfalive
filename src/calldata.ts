import { encodeFunctionData, getAddress } from "viem";
import type { SettlementCall } from "./keeperhub.js";
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

/**
 * The plan expressed as a KeeperHub Direct Execution call.
 *
 * `network` is passed as the decimal chain id, which the API accepts alongside
 * names like "base"; the id avoids any ambiguity about which network a name maps
 * to, and matches what the idempotency key hashes.
 */
export function buildSettlementCall(plan: SettlementPlan): SettlementCall {
  if (plan.payouts.length === 0) {
    throw new Error(`epoch ${plan.epochId} has no payouts; nothing to broadcast`);
  }
  return {
    network: plan.chainId.toString(10),
    chainId: plan.chainId,
    contractAddress: getAddress(plan.disperser),
    functionName: "disperseToken",
    args: [
      getAddress(plan.token),
      plan.payouts.map((payout) => getAddress(payout.recipient)),
      plan.payouts.map((payout) => payout.amount.toString(10)),
    ],
    abi: DISPERSE_ABI,
  };
}
