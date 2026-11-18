import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { YieldBenchmarkKey, YieldBenchmarkMeta } from "@shared/types/yield";
import { classifyYieldBenchmarkFreshness, getYieldBenchmarkRecordMaxAgeSeconds, type YieldBenchmarkFreshness } from "@shared/lib/yield-benchmark-freshness";
import { getBenchmarkKeyForPegCurrency } from "../../cron/yield-sync/benchmarks";
import { resolveLinkedVariantSourceOwnerId } from "../yield-source-links";
import { RATE_DERIVED_CONFIGS } from "./yield-config-rate-sources";

/** Product, comparison hurdle and USD normalization are independent dependencies. */
export function resolveYieldBenchmarkDependencies<Meta extends YieldBenchmarkMeta>(params: {
  stablecoinId: string;
  dataSource: string;
  sourceKey?: string | null;
  benchmarks: Partial<Record<YieldBenchmarkKey, Meta | null>>;
  benchmarkCurrency: string | null;
  nowSec?: number;
}) {
  const ownerId = resolveLinkedVariantSourceOwnerId(params.stablecoinId, params.sourceKey) ?? params.stablecoinId;
  const config = params.dataSource === "rate-derived"
    ? RATE_DERIVED_CONFIGS.find(({ stablecoinId }) => stablecoinId === ownerId) : undefined;
  const productKey = config
    ? config.benchmarkCurrency ?? getBenchmarkKeyForPegCurrency(TRACKED_META_BY_ID.get(ownerId)?.flags.pegCurrency) ?? "USD"
    : null;
  const productMeta = productKey == null ? null : params.benchmarks[productKey] ?? null;
  const classify = (key: YieldBenchmarkKey): YieldBenchmarkFreshness => {
    const meta = params.benchmarks[key];
    return meta ? classifyYieldBenchmarkFreshness({ ...meta, key }, {
      recordDate: meta.recordDate,
      maxRecordAgeSec: getYieldBenchmarkRecordMaxAgeSeconds(key, meta.recordDate, meta.maxRecordAgeSec),
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
