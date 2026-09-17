import { getClient } from "@keeperhub/mcp";
import {
  normalizeState,
  type ExecutionHandle,
  type ExecutionStatus,
  type KeeperHubClient,
  type NativeTransfer,
  type SettlementCall,
  type SimulationResult,
} from "../keeperhub.js";
import { buildContractCallBody } from "./body.js";

const TOOL = {
  executeContractCall: "execute_contract_call",
  executeTransfer: "execute_transfer",
  getStatus: "get_direct_execution_status",
} as const;

export interface CallToolCapable {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Inject for tests; defaults to the real MCP transport. */
  transport?: CallToolCapable;
}

/**
 * Raised when KeeperHub says the body does not match the one this key was bound
 * to. Deliberately fatal: the documented remedy is to rebuild the body to match
 * the original and keep the key, because rotating it escapes the in-flight guard
 * and can broadcast a second transaction. Nothing here retries on its own.
 */
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string, detail: string) {
    super(
      `idempotency_conflict for key ${idempotencyKey}: ${detail}. The body drifted, not ` +
        "the intent — rebuild it byte-for-byte and reuse this key. Rotating the key here " +
        "can broadcast a second transaction.",
    );
    this.name = "IdempotencyConflictError";
  }
}

/** Raised while the first request under this key is still running; retry the same key. */
export class IdempotencyInProgressError extends Error {
  readonly retryable = true;
  constructor(readonly idempotencyKey: string) {
    super(`idempotency_in_progress for key ${idempotencyKey}; retry shortly with the same key`);
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * KeeperHub via the MCP endpoint.
 *
 * Preferred over the REST adapter: `execute_contract_call` here accepts both
 * `simulate` and `idempotency_key`, neither of which `@keeperhub/sdk@0.1.1`
 * exposes at all.
 */
export class McpKeeperHubClient implements KeeperHubClient {
  private readonly client: CallToolCapable;

  constructor(options: McpClientOptions) {
    this.client =
      options.transport ??
      (getClient(options.apiKey, {
        clientInfo: { name: "nonce-firewall", version: "0.1.0" },
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      }) as unknown as CallToolCapable);
  }

  /**
   * A failing dry run arrives as an HTTP 400, not a result with `ok: false`, so
   * the rejection has to be read out of the thrown error. Code that only handles
   * the happy path sees a transport failure and may retry a call the simulator
   * already decided would revert.
   */
  async simulate(call: SettlementCall): Promise<SimulationResult> {
    try {
      const response = (await this.client.callTool(TOOL.executeContractCall, {
        ...buildContractCallBody(call),
        simulate: true,
      })) as { wouldRevert?: boolean; revertReason?: string; gasEstimate?: string };

      return response?.wouldRevert
        ? { ok: false, revertReason: response.revertReason ?? "would revert", via: "keeperhub" }
        : {
            ok: true,
            via: "keeperhub",
            ...(response?.gasEstimate ? { gasEstimate: response.gasEstimate } : {}),
          };
    } catch (error) {
      const detail = parseError(error);
      if (detail.wouldRevert || detail.code === "insufficient_balance" || detail.revertReason) {
        return {
          ok: false,
          revertReason: detail.revertReason ?? detail.code ?? "simulation failed",
          via: "keeperhub",
        };
      }
      throw error;
    }
  }

  async execute(call: SettlementCall, idempotencyKey: string): Promise<ExecutionHandle> {
    let response: { executionId?: string; execution_id?: string; idempotentReplay?: boolean };
    try {
      response = (await this.client.callTool(TOOL.executeContractCall, {
        ...buildContractCallBody(call),
        idempotency_key: idempotencyKey,
      })) as { executionId?: string; execution_id?: string; idempotentReplay?: boolean };
    } catch (error) {
      const detail = parseError(error);
      if (detail.code === "idempotency_in_progress") throw new IdempotencyInProgressError(idempotencyKey);
      if (detail.code === "idempotency_conflict") {
        throw new IdempotencyConflictError(idempotencyKey, detail.revertReason ?? detail.message ?? "body mismatch");
      }
      throw error;
    }

    const executionId = response?.executionId ?? response?.execution_id;
    if (!executionId) throw new Error(`${TOOL.executeContractCall} returned no execution id`);
    // KeeperHub sets idempotentReplay when it returned a prior execution rather
    // than broadcasting. Surfacing it lets a caller tell "paid now" from
    // "already paid", which a retrying buyer needs to hear.
    return {
      executionId,
      idempotencyEnforcedRemotely: true,
      replayed: response?.idempotentReplay === true,
    };
  }

  async simulateTransfer(transfer: NativeTransfer): Promise<SimulationResult> {
    try {
      const response = (await this.client.callTool(TOOL.executeTransfer, {
        ...transferBody(transfer),
        simulate: true,
      })) as { wouldRevert?: boolean; revertReason?: string; gasEstimate?: string };

      return response?.wouldRevert
        ? { ok: false, revertReason: response.revertReason ?? "would revert", via: "keeperhub" }
        : {
            ok: true,
            via: "keeperhub",
            ...(response?.gasEstimate ? { gasEstimate: response.gasEstimate } : {}),
          };
    } catch (error) {
      const detail = parseError(error);
      if (detail.wouldRevert || detail.code === "insufficient_balance" || detail.revertReason) {
        return {
          ok: false,
          revertReason: detail.revertReason ?? detail.code ?? "transfer simulation failed",
          via: "keeperhub",
        };
      }
      throw error;
    }
  }

  async executeTransfer(transfer: NativeTransfer, idempotencyKey: string): Promise<ExecutionHandle> {
    let response: { executionId?: string; execution_id?: string; idempotentReplay?: boolean };
    try {
      response = (await this.client.callTool(TOOL.executeTransfer, {
        ...transferBody(transfer),
        idempotency_key: idempotencyKey,
      })) as typeof response;
    } catch (error) {
      const detail = parseError(error);
      if (detail.code === "idempotency_in_progress") throw new IdempotencyInProgressError(idempotencyKey);
      if (detail.code === "idempotency_conflict") {
        throw new IdempotencyConflictError(idempotencyKey, detail.revertReason ?? detail.message ?? "body mismatch");
      }
      throw error;
    }

    const executionId = response?.executionId ?? response?.execution_id;
    if (!executionId) throw new Error(`${TOOL.executeTransfer} returned no execution id`);
    return {
      executionId,
      idempotencyEnforcedRemotely: true,
      replayed: response?.idempotentReplay === true,
    };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    const response = (await this.client.callTool(TOOL.getStatus, {
      execution_id: executionId,
    })) as {
      status?: string;
      transactionHash?: string;
      transactionLink?: string;
      gasUsedWei?: string;
      error?: string | null;
      receipts?: Array<{
        hash?: string;
        verified?: boolean;
        blockNumber?: number;
        receiptStatus?: string;
      }>;
    };

    // The receipt KeeperHub reconciled against the chain, matched by hash. Its
    // `verified` flag is a stronger claim than the execution's status, and it is
    // the one a caller should gate an irreversible action on.
    const receipt =
      response?.receipts?.find((entry) => entry.hash === response.transactionHash) ??
      response?.receipts?.[0];

    return {
      state: normalizeState(response?.status ?? "pending"),
      ...(response?.transactionHash ? { txHash: response.transactionHash } : {}),
      ...(response?.transactionLink ? { txLink: response.transactionLink } : {}),
      ...(response?.gasUsedWei ? { gasUsedWei: response.gasUsedWei } : {}),
      ...(response?.error ? { error: response.error } : {}),
      ...(receipt?.verified === undefined ? {} : { verified: receipt.verified }),
      ...(receipt?.blockNumber === undefined ? {} : { blockNumber: receipt.blockNumber }),
      ...(receipt?.receiptStatus ? { receiptStatus: receipt.receiptStatus } : {}),
    };
  }
}

interface ErrorDetail {
  code?: string;
  revertReason?: string;
  message?: string;
  wouldRevert?: boolean;
}

/** KeeperHub returns a JSON body inside the error text; branch on `code`, not prose. */
export function parseError(error: unknown): ErrorDetail {
  const text = error instanceof Error ? error.message : String(error);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { message: text };
  try {
    const body = JSON.parse(text.slice(start, end + 1)) as ErrorDetail & { error?: string };
    return { ...body, message: body.message ?? body.error ?? text };
  } catch {
    return { message: text };
  }
}

/**
 * Body for `execute_transfer`.
 *
 * The amount passes through verbatim. It is in ether units, so it is the exact
 * case KeeperHub documents as breaking an idempotency binding when reformatted
 * — "0.1" re-serialized as "0.10" is a different body under the same key.
 */
function transferBody(transfer: NativeTransfer): Record<string, string> {
  return {
    chain_id: transfer.chainId.toString(10),
    to_address: transfer.toAddress,
    amount: transfer.amount,
  };
}
