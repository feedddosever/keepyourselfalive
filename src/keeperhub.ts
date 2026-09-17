import type { SettlementPlan } from "./types.js";

/**
 * The KeeperHub surface this agent depends on, narrowed to three calls.
 *
 * ⚠️ ADAPTER BOUNDARY — the field names below are reconstructed, not read off the
 * docs (docs.keeperhub.com was unreachable from the build environment). The
 * documented call sequence is:
 *
 *   execute_contract_call { simulate: true }      → dry run, no value moves
 *   execute_contract_call { idempotency_key }     → broadcast, replayed on retry
 *   get_direct_execution_status { execution_id }  → once per execution id
 *
 * Everything else in this repo is written against this interface, so reconciling
 * it with the real schema is a one-file change.
 */
export interface ContractCall {
  chainId: number;
  to: string;
  data: `0x${string}`;
  value?: string;
}

export interface SimulationResult {
  ok: boolean;
  gasEstimate?: string;
  revertReason?: string;
}

export interface ExecutionHandle {
  executionId: string;
}

export interface ExecutionStatus {
  state: "pending" | "confirmed" | "failed";
  txHash?: string;
  error?: string;
}

export interface KeeperHubClient {
  simulate(call: ContractCall): Promise<SimulationResult>;
  execute(call: ContractCall, idempotencyKey: string): Promise<ExecutionHandle>;
  status(executionId: string): Promise<ExecutionStatus>;
}

/** Guard rail independent of the adapter: the plan must target the configured disperser. */
export function assertCallMatchesPlan(call: ContractCall, plan: SettlementPlan): void {
  if (call.chainId !== plan.chainId) {
    throw new Error(`call targets chain ${call.chainId}, plan is for ${plan.chainId}`);
  }
  if (call.to.toLowerCase() !== plan.disperser) {
    throw new Error(`call targets ${call.to}, plan disperses via ${plan.disperser}`);
  }
}
