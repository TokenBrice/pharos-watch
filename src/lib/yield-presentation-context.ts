import type { YieldBenchmarkRegistry } from "@shared/types";
import { YIELD_BENCHMARK_KEY_CURRENCY } from "@shared/types/yield";
import { resolveYieldDisplayRebaseReferenceRate } from "@/lib/yield-benchmark";
import { computePysBreakdown } from "@/lib/yield-constants";
import type { YieldSourceDisplayClock } from "@/lib/yield-source-presentation";
import type { YieldWorkbenchRanking } from "@/lib/yield-workbench-row";

export function buildYieldPresentationContext({
  methodologyVersion,
  riskFreeRate,
  benchmarks,
  scalingFactor,
  sourceClock = null,
}: {
  methodologyVersion?: string | null;
  riskFreeRate: number;
  benchmarks?: YieldBenchmarkRegistry | null;
  scalingFactor: number;
  sourceClock?: YieldSourceDisplayClock | null;
}) {
  return {
    scalingFactor,
    sourceClock,
    // v8.43-gated: a payload scored before the re-base release (still
    // servable during a deploy window) was published without one, so the
    // display must not synthesize a re-base line the badge never used.
    usdBenchmarkRate: resolveYieldDisplayRebaseReferenceRate(methodologyVersion, riskFreeRate, benchmarks?.USD),
  };
}

export type YieldPresentationContext = ReturnType<typeof buildYieldPresentationContext>;

export function buildYieldPysBreakdown(row: YieldWorkbenchRanking, context: YieldPresentationContext) {
  // Same resolution the scoring/read paths use: the row's carried currency
  // wins; the benchmark-key table fills the summary projection in (USD_EFFR
  // rows are USD-benchmarked and must take no v8.43 re-base).
  const benchmarkCurrency =
    ("benchmarkCurrency" in row ? row.benchmarkCurrency : null) ??
    (row.benchmarkKey != null ? YIELD_BENCHMARK_KEY_CURRENCY[row.benchmarkKey] : null) ??
    null;
  return {
    ...computePysBreakdown(
      row.apy30d,
      row.safetyScore,
      row.yieldStability,
      row.benchmarkRate,
      row.sourceRisk?.sourceRiskPenalty ?? null,
      context.usdBenchmarkRate,
      benchmarkCurrency,
    ),
    scalingFactor: context.scalingFactor,
  };
}
