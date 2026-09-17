import type { KeeperHubClient, SettlementCall } from "../keeperhub.js";
import {
  UnidentifiedPaymentError,
  UnverifiedSettlementError,
  type SettlementRequest,
  type VerifiedSettlement,
} from "./types.js";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface SettlerOptions {
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Settles a Lucid Agents x402 payment on chain through KeeperHub.
 *
 * Lucid's runtime admits a payment when the x402 facilitator says the credential
 * is good, and issues its offer receipt from the payment payload — that is, from
 * a protocol response. Its own types call the next step out explicitly:
 * `preflightIncoming` exists to "evaluate amount and endpoint policies before
 * another rail attempts an irreversible settlement". This is that rail.
 *
 * The join is Lucid's payment identifier. Lucid already guarantees it equals the
 * request's `Idempotency-Key`, so using it as KeeperHub's `idempotency_key`
 * makes one identity span the whole path: the value a buyer retries with is the
 * same value that decides whether a transfer is broadcast or replayed. Nothing
 * needs to be generated, correlated or stored to make the retry safe.
 *
 * What Lucid gains is the other direction: it can finalize against a receipt
 * KeeperHub reconciled with the chain, instead of against an HTTP response.
 */
export class LucidKeeperHubSettler {
  constructor(
    private readonly client: KeeperHubClient,
    private readonly options: SettlerOptions = {},
  ) {}

  async settle(request: SettlementRequest): Promise<VerifiedSettlement> {
    const paymentIdentifier = request.reconciliation.paymentIdentifier;
    if (!paymentIdentifier) throw new UnidentifiedPaymentError(request.entrypointKey);

    // Preflight before an irreversible settlement, matching the phase Lucid
    // names. A revert here costs nothing and Lucid can refuse the invocation.
    //
    // Lucid's payment identifier IS the idempotency key on both paths. A buyer
    // retrying with the same Idempotency-Key cannot produce a second transfer.
    const handle = request.token
      ? await this.settleToken(request, paymentIdentifier)
      : await this.settleNative(request, paymentIdentifier);
    const status = await this.awaitVerified(handle.executionId);

    if (!status.txHash) {
      throw new UnverifiedSettlementError(handle.executionId, "confirmed without a transaction hash");
    }

    return {
      paymentIdentifier,
      entrypointKey: request.entrypointKey,
      executionId: handle.executionId,
      txHash: status.txHash,
      verified: true,
      replayed: handle.replayed ?? false,
      ...(status.txLink ? { txLink: status.txLink } : {}),
      ...(status.blockNumber === undefined ? {} : { blockNumber: status.blockNumber }),
      ...(status.gasUsedWei ? { gasUsedWei: status.gasUsedWei } : {}),
    };
  }

  private async settleToken(request: SettlementRequest, paymentIdentifier: string) {
    const call = this.buildCall(request);
    const simulation = await this.client.simulate(call);
    if (!simulation.ok) {
      throw new UnverifiedSettlementError(
        `preflight:${paymentIdentifier}`,
        "would revert",
        simulation.revertReason,
      );
    }
    return this.client.execute(call, paymentIdentifier);
  }

  /** Natively priced offer: settles as a native transfer, amount in ether units. */
  private async settleNative(request: SettlementRequest, paymentIdentifier: string) {
    if (!this.client.executeTransfer || !this.client.simulateTransfer) {
      throw new Error(
        "this KeeperHub transport cannot send native transfers; price the offer in an ERC-20 " +
          "or use the MCP adapter",
      );
    }
    const transfer = {
      chainId: request.chainId,
      toAddress: request.payTo,
      amount: request.amount,
    };
    const simulation = await this.client.simulateTransfer(transfer);
    if (!simulation.ok) {
      throw new UnverifiedSettlementError(
        `preflight:${paymentIdentifier}`,
        "would revert",
        simulation.revertReason,
      );
    }
    return this.client.executeTransfer(transfer, paymentIdentifier);
  }

  private buildCall(request: SettlementRequest): SettlementCall {
    if (!/^\d+$/.test(request.amount)) {
      throw new Error(
        `amount must be base units as a decimal string, got ${JSON.stringify(request.amount)}. ` +
          "A float would re-serialize differently on retry and break the idempotency binding.",
      );
    }
    return {
      network: request.chainId.toString(10),
      chainId: request.chainId,
      contractAddress: request.token as string,
      functionName: "transfer",
      args: [request.payTo, request.amount],
      abi: ERC20_TRANSFER_ABI,
    };
  }

  /**
   * Polls until KeeperHub reconciles the receipt against the chain.
   *
   * `verified` is required, not just `confirmed`. KeeperHub distinguishes an
   * execution it believes succeeded from one whose receipt it has checked, and
   * Lucid fulfilling work is irreversible — so the weaker signal is not enough.
   */
  private async awaitVerified(executionId: string) {
    const { pollIntervalMs = 3000, maxPolls = 40, sleep = defaultSleep } = this.options;

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const status = await this.client.status(executionId);

      if (status.state === "failed") {
        throw new UnverifiedSettlementError(executionId, "failed", status.error);
      }
      if (status.state === "confirmed") {
        if (status.verified === false) {
          throw new UnverifiedSettlementError(executionId, "confirmed but unverified");
        }
        return status;
      }
      await sleep(pollIntervalMs);
    }

    // Deliberately not a failure: the transfer may still land, and telling Lucid
    // it failed would invite a second settlement for the same payment.
    throw new UnverifiedSettlementError(executionId, "still pending", "poll budget exhausted");
  }
}
