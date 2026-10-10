import { describe, expect, it } from "vitest";
import { hydrateFxRateState, getFxSourceStatus, type FxRateSourceMode } from "../fx-rate-state";
import { applyRealtimeOverlaySourceMetadata, canCarryForwardFxRates, inheritFxSourceMetadata } from "../fx-source-metadata";
import type { FxSourceCadence } from "../fx-cadence";

function sourceMaps() {
  return {
    times: {} as Record<string, number | null>,
    modes: {} as Record<string, FxRateSourceMode>,
    cadences: {} as Record<string, FxSourceCadence>,
    dates: {} as Record<string, string | null>,
  };
}

describe("FX carry-forward source metadata", () => {
  it.each([
    ["intraday", "2026-10-08T08:00:00Z", "2026-10-08T22:00:00Z", null, "degraded", false],
    ["calendar-daily", "2026-10-09T08:00:00Z", "2026-10-11T22:00:00Z", "2026-10-09", "stale", false],
    ["business-daily", "2026-10-09T08:00:00Z", "2026-10-11T22:00:00Z", "2026-10-09", "fresh", true],
  ] as const)("preserves explicit %s cadence and original age through carry eligibility and inheritance", (cadence, observed, assessed, sourceDate, status, carried) => {
    const observedAt = Date.parse(observed) / 1000;
    const now = Date.parse(assessed) / 1000;
    const state = hydrateFxRateState(
      { value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: observedAt },
      { value: JSON.stringify({
        usableSyncAt: observedAt, mode: "live", consecutiveFallbackRuns: 0,
        sourceUpdatedAtByPeg: { peggedEUR: observedAt }, sourceModeByPeg: { peggedEUR: "live" },
        sourceCadenceByPeg: { peggedEUR: cadence }, sourceDateByPeg: { peggedEUR: sourceDate },
      }), updatedAt: observedAt },
    );
    expect(state).not.toBeNull();
    expect(canCarryForwardFxRates(["peggedEUR"], state, { peggedEUR: 1.08 }, now)).toBe(carried);
    const maps = sourceMaps();
    inheritFxSourceMetadata(state, "peggedEUR", maps.times, maps.modes, maps.cadences, maps.dates);
    expect(maps.times.peggedEUR).toBe(observedAt);
    expect(maps.cadences.peggedEUR).toBe(cadence);
    expect(maps.dates.peggedEUR).toBe(sourceDate);
    expect(getFxSourceStatus(maps.times.peggedEUR, maps.modes.peggedEUR, now, {
      pegKey: "peggedEUR", cadence: maps.cadences.peggedEUR, sourceDate: maps.dates.peggedEUR,
    })).toBe(status);
  });

  it("does not convert explicit intraday provenance into daily provenance during an overlay", () => {
    const now = Date.parse("2026-10-08T22:00:00Z") / 1000;
    const maps = sourceMaps();
    maps.times.peggedEUR = now - 14 * 3600;
    maps.modes.peggedEUR = "live";
    maps.cadences.peggedEUR = "intraday";
    maps.dates.peggedEUR = "2026-10-08";
    applyRealtimeOverlaySourceMetadata("peggedEUR", now - 60, now, maps.times, maps.modes, maps.cadences, maps.dates);
    expect(maps.cadences.peggedEUR).toBe("intraday");
    expect(maps.dates.peggedEUR).toBeNull();
    expect(maps.times.peggedEUR).toBe(now - 60);
  });

  it("preserves an explicitly calendar-daily incumbent during a fresh realtime overlay", () => {
    const now = Date.parse("2026-10-08T22:00:00Z") / 1000;
    const maps = sourceMaps();
    maps.times.peggedEUR = now - 14 * 3600;
    maps.modes.peggedEUR = "live";
    maps.cadences.peggedEUR = "calendar-daily";
    maps.dates.peggedEUR = "2026-10-08";
    applyRealtimeOverlaySourceMetadata("peggedEUR", now - 60, now, maps.times, maps.modes, maps.cadences, maps.dates);
    expect(maps.cadences.peggedEUR).toBe("calendar-daily");
    expect(maps.dates.peggedEUR).toBe("2026-10-08");
  });

  it("infers natural daily cadence only for legacy metadata with no recorded cadence", () => {
    const observedAt = Date.parse("2026-10-08T08:00:00Z") / 1000;
    const state = hydrateFxRateState(
      { value: JSON.stringify({ peggedEUR: 1.08 }), updatedAt: observedAt },
      { value: JSON.stringify({
        usableSyncAt: observedAt, mode: "live", consecutiveFallbackRuns: 0,
        sourceUpdatedAtByPeg: { peggedEUR: observedAt }, sourceModeByPeg: { peggedEUR: "live" },
      }), updatedAt: observedAt },
    );
    const maps = sourceMaps();
    inheritFxSourceMetadata(state, "peggedEUR", maps.times, maps.modes, maps.cadences, maps.dates);
    expect(maps.cadences.peggedEUR).toBe("business-daily");
    expect(maps.dates.peggedEUR).toBe("2026-10-08");
    expect(maps.times.peggedEUR).toBe(observedAt);
  });
});
