import { afterEach, describe, expect, it, vi } from "vitest";
import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "@shared/lib/status-thresholds";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
  assessYieldBenchmarkRate,
  benchmarkRecordAgeSeconds,
  classifyYieldBenchmarkFreshness,
  isYieldBenchmarkRatePlausible,
} from "@shared/lib/yield-benchmark-freshness";

const NOW_SEC = Date.UTC(2026, 8, 12, 12, 0, 0) / 1000;
const healthyMeta = { ageSeconds: 3_600, isFallback: false, fallbackMode: null };

describe("classifyYieldBenchmarkFreshness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes stale past the fetch-age TTL regardless of the observation date", () => {
    expect(classifyYieldBenchmarkFreshness({ ...healthyMeta, ageSeconds: YIELD_BENCHMARK_SCORE_TTL_SEC + 1 })).toBe("stale");
    expect(classifyYieldBenchmarkFreshness({ ...healthyMeta, ageSeconds: null })).toBe("stale");
    expect(classifyYieldBenchmarkFreshness({ ...healthyMeta, ageSeconds: -DAY_SECONDS })).toBe("stale");
  });

  it("goes stale when the observation itself is older than the key's bound, even on a fresh fetch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const nineDaysAgo = new Date((NOW_SEC - 9 * DAY_SECONDS) * 1000).toISOString().slice(0, 10);
    expect(
      classifyYieldBenchmarkFreshness(healthyMeta, { recordDate: nineDaysAgo, maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD }),
    ).toBe("stale");
    expect(
      classifyYieldBenchmarkFreshness(healthyMeta, { recordDate: nineDaysAgo, maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.RUB }),
    ).toBe("healthy");
  });

  it("fails closed when bounded observation evidence is missing, unparseable, or future-dated", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const bounded = { maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD };
    expect(classifyYieldBenchmarkFreshness(healthyMeta, { ...bounded, recordDate: null })).toBe("stale");
    expect(classifyYieldBenchmarkFreshness(healthyMeta, { ...bounded, recordDate: "not-a-date" })).toBe("stale");
    expect(classifyYieldBenchmarkFreshness(healthyMeta, { ...bounded, recordDate: "2099-01-01" })).toBe("stale");
  });

  it("degrades on feed fallback but not on documented proxy selection alone", () => {
    expect(classifyYieldBenchmarkFreshness({ ...healthyMeta, isFallback: true })).toBe("degraded");
    expect(classifyYieldBenchmarkFreshness({ ...healthyMeta, fallbackMode: "retained" })).toBe("degraded");
    expect(classifyYieldBenchmarkFreshness(healthyMeta)).toBe("healthy");
    expect(classifyYieldBenchmarkFreshness(healthyMeta, { selectionMode: "fallback-usd" })).toBe("degraded");
  });
});

describe("benchmarkRecordAgeSeconds", () => {
  it("returns negative age for far-future observations and rejects unparseable dates", () => {
    expect(benchmarkRecordAgeSeconds("2099-01-01", NOW_SEC)).toBeLessThan(0);
    expect(benchmarkRecordAgeSeconds("not-a-date", NOW_SEC)).toBeNull();
    expect(benchmarkRecordAgeSeconds(null, NOW_SEC)).toBeNull();
    expect(benchmarkRecordAgeSeconds("2026-09-10", NOW_SEC)).toBe(2 * DAY_SECONDS + 12 * 3600);
  });
});

describe("isYieldBenchmarkRatePlausible", () => {
  it("rejects a unit-scale drift even inside the provider's broad range", () => {
    expect(isYieldBenchmarkRatePlausible("USD", 0.43, 4.3)).toBe(false);
    expect(isYieldBenchmarkRatePlausible("TRY", 4, 40)).toBe(false);
    expect(isYieldBenchmarkRatePlausible("EUR", 0.9, 1.9)).toBe(false);
  });

  it("rejects a 100x unit drift for the wide-band policy keys", () => {
    expect(isYieldBenchmarkRatePlausible("TRY", 0.4, 40)).toBe(false);
    expect(isYieldBenchmarkRatePlausible("RUB", 0.16, 16)).toBe(false);
    expect(isYieldBenchmarkRatePlausible("MXN", 0.07, 7)).toBe(false);
    expect(isYieldBenchmarkRatePlausible("BRL", 0.14, 14)).toBe(false);
    expect(isYieldBenchmarkRatePlausible("TRY", 0, 40)).toBe(false);
  });

  it("admits ordinary moves inside each key's band", () => {
    expect(isYieldBenchmarkRatePlausible("USD", 3.72, 4.33)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("TRY", 42, 40)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("CHF", -0.05, -0.02)).toBe(true);
  });

  it("always admits a move of at most 50 bp, including low levels and sign crossings", () => {
    expect(isYieldBenchmarkRatePlausible("USD", 0.5, 1.0)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("CAD", 0.5, 1.0)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("AUD", 0.25, 0.75)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("CHF", -0.75, -0.25)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("EUR", 0.0, -0.5)).toBe(true);
  });

  it("cannot grade without a finite previous market observation", () => {
    expect(isYieldBenchmarkRatePlausible("USD", 3.72, null)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("USD", 3.72, 0)).toBe(true);
    expect(isYieldBenchmarkRatePlausible("USD", Number.NaN, 3.72)).toBe(false);
  });
});

describe("assessYieldBenchmarkRate", () => {
  it("confirms a persistent relative-band shift on the second consecutive observation", () => {
    expect(assessYieldBenchmarkRate("USD", 0.4, 1.0)).toEqual({
      accepted: false,
      rejection: "relative-band",
      confirmedLevelShift: false,
    });
    expect(assessYieldBenchmarkRate("USD", 0.41, 1.0, 0.4)).toEqual({
      accepted: true,
      rejection: null,
      confirmedLevelShift: true,
    });
  });

  it("rejects a one-off spike and a different out-of-band level", () => {
    expect(assessYieldBenchmarkRate("USD", 0.4, 1.0, null)).toMatchObject({
      accepted: false,
      rejection: "relative-band",
      confirmedLevelShift: false,
    });
    expect(assessYieldBenchmarkRate("USD", 0.4, 1.0, 0.25)).toMatchObject({
      accepted: false,
      rejection: "relative-band",
      confirmedLevelShift: false,
    });
  });

  it("never confirms a persistent unit-scale drift", () => {
    expect(assessYieldBenchmarkRate("TRY", 0.4, 40, 0.4)).toEqual({
      accepted: false,
      rejection: "unit-scale",
      confirmedLevelShift: false,
    });
    expect(assessYieldBenchmarkRate("USD", 0.43, 4.3, 0.43)).toMatchObject({
      accepted: false,
      rejection: "unit-scale",
      confirmedLevelShift: false,
    });
  });
});
