import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS, ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import {
  buildFallbackStablecoinsSyncResult,
  buildPricingSourceAuditReport,
  buildSizeGuardedStablecoinsSyncMetadata,
  buildStablecoinsSyncResult,
} from "../metadata";
import type { PricingAssetAttemptRecord } from "../../../lib/pricing-provider-diagnostics";
import {
  evaluateStablecoinActivePriceCoverage,
  evaluateStablecoinPublicationCoverage,
  loadPreviousStablecoinActivePriceCoverage,
  STABLECOIN_PRICE_GAP_REVIEWS,
} from "../../../lib/stablecoin-publication-coverage";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { PriceObservationEffectiveness } from "../price-corroboration-observations";
import type { PeggedAsset } from "../enrich-prices";
import { normalizeCronMetadataWithLease } from "../../../lib/cron-metadata";
import {
  compactCronMetadataForPersistence,
  MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES,
} from "../../../lib/cron-metadata-persistence";

function syncInput(
  assets: PeggedAsset[],
): Parameters<typeof buildStablecoinsSyncResult>[0] {
  return {
    assets,
    rawAssetCount: assets.length,
    droppedMalformedAssets: 0,
    canonicalDeduplication: { dedupedAssets: assets, duplicateRows: 0, affectedIds: [] },
    enrichStats: {},
    priceValidationStats: {},
    providerDiagnostics: [],
    rejectedCount: 0,
    stalenessWarning: false,
    stalenessCheckFailed: false,
    gtProbe: { stats: {} as never },
    depegErrorCount: 0,
    depegErrors: [],
    syncStartSec: 1_777_000_000,
  };
}

const observationEffectiveness: PriceObservationEffectiveness = {
  stagingStatus: "missing", stagingSlotStartedAt: null, stagingAgeSec: null,
  loadedObservationCount: null, eligibleObservationCount: 0,
  discarded: { sourceIneligible: 0, unknownTime: 0, futureTime: 0, sourceExpired: 0, superseded: 0 },
  publication: { alreadyPriced: 0, assetAbsent: 0, policyRejected: 0, selected: 0, notNeededAfterSelection: 0 },
  minimumFreshnessHeadroomSec: null,
};


function allMissingSizeGuardFixture(): {
  assets: PeggedAsset[];
  guard: Parameters<typeof buildSizeGuardedStablecoinsSyncMetadata>[0];
} {
  const assets = ACTIVE_STABLECOINS.map((stablecoin) => ({
    id: stablecoin.id,
    name: stablecoin.name,
    symbol: stablecoin.symbol,
    price: null,
    priceSource: "coingecko",
    priceObservedAt: 1_776_999_900,
    circulating: { peggedUSD: 1 },
  })) as PeggedAsset[];
  const activePriceCoverage = evaluateStablecoinActivePriceCoverage(assets);
  const ledgerRecords: PricingAssetAttemptRecord[] = ACTIVE_STABLECOINS.slice(0, 6).map(
    (stablecoin, index) => ({
      assetId: stablecoin.id,
      adapter: "coinmarketcap",
      source: "coinmarketcap",
      target: `slug:${stablecoin.id}`,
      state: "attempted",
      result: "rejected",
      rejectionClass: "stale",
      candidateAt: 1_777_000_000,
      observedAt: 1_776_900_000 + index,
      replaySafe: false,
    }),
  );
  return {
    assets,
    guard: {
      metadata: {
        rowsRead: assets.length,
        rowsWritten: assets.length,
        rowsDropped: 0,
        assetCount: assets.length,
        missingPrices: assets.length,
        canonicalDeduplication: { duplicateRows: 0, affectedIds: [], affectedIdsTruncated: 0 },
        rejectedPrices: 0,
        nativePegCorrections: 0,
        nativePegFills: 0,
        priceObservationEffectiveness: observationEffectiveness,
        depegErrorCount: 0,
        stalenessCheckFailed: false,
      },
      publicationCoverage: evaluateStablecoinPublicationCoverage(
        assets.map((asset) => asset.id),
        1_777_000_000,
      ),
      activePriceCoverage,
      priceSourceAttemptLedger: {
        version: 1 as const,
        missingActiveIds: activePriceCoverage.missingActiveIds,
        recordCount: ledgerRecords.length,
        truncated: 0,
        records: ledgerRecords,
      },
      capabilities: { stablecoinsCache: false, depegPipeline: true },
      originalMetadataBytes: 500_000,
    },
  };
}
// Measure the current catalog's retained ID/streak floor rather than pinning a
// byte budget that accidentally selects a different rung after coin additions.
function sizeGuardRungBudget(
  guard: Parameters<typeof buildSizeGuardedStablecoinsSyncMetadata>[0],
  detailCount: number,
  recordCount: number,
): number {
  const metadata = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, Infinity)) as {
    activePriceCoverage: { missingActiveAssets: unknown[]; missingActiveAssetsTruncated: number };
    priceSourceAttemptLedger: {
      missingActiveIds?: string[];
      missingActiveIdCount?: number;
      records: unknown[];
      truncated: number;
    };
  };
  metadata.activePriceCoverage.missingActiveAssets =
    metadata.activePriceCoverage.missingActiveAssets.slice(0, detailCount);
  metadata.activePriceCoverage.missingActiveAssetsTruncated =
    guard.activePriceCoverage.missingActiveAssets.length - detailCount;
  const ledger = metadata.priceSourceAttemptLedger;
  delete ledger.missingActiveIds;
  ledger.missingActiveIdCount = guard.priceSourceAttemptLedger.missingActiveIds.length;
  ledger.truncated += ledger.records.length - recordCount;
  ledger.records = ledger.records.slice(0, recordCount);
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength + 1;
}

describe("stablecoins pricing metadata", () => {
  it.each([false, true])("reports completed supply publication with bounded quality findings (quarantined=%s)", (quarantined) => {
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((asset) => ({
      id: asset.id, name: asset.name, symbol: asset.symbol, price: 1, priceSource: "coingecko",
      circulating: { peggedUSD: 1 },
    }));
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      supplyChainGuard: {
        flagged: 25, repaired: quarantined ? 0 : 25,
        quarantinedAssetIds: quarantined ? Array.from({ length: 25 }, (_, index) => `asset-${index}`) : [],
        unavailableAssetIds: quarantined ? ["asset-0"] : [],
        historyFetches: 8, stateReadFailed: false,
      },
    });
    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.supplyChainGuard).toMatchObject({
      flagged: 25, repaired: quarantined ? 0 : 25, historyFetches: 8,
      quarantinedAssetCount: quarantined ? 25 : 0,
      unavailableAssetCount: quarantined ? 1 : 0,
    });
    expect(metadata.supplyChainGuard.quarantinedAssetIds).toHaveLength(quarantined ? 20 : 0);
    expect(metadata.supplyChainGuard.state).toBeUndefined();
    expect(metadata.reason).toBeUndefined();
    expect(metadata.quality).toEqual(quarantined ? {
      reason: "supply-chain-dropout-quarantine", quarantinedAssetCount: 25, unavailableAssetCount: 1,
    } : undefined);
  });

  it.each([Infinity, 1])("retains supply quality findings through metadata compaction (budget=%s)", (budget) => {
    const { guard } = allMissingSizeGuardFixture();
    const quality = {
      reason: "supply-chain-dropout-quarantine", quarantinedAssetCount: 1, unavailableAssetCount: 1,
    };
    guard.metadata.quality = quality;
    const metadata = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, budget));
    expect(metadata.quality).toEqual(quality);
  });

  it.each(["kava-pricefeed", "mento-fpmm", "mento-broker", "protocol-redeem-cached-rate"])(
    "retains %s fallback observations in source health",
    (source) => {
      const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((asset) => ({
        id: asset.id, name: asset.name, symbol: asset.symbol,
        price: 1, priceSource: asset.id === "usdc-circle" ? source : "coingecko",
        priceConfidence: "high",
      }));
      const health = JSON.parse(buildStablecoinsSyncResult(syncInput(assets)).metadata!).priceSourceHealth;
      expect(health.sourceDistribution[source]).toBe(1);
      expect(health.sourceDistribution.missing).toBe(0);
      expect(Object.values(health.sourceDistribution).reduce<number>((sum, count) => sum + Number(count), 0)).toBe(assets.length);
    },
  );

  it("preserves observation effectiveness and unknown counts in both publication paths", () => {
    const main = buildStablecoinsSyncResult({ ...syncInput([]), priceObservationEffectiveness: observationEffectiveness });
    const metadata = JSON.parse(main.metadata!);
    const fallback = buildFallbackStablecoinsSyncResult({
      ...syncInput([]), providerDiagnostics: [], authoritativeOverrideCount: 0,
      cachedFallbackCount: 0, nativePegCorrectionCount: 0, nativePegFillCount: 0,
      cacheKey: "stablecoins", syncStartSec: 1_777_000_000,
      activePriceCoverage: metadata.activePriceCoverage,
      priceObservationEffectiveness: observationEffectiveness,
    });
    for (const result of [main, fallback]) {
      expect(JSON.parse(result.metadata!).priceObservationEffectiveness).toEqual(observationEffectiveness);
    }
    expect(JSON.parse(buildStablecoinsSyncResult(syncInput([])).metadata!).priceObservationEffectiveness).toBeUndefined();
  });

  it("separates active catalog health from untracked cache rows and counts absent active assets", () => {
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.filter((asset) => asset.id !== "usdc-circle").map((asset) => ({
      id: asset.id, name: asset.name, symbol: asset.symbol,
      price: asset.id === "usdt-tether" ? null : 1,
      priceSource: asset.id === "usdt-tether" ? "missing" : "coingecko",
      priceConfidence: "high",
    }));
    assets.push(...["upstream-only-a", "upstream-only-b"].map((id) => ({ id, name: id, symbol: "OTHER", price: null, priceSource: "missing" })));
    const result = buildStablecoinsSyncResult(syncInput(assets));
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.priceSourceHealth).toMatchObject({ totalAssets: ACTIVE_IDS.size + 1, sourceDistribution: { missing: 3 },
      confidenceDistribution: { high: ACTIVE_IDS.size - 2 }, active: { totalAssets: ACTIVE_IDS.size,
        sourceDistribution: { missing: 2 }, confidenceDistribution: { high: ACTIVE_IDS.size - 2 } } });
  });

  it("weights active confidence by circulating value and acknowledges reviewed price gaps", () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide");
    expect(review).toBeDefined();
    const nowSec = review!.reviewedAt + Math.floor((review!.expiresAt - review!.reviewedAt) / 2);
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((asset): PeggedAsset => {
      const circulating: Record<string, number> =
        asset.id === "usdt-tether" ? { peggedUSD: 300_000_000_000 }
          : asset.id === "eurc-circle" ? { peggedEUR: 3_000_000_000 }
            : asset.id === "usdy-ondo-finance" ? { peggedUSD: 2_000_000_000 }
              : { peggedUSD: 0 };
      if (asset.id === "wusd-worldwide") {
        return { id: asset.id, name: asset.name, symbol: asset.symbol, price: null, priceSource: "missing", priceConfidence: null, circulating };
      }
      if (asset.id === "usdy-ondo-finance") {
        return { id: asset.id, name: asset.name, symbol: asset.symbol, price: 1, priceSource: "redstone", priceConfidence: "single-source", circulating };
      }
      return { id: asset.id, name: asset.name, symbol: asset.symbol, price: 1, priceSource: "coingecko", priceConfidence: "high", circulating };
    });
    const result = buildStablecoinsSyncResult({ ...syncInput(assets), syncStartSec: nowSec });
    const active = JSON.parse(result.metadata!).priceSourceHealth.active;
    expect(active).toMatchObject({
      totalAssets: ACTIVE_IDS.size,
      confidenceDistribution: { high: ACTIVE_IDS.size - 2, "single-source": 1, low: 0, fallback: 0 },
      confidenceMarketCapUsd: { high: 303_000_000_000, "single-source": 2_000_000_000, low: 0, fallback: 0 },
      pricedMarketCapUsd: 305_000_000_000,
      // The reviewed gap stays a raw missing row but is acknowledged.
      acknowledgedMissingCount: 1,
    });
    expect(active.sourceDistribution.missing).toBe(1);
  });

  it("re-alerts a reviewed price gap once its review window has expired", () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide");
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((asset) => ({
      id: asset.id, name: asset.name, symbol: asset.symbol,
      price: asset.id === "wusd-worldwide" ? null : 1,
      priceSource: asset.id === "wusd-worldwide" ? "missing" : "coingecko",
      priceConfidence: asset.id === "wusd-worldwide" ? null : "high" as const,
    }));
    const result = buildStablecoinsSyncResult({ ...syncInput(assets), syncStartSec: review!.expiresAt + 1 });
    expect(JSON.parse(result.metadata!).priceSourceHealth.active.acknowledgedMissingCount).toBe(0);
  });

  it("summarizes weak source coverage and provider rejection counts", () => {
    const assets: PeggedAsset[] = [
      {
        id: "hard",
        name: "Hard USD",
        symbol: "HARD",
        price: 1,
        priceSource: "pyth",
        priceConfidence: "high",
        agreeSources: ["pyth", "binance"],
      },
      {
        id: "search",
        name: "Search USD",
        symbol: "SEARCH",
        price: 1,
        priceSource: "dexscreener-search",
        priceConfidence: "fallback",
      },
      {
        id: "cached",
        name: "Cached USD",
        symbol: "CACHED",
        price: 1,
        priceSource: "cached",
        priceConfidence: "fallback",
      },
      {
        id: "missing",
        name: "Missing USD",
        symbol: "MISS",
        price: 0,
      },
      {
        id: "low",
        name: "Low USD",
        symbol: "LOW",
        price: 1,
        priceSource: "coingecko",
        priceConfidence: "low",
      },
    ];

    const report = buildPricingSourceAuditReport(assets, [
      {
        source: "dexscreener-search",
        stage: "fallback",
        endpoint: "api.dexscreener.com/latest/dex/search",
        status: 200,
        ok: true,
        success: false,
        rejectionReasonCounts: { "price-rejected": 2 },
      },
      {
        source: "native-peg",
        stage: "fallback",
        endpoint: "api.coingecko.com/api/v3/simple/price",
        status: 200,
        ok: true,
        success: false,
        rejectionReasonCounts: { stale: 1 },
      },
    ]);

    expect(report).toMatchObject({
      missingPriceCount: 1,
      fallbackOrCachedCount: 2,
      lowConfidenceCount: 1,
      providerRejectionCounts: {
        "price-rejected": 2,
        stale: 1,
      },
      providerFailuresBySource: {
        "dexscreener-search": 1,
        "native-peg": 1,
      },
    });
    expect(report.assetsWithoutIndependentHardSource).toEqual(["cached", "low", "search"]);
  });

  it("keeps health evidence intact after scheduler metadata enrichment", () => {
    const sentinel = "full-asset-payload-must-not-be-persisted";
    const diagnosticFields = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`diagnostic${index}`, "x".repeat(500)]),
    );
    const assets = ACTIVE_STABLECOINS.map((stablecoin) => ({
      id: stablecoin.id,
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      price: 1,
      priceSource: "defillama-list",
      priceConfidence: "single-source" as const,
      circulating: { peggedUSD: 1 },
      diagnosticSentinel: sentinel,
    })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      assets,
      rawAssetCount: assets.length,
      droppedMalformedAssets: 0,
      canonicalDeduplication: {
        dedupedAssets: assets,
        duplicateRows: 1,
        affectedIds: assets.map((asset) => asset.id),
      },
      enrichStats: diagnosticFields(36),
      priceValidationStats: { rejected: [] },
      providerDiagnostics: (["binance", "kraken"] as const).map((source) => ({
        source,
        stage: "primary" as const,
        endpoint: `${source}.example.com`,
        status: 200,
        ok: true,
        success: true,
        ...diagnosticFields(40),
      })),
      rejectedCount: 0,
      stalenessWarning: false,
      stalenessCheckFailed: false,
      gtProbe: { stats: {} as never },
      depegErrorCount: 0,
      depegErrors: [],
      syncStartSec: 1_777_000_000,
    });

    expect(new TextEncoder().encode(result.metadata ?? "").byteLength).toBeLessThan(
      MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES,
    );
    expect(result.metadata).not.toContain(sentinel);
    const enrichedMetadata = normalizeCronMetadataWithLease(result, {
      leaseOwner: "sync-stablecoins:scheduled:00000000-0000-4000-8000-000000000000",
      renewFailures: 0,
      leaseLost: false,
      leaseTtlSec: 600,
      leaseHeartbeatSec: 30,
      leaseMaxRenewFailures: 3,
      leaseRenewAttempts: 4,
      leaseRenewSuccesses: 4,
      leaseRenewFailuresTotal: 0,
      leaseLastRenewedAt: 1_777_000_120,
      slotStartedAt: 1_777_000_000,
      scheduleKey: "*/15 * * * *",
      producerPath: "worker/src/cron/sync-stablecoins/index.ts",
      invocationId: "00000000-0000-4000-8000-000000000001",
      workerVersion: "test-version",
      attemptNo: 1,
      producerKind: "scheduled",
    });
    const persisted = compactCronMetadataForPersistence(enrichedMetadata);

    expect(persisted.compacted).toBe(false);
    const metadata = JSON.parse(persisted.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.metadataCompactedBySizeGuard).toBe(true);
    expect(metadata.canonicalDeduplication).not.toHaveProperty("dedupedAssets");
    expect(metadata.activePublicationCoverage).toMatchObject({ complete: true });
    expect(metadata.activePriceCoverage).toMatchObject({
      complete: true,
      pricedActiveCount: ACTIVE_STABLECOINS.length,
      missingPriceCount: 0,
    });
  });

  it("reports missing active prices without downgrading a complete row publication", () => {
    const missingId = ACTIVE_STABLECOINS[0]!.id;
    const assets = ACTIVE_STABLECOINS.map((stablecoin) => ({
      id: stablecoin.id,
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      price: stablecoin.id === missingId ? null : 1,
      priceSource: stablecoin.id === missingId ? "coingecko" : "defillama-list",
      priceConfidence: "single-source" as const,
      priceObservedAt: 1_776_999_900,
      circulating: { peggedUSD: stablecoin.id === missingId ? 125_500 : 1 },
    })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      previousActivePriceCoverage: {
        missingActiveIds: [missingId],
        missingActiveAssets: [{
          stablecoinId: missingId,
          symbol: ACTIVE_STABLECOINS[0]!.symbol,
          marketCapUsd: 125_500,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: 1,
          lastAcceptedPrice: 1.002,
          lastAcceptedSource: "pyth",
          lastAcceptedObservedAt: 1_776_999_000,
          rejectionReason: "no-accepted-price",
          alertEligible: false,
        }],
      },
      previousAcceptedAssetsById: new Map([[
        missingId,
        { id: missingId, symbol: ACTIVE_STABLECOINS[0]!.symbol, price: null },
      ]]),
    });

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      activePublicationCoverage: { complete: boolean };
      activePriceCoverage: {
        complete: boolean;
        missingActiveIds: string[];
        affectedMarketCapUsd: number;
        alertEligibleIds: string[];
        missingActiveAssets: Array<Record<string, unknown>>;
      };
      capabilities: { stablecoinsCache: boolean };
    };
    expect(result.status).toBe("ok");
    expect(metadata.activePublicationCoverage.complete).toBe(true);
    expect(metadata.capabilities.stablecoinsCache).toBe(true);
    expect(metadata.activePriceCoverage).toMatchObject({
      complete: false,
      missingActiveIds: [missingId],
      affectedMarketCapUsd: 125_500,
      alertEligibleIds: [missingId],
    });
    expect(metadata.activePriceCoverage.missingActiveAssets[0]).toMatchObject({
      symbol: ACTIVE_STABLECOINS[0]!.symbol,
      consecutiveMissingGenerations: 2,
      lastAcceptedPrice: 1.002,
      lastAcceptedSource: "pyth",
      lastAcceptedObservedAt: 1_776_999_000,
      rejectionReason: "no-accepted-price",
      alertEligible: true,
    });
  });

  it("compacts all-asset gap state below the cron metadata limit without losing streak state", () => {
    const assets = ACTIVE_STABLECOINS.map((stablecoin) => ({
      id: stablecoin.id,
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      price: null,
      circulating: { peggedUSD: 1 },
    })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      previousAcceptedAssetsById: new Map(assets.map((asset) => [
        asset.id,
        {
          id: asset.id,
          symbol: asset.symbol,
          price: 1,
          priceSource: "coingecko",
          priceObservedAt: 1_776_999_000,
        },
      ])),
    });

    expect(new TextEncoder().encode(result.metadata ?? "").byteLength)
      .toBeLessThan(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      activePriceCoverage: {
        missingActiveAssets: unknown[];
        missingActiveAssetsTruncated: number;
        missingActiveState: unknown[];
      };
    };
    expect(metadata.activePriceCoverage.missingActiveAssets).toHaveLength(20);
    expect(metadata.activePriceCoverage.missingActiveAssetsTruncated).toBe(ACTIVE_STABLECOINS.length - 20);
    expect(metadata.activePriceCoverage.missingActiveState).toHaveLength(ACTIVE_STABLECOINS.length);
  });

  it("retains missing-asset source attempts when the metadata size guard compacts diagnostics", () => {
    const missingId = ACTIVE_STABLECOINS[0]!.id;
    const assets = ACTIVE_STABLECOINS.map((stablecoin) => ({
      id: stablecoin.id,
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      price: null,
      circulating: { peggedUSD: 1 },
    })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      priceObservationEffectiveness: observationEffectiveness,
      providerDiagnostics: [{
        source: "coinmarketcap",
        stage: "fallback",
        endpoint: "pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest",
        status: 200,
        ok: true,
        success: false,
        assetAttempts: [{
          assetId: missingId,
          adapter: "coinmarketcap",
          source: "coinmarketcap",
          target: "slug:missing",
          state: "attempted",
          result: "rejected",
          rejectionClass: "stale",
          candidateAt: 1_777_000_000,
          observedAt: 1_776_900_000,
          replaySafe: false,
        }],
      }],
      previousAcceptedAssetsById: new Map(assets.map((asset) => [
        asset.id,
        {
          id: asset.id,
          symbol: asset.symbol,
          price: 1,
          priceSource: "intentionally-overlong-source-".repeat(20),
          priceObservedAt: 1_776_999_000,
        },
      ])),
    });

    expect(new TextEncoder().encode(result.metadata ?? "").byteLength)
      .toBeLessThan(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      activePriceCoverage: { missingActiveIds: string[] };
      priceObservationEffectiveness: PriceObservationEffectiveness;
      metadataCompactedBySizeGuard: boolean;
      priceSourceAttemptLedger: { missingActiveIdCount: number; records: unknown[][] };
    };
    expect(metadata.metadataCompactedBySizeGuard).toBe(true);
    expect(metadata.priceObservationEffectiveness).toEqual(observationEffectiveness);
    // The guard drops the ledger's duplicate ID list before any attempt
    // records: the exact missing set survives one key up in coverage.
    expect(metadata.activePriceCoverage.missingActiveIds).toContain(missingId);
    expect(metadata.priceSourceAttemptLedger.missingActiveIdCount).toBe(ACTIVE_STABLECOINS.length);
    expect(metadata.priceSourceAttemptLedger.records).toContainEqual([
      missingId,
      "coinmarketcap",
      "coinmarketcap",
      null,
      "slug:missing",
      "rejected",
      "stale",
      1_777_000_000,
      1_776_900_000,
      false,
    ]);
  });

  it("degrades size-guarded metadata through bounded rungs and fails closed when no rung fits", () => {
    const { guard } = allMissingSizeGuardFixture();

    // A mid-ladder budget sheds verbose gap details but keeps the exact ID
    // sets, the full compact streak state, and every attempt record.
    const midBudgetBytes = sizeGuardRungBudget(guard, 10, 6);
    const midBudget = buildSizeGuardedStablecoinsSyncMetadata(guard, midBudgetBytes);
    expect(new TextEncoder().encode(midBudget).byteLength).toBeLessThan(midBudgetBytes);
    const mid = JSON.parse(midBudget) as {
      metadataCompactedBySizeGuard: boolean;
      activePriceCoverage: { missingActiveState: unknown[]; missingActiveIds: string[]; missingActiveAssets: unknown[] };
      priceSourceAttemptLedger: { records: unknown[][] };
    };
    expect(mid.metadataCompactedBySizeGuard).toBe(true);
    expect(mid.activePriceCoverage.missingActiveIds).toHaveLength(ACTIVE_STABLECOINS.length);
    expect(mid.activePriceCoverage.missingActiveState).toHaveLength(ACTIVE_STABLECOINS.length);
    expect(mid.activePriceCoverage.missingActiveAssets).toHaveLength(10);
    expect(mid.priceSourceAttemptLedger.records).toHaveLength(6);

    // No rung can satisfy an impossible budget: the guard fails closed with
    // bounded scalars instead of an oversized payload.
    const terminalBudget = buildSizeGuardedStablecoinsSyncMetadata(guard, 2_000);
    expect(new TextEncoder().encode(terminalBudget).byteLength).toBeLessThan(2_000);
    const terminal = JSON.parse(terminalBudget) as Record<string, unknown> & {
      metadataCompactedBySizeGuard: boolean;
      sizeGuardEvidenceDropped: boolean;
    };
    expect(terminal.metadataCompactedBySizeGuard).toBe(true);
    expect(terminal.sizeGuardEvidenceDropped).toBe(true);
    expect(terminal).not.toHaveProperty("priceSourceAttemptLedger");
    expect(terminal.activePriceCoverage).not.toHaveProperty("missingActiveIds");
  });

  it("treats terminal size-guard payloads as unavailable continuity and preserves streaks across late rungs", async () => {
    const { assets, guard } = allMissingSizeGuardFixture();

    // A terminal envelope persisted as the previous run's cron metadata is
    // reported as malformed continuity — unavailable, never a healthy empty
    // missing set that would silently restart every streak.
    const terminalMetadata = buildSizeGuardedStablecoinsSyncMetadata(guard, 2_000);
    const terminalPrior = await loadPreviousStablecoinActivePriceCoverage(
      mockD1([{ match: "activePriceCoverage", rows: [], first: { metadata: terminalMetadata } }]),
      1_777_000_000,
    );
    expect(terminalPrior).toMatchObject({ status: "read-error", reason: "previous-coverage-malformed" });

    // A late rung that drops every verbose gap detail still round-trips: the
    // loader restores the full missing set with its streak state, and the next
    // generation builds on those streaks instead of restarting them.
    const lateRungMetadata = buildSizeGuardedStablecoinsSyncMetadata(guard, sizeGuardRungBudget(guard, 0, 0));
    const lateRung = JSON.parse(lateRungMetadata) as {
      activePriceCoverage: { missingActiveAssets: unknown[]; missingActiveAssetsTruncated: number };
    };
    expect(lateRung.activePriceCoverage.missingActiveAssets).toHaveLength(0);
    expect(lateRung.activePriceCoverage.missingActiveAssetsTruncated).toBe(ACTIVE_STABLECOINS.length);
    const prior = await loadPreviousStablecoinActivePriceCoverage(
      mockD1([{ match: "activePriceCoverage", rows: [], first: { metadata: lateRungMetadata } }]),
      1_777_000_000,
    );
    expect(prior.status).toBe("ok");
    if (prior.status !== "ok") throw new Error("Expected readable late-rung continuity");
    expect(prior.coverage.missingActiveIds).toHaveLength(ACTIVE_STABLECOINS.length);
    expect(prior.coverage.missingActiveAssets).toHaveLength(ACTIVE_STABLECOINS.length);
    const nextGeneration = evaluateStablecoinActivePriceCoverage(assets, undefined, {
      previousCoverage: prior.coverage,
    });
    expect(nextGeneration.maxConsecutiveMissingGenerations).toBe(2);
    expect(nextGeneration.missingActiveAssets.every(
      (detail) => detail.consecutiveMissingGenerations === 2,
    )).toBe(true);
  });
});
