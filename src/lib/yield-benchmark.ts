import type {
  YieldBenchmarkKey,
  YieldBenchmarkSelectionMode,
} from "@shared/types/yield-vocabulary";
import type {
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
} from "@shared/types/yield";
import type { YieldRanking } from "@shared/types/yield";
import type { YieldRankingSummary } from "@shared/types/yield-summary";
import {
  benchmarkRecordAgeSeconds,
  classifyYieldBenchmarkFreshness,
  getYieldBenchmarkComparisonApy,
  getYieldBenchmarkRecordMaxAgeSeconds,
  hasYieldBenchmarkUnitMismatch,
  isYieldBenchmarkFixingEffective,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
} from "@shared/lib/yield-benchmark-freshness";
import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "@shared/lib/status-thresholds";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { deriveDataHealth, isPublicWarning } from "@/lib/data-health";

type YieldWorkbenchRanking = YieldRanking | YieldRankingSummary;

type YieldBenchmarkLike = {
  key?: YieldBenchmarkKey;
  benchmarkKey?: YieldBenchmarkKey;
  benchmarkLabel?: string;
  benchmarkSelectionMode?: YieldBenchmarkSelectionMode;
  benchmarkIsFallback?: boolean;
  ageSeconds?: number | null;
  fetchedAt?: number | null;
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
  // Registry entries carry age evidence, so a publicly stale fetch generation
  // labels itself wherever the shared suffix renders (reference-rates strip,
  // scatter benchmark frame); score qualification alone never does (ADR-42).
  if ("ageSeconds" in value || "recordDate" in value) {
    const display = resolveYieldBenchmarkDisplayHealth(value);
    if (display.warning) parts.push(display.marker);
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
  opts: { includePeriod?: boolean } = {},
): string {
  const prefix = opts.includePeriod === false ? "" : "30d ";
  return `${prefix}${getYieldBenchmarkReferenceText(value)}`;
}

export function getYieldBenchmarkGapUnavailableText(): string {
  return "No 30d benchmark gap";
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
  const entry = benchmarks?.[key];
  return entry == null ? null : entry.key === undefined ? { ...entry, key } : entry;
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
  const comparableRankings = params.rankings.filter((row) => !hasYieldBenchmarkUnitMismatch(row));
  const visibleBenchmarkKeys = getYieldBenchmarkKeys(comparableRankings);
  const hasMixedBenchmarks = visibleBenchmarkKeys.length > 1;
  const sharedBenchmarkKey = visibleBenchmarkKeys.length === 1 ? visibleBenchmarkKeys[0] : null;
  const referenceBenchmark = comparableRankings.length === 0 && params.rankings.length > 0
    ? null
    : getYieldBenchmarkForKey(params.benchmarks, sharedBenchmarkKey ?? "USD") ?? params.fallbackBenchmark ?? null;

  return {
    referenceBenchmark,
    hasMixedBenchmarks,
    usesDefaultBenchmarkFrame: hasMixedBenchmarks,
    sharedBenchmarkKey,
  };
}

export const YIELD_BENCHMARK_AGE_FALLBACK_BOUND_SEC = YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD;

export interface YieldBenchmarkAgeEvidence {
  key?: YieldBenchmarkKey;
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
  const publishedBound =
    value?.maxRecordAgeSec != null && Number.isFinite(value.maxRecordAgeSec) && value.maxRecordAgeSec > 0
      ? value.maxRecordAgeSec : undefined;
  const boundSeconds = getYieldBenchmarkRecordMaxAgeSeconds(value?.key ?? "USD", value?.recordDate, publishedBound);
  const nowSec = Math.floor(nowMs / 1000);
  const fetchAge = value?.fetchedAt != null ? nowSec - value.fetchedAt : value?.ageSeconds ?? null;
  const recordAge = benchmarkRecordAgeSeconds(value?.recordDate, nowSec);
  const freshness = classifyYieldBenchmarkFreshness(
    { key: value?.key, ageSeconds: fetchAge, isFallback: value?.isFallback ?? false, fallbackMode: value?.fallbackMode ?? null },
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

/** Public display gate input: the benchmark's own fetch clock against its daily producer cadence. */
export function getYieldBenchmarkDisplayHealthInput(value: YieldBenchmarkAgeEvidence | null | undefined) {
  const fetchedAt = value?.fetchedAt;
  return {
    label: "Benchmark",
    // A missing or invalid clock stays unavailable, never zero-age evidence.
    dataUpdatedAt: fetchedAt != null && Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt * 1000 : 0,
    staleTime: CRON_INTERVALS["fetch-tbill-rate"] * 1000,
    hasData: true,
  };
}

export interface YieldBenchmarkDisplayHealth {
  /** True only when the shared public gate warns on the fetch generation. */
  warning: boolean;
  /** Compact label marker, e.g. "13d old"; empty below public eligibility. */
  marker: string;
}

/**
 * Reader-facing benchmark health, separate from `resolveYieldBenchmarkAge`'s
 * score qualification. CETES also warns when its effective placement expires.
 */
export function resolveYieldBenchmarkDisplayHealth(
  value: YieldBenchmarkAgeEvidence | null | undefined,
  nowMs: number = Date.now(),
): YieldBenchmarkDisplayHealth {
  const health = deriveDataHealth(getYieldBenchmarkDisplayHealthInput(value), nowMs);
  if (value?.key === "MXN") {
    const nowSec = Math.floor(nowMs / 1000);
    const recordAge = benchmarkRecordAgeSeconds(value.recordDate, nowSec);
    if (!isYieldBenchmarkFixingEffective("MXN", value.recordDate, nowSec)) {
      return { warning: true, marker: "unavailable" };
    }
    if (recordAge != null && recordAge > getYieldBenchmarkRecordMaxAgeSeconds("MXN", value.recordDate)) {
      return { warning: true, marker: `${formatBenchmarkAge(recordAge)} old` };
    }
  }
  if (!isPublicWarning(health)) return { warning: false, marker: "" };
  return {
    warning: true,
    marker: health.ageMs != null ? `${formatBenchmarkAge(health.ageMs / 1000)} old` : "unavailable",
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

export interface YieldResolvedRowBenchmark {
  /** Display comparison rate; not a replacement for the published PYS hurdle. */
  rate: number | null;
  /** Identity of the rate actually displayed; null when unavailable. */
  key: YieldBenchmarkKey | null;
  label: string;
  /** Published selection/feed fallback evidence, independent of display fallback. */
  isFallback: boolean;
  selectionMode: YieldBenchmarkSelectionMode | null;
  /** True only when incomplete row/keyed evidence uses a USD display frame. */
  displayFallback: boolean;
  /** Original scoring hurdle, never filled from a display-only fallback. */
  publishedRate: number | null;
}

/**
 * Resolve the first finite display rate together with its own identity.
 * Row/keyed evidence wins; a legacy USD display frame is explicitly labelled
 * without rewriting the published selection mode or PYS hurdle.
 */
export function resolveYieldRowBenchmark(
  row: YieldWorkbenchRanking,
  registry: YieldBenchmarkRegistry | null | undefined,
  riskFreeRate?: number | null,
): YieldResolvedRowBenchmark {
  if (hasYieldBenchmarkUnitMismatch(row)) {
    return { rate: null, key: null, label: "Benchmark unavailable", isFallback: false, selectionMode: null, displayFallback: false, publishedRate: null };
  }
  const benchmarkKey = getYieldRankingBenchmarkKey(row);
  const meta = getYieldBenchmarkForKey(registry, benchmarkKey);
  const usd = getYieldBenchmarkForKey(registry, "USD");
  const selectionMode = row.benchmarkSelectionMode ?? null;
  const isFallback = selectionMode === "fallback-usd" || row.benchmarkIsFallback === true;
  const resolved = [
    { rate: row.benchmarkRate, key: benchmarkKey, label: row.benchmarkLabel ?? meta?.label, displayFallback: false },
    { rate: meta && getYieldBenchmarkComparisonApy({ ...meta, key: benchmarkKey }), key: benchmarkKey, label: meta?.label, displayFallback: false },
    { rate: usd && getYieldBenchmarkComparisonApy({ ...usd, key: "USD" }), key: "USD" as const, label: usd?.label, displayFallback: true },
    { rate: riskFreeRate, key: "USD" as const, label: usd?.label ?? "USD benchmark", displayFallback: true },
  ].find((candidate) => typeof candidate.rate === "number" && Number.isFinite(candidate.rate));
  const label = resolved
    ? getYieldBenchmarkDisplayLabel({
      benchmarkLabel: resolved.label,
      benchmarkKey: resolved.key,
      benchmarkSelectionMode: resolved.displayFallback ? undefined : selectionMode ?? undefined,
      benchmarkIsFallback: !resolved.displayFallback && isFallback,
    }) + (resolved.displayFallback ? " (display fallback)" : "")
    : "Benchmark unavailable";
  return {
    rate: resolved?.rate ?? null,
    key: resolved?.key ?? null,
    label,
    isFallback,
    selectionMode,
    displayFallback: resolved?.displayFallback ?? false,
    publishedRate: typeof row.benchmarkRate === "number" && Number.isFinite(row.benchmarkRate) ? row.benchmarkRate : null,
  };
}
