import { canonicalHash } from "./hash.js";
import type { SettlementPlan } from "./types.js";

/**
 * Canonical description of a plan's onchain effect.
 *
 * Deliberately excluded: nonce, gas price, wall-clock time, and the tip ids that
 * composed the payouts. A retry assigns a fresh nonce and re-derives the plan a
 * moment later; if either were in the key, the retry would mint a new key and
 * KeeperHub would broadcast a second payout instead of replaying the first.
 *
 * Deliberately included: the epoch id, so two epochs that happen to net to the
 * same payouts stay distinct and both get paid.
 */
export function canonicalLines(plan: SettlementPlan): string[] {
  const lines = [
    "netted-tips/v1",
    `epoch:${plan.epochId}`,
    `chain:${plan.chainId.toString(10)}`,
    `token:${plan.token}`,
    `disperser:${plan.disperser}`,
  ];
  for (const payout of [...plan.payouts].sort((a, b) => (a.recipient < b.recipient ? -1 : 1))) {
    lines.push(`payout:${payout.recipient}:${payout.amount.toString(10)}`);
  }
  return lines;
}

export function canonicalize(plan: SettlementPlan): string {
  return canonicalLines(plan).join("\n");
}

export function idempotencyKey(plan: SettlementPlan): string {
  return canonicalHash(canonicalLines(plan));
}
