import { hasMissingPrice, type PeggedAsset } from "../enrich-prices";
import { buildSyncMetadata, type CronResult, type PriceSourceHealth } from "./shared";
import type { CanonicalDeduplicationResult } from "./stages";

const INDIVIDUAL_SOURCE_KEYS = new Set<string>([
  "coingecko", "defillama", "defillama-list", "protocol-redeem", "defillama-contract",
  "coinmarketcap", "dexscreener", "jupiter", "pyth", "binance", "kraken", "bitstamp", "coinbase",
  "redstone", "curve-onchain", "dex-promoted", "geckoterminal", "pool-tvl-weighted", "cached",
]);

function mapSourceToBucket(
  source: string,
  dist: PriceSourceHealth["sourceDistribution"],
): keyof PriceSourceHealth["sourceDistribution"] | null {
  if (source in dist) return source as keyof typeof dist;
  const firstSource = source.split("+")[0];
  if (firstSource in dist) return firstSource as keyof typeof dist;
  return null;
}

export function buildPriceSourceHealth(assets: PeggedAsset[]): PriceSourceHealth {
  const sourceDistribution: PriceSourceHealth["sourceDistribution"] = {
    "coingecko+defillama-list": 0,
    coingecko: 0,
    defillama: 0,
    "defillama-list": 0,
    "protocol-redeem": 0,
    "defillama-contract": 0,
    coinmarketcap: 0,
    dexscreener: 0,
    jupiter: 0,
    pyth: 0,
    binance: 0,
    kraken: 0,
    bitstamp: 0,
    coinbase: 0,
    redstone: 0,
    "curve-onchain": 0,
    "dex-promoted": 0,
    geckoterminal: 0,
    "pool-tvl-weighted": 0,
    cached: 0,
    missing: 0,
  };
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
        if (INDIVIDUAL_SOURCE_KEYS.has(src)) {
          sourceDistribution[src as keyof typeof sourceDistribution]++;
        }
      }
    } else {
      const source = asset.priceSource;
      const bucket = source ? mapSourceToBucket(source, sourceDistribution) : null;
      if (bucket) {
        sourceDistribution[bucket]++;
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
  rejectedCount: number;
  stalenessWarning: boolean;
  depegErrorCount: number;
  depegErrors: string[];
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
    priceValidation: input.priceValidationStats,
    rejectedPrices: input.rejectedCount,
    missingPrices: finalMissing,
    priceSourceHealth,
  };
  if (input.stalenessWarning) metadata.stalenessWarning = true;
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
        depegPipeline: input.depegErrorCount === 0,
      },
    }),
  };
}
