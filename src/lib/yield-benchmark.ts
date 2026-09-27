import type {
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldBenchmarkSelectionMode,
} from "@shared/types";
import type { YieldRanking } from "@shared/types/yield";
import type { YieldRankingSummary } from "@shared/types/yield-summary";
import {
  benchmarkRecordAgeSeconds,
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
} from "@shared/lib/yield-benchmark-freshness";
import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "@shared/lib/status-thresholds";

type YieldWorkbenchRanking = YieldRanking | YieldRankingSummary;

type YieldBenchmarkLike = {
  benchmarkKey?: YieldBenchmarkKey;
  benchmarkLabel?: string;
  benchmarkSelectionMode?: YieldBenchmarkSelectionMode;
  benchmarkIsFallback?: boolean;
  ageSeconds?: number | null;
  recordDate?: string | null;
  recordAgeSec?: number | null;
  maxRecordAgeSec?: number | null;
};

function getYieldBenchmarkLabel(value: YieldBenchmarkLike | YieldBenchmarkMeta | null | undefined): string {
  if (!value) return "Benchmark";
  if ("benchmarkLabel" in value && value.benchmarkLabel) return value.benchmarkLabel;
  if ("label" in value && value.label) return value.label;
  if ("benchmarkKey" in value && value.benchmarkKey) return value.benchmarkKey;
  if ("key" in value && value.key) return value.key;
  return "Benchmark";
}

function getYieldBenchmarkStatusSuffix(value: YieldBenchmarkLike | null | undefined): string {
  if (!value) return "";
  const parts: string[] = [];
  if (value.benchmarkSelectionMode === "fallback-usd" || value.benchmarkIsFallback) {
    parts.push("fallback");
  }
  // Registry entries carry age evidence, so a stale entry labels itself
  // wherever the shared suffix renders (reference-rates strip, source board,
  // scatter benchmark frame) instead of reading identically to a fresh one.
  if ("ageSeconds" in value || "recordDate" in value) {
    const age = resolveYieldBenchmarkAge(value);
    if (age.stale && age.marker !== "fallback") parts.push(age.marker);
  }
  if (parts.length === 0) return "";
  return ` (${parts.join(" · ")})`;
}

export function getYieldBenchmarkDisplayLabel(
  value: YieldBenchmarkLike | YieldBenchmarkMeta | null | undefined,
): string {
  return `${getYieldBenchmarkLabel(value)}${getYieldBenchmarkStatusSuffix(value as YieldBenchmarkLike | null | undefined)}`;
}

export function getYieldBenchmarkReferenceText(
  value: YieldBenchmarkLike | YieldBenchmarkMeta | null | undefined,
): string {
  return `vs ${getYieldBenchmarkDisplayLabel(value)}`;
}

export function getYieldBenchmarkGapReferenceText(
  value: YieldBenchmarkLike | YieldBenchmarkMeta | null | undefined,
  opts: { includePeriod?: boolean; periodLabel?: string } = {},
): string {
  const prefix = opts.includePeriod === false ? "" : `${opts.periodLabel ?? "30d"} `;
  return `${prefix}${getYieldBenchmarkReferenceText(value)}`;
}

export function getYieldBenchmarkGapUnavailableText(periodLabel = "30d"): string {
  return `No ${periodLabel} benchmark gap`;
}

export function getYieldRankingBenchmarkKey(ranking: YieldWorkbenchRanking): YieldBenchmarkKey {
  return (
    ranking.benchmarkKey ??
    (!("alternateSourceCount" in ranking) ? ranking.provenance?.benchmarkKey : undefined) ??
    "USD"
  );
}

function getYieldBenchmarkKeys(rankings: YieldWorkbenchRanking[]): YieldBenchmarkKey[] {
  return Array.from(new Set(rankings.map(getYieldRankingBenchmarkKey)));
}

function getYieldBenchmarkForKey(
  benchmarks: YieldBenchmarkRegistry | null | undefined,
  key: YieldBenchmarkKey,
): YieldBenchmarkMeta | null {
  if (!benchmarks) return null;
  return benchmarks[key] ?? null;
}

export function resolveYieldScatterBenchmarkFrame(params: {
  rankings: YieldWorkbenchRanking[];
  benchmarks: YieldBenchmarkRegistry | null | undefined;
  fallbackBenchmark?: YieldBenchmarkMeta | null;
}): {
  referenceBenchmark: YieldBenchmarkMeta | null;
  hasMixedBenchmarks: boolean;
  usesDefaultBenchmarkFrame: boolean;
  sharedBenchmarkKey: YieldBenchmarkKey | null;
} {
  const visibleBenchmarkKeys = getYieldBenchmarkKeys(params.rankings);
  const hasMixedBenchmarks = visibleBenchmarkKeys.length > 1;
  const sharedBenchmarkKey = visibleBenchmarkKeys.length === 1 ? visibleBenchmarkKeys[0] : null;
  const referenceBenchmark = sharedBenchmarkKey
    ? (getYieldBenchmarkForKey(params.benchmarks, sharedBenchmarkKey) ?? params.fallbackBenchmark ?? null)
    : (getYieldBenchmarkForKey(params.benchmarks, "USD") ?? params.fallbackBenchmark ?? null);

  return {
    referenceBenchmark,
    hasMixedBenchmarks,
    usesDefaultBenchmarkFrame: hasMixedBenchmarks,
    sharedBenchmarkKey,
  };
}

// ---------------------------------------------------------------------------
// Benchmark staleness (E9)
// ---------------------------------------------------------------------------

export const YIELD_BENCHMARK_AGE_FALLBACK_BOUND_SEC = YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD;

export interface YieldBenchmarkAgeEvidence {
  /** Fetch age published on the registry entry. */
  ageSeconds?: number | null;
  fetchedAt?: number | null;
  isFallback?: boolean;
  fallbackMode?: string | null;
  /** Observation date published on the registry entry. */
  recordDate?: string | null;
  /** Informational cached age; assessment recomputes from recordDate. */
  recordAgeSec?: number | null;
  /** Per-key bound on the observation age, when the payload carries one. */
  maxRecordAgeSec?: number | null;
}

export interface YieldBenchmarkAgeAssessment {
  stale: boolean;
  /** Slowest of the available age signals (record age beats fetch age). */
  ageSeconds: number | null;
  /** Observation bound, or the fetch TTL when fetch age has expired. */
  boundSeconds: number;
  /** Compact label marker, e.g. "42d old"; empty when fresh. */
  marker: string;
  /** Tooltip / assistive reason; null when fresh. */
  reason: string | null;
}

function formatBenchmarkAge(seconds: number): string {
  if (seconds >= 2 * 24 * 60 * 60) return `${Math.round(seconds / (24 * 60 * 60))}d`;
  if (seconds >= 2 * 60 * 60) return `${Math.round(seconds / (60 * 60))}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

/** Assess the registry's own evidence using the same authority as the worker. */
export function resolveYieldBenchmarkAge(
  value: YieldBenchmarkAgeEvidence | null | undefined,
  nowMs: number = Date.now(),
): YieldBenchmarkAgeAssessment {
  const boundSeconds =
    value?.maxRecordAgeSec != null && Number.isFinite(value.maxRecordAgeSec) && value.maxRecordAgeSec > 0
      ? value.maxRecordAgeSec
      : YIELD_BENCHMARK_AGE_FALLBACK_BOUND_SEC;
  const nowSec = Math.floor(nowMs / 1000);
  const fetchAge = value?.fetchedAt != null ? nowSec - value.fetchedAt : value?.ageSeconds ?? null;
  const recordAge = benchmarkRecordAgeSeconds(value?.recordDate, nowSec);
  const freshness = classifyYieldBenchmarkFreshness(
    { ageSeconds: fetchAge, isFallback: value?.isFallback ?? false, fallbackMode: value?.fallbackMode ?? null },
    { recordDate: value?.recordDate, maxRecordAgeSec: boundSeconds, nowSec },
  );
  const ageSeconds = fetchAge == null ? recordAge : recordAge == null ? fetchAge : Math.max(fetchAge, recordAge);
  if (freshness === "healthy") {
    return { stale: false, ageSeconds, boundSeconds, marker: "", reason: null };
  }
  const fetchExpired = fetchAge != null && fetchAge > YIELD_BENCHMARK_SCORE_TTL_SEC;
  const effectiveBound = fetchExpired ? YIELD_BENCHMARK_SCORE_TTL_SEC : boundSeconds;
  return {
    stale: true,
    ageSeconds,
    boundSeconds: effectiveBound,
    marker: freshness === "degraded" ? "fallback" : ageSeconds != null && ageSeconds >= 0 ? `${formatBenchmarkAge(ageSeconds)} old` : "unavailable",
    reason: freshness === "degraded"
      ? "Benchmark evidence is a fallback, not a healthy reference."
      : `Benchmark evidence is unavailable or exceeds its ${formatBenchmarkAge(effectiveBound)} ${fetchExpired ? "fetch" : "observation"} freshness bound.`,
  };
}

// ---------------------------------------------------------------------------
// v8.43 re-base window (display breakdown)
// ---------------------------------------------------------------------------

/**
 * Yield methodology release that re-based the PYS hurdle onto the USD
 * reference (`usdBenchmarkRate`). Rows scored by an earlier version were
 * published *without* the re-base, so while a deploy window serves a
 * v8.42-scored payload to re-base-aware client code, the display breakdown
 * must not render a re-base line the published badge never used.
 */
const YIELD_REBASE_METHODOLOGY_VERSION = 8.43;

/** Numeric value of a published methodology version string ("v8.43" -> 8.43). */
function parseYieldMethodologyVersion(version: string | null | undefined): number | null {
  const parsed = Number.parseFloat((version ?? "").replace(/^v/i, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * USD reference rate the *display* breakdown may re-base onto: the payload's
 * risk-free rate only with healthy USD evidence and a post-re-base methodology.
 * Otherwise null preserves the API's un-rebased explanation.
 */
export function resolveYieldDisplayRebaseReferenceRate(
  methodologyVersion: string | null | undefined,
  riskFreeRate: number | null | undefined,
  usdBenchmark: YieldBenchmarkMeta | null | undefined,
): number | null {
  const version = parseYieldMethodologyVersion(methodologyVersion);
  if (version === null || version < YIELD_REBASE_METHODOLOGY_VERSION) return null;
  if (!usdBenchmark || resolveYieldBenchmarkAge(usdBenchmark).stale) return null;
  return riskFreeRate != null && Number.isFinite(riskFreeRate) ? riskFreeRate : null;
}

// ---------------------------------------------------------------------------
// Per-row benchmark resolution (E5)
// ---------------------------------------------------------------------------

export interface YieldResolvedRowBenchmark {
  /** Rate the row is judged against; null only when nothing resolves. */
  rate: number | null;
  /** Display label, including the (fallback) marker when the row proxies USD. */
  label: string;
  isFallback: boolean;
  selectionMode: YieldBenchmarkSelectionMode | null;
}

function getYieldRowSelectionMode(row: YieldWorkbenchRanking): YieldBenchmarkSelectionMode | undefined {
  return row.benchmarkSelectionMode ??
    ("alternateSourceCount" in row && row.benchmarkIsFallback ? "fallback-usd" : undefined);
}

function firstFiniteNumber(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * One resolution for "which benchmark is this row judged against": the row's
 * published rate, else the registry entry for its benchmark key, else the USD
 * frame, else the chart-wide risk-free rate. The (fallback) marker follows the
 * row's selection mode — `benchmarkIsFallback` is false on documented proxy
 * selections, so the marker would otherwise drop off scatter tooltips.
 */
export function resolveYieldRowBenchmark(
  row: YieldWorkbenchRanking,
  registry: YieldBenchmarkRegistry | null | undefined,
  riskFreeRate?: number | null,
): YieldResolvedRowBenchmark {
  const benchmarkKey = getYieldRankingBenchmarkKey(row);
  const meta = getYieldBenchmarkForKey(registry, benchmarkKey);
  const selectionMode = getYieldRowSelectionMode(row) ?? null;
  const isFallback = selectionMode === "fallback-usd" || row.benchmarkIsFallback === true;
  const rate = firstFiniteNumber(
    row.benchmarkRate,
    meta?.rate,
    getYieldBenchmarkForKey(registry, "USD")?.rate,
    riskFreeRate,
  );
  const label = getYieldBenchmarkDisplayLabel({
    benchmarkLabel: row.benchmarkLabel ?? meta?.label,
    benchmarkKey,
    benchmarkSelectionMode: selectionMode ?? undefined,
    benchmarkIsFallback: isFallback,
  });
  return { rate, label, isFallback, selectionMode };
}
