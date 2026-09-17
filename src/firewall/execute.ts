import { McpKeeperHubClient, IdempotencyInProgressError } from "../adapters/mcp.js";
import { NonceFirewall } from "./firewall.js";
import type { Intent } from "./intent.js";
import { LaneStore, type AuditEntry } from "./store.js";

/**
 * Drives real intents through the firewall to KeeperHub.
 *
 * The demonstration: N intents submitted at once against ONE sender key. Without
 * the firewall they are assigned the same nonce and all but one is lost. With it
 * they land as N sequential transactions on N consecutive nonces — which is
 * visible afterwards in the explorer, not just in the log.
 */

/**
 * Default action: `approve(spender, 0)` on an ERC-20.
 *
 * Chosen because it is the cheapest possible way to prove the point. It moves no
 * value, needs no token balance, and costs only gas — so the wallet needs a dust
 * amount of native currency and nothing else. Two approvals naming two different
 * spenders are two genuinely distinct intents contending for one nonce, which is
 * the whole demonstration; the action itself is incidental.
 */
const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const WETH_DEPOSIT_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

/** Distinct, inert spender addresses so each approval is its own intent. */
function spender(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
  11155111: "https://sepolia.etherscan.io",
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function config() {
  const apiKey = process.env.KH_API_KEY ?? process.env.KEEPERHUB_API_KEY;
  if (!apiKey) throw new Error("KH_API_KEY is not set");
  if (apiKey.startsWith("wfb_")) {
    throw new Error("KH_API_KEY is a wfb_ webhook key; MCP needs an organization key (kh_)");
  }
  return {
    apiKey,
    chainId: Number(process.env.CHAIN_ID ?? 84532),
    sender: required("SENDER_ADDRESS"),
    mode: (process.env.EXECUTE_MODE ?? "approve") as "approve" | "deposit",
    target:
      process.env.TARGET_ADDRESS ??
      (process.env.EXECUTE_MODE === "deposit"
        ? "0x4200000000000000000000000000000000000006"
        : "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
    value: process.env.EXECUTE_VALUE ?? "0.0000001",
    count: Number(process.env.EXECUTE_COUNT ?? 2),
    ledgerPath: process.env.LEDGER_PATH ?? "state/lanes.json",
    gasCeiling: process.env.GAS_CEILING ? BigInt(process.env.GAS_CEILING) : undefined,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const settings = config();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const client = new McpKeeperHubClient({ apiKey: settings.apiKey });
  const store = new LaneStore(settings.ledgerPath);
  const firewall = new NonceFirewall(store, client, { stuckAfterMs: 300_000 });

  console.log(`chain ${settings.chainId}  mode ${settings.mode}  sender ${settings.sender}`);
  console.log(`target ${settings.target}`);
  console.log(`submitting ${settings.count} intents against one key\n`);

  for (let i = 1; i <= settings.count; i += 1) {
    const deposit = settings.mode === "deposit";
    // Each intent must differ in its onchain effect, or the firewall would
    // correctly collapse them into one: distinct spenders here, distinct values
    // there.
    const value = (Number(settings.value) * i).toFixed(12).replace(/0+$/, "");
    const call = deposit
      ? { contractAddress: settings.target, functionName: "deposit", args: [], abi: WETH_DEPOSIT_ABI, value }
      : {
          contractAddress: settings.target,
          functionName: "approve",
          args: [spender(i), "0"],
          abi: APPROVE_ABI,
        };

    const intent: Intent = {
      id: `${runId}-${settings.mode}-${i}`,
      submitter: `agent-${i}`,
      chainId: settings.chainId,
      sender: settings.sender,
      call,
      // Distinct per intent: these are independent actions, not replacements of
      // one another, so they must not supersede each other.
      writes: [`${settings.mode}:${settings.target}#${i}`],
      submittedAtMs: Date.now(),
      ...(settings.gasCeiling === undefined ? {} : { gasCeiling: settings.gasCeiling }),
    };
    const label = deposit ? `${value} ETH` : `approve ${spender(i).slice(0, 10)}…`;
    console.log(`  agent-${i} (${label}) → ${firewall.submit(intent).decision}`);
  }

  console.log("");
  const deadline = Date.now() + 10 * 60_000;
  let settled = 0;

  while (Date.now() < deadline && settled < settings.count) {
    try {
      for (const action of await firewall.drain()) {
        console.log(`  ${action.intentId} → ${action.decision}${action.reason ? ` (${action.reason})` : ""}`);
        if (action.decision.startsWith("rejected")) settled += 1;
      }
    } catch (error) {
      if (!(error instanceof IdempotencyInProgressError)) throw error;
      console.log("  in progress under the same key; holding the key and retrying");
    }

    for (const action of await firewall.poll()) {
      settled += 1;
      const link = action.txHash ? `${EXPLORERS[settings.chainId] ?? ""}/tx/${action.txHash}` : "";
      console.log(`  ${action.intentId} → ${action.decision} ${link}`);
    }

    await sleep(4000);
  }

  report(store.audit(), settings.chainId);
  process.exitCode = settled >= settings.count ? 0 : 1;
}

function report(audit: readonly AuditEntry[], chainId: number): void {
  console.log("\naudit trail");
  for (const entry of audit) {
    const reason = entry.reason ? `  ${entry.reason}` : "";
    console.log(`  ${entry.intentId.padEnd(34)} ${entry.decision}${reason}`);
  }

  const hashes = audit.filter((entry) => entry.txHash).map((entry) => entry.txHash);
  if (hashes.length === 0) {
    console.log("\nno transaction landed");
    return;
  }
  console.log(`\n${hashes.length} transaction(s), each on its own nonce:`);
  for (const hash of hashes) console.log(`  ${EXPLORERS[chainId] ?? ""}/tx/${hash}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
