import type { SettlementPlan } from "./types.js";

/**
 * The KeeperHub surface this agent depends on, narrowed to three operations.
 *
 * Shapes here follow `@keeperhub/sdk@0.1.1`'s Direct Execution API, which takes a
 * function name plus JSON-encoded args rather than raw calldata.
 *
 * Two implementations satisfy this port because the two official surfaces do not
 * agree on what they expose — see `docs/FRICTION.md`:
 *
 *   RestKeeperHubClient — @keeperhub/sdk. No simulate, no idempotency key.
 *   McpKeeperHubClient  — @keeperhub/mcp. Generic `callTool`, so the documented
 *                         `simulate` / `idempotency_key` arguments can be passed.
 */
export interface SettlementCall {
  /** Chain id or network name; the API accepts either ("base", "8453"). */
  network: string;
  chainId: number;
  contractAddress: string;
  functionName: string;
  args: readonly unknown[];
  abi: readonly unknown[];
}

export interface SimulationResult {
  ok: boolean;
  gasEstimate?: string;
  revertReason?: string;
  /** How the preflight was performed, so the audit trail never overstates it. */
  via: "keeperhub" | "local-eth-call";
}

export interface ExecutionHandle {
  executionId: string;
  /** False when the transport could not carry the idempotency key to KeeperHub. */
  idempotencyEnforcedRemotely: boolean;
}

export interface ExecutionStatus {
  state: "pending" | "confirmed" | "failed";
  txHash?: string;
  txLink?: string;
  gasUsedWei?: string;
  error?: string;
}

export interface KeeperHubClient {
  simulate(call: SettlementCall): Promise<SimulationResult>;
  execute(call: SettlementCall, idempotencyKey: string): Promise<ExecutionHandle>;
  status(executionId: string): Promise<ExecutionStatus>;
}

/** Guard rail independent of the transport: the call must match the plan it came from. */
export function assertCallMatchesPlan(call: SettlementCall, plan: SettlementPlan): void {
  if (call.chainId !== plan.chainId) {
    throw new Error(`call targets chain ${call.chainId}, plan is for ${plan.chainId}`);
  }
  if (call.contractAddress.toLowerCase() !== plan.disperser) {
    throw new Error(`call targets ${call.contractAddress}, plan disperses via ${plan.disperser}`);
  }
}

/**
 * Collapses KeeperHub's execution states to the three this agent acts on.
 *
 * Only `completed` and `failed` are terminal. `unconfirmed` in particular means
 * the transaction is already on chain but not yet confirmed — treating it as
 * failure and re-sending would put a second transaction on the same nonce, so it
 * maps to pending and the caller keeps polling.
 */
export function normalizeState(status: string): ExecutionStatus["state"] {
  switch (status) {
    case "completed":
    case "success":
      return "confirmed";
    case "failed":
    case "error":
    case "cancelled":
      return "failed";
    case "pending":
    case "running":
    case "unconfirmed":
    default:
      return "pending";
  }
}
