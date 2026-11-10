import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { loadStablecoinsIntake } from "../intake";
import * as supplemental from "../supplemental-assets";
import * as reconciliation from "../supply-gap-reconciliation";
import * as transport from "../../../lib/fetch-retry";
import * as circuit from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE, MIN_VALID_ASSET_COUNT } from "../../../lib/constants";
import { makePeggedAsset } from "./_fixtures";
import * as shared from "../shared";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { StablecoinDataSchema } from "@shared/types/market";
import { fetchFiatCoinGeckoTokens, FIAT_CG_METAS } from "../supplemental-assets/fiat-cg";
import * as supplementalPrices from "../supplemental-assets/shared";
import * as onchainSupply from "../supplemental-assets/onchain-supply";
import * as structuredLog from "../../../lib/structured-log";

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

describe("stablecoin intake admission", () => {
  it.each(["onchain-total-supply", "coingecko-fallback"])(
    "keeps preferred STAC with a fresh price after failed native reads and a cached %s row", async (supplySource) => {
      const nowSec = 1_777_000_000;
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      const meta = ACTIVE_META_BY_ID.get("stac-securitize")!;
      const previous = makePeggedAsset({
        id: meta.id, name: meta.name, symbol: meta.symbol, geckoId: meta.geckoId,
        pegMechanism: meta.flags.backing, price: 1.05, priceSource: "coingecko",
        priceConfidence: "single-source", priceObservedAt: nowSec - 60, priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 300 }, supplySource, supplyObservedAt: nowSec - 120,
        chainCirculating: { Ethereum: { chainId: "ethereum", current: 100 }, Solana: { chainId: "solana", current: 200 } },
        chains: ["Ethereum", "Solana"],
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
    upstream({ peggedAssets: [...rows, null], fxFallbackRates: { EUR: 1.1, BAD: "missing" } });
    const fallbackToCoingecko = vi.fn(async () => fallbackResult);
    const result = await loadStablecoinsIntake({ db, syncStartSec: 1_777_000_000, fallbackToCoingecko });
    expect(result.kind).toBe("main");
    if (result.kind !== "main") throw new Error("Expected the healthy intake cohort");
    expect(result.rawAssetCount).toBe(MIN_VALID_ASSET_COUNT + 1);
    expect(result.droppedMalformedAssets).toBe(1);
    expect(result.assets.find((asset) => asset.id === "intake-fixture-0")?.circulating).toEqual({ peggedUSD: 0 });
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
      cgData, undefined, undefined, undefined, fxFallbackRates, db, expect.any(Map), undefined, undefined,
    );
    expect(result.fxFallbackRates).toBe(fxFallbackRates);
    expect(result.validationReferences).toBe(validationReferences);
    expect(result.assets.find((asset) => asset.id === rows[0].id)).toMatchObject({
      circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 90 },
      chainCirculating: { Ethereum: { current: 100, circulatingPrevDay: 90 } },
      supplyObservedAt: 1_776_999_940,
    });
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
    { label: "positive primary beats positive supplemental", primary: 100, supplemental: 200, expected: 100, source: "defillama", observedAt: 1_776_999_940 },
    { label: "observed zero beats positive supplemental", primary: 0, supplemental: 200, expected: 0, source: "defillama", observedAt: 1_776_999_940 },
    { label: "observed zero beats zero supplemental", primary: 0, supplemental: 0, expected: 0, source: "defillama", observedAt: 1_776_999_940 },
    { label: "absent primary admits positive supplemental", primary: "absent", supplemental: 200, expected: 200, source: "coingecko-fallback", observedAt: 1_777_000_000 },
    { label: "invalid primary admits positive supplemental", primary: -1, supplemental: 200, expected: 200, source: "coingecko-fallback", observedAt: 1_777_000_000 },
    { label: "omitted primary admits positive supplemental", primary: "omitted", supplemental: 200, expected: 200, source: "coingecko-fallback", observedAt: 1_777_000_000 },
    { label: "absent primary leaves supplemental unavailable", primary: "absent", supplemental: undefined, expected: undefined, source: "coingecko-fallback", observedAt: 1_777_000_000 },
    { label: "invalid primary leaves supplemental unavailable", primary: -1, supplemental: undefined, expected: undefined, source: "coingecko-fallback", observedAt: 1_777_000_000 },
    { label: "omitted providers leave no asset", primary: "omitted", supplemental: null, expected: undefined, source: null, observedAt: null },
  ])("$label with original supply provenance", async ({ primary, supplemental: supplementalSupply, expected, source, observedAt }) => {
    const { db } = fixtures.open();
    const id = "intake-supply-fixture";
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
        supplySource: "coingecko-fallback", supplyObservedAt: 1_777_000_000,
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
});
