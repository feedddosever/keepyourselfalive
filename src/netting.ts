import { normalizeAddress } from "./address.js";
import type { NetPosition, Payout, SettlementConfig, SettlementPlan, TipEvent } from "./types.js";

/**
 * Collapses tips into one net position per account. Sending and receiving in the
 * same epoch cancel, which is the whole economic point: N micro-obligations
 * become at most one transfer per net creditor.
 *
 * `opening` carries balances forward from the previous epoch so sub-dust amounts
 * accumulate rather than being silently dropped.
 */
export function netTips(tips: readonly TipEvent[], opening: readonly NetPosition[] = []): NetPosition[] {
  const net = new Map<string, bigint>();
  const bump = (account: string, delta: bigint) => {
    const key = normalizeAddress(account);
    net.set(key, (net.get(key) ?? 0n) + delta);
  };

  for (const position of opening) bump(position.account, position.net);

  const seen = new Set<string>();
  for (const tip of tips) {
    if (seen.has(tip.id)) throw new Error(`duplicate tip id in epoch: ${tip.id}`);
    seen.add(tip.id);
    if (tip.amount <= 0n) throw new Error(`tip ${tip.id} has non-positive amount ${tip.amount}`);
    bump(tip.to, tip.amount);
    bump(tip.from, -tip.amount);
  }

  return [...net.entries()]
    .filter(([, value]) => value !== 0n)
    .map(([account, value]) => ({ account, net: value }))
    .sort((a, b) => (a.account < b.account ? -1 : 1));
}

/**
 * Builds the settlement plan for one epoch. Deterministic: the same tips in any
 * order yield a byte-identical plan, which is what lets the idempotency key
 * survive a retry.
 */
export function planSettlement(
  epochId: string,
  tips: readonly TipEvent[],
  config: SettlementConfig,
  opening: readonly NetPosition[] = [],
): SettlementPlan {
  const positions = netTips(tips, opening);

  const payouts: Payout[] = [];
  const carried: NetPosition[] = [];
  for (const position of positions) {
    if (position.net >= config.dustThreshold) {
      payouts.push({ recipient: position.account, amount: position.net });
    } else {
      carried.push(position);
    }
  }

  return {
    epochId,
    chainId: config.chainId,
    token: normalizeAddress(config.token),
    disperser: normalizeAddress(config.disperser),
    payouts,
    total: payouts.reduce((sum, payout) => sum + payout.amount, 0n),
    tipIds: [...tips.map((tip) => tip.id)].sort(),
    carried,
  };
}
