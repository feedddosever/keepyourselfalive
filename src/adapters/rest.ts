import { DirectExecutor, isReadResult, KeeperHubClient as KeeperHubSdkClient } from "@keeperhub/sdk";
import { createPublicClient, http, type Address } from "viem";
import {
  normalizeState,
  type ExecutionHandle,
  type ExecutionStatus,
  type KeeperHubClient,
  type SettlementCall,
  type SimulationResult,
} from "../keeperhub.js";

export interface RestClientOptions {
  apiKey: string;
  /** Sender the preflight impersonates; must be the address KeeperHub broadcasts from. */
  senderAddress: Address;
  /** RPC for the local preflight. Omit only with `allowUnsimulated`. */
  rpcUrl?: string;
  baseUrl?: string;
  allowUnsimulated?: boolean;
}

/**
 * KeeperHub via the official REST SDK.
 *
 * Two capabilities this agent's safety model assumes are absent from
 * `@keeperhub/sdk@0.1.1` and are compensated for here:
 *
 *   simulate — not exposed, so the preflight is a local `eth_call` against an RPC.
 *              It catches the same class of failure (insufficient balance, bad
 *              recipient, wrong token) but is *not* KeeperHub's own simulation,
 *              so `via` reports `local-eth-call` and nothing claims otherwise.
 *
 *   idempotency key — no parameter carries it, so exactly-once rests entirely on
 *              the local epoch ledger. `idempotencyEnforcedRemotely: false` makes
 *              that visible to callers rather than implied.
 */
export class RestKeeperHubClient implements KeeperHubClient {
  private readonly executor: DirectExecutor;

  constructor(private readonly options: RestClientOptions) {
    if (!options.rpcUrl && !options.allowUnsimulated) {
      throw new Error(
        "rpcUrl is required: the REST SDK exposes no simulation, so skipping the local " +
          "preflight would broadcast an unchecked batch. Pass allowUnsimulated to override.",
      );
    }
    this.executor = new DirectExecutor(
      new KeeperHubSdkClient({
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      }),
    );
  }

  async simulate(call: SettlementCall): Promise<SimulationResult> {
    if (!this.options.rpcUrl) return { ok: true, via: "local-eth-call" };
    const publicClient = createPublicClient({ transport: http(this.options.rpcUrl) });
    try {
      const gas = await publicClient.estimateContractGas({
        address: call.contractAddress as Address,
        abi: call.abi as never,
        functionName: call.functionName,
        args: call.args as never,
        account: this.options.senderAddress,
      });
      return { ok: true, gasEstimate: gas.toString(10), via: "local-eth-call" };
    } catch (error) {
      return { ok: false, revertReason: describe(error), via: "local-eth-call" };
    }
  }

  async execute(call: SettlementCall, _idempotencyKey: string): Promise<ExecutionHandle> {
    const result = await this.executor.callContract({
      network: call.network,
      contractAddress: call.contractAddress,
      functionName: call.functionName,
      functionArgs: JSON.stringify(call.args),
      abi: JSON.stringify(call.abi),
    });
    if (isReadResult(result)) {
      throw new Error(`${call.functionName} was treated as a read call; expected a write`);
    }
    return { executionId: result.executionId, idempotencyEnforcedRemotely: false };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    const status = await this.executor.getStatus(executionId);
    return {
      state: normalizeState(status.status),
      ...(status.transactionHash ? { txHash: status.transactionHash } : {}),
      ...(status.transactionLink ? { txLink: status.transactionLink } : {}),
      ...(status.gasUsedWei ? { gasUsedWei: status.gasUsedWei } : {}),
      ...(status.error ? { error: status.error } : {}),
    };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}
