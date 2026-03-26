import type {
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldBenchmarkSelectionMode,
  YieldRanking,
} from "@shared/types";

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

export function getYieldBenchmarkDisplayLabel(value: YieldBenchmarkLike | YieldBenchmarkMeta | null | undefined): string {
  return `${getYieldBenchmarkLabel(value)}${getYieldBenchmarkStatusSuffix(value as YieldBenchmarkLike | null | undefined)}`;
}

export function getYieldBenchmarkReferenceText(value: YieldBenchmarkLike | YieldBenchmarkMeta | null | undefined): string {
  return `vs ${getYieldBenchmarkDisplayLabel(value)}`;
}

export function getYieldBenchmarkKeys(rankings: YieldRanking[]): YieldBenchmarkKey[] {
  return Array.from(
    new Set(
      rankings.map((ranking) => ranking.benchmarkKey ?? "USD"),
    ),
  );
}

export function getYieldBenchmarkForKey(
  benchmarks: YieldBenchmarkRegistry | null | undefined,
  key: YieldBenchmarkKey,
): YieldBenchmarkMeta | null {
  if (!benchmarks) return null;
  return benchmarks[key] ?? null;
}
