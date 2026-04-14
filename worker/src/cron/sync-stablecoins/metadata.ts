import { hasMissingPrice, type PeggedAsset } from "./enrich-prices";
import { buildSyncMetadata, type CronResult, type PriceSourceHealth } from "./shared";
import type { CanonicalDeduplicationResult } from "./phase-helpers";
import type { GtProbeStats } from "../../lib/geckoterminal-price-probe";
import {
  createEmptyPriceSourceHealthDistribution,
  isPriceSourceHealthBucketKey,
  splitCompositePriceSource,
} from "@shared/lib/pricing-sources";
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
  depegPipelineSucceeded?: boolean;
}): CronResult {
  const finalMissing = input.assets.filter(hasMissingPrice).length;
  const priceSourceHealth = buildPriceSourceHealth(input.assets);
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
    upstreamFetchOk: input.upstreamFetchOk ?? true,
    payloadAccepted: input.payloadAccepted ?? true,
    cacheWriteSucceeded: input.cacheWriteSucceeded ?? true,
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
      cacheWriteMode: "main-write",
      capabilities: {
        stablecoinsCache: true,
        depegPipeline: input.depegPipelineSucceeded ?? input.depegErrorCount === 0,
      },
    }),
  };
}
