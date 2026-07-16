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
import type {
  PricingAssetAttemptRecord,
  PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";
import type { AuthoritativeLivePriceOverrideStats } from "../../lib/authoritative-price-sources";
import {
  compactStablecoinActivePriceCoverage,
  evaluateStablecoinActivePriceCoverage,
  evaluateStablecoinPublicationCoverage,
  type PreviousStablecoinActivePriceCoverage,
  type StablecoinPriceCoverageAsset,
  type StablecoinActivePriceCoverage,
} from "../../lib/stablecoin-publication-coverage";
import type { StablecoinPriceCoverageAlertResult } from "../../lib/stablecoin-publication-alerts";

const MAX_DIAGNOSTIC_ARRAY_ITEMS = 20;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 40;
const MAX_DIAGNOSTIC_STRING_CHARS = 500;
const MAX_DIAGNOSTIC_DEPTH = 4;
const MAX_STABLECOINS_CRON_METADATA_BYTES = 64 * 1024;
const MAX_PRICE_SOURCE_ATTEMPT_LEDGER_RECORDS = 100;

interface PriceSourceAttemptLedger {
  version: 1;
  missingActiveIds: string[];
  recordCount: number;
  truncated: number;
  records: PricingAssetAttemptRecord[];
}

type CompactPriceSourceAttempt = readonly [
  assetId: string,
  adapter: string,
  source: string,
  chain: string | null,
  target: string | null,
  outcome: string,
  rejectionClass: string | null,
  candidateAt: number | null,
  observedAt: number | null,
  replaySafe: boolean,
];

function buildPriceSourceAttemptLedger(input: {
  missingActiveIds: readonly string[];
  providerDiagnostics: readonly PricingProviderAttemptDiagnostic[];
  authoritativeOverrideStats?: AuthoritativeLivePriceOverrideStats;
}): PriceSourceAttemptLedger {
  const missingIds = new Set(input.missingActiveIds);
  const allAttempts = [
    ...(input.authoritativeOverrideStats?.assetAttempts ?? []),
    ...input.providerDiagnostics.flatMap((diagnostic) => diagnostic.assetAttempts ?? []),
  ].filter((attempt) => missingIds.has(attempt.assetId));
  const records = allAttempts.slice(0, MAX_PRICE_SOURCE_ATTEMPT_LEDGER_RECORDS);
  return {
    version: 1,
    missingActiveIds: [...input.missingActiveIds],
    recordCount: allAttempts.length,
    truncated: Math.max(0, allAttempts.length - records.length),
    records,
  };
}

function compactPriceSourceAttemptLedger(ledger: PriceSourceAttemptLedger): Omit<PriceSourceAttemptLedger, "records"> & {
  records: CompactPriceSourceAttempt[];
} {
  return {
    ...ledger,
    records: ledger.records.map((attempt) => [
      attempt.assetId,
      attempt.adapter,
      attempt.source,
      attempt.chain ?? null,
      attempt.target ?? null,
      attempt.state === "skipped"
        ? `skipped:${attempt.skipReason ?? "unknown"}`
        : attempt.result ?? "attempted",
      attempt.rejectionClass ?? null,
      attempt.candidateAt ?? null,
      attempt.observedAt ?? null,
      attempt.replaySafe,
    ]),
  };
}

function compactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length <= MAX_DIAGNOSTIC_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_DIAGNOSTIC_STRING_CHARS)}...`;
  }
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return "[truncated-depth]";
  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS)
      .map((entry) => compactDiagnosticValue(entry, depth + 1));
    if (value.length > MAX_DIAGNOSTIC_ARRAY_ITEMS) {
      compacted.push(`[${value.length - MAX_DIAGNOSTIC_ARRAY_ITEMS} more]`);
    }
    return compacted;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const compacted: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS)) {
      compacted[key] = compactDiagnosticValue(entry, depth + 1);
    }
    if (entries.length > MAX_DIAGNOSTIC_OBJECT_KEYS) {
      compacted.truncatedKeys = entries.length - MAX_DIAGNOSTIC_OBJECT_KEYS;
    }
    return compacted;
  }
  return String(value).slice(0, MAX_DIAGNOSTIC_STRING_CHARS);
}

function boundedIds(ids: readonly string[]): { ids: string[]; total: number; truncated: number } {
  return {
    ids: ids.slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS),
    total: ids.length,
    truncated: Math.max(0, ids.length - MAX_DIAGNOSTIC_ARRAY_ITEMS),
  };
}

function serializedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

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
  previousActivePriceCoverage?: PreviousStablecoinActivePriceCoverage | null;
  previousAcceptedAssetsById?: ReadonlyMap<string, StablecoinPriceCoverageAsset>;
  activePriceCoverage?: StablecoinActivePriceCoverage;
  activePriceCoverageAlert?: StablecoinPriceCoverageAlertResult;
}): CronResult {
  const finalMissing = input.assets.filter(hasMissingPrice).length;
  const priceSourceHealth = buildPriceSourceHealth(input.assets);
  const pricingSourceAuditReport = buildPricingSourceAuditReport(input.assets, input.providerDiagnostics ?? []);
  const publicationCoverage = evaluateStablecoinPublicationCoverage(
    input.assets.map((asset) => String(asset.id)),
    input.syncStartSec,
  );
  const activePriceCoverage = input.activePriceCoverage
    ?? evaluateStablecoinActivePriceCoverage(input.assets, undefined, {
      previousCoverage: input.previousActivePriceCoverage,
      previousAcceptedAssetsById: input.previousAcceptedAssetsById,
    });
  const priceSourceAttemptLedger = buildPriceSourceAttemptLedger({
    missingActiveIds: activePriceCoverage.missingActiveIds,
    providerDiagnostics: input.providerDiagnostics ?? [],
    authoritativeOverrideStats: input.authoritativeOverrideStats,
  });
  const status: CronResult["status"] =
    input.depegErrorCount > 0
      || input.stalenessCheckFailed
      || !publicationCoverage.complete
      || !activePriceCoverage.complete
      ? "degraded"
      : "ok";

  const metadata: Record<string, unknown> = {
    rowsRead: input.rawAssetCount,
    rowsWritten: input.assets.length,
    rowsDropped: input.droppedMalformedAssets,
    sourceCoverage: { defillama: true },
    fallbackMode: null,
    validationFailures: 0,
    canonicalDeduplication: {
      duplicateRows: input.canonicalDeduplication.duplicateRows,
      affectedIds: input.canonicalDeduplication.affectedIds.slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS),
      affectedIdsTruncated: Math.max(
        0,
        input.canonicalDeduplication.affectedIds.length - MAX_DIAGNOSTIC_ARRAY_ITEMS,
      ),
    },
    assetCount: input.assets.length,
    enrichment: compactDiagnosticValue(input.enrichStats),
    authoritativeOverrides: input.authoritativeOverrideCount ?? 0,
    authoritativeOverrideStats: compactDiagnosticValue(input.authoritativeOverrideStats),
    gtProbe: {
      updatedCount: input.gtProbe.updatedCount,
      ...compactDiagnosticValue(input.gtProbe.stats) as Record<string, unknown>,
    },
    priceValidation: compactDiagnosticValue(input.priceValidationStats),
    providerDiagnostics: compactDiagnosticValue(input.providerDiagnostics ?? []),
    rejectedPrices: input.rejectedCount,
    nativePegCorrections: input.nativePegCorrectionCount ?? 0,
    nativePegFills: input.nativePegFillCount ?? 0,
    missingPrices: finalMissing,
    priceSourceHealth,
    pricingSourceAuditReport: {
      ...pricingSourceAuditReport,
      assetsWithoutIndependentHardSource: boundedIds(
        pricingSourceAuditReport.assetsWithoutIndependentHardSource,
      ),
    },
    activePublicationCoverage: publicationCoverage,
    activePriceCoverage,
    activePriceCoverageAlert: input.activePriceCoverageAlert,
    priceSourceAttemptLedger,
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
      assets: compactDiagnosticValue(input.supplyGapReconciliation.assets),
    };
  }
  if (input.trackedCoverage && (input.trackedCoverage.restoredIds.length > 0 || input.trackedCoverage.droppedIds.length > 0)) {
    metadata.trackedCoverage = {
      restoredIds: boundedIds(input.trackedCoverage.restoredIds),
      droppedIds: boundedIds(input.trackedCoverage.droppedIds),
    };
  }
  if (input.depegErrorCount > 0) {
    metadata.depegErrorCount = input.depegErrorCount;
    metadata.depegErrors = compactDiagnosticValue(input.depegErrors);
  }

  const capabilities = {
    stablecoinsCache: publicationCoverage.complete,
    depegPipeline: input.depegPipelineSucceeded ?? input.depegErrorCount === 0,
  };
  let serializedMetadata = buildSyncMetadata(metadata, {
    cacheWriteMode: "published",
    capabilities,
  });
  if (serializedByteLength(serializedMetadata) >= MAX_STABLECOINS_CRON_METADATA_BYTES) {
    const compactedActivePriceCoverage = compactStablecoinActivePriceCoverage(
      activePriceCoverage,
      MAX_DIAGNOSTIC_ARRAY_ITEMS,
    );
    const compactedMetadata = {
      rowsRead: input.rawAssetCount,
      rowsWritten: input.assets.length,
      rowsDropped: input.droppedMalformedAssets,
      assetCount: input.assets.length,
      missingPrices: finalMissing,
      activePublicationCoverage: publicationCoverage,
      activePriceCoverage: compactedActivePriceCoverage,
      priceSourceAttemptLedger: compactPriceSourceAttemptLedger(priceSourceAttemptLedger),
      canonicalDeduplication: metadata.canonicalDeduplication,
      rejectedPrices: input.rejectedCount,
      nativePegCorrections: input.nativePegCorrectionCount ?? 0,
      nativePegFills: input.nativePegFillCount ?? 0,
      depegErrorCount: input.depegErrorCount,
      stalenessCheckFailed: input.stalenessCheckFailed,
      metadataCompactedBySizeGuard: true,
      originalMetadataBytes: serializedByteLength(serializedMetadata),
    };
    serializedMetadata = buildSyncMetadata(compactedMetadata, {
      cacheWriteMode: "published",
      capabilities,
    });
  }

  return {
    itemCount: input.assets.length,
    status,
    metadata: serializedMetadata,
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
