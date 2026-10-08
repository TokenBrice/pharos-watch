import { describe, expect, it } from "vitest";
import {
  classifyDexPoolVolumeObservation,
  composeLiquidityScore,
  parseDexVolumeAvailabilityRecord,
  readStoredDexTurnover24h,
  readStoredDexVolumeWindow,
  resolveDexVolumeView,
  resolveVolumeActivityComponent,
  summarizeDexVolumeWindow,
  type DexPoolVolumeObservationInput,
} from "../dex-volume-availability";
import { DexVolumeAvailabilityRecordSchema } from "../../types/market";
import { LIQUIDITY_SCORE_WEIGHTS } from "../liquidity-score-weights";

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
      "24h": summarizeDexVolumeWindow([{ ...at(1), tvlUsd: 10 }, { ...at(30), tvlUsd: 30 }], "24h", CLOCK).availability,
      "7d": summarizeDexVolumeWindow([at(30)], "7d", CLOCK).availability,
    };
    expect(record["24h"]).toMatchObject({ admittedTvlUsd: 10, retainedTvlUsd: 40, volumeCoverage: 0.25 });
    expect(DexVolumeAvailabilityRecordSchema.safeParse(record).success).toBe(true);
  });

  it("still reads records written before the coverage fields existed", () => {
    const { admittedTvlUsd: _admitted, retainedTvlUsd: _retained, volumeCoverage: _coverage, ...legacy24h } =
      summarizeDexVolumeWindow([at(1, 40_000), at(1, null)], "24h", CLOCK).availability;
    const parsed = parseDexVolumeAvailabilityRecord(JSON.stringify({ "24h": legacy24h }));
    expect(parsed).toMatchObject({ status: "recorded", record: { "24h": { completeness: "partial", partialGrossUsd: 40_000 } } });
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

describe("readStoredDexTurnover24h", () => {
  const recorded = (pools: DexPoolVolumeObservationInput[]) =>
    parseDexVolumeAvailabilityRecord(JSON.stringify({ "24h": summarizeDexVolumeWindow(pools, "24h", CLOCK).availability }));

  it("uses admitted volume over admitted TVL for a day at the coverage floor and skips one just below", () => {
    const atFloor = recorded([{ ...at(1, 5_000), tvlUsd: 500_000 }, { ...at(1, null), tvlUsd: 500_000 }]);
    expect(readStoredDexTurnover24h(5_000, 1_000_000, atFloor)).toBeCloseTo(0.01, 10);
    const belowFloor = recorded([{ ...at(1, 5_000), tvlUsd: 499_999 }, { ...at(1, null), tvlUsd: 500_001 }]);
    expect(readStoredDexTurnover24h(5_000, 1_000_000, belowFloor)).toBeNull();
  });

  it("keeps complete and legacy days as volume over TVL and unknown days out", () => {
    expect(readStoredDexTurnover24h(0, 1_000_000, recorded([{ ...at(1, 0), tvlUsd: 1_000_000 }]))).toBe(0);
    expect(readStoredDexTurnover24h(20_000, 1_000_000, parseDexVolumeAvailabilityRecord(null))).toBe(0.02);
    expect(readStoredDexTurnover24h(20_000, 1_000_000, parseDexVolumeAvailabilityRecord("{"))).toBeNull();
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

describe("DEC-19 LiquidityScore contract (coverage-gated)", () => {
  const OTHER_COMPONENTS = { tvlDepth: 100, poolQuality: 100, durability: 100, pairDiversity: 100 };
  const pool = (ageHours: number, volumeUsd: number | null, tvlUsd: number): DexPoolVolumeObservationInput => ({
    ...at(ageHours, volumeUsd),
    tvlUsd,
  });
  const activityOf = (pools: DexPoolVolumeObservationInput[]) =>
    resolveVolumeActivityComponent(summarizeDexVolumeWindow(pools, "24h", CLOCK).availability);

  it.each(LIQUIDITY_SCORE_WEIGHTS)("applies the authored $key share without redistribution", ({ key, weight }) => {
    const result = composeLiquidityScore({
      tvlDepth: key === "tvlDepth" ? 100 : 0,
      poolQuality: key === "poolQuality" ? 100 : 0,
      durability: key === "durability" ? 100 : 0,
      pairDiversity: key === "pairDiversity" ? 100 : 0,
      volumeActivity: { status: "measured", score: key === "volumeActivity" ? 100 : 0 },
    });
    expect(result.status).toBe("rated");
    expect(result.score).toBe(Math.round(100 * weight));
  });

  it("scores a complete measured zero as 0 activity under the full weight denominator", () => {
    const activity = activityOf([pool(1, 0, 600_000), pool(2, 0, 400_000)]);
    expect(activity).toEqual({ status: "measured", score: 0 });
    // 0.30 + 0.20 + 0.20 + 0.10 = 0.80 of 100 — the 20% activity share is not redistributed.
    expect(composeLiquidityScore({ ...OTHER_COMPONENTS, volumeActivity: activity })).toMatchObject({
      status: "rated",
      score: 80,
      components: { volumeActivity: 0 },
    });
  });

  it("keeps stale and missing pools out of both the activity numerator and denominator", () => {
    // Admitted: $1M over $20M (V/T 5% → 38 × (log10(0.05) + 3) ≈ 64.56). The stale pool's
    // $50M flow and the missing pool's TVL change nothing; coverage 20/35 clears the floor.
    const activity = activityOf([pool(1, 1_000_000, 20_000_000), pool(180, 50_000_000, 10_000_000), pool(1, null, 5_000_000)]);
    expect(activity.status).toBe("measured");
    expect(activity.score).toBeCloseTo(64.56, 2);
  });

  it("rates coverage exactly at the 0.50 floor and not rated just below it", () => {
    const atFloor = activityOf([pool(1, 10_000, 500_000), pool(100, 10_000, 500_000)]);
    expect(atFloor).toEqual({ status: "measured", score: expect.any(Number) });
    const belowFloor = activityOf([pool(1, 10_000, 499_999), pool(100, 10_000, 500_001)]);
    expect(belowFloor).toEqual({ status: "unavailable", score: null, reason: "activity-coverage-below-floor" });
    expect(composeLiquidityScore({ ...OTHER_COMPONENTS, volumeActivity: belowFloor })).toEqual({
      status: "not-rated",
      score: null,
      reason: "volume-activity-unavailable",
      activityReason: "activity-coverage-below-floor",
      components: { ...OTHER_COMPONENTS, volumeActivity: null },
    });
  });

  it.each([
    ["all-missing", [pool(1, null, 1_000), pool(1, null, 2_000)], "activity-missing"],
    ["all-stale", [pool(100, 5_000, 1_000)], "activity-stale"],
  ] as const)("makes an %s window NR", (_name, pools, reason) => {
    expect(activityOf([...pools])).toEqual({ status: "unavailable", score: null, reason });
  });

  it("treats an absent or unknown-completeness record as unavailable", () => {
    const unknown = { status: "unavailable", score: null, reason: "activity-completeness-unknown" };
    expect(resolveVolumeActivityComponent(undefined)).toEqual(unknown);
    const unreadable = readStoredDexVolumeWindow(1, parseDexVolumeAvailabilityRecord("{"), "24h").availability;
    expect(resolveVolumeActivityComponent(unreadable)).toEqual(unknown);
  });
});
