import { loadConfig, type AgentConfig } from "./config.js";
import { lastClosedEpoch, tipsInEpoch } from "./epoch.js";
import { idempotencyKey } from "./idempotency.js";
import { JsonlTipSource } from "./ingest/source.js";
import type { KeeperHubClient } from "./keeperhub.js";
import { EpochLedger } from "./ledger.js";
import { planSettlement } from "./netting.js";
import { resume, settleEpoch } from "./settle.js";
import { McpKeeperHubClient } from "./adapters/mcp.js";
import { RestKeeperHubClient } from "./adapters/rest.js";
import type { SettlementPlan } from "./types.js";

function connect(config: AgentConfig): KeeperHubClient {
  if (config.transport === "mcp") {
    return new McpKeeperHubClient({ apiKey: config.apiKey });
  }
  return new RestKeeperHubClient({
    apiKey: config.apiKey,
    senderAddress: config.senderAddress,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  });
}

async function buildPlan(config: AgentConfig, ledger: EpochLedger): Promise<SettlementPlan> {
  const epochId = lastClosedEpoch(Date.now(), config.intervalMs);
  const tips = tipsInEpoch(await new JsonlTipSource(config.tipsPath).tips(), epochId, config.intervalMs);
  const previous = ledger.previousEpochId(epochId);
  return planSettlement(epochId, tips, config, previous ? ledger.carriedFrom(previous) : []);
}

function describe(plan: SettlementPlan): void {
  console.log(`epoch          ${plan.epochId}`);
  console.log(`chain          ${plan.chainId}`);
  console.log(`tips           ${plan.tipIds.length}`);
  console.log(`payouts        ${plan.payouts.length} totalling ${plan.total}`);
  for (const payout of plan.payouts) console.log(`  → ${payout.recipient}  ${payout.amount}`);
  if (plan.carried.length > 0) {
    console.log(`carried        ${plan.carried.length} balances into the next epoch`);
  }
  console.log(`idempotency    ${idempotencyKey(plan)}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "plan";
  const config = loadCommandConfig(command);
  const ledger = new EpochLedger(config.ledgerPath);

  if (command === "plan") {
    describe(await buildPlan(config, ledger));
    console.log("\nnothing was broadcast; run `settle` to execute");
    return;
  }

  if (command === "settle") {
    const client = connect(config);

    // Always before planning: an epoch left in flight by a crash must be resolved
    // by polling its execution, never by re-netting the same tips.
    for (const resolved of await resume(client, ledger)) {
      console.log(`resumed ${resolved.epochId}: ${resolved.status} ${resolved.txHash ?? ""}`);
    }

    const plan = await buildPlan(config, ledger);
    if (plan.payouts.length === 0) {
      console.log(`${plan.epochId}: nothing above dust to settle`);
      return;
    }
    describe(plan);

    const record = await settleEpoch(plan, client, ledger);
    console.log(`\nstatus         ${record.status}`);
    if (record.txHash) console.log(`tx             ${record.txLink ?? record.txHash}`);
    if (record.error) console.log(`error          ${record.error}`);
    process.exitCode = record.status === "settled" ? 0 : 1;
    return;
  }

  console.error(`unknown command: ${command}\nusage: settle | plan`);
  process.exitCode = 2;
}

/** `plan` is offline, so it must not demand an API key just to show the arithmetic. */
function loadCommandConfig(command: string): AgentConfig {
  if (command !== "plan") return loadConfig();
  return loadConfig({ KH_API_KEY: "kh_offline-plan-only", ...process.env });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
