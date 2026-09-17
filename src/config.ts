import type { Address } from "viem";
import { normalizeAddress } from "./address.js";
import type { SettlementConfig } from "./types.js";

export interface AgentConfig extends SettlementConfig {
  transport: "mcp" | "rest";
  apiKey: string;
  senderAddress: Address;
  rpcUrl?: string;
  intervalMs: number;
  tipsPath: string;
  ledgerPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const apiKey = env.KH_API_KEY ?? env.KEEPERHUB_API_KEY;
  if (!apiKey) throw new Error("KH_API_KEY is not set (see .env.example)");
  if (apiKey.startsWith("wfb_")) {
    throw new Error(
      "KH_API_KEY is a wfb_ webhook key. MCP and the REST API need an organization " +
        "key (kh_) from Settings → API Keys → Organisation.",
    );
  }

  const transport = (env.KH_TRANSPORT ?? "mcp") as AgentConfig["transport"];
  if (transport !== "mcp" && transport !== "rest") {
    throw new Error(`KH_TRANSPORT must be "mcp" or "rest", got ${transport}`);
  }

  const intervalMs = Number(env.SETTLEMENT_INTERVAL_MS ?? 3_600_000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`SETTLEMENT_INTERVAL_MS must be a positive number, got ${env.SETTLEMENT_INTERVAL_MS}`);
  }

  return {
    transport,
    apiKey,
    chainId: Number(required(env, "CHAIN_ID")),
    token: normalizeAddress(required(env, "TOKEN_ADDRESS")),
    disperser: normalizeAddress(required(env, "DISPERSER_ADDRESS")),
    senderAddress: normalizeAddress(required(env, "SENDER_ADDRESS")) as Address,
    dustThreshold: BigInt(env.DUST_THRESHOLD ?? "10000"),
    ...(env.RPC_URL ? { rpcUrl: env.RPC_URL } : {}),
    intervalMs,
    tipsPath: env.TIPS_PATH ?? "state/tips.jsonl",
    ledgerPath: env.LEDGER_PATH ?? "state/epochs.json",
  };
}
