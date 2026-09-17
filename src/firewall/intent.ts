import { canonicalHash } from "../hash.js";

/** A contract write an agent wants executed, in KeeperHub Direct Execution shape. */
export interface IntentCall {
  contractAddress: string;
  functionName: string;
  args: readonly unknown[];
  abi: readonly unknown[];
}

export interface Intent {
  /** Caller-supplied and stable: resubmitting the same intent must reuse it. */
  id: string;
  /** Which agent asked. Recorded for the audit trail; never affects ordering. */
  submitter: string;
  chainId: number;
  /** The key KeeperHub broadcasts from. Intents sharing one contend for nonces. */
  sender: string;
  call: IntentCall;
  /**
   * Resources this intent mutates, named by the submitter — e.g.
   * `approve:0xtoken:0xspender` or `treasury:usdc`. Two intents naming the same
   * resource may not be in flight together, and a newer one supersedes an older
   * queued one, because executing a stale write after a fresh one produces an
   * order-dependent result nobody reasoned about.
   */
  writes: readonly string[];
  /** Simulated gas above this is refused before broadcast, not after. */
  gasCeiling?: bigint;
  /** Lower admits earlier. Ties break on intent hash, never on arrival time. */
  priority?: number;
  submittedAtMs: number;
}

/** Lane = one sender key on one chain. All nonce contention happens inside a lane. */
export function laneKey(intent: Pick<Intent, "chainId" | "sender">): string {
  return `${intent.chainId}:${intent.sender.toLowerCase()}`;
}

/**
 * Identity of an intent's onchain effect.
 *
 * Excludes submitter, priority and submission time: the same call from the same
 * key is the same intent whoever queued it and whenever they did. Including them
 * would let one agent's duplicate slip past the supersession check.
 */
export function intentHash(intent: Intent): string {
  return canonicalHash([
    "nonce-firewall/intent/v1",
    `chain:${intent.chainId.toString(10)}`,
    `sender:${intent.sender.toLowerCase()}`,
    `contract:${intent.call.contractAddress.toLowerCase()}`,
    `function:${intent.call.functionName}`,
    `args:${JSON.stringify(intent.call.args)}`,
  ]);
}

/**
 * Deterministic admission order.
 *
 * Priority first, then the intent hash — never arrival time. Two schedulers
 * racing the same queue see arrivals in different orders; if arrival broke ties
 * they would admit different intents and both broadcast. Hash ties make the
 * order a pure function of the queue's contents, so the log replays exactly.
 */
export function compareIntents(a: Intent, b: Intent): number {
  const byPriority = (a.priority ?? 0) - (b.priority ?? 0);
  if (byPriority !== 0) return byPriority;
  const [ha, hb] = [intentHash(a), intentHash(b)];
  if (ha === hb) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return ha < hb ? -1 : 1;
}

export function writesOverlap(a: Intent, b: Intent): string[] {
  const other = new Set(b.writes);
  return a.writes.filter((resource) => other.has(resource));
}
