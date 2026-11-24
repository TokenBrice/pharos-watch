import { sampleDepegDeadBandNotices } from "../../detect-depegs";
import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS, ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import {
  buildFallbackStablecoinsSyncResult,
  buildSizeGuardedStablecoinsSyncMetadata,
  buildStablecoinsSyncResult,
} from "../metadata";
import type { PricingAssetAttemptRecord } from "../../../lib/pricing-provider-diagnostics";
import { createEmptyGtProbeStats } from "../../../lib/geckoterminal-price-probe-stats";
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
import { fetchHiveNativeHbdPrice } from "../../../lib/hive-market-price";

it.each([false, true])("preserves bounded native evidence for successful and unavailable attempts (success=%s)", async (success) => {
  const { diagnostic } = await fetchHiveNativeHbdPrice(undefined, { generation: 1_777_000_000 });
  if (success) {
    diagnostic.rejectionReason = null;
    diagnostic.price = 0.98662;
    diagnostic.parent = { id: "hive", source: "coingecko", price: 0.04872914, observedAt: 1_776_999_996, ageSec: 4 };
  }
  const result = buildStablecoinsSyncResult({
    ...syncInput(ACTIVE_STABLECOINS.map((coin) => ({
      ...identity(coin), price: coin.id === "hbd-hive" ? diagnostic.price : 1,
    }))),
    providerDiagnostics: [{ source: "hive-native-cg", stage: "primary", endpoint: "api.hive.blog",
      status: null, ok: true, success, nativeMarket: diagnostic }],
  });
  const metadata = JSON.parse(result.metadata!);
  expect(metadata.providerDiagnostics[0].nativeMarket).toEqual(diagnostic);
  expect(metadata.nativeMarket).toEqual(diagnostic);
  expect(metadata.nativeMarket.bidDepthHbd).toBeNull();
  expect(metadata.nativeMarket.policy.parentMaxAgeSec).toBe(300);
  expect(metadata.nativeMarket.generation).toBe(1_777_000_000);
  expect(metadata.nativeMarket).not.toHaveProperty("bids");
  const { guard } = allMissingSizeGuardFixture();
  guard.metadata.nativeMarket = diagnostic;
  const compact = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard));
  expect(compact.nativeMarket).toEqual(diagnostic);
  const terminal = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, 2000));
  expect(terminal.nativeMarket).toEqual({ evidenceOmitted: true, reason: "metadata-size-guard" });
});

const identity = ({ id, name, symbol }: Pick<PeggedAsset, "id" | "name" | "symbol">) => ({ id, name, symbol });
const pricedAssets = (): PeggedAsset[] => ACTIVE_STABLECOINS.map((asset) => ({
  ...identity(asset), price: 1, priceSource: "coingecko", circulating: { peggedUSD: 1 },
}));

function syncInput(assets: PeggedAsset[]): Parameters<typeof buildStablecoinsSyncResult>[0] {
  return {
    assets, rawAssetCount: assets.length, droppedMalformedAssets: 0,
    canonicalDeduplication: { duplicateRows: 0, affectedIds: [] }, enrichStats: {}, priceValidationStats: {},
    providerDiagnostics: [], rejectedCount: 0, stalenessWarning: false, stalenessCheckFailed: false,
    gtProbe: { stats: {} as never }, depegErrorCount: 0, depegErrors: [], syncStartSec: 1_777_000_000,
  };
}

const observationEffectiveness: PriceObservationEffectiveness = {
  stagingStatus: "missing", stagingSlotStartedAt: null, stagingAgeSec: null,
  loadedObservationCount: null, eligibleObservationCount: 0,
  discarded: { sourceIneligible: 0, unknownTime: 0, futureTime: 0, sourceExpired: 0, superseded: 0 },
  publication: { alreadyPriced: 0, assetAbsent: 0, policyRejected: 0, selected: 0, notNeededAfterSelection: 0 },
  minimumFreshnessHeadroomSec: null,
};

function allMissingSizeGuardFixture(): { assets: PeggedAsset[]; guard: Parameters<typeof buildSizeGuardedStablecoinsSyncMetadata>[0] } {
  const assets = ACTIVE_STABLECOINS.map((c) => ({ ...identity(c), price: null, priceSource: "coingecko", priceObservedAt: 1_776_999_900, circulating: { peggedUSD: 1 } })) as PeggedAsset[];
  const activePriceCoverage = evaluateStablecoinActivePriceCoverage(assets);
  const ledgerRecords: PricingAssetAttemptRecord[] = ACTIVE_STABLECOINS.slice(0, 6).map((c, i) => ({
    assetId: c.id, adapter: "coinmarketcap", source: "coinmarketcap", target: `slug:${c.id}`, state: "attempted",
    result: "rejected", rejectionClass: "stale", candidateAt: 1_777_000_000, observedAt: 1_776_900_000 + i, replaySafe: false,
  }));
  return {
    assets,
    guard: {
      metadata: {
        rowsRead: assets.length, rowsWritten: assets.length, rowsDropped: 0, assetCount: assets.length, missingPrices: assets.length,
        canonicalDeduplication: { duplicateRows: 0, affectedIds: [], affectedIdsTruncated: 0 }, rejectedPrices: 0, priceObservationEffectiveness: observationEffectiveness, depegErrorCount: 0, stalenessCheckFailed: false,
      },
      publicationCoverage: evaluateStablecoinPublicationCoverage(assets.map((a) => a.id), 1_777_000_000),
      activePriceCoverage,
      priceSourceAttemptLedger: { version: 1 as const, missingActiveIds: activePriceCoverage.missingActiveIds, recordCount: ledgerRecords.length, truncated: 0, records: ledgerRecords },
      capabilities: { stablecoinsCache: false, depegPipeline: true }, originalMetadataBytes: 500_000,
    },
  };
}

function sizeGuardRungBudget(guard: Parameters<typeof buildSizeGuardedStablecoinsSyncMetadata>[0], detailCount: number, recordCount: number): number {
  const metadata = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, Infinity)) as {
    activePriceCoverage: { missingActiveAssets: unknown[]; missingActiveAssetsTruncated: number };
    priceSourceAttemptLedger: { missingActiveIds?: string[]; missingActiveIdCount?: number; records: unknown[]; truncated: number };
  };
  metadata.activePriceCoverage.missingActiveAssets = metadata.activePriceCoverage.missingActiveAssets.slice(0, detailCount);
  metadata.activePriceCoverage.missingActiveAssetsTruncated = guard.activePriceCoverage.missingActiveAssets.length - detailCount;
  const ledger = metadata.priceSourceAttemptLedger;
  delete ledger.missingActiveIds;
  ledger.missingActiveIdCount = guard.priceSourceAttemptLedger.missingActiveIds.length;
  ledger.truncated += ledger.records.length - recordCount;
  ledger.records = ledger.records.slice(0, recordCount);
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength + 1;
}

describe("stablecoins pricing metadata", () => {
  it.each(["main", "fallback"] as const)("keeps preferred native supply findings as bounded quality on the %s path", (path) => {
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((coin): PeggedAsset => ({
      ...identity(coin), price: 1,
      circulating: coin.id === "usyc-hashnote" || coin.id === "sfrax-frax" ? {} : { peggedUSD: coin.id === "myrc-blox" ? 0 : 1 },
      supplySource: coin.id === "usyc-hashnote" || coin.id === "sfrax-frax" ? "onchain-supply-withheld" : coin.id === "eurc-circle" ? "onchain-circulating-supply" : "onchain-total-supply",
      ...(coin.id === "myrc-blox" || coin.id === "eurc-circle" ? { supplyRestored: true } : {}),
    }));
    const input = { ...syncInput(assets), providerDiagnostics: [], cacheKey: "stablecoins", syncStartSec: 1_777_000_000, authoritativeOverrideCount: 0, cachedFallbackCount: 0, activePriceCoverage: evaluateStablecoinActivePriceCoverage(assets) };
    const build = (stalenessCheckFailed: boolean) => path === "main" ? buildStablecoinsSyncResult({ ...input, stalenessCheckFailed }) : buildFallbackStablecoinsSyncResult({ ...input, stalenessCheckFailed });
    const result = build(false);
    const metadata = JSON.parse(result.metadata!);
    const expectedRestoredIds = ACTIVE_STABLECOINS.filter((c) => c.id === "myrc-blox" || c.id === "eurc-circle").map((c) => c.id);
    const finding = { reason: "preferred-native-supply-unavailable", unavailableIds: { ids: ["usyc-hashnote"], total: 1, truncated: 0 }, restoredIds: { ids: expectedRestoredIds, total: 2, truncated: 0 } };
    expect(result.status).toBe("ok");
    expect(metadata.reason).toBeUndefined();
    expect(metadata.capabilities).toMatchObject({ stablecoinsCache: true, depegPipeline: true });
    expect(metadata.quality).toEqual({ reason: finding.reason, preferredNativeSupply: finding });
    const degraded = build(true);
    expect(degraded.status).toBe("degraded");
    expect(JSON.parse(degraded.metadata!).quality).toEqual({ reason: "price-staleness-check-failed", reasons: ["price-staleness-check-failed", finding.reason], preferredNativeSupply: finding });
    const { guard } = allMissingSizeGuardFixture();
    guard.metadata.quality = metadata.quality;
    for (const budget of [Infinity, 2000]) expect(JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, budget)).quality).toEqual(metadata.quality);
    const persisted = compactCronMetadataForPersistence(JSON.stringify({ ...metadata, fullAssets: "x".repeat(100_000) }), undefined, "sync-stablecoins");
    expect(persisted.compacted).toBe(true);
    expect(JSON.parse(persisted.metadata!).quality).toEqual(metadata.quality);
  });

  it.each(["main", "fallback"] as const)("does not report healthy, observed-zero or reviewed-held preferred supply on the %s path", (path) => {
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((coin): PeggedAsset => ({
      ...identity(coin), price: 1,
      circulating: coin.id === "sfrax-frax" ? {} : { peggedUSD: coin.id === "usyc-hashnote" ? 0 : 1 },
      supplySource: coin.id === "sfrax-frax" ? "onchain-supply-withheld" : coin.id === "eurc-circle" ? "onchain-circulating-supply" : "onchain-total-supply",
    }));
    const input = { ...syncInput(assets), providerDiagnostics: [], cacheKey: "stablecoins", syncStartSec: 1_777_000_000, authoritativeOverrideCount: 0, cachedFallbackCount: 0, activePriceCoverage: evaluateStablecoinActivePriceCoverage(assets) };
    const result = path === "main" ? buildStablecoinsSyncResult(input) : buildFallbackStablecoinsSyncResult(input);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata!).quality).toBeUndefined();
  });

  it.each(["main", "fallback"] as const)("reports capacity holds as degraded with no depeg capability on the %s path", (path) => {
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((coin) => ({ ...identity(coin), price: 1, circulating: { peggedUSD: 1 } }));
    const input = { ...syncInput(assets), providerDiagnostics: [], depegHeldReason: "depeg-open-event-limit-reached" as const, cacheKey: "stablecoins", syncStartSec: 1_777_000_000, authoritativeOverrideCount: 0, cachedFallbackCount: 0, activePriceCoverage: evaluateStablecoinActivePriceCoverage(assets) };
    const result = path === "main" ? buildStablecoinsSyncResult(input) : buildFallbackStablecoinsSyncResult(input);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!)).toMatchObject({ reason: "depeg-open-event-limit-reached", depegHeldReason: "depeg-open-event-limit-reached", depegPipelineSucceeded: false, capabilities: { stablecoinsCache: true, depegPipeline: false } });
    const { guard } = allMissingSizeGuardFixture();
    guard.metadata.depegHeldReason = input.depegHeldReason;
    guard.metadata.reason = input.depegHeldReason;
    guard.capabilities.depegPipeline = false;
    for (const budget of [100_000, 2000]) expect(JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, budget))).toMatchObject({ depegHeldReason: input.depegHeldReason, capabilities: { depegPipeline: false } });
  });

  it("retains disabled inline GeckoTerminal provenance in final publication metadata", () => {
    const result = buildStablecoinsSyncResult({ ...syncInput(pricedAssets()), gtProbe: { stats: { ...createEmptyGtProbeStats(), inlineDisabled: true, isolationReason: "worker-memory-boundary" } } });
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata!)).toMatchObject({ cacheWriteMode: "published", capabilities: { stablecoinsCache: true }, gtProbe: { inlineDisabled: true, isolationReason: "worker-memory-boundary" } });
  });

  it.each([false, true])("reports completed supply publication with bounded quality findings (quarantined=%s)", (quarantined) => {
    const result = buildStablecoinsSyncResult({
      ...syncInput(pricedAssets()),
      supplyChainGuard: { flagged: 25, repaired: quarantined ? 0 : 25, quarantinedAssetIds: quarantined ? Array.from({ length: 25 }, (_, i) => `asset-${i}`) : [], unavailableAssetIds: quarantined ? ["asset-0"] : [], historyFetches: 8, stateReadFailed: false },
    });
    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.supplyChainGuard).toMatchObject({ flagged: 25, repaired: quarantined ? 0 : 25, historyFetches: 8, quarantinedAssetCount: quarantined ? 25 : 0, unavailableAssetCount: quarantined ? 1 : 0 });
    expect(metadata.supplyChainGuard.quarantinedAssetIds).toHaveLength(quarantined ? 20 : 0);
    expect(metadata.supplyChainGuard.state).toBeUndefined();
    expect(metadata.reason).toBeUndefined();
    expect(metadata.quality).toEqual(quarantined ? { reason: "supply-chain-dropout-quarantine", quarantinedAssetCount: 25, unavailableAssetCount: 1 } : undefined);
  });

  it("names the degrading publication gap as the quality driver ahead of an informational quarantine", () => {
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.slice(Math.ceil(ACTIVE_STABLECOINS.length * 0.01)).map((a) => ({ ...identity(a), price: 1, priceSource: "coingecko", circulating: { peggedUSD: 1 } }));
    const result = buildStablecoinsSyncResult({ ...syncInput(assets), supplyChainGuard: { flagged: 1, repaired: 0, quarantinedAssetIds: ["asset-0"], unavailableAssetIds: [], historyFetches: 1, stateReadFailed: false } });
    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.reason).toBe("stablecoin-publication-gap-elevated");
    expect(metadata.quality).toEqual({ reason: "stablecoin-publication-gap-elevated", reasons: ["stablecoin-publication-gap-elevated", "supply-chain-dropout-quarantine"], quarantinedAssetCount: 1, unavailableAssetCount: 0 });
  });

  it.each([[{ depegErrorCount: 1 }, "depeg-pipeline-errors"], [{ stalenessCheckFailed: true }, "price-staleness-check-failed"]] as const)(
    "names every degraded driver in reason and quality (%o)",
    (override, reason) => {
      const result = buildStablecoinsSyncResult({ ...syncInput(pricedAssets()), ...override });
      expect(result.status).toBe("degraded");
      expect(JSON.parse(result.metadata!)).toMatchObject({ reason, quality: { reason } });
    },
  );

  describe("depeg observation census", () => {
    const census = {
      scope: "psi-non-nav-before-supply-floor" as const, evaluatedAt: 1_777_000_000, eligibleCount: 4, observedCount: 2,
      unavailableCount: 1, belowFloorCount: 1, reasonCounts: { "supply-unavailable": 1 },
      unavailableAssets: [{ id: "gap", reason: "supply-unavailable" as const, reviewedNominalReference: false }], unavailableIdsTruncated: false,
    };
    const build = (path: "main" | "fallback", extra: Partial<Parameters<typeof buildStablecoinsSyncResult>[0]>) => {
      const rows = pricedAssets();
      const input = { ...syncInput(rows), providerDiagnostics: [], cacheKey: "stablecoins", syncStartSec: 1_777_000_100, authoritativeOverrideCount: 0, cachedFallbackCount: 0, activePriceCoverage: evaluateStablecoinActivePriceCoverage(rows), ...extra };
      return path === "main" ? buildStablecoinsSyncResult(input) : buildFallbackStablecoinsSyncResult(input);
    };

    it.each(["main", "fallback"] as const)("handles complete, incomplete, and unavailable census on the %s path", (path) => {
      const incomplete = build(path, { depegObservation: census });
      expect(incomplete.status).toBe("ok");
      const meta = JSON.parse(incomplete.metadata!);
      expect(meta.reason).toBeUndefined();
      expect(meta).toMatchObject({ depegPipelineSucceeded: true, capabilities: { depegPipeline: true } });
      expect(meta.quality).toEqual({ reason: "depeg-observation-incomplete", depegObservation: { ...census, syncStartSec: 1_777_000_100 } });

      const complete = { ...census, observedCount: 3, unavailableCount: 0, reasonCounts: {} };
      expect(JSON.parse(build(path, { depegObservation: complete }).metadata!).quality).toEqual({ depegObservation: { ...complete, syncStartSec: 1_777_000_100 } });
      const degraded = build(path, { depegObservation: census, depegErrorCount: 1 });
      expect(degraded.status).toBe("degraded");
      expect(JSON.parse(degraded.metadata!).quality).toMatchObject({ reason: "depeg-pipeline-errors", reasons: ["depeg-pipeline-errors", "depeg-observation-incomplete"] });

      expect(JSON.parse(build(path, { depegObservation: null, depegObservationUnavailableReason: "depeg-detection-error", depegErrorCount: 1 }).metadata!).quality).toEqual({
        reason: "depeg-pipeline-errors", depegObservation: null, depegObservationUnavailableReason: "depeg-detection-error",
      });
    });

    it.each([1, 100])("bounds notice samples before coverage compaction (%i receipts)", (count) => {
      const notices = Array.from({ length: count }, (_, i) => ({ eventId: i + 1, stablecoinId: "coin", evidenceKind: "dex-aggregate" as const, evaluatedAt: 1, price: .992, deviationBps: -80, publishedAt: 1, aggregateObservedAt: 1, pricedTvlUsd: 1e6, contributorCount: 4, contributors: Array(4).fill({ family: "direct_api", protocol: "orca", chain: "solana", price: .992, deviationBps: -80, tvlUsd: 1e6, observedAt: 1, aggregateObservedAt: 1 }) }));
      const sample = sampleDepegDeadBandNotices(notices);
      expect(sample.deadBandNoticesShownCount + sample.deadBandNoticesOmittedCount).toBe(count);
      expect(sample.deadBandNoticesShownCount).toBe(Math.min(count, 2));
      const expected = JSON.parse(buildStablecoinsSyncResult(syncInput(pricedAssets())).metadata!).activePriceCoverage;
      expect(JSON.parse(buildStablecoinsSyncResult({ ...syncInput(pricedAssets()), depegObservation: { ...census, ...sample } }).metadata!).activePriceCoverage).toEqual(expected);
      const { guard } = allMissingSizeGuardFixture();
      const baseline = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, Infinity)).activePriceCoverage;
      guard.metadata.quality = { depegObservation: { ...census, deadBandNotices: notices } };
      const result = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard));
      expect(result.activePriceCoverage).toEqual(baseline);
      expect(result.quality.depegObservation).toMatchObject({ deadBandNoticesShownCount: 0, deadBandNoticesOmittedCount: count });
    });

    it.each([Infinity, 100_000, 2_000])("retains the census through metadata compaction (budget=%s)", (budget) => {
      const { guard } = allMissingSizeGuardFixture();
      const quality = { reason: "depeg-observation-incomplete", depegObservation: { ...census, syncStartSec: 1 } };
      guard.metadata.quality = quality;
      const metadata = JSON.parse(buildSizeGuardedStablecoinsSyncMetadata(guard, budget));
      expect(metadata.quality).toEqual(budget === 2_000 ? { ...quality, depegObservation: { ...quality.depegObservation, unavailableAssets: undefined, unavailableIdsDropped: true } } : quality);
    });
  });

  it("retains kava-pricefeed fallback observations and observation effectiveness across paths", () => {
    const assets: PeggedAsset[] = ACTIVE_STABLECOINS.map((a) => ({ ...identity(a), price: 1, priceSource: a.id === "usdc-circle" ? "kava-pricefeed" : "coingecko", priceConfidence: "high" }));
    const health = JSON.parse(buildStablecoinsSyncResult(syncInput(assets)).metadata!).priceSourceHealth;
    expect(health.sourceDistribution["kava-pricefeed"]).toBe(1);
    expect(health.sourceDistribution.missing).toBe(0);
    expect(Object.values(health.sourceDistribution).reduce<number>((sum, n) => sum + Number(n), 0)).toBe(assets.length);
    const main = buildStablecoinsSyncResult({ ...syncInput([]), priceObservationEffectiveness: observationEffectiveness });
    const metadata = JSON.parse(main.metadata!);
    const fallback = buildFallbackStablecoinsSyncResult({ ...syncInput([]), providerDiagnostics: [], authoritativeOverrideCount: 0, cachedFallbackCount: 0, cacheKey: "stablecoins", syncStartSec: 1_777_000_000, activePriceCoverage: metadata.activePriceCoverage, priceObservationEffectiveness: observationEffectiveness });
    for (const r of [main, fallback]) expect(JSON.parse(r.metadata!).priceObservationEffectiveness).toEqual(observationEffectiveness);
    expect(JSON.parse(buildStablecoinsSyncResult(syncInput([])).metadata!).priceObservationEffectiveness).toBeUndefined();
  });

  it("separates active catalog health, value weighting, gap reviews, and calendar closures", () => {
    const activeSubset: PeggedAsset[] = ACTIVE_STABLECOINS.filter((a) => a.id !== "usdc-circle").map((a) => ({ ...identity(a), price: a.id === "usdt-tether" ? null : 1, priceSource: a.id === "usdt-tether" ? "missing" : "coingecko", priceConfidence: "high" }));
    activeSubset.push(...["upstream-only-a", "upstream-only-b"].map((id) => ({ id, name: id, symbol: "OTHER", price: null, priceSource: "missing" })));
    expect(JSON.parse(buildStablecoinsSyncResult(syncInput(activeSubset)).metadata!).priceSourceHealth).toMatchObject({
      totalAssets: ACTIVE_IDS.size + 1, sourceDistribution: { missing: 3 }, confidenceDistribution: { high: ACTIVE_IDS.size - 2 },
      active: { totalAssets: ACTIVE_IDS.size, sourceDistribution: { missing: 2 }, confidenceDistribution: { high: ACTIVE_IDS.size - 2 } },
    });

    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((e) => e.stablecoinId === "wusd-worldwide")!;
    expect(review).toBeDefined();
    const weighted = ACTIVE_STABLECOINS.map((a): PeggedAsset => {
      const circulating: Record<string, number> = a.id === "usdt-tether" ? { peggedUSD: 300e9 } : a.id === "eurc-circle" ? { peggedEUR: 3e9 } : a.id === "usyc-hashnote" ? { peggedUSD: 2e9 } : { peggedUSD: 0 };
      if (a.id === "wusd-worldwide") return { ...identity(a), price: null, priceSource: "missing", priceConfidence: null, circulating };
      if (a.id === "usyc-hashnote") return { ...identity(a), price: 1, priceSource: "chainlink-nav", priceConfidence: "single-source", circulating };
      return { ...identity(a), price: 1, priceSource: "coingecko", priceConfidence: "high", circulating };
    });
    const active = JSON.parse(buildStablecoinsSyncResult({ ...syncInput(weighted), syncStartSec: review.reviewedAt + Math.floor((review.expiresAt - review.reviewedAt) / 2) }).metadata!).priceSourceHealth.active;
    expect(active).toMatchObject({ totalAssets: ACTIVE_IDS.size, confidenceDistribution: { high: ACTIVE_IDS.size - 2, "single-source": 1, low: 0, fallback: 0 }, confidenceMarketCapUsd: { high: 303e9, "single-source": 2e9, low: 0, fallback: 0 }, pricedMarketCapUsd: 305e9, acknowledgedMissingCount: 1 });
    expect(active.sourceDistribution.missing).toBe(1);
    expect(JSON.parse(buildStablecoinsSyncResult({ ...syncInput(weighted), syncStartSec: review.expiresAt + 1 }).metadata!).priceSourceHealth.active.acknowledgedMissingCount).toBe(0);

    const rows = (missing: string[]) => ACTIVE_STABLECOINS.map((a) => ({ ...identity(a), price: missing.includes(a.id) ? null : 1, priceSource: missing.includes(a.id) ? "missing" : "coingecko" }));
    const mento = rows(["cadm-mento", "audm-mento", "chfm-mento", "copm-mento", "jpym-mento"]);
    for (const [syncStartSec, expected] of [[Date.UTC(2026, 9, 30, 21) / 1000, 5], [Date.UTC(2026, 10, 1, 23) / 1000, 0]]) {
      const m = JSON.parse(buildStablecoinsSyncResult({ ...syncInput(mento), syncStartSec }).metadata!);
      expect(m.priceSourceHealth.active).toMatchObject({ sourceDistribution: { missing: 5 }, acknowledgedMissingCount: 0, scheduledClosureMissingCount: expected });
      expect(m.activePriceCoverage.scheduledClosureGapIds).toHaveLength(expected);
    }
    const close = Date.UTC(2026, 9, 30, 21) / 1000;
    const prev = evaluateStablecoinActivePriceCoverage(rows(["chfm-mento"]), undefined, { nowSec: close - 900 });
    const m = JSON.parse(buildStablecoinsSyncResult({ ...syncInput(rows(["chfm-mento", "cadm-mento"])), syncStartSec: close + 900, previousActivePriceCoverage: prev }).metadata!);
    expect(m.activePriceCoverage.scheduledClosureGapIds).toEqual(["cadm-mento"]);
    expect(m.activePriceCoverage.alertEligibleIds).toContain("chfm-mento");
    expect(m.priceSourceHealth.active).toMatchObject({ sourceDistribution: { missing: 2 }, acknowledgedMissingCount: 0, scheduledClosureMissingCount: 1 });

    const supplyRows = ACTIVE_STABLECOINS.map((a): PeggedAsset => ({
      ...identity(a), price: 1, priceSource: "coingecko", priceConfidence: a.id === "usdc-circle" ? "low" : "high",
      circulating: a.id === "usdt-tether" ? { peggedUSD: 100 } : a.id === "usdc-circle" ? {} : a.id === "dai-makerdao" ? { peggedUSD: 0 } : { peggedUSD: 1 },
    }));
    const knownSubtotal = 100 + ACTIVE_STABLECOINS.length - 3;
    const sh = JSON.parse(buildStablecoinsSyncResult(syncInput(supplyRows)).metadata!).priceSourceHealth;
    expect(sh.supplyCoverage).toEqual({ complete: false, observedCount: ACTIVE_STABLECOINS.length - 1, unavailableCount: 1 });
    expect(sh.pricedMarketCapUsd).toBe(knownSubtotal);
    expect(sh.confidenceDistribution).toMatchObject({ high: ACTIVE_STABLECOINS.length - 1, low: 1 });
    expect(sh.confidenceMarketCapUsd).toMatchObject({ high: knownSubtotal, low: 0 });
    expect(sh.active.supplyCoverage).toEqual(sh.supplyCoverage);
  });

  it("keeps health evidence intact after scheduler metadata enrichment", () => {
    const sentinel = "full-asset-payload-must-not-be-persisted";
    const diag = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`diagnostic${i}`, "x".repeat(500)]));
    const assets = ACTIVE_STABLECOINS.map((c) => ({ ...identity(c), price: 1, priceSource: "defillama-list", priceConfidence: "single-source" as const, circulating: { peggedUSD: 1 }, diagnosticSentinel: sentinel })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      canonicalDeduplication: { duplicateRows: 1, affectedIds: assets.map((a) => a.id) },
      enrichStats: diag(36), priceValidationStats: { rejected: [] },
      providerDiagnostics: (["binance", "kraken"] as const).map((source) => ({ source, stage: "primary" as const, endpoint: `${source}.example.com`, status: 200, ok: true, success: true, ...diag(40) })),
    });
    expect(new TextEncoder().encode(result.metadata ?? "").byteLength).toBeLessThan(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    expect(result.metadata).not.toContain(sentinel);
    const enriched = normalizeCronMetadataWithLease(result, {
      leaseOwner: "sync-stablecoins:scheduled:00000000-0000-4000-8000-000000000000", renewFailures: 0, leaseLost: false,
      leaseTtlSec: 600, leaseHeartbeatSec: 30, leaseMaxRenewFailures: 3, leaseRenewAttempts: 4, leaseRenewSuccesses: 4,
      leaseRenewFailuresTotal: 0, leaseLastRenewedAt: 1_777_000_120, slotStartedAt: 1_777_000_000, scheduleKey: "*/15 * * * *",
      producerPath: "worker/src/cron/sync-stablecoins/index.ts", invocationId: "00000000-0000-4000-8000-000000000001",
      workerVersion: "test-version", attemptNo: 1, producerKind: "scheduled",
    });
    const persisted = compactCronMetadataForPersistence(enriched, undefined, "sync-stablecoins");
    expect(persisted.compacted).toBe(false);
    const metadata = JSON.parse(persisted.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.metadataCompactedBySizeGuard).toBe(true);
    expect(metadata.canonicalDeduplication).not.toHaveProperty("dedupedAssets");
    expect(metadata.activePublicationCoverage).toMatchObject({ complete: true });
    expect(metadata.activePriceCoverage).toMatchObject({ complete: true, pricedActiveCount: ACTIVE_STABLECOINS.length, missingPriceCount: 0 });
  });

  it("reports missing active prices without downgrading a complete row publication", () => {
    const first = ACTIVE_STABLECOINS[0]!;
    const assets = ACTIVE_STABLECOINS.map((c) => ({
      ...identity(c), price: c.id === first.id ? null : 1, priceSource: c.id === first.id ? "coingecko" : "defillama-list",
      priceConfidence: "single-source" as const, priceObservedAt: 1_776_999_900, circulating: { peggedUSD: c.id === first.id ? 125_500 : 1 },
    })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      previousActivePriceCoverage: {
        missingActiveIds: [first.id],
        missingActiveAssets: [{ stablecoinId: first.id, symbol: first.symbol, marketCapUsd: 125_500, currentPrice: null, currentSource: null, currentObservedAt: null, currentConfidence: null, consecutiveMissingGenerations: 1, lastAcceptedPrice: 1.002, lastAcceptedSource: "pyth", lastAcceptedObservedAt: 1_776_999_000, rejectionReason: "no-accepted-price", alertEligible: false }],
      },
      previousAcceptedAssetsById: new Map([[first.id, { id: first.id, symbol: first.symbol, price: null }]]),
    });
    const metadata = JSON.parse(result.metadata ?? "{}") as { activePublicationCoverage: { complete: boolean }; activePriceCoverage: { complete: boolean; missingActiveIds: string[]; affectedMarketCapUsd: number; alertEligibleIds: string[]; missingActiveAssets: Array<Record<string, unknown>> }; capabilities: { stablecoinsCache: boolean } };
    expect(result.status).toBe("ok");
    expect(metadata.activePublicationCoverage.complete).toBe(true);
    expect(metadata.capabilities.stablecoinsCache).toBe(true);
    expect(metadata.activePriceCoverage).toMatchObject({ complete: false, missingActiveIds: [first.id], affectedMarketCapUsd: 125_500, alertEligibleIds: [first.id] });
    expect(metadata.activePriceCoverage.missingActiveAssets[0]).toMatchObject({ symbol: first.symbol, consecutiveMissingGenerations: 2, lastAcceptedPrice: 1.002, lastAcceptedSource: "pyth", lastAcceptedObservedAt: 1_776_999_000, rejectionReason: "no-accepted-price", alertEligible: true });
  });

  it.each([
    ["routine", 1, "ok", true, undefined],
    ["elevated", Math.ceil(ACTIVE_STABLECOINS.length * 0.01), "degraded", true, "stablecoin-publication-gap-elevated"],
    ["systemic", Math.floor(ACTIVE_STABLECOINS.length * 0.1) + 1, "degraded", false, "stablecoin-publication-gap-systemic"],
  ] as const)("bands a %s publication gap", (_band, missingCount, status, cacheSafe, reason) => {
    const assets = ACTIVE_STABLECOINS.slice(missingCount).map((c) => ({ ...identity(c), price: 1, priceSource: "defillama-list", priceConfidence: "single-source" as const, priceObservedAt: 1_776_999_900, circulating: { peggedUSD: 1 } })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult(syncInput(assets));
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason?: string; activePublicationCoverage: { complete: boolean; missingActiveIds: string[] }; capabilities: { stablecoinsCache: boolean } };
    expect(result.status).toBe(status);
    expect(metadata.reason).toBe(reason);
    expect(metadata.capabilities.stablecoinsCache).toBe(cacheSafe);
    expect(metadata.activePublicationCoverage).toMatchObject({ complete: false });
    expect(metadata.activePublicationCoverage.missingActiveIds).toHaveLength(missingCount);
  });

  it("compacts all-asset gap state below the cron metadata limit without losing streak state", () => {
    const assets = ACTIVE_STABLECOINS.map((c) => ({ ...identity(c), price: null, circulating: { peggedUSD: 1 } })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      previousAcceptedAssetsById: new Map(assets.map((a) => [a.id, { id: a.id, symbol: a.symbol, price: 1, priceSource: "coingecko", priceObservedAt: 1_776_999_000 }])),
    });
    expect(new TextEncoder().encode(result.metadata ?? "").byteLength).toBeLessThan(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    const metadata = JSON.parse(result.metadata ?? "{}") as { activePriceCoverage: { missingActiveAssets: unknown[]; missingActiveAssetsTruncated: number; missingActiveState: unknown[] } };
    expect(metadata.activePriceCoverage.missingActiveAssets).toHaveLength(20);
    expect(metadata.activePriceCoverage.missingActiveAssetsTruncated).toBe(ACTIVE_STABLECOINS.length - 20);
    expect(metadata.activePriceCoverage.missingActiveState).toHaveLength(ACTIVE_STABLECOINS.length);
  });

  it("retains missing-asset source attempts when the metadata size guard compacts diagnostics", () => {
    const missingId = ACTIVE_STABLECOINS[0]!.id;
    const assets = ACTIVE_STABLECOINS.map((c) => ({ ...identity(c), price: null, circulating: { peggedUSD: 1 } })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      ...syncInput(assets),
      priceObservationEffectiveness: observationEffectiveness,
      providerDiagnostics: [{
        source: "coinmarketcap", stage: "fallback", endpoint: "pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest",
        status: 200, ok: true, success: false,
        assetAttempts: [{ assetId: missingId, adapter: "coinmarketcap", source: "coinmarketcap", target: "slug:missing", state: "attempted", result: "rejected", rejectionClass: "stale", candidateAt: 1_777_000_000, observedAt: 1_776_900_000, replaySafe: false }],
      }],
      previousAcceptedAssetsById: new Map(assets.map((a) => [a.id, { id: a.id, symbol: a.symbol, price: 1, priceSource: "intentionally-overlong-source-".repeat(20), priceObservedAt: 1_776_999_000 }])),
    });
    expect(new TextEncoder().encode(result.metadata ?? "").byteLength).toBeLessThan(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    const metadata = JSON.parse(result.metadata ?? "{}") as { activePriceCoverage: { missingActiveIds: string[] }; priceObservationEffectiveness: PriceObservationEffectiveness; metadataCompactedBySizeGuard: boolean; priceSourceAttemptLedger: { missingActiveIdCount: number; records: unknown[][] } };
    expect(metadata.metadataCompactedBySizeGuard).toBe(true);
    expect(metadata.priceObservationEffectiveness).toEqual(observationEffectiveness);
    expect(metadata.activePriceCoverage.missingActiveIds).toContain(missingId);
    expect(metadata.priceSourceAttemptLedger.missingActiveIdCount).toBe(ACTIVE_STABLECOINS.length);
    expect(metadata.priceSourceAttemptLedger.records).toContainEqual([missingId, "coinmarketcap", "coinmarketcap", null, "slug:missing", "rejected", "stale", 1_777_000_000, 1_776_900_000, false]);
  });

  it("degrades size-guarded metadata through bounded rungs and fails closed when no rung fits", () => {
    const { guard } = allMissingSizeGuardFixture();
    const midBudgetBytes = sizeGuardRungBudget(guard, 10, 6);
    const midBudget = buildSizeGuardedStablecoinsSyncMetadata(guard, midBudgetBytes);
    expect(new TextEncoder().encode(midBudget).byteLength).toBeLessThan(midBudgetBytes);
    const mid = JSON.parse(midBudget) as { metadataCompactedBySizeGuard: boolean; activePriceCoverage: { missingActiveState: unknown[]; missingActiveIds: string[]; missingActiveAssets: unknown[] }; priceSourceAttemptLedger: { records: unknown[][] } };
    expect(mid.metadataCompactedBySizeGuard).toBe(true);
    expect(mid.activePriceCoverage.missingActiveIds).toHaveLength(ACTIVE_STABLECOINS.length);
    expect(mid.activePriceCoverage.missingActiveState).toHaveLength(ACTIVE_STABLECOINS.length);
    expect(mid.activePriceCoverage.missingActiveAssets).toHaveLength(10);
    expect(mid.priceSourceAttemptLedger.records).toHaveLength(6);

    const terminalBudget = buildSizeGuardedStablecoinsSyncMetadata(guard, 2_000);
    expect(new TextEncoder().encode(terminalBudget).byteLength).toBeLessThan(2_000);
    const terminal = JSON.parse(terminalBudget) as Record<string, unknown> & { metadataCompactedBySizeGuard: boolean; sizeGuardEvidenceDropped: boolean };
    expect(terminal.metadataCompactedBySizeGuard).toBe(true);
    expect(terminal.sizeGuardEvidenceDropped).toBe(true);
    expect(terminal).not.toHaveProperty("priceSourceAttemptLedger");
    expect(terminal.activePriceCoverage).not.toHaveProperty("missingActiveIds");
  });

  it("treats terminal size-guard payloads as unavailable continuity and preserves streaks across late rungs", async () => {
    const { assets, guard } = allMissingSizeGuardFixture();
    const terminalMetadata = buildSizeGuardedStablecoinsSyncMetadata(guard, 2_000);
    expect(await loadPreviousStablecoinActivePriceCoverage(mockD1([{ match: "activePriceCoverage", rows: [], first: { metadata: terminalMetadata } }]), 1_777_000_000)).toMatchObject({ status: "read-error", reason: "previous-coverage-malformed" });

    const lateRungMetadata = buildSizeGuardedStablecoinsSyncMetadata(guard, sizeGuardRungBudget(guard, 0, 0));
    const lateRung = JSON.parse(lateRungMetadata) as { activePriceCoverage: { missingActiveAssets: unknown[]; missingActiveAssetsTruncated: number } };
    expect(lateRung.activePriceCoverage.missingActiveAssets).toHaveLength(0);
    expect(lateRung.activePriceCoverage.missingActiveAssetsTruncated).toBe(ACTIVE_STABLECOINS.length);
    const prior = await loadPreviousStablecoinActivePriceCoverage(mockD1([{ match: "activePriceCoverage", rows: [], first: { metadata: lateRungMetadata } }]), 1_777_000_000);
    expect(prior.status).toBe("ok");
    if (prior.status !== "ok") throw new Error("Expected readable late-rung continuity");
    expect(prior.coverage.missingActiveIds).toHaveLength(ACTIVE_STABLECOINS.length);
    expect(prior.coverage.missingActiveAssets).toHaveLength(ACTIVE_STABLECOINS.length);
    const nextGeneration = evaluateStablecoinActivePriceCoverage(assets, undefined, { previousCoverage: prior.coverage });
    expect(nextGeneration.maxConsecutiveMissingGenerations).toBe(2);
    expect(nextGeneration.missingActiveAssets.every((d) => d.consecutiveMissingGenerations === 2)).toBe(true);
  });
});

describe("priced-cohort collapse", () => {
  const pricedAssets = (n: number): PeggedAsset[] => {
    const unpriced = new Set(ACTIVE_STABLECOINS.slice(0, n).map((c) => c.id));
    return ACTIVE_STABLECOINS.map((c) => ({ ...identity(c), price: unpriced.has(c.id) ? null : 1, priceSource: unpriced.has(c.id) ? "missing" : "defillama-list", priceConfidence: "single-source" as const, circulating: { peggedUSD: 1 } })) as PeggedAsset[];
  };
  const previousFullCohort = { missingActiveIds: [], missingActiveAssets: [], pricedActiveCount: ACTIVE_STABLECOINS.length, expectedActiveCount: ACTIVE_STABLECOINS.length };

  it("degrades a run whose priced cohort drops materially against the previous generation", () => {
    const result = buildStablecoinsSyncResult({ ...syncInput(pricedAssets(40)), previousActivePriceCoverage: previousFullCohort });
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "stablecoin-price-coverage-collapse", quality: { reason: "stablecoin-price-coverage-collapse" } });
    expect(buildStablecoinsSyncResult({ ...syncInput(pricedAssets(4)), previousActivePriceCoverage: previousFullCohort }).status).toBe("ok");
    expect(buildStablecoinsSyncResult({ ...syncInput(pricedAssets(4)), previousActivePriceCoverage: { ...previousFullCohort, pricedActiveCount: 8 } }).status).toBe("ok");
    const zero = buildStablecoinsSyncResult(syncInput(pricedAssets(ACTIVE_STABLECOINS.length)));
    expect(zero.status).toBe("degraded");
    expect(JSON.parse(zero.metadata ?? "{}")).toMatchObject({ reason: "stablecoin-price-coverage-collapse" });
    const single = buildStablecoinsSyncResult({ ...syncInput(pricedAssets(1)), previousActivePriceCoverage: previousFullCohort });
    expect(single.status).toBe("ok");
    expect(JSON.parse(single.metadata ?? "{}").reason).toBeUndefined();
  });

  it("degrades a CoinGecko-supply-fallback publication whose priced cohort collapses", () => {
    const assets = pricedAssets(40);
    const result = buildFallbackStablecoinsSyncResult({
      ...syncInput(assets), providerDiagnostics: [], cacheKey: "stablecoins", syncStartSec: 1_777_000_000,
      authoritativeOverrideCount: 0, cachedFallbackCount: 0,
      activePriceCoverage: evaluateStablecoinActivePriceCoverage(assets), previousActivePriceCoverage: previousFullCohort,
    });
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "stablecoin-price-coverage-collapse", quality: { reason: "stablecoin-price-coverage-collapse" } });
  });

  it("records unavailable open-depeg continuity in quality without degrading sync status", () => {
    const assets = pricedAssets(0);
    const ok = buildStablecoinsSyncResult({ ...syncInput(assets), openDepegContinuity: { status: "ok", openEventCount: 1, publishedCount: 1, publishedAssetIds: ["pmusd-raac"] } });
    expect(ok.status).toBe("ok");
    expect(JSON.parse(ok.metadata!)).toMatchObject({ openDepegContinuity: { status: "ok", openEventCount: 1, publishedCount: 1, publishedAssetIds: ["pmusd-raac"] } });
    expect(JSON.parse(ok.metadata!).quality).toBeUndefined();
    const unavailable = buildStablecoinsSyncResult({ ...syncInput(assets), openDepegContinuity: { status: "unavailable", unavailableReason: "open-depeg-read-failed", openEventCount: null, publishedCount: 0 } });
    expect(unavailable.status).toBe("ok");
    expect(JSON.parse(unavailable.metadata!)).toMatchObject({
      openDepegContinuity: { status: "unavailable", unavailableReason: "open-depeg-read-failed", openEventCount: null, publishedCount: 0 },
      quality: { reason: "open-depeg-continuity-unavailable", openDepegContinuityUnavailableReason: "open-depeg-read-failed" },
    });
  });
});
