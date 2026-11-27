import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { CURVE_POOL_CONFIGS } from "@shared/lib/curve-pool-configs";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import * as circuit from "../../../lib/circuit-breaker";
import { fetchCoingeckoSimplePrices } from "../../../lib/coingecko-simple-price";
import { fetchBitstampPrices, fetchCoinbasePrices, fetchKrakenPrices } from "../../../lib/cex-tickers";
import { fetchCurveOnchainPrices, fetchCurveOracleEma } from "../../../lib/curve-onchain";
import { shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { buildPrimaryPricePlan, collectPrimaryProviderQuotes } from "../enrich-prices-primary-provider-collection";
import { fetchPrimaryPrices } from "../enrich-prices-primary";
import type { PeggedAsset } from "../enrich-prices-shared";
import * as hive from "../../../lib/hive-market-price";

vi.mock("../../../lib/circuit-breaker", async (importOriginal) => {
  const actual = await importOriginal<typeof circuit>();
  return {
    ...actual,
    shouldAttemptFetch: vi.fn(async () => false),
    recoverBreakerOnNoCandidate: vi.fn(async () => {}),
    // The no-candidate recovery test restores the real best-effort wrapper.
    recoverBreakerOnNoCandidateSafe: vi.fn(async () => {}),
  };
});
vi.mock("../../../lib/coingecko-simple-price", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/coingecko-simple-price")>()),
  fetchCoingeckoSimplePrices: vi.fn(),
}));
vi.mock("../../../lib/cex-tickers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/cex-tickers")>()),
  fetchBitstampPrices: vi.fn(),
  fetchCoinbasePrices: vi.fn(),
  fetchKrakenPrices: vi.fn(),
}));
vi.mock("../../../lib/curve-onchain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/curve-onchain")>()),
  fetchCurveOnchainPrices: vi.fn(),
  fetchCurveOracleEma: vi.fn(),
}));

vi.mock("../../../lib/depeg-helpers", () => ({
  createDexPriceSourceLoadTelemetry: vi.fn(() => ({
    staleRows: [],
    malformedRows: [],
  })),
  loadDexPrices: vi.fn(async () => ({ dexPriceRows: new Map(), dexPriceSources: new Map() })),
  loadDexPoolChallengers: vi.fn(async () => new Map()),
}));

const TEST_ASSET: PeggedAsset = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  geckoId: "test-usd",
  pegType: "peggedUSD",
};

const mockBitstampUsdc = (price: number, observedAt: number | null) =>
  vi.mocked(fetchBitstampPrices).mockResolvedValue({ kind: "ok", value: { prices: new Map([["USDC", price]]), observedAtBySymbol: new Map(observedAt == null ? [] : [["USDC", observedAt]]), diagnostics: [] } });

const mockCoinbaseOk = (entries: readonly [string, number, number, "USD" | "USDC", "book" | "trade"][], diagnostics: NonNullable<Awaited<ReturnType<typeof fetchCoinbasePrices>>["value"]["diagnostics"]> = []) =>
  vi.mocked(fetchCoinbasePrices).mockResolvedValue({ kind: "ok", value: { prices: new Map(entries.map(([s, p]) => [s, p])), observedAtBySymbol: new Map(entries.map(([s, , t]) => [s, t])), quoteAssetBySymbol: new Map(entries.map(([s, , , q]) => [s, q])), clockBySymbol: new Map(entries.map(([s, , , , c]) => [s, c])), diagnostics } });

describe("critical publication provider collection", () => {
  it("adds one HIVE batch dependency only for eligible HBD, never a candidate row", async () => {
    const plain = await buildPrimaryPricePlan([TEST_ASSET], mockD1([]));
    expect(plain.geckoIds).not.toContain("hive");
    const hbd = { ...TEST_ASSET, id: "hbd-hive", geckoId: "hive_dollar" };
    const plan = await buildPrimaryPricePlan([hbd, TEST_ASSET], mockD1([]));
    expect(plan.geckoIds).toEqual(["hive_dollar", "test-usd", "hive"]);
    expect(plan.candidates.map((asset) => asset.id)).toEqual(["hbd-hive", "test-usd"]);
  });

  it("serializes native collection behind CG and records one healthy outcome for shallow market evidence", async () => {
    const db = mockD1([]);
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, key) => key === CIRCUIT_SOURCE.CG_PRICES || key === CIRCUIT_SOURCE.HIVE_MARKET);
    const plan = await buildPrimaryPricePlan([{ ...TEST_ASSET, id: "hbd-hive", geckoId: "hive_dollar" }, TEST_ASSET], db);
    const evidence = await hive.fetchHiveNativeHbdPrice(undefined);
    evidence.diagnostic.rpcCount = 2;
    evidence.diagnostic.rejectionReason = "insufficient_depth";
    const order: string[] = [];
    vi.mocked(fetchCoingeckoSimplePrices).mockImplementation(async () => {
      order.push("cg");
      return { kind: "ok", value: new Map([["hive", { price: 0.05, observedAt: plan.nowSec, observedAtMode: "upstream" }], ["test-usd", { price: 1, observedAt: plan.nowSec, observedAtMode: "upstream" }]]) };
    });
    const native = vi.spyOn(hive, "fetchHiveNativeHbdPrice").mockImplementation(async (parent) => {
      expect(parent).toMatchObject({ id: "hive", price: 0.05 });
      order.push("hive");
      return evidence;
    });
    const outcomes = vi.spyOn(circuit, "recordOutcomeSafe");
    const result = await collectPrimaryProviderQuotes({ db, plan });
    expect(order).toEqual(["cg", "hive"]);
    expect(native).toHaveBeenCalledOnce();
    expect(outcomes.mock.calls.map(([, key, ok]) => [key, ok])).toEqual([[CIRCUIT_SOURCE.CG_PRICES, true], [CIRCUIT_SOURCE.HIVE_MARKET, true]]);
    expect(result.quoteMaps.cgQuotes.get("test-usd")?.price).toBe(1);
    expect(result.quoteMaps.hiveNativeQuote).toBeNull();
    expect(result.providerDiagnostics[0].assetAttempts?.[0]).toMatchObject({ result: "rejected", rejectionClass: "insufficient_depth" });
  });

  it("does not start a native request with denied CG or after inherited abort", async () => {
    const db = mockD1([]);
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, key) => key === CIRCUIT_SOURCE.HIVE_MARKET);
    const plan = await buildPrimaryPricePlan([{ ...TEST_ASSET, id: "hbd-hive", geckoId: "hive_dollar" }], db);
    const result = await collectPrimaryProviderQuotes({ db, plan });
    expect(result.providerDiagnostics[0].nativeMarket).toMatchObject({ rpcCount: 0, rejectionReason: "hive_usd_unavailable" });
    const native = vi.spyOn(hive, "fetchHiveNativeHbdPrice");
    const controller = new AbortController(); controller.abort();
    await expect(collectPrimaryProviderQuotes({ db, plan, signal: controller.signal })).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fetchCoingeckoSimplePrices).mockReset();
    vi.mocked(fetchBitstampPrices).mockReset();
    vi.mocked(fetchCoinbasePrices).mockReset();
    vi.mocked(fetchKrakenPrices).mockReset();
    vi.mocked(fetchCurveOnchainPrices).mockReset();
    vi.mocked(fetchCurveOracleEma).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only checks the eight active primary provider circuits in the 15-minute plan", async () => {
    await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(shouldAttemptFetch).toHaveBeenCalledTimes(8);
    expect(vi.mocked(shouldAttemptFetch).mock.calls.map(([, source]) => source)).toEqual([
      CIRCUIT_SOURCE.CG_PRICES,
      CIRCUIT_SOURCE.BINANCE_PRICES,
      CIRCUIT_SOURCE.KRAKEN_PRICES,
      CIRCUIT_SOURCE.BITSTAMP_PRICES,
      CIRCUIT_SOURCE.COINBASE_PRICES,
      CIRCUIT_SOURCE.CURVE_ONCHAIN,
      CIRCUIT_SOURCE.CURVE_ORACLE,
      CIRCUIT_SOURCE.HIVE_MARKET,
    ]);
  });

  async function admittedCgPlan(db: D1Database) {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CG_PRICES);
    return buildPrimaryPricePlan([TEST_ASSET], db);
  }

  function failingBookkeepingDb() {
    const db = mockD1([]);
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("outcome cache unavailable"); });
    return db;
  }

  it.each([
    ["ok", { kind: "ok" as const, value: new Map([["test-usd", { price: 1.002, observedAt: 1, observedAtMode: "upstream" as const }]]) }, true, false],
    ["throw", new Error("provider unavailable"), false, true],
    ["upstream-error", { kind: "upstream-error" as const, value: new Map(), reason: "upstream-unavailable" }, false, false],
  ] as const)("handles CG %s outcome cleanly when circuit bookkeeping fails", async (_mode, response, ok, warnsFetchFail) => {
    const db = failingBookkeepingDb(), plan = await admittedCgPlan(db);
    if (response instanceof Error) vi.mocked(fetchCoingeckoSimplePrices).mockRejectedValue(response);
    else vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue(response);
    const outcomes = vi.spyOn(circuit, "recordOutcomeSafe"), warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await collectPrimaryProviderQuotes({ db, plan });
    expect(result.quoteMaps.cgQuotes.size).toBe(ok ? 1 : 0);
    if (ok) expect(result.providerDiagnostics).toEqual([]);
    expect(outcomes.mock.calls.map(([, s, v]) => [s, v])).toEqual([[CIRCUIT_SOURCE.CG_PRICES, ok]]);
    expect(fetchCoingeckoSimplePrices).toHaveBeenCalledOnce();
    const messages = warnings.mock.calls.flat().join(" ");
    expect(messages).toContain("circuit_outcome_write_failed");
    expect(messages.includes("[primary-prices] CG price API failed:")).toBe(warnsFetchFail);
  });

  it("carries Kraken Depth upstream clocks and scopes colliding OUSD and USDS symbols", async () => {
    const db = mockD1([]), now = 1_800_000_000, observedAt = now - 12;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, k) => k === CIRCUIT_SOURCE.KRAKEN_PRICES || k === CIRCUIT_SOURCE.COINBASE_PRICES);
    expect((await buildPrimaryPricePlan([{ id: "ousd-origin-protocol", name: "Origin Dollar", symbol: "OUSD" }], db)).krakenSymbols).toEqual([]);
    const arqOnly = await buildPrimaryPricePlan([{ id: "usds-arq", name: "ARQ USDs", symbol: "USDS" }], db);
    expect([arqOnly.krakenSymbols, arqOnly.coinbaseSymbols]).toEqual([[], []]);
    const assets: PeggedAsset[] = [
      { ...TEST_ASSET, id: "eurcv-societe-generale-forge", symbol: "EURCV", pegType: "peggedEUR" },
      { ...TEST_ASSET, id: "ousd-open-standard", symbol: "OUSD", geckoId: "open-usd" },
      { ...TEST_ASSET, id: "ousd-origin-protocol", symbol: "OUSD", geckoId: "origin-dollar" },
      { ...TEST_ASSET, id: "usds-sky", symbol: "USDS", geckoId: "usds" },
      { ...TEST_ASSET, id: "usds-arq", symbol: "USDS" },
    ];
    const plan = await buildPrimaryPricePlan(assets, db);
    expect([plan.krakenSymbols, plan.coinbaseSymbols]).toEqual([["EURCV", "OUSD", "USDS"], ["USDS"]]);
    vi.mocked(fetchKrakenPrices).mockResolvedValue({ kind: "ok", value: { prices: new Map([["EURCV", 1.0975], ["OUSD", 0.99995], ["USDS", 0.9999]]), observedAtBySymbol: new Map([["EURCV", observedAt], ["OUSD", observedAt], ["USDS", observedAt]]), quoteBasisBySymbol: new Map([["EURCV", "bid-ask-midpoint"], ["OUSD", "bid-ask-midpoint"]]), diagnostics: [] } });
    mockCoinbaseOk([["USDS", 1.0001, observedAt, "USD", "book"]]);
    const outcomes = vi.spyOn(circuit, "recordOutcomeSafe");
    expect((await collectPrimaryProviderQuotes({ db, plan })).quoteMaps.krakenObservedAt).toBeNull();
    expect(outcomes.mock.calls.map(([, k, ok]) => [k, ok])).toEqual([[CIRCUIT_SOURCE.KRAKEN_PRICES, true], [CIRCUIT_SOURCE.COINBASE_PRICES, true]]);
    const { results } = await fetchPrimaryPrices(assets, db);
    expect(results.get("eurcv-societe-generale-forge")).toMatchObject({ source: "kraken", observedAt, observedAtMode: "upstream" });
    expect(results.get("ousd-open-standard")).toMatchObject({ source: "kraken", observedAt, observedAtMode: "upstream" });
    expect(results.get("usds-sky")).toMatchObject({ source: "coinbase+kraken", agreeSources: ["kraken", "coinbase"] });
    expect([results.has("ousd-origin-protocol"), results.has("usds-arq")]).toEqual([false, false]);
  });

  it("keeps a collected quote when no-candidate breaker recovery cannot persist its circuit record", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Kraken has a half-open breaker but no candidate symbol for this run, so
    // collection schedules the no-candidate recovery bookkeeping write. The
    // circuit row read succeeds; persisting the recovered record fails.
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: `circuit:${CIRCUIT_SOURCE.KRAKEN_PRICES}`,
            value: JSON.stringify({
              state: "half-open",
              consecutiveFailures: 3,
              lastFailureAt: nowSec - 900,
              lastSuccessAt: null,
              openedAt: nowSec - 1800,
            }),
            updated_at: nowSec,
          },
        ],
      },
      { match: "INSERT INTO cache", rows: [], throwError: new Error("circuit cache write unavailable") },
    ]);
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CG_PRICES);
    const actualCircuit = await vi.importActual<typeof circuit>("../../../lib/circuit-breaker");
    const directRecovery = vi.mocked(circuit.recoverBreakerOnNoCandidate);
    const safeRecovery = vi.mocked(circuit.recoverBreakerOnNoCandidateSafe);
    directRecovery.mockImplementation(actualCircuit.recoverBreakerOnNoCandidate);
    safeRecovery.mockImplementation(actualCircuit.recoverBreakerOnNoCandidateSafe);
    try {
      const plan = await buildPrimaryPricePlan([TEST_ASSET], db);
      expect(plan.krakenSymbols).toEqual([]);

      const quote = { price: 1.002, observedAt: plan.nowSec, observedAtMode: "upstream" as const };
      vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue({ kind: "ok", value: new Map([["test-usd", quote]]) });

      const result = await collectPrimaryProviderQuotes({ db, plan });

      // Bookkeeping is best-effort: the circuit write fails, the collected CG
      // quote still publishes instead of the whole fan-out rejecting.
      expect(result.quoteMaps.cgQuotes.get("test-usd")).toEqual(quote);
    } finally {
      directRecovery.mockReset().mockImplementation(async () => {});
      safeRecovery.mockReset().mockImplementation(async () => {});
    }
  });

  it("propagates an aborted provider rejection without recording a failed observation", async () => {
    const db = mockD1([]);
    const plan = await admittedCgPlan(db);
    const controller = new AbortController();
    const failure = new Error("provider cancelled");
    vi.mocked(fetchCoingeckoSimplePrices).mockImplementation(async () => {
      controller.abort(failure);
      throw failure;
    });
    const outcomes = vi.spyOn(circuit, "recordOutcomeSafe");

    await expect(collectPrimaryProviderQuotes({ db, plan, signal: controller.signal })).rejects.toBe(failure);
    expect(outcomes).not.toHaveBeenCalled();
  });

  it("returns an inert plan when no asset qualifies for any primary source", async () => {
    const plan = await buildPrimaryPricePlan([{ id: "unlisted-test", name: "Unlisted", symbol: "ZZZZ" }], mockD1([]));
    expect(plan).toMatchObject({ candidates: [], geckoIds: [], coinbaseSymbols: [], krakenSymbols: [], shouldFetchBitstamp: false, navPriceIds: [] });
    expect(Object.values(plan.sourceAllowed)).toEqual(Array(8).fill(false));
    expect(shouldAttemptFetch).not.toHaveBeenCalled();
  });

  it("values a non-USD reserve NAV quote at its admitted FX reference rate", async () => {
    const meta = TRACKED_META_BY_ID.get("eutbl-spiko")!, config = meta.liveReservesConfig!, fetchedAt = Math.floor(Date.now() / 1000) - 60;
    const fp = computeLiveReserveConfigFingerprint(config);
    const db = mockD1([{ match: "FROM reserve_composition", rows: [{ stablecoin_id: "eutbl-spiko", fetched_at: fetchedAt, source: config.adapter, metadata: JSON.stringify({ navPerToken: 1.25, sourceTimestamp: fetchedAt }), config_fingerprint: fp, attempt_id: "a1", last_success_at: fetchedAt, last_success_attempt_id: "a1", state_config_fingerprint: fp, last_attempt_id: "a1", pending_attempt_id: null }] }]);
    const plan = await buildPrimaryPricePlan([{ id: "eutbl-spiko", name: "EUTBL", symbol: "EUTBL", pegType: "peggedEUR" }], db);
    expect(plan.navPriceIds).toEqual(["eutbl-spiko"]);
    const result = await collectPrimaryProviderQuotes({ db, plan, references: { rates: { peggedEUR: 1.08 }, type: "fresh", updatedAt: fetchedAt, typeByPeg: { peggedEUR: "fresh" } } });
    expect(result.quoteMaps.navPrices.get("eutbl-spiko")).toMatchObject({ source: config.adapter, price: 1.25 * 1.08, metadata: { reserveFetchedAt: fetchedAt, navPerToken: 1.25, navUsdRate: 1.08 } });
  });

  it("keeps provider quotes when the reserve NAV telemetry query fails", async () => {
    const db = mockD1([{ match: "FROM reserve_composition", rows: [], throwError: new Error("reserve database unavailable") }]);
    const plan = await buildPrimaryPricePlan([{ id: "eutbl-spiko", name: "EUTBL", symbol: "EUTBL", pegType: "peggedEUR" }], db);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await collectPrimaryProviderQuotes({ db, plan })).quoteMaps.navPrices.size).toBe(0);
    expect(warnings.mock.calls.flat().join(" ")).toContain("[primary-prices] Failed to load reserve NAV telemetry: reserve database unavailable");
  });

  it("collects Coinbase quotes with their per-symbol observation clocks", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.COINBASE_PRICES);
    const db = mockD1([]), plan = await buildPrimaryPricePlan([{ id: "test-usdt", name: "Test USDT", symbol: "USDT" }], db);
    expect(plan.coinbaseSymbols).toEqual(["USDT"]);
    mockCoinbaseOk([["USDT", 1.0004, 1_700_000_000, "USD", "trade"]], [{ source: "coinbase", stage: "primary", endpoint: "api.exchange.coinbase.com/products", status: null, ok: true, success: true, rejectionReasonCounts: { "wide-spread": 1 } }]);
    const result = await collectPrimaryProviderQuotes({ db, plan });
    expect([result.quoteMaps.coinbasePrices.get("USDT"), result.quoteMaps.coinbaseObservedAtBySymbol.get("USDT")]).toEqual([1.0004, 1_700_000_000]);
    expect(result.providerDiagnostics).toContainEqual(expect.objectContaining({ source: "coinbase", rejectionReasonCounts: { "wide-spread": 1 } }));
  });

  it.each([[60, true], [-1, true], [-6, false], [601, false], [null, false]] as const)(
    "requires a fresh independent USDC/USD anchor for Coinbase (anchor age %s)", async (age, accepted) => {
      vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.COINBASE_PRICES || source === CIRCUIT_SOURCE.BITSTAMP_PRICES);
      const db = mockD1([]), plan = await buildPrimaryPricePlan([{ ...TEST_ASSET, id: "audd-novatti", symbol: "AUDD" }], db), now = Math.floor(Date.now() / 1000);
      mockBitstampUsdc(0.87, age == null ? null : now - age);
      mockCoinbaseOk([["AUDD", 0.65 / 0.87, now - 20, "USDC", "book"]]);
      const { quoteMaps, providerDiagnostics } = await collectPrimaryProviderQuotes({ db, plan });
      expect(fetchBitstampPrices).toHaveBeenCalledOnce();
      expect(quoteMaps.coinbasePrices.has("AUDD")).toBe(accepted);
      expect(providerDiagnostics).toContainEqual(expect.objectContaining({ quoteClock: "book", quoteObservedAt: now - 20, resolvedCount: accepted ? 1 : 0 }));
      if (accepted) {
        expect(quoteMaps.coinbasePrices.get("AUDD")).toBeCloseTo(0.65, 8);
        expect(quoteMaps.coinbaseObservedAtBySymbol.get("AUDD")).toBe(Math.min(now - 20, now - age!));
      }
    },
  );

  it("collects and converts Coinbase EURC-USDC and TGBP-USDC book quotes with upstream clocks", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    vi.spyOn(circuit, "recordOutcomeSafe").mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.COINBASE_PRICES || source === CIRCUIT_SOURCE.BITSTAMP_PRICES);
    const db = mockD1([]), assets: PeggedAsset[] = [{ id: "eurc-circle", name: "EURC", symbol: "EURC", pegType: "peggedEUR" }, { id: "tgbp-tokenised", name: "Tokenised GBP", symbol: "tGBP", pegType: "peggedGBP" }];
    const plan = await buildPrimaryPricePlan(assets, db);
    expect([plan.coinbaseSymbols, plan.shouldFetchBitstamp]).toEqual([["EURC", "TGBP"], true]);
    mockBitstampUsdc(0.9998, now - 30);
    mockCoinbaseOk([["EURC", 1.0943, now - 10, "USDC", "book"], ["TGBP", 1.30815, now - 45, "USDC", "book"]]);
    const { results, providerDiagnostics } = await fetchPrimaryPrices(assets, db);
    expect(results.get("eurc-circle")).toMatchObject({ source: "coinbase", observedAt: now - 30, observedAtMode: "upstream" });
    expect(results.get("eurc-circle")?.price).toBeCloseTo(1.0943 * 0.9998, 8);
    expect(results.get("tgbp-tokenised")).toMatchObject({ source: "coinbase", observedAt: now - 45, observedAtMode: "upstream" });
    expect(results.get("tgbp-tokenised")?.price).toBeCloseTo(1.30815 * 0.9998, 8);
    expect(providerDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: "api.exchange.coinbase.com/products/EURC-USDC/book", quoteClock: "book", quoteObservedAt: now - 10, resolvedCount: 1 }),
      expect.objectContaining({ endpoint: "api.exchange.coinbase.com/products/TGBP-USDC/book", quoteClock: "book", quoteObservedAt: now - 45, resolvedCount: 1 }),
    ]));
  });

  it.each([
    ["coinbase", "book", 1], ["coinbase", "trade", 1], ["coinbase", "trade", 2],
    ["curve-onchain", null, 1], ["curve-onchain", null, 2],
  ] as const)("checks the %s anchor at decision time (%s, %s seconds of fetch latency)", async (source, clock, delay) => {
    const now = 1_800_000_000;
    const date = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const circuitSource = source === "coinbase" ? CIRCUIT_SOURCE.COINBASE_PRICES : CIRCUIT_SOURCE.CURVE_ONCHAIN;
    const asset = clock ? { ...TEST_ASSET, id: "audd-novatti", symbol: "AUDD" }
      : { ...TEST_ASSET, id: "pmusd-precious-metals", symbol: "PMUSD" };
    const budget = getPricingSourceRegistryEntry(source)!.maxTrustedAgeSec!;
    const anchorAt = now - budget + 1;
    vi.spyOn(circuit, "recordOutcomeSafe").mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, key) =>
      key === CIRCUIT_SOURCE.BITSTAMP_PRICES || key === circuitSource);
    mockBitstampUsdc(0.87, anchorAt);
    if (clock) vi.mocked(fetchCoinbasePrices).mockImplementation(async () => {
      date.mockReturnValue((now + delay) * 1000);
      return { kind: "ok", value: { prices: new Map([["AUDD", 1 / 0.87]]), observedAtBySymbol: new Map([["AUDD", now]]),
        quoteAssetBySymbol: new Map([["AUDD", "USDC"]]), clockBySymbol: new Map([["AUDD", clock]]), diagnostics: [] } };
    });
    else vi.mocked(fetchCurveOnchainPrices).mockImplementation(async (_configs, anchor) => {
      date.mockReturnValue((now + delay) * 1000);
      return { kind: "ok", value: { prices: new Map([[asset.id, 1]]), observedAtByCoinId: new Map([[asset.id, anchor!.observedAt]]),
        pricePoolKeysByCoinId: new Map(), routeTypeByCoinId: new Map(), hopDepthByCoinId: new Map() } };
    });
    const { results, providerDiagnostics } = await fetchPrimaryPrices([asset], mockD1([]));
    if (delay === 1) {
      expect(results.get(asset.id)).toMatchObject({ source, observedAt: anchorAt });
      expect(results.get(asset.id)?.price).toBeCloseTo(1);
    } else {
      expect(results.has(asset.id)).toBe(false);
    }
    if (clock) expect(providerDiagnostics).toContainEqual(expect.objectContaining({
      endpoint: `api.exchange.coinbase.com/products/AUDD-USDC/${clock === "book" ? "book" : "ticker"}`,
      quoteClock: clock, quoteObservedAt: now,
    }));
  });

  it("collects Curve pool quotes with their per-coin observation clocks", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) =>
      source === CIRCUIT_SOURCE.CURVE_ONCHAIN || source === CIRCUIT_SOURCE.BITSTAMP_PRICES);
    const coinId = CURVE_POOL_CONFIGS[0].stablecoinId;
    const db = mockD1([]);
    const plan = await buildPrimaryPricePlan([
      { id: coinId, name: "Curve coin", symbol: "CRVCOIN" },
    ], db);
    const anchorAt = Math.floor(Date.now() / 1000) - 60;
    mockBitstampUsdc(0.87, anchorAt);
    vi.mocked(fetchCurveOnchainPrices).mockResolvedValue({
      kind: "ok",
      value: {
        prices: new Map([[coinId, 0.9995]]),
        observedAtByCoinId: new Map([[coinId, 1_700_000_000]]),
        pricePoolKeysByCoinId: new Map(),
        routeTypeByCoinId: new Map(),
        hopDepthByCoinId: new Map(),
        sellGuardRejections: [{
          stablecoinId: "pmusd-precious-metals", chain: "ethereum",
          poolAddress: "0xEcb0F0d68C19BdAaDAEbE24f6752A4Db34e2c2cb", reason: "insufficient-sell-depth",
        }],
      },
    });
    const result = await collectPrimaryProviderQuotes({ db, plan });
    expect(fetchCurveOnchainPrices).toHaveBeenCalledWith(CURVE_POOL_CONFIGS, { price: 0.87, observedAt: anchorAt }, undefined, undefined);
    expect(result.quoteMaps.curvePrices.get(coinId)).toBe(0.9995);
    expect(result.quoteMaps.curveObservedAtByCoinId.get(coinId)).toBe(1_700_000_000);
    expect(result.providerDiagnostics).toContainEqual(expect.objectContaining({
      source: "curve-onchain", success: true, resolvedCount: 1,
      rejectionReasonCounts: { "missing-liquidity": 1 }, sellGuardRejectionCounts: { "insufficient-sell-depth": 1 },
      assetAttempts: [expect.objectContaining({ assetId: "pmusd-precious-metals", rejectionClass: "insufficient-sell-depth", result: "rejected" })],
    }));
  });

  it("admits a fresh crvUSD oracle EMA as a primary quote", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, s) => s === CIRCUIT_SOURCE.CURVE_ORACLE);
    const db = mockD1([]), plan = await buildPrimaryPricePlan([{ id: "crvusd-curve", name: "crvUSD", symbol: "CRVUSD" }], db);
    const blockTimestamp = Math.floor(Date.now() / 1000) - 15;
    vi.mocked(fetchCurveOracleEma).mockResolvedValue({ price: 0.9987, blockNumber: 123, blockTimestamp });
    const result = await collectPrimaryProviderQuotes({ db, plan });
    expect([result.quoteMaps.curveOraclePrice, result.quoteMaps.curveOracleObservedAt]).toEqual([0.9987, blockTimestamp]);
  });

  it("does not fetch when required circuit admission rejects", async () => {
    const failure = new Error("admission unavailable");
    vi.mocked(shouldAttemptFetch).mockRejectedValue(failure);
    await expect(buildPrimaryPricePlan([TEST_ASSET], mockD1([]))).rejects.toBe(failure);
    expect(fetchCoingeckoSimplePrices).not.toHaveBeenCalled();
  });
});
