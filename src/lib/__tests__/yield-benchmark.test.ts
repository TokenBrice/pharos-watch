import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  YIELD_BENCHMARK_AGE_FALLBACK_BOUND_SEC,
  getYieldBenchmarkDisplayLabel,
  getYieldBenchmarkGapReferenceText,
  getYieldBenchmarkGapUnavailableText,
  getYieldRankingBenchmarkKey,
  resolveYieldBenchmarkAge,
  resolveYieldDisplayRebaseReferenceRate,
  resolveYieldRowBenchmark,
  resolveYieldScatterBenchmarkFrame,
} from "@/lib/yield-benchmark";
import type { YieldBenchmarkKey, YieldBenchmarkRegistry, YieldRanking, YieldRankingProvenance } from "@shared/types";
import type { YieldRankingSummary } from "@shared/types/yield-summary";
import { makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { classifyYieldBenchmarkFreshness } from "@shared/lib/yield-benchmark-freshness";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import { getYieldBenchmarkSelectionMode } from "@/lib/yield-workbench-row";

// Age markers resolve against the wall clock; pin it so day counts are exact.
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-09-12T00:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("row benchmark selection evidence", () => {
  it.each([
    ["fallback-usd", false], ["native", true],
  ] as const)("preserves %s selection independently of feed fallback %s", (selectionMode, isFallback) => {
    const row = makeYieldRanking({ benchmarkSelectionMode: selectionMode, benchmarkIsFallback: isFallback });
    const summary = projectYieldRankingsSummary({
      rankings: [row], updatedAt: 1, riskFreeRate: 4.25, scalingFactor: 8, medianApy: 5,
    }).rankings[0];
    for (const candidate of [row, summary]) {
      expect(getYieldBenchmarkSelectionMode(candidate)).toBe(selectionMode);
      expect(resolveYieldRowBenchmark(candidate, BENCHMARKS).selectionMode).toBe(selectionMode);
    }
  });

  it("infers legacy summary selection only when explicit selection evidence is absent", () => {
    const summary = projectYieldRankingsSummary({
      rankings: [makeYieldRanking({ benchmarkIsFallback: true })],
      updatedAt: 1, riskFreeRate: 4.25, scalingFactor: 8, medianApy: 5,
    }).rankings[0];
    delete summary.benchmarkSelectionMode;
    expect(getYieldBenchmarkSelectionMode(summary)).toBe("fallback-usd");
    expect(resolveYieldRowBenchmark(summary, BENCHMARKS).selectionMode).toBe("fallback-usd");
  });
});
const BENCHMARKS: YieldBenchmarkRegistry = {
  USD: {
    key: "USD",
    label: "USD 3M T-Bill",
    currency: "USD",
    rate: 4.25,
    recordDate: "2026-03-26",
    fetchedAt: 1774483200,
    ageSeconds: 0,
    source: "fred-dgs3mo",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
  EUR: {
    key: "EUR",
    label: "EUR 3M compounded €STR",
    currency: "EUR",
    rate: 1.94,
    recordDate: "2026-03-26",
    fetchedAt: 1774483200,
    ageSeconds: 0,
    source: "ecb-estr-3m",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
  CHF: {
    key: "CHF",
    label: "CHF 3M compounded SARON",
    currency: "CHF",
    rate: -0.05,
    recordDate: "2026-03-25",
    fetchedAt: 1774483200,
    ageSeconds: 0,
    source: "six-sar3mc",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
};

function buildProvenance(benchmarkKey: YieldBenchmarkKey): YieldRankingProvenance {
  return makeYieldProvenance({
    benchmarkKey,
    benchmarkLabel: BENCHMARKS[benchmarkKey]?.label,
    benchmarkCurrency: benchmarkKey,
    benchmarkRate: BENCHMARKS[benchmarkKey]?.rate,
    benchmarkRecordDate: BENCHMARKS[benchmarkKey]?.recordDate ?? null,
  });
}

function buildRanking(id: string, benchmarkKey: "USD" | "EUR" | "CHF"): YieldRanking {
  return makeYieldRanking({
    id,
    symbol: id.toUpperCase(),
    name: id,
    benchmarkKey,
    benchmarkLabel: BENCHMARKS[benchmarkKey]?.label,
    benchmarkCurrency: benchmarkKey,
    benchmarkRate: BENCHMARKS[benchmarkKey]?.rate,
    benchmarkRecordDate: BENCHMARKS[benchmarkKey]?.recordDate ?? null,
    provenance: buildProvenance(benchmarkKey),
  });
}

describe("getYieldBenchmarkDisplayLabel", () => {
  it("adds the fallback suffix when a row is using a fallback benchmark", () => {
    expect(
      getYieldBenchmarkDisplayLabel({
        benchmarkLabel: "USD 3M T-Bill",
        benchmarkIsFallback: true,
      }),
    ).toBe("USD 3M T-Bill (fallback)");
  });

  it("combines the fallback marker with an age marker for a stale proxy selection", () => {
    expect(
      getYieldBenchmarkDisplayLabel({
        benchmarkLabel: "USD 3M T-Bill",
        benchmarkIsFallback: true,
        ageSeconds: 60,
        recordDate: "2026-08-01",
      }),
    ).toBe("USD 3M T-Bill (fallback · 42d old)");
  });
});

describe("resolveYieldBenchmarkAge", () => {
  const NOW = Date.parse("2026-09-12T00:00:00Z");

  it("flags a record older than the default daily-series bound", () => {
    const age = resolveYieldBenchmarkAge({ ageSeconds: 60, recordDate: "2026-08-01" }, NOW);
    expect(age.stale).toBe(true);
    expect(age.boundSeconds).toBe(YIELD_BENCHMARK_AGE_FALLBACK_BOUND_SEC);
    expect(age.marker).toBe("42d old");
  });

  it("stays fresh inside the default bound (a 3d-old observation on an old payload does not tint)", () => {
    // 3 days is past the retired 48h fallback but inside the daily-series
    // bound the fallback now mirrors — exactly the healthy cached entry that
    // must never render amber.
    const age = resolveYieldBenchmarkAge({ ageSeconds: 60, recordDate: "2026-09-09" }, NOW);
    expect(age.ageSeconds).toBe(3 * 24 * 60 * 60);
    expect(age.stale).toBe(false);
    expect(age.marker).toBe("");
    expect(age.reason).toBeNull();
  });

  it("measures against the published per-key bound when the payload carries one", () => {
    const withinBound = resolveYieldBenchmarkAge(
      { ageSeconds: 60, recordDate: "2026-08-01", maxRecordAgeSec: 45 * 24 * 60 * 60 },
      NOW,
    );
    expect(withinBound.stale).toBe(false);

    const pastBound = resolveYieldBenchmarkAge(
      { ageSeconds: 60, recordDate: "2026-07-24", maxRecordAgeSec: 45 * 24 * 60 * 60 },
      NOW,
    );
    expect(pastBound.stale).toBe(true);
  });

  it("does not let a cached record age override the actual observation date", () => {
    const age = resolveYieldBenchmarkAge(
      { ageSeconds: 60, recordDate: "2026-08-01", recordAgeSec: 3600 },
      NOW,
    );
    expect(age.stale).toBe(true);
    expect(age.ageSeconds).toBe(42 * 24 * 60 * 60);
  });

  it("flags a fetch age past the bound even without a record date", () => {
    const age = resolveYieldBenchmarkAge({ ageSeconds: 6 * 24 * 60 * 60 }, NOW);
    expect(age.stale).toBe(true);
    expect(age.marker).toBe("6d old");
  });

  it("fails closed for missing or future observation evidence", () => {
    expect(resolveYieldBenchmarkAge({ ageSeconds: 60, recordDate: "2026-10-01" }, NOW).stale).toBe(true);
    expect(resolveYieldBenchmarkAge({}, NOW).stale).toBe(true);
    expect(resolveYieldBenchmarkAge(null, NOW).stale).toBe(true);
  });

  it("applies the 48h fetch bound even when today's observation is within its five-day bound", () => {
    const age = resolveYieldBenchmarkAge({
      ageSeconds: 49 * 3600,
      recordDate: "2026-09-12",
      maxRecordAgeSec: 5 * 86400,
    }, NOW);
    expect(age.stale).toBe(true);
    expect(age.boundSeconds).toBe(48 * 3600);
    expect(classifyYieldBenchmarkFreshness(
      { ageSeconds: 49 * 3600, isFallback: false, fallbackMode: null },
      { recordDate: "2026-09-12", maxRecordAgeSec: 5 * 86400, nowSec: NOW / 1000 },
    )).toBe("stale");
  });
});

describe("resolveYieldRowBenchmark", () => {
  it("keeps the row's published rate and native label", () => {
    const resolved = resolveYieldRowBenchmark(buildRanking("eur-a", "EUR"), BENCHMARKS, 4.25);
    expect(resolved.rate).toBe(1.94);
    expect(resolved.label).toBe("EUR 3M compounded €STR");
    expect(resolved.isFallback).toBe(false);
    expect(resolved.selectionMode).toBe("native");
  });

  it("resolves a missing row rate from the registry by benchmark key before the USD frame", () => {
    const { benchmarkRate: _drop, ...row } = buildRanking("eur-b", "EUR");
    const resolved = resolveYieldRowBenchmark(row as YieldRanking, BENCHMARKS, 4.25);
    expect(resolved.rate).toBe(1.94);
    expect(resolved.label).toBe("EUR 3M compounded €STR");
  });

  it("falls back to the USD registry entry only when the row's key is missing", () => {
    const { benchmarkRate: _drop, ...row } = buildRanking("chf-b", "CHF");
    const usdOnly: YieldBenchmarkRegistry = { USD: BENCHMARKS.USD };
    const resolved = resolveYieldRowBenchmark(row as YieldRanking, usdOnly, null);
    expect(resolved.rate).toBe(4.25);
  });

  it("labels a fallback-usd proxy selection even though benchmarkIsFallback is false", () => {
    const row = makeYieldRanking({ benchmarkSelectionMode: "fallback-usd" });
    const resolved = resolveYieldRowBenchmark(row, BENCHMARKS, 4.25);
    expect(resolved.isFallback).toBe(true);
    expect(resolved.selectionMode).toBe("fallback-usd");
    expect(resolved.label).toBe("USD 3M T-Bill (fallback)");
  });

  it.each([
    ["fallback-usd", false],
    ["native", true],
  ] as const)("preserves summary selection %s separately from fallback evidence", (selectionMode, isFallback) => {
    const summaryRow = {
      ...makeYieldRanking({ benchmarkIsFallback: isFallback, benchmarkSelectionMode: selectionMode }),
      alternateSourceCount: 3,
    } as YieldRankingSummary;
    const resolved = resolveYieldRowBenchmark(summaryRow, BENCHMARKS, 4.25);
    expect(resolved.selectionMode).toBe(selectionMode);
    expect(resolved.isFallback).toBe(true);
  });

  it("resolves to a null rate only when nothing resolves at all", () => {
    const { benchmarkRate: _drop, ...row } = makeYieldRanking({ benchmarkKey: "CHF" });
    expect(resolveYieldRowBenchmark(row as YieldRanking, null, 4.25).rate).toBe(4.25);
    expect(resolveYieldRowBenchmark(row as YieldRanking, null, null).rate).toBeNull();
  });
});

describe("yield benchmark gap copy", () => {
  it("builds a shared 30d benchmark subtitle for excess yield callouts", () => {
    expect(
      getYieldBenchmarkGapReferenceText({
        benchmarkLabel: "USD 3M T-Bill",
      }),
    ).toBe("30d vs USD 3M T-Bill");
    expect(
      getYieldBenchmarkGapReferenceText({
        benchmarkLabel: "USD 3M T-Bill",
      }, { includePeriod: false }),
    ).toBe("vs USD 3M T-Bill");
  });

  it("builds the shared no-gap fallback copy", () => {
    expect(getYieldBenchmarkGapUnavailableText()).toBe("No 30d benchmark gap");
  });
});

describe("resolveYieldScatterBenchmarkFrame", () => {
  it("uses the provenance benchmark key when the top-level key is absent", () => {
    const { benchmarkKey: _benchmarkKey, ...rankingWithoutBenchmarkKey } = buildRanking("eur-fallback", "USD");
    const ranking: YieldRanking = {
      ...rankingWithoutBenchmarkKey,
      provenance: buildProvenance("EUR"),
    };

    const result = resolveYieldScatterBenchmarkFrame({
      rankings: [ranking],
      benchmarks: BENCHMARKS,
      fallbackBenchmark: BENCHMARKS.USD,
    });

    expect(getYieldRankingBenchmarkKey(ranking)).toBe("EUR");
    expect(result.hasMixedBenchmarks).toBe(false);
    expect(result.usesDefaultBenchmarkFrame).toBe(false);
    expect(result.sharedBenchmarkKey).toBe("EUR");
    expect(result.referenceBenchmark?.key).toBe("EUR");
  });

  it("uses the shared native benchmark when the visible set is homogeneous", () => {
    const result = resolveYieldScatterBenchmarkFrame({
      rankings: [buildRanking("eur-a", "EUR"), buildRanking("eur-b", "EUR")],
      benchmarks: BENCHMARKS,
      fallbackBenchmark: BENCHMARKS.USD,
    });

    expect(result.hasMixedBenchmarks).toBe(false);
    expect(result.usesDefaultBenchmarkFrame).toBe(false);
    expect(result.sharedBenchmarkKey).toBe("EUR");
    expect(result.referenceBenchmark?.key).toBe("EUR");
  });

  it("uses the USD default benchmark frame when the visible set mixes currencies", () => {
    const result = resolveYieldScatterBenchmarkFrame({
      rankings: [buildRanking("usd-a", "USD"), buildRanking("eur-a", "EUR"), buildRanking("chf-a", "CHF")],
      benchmarks: BENCHMARKS,
      fallbackBenchmark: BENCHMARKS.USD,
    });

    expect(result.hasMixedBenchmarks).toBe(true);
    expect(result.usesDefaultBenchmarkFrame).toBe(true);
    expect(result.sharedBenchmarkKey).toBeNull();
    expect(result.referenceBenchmark?.key).toBe("USD");
  });
});

describe("resolveYieldDisplayRebaseReferenceRate (v8.43 re-base window)", () => {
  const healthy = {
    ...BENCHMARKS.USD,
    recordDate: "2026-09-12",
    fetchedAt: Date.parse("2026-09-12T00:00:00Z") / 1000,
    maxRecordAgeSec: 5 * 86400,
  };

  it.each(["v8.43", "v8.44", "8.43"])("allows healthy evidence for %s", (version) => {
    expect(resolveYieldDisplayRebaseReferenceRate(version, 3.5, healthy)).toBe(3.5);
  });

  it.each(["v8.42", "v8.4", null, undefined, "not-a-version"])("does not rebase methodology %s", (version) => {
    expect(resolveYieldDisplayRebaseReferenceRate(version, 3.5, healthy)).toBeNull();
  });

  it("rejects fallback, stale and absent reference evidence", () => {
    expect(resolveYieldDisplayRebaseReferenceRate("v8.44", 3.5, { ...healthy, isFallback: true })).toBeNull();
    expect(resolveYieldDisplayRebaseReferenceRate("v8.44", 3.5, BENCHMARKS.USD)).toBeNull();
    expect(resolveYieldDisplayRebaseReferenceRate("v8.44", 3.5, undefined)).toBeNull();
    expect(resolveYieldDisplayRebaseReferenceRate("v8.44", null, healthy)).toBeNull();
  });
});
