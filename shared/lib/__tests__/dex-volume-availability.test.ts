import { describe, expect, it } from "vitest";
import {
  classifyDexPoolVolumeObservation,
  composeLiquidityScore,
  parseDexVolumeAvailabilityRecord,
  readStoredDexVolumeWindow,
  resolveDexVolumeView,
  resolveVolumeActivityComponent,
  summarizeDexVolumeWindow,
  type DexPoolVolumeObservationInput,
} from "../dex-volume-availability";
import { DexVolumeAvailabilityRecordSchema, type DexVolumeCompleteness } from "../../types/market";

const AS_OF = 1_790_000_000;
const HOUR = 3_600;
const CLOCK = { asOfSec: AS_OF, maxObservationAgeSec: 24 * HOUR };
const at = (ageHours: number, volumeUsd: number | null = 1_000): DexPoolVolumeObservationInput => ({
  volumeUsd,
  observedAtSec: AS_OF - ageHours * HOUR,
});

describe("classifyDexPoolVolumeObservation", () => {
  it.each([
    ["fresh", at(1), "measured"],
    ["exact budget boundary", at(24), "measured"],
    ["25h", at(25), "stale"],
    ["180h", at(180), "stale"],
    ["expired (336h)", at(336), "stale"],
    ["measured zero", at(1, 0), "measured"],
    ["null volume", at(1, null), "missing"],
    ["negative volume", at(1, -5), "missing"],
    ["non-finite volume", at(1, Number.NaN), "missing"],
    ["no observation clock", { volumeUsd: 1_000, observedAtSec: null }, "missing"],
    ["clock after evaluation", { volumeUsd: 1_000, observedAtSec: AS_OF + 60 }, "missing"],
  ] as const)("%s → %s", (_name, observation, expected) => {
    expect(classifyDexPoolVolumeObservation(observation, CLOCK)).toBe(expected);
  });
});

describe("summarizeDexVolumeWindow", () => {
  it("keeps an all-measured zero window complete at 0", () => {
    const summary = summarizeDexVolumeWindow([at(1, 0), at(2, 0)], "24h", CLOCK);
    expect(summary.measuredUsd).toBe(0);
    expect(summary.availability).toMatchObject({
      completeness: "complete",
      reason: null,
      partialGrossUsd: 0,
      measuredPoolCount: 2,
      windowSec: 86_400,
      asOfSec: AS_OF,
      maxObservationAgeSec: 24 * HOUR,
    });
  });

  it("never turns all-missing observations into a measured zero", () => {
    const summary = summarizeDexVolumeWindow([at(1, null), { volumeUsd: 5, observedAtSec: null }], "24h", CLOCK);
    expect(summary.measuredUsd).toBeNull();
    expect(summary.availability).toMatchObject({
      completeness: "missing",
      reason: "pool-observations-missing",
      partialGrossUsd: null,
      missingPoolCount: 2,
    });
  });

  it("labels a mixed window partial with only in-budget flow in the gross sum", () => {
    const summary = summarizeDexVolumeWindow([at(1, 40_000), at(180, 50_000), at(1, null)], "7d", CLOCK);
    expect(summary.measuredUsd).toBeNull();
    expect(summary.availability).toMatchObject({
      completeness: "partial",
      reason: "pool-observations-missing-and-stale",
      partialGrossUsd: 40_000,
      measuredPoolCount: 1,
      stalePoolCount: 1,
      missingPoolCount: 1,
      windowSec: 604_800,
      oldestObservedAtSec: AS_OF - 180 * HOUR,
      newestObservedAtSec: AS_OF - HOUR,
    });
  });

  it("reports an all-aged window as stale, not as decayed current flow", () => {
    const summary = summarizeDexVolumeWindow([at(180, 50_000)], "24h", CLOCK);
    expect(summary.measuredUsd).toBeNull();
    expect(summary.availability).toMatchObject({ completeness: "stale", reason: "pool-observations-stale", partialGrossUsd: null });
  });

  it("classifies none-measured stale+missing windows as missing with the combined reason", () => {
    const summary = summarizeDexVolumeWindow([at(180), at(1, null)], "24h", CLOCK);
    expect(summary.availability).toMatchObject({ completeness: "missing", reason: "pool-observations-missing-and-stale" });
  });

  it("produces records the stored-record schema accepts", () => {
    const record = {
      "24h": summarizeDexVolumeWindow([at(1)], "24h", CLOCK).availability,
      "7d": summarizeDexVolumeWindow([at(30)], "7d", CLOCK).availability,
    };
    expect(DexVolumeAvailabilityRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe("readStoredDexVolumeWindow", () => {
  const recorded = (pools: DexPoolVolumeObservationInput[]) =>
    parseDexVolumeAvailabilityRecord(JSON.stringify({
      "24h": summarizeDexVolumeWindow(pools, "24h", CLOCK).availability,
      "7d": summarizeDexVolumeWindow(pools, "7d", CLOCK).availability,
    }));

  it("keeps legacy rows numeric without claiming completeness", () => {
    expect(readStoredDexVolumeWindow(1_234, parseDexVolumeAvailabilityRecord(null), "24h")).toEqual({ measuredUsd: 1_234 });
  });

  it("honors the legacy 7d measurement marker", () => {
    expect(readStoredDexVolumeWindow(700, parseDexVolumeAvailabilityRecord(null), "7d", false)).toEqual({ measuredUsd: null });
  });

  it("publishes the stored column only for a complete recorded window", () => {
    expect(readStoredDexVolumeWindow(0, recorded([at(1, 0)]), "24h").measuredUsd).toBe(0);
    expect(readStoredDexVolumeWindow(40_000, recorded([at(1, 40_000), at(1, null)]), "24h").measuredUsd).toBeNull();
    expect(readStoredDexVolumeWindow(50_000, recorded([at(180, 50_000)]), "7d").measuredUsd).toBeNull();
  });

  it.each(["{", JSON.stringify({ "24h": { completeness: "complete" } }), JSON.stringify({ "7d": null })])(
    "treats unreadable record %s as unknown with no measured value",
    (json) => {
      expect(readStoredDexVolumeWindow(9_999, parseDexVolumeAvailabilityRecord(json), "24h")).toMatchObject({
        measuredUsd: null,
        availability: { completeness: "unknown", reason: "availability-record-unreadable" },
      });
    },
  );

  it("marks a history-style record without a 7d window unreadable for 7d", () => {
    const historyRecord = parseDexVolumeAvailabilityRecord(JSON.stringify({
      "24h": summarizeDexVolumeWindow([at(1)], "24h", CLOCK).availability,
    }));
    expect(readStoredDexVolumeWindow(7_000, historyRecord, "7d").availability?.reason).toBe("availability-record-unreadable");
  });
});

describe("resolveDexVolumeView", () => {
  it("interprets a legacy number as unknown completeness, never as measured", () => {
    expect(resolveDexVolumeView(5_000, undefined)).toMatchObject({
      status: "legacy-unknown",
      valueUsd: 5_000,
      completeness: "unknown",
      reason: "legacy-completeness-unrecorded",
    });
  });

  it("keeps a partial gross sum out of the headline value", () => {
    const { availability } = summarizeDexVolumeWindow([at(1, 40_000), at(1, null)], "24h", CLOCK);
    expect(resolveDexVolumeView(null, availability)).toMatchObject({
      status: "unavailable",
      valueUsd: null,
      partialGrossUsd: 40_000,
      completeness: "partial",
    });
  });

  it("shows a complete measured zero as measured", () => {
    const { availability } = summarizeDexVolumeWindow([at(1, 0)], "24h", CLOCK);
    expect(resolveDexVolumeView(0, availability)).toMatchObject({ status: "measured", valueUsd: 0 });
  });
});

describe("DEC-19 LiquidityScore contract", () => {
  const OTHER_COMPONENTS = { tvlDepth: 100, poolQuality: 100, durability: 100, pairDiversity: 100 };

  it("scores a complete measured zero as 0 activity under the full weight denominator", () => {
    const activity = resolveVolumeActivityComponent({ measuredVolume24hUsd: 0, completeness: "complete", totalTvlUsd: 1_000_000 });
    expect(activity).toEqual({ status: "measured", score: 0 });
    // 0.30 + 0.20 + 0.20 + 0.10 = 0.80 of 100 — the 20% activity share is not redistributed.
    expect(composeLiquidityScore({ ...OTHER_COMPONENTS, volumeActivity: activity })).toMatchObject({
      status: "rated",
      score: 80,
      components: { volumeActivity: 0 },
    });
  });

  it("keeps the existing log-scale activity formula for complete windows", () => {
    // V/T = 5% → 38 × (log10(0.05) + 3) ≈ 64.56
    const activity = resolveVolumeActivityComponent({ measuredVolume24hUsd: 1_000_000, completeness: "complete", totalTvlUsd: 20_000_000 });
    expect(activity.status).toBe("measured");
    expect(activity.score).toBeCloseTo(64.56, 2);
  });

  it.each([
    ["partial", "activity-partial"],
    ["missing", "activity-missing"],
    ["stale", "activity-stale"],
    ["unknown", "activity-completeness-unknown"],
  ] as const satisfies ReadonlyArray<readonly [Exclude<DexVolumeCompleteness, "complete">, string]>)(
    "%s required activity makes the component unavailable and the composite NR",
    (completeness, reason) => {
      // Even a present partial gross sum is never used as estimated activity.
      const activity = resolveVolumeActivityComponent({ measuredVolume24hUsd: 500_000, completeness, totalTvlUsd: 1_000_000 });
      expect(activity).toEqual({ status: "unavailable", score: null, reason });
      expect(composeLiquidityScore({ ...OTHER_COMPONENTS, volumeActivity: activity })).toEqual({
        status: "not-rated",
        score: null,
        reason: "volume-activity-unavailable",
        activityReason: reason,
        components: { ...OTHER_COMPONENTS, volumeActivity: null },
      });
    },
  );

  it("treats a complete window without a valid measured value as missing activity", () => {
    expect(resolveVolumeActivityComponent({ measuredVolume24hUsd: null, completeness: "complete", totalTvlUsd: 1 })).toEqual({
      status: "unavailable",
      score: null,
      reason: "activity-missing",
    });
  });
});
