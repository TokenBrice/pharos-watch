import { hasMissingPrice, type PeggedAsset } from "./enrich-prices";
import { buildSyncMetadata, type CronResult, type PriceSourceHealth } from "./shared";
import type { CacheValidationResult } from "./cache-publication";
import type { CanonicalDeduplicationResult } from "./phase-helpers";
import type { GtProbeStats } from "../../lib/geckoterminal-price-probe";
import {
  createEmptyPriceSourceHealthDistribution,
  isPriceSourceHealthBucketKey,
  normalizePricingSourceKeys,
  splitCompositePriceSource,
} from "@shared/lib/pricing-sources";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";

function mapSourceToBucket(
  source: string,
  _dist: PriceSourceHealth["sourceDistribution"],
) {
  return isPriceSourceHealthBucketKey(source) ? source : null;
}

export function buildPriceSourceHealth(assets: PeggedAsset[]): PriceSourceHealth {
  const sourceDistribution: PriceSourceHealth["sourceDistribution"] = createEmptyPriceSourceHealthDistribution();
  const confidenceDistribution: PriceSourceHealth["confidenceDistribution"] = {
    high: 0,
    "single-source": 0,
    low: 0,
    fallback: 0,
  };

  for (const asset of assets) {
    if (hasMissingPrice(asset)) {
      sourceDistribution.missing++;
      continue;
    }

    if (asset.agreeSources && asset.agreeSources.length > 0) {
      const agreeSet = new Set(asset.agreeSources);
      if (agreeSet.has("coingecko") && agreeSet.has("defillama-list")) {
        sourceDistribution["coingecko+defillama-list"]++;
      }
      for (const src of asset.agreeSources) {
        const bucket = mapSourceToBucket(src, sourceDistribution);
        if (bucket) {
          sourceDistribution[bucket]++;
        }
      }
    } else {
      const source = asset.priceSource;
      if (source) {
        const exactBucket = mapSourceToBucket(source, sourceDistribution);
        if (exactBucket) {
          sourceDistribution[exactBucket]++;
        } else {
          for (const part of splitCompositePriceSource(source)) {
            const partBucket = mapSourceToBucket(part, sourceDistribution);
            if (partBucket) {
              sourceDistribution[partBucket]++;
            }
          }
        }
      }
    }

    const confidence = asset.priceConfidence;
    if (confidence && confidence in confidenceDistribution) {
      confidenceDistribution[confidence as keyof typeof confidenceDistribution]++;
    }
  }

  return {
    sourceDistribution,
    confidenceDistribution,
    totalAssets: assets.length,
    lastSync: Math.floor(Date.now() / 1000),
  };
}

interface PricingSourceAuditReport {
  missingPriceCount: number;
  fallbackOrCachedCount: number;
  lowConfidenceCount: number;
  assetsWithoutIndependentHardSource: string[];
  providerRejectionCounts: Record<string, number>;
  providerFailuresBySource: Record<string, number>;
}

function hasIndependentHardSource(asset: PeggedAsset): boolean {
  const sources = asset.agreeSources && asset.agreeSources.length > 0
    ? asset.agreeSources
    : asset.priceSource
      ? normalizePricingSourceKeys(asset.priceSource)
      : [];
  return normalizePricingSourceKeys(sources).some((source) => {
    const trustTier = getPricingSourceRegistryEntry(source)?.trustTier;
    return trustTier === "hard_market" || trustTier === "hard_oracle" || trustTier === "hard_protocol";
  });
}

export function buildPricingSourceAuditReport(
  assets: PeggedAsset[],
  providerDiagnostics: readonly PricingProviderAttemptDiagnostic[] = [],
): PricingSourceAuditReport {
  const providerRejectionCounts: Record<string, number> = {};
  const providerFailuresBySource: Record<string, number> = {};

  for (const diagnostic of providerDiagnostics) {
    if (!diagnostic.success) {
      providerFailuresBySource[diagnostic.source] = (providerFailuresBySource[diagnostic.source] ?? 0) + 1;
    }
    for (const [reason, count] of Object.entries(diagnostic.rejectionReasonCounts ?? {})) {
      providerRejectionCounts[reason] = (providerRejectionCounts[reason] ?? 0) + (typeof count === "number" ? count : 0);
    }
  }

  return {
    missingPriceCount: assets.filter(hasMissingPrice).length,
    fallbackOrCachedCount: assets.filter((asset) => {
      const source = asset.priceSource;
      if (source === "cached" || asset.priceConfidence === "fallback") return true;
      const entries = normalizePricingSourceKeys(source).map((sourceKey) => getPricingSourceRegistryEntry(sourceKey));
      return entries.length > 0 && entries.every((entry) =>
        entry?.trustTier === "fallback_search" || entry?.trustTier === "cached_replay"
      );
    }).length,
    lowConfidenceCount: assets.filter((asset) => asset.priceConfidence === "low").length,
    assetsWithoutIndependentHardSource: assets
      .filter((asset) => !hasMissingPrice(asset) && !hasIndependentHardSource(asset))
      .map((asset) => asset.id)
      .sort(),
    providerRejectionCounts,
    providerFailuresBySource,
  };
}

export function buildStablecoinsSyncResult(input: {
  assets: PeggedAsset[];
  rawAssetCount: number;
  droppedMalformedAssets: number;
  canonicalDeduplication: CanonicalDeduplicationResult;
  enrichStats: unknown;
  priceValidationStats: unknown;
  providerDiagnostics?: PricingProviderAttemptDiagnostic[];
  authoritativeOverrideCount?: number;
  rejectedCount: number;
  nativePegCorrectionCount?: number;
  nativePegFillCount?: number;
  stalenessWarning: boolean;
  stalenessSummary?: { compared: number; identical: number; identicalRatio: number } | null;
  gtProbe: { updatedCount: number; stats: GtProbeStats };
  depegErrorCount: number;
  depegErrors: string[];
  upstreamFetchOk?: boolean;
  payloadAccepted?: boolean;
  cacheWriteSucceeded?: boolean;
  cacheKey?: string;
  syncStartSec?: number;
  depegPipelineSucceeded?: boolean;
}): CronResult {
  const finalMissing = input.assets.filter(hasMissingPrice).length;
  const priceSourceHealth = buildPriceSourceHealth(input.assets);
  const pricingSourceAuditReport = buildPricingSourceAuditReport(input.assets, input.providerDiagnostics ?? []);
  const status: CronResult["status"] = input.depegErrorCount > 0 ? "degraded" : "ok";

  const metadata: Record<string, unknown> = {
    rowsRead: input.rawAssetCount,
    rowsWritten: input.assets.length,
    rowsDropped: input.droppedMalformedAssets,
    sourceCoverage: { defillama: true },
    fallbackMode: null,
    validationFailures: 0,
    canonicalDeduplication: input.canonicalDeduplication,
    assetCount: input.assets.length,
    enrichment: input.enrichStats,
    authoritativeOverrides: input.authoritativeOverrideCount ?? 0,
    gtProbe: {
      updatedCount: input.gtProbe.updatedCount,
      ...input.gtProbe.stats,
    },
    priceValidation: input.priceValidationStats,
    providerDiagnostics: input.providerDiagnostics ?? [],
    rejectedPrices: input.rejectedCount,
    nativePegCorrections: input.nativePegCorrectionCount ?? 0,
    nativePegFills: input.nativePegFillCount ?? 0,
    missingPrices: finalMissing,
    priceSourceHealth,
    pricingSourceAuditReport,
    upstreamFetchOk: input.upstreamFetchOk ?? true,
    payloadAccepted: input.payloadAccepted ?? true,
    cacheWriteSucceeded: input.cacheWriteSucceeded ?? true,
    cacheKey: input.cacheKey ?? "stablecoins",
    syncStartSec: input.syncStartSec,
    depegPipelineSucceeded: input.depegPipelineSucceeded ?? input.depegErrorCount === 0,
  };
  if (input.stalenessWarning) metadata.stalenessWarning = true;
  if (input.stalenessSummary) metadata.priceStaleness = input.stalenessSummary;
  if (input.depegErrorCount > 0) {
    metadata.depegErrorCount = input.depegErrorCount;
    metadata.depegErrors = input.depegErrors;
  }

  return {
    itemCount: input.assets.length,
    status,
    metadata: buildSyncMetadata(metadata, {
      cacheWriteMode: "published",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: input.depegPipelineSucceeded ?? input.depegErrorCount === 0,
      },
    }),
  };
}

export function buildStablecoinsUnwrittenCacheResult(input: {
  cacheResult: CacheValidationResult;
  rawAssetCount: number;
  droppedMalformedAssets: number;
}): CronResult {
  if (!input.cacheResult.skippedBecauseNewer) {
    return input.cacheResult.blockedResult!;
  }
  return {
    itemCount: 0,
    metadata: buildSyncMetadata({
      rowsRead: input.rawAssetCount,
      rowsWritten: 0,
      rowsDropped: input.droppedMalformedAssets,
      sourceCoverage: { defillama: true },
      fallbackMode: null,
      validationFailures: 0,
      upstreamFetchOk: true,
      payloadAccepted: true,
      cacheWriteSucceeded: false,
      depegPipelineSucceeded: false,
      cacheKey: input.cacheResult.cacheKey,
      syncStartSec: input.cacheResult.syncStartSec,
    }, {
      cacheWriteMode: "skipped-newer",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: false,
      },
    }),
  };
}
