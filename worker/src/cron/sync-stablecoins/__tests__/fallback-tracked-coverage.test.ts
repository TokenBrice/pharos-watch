/**
 * DefiLlama-outage publication keeps the tracked set (fe2-082-1).
 *
 * Runs `syncViaCoingeckoFallback` against a real latest-schema D1 that holds a
 * complete previous main publication. Only network-bound pricing, on-chain and
 * depeg phases are stubbed; intake, restoration, admission and the canonical
 * cache write are the production code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS } from "@shared/lib/stablecoins/frozen-snapshots";
import { getOnchainSupplyHoldReason, prefersOnChainSupplyMcap } from "@shared/lib/onchain-supply-probe";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { getCirculatingRawOrNull, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import { StablecoinListResponseSchema, type StablecoinData } from "@shared/types/supply";
import { getCache } from "../../../lib/db-cache";
import * as authoritative from "../../../lib/authoritative-price-sources";
import { parseStablecoinsCapabilities } from "../../../handlers/scheduled/context";
import { snapshotSupply } from "../../market-supply/snapshot-supply";
import * as enrichment from "../enrich-prices";
import * as post from "../post-enrichment";
import * as onchain from "../supplemental-assets/onchain-supply";
import { validateAndWriteStablecoinsCache } from "../cache-publication";
import { syncViaCoingeckoFallback } from "../fallback";
import type { PeggedAsset } from "../enrich-prices";

const MAIN_SEC = 1_800_000_000;
const MAIN_CLOCK = MAIN_SEC - 60;
const fixtures = createLatestSchemaFixtureTracker();

/** The outage feed covers commodity and CoinGecko-detail coins only, like `fetchCoinGeckoMarketData`. */
const COINGECKO_FEED = ACTIVE_STABLECOINS.filter((meta) => meta.geckoId && meta.id !== "hbd-hive"
  && (meta.detailProvider === "coingecko" || meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER"));
const OMITTED = ACTIVE_STABLECOINS.filter((meta) => !COINGECKO_FEED.includes(meta));
const isPreferredOrHeld = (id: string) => prefersOnChainSupplyMcap({ id }) || getOnchainSupplyHoldReason(id) != null;
/** An ordinary coin whose previous supply observation is past the restore ceiling: nothing can vouch for it. */
const EXPIRED_ID = OMITTED.find((meta) => !isPreferredOrHeld(meta.id))!.id;
const RESTORABLE = OMITTED.filter((meta) => meta.id !== EXPIRED_ID && !isPreferredOrHeld(meta.id));
/** A restored coin this run's enrichment manages to price. */
const REFILLED = RESTORABLE.find((meta) => meta.flags.pegCurrency === "USD")!;
const CARRIED_SOURCES = ["coingecko", "defillama-list"];

function previousMainRow(meta: (typeof ACTIVE_STABLECOINS)[number], restored = false): PeggedAsset {
  const pegType = pegTypeFromCurrency(meta.flags.pegCurrency) ?? "peggedUSD";
  const supplyObservedAt = meta.id === EXPIRED_ID ? MAIN_SEC - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - 1 : MAIN_CLOCK;
  return {
    id: meta.id, name: meta.name, symbol: meta.symbol, geckoId: meta.geckoId, pegType, pegMechanism: "fiat-backed",
    price: 1, priceSource: "coingecko", priceConfidence: "high",
    consensusSources: CARRIED_SOURCES, agreeSources: CARRIED_SOURCES,
    priceObservedAt: MAIN_CLOCK, priceUpdatedAt: MAIN_CLOCK, priceObservedAtMode: "upstream",
    circulating: { [pegType]: 10_000_000 }, circulatingPrevDay: { [pegType]: 9_000_000 },
    chainCirculating: { Ethereum: { current: 10_000_000 } }, chains: ["Ethereum"],
    supplySource: "defillama", supplyObservedAt, ...(restored ? { supplyRestored: true } : {}),
  };
}

function coingeckoFeed(observedAt: number) {
  return Object.fromEntries(COINGECKO_FEED.map((meta) => [meta.geckoId!, {
    usd: 1, usd_market_cap: 5_000_000, last_updated_at: observedAt,
  }]));
}

async function publishedPayload(db: D1Database): Promise<Map<string, StablecoinData>> {
  const cached = await getCache(db, "stablecoins");
  const payload = StablecoinListResponseSchema.parse(JSON.parse(cached!.value));
  return new Map(payload.peggedAssets.map((row) => [row.id, row]));
}

async function runOutage(db: D1Database, syncStartSec: number) {
  vi.spyOn(Date, "now").mockReturnValue(syncStartSec * 1000);
  return syncViaCoingeckoFallback(db, coingeckoFeed(syncStartSec - 30), undefined, syncStartSec);
}

describe("DefiLlama outage publication with a complete previous publication", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in this suite"); }));
    vi.spyOn(onchain, "fetchCuratedAggregateOnChainMcap").mockResolvedValue(null);
    vi.spyOn(authoritative, "fetchAuthoritativeLivePriceOverrides").mockResolvedValue(new Map());
    vi.spyOn(enrichment, "enrichMissingPrices").mockResolvedValue({
      totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0,
      passCgLowVolume: 0, finalMissing: 0, failedPasses: [],
    });
    vi.spyOn(post, "runSharedPriceCompletion").mockResolvedValue({
      authoritativeOverrideStats: authoritative.createAuthoritativeLivePriceOverrideStats(),
      authoritativeOverrideCount: 0, rejectedCount: 0, cachedFallbackCount: 0,
      nativePegCorrectionCount: 0, nativePegFillCount: 0, priceCacheEntries: [], providerDiagnostics: [],
    });
    vi.spyOn(post, "runDepegPipeline").mockResolvedValue({
      depegErrorCount: 0, depegErrors: [], providerDiagnostics: [], depegObservation: null,
    });
  });
  afterEach(() => { fixtures.closeAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function openWithCompletePublication(restoredIds: ReadonlySet<string> = new Set()) {
    const { db } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(MAIN_SEC * 1000);
    const written = await validateAndWriteStablecoinsCache({
      assets: ACTIVE_STABLECOINS.map((meta) => previousMainRow(meta, restoredIds.has(meta.id))),
      db, syncStartSec: MAIN_SEC, validationContext: "main",
    }, () => ({ metadata: "blocked" }));
    expect(written).toMatchObject({ written: true, quarantinedAssets: [] });
    return db;
  }

  it("keeps every vouched tracked coin, carries original provenance and never zero-fills", async () => {
    expect(COINGECKO_FEED.length * 2).toBeLessThan(ACTIVE_STABLECOINS.length);
    expect(RESTORABLE.length).toBeGreaterThan(50);
    const db = await openWithCompletePublication();
    // Enrichment is this run's only price source for a restored row; a carried price never reaches it.
    let carriedPricesAtEnrichment: number | null = null;
    vi.mocked(enrichment.enrichMissingPrices).mockImplementationOnce(async (assets) => {
      carriedPricesAtEnrichment = assets.filter((asset) => asset.supplyRestored === true && asset.price != null).length;
      Object.assign(assets.find((asset) => asset.id === REFILLED.id)!, {
        price: 1.0003, priceSource: "coinmarketcap", priceConfidence: "single-source",
        priceObservedAt: MAIN_SEC + 880, priceUpdatedAt: MAIN_SEC + 880, priceObservedAtMode: "upstream",
        consensusSources: ["coinmarketcap"], agreeSources: ["coinmarketcap"],
      });
      return { totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 1, passJupiter: 0, passDex: 0,
        passCgLowVolume: 0, finalMissing: 0, failedPasses: [] };
    });
    const result = await runOutage(db, MAIN_SEC + 900);
    const published = await publishedPayload(db);

    // No tracked coin disappears except the one whose evidence is past the restore ceiling.
    expect(ACTIVE_STABLECOINS.map((meta) => meta.id).filter((id) => !published.has(id))).toEqual([EXPIRED_ID]);
    for (const meta of RESTORABLE) {
      const row = published.get(meta.id)!;
      const previous = previousMainRow(meta);
      expect(row, meta.id).toMatchObject({
        supplyRestored: true,
        supplyObservedAt: MAIN_CLOCK,
        supplySource: "defillama",
        circulating: previous.circulating,
        circulatingPrevDay: previous.circulatingPrevDay,
      });
      if (meta.id === REFILLED.id) continue;
      // R2: a carried high-confidence quote is not this run's observation and is not republished.
      expect(row, meta.id).toMatchObject({ price: null, priceConfidence: null, consensusSources: [], agreeSources: [] });
    }
    expect(carriedPricesAtEnrichment).toBe(0);
    expect(published.get(REFILLED.id)).toMatchObject({
      price: 1.0003, priceSource: "coinmarketcap", priceConfidence: "single-source",
      priceObservedAt: MAIN_SEC + 880, agreeSources: ["coinmarketcap"],
    });
    for (const meta of OMITTED.filter((entry) => isPreferredOrHeld(entry.id))) {
      const row = published.get(meta.id)!;
      expect(row.supplySource, meta.id).toBe("onchain-supply-withheld");
      expect(getCirculatingRawOrNull(row), meta.id).toBeNull();
      expect(row.supplyRestored, meta.id).toBeUndefined();
      expect(row.supplyObservedAt, meta.id).toBeUndefined();
    }
    for (const meta of COINGECKO_FEED.filter((entry) => !isPreferredOrHeld(entry.id))) {
      const row = published.get(meta.id)!;
      expect(row, meta.id).toMatchObject({ supplySource: "coingecko-fallback", supplyObservedAt: MAIN_SEC + 870 });
      expect(row.supplyRestored, meta.id).toBeUndefined();
    }
    // Frozen coins are absent from every live feed, so an outage publication
    // restores their archived rows exactly as the primary intake does.
    for (const snapshot of FROZEN_SNAPSHOTS) {
      expect(published.get(snapshot.id), snapshot.id).toMatchObject({
        frozen: true,
        circulating: snapshot.peggedAssetRow.circulating,
      });
    }
    // Every published supply is an admitted observation or carry; no unavailable value became zero.
    for (const meta of ACTIVE_STABLECOINS) {
      const row = published.get(meta.id);
      if (!row) continue;
      const supply = getCirculatingRawOrNull(row);
      expect(supply === null || supply > 0, row.id).toBe(true);
    }

    // Run provenance counts only what CoinGecko served; the carries are named separately. The payload
    // is complete, but the run is graded on what it observed, so it stays degraded and downstream-unsafe.
    const metadata = JSON.parse(result.metadata!);
    expect(result.status).toBe("degraded");
    expect(parseStablecoinsCapabilities(result).stablecoinsCache).toBe(false);
    expect(metadata).toMatchObject({
      reason: "stablecoin-publication-gap-systemic",
      capabilities: { stablecoinsCache: false },
      fallbackMode: "coingecko-supply-fallback",
      upstreamFetchOk: false,
      rowsRead: COINGECKO_FEED.length,
      rowsWritten: published.size,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: COINGECKO_FEED.length },
      activePublicationCoverage: { missingActiveIds: [EXPIRED_ID] },
      trackedCoverage: {
        restoredIds: { total: RESTORABLE.length },
        droppedIds: { ids: [EXPIRED_ID], total: 1, truncated: 0 },
      },
    });
  });

  it("cannot erase a supply day the primary path already snapshotted", async () => {
    // A CoinGecko-detail coin the morning publication restored is served fresh by the outage feed, so
    // snapshot-supply sees it as recovered and rewrites the day. The quarter-hourly gate skips the job on
    // the unsafe run; the 08:00 safety net gates only on freshness, so the rewrite must keep the rows of
    // coins the outage generation only restores.
    const recovered = COINGECKO_FEED.find((meta) => !isPreferredOrHeld(meta.id))!;
    const db = await openWithCompletePublication(new Set([recovered.id]));
    const day = Math.floor(MAIN_SEC / 86_400) * 86_400;
    const dayRows = async () => new Map((await db.prepare(
      "SELECT stablecoin_id, circulating_usd FROM supply_history WHERE snapshot_date = ?",
    ).bind(day).all<{ stablecoin_id: string; circulating_usd: number }>()).results
      .map((row) => [row.stablecoin_id, row.circulating_usd]));
    await snapshotSupply(db, undefined, { nowSec: MAIN_SEC + 60 });
    const written = await dayRows();
    expect(written.has(recovered.id)).toBe(false);
    for (const meta of RESTORABLE) expect(written.get(meta.id), meta.id).toBe(10_000_000);

    const outage = await runOutage(db, MAIN_SEC + 900);
    expect(parseStablecoinsCapabilities(outage).stablecoinsCache).toBe(false);
    await snapshotSupply(db, undefined, { nowSec: MAIN_SEC + 960, minStablecoinsCacheUpdatedAtSec: MAIN_SEC + 900 });
    const rewritten = await dayRows();
    for (const meta of RESTORABLE) expect(rewritten.get(meta.id), meta.id).toBe(10_000_000);
    expect(rewritten.get(recovered.id)).toBe(5_000_000);
    const marker = await getCache(db, "snapshot-supply:last-write");
    const ownedRowIds = new Set(JSON.parse(marker!.value).ownedRowIds as string[]);
    for (const meta of RESTORABLE) expect(ownedRowIds.has(meta.id), meta.id).toBe(true);
  });

  it("does not re-date a carry across consecutive outage publications and drops it past the ceiling", async () => {
    const db = await openWithCompletePublication();
    await runOutage(db, MAIN_SEC + 900);
    await runOutage(db, MAIN_SEC + 1_800);
    const second = await publishedPayload(db);
    expect(ACTIVE_STABLECOINS.map((meta) => meta.id).filter((id) => !second.has(id))).toEqual([EXPIRED_ID]);
    for (const meta of RESTORABLE) {
      expect(second.get(meta.id), meta.id).toMatchObject({ supplyRestored: true, supplyObservedAt: MAIN_CLOCK });
    }

    // Past the seven-day ceiling of the original observation nothing vouches for the carry: the
    // coins are dropped (fail closed) instead of republished with a newer clock.
    const result = await runOutage(db, MAIN_CLOCK + SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + 1);
    const expired = await publishedPayload(db);
    for (const meta of RESTORABLE) expect(expired.has(meta.id), meta.id).toBe(false);
    for (const row of expired.values()) expect(row.supplyObservedAt === MAIN_CLOCK, row.id).toBe(false);
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.trackedCoverage.droppedIds.total).toBe(RESTORABLE.length + 1);
    expect(metadata.capabilities).toMatchObject({ stablecoinsCache: false });
  });
});
