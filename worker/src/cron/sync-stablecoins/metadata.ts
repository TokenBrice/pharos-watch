import { hasMissingPrice, type PeggedAsset } from "./enrich-prices";
import { buildSyncMetadata, type CronResult, type PriceSourceHealth, type TrackedCoverageRestoreResult } from "./shared";
import type { CacheValidationResult } from "./cache-publication";
import type { CanonicalDeduplicationResult } from "./phase-helpers";
import type { SupplyGapReconciliationResult } from "./supply-gap-reconciliation";
import type { GtProbeStats } from "../../lib/geckoterminal-price-probe";
import {
  createEmptyPriceSourceHealthDistribution,
  isPriceSourceHealthBucketKey,
  normalizePricingSourceKeys,
  splitCompositePriceSource,
} from "@shared/lib/pricing-sources";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { AuthoritativeLivePriceOverrideStats } from "../../lib/authoritative-price-sources";

function mapSourceToBucket(source: string) {
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
        const bucket = mapSourceToBucket(src);
        if (bucket) {
          sourceDistribution[bucket]++;
        }
      }
    } else {
      const source = asset.priceSource;
      if (source) {
        const exactBucket = mapSourceToBucket(source);
        if (exactBucket) {
          sourceDistribution[exactBucket]++;
        } else {
          for (const part of splitCompositePriceSource(source)) {
            const partBucket = mapSourceToBucket(part);
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

interface CachePublicationMetadataBase {
  rowsRead: number;
  rowsDropped: number;
  sourceCoverage: Record<string, unknown>;
  fallbackMode: string | null;
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
  authoritativeOverrideStats?: AuthoritativeLivePriceOverrideStats;
  rejectedCount: number;
  nativePegCorrectionCount?: number;
  nativePegFillCount?: number;
  stalenessWarning: boolean;
  stalenessSummary?: { compared: number; identical: number; identicalRatio: number } | null;
  stalenessCheckFailed: boolean;
  stalenessCheckFailureReason?: string;
  supplyGapReconciliation?: SupplyGapReconciliationResult | null;
  trackedCoverage?: TrackedCoverageRestoreResult | null;
  gtProbe: { updatedCount: number; stats: GtProbeStats };
  depegErrorCount: number;
  depegErrors: string[];
  upstreamFetchOk?: boolean;
  payloadAccepted?: boolean;
  cacheWriteSucceeded?: boolean;
  cacheKey?: string;
  syncStartSec?: number;
  responseReadyCacheError?: string | null;
  depegPipelineSucceeded?: boolean;
}): CronResult {
  const finalMissing = input.assets.filter(hasMissingPrice).length;
  const priceSourceHealth = buildPriceSourceHealth(input.assets);
  const pricingSourceAuditReport = buildPricingSourceAuditReport(input.assets, input.providerDiagnostics ?? []);
  const status: CronResult["status"] = input.depegErrorCount > 0 || input.stalenessCheckFailed ? "degraded" : "ok";

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
    authoritativeOverrideStats: input.authoritativeOverrideStats,
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
    stalenessCheckFailed: input.stalenessCheckFailed,
  };
  if (input.stalenessWarning) metadata.stalenessWarning = true;
  if (input.stalenessCheckFailureReason) {
    metadata.stalenessCheckFailureReason = input.stalenessCheckFailureReason;
  }
  if (input.responseReadyCacheError) {
    metadata.responseReadyCacheError = input.responseReadyCacheError;
  }
  if (input.stalenessSummary) metadata.priceStaleness = input.stalenessSummary;
  if (input.supplyGapReconciliation && input.supplyGapReconciliation.totalReconciled > 0) {
    metadata.supplyGapReconciliation = {
      totalReconciled: input.supplyGapReconciliation.totalReconciled,
      byReason: input.supplyGapReconciliation.byReason,
      assets: input.supplyGapReconciliation.assets,
    };
  }
  if (input.trackedCoverage && (input.trackedCoverage.restoredIds.length > 0 || input.trackedCoverage.droppedIds.length > 0)) {
    metadata.trackedCoverage = {
      restoredIds: input.trackedCoverage.restoredIds,
      droppedIds: input.trackedCoverage.droppedIds,
    };
  }
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

export function buildBlockedInvalidPayloadResult(input: CachePublicationMetadataBase & {
  itemCount: number;
  validationContext: "main" | "fallback";
  stablecoinsCacheAgeSec: number | null;
}): CronResult {
  return {
    status: "degraded",
    itemCount: input.itemCount,
    metadata: buildSyncMetadata({
      rowsRead: input.rowsRead,
      rowsWritten: 0,
      rowsDropped: input.rowsDropped,
      sourceCoverage: input.sourceCoverage,
      fallbackMode: input.fallbackMode,
      validationFailures: 1,
      validationContext: input.validationContext,
      stablecoinsCacheAgeSec: input.stablecoinsCacheAgeSec,
      cacheWriteMode: "blocked-invalid-payload",
    }, {
      cacheWriteMode: "blocked-invalid-payload",
      capabilities: {
        stablecoinsCache: false,
        depegPipeline: false,
      },
    }),
  };
}

export function buildSkippedNewerCacheResult(input: CachePublicationMetadataBase & {
  cacheKey: string;
  syncStartSec: number;
  upstreamFetchOk?: boolean;
}): CronResult {
  return {
    itemCount: 0,
    metadata: buildSyncMetadata({
      rowsRead: input.rowsRead,
      rowsWritten: 0,
      rowsDropped: input.rowsDropped,
      sourceCoverage: input.sourceCoverage,
      fallbackMode: input.fallbackMode,
      validationFailures: 0,
      upstreamFetchOk: input.upstreamFetchOk ?? false,
      payloadAccepted: true,
      cacheWriteSucceeded: false,
      depegPipelineSucceeded: false,
      cacheKey: input.cacheKey,
      syncStartSec: input.syncStartSec,
    }, {
      cacheWriteMode: "skipped-newer",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: false,
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
  return buildSkippedNewerCacheResult({
    rowsRead: input.rawAssetCount,
    rowsDropped: input.droppedMalformedAssets,
    sourceCoverage: { defillama: true },
    fallbackMode: null,
    cacheKey: input.cacheResult.cacheKey,
    syncStartSec: input.cacheResult.syncStartSec,
    upstreamFetchOk: true,
  });
}
