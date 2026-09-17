import type { TipEvent } from "./types.js";

/**
 * Epoch ids are derived from the clock, not from a counter.
 *
 * A counter would drift if a run were skipped, and two agents racing on the same
 * interval would mint different ids for the same window — each producing a plan
 * with a different idempotency key, and both getting broadcast. A floored
 * timestamp makes the id a pure function of the window, so a retry, a restart or
 * a second agent all derive the same one.
 */
export function epochIdFor(timestampMs: number, intervalMs: number): string {
  if (intervalMs <= 0) throw new Error(`interval must be positive, got ${intervalMs}`);
  const start = Math.floor(timestampMs / intervalMs) * intervalMs;
  return `epoch-${new Date(start).toISOString()}`;
}

/** Tips belonging to the window `[start, start + intervalMs)`. */
export function tipsInEpoch(
  tips: readonly TipEvent[],
  epochId: string,
  intervalMs: number,
): TipEvent[] {
  const start = Date.parse(epochId.replace(/^epoch-/, ""));
  if (Number.isNaN(start)) throw new Error(`unparseable epoch id: ${epochId}`);
  return tips
    .filter((tip) => tip.timestampMs >= start && tip.timestampMs < start + intervalMs)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The most recent window that has fully elapsed, and is therefore safe to settle. */
export function lastClosedEpoch(nowMs: number, intervalMs: number): string {
  return epochIdFor(nowMs - intervalMs, intervalMs);
}
