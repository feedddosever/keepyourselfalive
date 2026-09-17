/**
 * The shape Lucid Agents hands back from `reconcilePaymentIdentifier`
 * (`packages/payments/src/x402-reconciliation.ts`).
 *
 * Lucid has already enforced the invariant that makes this integration work:
 * the x402 payment identifier **equals** the HTTP `Idempotency-Key`, and both
 * satisfy `isValidPaymentId`. A request that fails either check never reaches
 * settlement.
 */
export interface LucidReconciliation {
  paymentIdentifier?: string;
  extensions: Record<string, unknown>;
}

/** One entrypoint invocation's payment, ready to be settled on chain. */
export interface SettlementRequest {
  reconciliation: LucidReconciliation;
  /** Lucid's entrypoint key, carried into the audit trail. */
  entrypointKey: string;
  kind: "invoke" | "stream" | "task";
  chainId: number;
  /**
   * ERC-20 the offer is priced in. Omit for a natively priced offer, which
   * settles as a native transfer instead of a `transfer` call.
   */
  token?: string;
  /** Who the entrypoint pays. */
  payTo: string;
  /**
   * For an ERC-20 offer: base units as a decimal string, never a float.
   * For a native offer: ether units, passed to KeeperHub verbatim.
   */
  amount: string;
}

/**
 * A settlement Lucid may finalize against.
 *
 * Only produced when KeeperHub reconciled the receipt against the chain, so
 * `verified` is always true here; an unverified execution raises instead.
 */
export interface VerifiedSettlement {
  paymentIdentifier: string;
  entrypointKey: string;
  executionId: string;
  txHash: string;
  txLink?: string;
  blockNumber?: number;
  gasUsedWei?: string;
  verified: true;
  /** KeeperHub replayed an earlier execution for this payment identifier. */
  replayed: boolean;
}

export class UnidentifiedPaymentError extends Error {
  constructor(entrypointKey: string) {
    super(
      `entrypoint ${entrypointKey} produced no payment identifier. Settlement is ` +
        "refused: without the identifier there is nothing to bind the onchain " +
        "execution to, so a retry could pay twice. Configure Lucid's " +
        "paymentIdentifier extension with required: true.",
    );
    this.name = "UnidentifiedPaymentError";
  }
}

export class UnverifiedSettlementError extends Error {
  constructor(
    readonly executionId: string,
    readonly state: string,
    detail?: string,
  ) {
    super(
      `execution ${executionId} is ${state}${detail ? ` (${detail})` : ""}, so it cannot ` +
        "be finalized. Lucid must not fulfil against a payment that is not yet " +
        "reconciled against the chain.",
    );
    this.name = "UnverifiedSettlementError";
  }
}
