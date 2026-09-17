import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceFirewall } from "./firewall.js";
import type { Intent } from "./intent.js";
import { LaneStore } from "./store.js";
import type {
  ExecutionHandle,
  ExecutionStatus,
  KeeperHubClient,
  SettlementCall,
  SimulationResult,
} from "../keeperhub.js";

/**
 * Runs the firewall against a stand-in for KeeperHub so the behaviour can be
 * watched without an API key. Nothing here touches a network; the point is the
 * admission decisions, which are the same ones the real adapters drive.
 */
class ScriptedKeeperHub implements KeeperHubClient {
  broadcasts = 0;
  gasEstimate = "50000";
  private statuses = new Map<string, ExecutionStatus>();
  private stuck = new Set<string>();

  async simulate(): Promise<SimulationResult> {
    return { ok: true, gasEstimate: this.gasEstimate, via: "keeperhub" };
  }

  async execute(_call: SettlementCall, _key: string): Promise<ExecutionHandle> {
    this.broadcasts += 1;
    const executionId = `exec-${this.broadcasts}`;
    this.statuses.set(executionId, { state: "pending" });
    return { executionId, idempotencyEnforcedRemotely: true };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    if (this.stuck.has(executionId)) return { state: "pending" };
    return this.statuses.get(executionId) ?? { state: "failed", error: "unknown" };
  }

  confirm(executionId: string): void {
    this.statuses.set(executionId, { state: "confirmed", txHash: `0x${executionId.padEnd(40, "0")}` });
  }

  wedge(executionId: string): void {
    this.stuck.add(executionId);
  }
}

const SENDER = "0x00000000000000000000000000000000000000f1";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function intent(id: string, submitter: string, writes: string[], extra: Partial<Intent> = {}): Intent {
  return {
    id,
    submitter,
    chainId: 84532,
    sender: SENDER,
    call: { contractAddress: TOKEN, functionName: "transfer", args: [id, "1"], abi: ABI },
    writes,
    submittedAtMs: Date.now(),
    ...extra,
  };
}

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

async function main(): Promise<void> {
  const client = new ScriptedKeeperHub();
  const store = new LaneStore(join(mkdtempSync(join(tmpdir(), "firewall-demo-")), "lanes.json"));
  let clock = Date.now();
  const firewall = new NonceFirewall(store, client, { now: () => clock, stuckAfterMs: 60_000 });

  heading("1. Six agents submit at once against one treasury key");
  for (let i = 1; i <= 6; i += 1) {
    const result = firewall.submit(intent(`payout-${i}`, `agent-${i}`, [`invoice-${i}`]));
    console.log(`   agent-${i} → ${result.decision}`);
  }

  let actions = await firewall.drain();
  console.log(`   drain admitted ${actions.length}, broadcast count ${client.broadcasts}`);
  console.log("   \x1b[2mwithout the lease, all six would be assigned the same nonce\x1b[0m");

  heading("2. Draining again while the lease is held changes nothing");
  await firewall.drain();
  await firewall.drain();
  console.log(`   broadcast count still ${client.broadcasts}`);

  heading("3. The lease releases only when the transaction resolves");
  client.confirm("exec-1");
  for (const action of await firewall.poll()) console.log(`   ${action.intentId} → ${action.decision}`);
  actions = await firewall.drain();
  console.log(`   next admitted: ${actions[0]?.intentId}, broadcast count ${client.broadcasts}`);

  heading("4. A stale intent is superseded by its own submitter's fresher one");
  firewall.submit(intent("rebalance-stale", "agent-7", ["pool:eth-usdc"], { submittedAtMs: clock }));
  const superseded = firewall.submit(
    intent("rebalance-fresh", "agent-7", ["pool:eth-usdc"], { submittedAtMs: clock + 1 }),
  );
  console.log(`   ${superseded.decision}: dropped ${superseded.supersededIds?.join(", ")}`);
  console.log("   \x1b[2ma different agent naming the same resource would queue, not cancel\x1b[0m");

  heading("5. A gas ceiling is enforced before broadcast, not after");
  client.gasEstimate = "1200000";
  firewall.submit(intent("runaway", "agent-8", ["invoice-8"], { gasCeiling: 150_000n, priority: -5 }));
  client.confirm("exec-2");
  await firewall.poll();
  for (const action of await firewall.drain()) {
    console.log(`   ${action.intentId} → ${action.decision} (${action.reason})`);
  }
  console.log(`   broadcast count ${client.broadcasts} — the rejected intent never reached the chain`);

  heading("6. A wedged transaction quarantines its lane instead of stacking nonces");
  client.gasEstimate = "50000";
  await firewall.drain();
  client.wedge(`exec-${client.broadcasts}`);
  clock += 61_000;
  for (const action of await firewall.poll()) console.log(`   ${action.intentId} → ${action.decision}`);
  const refused = firewall.submit(intent("after-wedge", "agent-9", ["invoice-9"]));
  console.log(`   new submission → ${refused.decision}`);
  const before = client.broadcasts;
  await firewall.drain();
  console.log(`   broadcast count ${client.broadcasts} (was ${before}) — nothing queued behind the wedge`);

  heading("Audit trail");
  for (const entry of store.audit()) {
    const reason = entry.reason ? ` \x1b[2m${entry.reason}\x1b[0m` : "";
    console.log(`   ${entry.laneKey}  ${entry.intentId.padEnd(18)} ${entry.decision}${reason}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
