/** A single tip obligation observed offchain. `id` must be stable across replays. */
export interface TipEvent {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  castHash: string;
  timestampMs: number;
}

/** net = received - sent, in token base units. Sums to zero across all accounts. */
export interface NetPosition {
  account: string;
  net: bigint;
}

export interface Payout {
  recipient: string;
  amount: bigint;
}

export interface SettlementConfig {
  chainId: number;
  token: string;
  disperser: string;
  /** Positive nets below this are carried into the next epoch instead of paid. */
  dustThreshold: bigint;
}

/** The exact onchain effect of one settlement epoch. Fully determined by its inputs. */
export interface SettlementPlan {
  epochId: string;
  chainId: number;
  token: string;
  disperser: string;
  payouts: Payout[];
  total: bigint;
  tipIds: string[];
  /** Balances rolled into the next epoch: negative nets and sub-dust positives. */
  carried: NetPosition[];
}
