import { getClient } from "@keeperhub/mcp";
import {
  normalizeState,
  type ExecutionHandle,
  type ExecutionStatus,
  type KeeperHubClient,
  type SettlementCall,
  type SimulationResult,
} from "../keeperhub.js";

/**
 * ⚠️ UNVERIFIED — tool names and argument keys.
 *
 * `@keeperhub/mcp` is a transport only: it exposes `callTool(name, args)` and
 * bundles no schemas. The real ones live behind `tools/list` at
 * https://app.keeperhub.com/mcp, which needs a `kh_` key and network access.
 * The names below come from KeeperHub's documented call sequence; confirm them
 * with one `tools/list` before trusting this adapter with money.
 */
const TOOL = {
  executeContractCall: "execute_contract_call",
  getStatus: "get_direct_execution_status",
} as const;

export interface McpClientOptions {
  apiKey: string;
  baseUrl?: string;
}

interface CallToolCapable {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * KeeperHub via the MCP endpoint.
 *
 * Preferred over the REST adapter when available: because `callTool` passes
 * arbitrary arguments, this is the only transport that can carry `simulate` and
 * `idempotency_key` through to KeeperHub, which makes exactly-once enforceable
 * on the server rather than only in the local ledger.
 */
export class McpKeeperHubClient implements KeeperHubClient {
  private readonly client: CallToolCapable;

  constructor(options: McpClientOptions) {
    this.client = getClient(options.apiKey, {
      clientInfo: { name: "netted-tips", version: "0.1.0" },
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    }) as unknown as CallToolCapable;
  }

  async simulate(call: SettlementCall): Promise<SimulationResult> {
    const response = (await this.client.callTool(TOOL.executeContractCall, {
      ...toolArgs(call),
      simulate: true,
    })) as { error?: string; revertReason?: string; gasEstimate?: string };

    const reason = response?.revertReason ?? response?.error;
    return reason
      ? { ok: false, revertReason: reason, via: "keeperhub" }
      : {
          ok: true,
          via: "keeperhub",
          ...(response?.gasEstimate ? { gasEstimate: response.gasEstimate } : {}),
        };
  }

  async execute(call: SettlementCall, idempotencyKey: string): Promise<ExecutionHandle> {
    const response = (await this.client.callTool(TOOL.executeContractCall, {
      ...toolArgs(call),
      idempotency_key: idempotencyKey,
    })) as { executionId?: string; execution_id?: string };

    const executionId = response?.executionId ?? response?.execution_id;
    if (!executionId) {
      throw new Error(`${TOOL.executeContractCall} returned no execution id`);
    }
    return { executionId, idempotencyEnforcedRemotely: true };
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
    };

    return {
      state: normalizeState(response?.status ?? "pending"),
      ...(response?.transactionHash ? { txHash: response.transactionHash } : {}),
      ...(response?.transactionLink ? { txLink: response.transactionLink } : {}),
      ...(response?.gasUsedWei ? { gasUsedWei: response.gasUsedWei } : {}),
      ...(response?.error ? { error: response.error } : {}),
    };
  }
}

function toolArgs(call: SettlementCall): Record<string, unknown> {
  return {
    network: call.network,
    contractAddress: call.contractAddress,
    functionName: call.functionName,
    functionArgs: JSON.stringify(call.args),
    abi: JSON.stringify(call.abi),
  };
}
