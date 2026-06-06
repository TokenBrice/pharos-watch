import { describe, expect, it } from "vitest";
import { isValidFxRate } from "../../lib/fx-config";
import type { FxRateState, FxSourceCadence } from "../../lib/fx-rate-state";
import { FxSyncRunState } from "../sync-fx-rates-helpers";

const syncStartSec = Math.floor(Date.parse("2025-06-15T12:00:00Z") / 1000);

function buildPrevState(rates: Record<string, number>): FxRateState {
  const updatedAt = syncStartSec - 3600;
  const keys = Object.keys(rates);
  return {
    rates,
    usableSyncAt: updatedAt,
    usableAgeSec: syncStartSec - updatedAt,
    mode: "live",
    sourceUpdatedAtByPeg: Object.fromEntries(keys.map((key) => [key, updatedAt])),
    sourceModeByPeg: Object.fromEntries(keys.map((key) => [key, "live"])),
    sourceCadenceByPeg: Object.fromEntries(keys.map((key) => [key, "intraday" as FxSourceCadence])),
    sourceDateByPeg: Object.fromEntries(keys.map((key) => [key, null])),
    consecutiveFallbackRuns: 0,
    bootstrapMetadata: false,
  };
}

function createState(prevRates: Record<string, number> = {}): FxSyncRunState {
  const prevState = Object.keys(prevRates).length > 0 ? buildPrevState(prevRates) : null;
  return new FxSyncRunState({
    prevState,
    syncStartSec,
    expectedPegKeys: ["peggedMYR"],
    initialSources: {},
    validateRate: (pegKey, rate, prevRate) => isValidFxRate(pegKey, rate, prevRate, "[sync-fx-rates:test]"),
  });
}

describe("FxSyncRunState realtime overlays", () => {
  it("leaves an unanchored realtime rate provisional when there is no current or previous reference", () => {
    const state = createState();

    const applied = state.applyRealtimeOverlayRates(new Map([["peggedMYR", 0.222222]]));

    expect(applied).toBe(0);
    expect(state.usableRates.peggedMYR).toBeUndefined();
    expect(state.buildResultMetadata([])).toMatchObject({
      missing: ["peggedMYR"],
      provisionalRealtimeOverlayPegs: ["peggedMYR"],
    });
  });

  it("applies a realtime overlay when the current run already has a reference", () => {
    const state = createState();
    state.usableRates.peggedMYR = 0.222222;
    state.markLive("peggedMYR", syncStartSec - 120, "calendar-daily", "2025-06-15");

    const applied = state.applyRealtimeOverlayRates(new Map([["peggedMYR", 0.223333]]));

    expect(applied).toBe(1);
    expect(state.usableRates.peggedMYR).toBe(0.223333);
    expect(state.buildResultMetadata([]).provisionalRealtimeOverlayPegs).toBeUndefined();
  });

  it("applies a realtime overlay when previous history can corroborate the peg", () => {
    const state = createState({ peggedMYR: 0.222222 });

    const applied = state.applyRealtimeOverlayRates(new Map([["peggedMYR", 0.223333]]));

    expect(applied).toBe(1);
    expect(state.usableRates.peggedMYR).toBe(0.223333);
    expect(state.buildResultMetadata([]).provisionalRealtimeOverlayPegs).toBeUndefined();
  });
});
