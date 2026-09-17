import { readFileSync } from "node:fs";
import { normalizeAddress } from "../address.js";
import type { TipEvent } from "../types.js";

/**
 * Where tips come from. Implement this once per app; nothing downstream changes.
 *
 * The contract a source must honour:
 *
 *   `id` is stable  — the same tip observed twice yields the same id. Ids are the
 *                     dedupe key inside an epoch, so a source that mints a fresh
 *                     uuid per poll will let one tip be counted twice.
 *   `timestampMs`   — when the tip happened, not when it was observed. Epoch
 *                     membership is decided by this field.
 *   `amount`        — token base units, never a decimal string.
 */
export interface TipSource {
  tips(): Promise<TipEvent[]>;
}

interface RawTip {
  id: string;
  from: string;
  to: string;
  amount: string;
  castHash: string;
  timestampMs: number;
}

/**
 * Reads tips from a JSONL file: one JSON object per line, in the shape above.
 *
 * This is the intake contract the mini-app writes to. It is deliberately the
 * dumbest possible source — a file the app appends to — so that the settlement
 * agent can be run, tested and replayed without the app being up.
 */
export class JsonlTipSource implements TipSource {
  constructor(private readonly path: string) {}

  async tips(): Promise<TipEvent[]> {
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"));

    return lines.map((line, index) => {
      let raw: RawTip;
      try {
        raw = JSON.parse(line) as RawTip;
      } catch {
        throw new Error(`${this.path}:${index + 1} is not valid JSON`);
      }
      return parseTip(raw, `${this.path}:${index + 1}`);
    });
  }
}

export function parseTip(raw: RawTip, where: string): TipEvent {
  for (const field of ["id", "from", "to", "amount", "castHash"] as const) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      throw new Error(`${where}: missing or non-string "${field}"`);
    }
  }
  if (!Number.isFinite(raw.timestampMs)) {
    throw new Error(`${where}: timestampMs must be a number`);
  }
  if (!/^\d+$/.test(raw.amount)) {
    throw new Error(`${where}: amount must be base units as a decimal string, got ${raw.amount}`);
  }
  return {
    id: raw.id,
    from: normalizeAddress(raw.from),
    to: normalizeAddress(raw.to),
    amount: BigInt(raw.amount),
    castHash: raw.castHash,
    timestampMs: raw.timestampMs,
  };
}
