import { describe, expect, it } from "vitest";
import type { DepegRow } from "../../../lib/depeg-helpers";
import { buildDuplicateOpenEventRepair, buildOrphanCloseRepair } from "../repair";

function makeOpenRow(overrides: Partial<DepegRow> = {}): DepegRow {
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: -150,
    started_at: 100,
    ended_at: null,
    start_price: 0.985,
    peak_price: 0.985,
    recovery_price: null,
    peg_reference: 1,
    source: "live",
    confirmation_sources: null,
    pending_reason: null,
    ...overrides,
  };
}

describe("buildDuplicateOpenEventRepair", () => {
  it("absorbs only same-direction duplicate peaks", () => {
    const result = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, direction: "below", peak_deviation_bps: -150, peak_price: 0.985, started_at: 100 }),
      makeOpenRow({ id: 2, direction: "below", peak_deviation_bps: -300, peak_price: 0.97, started_at: 200 }),
    ]);

    expect(result.openEvents.get("usdt-tether")).toMatchObject({
      id: 1,
      direction: "below",
      peak_deviation_bps: -300,
      peak_price: 0.97,
    });
    expect(result.commands).toEqual([
      { type: "delete-event", id: 2 },
      { type: "update-peak", id: 1, peakDeviationBps: -300, peakPrice: 0.97 },
    ]);
  });

  it("closes stale opposite-direction rows instead of absorbing their peak", () => {
    const result = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, direction: "below", peak_deviation_bps: -150, peak_price: 0.985, started_at: 100 }),
      makeOpenRow({ id: 2, direction: "below", peak_deviation_bps: -300, peak_price: 0.97, started_at: 200 }),
      makeOpenRow({ id: 3, direction: "above", peak_deviation_bps: 400, peak_price: 1.04, started_at: 300 }),
    ]);

    expect(result.openEvents.get("usdt-tether")).toMatchObject({
      id: 3,
      direction: "above",
      peak_deviation_bps: 400,
      peak_price: 1.04,
    });
    expect(result.commands).toEqual([
      { type: "delete-event", id: 2 },
      { type: "update-peak", id: 1, peakDeviationBps: -300, peakPrice: 0.97 },
      {
        type: "close-event",
        id: 1,
        endedAt: 300,
        recoveryPrice: null,
        closeReason: "superseded-direction",
      },
    ]);
  });
});

describe("buildOrphanCloseRepair", () => {
  it("closes untracked orphan events and reports the repair", () => {
    const result = buildOrphanCloseRepair({
      rows: [
        { id: 10, stablecoin_id: "retired-coin", started_at: 100 },
        { id: 11, stablecoin_id: "usdt-tether", started_at: 100 },
        { id: 12, stablecoin_id: "new-coin", started_at: 500 },
      ],
      seenEventIds: new Set(),
      syncStart: 500,
      trackedCoinIds: new Set(["usdt-tether"]),
      now: 1_000,
    });

    expect(result.commands).toEqual([
      {
        type: "close-event",
        id: 10,
        endedAt: 1_000,
        recoveryPrice: null,
        closeReason: "orphan-tracking-removed",
      },
    ]);
    expect(result.diagnostics).toEqual([
      { level: "log", message: "[depeg] Closing orphan event for retired-coin (id=10)" },
    ]);
  });
});
