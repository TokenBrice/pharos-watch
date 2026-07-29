import type {
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldBenchmarkSelectionMode,
} from "@shared/types";
import type { YieldRanking } from "@shared/types/yield";
import type { YieldRankingSummary } from "@shared/types/yield-summary";

type YieldWorkbenchRanking = YieldRanking | YieldRankingSummary;

type YieldBenchmarkLike = {
  benchmarkKey?: YieldBenchmarkKey;
  benchmarkLabel?: string;
  benchmarkSelectionMode?: YieldBenchmarkSelectionMode;
  benchmarkIsFallback?: boolean;
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
  if (value.benchmarkSelectionMode === "fallback-usd" || value.benchmarkIsFallback) {
    return " (fallback)";
  }
  return "";
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
