import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { loadStablecoinsIntake } from "../intake";
import * as supplemental from "../supplemental-assets";
import * as reconciliation from "../supply-gap-reconciliation";
import * as transport from "../../../lib/fetch-retry";
import * as circuit from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { MIN_VALID_ASSET_COUNT } from "../../../lib/stablecoin-intake-policy";
import { makePeggedAsset } from "./_fixtures";
import * as shared from "../shared";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getCirculatingRawOrNull, getUsdMarketCapBaselineOrNull } from "@shared/lib/supply";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { StablecoinDataSchema } from "@shared/types/supply";
import { dedupeCanonicalAssets, deriveExactParListNativeQuantities, fillMissingSupplyHistory } from "../phase-helpers";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { fetchFiatCoinGeckoTokens, FIAT_CG_METAS } from "../supplemental-assets/fiat-cg";
import * as supplementalPrices from "../supplemental-assets/shared";
import * as onchainSupply from "../supplemental-assets/onchain-supply";
import * as structuredLog from "../../../lib/structured-log";
import { fxRatesCacheRows } from "../../../lib/__tests__/fx-rate-state.test-support";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";

const fixtures = createLatestSchemaFixtureTracker();
const cgData = { "fixture-usd": { usd: 1, usd_market_cap: 100, last_updated_at: 1_777_000_000 } };
const fallbackResult = { status: "degraded" as const, itemCount: 0, metadata: "fallback unavailable" };
beforeEach(() => {
  vi.spyOn(supplemental, "fetchCoinGeckoMarketData").mockResolvedValue(cgData);
  vi.spyOn(supplemental, "fetchSupplementalTrackedTokens").mockResolvedValue({ goldTokens: [], silverTokens: [], fiatCgTokens: [] });
  vi.spyOn(circuit, "shouldAttemptFetch").mockResolvedValue(true);
  vi.spyOn(circuit, "recordOutcome");
  vi.spyOn(reconciliation, "reconcileTrackedSupplyGaps").mockResolvedValue({
    reconciledIds: [], totalReconciled: 0,
    byReason: { "defillama-history-gap-fill": 0, "coingecko-gap-fill": 0, "onchain-total-supply": 0 },
    assets: [], baselineMismatches: [], gapFillRejections: [],
  });
});
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

function upstream(body: unknown) {
  return vi.spyOn(transport, "fetchTextWithRetry").mockResolvedValue({
    response: new Response(JSON.stringify(body)), body: JSON.stringify(body),
  });
}

function intakeRows(overrides: Parameters<typeof makePeggedAsset>[0] = {}) {
  return Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
    id: `intake-fixture-${index}`, circulating: { peggedUSD: 100 }, ...overrides,
  }));
}

function datedHistoryFixture() {
  const now = 1_777_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  return { now, ...fixtures.open() };
}

function historyProvenance(supplySource: string | undefined, supplyObservedAt: number) {
  return JSON.stringify({ supplySource, supplyObservedAt, supplyChainGuard: null });
}

describe("stablecoin intake admission", () => {
  it("projects selected same-provider FX evidence from the digest-bound intake read", async () => {
    const nowSec = Date.parse("2026-11-20T21:55:00Z") / 1000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const { db, sqlite } = fixtures.open();
    const observedAtSec = nowSec - 300;
    const observation = { pegKey: "peggedEUR", usdPerUnit: 1.1, source: "openExchangeRates",
      cadence: "intraday", observedAtSec };
    const evidence = { sessionOpenedAtSec: getReferenceSessionState("fx", nowSec).sessionOpenedAtSec,
      preCloseUsdPerUnit: 1.09, firstInSessionObservedAtSec: observedAtSec };
    for (const row of fxRatesCacheRows(nowSec - 30, { peggedEUR: 1.1 }, {
      sourceUpdatedAtByPeg: { peggedEUR: observedAtSec }, observations: { peggedEUR: observation },
      referenceSourceSamples: { "peggedEUR:openExchangeRates": { observation, evidence } },
    })) sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(row.key, row.value, row.updated_at);
    upstream({ peggedAssets: intakeRows() });
    const result = await loadStablecoinsIntake({ db, syncStartSec: nowSec, fallbackToCoingecko: async () => fallbackResult });
    if (result.kind !== "main") throw new Error("Expected main intake");
    expect(result.validationReferences?.fxReferenceEvidenceByPeg?.peggedEUR).toMatchObject({
      ...evidence, observation, generation: expect.stringMatching(/^fx:/),
    });
  });

  it("keeps a reported DefiLlama USD cap when the same-packet quote cannot value its units", async () => {
    const nowSec = 1_777_000_000;
    const { db } = fixtures.open();
    upstream({ peggedAssets: [
      ...intakeRows(),
      makePeggedAsset({ id: "1", symbol: "USDT", price: 10, priceSource: "defillama",
        circulating: { peggedUSD: 100_000_000 } }),
    ] });
    const result = await loadStablecoinsIntake({ db, syncStartSec: nowSec, fallbackToCoingecko: async () => fallbackResult });
    if (result.kind !== "main") throw new Error("Expected main intake");
    expect(result.assets.find((row) => row.id === "usdt-tether")).toMatchObject({
      circulating: { peggedUSD: 100_000_000 },
      circulatingNative: null,
      valuationPriceUsd: null,
      valuationObservedAtSec: null,
    });
  });

  it.each(["onchain-total-supply", "coingecko-fallback"])(
    "keeps preferred USYC with a fresh price after failed native reads and a cached %s row", async (supplySource) => {
      const nowSec = 1_777_000_000;
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      const meta = ACTIVE_META_BY_ID.get("usyc-hashnote")!;
      const previous = makePeggedAsset({
        id: meta.id, name: meta.name, symbol: meta.symbol, geckoId: meta.geckoId,
        pegMechanism: meta.flags.backing, price: 1.05, priceSource: "coingecko",
        priceConfidence: "single-source", priceObservedAt: nowSec - 60, priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 300 }, supplySource, supplyObservedAt: nowSec - 120,
        circulatingNative: 200, valuationPriceUsd: 1.5, valuationObservedAtSec: nowSec - 240,
        chainCirculating: { Ethereum: { chainId: "ethereum", current: 100 }, BSC: { chainId: "bsc", current: 100 }, Solana: { chainId: "solana", current: 100 }, Arc: { chainId: "arc", current: 0 } },
        chains: ["Ethereum", "BSC", "Solana", "Arc"],
      });
      const { db, sqlite } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run("stablecoins", JSON.stringify({ peggedAssets: [previous] }), nowSec - 60);
      upstream({ peggedAssets: Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
        id: `intake-fixture-${index}`, circulating: { peggedUSD: 100 },
      })) });
      vi.mocked(supplemental.fetchCoinGeckoMarketData).mockResolvedValue({
        [meta.geckoId!]: { usd: 1.14, usd_market_cap: 1_000_000, last_updated_at: nowSec },
      });
      vi.spyOn(supplementalPrices, "fetchSupplementalPriceData").mockResolvedValue({ coins: {} });
      const nativeRead = vi.spyOn(onchainSupply, "fetchCuratedAggregateOnChainMcap").mockResolvedValue(null);
      vi.spyOn(onchainSupply, "fetchOnChainMcap").mockResolvedValue(null);
      const log = vi.spyOn(structuredLog, "logWorkerEvent");
      vi.mocked(supplemental.fetchSupplementalTrackedTokens).mockImplementation(async (
        data, signal, _key, chainRpcs, fxRates, inputDb, previousAssetsById, dwellirNative, report,
      ) => ({ goldTokens: [], silverTokens: [], fiatCgTokens: await fetchFiatCoinGeckoTokens(
        data, signal, chainRpcs, fxRates, inputDb, previousAssetsById, dwellirNative, report,
      ) }));
      const originalMetas = FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, meta);
      try {
        const result = await loadStablecoinsIntake({ db, syncStartSec: nowSec, fallbackToCoingecko: async () => fallbackResult });
        if (result.kind !== "main") throw new Error("Expected main intake");
        expect(nativeRead).toHaveBeenCalledOnce();
        expect(result.assets.filter((asset) => asset.id.startsWith("intake-fixture-"))).toHaveLength(MIN_VALID_ASSET_COUNT);
        const asset = result.assets.find((row) => row.id === meta.id);
        expect(asset).toBeDefined();
        const [published] = shared.normalizeStablecoinsPayload({ peggedAssets: [asset!] }, nowSec).peggedAssets;
        expect(published).toMatchObject({ id: meta.id, price: 1.14, priceObservedAt: nowSec, priceSource: "coingecko" });
        expect(StablecoinDataSchema.safeParse(published).success).toBe(true);
        expect(JSON.parse(JSON.stringify(published))).not.toHaveProperty("supplyUnavailableReason");
        expect(result.trackedCoverage.droppedIds).not.toContain(meta.id);
        if (supplySource === "onchain-total-supply") {
          expect(published).toMatchObject({ circulating: previous.circulating, chainCirculating: previous.chainCirculating,
            supplySource, supplyObservedAt: nowSec - 120, supplyRestored: true });
          expect(StablecoinDataSchema.parse(published)).toMatchObject({ circulatingNative: 200,
            valuationPriceUsd: 1.5, valuationObservedAtSec: nowSec - 240 });
          expect(getCirculatingRawOrNull(published)).toBe(300);
        } else {
          expect(published).toMatchObject({ circulating: {},
            supplySource: "onchain-supply-withheld", chainCirculating: {
              Ethereum: { chainId: "ethereum", current: null }, Solana: { chainId: "solana", current: null },
            } });
          expect(getCirculatingRawOrNull(published)).toBeNull();
          expect(published.supplyObservedAt).toBeUndefined();
          expect(published.supplyRestored).toBeUndefined();
        }
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
          stablecoinId: meta.id, reason: "preferred-native-supply-unavailable",
        }) }));
      } finally {
        FIAT_CG_METAS.splice(0, FIAT_CG_METAS.length, ...originalMetas);
      }
    },
  );

  it("publishes tracked registry backing in the current pegMechanism vocabulary", async () => {
    const { db } = fixtures.open();
    // DefiLlama labels United Stables (id 336) crypto-backed while the curated
    // registry reviews it as rwa-backed; tracked rows publish the registry class.
    const unitedStables = makePeggedAsset({
      id: "336", name: "United Stables", symbol: "U", pegType: "peggedUSD",
      pegMechanism: "crypto-backed", price: 1, priceSource: "coingecko",
      circulating: { peggedUSD: 100 },
    });
    const untracked = makePeggedAsset({
      id: "intake-fixture-untracked", pegMechanism: "commodity-backed", circulating: { peggedUSD: 100 },
    });
    upstream({
      peggedAssets: [
        unitedStables,
        untracked,
        ...Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
          id: `intake-fixture-${index}`, circulating: { peggedUSD: 100 },
        })),
      ],
    });
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko: async () => fallbackResult });
    if (result.kind !== "main") throw new Error("Expected main intake");
    expect(result.assets.find((asset) => asset.id === "u-united-stables")?.pegMechanism).toBe("fiat-backed");
    expect(result.assets.find((asset) => asset.id === "intake-fixture-untracked")?.pegMechanism).toBe("commodity-backed");
  });

  it("keeps a preferred coin omitted by a deadline-skipped supplemental batch with unavailable supply", async () => {
    const nowSec = 1_777_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const meta = ACTIVE_META_BY_ID.get("myrc-blox")!;
    const previous = makePeggedAsset({
      id: meta.id, name: meta.name, symbol: meta.symbol, geckoId: meta.geckoId,
      pegType: "peggedMYR", pegMechanism: meta.flags.backing,
      price: 0.24, priceSource: "coingecko", priceConfidence: "single-source",
      priceObservedAt: nowSec - 60, priceObservedAtMode: "upstream",
      circulating: { peggedMYR: 5_000_000 }, supplySource: "coingecko-fallback", supplyObservedAt: nowSec - 60,
      chainCirculating: {}, chains: [],
    });
    const { db, sqlite } = fixtures.open();
    const log = vi.spyOn(structuredLog, "logWorkerEvent");
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("stablecoins", JSON.stringify({ peggedAssets: [previous] }), nowSec - 60);
    upstream({ peggedAssets: Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
      id: `intake-fixture-${index}`, circulating: { peggedUSD: 100 },
    })) });
    // Exercise the intake omission boundary without cancelling the whole publication.
    vi.mocked(supplemental.fetchSupplementalTrackedTokens).mockResolvedValue({ goldTokens: [], silverTokens: [], fiatCgTokens: [] });
    const result = await loadStablecoinsIntake({ db, syncStartSec: nowSec, fallbackToCoingecko: async () => fallbackResult });
    if (result.kind !== "main") throw new Error("Expected main intake");
    const asset = result.assets.find((row) => row.id === meta.id);
    expect(asset).toBeDefined();
    const [published] = shared.normalizeStablecoinsPayload({ peggedAssets: [asset!] }, nowSec).peggedAssets;
    expect(published).toMatchObject({ id: meta.id, price: 0.24, pegType: "peggedMYR",
      circulating: {} });
    expect(JSON.parse(JSON.stringify(published))).not.toHaveProperty("supplyUnavailableReason");
    expect(getCirculatingRawOrNull(published)).toBeNull();
    expect(StablecoinDataSchema.safeParse(published).success).toBe(true);
    expect(result.trackedCoverage.droppedIds).not.toContain(meta.id);
    expect(result.assets.filter((row) => row.id.startsWith("intake-fixture-"))).toHaveLength(MIN_VALID_ASSET_COUNT);
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: "tracked-assets-restored" }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
      stablecoinId: meta.id, reason: "preferred-native-supply-unavailable", resolution: "unavailable",
    }) }));
  });

  it("publishes valid peers while quarantining a malformed row, preserving observed zero and upstream FX", async () => {
    const { db } = fixtures.open();
    const rows = Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
      id: `intake-fixture-${index}`, circulating: { peggedUSD: index === 0 ? 0 : 100 },
    }));
    rows.push(makePeggedAsset({ id: "199", price: 0.17939308404234408, circulating: { peggedREAL: 201_972.94022000663 } }));
    upstream({ peggedAssets: [...rows, null], fxFallbackRates: { EUR: 1.1, BAD: "missing" } });
    const fallbackToCoingecko = vi.fn(async () => fallbackResult);
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko });
    expect(result.kind).toBe("main");
    if (result.kind !== "main") throw new Error("Expected the healthy intake cohort");
    expect(result.rawAssetCount).toBe(MIN_VALID_ASSET_COUNT + 2);
    expect(result.droppedMalformedAssets).toBe(1);
    expect(result.assets.find((asset) => asset.id === "intake-fixture-0")?.circulating).toEqual({ peggedUSD: 0 });
    expect(result.assets.find((asset) => asset.id === "brlm-mento")).toMatchObject({
      circulatingNative: 201_972.94022000663 / 0.17939308404234408,
      valuationPriceUsd: 0.17939308404234408,
      valuationObservedAtSec: null,
    });
    expect(result.fxFallbackRates).toEqual({ EUR: 1.1 });
    expect(result.previousCacheState).toEqual({ state: "missing" });
    expect(result.cgData).toEqual(cgData);
    expect(fallbackToCoingecko).not.toHaveBeenCalled();
  });

  it("loads FX once before intake progress and shares its references without changing supply packets", async () => {
    const { db } = fixtures.open();
    const events: string[] = [];
    const fxFallbackRates = { EUR: 1.2 };
    const validationReferences = { rates: { peggedEUR: 1.2 }, type: "fresh" as const, updatedAt: 1_777_000_000 };
    const fx = vi.spyOn(shared, "loadFreshFxRates").mockImplementation(async () => {
      events.push("fx");
      return { fxFallbackRates, validationReferences };
    });
    const rows = Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
      id: `intake-fixture-${index}`, circulating: { peggedUSD: 100 },
      circulatingPrevDay: { peggedUSD: 90 }, supplyObservedAt: 1_776_999_940,
      chainCirculating: { Ethereum: { current: 100, circulatingPrevDay: 90 } }, chains: ["Ethereum"],
    }));
    upstream({ peggedAssets: rows, fxFallbackRates: { EUR: 1.1 } });
    const result = await loadStablecoinsIntake({
      db, syncStartSec: 1_777_000_000, fallbackToCoingecko: async () => fallbackResult,
      reportProgress: async (update) => { events.push(update.message!); },
    });
    if (result.kind !== "main") throw new Error("Expected main intake");
    expect(fx).toHaveBeenCalledOnce();
    expect(events).toEqual(["fx", "Loading DefiLlama stablecoin intake", "Loaded DefiLlama stablecoin intake"]);
    expect(supplemental.fetchSupplementalTrackedTokens).toHaveBeenCalledWith(
      cgData, undefined, undefined, undefined, fxFallbackRates, db, expect.any(Map), undefined, undefined, 1_777_000_000, result.replayPriceCache,
      { validationReferences, previousTrustedPrices: expect.any(Map) },
    );
    expect(result.fxFallbackRates).toBe(fxFallbackRates);
    expect(result.validationReferences).toBe(validationReferences);
    expect(result.assets.find((asset) => asset.id === rows[0].id)).toMatchObject({
      circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 90 },
      chainCirculating: { Ethereum: { current: 100, circulatingPrevDay: 90 } },
      supplyObservedAt: 1_776_999_940,
    });
  });

  it.each([60, null, -60])("admits list USD baselines only with a known source clock (%s seconds)", async (ageSec) => {
    const { now, db, sqlite } = datedHistoryFixture();
    const id = "intake-fixture-0";
    const observedAt = now - 60 - 86_400;
    sqlite.prepare(`INSERT INTO supply_history
      (stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance) VALUES (?, ?, ?, ?, ?)`)
      .run(id, bucketUnixSecondsToUtcDay(observedAt), 110, 90, historyProvenance("defillama", observedAt));
    upstream({ peggedAssets: intakeRows({
      supplySource: "defillama", supplyObservedAt: ageSec == null ? undefined : now - ageSec,
    }) });
    const result = await loadStablecoinsIntake({ db, syncStartSec: now, fallbackToCoingecko: async () => fallbackResult });
    if (result.kind !== "main") throw new Error("Expected main intake");
    const asset = result.assets.find((row) => row.id === id)!;
    await fillMissingSupplyHistory(db, [asset]);
    const [published] = shared.normalizeStablecoinsPayload({ peggedAssets: [asset] }, now).peggedAssets;
    expect(published.supplyObservedAt).toBe(ageSec === 60 ? now - 60 : undefined);
    expect(published.supplyChangeBaselines).toEqual(ageSec === 60
      ? { day: { observedAt, circulatingUsd: 110, circulatingNative: 90 } } : { day: null });
  });

  it("keeps the earlier canonical row on equal quality and prefers observed zero to missing history", () => {
    const first = makePeggedAsset({ circulatingPrevDay: null });
    const tied = { ...first, name: "Duplicate" };
    const observed = { ...tied, circulatingPrevDay: { peggedUSD: 0 } };
    expect(dedupeCanonicalAssets([first, tied]).dedupedAssets[0]).toBe(first);
    expect(dedupeCanonicalAssets([first, observed]).dedupedAssets[0]).toBe(observed);
  });

  it("fills empty ordinary USD buckets from plausible unassessed closes on the exact UTC dates", async () => {
    const { now, db, sqlite } = datedHistoryFixture();
    const asset = makePeggedAsset({ supplySource: "defillama", circulating: { peggedUSD: 100 } });
    const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)");
    for (const [days, usd] of [[1, 99], [7, 95], [30, 85], [29, 90]]) {
      insert.run(asset.id, bucketUnixSecondsToUtcDay(now) - days * DAY_SECONDS, usd);
    }
    const rejected = { ...asset, supplyChangeBaselines: { day: null }, circulating: { peggedUSD: 130 } };
    const multiplePegs = { ...asset, circulating: { peggedUSD: 95, peggedEUR: 5 } };
    for (const [row, expected] of [[asset, [99, 95, 85]], [rejected, [null, 95, null]],
      [multiplePegs, [null, null, null]]] as const) {
      expect(await fillMissingSupplyHistory(db, [row])).toBe(expected.filter(x => x != null).length);
      expect((["day", "week", "month"] as const).map(window => getUsdMarketCapBaselineOrNull(row, window))).toEqual(expected);
    }
    expect(asset.supplyChangeBaselines).toBeUndefined();
    expect(rejected.supplyChangeBaselines).toEqual({ day: null });
    const dayAt = now - DAY_SECONDS;
    sqlite.prepare("UPDATE supply_history SET circulating_native = 99, supply_provenance = ? WHERE snapshot_date = ?")
      .run(historyProvenance("defillama", dayAt), bucketUnixSecondsToUtcDay(dayAt));
    const dated = { ...asset, circulatingPrevDay: null, supplyObservedAt: now, supplyChangeBaselines: { day: null } };
    expect(await fillMissingSupplyHistory(db, [dated])).toBe(0);
    expect(getUsdMarketCapBaselineOrNull(dated, "day")).toBeNull();
    expect(dated.circulatingPrevDay).toBeNull();
  });

  it("retains each rejected EUR valuation when only the weekly close becomes admissible", async () => {
    const { now, db, sqlite } = datedHistoryFixture();
    const bucket = { peggedEUR: 110 };
    const asset = makePeggedAsset({ id: "eurc-circle", pegType: "peggedEUR", supplySource: "coingecko-fallback",
      supplyObservedAt: now, circulating: bucket, circulatingPrevDay: bucket, circulatingPrevWeek: bucket,
      circulatingPrevMonth: bucket });
    for (const days of [1, 7, 30]) {
      const stockAt = now - days * DAY_SECONDS;
      sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, circulating_native,
        valuation_price_usd, valuation_observed_at_sec, supply_provenance) VALUES (?, ?, 100, 100, 1, ?, ?)`)
        .run(asset.id, bucketUnixSecondsToUtcDay(stockAt), stockAt - DAY_SECONDS, historyProvenance("onchain-total-supply", stockAt));
    }
    await fillMissingSupplyHistory(db, [asset]);
    expect(asset.supplyChangeBaselines).toEqual({ day: null, week: null, month: null });

    const weekAt = now - 7 * DAY_SECONDS;
    sqlite.prepare("UPDATE supply_history SET valuation_observed_at_sec = ? WHERE stablecoin_id = ? AND snapshot_date = ?")
      .run(weekAt, asset.id, bucketUnixSecondsToUtcDay(weekAt));
    await fillMissingSupplyHistory(db, [asset]);
    expect(asset.supplyChangeBaselines).toEqual({ day: null, week: {
      observedAt: weekAt, circulatingUsd: 100, circulatingNative: 100,
    }, month: null });
    expect(getUsdMarketCapBaselineOrNull(asset, "day")).toBeNull();
    expect(getUsdMarketCapBaselineOrNull(asset, "month")).toBeNull();
    const [wire] = shared.normalizeStablecoinsPayload({ peggedAssets: [asset] }, now).peggedAssets;
    expect([wire.circulatingPrevDay, wire.circulatingPrevWeek, wire.circulatingPrevMonth]).toEqual([
      {}, { peggedEUR: 100 }, {},
    ]);
    expect(asset.circulatingPrevWeek).toEqual(bucket);
  });

  it("compares same-source XAUT dollar caps while withholding unscoped native quantities", async () => {
    const { now, db, sqlite } = datedHistoryFixture();
    const asset = makePeggedAsset({ id: "xaut-tether", pegType: "peggedGOLD", supplySource: "coingecko-fallback",
      supplyObservedAt: now, circulating: { peggedGOLD: 3_300_000_000 }, circulatingNative: null });
    const weekAt = now - 7 * DAY_SECONDS;
    sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance)
      VALUES (?, ?, ?, ?, ?)`).run(asset.id, bucketUnixSecondsToUtcDay(weekAt), 3_000_000_000, 1_000_000, historyProvenance(asset.supplySource, weekAt));
    await fillMissingSupplyHistory(db, [asset]);
    expect(asset.supplyChangeBaselines?.week).toEqual({
      observedAt: weekAt, circulatingUsd: 3_000_000_000, circulatingNative: null,
    });
  });

  it.each([
    ["peggedUSD", "defillama", true],
    ["peggedEUR", "defillama", true],
    ["peggedEUR", "coingecko-fallback", false],
  ] as const)("compares dated %s DefiLlama caps against %s closes", async (peg, source, comparable) => {
    const { now, db, sqlite } = datedHistoryFixture();
    const stockAt = now - 60;
    const weekAt = stockAt - 7 * DAY_SECONDS;
    const asset = makePeggedAsset({ id: peg === "peggedUSD" ? "usdt-tether" : "eurc-circle", pegType: peg, supplySource: "defillama",
      supplyObservedAt: stockAt, circulating: { [peg]: 100_000_000 }, circulatingPrevWeek: { [peg]: 98_000_000 },
      circulatingNative: 100_000_000 / 0.999, valuationPriceUsd: 0.999, valuationObservedAtSec: null });
    sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, circulating_native,
      valuation_price_usd, valuation_observed_at_sec, supply_provenance) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(asset.id, bucketUnixSecondsToUtcDay(weekAt), 98_000_000, 98_000_000 / 0.999, 0.999,
        source === "defillama" ? null : weekAt, historyProvenance(source, weekAt));

    await fillMissingSupplyHistory(db, [asset]);
    const [wire] = shared.normalizeStablecoinsPayload({ peggedAssets: [asset] }, now).peggedAssets;
    expect(wire.supplyChangeBaselines?.week).toEqual(comparable
      ? { observedAt: weekAt, circulatingUsd: 98_000_000, circulatingNative: null } : null);
    if (comparable) expect(getCirculatingRawOrNull(wire)! - getUsdMarketCapBaselineOrNull(wire, "week")!).toBe(2_000_000);
    else expect(getUsdMarketCapBaselineOrNull(wire, "week")).toBeNull();
    expect(wire.circulatingPrevWeek).toEqual(comparable ? { [peg]: 98_000_000 } : {});
  });

  it("withholds a weekly ZSD dollar comparison when the current valuation is undated", async () => {
    const { now, db, sqlite } = datedHistoryFixture();
    const asset = makePeggedAsset({ id: "zsd-zephyr-protocol", supplySource: "zephyr-protocol-stats",
      supplyObservedAt: now, circulating: { peggedUSD: 100_000_000 }, circulatingNative: 100_000_000,
      valuationPriceUsd: 1, valuationObservedAtSec: null });
    const weekAt = now - 7 * DAY_SECONDS;
    sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, circulating_native,
      valuation_price_usd, valuation_observed_at_sec, supply_provenance) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(asset.id, bucketUnixSecondsToUtcDay(weekAt), 98_000_000, 100_000_000, 0.98, weekAt, historyProvenance(asset.supplySource, weekAt));
    await fillMissingSupplyHistory(db, [asset]);
    expect(getUsdMarketCapBaselineOrNull(asset, "week")).toBeNull();
    expect(asset.circulatingNative).toBe(100_000_000);
    expect(getCirculatingRawOrNull(asset)).toBe(100_000_000);
  });

  it("keeps USD list buckets but compares non-USD list caps only with the provider's snapshotted caps", async () => {
    const { now, db, sqlite } = datedHistoryFixture();
    // Non-USD list buckets price old balances at today's rate; D1 keeps each day's cap.
    const listed = JSON.stringify({ supplySource: "defillama", supplyObservedAt: null, supplyChainGuard: null,
      nativeQuantityUnavailable: true });
    const insert = sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, supply_provenance)
      VALUES (?, ?, ?, ?)`);
    const close = (days: number) => historyProvenance("coingecko-fallback", now - days * DAY_SECONDS);
    for (const [days, usd, provenance] of [[1, 514, listed], [2, 600, close(2)], [7, 519, close(7)], [30, 480, "malformed"]] as const) {
      for (const id of ["europ-schuman", "usd"]) insert.run(id, bucketUnixSecondsToUtcDay(now) - days * DAY_SECONDS, usd, provenance);
    }
    const list = (id = "europ-schuman", pegType = "peggedEUR") => makePeggedAsset({ id, pegType, supplySource: "defillama",
      circulating: { x: 503 }, circulatingPrevDay: { x: 513 }, circulatingPrevWeek: { x: 512 }, circulatingPrevMonth: { x: 511 } });
    const windows = ["day", "week", "month"] as const;
    const rows = [list(), list("unhistoried"), list("usd", "peggedUSD")];
    await fillMissingSupplyHistory(db, rows);
    expect(rows.map((row) => row.supplyChangeBaselines)).toEqual([{ week: null, month: null }, {}, { week: null, month: null }]);
    expect(rows.flatMap((row) => windows.map((window) => getUsdMarketCapBaselineOrNull(row, window))))
      .toEqual([514, null, null, null, null, null, 513, null, null]);
    sqlite.prepare("UPDATE supply_history SET supply_provenance = ?").run(listed);
    const complete = list();
    expect(await fillMissingSupplyHistory(db, [complete])).toBe(3);
    expect(complete.supplyChangeBaselines).toBeUndefined();
    expect(windows.map((window) => getUsdMarketCapBaselineOrNull(complete, window))).toEqual([514, 519, 480]);
    expect(await fillMissingSupplyHistory(db, [complete])).toBe(0);
  });

  it("keeps an explicit EUR week refusal despite a matching dated close", async () => {
    const { now, db, sqlite } = datedHistoryFixture();
    const asset = makePeggedAsset({ pegType: "peggedEUR", supplySource: "defillama", supplyObservedAt: now,
      circulating: { peggedEUR: 100 }, supplyChangeBaselines: { week: null } });
    const week = now - 7 * DAY_SECONDS;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, supply_provenance) VALUES (?, ?, ?, ?)")
      .run(asset.id, bucketUnixSecondsToUtcDay(week), 95, historyProvenance("defillama", week));
    const withheld = { ...asset, supplyChangeBaselines: {} };
    for (let attempt = 0; attempt < 2; attempt++) {
      await fillMissingSupplyHistory(db, [asset, withheld]);
      expect(asset.supplyChangeBaselines?.week).toBeNull();
      expect(withheld.supplyChangeBaselines).toEqual({});
    }
  });
  it("withholds at the original pre-fetch abort boundary after the FX await", async () => {
    const controller = new AbortController();
    vi.spyOn(shared, "loadFreshFxRates").mockImplementation(async () => {
      controller.abort("cancel intake");
      return { fxFallbackRates: undefined, validationReferences: undefined };
    });
    const progress = vi.fn();
    const fallbackToCoingecko = vi.fn(async () => fallbackResult);
    const result = await loadStablecoinsIntake({
      db: fixtures.open().db, syncStartSec: 1_777_000_000, signal: controller.signal,
      reportProgress: progress, fallbackToCoingecko,
    });
    if (result.kind !== "withheld") throw new Error("Expected cancelled intake");
    expect(JSON.parse(result.result.metadata!)).toMatchObject({
      reason: "aborted", stage: "fetch-stablecoins-and-supplementals", detail: "cancel intake",
    });
    expect(progress).not.toHaveBeenCalled();
    expect(supplemental.fetchCoinGeckoMarketData).not.toHaveBeenCalled();
    expect(fallbackToCoingecko).not.toHaveBeenCalled();
  });

  it.each([
    { label: "BUIDL native beats relisted supply", id: "buidl-blackrock", primary: 100, supplemental: 200, expected: 200, source: "onchain-total-supply", observedAt: 1_777_000_000 },
    { label: "BUIDL skipped native beats relisted supply", id: "buidl-blackrock", primary: 100, supplemental: null, expected: undefined, source: "onchain-supply-withheld", observedAt: undefined },
    { label: "EURCV preferred native beats DefiLlama list supply", id: "eurcv-societe-generale-forge", primary: 100, supplemental: 200, expected: 200, source: "onchain-total-supply", observedAt: 1_777_000_000 },
    { label: "EURC preferred circulating native beats DefiLlama list supply", id: "eurc-circle", primary: 100, supplemental: 200, expected: 200, source: "onchain-circulating-supply", observedAt: 1_777_000_000 },
    { label: "positive primary beats positive supplemental", primary: 100, supplemental: 200, expected: 100, source: "defillama", observedAt: 1_776_999_940 },
    { label: "observed zero beats positive supplemental", primary: 0, supplemental: 200, expected: 0, source: "defillama", observedAt: 1_776_999_940 },
    { label: "observed zero beats zero supplemental", primary: 0, supplemental: 0, expected: 0, source: "defillama", observedAt: 1_776_999_940 },
    { label: "absent primary admits positive supplemental", primary: "absent", supplemental: 200, expected: 200 },
    { label: "invalid primary admits positive supplemental", primary: -1, supplemental: 200, expected: 200 },
    { label: "omitted primary admits positive supplemental", primary: "omitted", supplemental: 200, expected: 200 },
    { label: "absent primary leaves supplemental unavailable", primary: "absent", supplemental: undefined, expected: undefined },
    { label: "invalid primary leaves supplemental unavailable", primary: -1, supplemental: undefined, expected: undefined },
    { label: "omitted providers leave no asset", primary: "omitted", supplemental: null, expected: undefined, source: null, observedAt: null },
  ])("$label with original supply provenance", async ({ id = "intake-supply-fixture", primary, supplemental: supplementalSupply, expected, source = "coingecko-fallback", observedAt = source === "onchain-supply-withheld" ? undefined : 1_777_000_000 }) => {
    const { db } = fixtures.open();
    const rows = Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({
      id: `intake-fixture-${index}`, circulating: { peggedUSD: 100 },
    }));
    if (primary !== "omitted") rows.push(makePeggedAsset({
      id, circulating: typeof primary === "number" ? { peggedUSD: primary } : {},
      supplySource: "defillama", supplyObservedAt: 1_776_999_940,
    }));
    vi.mocked(supplemental.fetchSupplementalTrackedTokens).mockResolvedValue({
      goldTokens: [], silverTokens: [], fiatCgTokens: supplementalSupply === null ? [] : [makePeggedAsset({
        id, circulating: supplementalSupply === undefined ? {} : { peggedUSD: supplementalSupply },
        supplySource: id === "eurc-circle" ? "onchain-circulating-supply"
          : id === "buidl-blackrock" || id === "eurcv-societe-generale-forge" ? "onchain-total-supply" : "coingecko-fallback", supplyObservedAt: 1_777_000_000,
      })],
    });
    upstream({ peggedAssets: rows });
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko: async () => fallbackResult });
    if (result.kind !== "main") throw new Error("Expected the healthy intake cohort");
    const matches = result.assets.filter((asset) => asset.id === id);
    expect(result.droppedMalformedAssets).toBe(primary === "absent" || primary === -1 ? 1 : 0);
    expect(matches).toHaveLength(source === null ? 0 : 1);
    if (source === null) return;
    expect(matches.map(({ id: assetId, circulating, supplySource, supplyObservedAt }) => ({
      id: assetId, circulating, supplySource, supplyObservedAt,
    }))).toEqual([{
      id, circulating: expected === undefined ? {} : { peggedUSD: expected },
      supplySource: source, supplyObservedAt: observedAt,
    }]);
    expect(matches[0].supplyRestored).toBeUndefined();
  });

  it.each([null, { peggedAssets: [] }])("takes an explicit fallback for a malformed or below-floor envelope", async (payload) => {
    const { db } = fixtures.open();
    upstream(payload);
    const fallbackToCoingecko = vi.fn(async () => fallbackResult);
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko });
    expect(result).toMatchObject({ kind: "fallback", result: fallbackResult });
    expect(fallbackToCoingecko).toHaveBeenCalledWith(cgData);
    expect(circuit.recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    expect(reconciliation.reconcileTrackedSupplyGaps).not.toHaveBeenCalled();
  });

  it("does not read the blocked DefiLlama provider and retains the fallback failure reason", async () => {
    const { db } = fixtures.open();
    vi.mocked(circuit.shouldAttemptFetch).mockResolvedValue(false);
    const fetch = upstream({ peggedAssets: [] });
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko: async () => fallbackResult });
    expect(result).toEqual({
      kind: "fallback", result: fallbackResult,
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(supplemental.fetchSupplementalTrackedTokens).not.toHaveBeenCalled();
  });

  it("withholds publication when both the guard state and the previous publication are unreadable", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run("stablecoins", "{", 1_776_999_000);
    insert.run("sync-stablecoins:chain-dropout-state", "{", 1_776_999_000);
    upstream({ peggedAssets: Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, index) => makePeggedAsset({ id: `intake-fixture-${index}`, circulating: { peggedUSD: 100 } })) });
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko: async () => fallbackResult });
    expect(result).toMatchObject({ kind: "withheld", result: { status: "degraded", itemCount: 0 } });
    if (result.kind !== "withheld") throw new Error("Expected a withheld generation");
    expect(JSON.parse(String(result.result.metadata))).toEqual({ reason: "supply-chain-guard-baselines-unavailable", previousCacheState: "malformed" });
  });

  it("defers exact-par USD list native derivation until high multi-source consensus", async () => {
    const syncStartSec = 1_795_347_918;
    const { db } = fixtures.open();
    const baseRows = Array.from({ length: MIN_VALID_ASSET_COUNT }, (_, i) => makePeggedAsset({
      id: `intake-fixture-${i}`, price: 0.9999 - i * 1e-6, circulating: { peggedUSD: 100 },
    }));
    const usdc = makePeggedAsset({ id: "2", symbol: "USDC", pegType: "peggedUSD", price: 1, priceSource: "defillama", circulating: { peggedUSD: 60_000_000_000 } });
    const eurc = makePeggedAsset({ id: "50", symbol: "EURC", pegType: "peggedEUR", price: 1.08, priceSource: "defillama", circulating: { peggedEUR: 500_000_000 } });
    upstream({ peggedAssets: [...baseRows, usdc, eurc] });
    const intake = await loadStablecoinsIntake({ db, syncStartSec, fallbackToCoingecko: async () => fallbackResult });
    if (intake.kind !== "main") throw new Error("Expected main intake");
    expect(intake.exactParUsdListObservations.get("usdc-circle")).toBe(60_000_000_000);
    expect(intake.exactParUsdListObservations.has("eurc-circle")).toBe(false);

    // 5+ rows at 1.0 triggers response-level fill default and must NOT be deferred.
    const fillRows = baseRows.map((row, i) => (i < 5 ? { ...row, price: 1 } : row));
    upstream({ peggedAssets: [...fillRows, { ...usdc }] });
    const fillIntake = await loadStablecoinsIntake({ db, syncStartSec, fallbackToCoingecko: async () => fallbackResult });
    if (fillIntake.kind !== "main") throw new Error("Expected main intake");
    expect(fillIntake.exactParUsdListObservations.has("usdc-circle")).toBe(false);

    const target = intake.assets.find((a) => a.id === "usdc-circle")!;
    const obs = intake.exactParUsdListObservations;
    for (const bad of [
      { price: 0.9999, priceSource: "coingecko", priceConfidence: "single-source" as const },
      { price: 0.9999, priceSource: "coingecko+defillama-list", priceConfidence: "high" as const },
      { price: 0.9999, priceSource: "bitstamp+coingecko", priceConfidence: "low" as const },
      { price: 0.9999, priceSource: "cached", priceConfidence: "fallback" as const },
      { price: 1, priceSource: "protocol-par+bitstamp", priceConfidence: "high" as const, priceObservedAtMode: "nominal_reference" as const },
      { price: 0.9999, priceSource: "bitstamp+coingecko+kraken", priceConfidence: "high" as const, supplyRestored: true },
    ]) {
      const clone = { ...target, ...bad };
      expect(deriveExactParListNativeQuantities([clone], obs, syncStartSec + 45)).toBe(0);
      expect(clone.circulatingNative).toBeNull();
    }
    const localFetch = { ...target, price: 0.99985, priceSource: "bitstamp+coingecko+kraken", priceConfidence: "high" as const, priceObservedAt: syncStartSec + 36, priceObservedAtMode: "local_fetch" as const };
    const upstreamClock = { ...target, id: "usdt-tether", price: 0.9999, priceSource: "coinbase+coingecko", priceConfidence: "high" as const, priceObservedAt: syncStartSec + 36, priceObservedAtMode: "upstream" as const };
    const map = new Map([["usdc-circle", 60_000_000_000], ["usdt-tether", 60_000_000_000]]);
    expect(deriveExactParListNativeQuantities([localFetch, upstreamClock], map, syncStartSec + 45)).toBe(2);
    expect(localFetch).toMatchObject({ circulatingNative: 60_000_000_000 / 0.99985, valuationPriceUsd: 0.99985, valuationObservedAtSec: null });
    expect(upstreamClock).toMatchObject({ circulatingNative: 60_000_000_000 / 0.9999, valuationPriceUsd: 0.9999, valuationObservedAtSec: syncStartSec + 36 });
  });

  it("pairs midnight-straddling finalized XAUT supply_history rows for 24h and 7d baselines", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd,
      circulating_native, valuation_price_usd, valuation_observed_at_sec, supply_provenance) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run("xaut-tether", 1795132800, 3_072_000_000, 749_423.56, 4100, 1795132832, historyProvenance("onchain-circulating-supply", 1795131863));
    insert.run("xaut-tether", 1795219200, 3_080_000_000, 750_000, 4106.67, 1795220130, historyProvenance("onchain-circulating-supply", 1795219031));
    const nov22Now = 1795347918;
    vi.spyOn(Date, "now").mockReturnValue(nov22Now * 1000);
    const nov22 = makePeggedAsset({
      id: "xaut-tether", pegType: "peggedGOLD", supplySource: "onchain-circulating-supply",
      supplyObservedAt: 1795307351, circulating: { peggedGOLD: 3_090_000_000 },
      circulatingNative: 751_000, valuationPriceUsd: 4114.51, valuationObservedAtSec: 1795308315,
    });
    await fillMissingSupplyHistory(db, [nov22], undefined, nov22Now);
    expect(nov22.supplyChangeBaselines?.day).toEqual({ observedAt: 1795219031, circulatingUsd: 3_080_000_000, circulatingNative: 750_000 });

    const nov27Now = Date.parse("2026-11-27T12:00:00Z") / 1000;
    vi.spyOn(Date, "now").mockReturnValue(nov27Now * 1000);
    const nov27 = makePeggedAsset({
      id: "xaut-tether", pegType: "peggedGOLD", supplySource: "onchain-circulating-supply",
      supplyObservedAt: nov27Now - 900, circulating: { peggedGOLD: 3_100_000_000 },
      circulatingNative: 752_000, valuationPriceUsd: 4122.34, valuationObservedAtSec: nov27Now - 60,
    });
    await fillMissingSupplyHistory(db, [nov27], undefined, nov27Now);
    expect(nov27.supplyChangeBaselines?.week).toEqual({ observedAt: 1795131863, circulatingUsd: 3_072_000_000, circulatingNative: 749_423.56 });
  });
});
