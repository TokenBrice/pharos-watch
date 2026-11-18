import { afterEach, describe, expect, it, vi } from "vitest";
import * as currentPeg from "../../../lib/current-peg-observations";
import { buildPricingOperatorConditions } from "../../operator-watch-pricing";
import { handleStablecoins } from "../../../api/cache-handlers";
import { handlePegSummary } from "../../../api/peg-summary";
import { CurrentPegSchema } from "@shared/types/current-peg";
import type { FxReferenceEvidenceMap } from "@shared/types/fx-reference";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { overlayCanonicalDetail } from "../../../api/stablecoin-detail/price";
import { DEX_PRICE_CHECK_FRESHNESS_SEC } from "../../../lib/dex-cron-constants";
import { getResponseReadyCacheKey } from "../../../lib/api-cache-read";
import { commitReplayPriceCache, validateAndWriteStablecoinsCache, type ValidateAndCacheInput } from "../cache-publication";
import { fxRatesCacheRows } from "../../../lib/__tests__/fx-rate-state.test-support";
import { loadFreshFxRates, loadPreviousStablecoinsById, mergeSupplementalLastKnownGood, normalizeStablecoinsPayload } from "../shared";
import { normalizeChainCirculating } from "../phase-helpers";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCache } from "../../../lib/db-cache";
import { loadStablecoinsCache, prepareStablecoinsGenerationCompanion } from "../../../lib/stablecoins-cache";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getPriceCache } from "../../../lib/price-cache";
import { makePeggedAsset } from "./_fixtures";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { StablecoinDetailResponseSchema, StablecoinListResponseSchema } from "@shared/types/supply";
import type { PeggedAsset } from "../enrich-prices";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

async function readCompanion(db: D1Database) {
  return JSON.parse((await getCache(db, getResponseReadyCacheKey("stablecoins")))!.value) as { body: string };
}

function publish(input: ValidateAndCacheInput, blocked = () => ({ metadata: "blocked" })) {
  return validateAndWriteStablecoinsCache(input, blocked);
}

describe("validateAndWriteStablecoinsCache", () => {
  const syncStartSec = 1_777_000_000;
  it("measures two open hours across winning publications while public FX evidence is off", async () => {
    const { db } = fixtures.open();
    const start = Date.parse("2026-11-17T12:00:00Z") / 1000;
    const clock = vi.spyOn(Date, "now");
    for (let interval = 0; interval <= 8; interval++) {
      const at = start + interval * 900;
      clock.mockReturnValue(at * 1000);
      const asset = makePeggedAsset({ id: "eurc-circle", pegType: "peggedEUR", pegMechanism: "fiat-backed",
        price: 1.1, priceSource: "coingecko", priceObservedAt: at, priceObservedAtMode: "upstream",
        circulating: { peggedEUR: 100_000_000 }, chainCirculating: {}, chains: [] });
      expect(await publish({ db, syncStartSec: at, validationContext: "main", assets: [asset],
        fxReferenceObservations: {} })).toMatchObject({ written: true });
    }
    const served = JSON.parse((await readCompanion(db)).body);
    expect(served.fxReferenceObservations).toBeUndefined();
    expect(served.peggedAssets[0].currentPeg.referenceAdmission).toBeUndefined();
    const conditions = await buildPricingOperatorConditions(db, { nowSec: start + 7200, caches: {} });
    expect(conditions.find((condition) => condition.id === "reference-admission-outage:EUR"))
      .toMatchObject({ active: true, unknown: false });
  });
  it.each([false, true])("measures each legacy FX source separately with stale EUR = %s", async (staleEur) => {
    const { db, sqlite } = fixtures.open();
    const start = Date.parse("2026-11-17T12:00:00Z") / 1000;
    const clock = vi.spyOn(Date, "now");
    for (let i = 0; i <= 9; i++) {
      const at = start + i * 900;
      clock.mockReturnValue(at * 1000);
      for (const row of fxRatesCacheRows(at - 60, { peggedEUR: 1.1, peggedREAL: 0.2 }, {
        sourceUpdatedAtByPeg: { peggedEUR: staleEur ? start - 72 * 3600 : at - 60, peggedREAL: at - 60 },
      })) {
        sqlite.prepare("INSERT OR REPLACE INTO cache(key,value,updated_at) VALUES(?,?,?)").run(row.key, row.value, row.updated_at);
      }
      const selection = await loadFreshFxRates(db);
      expect(selection).not.toHaveProperty("fxReferenceObservations");
      const asset = makePeggedAsset({ id: "eurc-circle", pegType: "peggedEUR", pegMechanism: "fiat-backed",
        price: 1.122, priceSource: "coingecko", priceObservedAt: at - 60, priceObservedAtMode: "upstream",
        circulating: { peggedEUR: 1e8 }, chainCirculating: {}, chains: [] });
      const brz = { ...asset, id: "brz-transfero", pegType: "peggedREAL", price: 0.2, circulating: { peggedREAL: 1e8 } };
      expect(await publish({ db, ...selection, assets: [asset, brz], validationContext: "main", syncStartSec: at,
        publishFxReferenceEvidence: i === 9 })).toMatchObject({ written: true });
    }
    const served = JSON.parse((await readCompanion(db)).body);
    expect(served.fxReferenceObservations).toBeUndefined();
    expect(served.peggedAssets[0].currentPeg.currentDeviationBps).toBe(staleEur ? null : 200);
    const conditions = await buildPricingOperatorConditions(db, { nowSec: start + 9 * 900, caches: {} });
    expect(conditions.find((row) => row.id === "reference-admission-outage:EUR")).toMatchObject({ active: staleEur, unknown: false });
    expect(conditions.find((row) => row.id === "reference-admission-outage:BRL")).toMatchObject({ active: false, unknown: false });
  });

  it("admits a legacy EUR peer median only while its original contributor clocks support the comparison", async () => {
    const { db } = fixtures.open();
    const start = Date.parse("2026-11-17T12:00:00Z") / 1000;
    const clock = vi.spyOn(Date, "now");
    for (let i = 0; i <= 9; i++) {
      const at = start + i * 900;
      clock.mockReturnValue(at * 1000);
      const assets = ["eurc-circle", "eure-monerium", "eurcv-societe-generale-forge", "eurs-stasis"].map((id, j) =>
        makePeggedAsset({ id, pegType: "peggedEUR", pegMechanism: "fiat-backed", price: j === 0 ? 1.122 : 1.1,
          priceSource: "coingecko", priceObservedAt: i === 9 && j === 3 ? undefined : at - 60,
          priceUpdatedAt: at - 60, priceObservedAtMode: "upstream",
          circulating: { peggedEUR: 1e8 }, chainCirculating: {}, chains: [] }));
      expect(await publish({ db, assets, validationContext: "main", syncStartSec: at })).toMatchObject({ written: true });
      if (i === 8) {
        const current = JSON.parse((await readCompanion(db)).body).peggedAssets[0].currentPeg;
        expect(current).toMatchObject({ currentDeviationBps: 200, pegReference: { source: "median", valueUsd: 1.1, contributorCount: 4 } });
        expect(current.referenceAdmission).toBeUndefined();
        const conditions = await buildPricingOperatorConditions(db, { nowSec: at, caches: {} });
        expect(conditions.find((row) => row.id === "reference-admission-outage:EUR")).toMatchObject({ active: false, unknown: false });
      }
    }
    const receipt = await getCache(db, "fx-reference-admission-coverage:v1");
    expect(JSON.parse(receipt!.value).currencies.EUR.missingSince).toBe(start + 9 * 900);
  });

  it.each([undefined, {}])("serves the equal-clock replacement after companion failure with FX evidence %j", async (fxReferenceObservations) => {
    const { db, sqlite } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(syncStartSec * 1000);
    const asset = makePeggedAsset({ id: "usdc-circle", pegMechanism: "fiat-backed", price: 1, priceSource: "pyth",
      priceObservedAt: syncStartSec - 20, priceObservedAtMode: "upstream", circulating: { peggedUSD: 1e8 }, chainCirculating: {}, chains: [] });
    const input = { db, assets: [asset], syncStartSec, fxReferenceObservations, validationContext: "main" as const };
    expect(await publish(input)).toMatchObject({ written: true });
    const key = getResponseReadyCacheKey("stablecoins");
    const companion = (await getCache(db, key))!;
    const firstGeneration = JSON.parse((await readCompanion(db)).body).fxAdmissionCoverageGeneration;
    sqlite.exec(`CREATE TRIGGER reject_companion BEFORE INSERT ON cache WHEN NEW.key = '${key}'
      BEGIN SELECT RAISE(FAIL, 'companion failed'); END`);
    expect(await publish({ ...input, assets: [{ ...asset, price: 0.98 }] })).toMatchObject({ written: true, responseReadyCacheError: "Error" });
    sqlite.exec("DROP TRIGGER reject_companion");
    expect(JSON.parse((await getCache(db, "stablecoins"))!.value).fxAdmissionCoverageGeneration).not.toBe(firstGeneration);
    await prepareStablecoinsGenerationCompanion(db, key, companion.value, syncStartSec, firstGeneration).run();
    expect(await getCache(db, key)).toBeNull();
    expect(await (await handleStablecoins(db)).json()).toMatchObject({ peggedAssets: [{ price: 0.98 }] });
  });
  it.each(["main", "fallback"] as const)("round trips the accepted prices, denominator, clocks and dated supply through %s", async (validationContext) => {
    const { db } = fixtures.open();
    const now = Date.parse("2027-03-29T16:00:00Z") / 1000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const repricing = { sessionOpenedAtSec: Date.parse("2027-03-28T21:00:00Z") / 1000, preCloseUsdPerUnit: 0.19, source: "openExchangeRates" } as const;
    const fx = { pegKey: "peggedREAL", usdPerUnit: 0.2, cadence: "intraday", source: "openExchangeRates", observedAtSec: now - 120, repricing } as const;
    const contributors = ["a", "b", "c"].map((assetId, i) => ({
      assetId, derivation: "traded-market" as const, provenanceKey: assetId, observedAtSec: now - 180 + i,
    }));
    const silver = { pegKey: "peggedSILVER", usdPerUnit: 30, cadence: "intraday", source: "peer-median", observedAtSec: now - 180, contributors } as const;
    const baselines = { week: { observedAt: now - 7 * 86400, circulatingUsd: 2_000_000, circulatingNative: null } };
    const asset = Object.assign(makePeggedAsset({
      id: "brz-transfero", pegType: fx.pegKey, pegMechanism: "fiat-backed", price: 0.204, priceSource: "coingecko",
      priceObservedAt: now - 60, priceObservedAtMode: "upstream", circulating: { peggedREAL: 2_000_000 }, chainCirculating: {}, chains: [],
    }), { supplyChangeBaselines: baselines });
    const input = { assets: [asset], db, syncStartSec: now, validationContext, publishFxReferenceEvidence: true, fxFallbackRates: { [fx.pegKey]: fx.usdPerUnit } };
    const generations: FxReferenceEvidenceMap[] = [{ [fx.pegKey]: fx, [silver.pegKey]: silver }, {}];
    for (const evidence of generations) {
      expect(await publish({ ...input, fxReferenceObservations: evidence })).toMatchObject({ written: true });
      for (const contract of ["published", "critical-fields"] as const) {
        const decoded = await loadStablecoinsCache(db, { contract });
        if (decoded.kind !== "ok") throw new Error(decoded.reason);
        expect(decoded.payload.fxReferenceObservations).toEqual(evidence);
        expect(decoded.payload.peggedAssets[0].supplyChangeBaselines).toEqual(baselines);
        const current = decoded.payload.peggedAssets[0].currentPeg!;
        expect(current.referenceAdmission).toMatchObject({ quoteObservedAtSec: now - 60, generation: `stablecoins:${now}` });
        if (evidence[fx.pegKey]) {
          expect(current.referenceAdmission).toMatchObject({ status: "admitted", referenceObservedAtSec: fx.observedAtSec });
          expect(current.admittedDeviationBps).toBeCloseTo(200);
          expect(decoded.payload.selectedPegReferences).toMatchObject({
            peggedREAL: { kind: "fx", repricing }, peggedSILVER: { kind: "median", contributors },
          });
        } else {
          expect(current.referenceAdmission?.reason).toBe("reference-clock-unavailable");
          expect(current).toMatchObject({ admittedDeviationBps: null, currentDeviationBps: null,
            pegReference: null, pegReferenceUnavailable: true, dexPriceCheck: null });
        }
      }
    }
    const undated = { ...asset, priceObservedAt: null, priceUpdatedAt: now - 60 };
    await publish({ ...input, assets: [undated], fxReferenceObservations: { [fx.pegKey]: fx } });
    const fromPages = StablecoinListResponseSchema.parse(JSON.parse((await readCompanion(db)).body));
    expect(fromPages.peggedAssets[0]).toMatchObject({ priceObservedAt: null, currentPeg: {
      referenceAdmission: { reason: "quote-clock-unavailable", quoteObservedAtSec: null }, admittedDeviationBps: null,
    } });
  });

  it("joins the issuer's pinned XAGm entitlement from the successful reserve attempt", async () => {
    const { db, sqlite } = fixtures.open();
    const id = "xagm-matrixdock", now = Date.parse("2027-03-30T14:00:00Z") / 1000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const config = WORKER_TRACKED_META_BY_ID.get(id)!.liveReservesConfig!;
    const ozPerToken = 0.998380822;
    const metadata = { freshnessMode: "not-applicable", observedBlock: { chain: "ethereum", number: 100, timestamp: now - 120 },
      details: { proofKind: "matrixdock-frs-fallback-reserve-feed", reserveUnit: "troy-oz", ozPerToken } };
    sqlite.prepare(`INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source, attempt_id, metadata,
      adapter_source_model, adapter_evidence_class, config_fingerprint) VALUES (?, ?, ?, ?, 'a', ?, 'single-bucket', 'weak-live-probe', ?)`)
      .run(id, '[{"name":"Silver","risk":"medium","pct":100}]', now - 60, config.adapter, JSON.stringify(metadata), computeLiveReserveConfigFingerprint(config));
    sqlite.prepare(`INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
      last_status, warning_count, warnings, metadata, last_success_attempt_id) VALUES (?, ?, 'xagm', ?, ?, 'ok', 0, '[]', '{}', 'a')`)
      .run(id, config.adapter, now - 60, now - 60);
    const asset = makePeggedAsset({ id, pegType: "peggedSILVER", pegMechanism: "commodity", price: ozPerToken * 30,
      priceObservedAt: now, priceObservedAtMode: "upstream", priceSource: "coingecko", circulating: { peggedSILVER: 2_000_000 }, chainCirculating: {}, chains: [] });
    const input = { db, assets: [asset], validationContext: "main" as const, syncStartSec: now, fxFallbackRates: { peggedSILVER: 30 } };
    await publish(input);
    let coin = StablecoinListResponseSchema.parse(JSON.parse((await readCompanion(db)).body)).peggedAssets[0];
    expect(coin.commodityEntitlement).toEqual({ ozPerToken, observedAtSec: now - 120, source: "matrixdock-frs", generation: "ethereum:100", quoteObservedAtSec: now });
    expect(coin.currentPeg?.currentDeviationBps).toBe(0);
    sqlite.prepare("UPDATE reserve_sync_state SET last_success_attempt_id = 'different'").run();
    await publish(input);
    coin = StablecoinListResponseSchema.parse(JSON.parse((await readCompanion(db)).body)).peggedAssets[0];
    expect(coin.commodityEntitlement).toBeUndefined();
    expect(coin.currentPeg?.currentDeviationBps).toBeNull();
  });
  it.each(["defillama", "onchain-total-supply", "missing", "clock", "newer"])("fences bootstrap against %s", async (source) => {
    const { db, sqlite } = fixtures.open();
    const row = makePeggedAsset({ id: "buidl-blackrock", pegMechanism: "fiat-backed", circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [],
      supplySource: "defillama", supplyRestored: true, supplyObservedAt: 100 });
    const prior = JSON.stringify({ peggedAssets: [{ ...row, supplySource: source === "clock" ? "defillama" : source === "newer" ? "onchain-total-supply" : source,
      supplyObservedAt: source === "clock" ? 99 : 100 }] });
    if (source !== "missing") sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run("stablecoins", prior, source === "newer" ? 400 : 200);
    const result = await publish({ db, assets: [row], syncStartSec: 300, validationContext: "main" });
    expect(result).toMatchObject({ written: source === "defillama", skippedBecauseNewer: source === "newer" });
    const cached = await getCache(db, "stablecoins");
    if (source === "defillama") expect(cached?.updatedAt).toBe(300);
    else {
      expect(cached?.value).toBe(source === "missing" ? undefined : prior);
      if (source !== "newer") expect(JSON.parse((result as { blockedResult: { metadata: string } }).blockedResult.metadata).reason)
        .toBe("buidl-bootstrap-predecessor-unavailable");
    }
  });
  it.each([[0.8, false], [null, false], [0.8, true]] as const)("publishes quote-bound fields at %s with DEX overload=%s", async (price, overload) => {
    const derive = vi.spyOn(currentPeg, "deriveCurrentPegObservationMap");
    const { db, sqlite } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(1_777_000_100_000);
    sqlite.prepare("INSERT INTO dex_prices (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl, updated_at, price_sources_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("usdc-circle", "USDC", 0.8, 4, 10_000_000, 1_777_000_090,
        JSON.stringify({ aggregateObservedAt: 1_777_000_101 - DEX_PRICE_CHECK_FRESHNESS_SEC, sources: [] }));
    const prepare = db.prepare.bind(db);
    const dexRead = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (overload && sql.includes("FROM dex_prices")) throw new Error("D1 DB is overloaded: consumed within a 10 second window");
      return prepare(sql);
    });
    const chainPartition = {
      basis: "onchain-share", observedAt: 1_777_000_000, onchainUsd: 102, ratio: 1.02, admission: "carried",
    } as const;
    const asset = makePeggedAsset({
      id: "usdc-circle", pegMechanism: "fiat-backed", price, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: 1_777_000_000, priceObservedAtMode: "upstream",
      agreeSources: ["coingecko"], consensusSources: ["coingecko"],
      circulating: { peggedUSD: 2_000_000 }, circulatingPrevDay: { peggedUSD: 90 },
      supplySource: "coingecko-fallback", supplyObservedAt: 1_777_000_050,
      chainCirculating: { Ethereum: { chainId: "ethereum", current: 100 } }, chains: ["Ethereum"], chainPartition,
    });
    await publish({
      assets: [asset], db, syncStartSec: 1_777_000_100, validationContext: "main",
    });
    dexRead.mockRestore();
    const canonical = JSON.parse((await getCache(db, "stablecoins"))!.value);
    expect(StablecoinListResponseSchema.parse(canonical).peggedAssets[0]).toMatchObject({
      chainPartition, circulating: asset.circulating, circulatingPrevDay: asset.circulatingPrevDay,
      supplySource: asset.supplySource, supplyObservedAt: asset.supplyObservedAt,
    });
    const companion = await readCompanion(db);
    expect(JSON.parse(companion.body)).toEqual(canonical);
    expect((await loadPreviousStablecoinsById(db)).previousAssetsById.get(asset.id)?.chainPartition).toEqual(chainPartition);
    const published = canonical.peggedAssets[0];
    expect(published.currentPeg).toMatchObject({ currentDeviationBps: price == null ? null : -2_000, currentPriceUnavailable: price == null });
    expect(published.price).toBe(price);
    expect(published.currentPeg.dexPriceCheckExpiresAt).toBe(price == null || overload ? null : 1_777_000_101);
    expect(published.currentPeg.dexPriceCheck?.agrees ?? null).toBe(price == null || overload ? null : true);
    expect(derive).toHaveBeenCalledOnce();
    derive.mockClear();
    const summary = await (await handlePegSummary(db)).json() as { coins: { id: string }[] };
    const summaryCoin = summary.coins.find(({ id }) => id === asset.id);
    expect(CurrentPegSchema.parse({ ...summaryCoin, dexPriceCheck: published.currentPeg.dexPriceCheck, dexPriceCheckExpiresAt: published.currentPeg.dexPriceCheckExpiresAt })).toEqual(published.currentPeg);
    expect(derive).toHaveBeenCalledTimes(2);
    const detail = await (await overlayCanonicalDetail(db, asset.id, Response.json({ price: 1 }))).json();
    expect(projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail))).toMatchObject({ price, currentPeg: published.currentPeg });
  });

  it.each(["main", "fallback"] as const)("withholds sFRAX current supply and retained chain quantities at %s publication", async (validationContext) => {
    const db = fixtures.open().db;
    const assets = [makePeggedAsset({
      id: "sfrax-frax", name: "Staked FRAX", symbol: "sFRAX", pegType: "peggedUSD", pegMechanism: "crypto-backed", price: 1.14,
      circulating: { peggedUSD: 64_000_000 }, circulatingPrevDay: { peggedUSD: 63_000_000 },
      supplySource: "onchain-total-supply", supplyObservedAt: 1_777_000_000, supplyRestored: true,
      chains: ["Ethereum", "Arbitrum"],
      chainCirculating: { Ethereum: { current: 63_900_000 }, Arbitrum: { current: 100_000 } },
    })];
    const result = await publish({
      assets, db, syncStartSec: 1_777_000_001, validationContext,
    });
    expect(result).toMatchObject({ written: true, quarantinedAssets: [] });
    const cached = await getCache(db, "stablecoins");
    const payload = StablecoinListResponseSchema.parse(JSON.parse(cached!.value));
    const held = payload.peggedAssets[0]!;
    expect(held).toMatchObject({
      id: "sfrax-frax", circulating: {}, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
      supplySource: "onchain-supply-withheld", supplyUnavailableReason: "economic-float-unreconciled", price: 1.14,
    });
    expect(getCirculatingRawOrNull(held)).toBeNull();
    expect(held.supplyObservedAt).toBeUndefined();
    expect(held.supplyRestored).toBeUndefined();
    expect(held.chainCirculating.Solana).toMatchObject({ chainId: "solana", current: null });
    expect(Object.values(held.chainCirculating)).toHaveLength(10);
    expect(Object.values(held.chainCirculating).every(({ current }) => current === null)).toBe(true);
    // Subsequent same-run consumers must see the refusal too, not the old input.
    expect(getCirculatingRawOrNull(assets[0])).toBeNull();
    expect(assets[0]!.supplyUnavailableReason).toBe("economic-float-unreconciled");
    const companion = await readCompanion(db);
    expect(JSON.parse(companion.body)).toEqual(JSON.parse(cached!.value));
  });

  it("does not resurrect a previously overstated sFRAX aggregate during supplemental carry", () => {
    const current = makePeggedAsset({ id: "sfrax-frax", circulating: {}, chainCirculating: {} });
    const previous = makePeggedAsset({
      id: "sfrax-frax", circulating: { peggedUSD: 64_000_000 }, supplySource: "coingecko-fallback", supplyObservedAt: 1_777_000_000,
    });
    const merged = mergeSupplementalLastKnownGood([current], new Map([[previous.id, previous]]), new Set(), 1_777_000_001);
    expect(merged.restoredCount).toBe(0);
    expect(getCirculatingRawOrNull(merged.assets[0])).toBeNull();
    expect(merged.assets[0]!.supplyUnavailableReason).toBe("economic-float-unreconciled");
  });

  it("publishes the same content with distinct generation IDs for main and fallback policies", async () => {
    const fxFallbackRates = { EUR: 1.1 };
    const priceCacheEntries = [{
      id: "fixture-usd",
      price: 1,
      source: "coingecko",
      confidence: "single-source" as const,
      observedAt: syncStartSec - 30,
      observedAtMode: "upstream" as const,
      syncedAt: syncStartSec,
      agreeSources: ["coingecko"],
      consensusSources: ["coingecko"],
    }];
    const mainDb = fixtures.open().db;
    const fallbackDb = fixtures.open().db;

    for (const [db, validationContext, stagePrefix] of [
      [mainDb, "main", undefined],
      [fallbackDb, "fallback", "fallback-"],
    ] as const) {
      await publish({
        assets: [],
        fxFallbackRates,
        db,
        syncStartSec,
        validationContext,
      });
      await commitReplayPriceCache({
        db,
        entries: priceCacheEntries,
        stagePrefix,
      });
    }

    expect((await getCache(mainDb, "stablecoins"))!.value).not.toBe((await getCache(fallbackDb, "stablecoins"))!.value);
    for (const db of [mainDb, fallbackDb]) {
      const cached = (await getCache(db, "stablecoins"))!;
      expect(cached.updatedAt).toBe(syncStartSec);
      expect(JSON.parse(cached.value)).toEqual({ peggedAssets: [], fxFallbackRates, fxAdmissionCoverageGeneration: expect.any(String) });
      expect((await readCompanion(db)).body).toBe(cached.value);
      expect([...(await getPriceCache(db))]).toEqual([["fixture-usd", {
        price: 1, source: "coingecko", confidence: "single-source",
        updatedAt: syncStartSec - 30, observedAt: syncStartSec - 30,
        observedAtMode: "upstream", syncedAt: syncStartSec,
        hasExplicitClocks: true,
        agreeSources: ["coingecko"], consensusSources: ["coingecko"],
      }]]);
    }
  });

  it.each(["invalid", "newer", "aborted"] as const)("preserves published generations when %s blocks publication", async (gate) => {
    const { db, sqlite } = fixtures.open();
    const companionKey = getResponseReadyCacheKey("stablecoins");
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("stablecoins", "prior", 200);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(companionKey, "companion", 50);
    const controller = new AbortController();
    if (gate === "aborted") controller.abort("cancelled before cache publication");
    const result = await publish({
      db, assets: gate === "invalid" ? [makePeggedAsset({ name: 42 as never })] : [],
      syncStartSec: gate === "newer" ? 100 : 300, validationContext: "main",
      signal: controller.signal,
    });
    expect(await getCache(db, "stablecoins")).toEqual({ value: "prior", updatedAt: 200 });
    expect(await getCache(db, companionKey)).toEqual({ value: "companion", updatedAt: 50 });
    if (gate === "invalid") {
      expect(result).toMatchObject({ written: false, blockedResult: { metadata: "blocked" } });
      expect(sqlite.prepare("SELECT key FROM cache WHERE key NOT IN (?, ?)").all("stablecoins", companionKey))
        .toEqual([expect.objectContaining({ key: expect.stringContaining("invalid") })]);
    } else if (gate === "newer") {
      expect(result).toMatchObject({ written: false, skippedBecauseNewer: true });
    } else {
      expect(result).toMatchObject({ aborted: true });
    }
  });

  it("preserves the replay generation when cancellation blocks persistence", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO price_cache (asset_id, price, updated_at, synced_at) VALUES (?, ?, ?, ?)")
      .run("fixture-usd", 0.99, 100, 100);
    const before = await getPriceCache(db);
    const result = await commitReplayPriceCache({
      db, entries: [{ id: "fixture-usd", price: 1, syncedAt: 200 }],
      signal: AbortSignal.abort("cancelled before replay persistence"),
    });
    expect(result).toMatchObject({ aborted: true });
    expect(JSON.parse(result!.metadata!)).toMatchObject({ stage: "save-price-cache", reason: "aborted" });
    expect(await getPriceCache(db)).toEqual(before);
  });

  it("normalizes every unusable price to explicit missing provenance", () => {
    const payload = normalizeStablecoinsPayload({
      peggedAssets: [makePeggedAsset({
        price: null, priceSource: "coingecko", priceSelectedSource: "coingecko", priceConfidence: "single-source",
        priceUpdatedAt: 1_700_000_000, priceObservedAt: 1_700_000_000, priceObservedAtMode: "upstream", priceSyncedAt: 1_700_000_010,
        consensusSources: ["coingecko"], agreeSources: ["coingecko"],
        priceSourceConfidenceProfile: { activeDexLanes: 1, freshestDexLaneAgeSec: 30, aggregateLaneOnly: false },
      })],
    });

    expect(payload.peggedAssets[0]).toMatchObject({
      price: null, priceSource: "missing", priceSelectedSource: null, priceConfidence: null,
      priceUpdatedAt: null, priceObservedAt: null, priceObservedAtMode: null, priceSyncedAt: null,
      consensusSources: [], agreeSources: [], priceSourceConfidenceProfile: null,
    });
  });

  it("keeps canonical stablecoins publication successful when response-ready cache write fails", async () => {
    const { db, sqlite } = fixtures.open();
    const key = getResponseReadyCacheKey("stablecoins");
    sqlite.exec(`CREATE TRIGGER reject_first_companion BEFORE INSERT ON cache WHEN NEW.key = '${key}'
      BEGIN SELECT RAISE(FAIL, 'response-ready write failed'); END`);

    const result = await publish({
      assets: [], db, syncStartSec, validationContext: "main",
    }, () => ({ status: "degraded", itemCount: 0, metadata: "blocked" }));

    expect(result).toMatchObject({
      written: true,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      responseReadyCacheError: "Error",
    });
  });

  it("quarantines a post-enrichment schema-invalid row per asset and publishes the healthy cohort", async () => {
    const { db, sqlite } = fixtures.open();
    const publishable = (id: string, overrides: Partial<PeggedAsset> = {}) => makePeggedAsset({
      id, name: id, symbol: id.toUpperCase(), pegMechanism: "fiat-backed", price: 1, priceSource: "defillama",
      circulating: { peggedUSD: 1000 }, chainCirculating: {}, chains: [], ...overrides,
    });
    const healthy = Array.from({ length: 50 }, (_, index) => publishable(`healthy-${index}`));
    healthy[0]!.chainCirculating = {
      Ethereum: { current: 5, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {} },
      Tron: { current: {} },
      Base: { current: { peggedUSD: 0 }, circulatingPrevDay: { peggedUSD: 0 } },
    };
    normalizeChainCirculating(healthy);
    const invalid = publishable("negative-history", { circulatingPrevDay: { peggedUSD: -1 } });
    const assets = [...healthy, invalid];

    const result = await publish({
      assets, db, syncStartSec, validationContext: "main",
    });

    expect(result).toMatchObject({ written: true, quarantinedAssets: [expect.objectContaining({ id: "negative-history" })] });
    // Later stages (depeg, coverage) see only the published cohort.
    expect(assets.map((asset) => asset.id)).toEqual(healthy.map((asset) => asset.id));
    const canonical = JSON.parse((await getCache(db, "stablecoins"))!.value) as { peggedAssets: Array<{ id: string; chainCirculating: unknown }> };
    expect(canonical.peggedAssets.map((asset) => asset.id)).toEqual(healthy.map((asset) => asset.id));
    const expectedChains = {
      Ethereum: { current: 5, circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null },
      Tron: { current: null },
      Base: { current: 0, circulatingPrevDay: 0 },
    };
    expect(canonical.peggedAssets[0]?.chainCirculating).toEqual(expectedChains);
    const companion = await readCompanion(db);
    expect((JSON.parse(companion.body) as typeof canonical).peggedAssets[0]?.chainCirculating)
      .toEqual(expectedChains);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").all("stablecoins:invalid-last")).toHaveLength(1);
  });
  it("strips upstream frozen fields from non-registry assets before publishing", async () => {
    const { db } = fixtures.open();
    const result = await publish({
      assets: [makePeggedAsset({
        id: "upstream-controlled-active-coin", pegMechanism: "fiat-backed", price: 1, priceSource: "defillama",
        circulating: { peggedUSD: 1000 }, chainCirculating: {}, chains: [], frozen: true, frozenAt: "2026-04-27",
      })],
      db, syncStartSec, validationContext: "main",
    }, () => ({ status: "degraded", itemCount: 0, metadata: "blocked" }));

    expect(result).toMatchObject({ written: true, skippedBecauseNewer: false });
    const published = StablecoinListResponseSchema.parse(JSON.parse((await getCache(db, "stablecoins"))!.value));
    expect(published.peggedAssets[0].frozen).toBeUndefined();
    expect(published.peggedAssets[0].frozenAt).toBeUndefined();
  });
});
