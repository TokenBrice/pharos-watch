import { afterEach, describe, expect, it, vi } from "vitest";
import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "@shared/lib/status-thresholds";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
  benchmarkRecordAgeSeconds,
  classifyYieldBenchmarkFreshness,
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

  it("degrades on feed fallback but not on documented proxy selection alone", () => {
    expect(classifyYieldBenchmarkFreshness({ ...healthyMeta, isFallback: true })).toBe("degraded");
    expect(classifyYieldBenchmarkFreshness({ ...healthyMeta, fallbackMode: "retained" })).toBe("degraded");
    expect(classifyYieldBenchmarkFreshness(healthyMeta)).toBe("healthy");
    expect(classifyYieldBenchmarkFreshness(healthyMeta, { selectionMode: "fallback-usd" })).toBe("degraded");
  });
});

describe("benchmarkRecordAgeSeconds", () => {
  it("clamps future-dated observations to zero and rejects unparseable dates", () => {
    expect(benchmarkRecordAgeSeconds("2099-01-01", NOW_SEC)).toBe(0);
    expect(benchmarkRecordAgeSeconds("not-a-date", NOW_SEC)).toBeNull();
    expect(benchmarkRecordAgeSeconds(null, NOW_SEC)).toBeNull();
    expect(benchmarkRecordAgeSeconds("2026-09-10", NOW_SEC)).toBe(2 * DAY_SECONDS + 12 * 3600);
  });
});
