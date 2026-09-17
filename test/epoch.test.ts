import { describe, expect, it } from "vitest";
import { epochIdFor, lastClosedEpoch, tipsInEpoch } from "../src/epoch.js";
import type { TipEvent } from "../src/types.js";

const HOUR = 3_600_000;
const AT = (iso: string) => Date.parse(iso);

function tip(id: string, iso: string): TipEvent {
  return {
    id,
    from: "0x00000000000000000000000000000000000000f1",
    to: "0x000000000000000000000000000000000000000a",
    amount: 1n,
    castHash: `0x${id}`,
    timestampMs: AT(iso),
  };
}

describe("epoch ids", () => {
  it("floors to the window, so any instant inside it yields one id", () => {
    const early = epochIdFor(AT("2026-09-17T13:00:00.000Z"), HOUR);
    const late = epochIdFor(AT("2026-09-17T13:59:59.999Z"), HOUR);
    expect(early).toBe("epoch-2026-09-17T13:00:00.000Z");
    expect(late).toBe(early);
  });

  it("gives the next window a different id", () => {
    expect(epochIdFor(AT("2026-09-17T14:00:00.000Z"), HOUR)).not.toBe(
      epochIdFor(AT("2026-09-17T13:00:00.000Z"), HOUR),
    );
  });

  it("settles only windows that have fully elapsed", () => {
    expect(lastClosedEpoch(AT("2026-09-17T14:30:00.000Z"), HOUR)).toBe("epoch-2026-09-17T13:00:00.000Z");
  });

  it("rejects a non-positive interval instead of dividing by zero", () => {
    expect(() => epochIdFor(AT("2026-09-17T13:00:00.000Z"), 0)).toThrow(/positive/);
  });
});

describe("tipsInEpoch", () => {
  const tips = [
    tip("a", "2026-09-17T12:59:59.999Z"),
    tip("b", "2026-09-17T13:00:00.000Z"),
    tip("c", "2026-09-17T13:30:00.000Z"),
    tip("d", "2026-09-17T14:00:00.000Z"),
  ];

  it("includes the window's start and excludes its end", () => {
    const selected = tipsInEpoch(tips, "epoch-2026-09-17T13:00:00.000Z", HOUR);
    expect(selected.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("assigns every tip to exactly one window", () => {
    const windows = ["12", "13", "14"].map((hour) =>
      tipsInEpoch(tips, `epoch-2026-09-17T${hour}:00:00.000Z`, HOUR).map((t) => t.id),
    );
    expect(windows.flat().sort()).toEqual(["a", "b", "c", "d"]);
  });
});
