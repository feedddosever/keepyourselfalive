import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Intent } from "./intent.js";

export type Decision =
  | "queued"
  | "admitted"
  | "superseded"
  | "rejected-gas-ceiling"
  | "rejected-simulation"
  | "rejected-quarantined"
  | "settled"
  | "failed"
  | "quarantined";

export interface AuditEntry {
  atMs: number;
  laneKey: string;
  intentId: string;
  decision: Decision;
  reason?: string;
  executionId?: string;
  txHash?: string;
}

export interface InFlight {
  intentId: string;
  intentHash: string;
  executionId: string;
  admittedAtMs: number;
}

export interface LaneState {
  laneKey: string;
  /**
   * At most one. This is the lease: while it is set, no other intent on this
   * lane may be broadcast, so no two transactions can be assigned the same nonce.
   */
  inFlight?: InFlight;
  queued: Intent[];
  quarantine?: { reason: string; sinceMs: number; intentId: string };
}

interface SerializedIntent extends Omit<Intent, "gasCeiling"> {
  gasCeiling?: string;
}

interface SerializedLane extends Omit<LaneState, "queued"> {
  queued: SerializedIntent[];
}

interface Snapshot {
  lanes: SerializedLane[];
  audit: AuditEntry[];
}

const AUDIT_LIMIT = 500;

/**
 * Durable lane state.
 *
 * Durability is the point, not an optimization. An in-memory lock is released by
 * a crash, so a restarted scheduler sees a free lane, admits a second intent, and
 * broadcasts it while the first is still pending — exactly the collision the
 * firewall exists to prevent. The lease has to outlive the process that took it.
 */
export class LaneStore {
  private lanes = new Map<string, LaneState>();
  private auditLog: AuditEntry[] = [];

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
      for (const lane of snapshot.lanes) this.lanes.set(lane.laneKey, deserializeLane(lane));
      this.auditLog = snapshot.audit ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  lane(laneKey: string): LaneState {
    const existing = this.lanes.get(laneKey);
    if (existing) return existing;
    const created: LaneState = { laneKey, queued: [] };
    this.lanes.set(laneKey, created);
    return created;
  }

  laneKeys(): string[] {
    return [...this.lanes.keys()].sort();
  }

  audit(): readonly AuditEntry[] {
    return this.auditLog;
  }

  record(entry: AuditEntry): void {
    this.auditLog.push(entry);
    if (this.auditLog.length > AUDIT_LIMIT) {
      this.auditLog = this.auditLog.slice(-AUDIT_LIMIT);
    }
  }

  flush(): void {
    const snapshot: Snapshot = {
      lanes: [...this.lanes.values()].map(serializeLane),
      audit: this.auditLog,
    };
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot, null, 2));
    renameSync(temp, this.path);
  }
}

function serializeLane(lane: LaneState): SerializedLane {
  return {
    ...lane,
    queued: lane.queued.map(({ gasCeiling, ...intent }) => ({
      ...intent,
      ...(gasCeiling === undefined ? {} : { gasCeiling: gasCeiling.toString(10) }),
    })),
  };
}

function deserializeLane(lane: SerializedLane): LaneState {
  return {
    ...lane,
    queued: lane.queued.map(({ gasCeiling, ...intent }) => ({
      ...intent,
      ...(gasCeiling === undefined ? {} : { gasCeiling: BigInt(gasCeiling) }),
    })),
  };
}
