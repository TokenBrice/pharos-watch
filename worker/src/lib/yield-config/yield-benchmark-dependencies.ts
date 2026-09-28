import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { YieldBenchmarkKey, YieldBenchmarkMeta } from "@shared/types/yield";
import { classifyYieldBenchmarkFreshness, YIELD_BENCHMARK_RECORD_MAX_AGE_SEC, type YieldBenchmarkFreshness } from "@shared/lib/yield-benchmark-freshness";
import { getBenchmarkKeyForPegCurrency } from "../../cron/yield-sync/benchmarks";
import { RATE_DERIVED_CONFIGS } from "./yield-config-rate-sources";

type BenchmarkEntries = Partial<Record<YieldBenchmarkKey, YieldBenchmarkMeta | null>>;
const configsById: Readonly<Record<string, (typeof RATE_DERIVED_CONFIGS)[number]>> =
  Object.fromEntries(RATE_DERIVED_CONFIGS.map((config) => [config.stablecoinId, config]));

/** Product, comparison hurdle and USD normalization are independent dependencies. */
export function resolveYieldBenchmarkDependencies(params: {
  stablecoinId: string;
  dataSource: string;
  benchmarks: BenchmarkEntries;
  benchmarkCurrency: string | null;
  nowSec?: number;
}) {
  const config = params.dataSource === "rate-derived" ? configsById[params.stablecoinId] : undefined;
  const configuredProductKey = config
    ? config.benchmarkCurrency ?? getBenchmarkKeyForPegCurrency(TRACKED_META_BY_ID.get(params.stablecoinId)?.flags.pegCurrency) ?? "USD"
    : null;
  // Match configured source selection: unavailable native feeds use the USD fallback.
  const productKey = configuredProductKey == null ? null : params.benchmarks[configuredProductKey] ? configuredProductKey : "USD";
  const productMeta = productKey ? params.benchmarks[productKey] ?? null : null;
  const classify = (key: YieldBenchmarkKey): YieldBenchmarkFreshness => {
    const meta = params.benchmarks[key];
    return meta ? classifyYieldBenchmarkFreshness(meta, {
      recordDate: meta.recordDate,
      maxRecordAgeSec: meta.maxRecordAgeSec ?? YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key],
      nowSec: params.nowSec,
    }) : "degraded";
  };
  const productFreshness = productKey == null ? "healthy" :
    productMeta == null || productMeta.source === "hardcoded-fallback" ? "stale" : classify(productKey);
  const normalizationFreshness = params.benchmarkCurrency === "USD" ? "healthy" : classify("USD");
  const referenceFreshness: YieldBenchmarkFreshness =
    productFreshness === "stale" || normalizationFreshness === "stale" ? "stale" :
      productFreshness === "degraded" || normalizationFreshness === "degraded" ? "degraded" : "healthy";
  return { productKey, productMeta, productFreshness, normalizationFreshness, referenceFreshness };
}
