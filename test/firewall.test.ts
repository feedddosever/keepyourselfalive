import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NonceFirewall } from "../src/firewall/firewall.js";
import { compareIntents, type Intent } from "../src/firewall/intent.js";
import { LaneStore } from "../src/firewall/store.js";
import type {
  ExecutionHandle,
  ExecutionStatus,
  KeeperHubClient,
  SettlementCall,
  SimulationResult,
} from "../src/keeperhub.js";

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

const SENDER = "0x00000000000000000000000000000000000000f1";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function intent(overrides: Partial<Intent> & Pick<Intent, "id">): Intent {
  return {
    submitter: "agent-a",
    chainId: 84532,
    sender: SENDER,
    call: { contractAddress: TOKEN, functionName: "transfer", args: [overrides.id, "1"], abi: ABI },
    writes: ["treasury:usdc"],
    submittedAtMs: 1_000,
    ...overrides,
  };
}

class FakeKeeperHub implements KeeperHubClient {
  broadcasts: { key: string; call: SettlementCall }[] = [];
  gasEstimate = "50000";
  revertReason: string | undefined;
  private statuses = new Map<string, ExecutionStatus>();

  async simulate(): Promise<SimulationResult> {
    return this.revertReason
      ? { ok: false, revertReason: this.revertReason, via: "keeperhub" }
      : { ok: true, gasEstimate: this.gasEstimate, via: "keeperhub" };
  }

  async execute(call: SettlementCall, idempotencyKey: string): Promise<ExecutionHandle> {
    const executionId = `exec-${this.broadcasts.length + 1}`;
    this.broadcasts.push({ key: idempotencyKey, call });
    this.statuses.set(executionId, { state: "pending" });
    return { executionId, idempotencyEnforcedRemotely: true };
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    return this.statuses.get(executionId) ?? { state: "failed", error: "unknown execution" };
  }

  confirm(executionId: string, txHash: string): void {
    this.statuses.set(executionId, { state: "confirmed", txHash });
  }
}

let client: FakeKeeperHub;
let storePath: string;
let clock: number;

function build(options: { stuckAfterMs?: number } = {}): NonceFirewall {
  return new NonceFirewall(new LaneStore(storePath), client, {
    now: () => clock,
    ...(options.stuckAfterMs === undefined ? {} : { stuckAfterMs: options.stuckAfterMs }),
  });
}

beforeEach(() => {
  client = new FakeKeeperHub();
  storePath = join(mkdtempSync(join(tmpdir(), "firewall-")), "lanes.json");
  clock = 10_000;
});

describe("lane exclusivity", () => {
  it("broadcasts one of twenty concurrent intents and queues the rest", async () => {
    const firewall = build();
    for (let i = 0; i < 20; i += 1) {
      firewall.submit(intent({ id: `intent-${i}`, submitter: `agent-${i}`, writes: [`slot-${i}`] }));
    }

    await firewall.drain();
    expect(client.broadcasts).toHaveLength(1);

    // Draining again while the lease is held must not admit a second.
    await firewall.drain();
    await firewall.drain();
    expect(client.broadcasts).toHaveLength(1);
  });

  it("admits the next intent only once the lease is released", async () => {
    const firewall = build();
    firewall.submit(intent({ id: "first", submitter: "agent-a", writes: ["a"] }));
    firewall.submit(intent({ id: "second", submitter: "agent-b", writes: ["b"] }));

    await firewall.drain();
    expect(client.broadcasts).toHaveLength(1);

    client.confirm("exec-1", "0xaaa");
    await firewall.poll();
    await firewall.drain();

    expect(client.broadcasts).toHaveLength(2);
  });

  it("runs separate sender keys in parallel", async () => {
    const firewall = build();
    firewall.submit(intent({ id: "on-key-1", sender: SENDER, writes: ["a"] }));
    firewall.submit(intent({
      id: "on-key-2",
      sender: "0x00000000000000000000000000000000000000f2",
      writes: ["b"],
    }));

    await firewall.drain();
    expect(client.broadcasts).toHaveLength(2);
  });
});

describe("admission order", () => {
  it("is identical under any submission order", () => {
    const intents = Array.from({ length: 30 }, (_, i) =>
      intent({ id: `intent-${i}`, submitter: `agent-${i}`, writes: [`slot-${i}`] }),
    );
    const forward = [...intents].sort(compareIntents).map((i) => i.id);
    const backward = [...intents].reverse().sort(compareIntents).map((i) => i.id);
    expect(backward).toEqual(forward);
  });

  it("honours priority before the hash tiebreak", () => {
    const urgent = intent({ id: "urgent", priority: -1, submitter: "agent-b", writes: ["b"] });
    const normal = intent({ id: "normal", submitter: "agent-c", writes: ["c"] });
    expect([normal, urgent].sort(compareIntents)[0]?.id).toBe("urgent");
  });

  it("admits the deterministic winner, not the first to arrive", async () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      intent({ id: `intent-${i}`, submitter: `agent-${i}`, writes: [`slot-${i}`] }),
    );
    const expected = [...candidates].sort(compareIntents)[0]?.id;

    const firewall = build();
    for (const candidate of [...candidates].reverse()) firewall.submit(candidate);
    const actions = await firewall.drain();

    expect(actions[0]?.intentId).toBe(expected);
  });
});

describe("durability", () => {
  it("keeps the lease across a restart instead of broadcasting twice", async () => {
    const crashing = build();
    crashing.submit(intent({ id: "first", submitter: "agent-a", writes: ["a"] }));
    crashing.submit(intent({ id: "second", submitter: "agent-b", writes: ["b"] }));
    await crashing.drain();
    expect(client.broadcasts).toHaveLength(1);

    // Process dies. A new scheduler reads the same lane file.
    const restarted = build();
    await restarted.drain();

    expect(client.broadcasts).toHaveLength(1);
  });
});

describe("pre-broadcast rejections", () => {
  it("refuses an intent whose simulated gas exceeds its ceiling", async () => {
    client.gasEstimate = "900000";
    const firewall = build();
    firewall.submit(intent({ id: "expensive", gasCeiling: 100_000n }));

    const [action] = await firewall.drain();

    expect(action?.decision).toBe("rejected-gas-ceiling");
    expect(action?.reason).toMatch(/900000 > ceiling 100000/);
    expect(client.broadcasts).toHaveLength(0);
  });

  it("refuses an intent whose simulation reverts", async () => {
    client.revertReason = "ERC20: transfer amount exceeds balance";
    const firewall = build();
    firewall.submit(intent({ id: "doomed" }));

    const [action] = await firewall.drain();

    expect(action?.decision).toBe("rejected-simulation");
    expect(client.broadcasts).toHaveLength(0);
  });

  it("frees the lane for the next intent after a rejection", async () => {
    client.gasEstimate = "900000";
    const firewall = build();
    firewall.submit(intent({ id: "expensive", gasCeiling: 100_000n, submitter: "agent-a", writes: ["a"] }));
    await firewall.drain();

    client.gasEstimate = "50000";
    firewall.submit(intent({ id: "affordable", submitter: "agent-b", writes: ["b"] }));
    await firewall.drain();

    expect(client.broadcasts).toHaveLength(1);
  });
});

describe("supersession", () => {
  it("drops a submitter's stale intent when it queues a fresher one on the same resource", () => {
    const firewall = build();
    firewall.submit(intent({ id: "stale", submitter: "agent-a", writes: ["rebalance:pool-1"], submittedAtMs: 1_000 }));
    const result = firewall.submit(
      intent({ id: "fresh", submitter: "agent-a", writes: ["rebalance:pool-1"], submittedAtMs: 2_000 }),
    );

    expect(result.decision).toBe("superseded");
    expect(result.supersededIds).toEqual(["stale"]);
  });

  it("never lets one agent supersede another's intent", () => {
    const firewall = build();
    firewall.submit(intent({ id: "theirs", submitter: "agent-b", writes: ["rebalance:pool-1"], submittedAtMs: 1_000 }));
    const result = firewall.submit(
      intent({ id: "mine", submitter: "agent-a", writes: ["rebalance:pool-1"], submittedAtMs: 2_000 }),
    );

    expect(result.decision).toBe("queued");
    expect(result.supersededIds).toBeUndefined();
  });

  it("treats a resubmitted intent as a duplicate rather than queueing it twice", () => {
    const firewall = build();
    firewall.submit(intent({ id: "once" }));
    expect(firewall.submit(intent({ id: "once" })).decision).toBe("duplicate");
  });

  it("recognises the same call submitted under a different id", () => {
    const firewall = build();
    firewall.submit(intent({ id: "first-id" }));
    const again = intent({ id: "second-id" });
    again.call = { ...again.call, args: ["first-id", "1"] };
    expect(firewall.submit(again).decision).toBe("duplicate");
  });
});

describe("quarantine", () => {
  it("quarantines a lane whose execution stays pending too long", async () => {
    const firewall = build({ stuckAfterMs: 60_000 });
    firewall.submit(intent({ id: "stuck" }));
    await firewall.drain();

    clock += 61_000;
    const [action] = await firewall.poll();

    expect(action?.decision).toBe("quarantined");
  });

  it("refuses new intents on a quarantined lane", async () => {
    const firewall = build({ stuckAfterMs: 60_000 });
    firewall.submit(intent({ id: "stuck" }));
    await firewall.drain();
    clock += 61_000;
    await firewall.poll();

    const result = firewall.submit(intent({ id: "later", submitter: "agent-b", writes: ["b"] }));
    expect(result.decision).toBe("rejected-quarantined");
  });

  it("does not broadcast behind a stuck transaction", async () => {
    const firewall = build({ stuckAfterMs: 60_000 });
    firewall.submit(intent({ id: "stuck", submitter: "agent-a", writes: ["a"] }));
    firewall.submit(intent({ id: "behind", submitter: "agent-b", writes: ["b"] }));
    await firewall.drain();

    clock += 61_000;
    await firewall.poll();
    await firewall.drain();

    // The stuck transaction may still land on its nonce. Admitting the queued
    // intent now would put a second transaction on that same nonce.
    expect(client.broadcasts).toHaveLength(1);
  });
});

describe("audit trail", () => {
  it("records every decision with its reason", async () => {
    client.gasEstimate = "900000";
    const store = new LaneStore(storePath);
    const firewall = new NonceFirewall(store, client, { now: () => clock });
    firewall.submit(intent({ id: "expensive", gasCeiling: 1_000n }));
    await firewall.drain();

    const decisions = store.audit().map((entry) => entry.decision);
    expect(decisions).toEqual(["queued", "rejected-gas-ceiling"]);
    expect(store.audit().at(-1)?.reason).toMatch(/ceiling/);
  });
});
