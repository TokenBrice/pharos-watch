import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { CURVE_POOL_CONFIGS } from "@shared/lib/curve-pool-configs";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import * as circuit from "../../../lib/circuit-breaker";
import { fetchCoingeckoSimplePrices } from "../../../lib/coingecko-simple-price";
import { fetchCgTickerPricesDetailed } from "../../../lib/cg-ticker";
import { fetchCoinbasePrices } from "../../../lib/cex-tickers";
import { fetchCurveOnchainPrices, fetchCurveOracleEma } from "../../../lib/curve-onchain";
import { shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { buildPrimaryPricePlan, collectPrimaryProviderQuotes } from "../enrich-prices-primary-provider-collection";
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
vi.mock("../../../lib/coingecko-simple-price", () => ({ fetchCoingeckoSimplePrices: vi.fn() }));
vi.mock("../../../lib/cg-ticker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/cg-ticker")>()),
  fetchCgTickerPricesDetailed: vi.fn(),
}));
vi.mock("../../../lib/cex-tickers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/cex-tickers")>()),
  fetchCoinbasePrices: vi.fn(),
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
}));

const TEST_ASSET: PeggedAsset = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  geckoId: "test-usd",
  pegType: "peggedUSD",
};

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
    vi.mocked(fetchCgTickerPricesDetailed).mockReset();
    vi.mocked(fetchCoinbasePrices).mockReset();
    vi.mocked(fetchCurveOnchainPrices).mockReset();
    vi.mocked(fetchCurveOracleEma).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps all nine primary provider circuits in the 15-minute plan", async () => {
    await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(shouldAttemptFetch).toHaveBeenCalledTimes(9);
    expect(vi.mocked(shouldAttemptFetch).mock.calls.map(([, source]) => source)).toEqual([
      CIRCUIT_SOURCE.CG_PRICES,
      CIRCUIT_SOURCE.CG_TICKER,
      CIRCUIT_SOURCE.BINANCE_PRICES,
      CIRCUIT_SOURCE.KRAKEN_PRICES,
      CIRCUIT_SOURCE.BITSTAMP_PRICES,
      CIRCUIT_SOURCE.COINBASE_PRICES,
      CIRCUIT_SOURCE.CURVE_ONCHAIN,
      CIRCUIT_SOURCE.CURVE_ORACLE,
      CIRCUIT_SOURCE.HIVE_MARKET,
    ]);
  });

  it("does not report every primary circuit open when the ticker lane is available", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CG_TICKER);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const plan = await buildPrimaryPricePlan([TEST_ASSET], {} as D1Database);

    expect(plan.sourceAllowed.cgTicker).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("All live primary fetch circuits are open"),
    );
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

  it("retains successful provider quotes when circuit bookkeeping fails without recording a false outcome", async () => {
    const db = failingBookkeepingDb();
    const plan = await admittedCgPlan(db);
    const quote = { price: 1.002, observedAt: plan.nowSec, observedAtMode: "upstream" as const };
    vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue({ kind: "ok", value: new Map([["test-usd", quote]]) });
    const outcomes = vi.spyOn(circuit, "recordOutcomeSafe");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.cgQuotes.get("test-usd")).toEqual(quote);
    expect(result.providerDiagnostics).toEqual([]);
    expect(outcomes.mock.calls.map(([, source, success]) => [source, success])).toEqual([[CIRCUIT_SOURCE.CG_PRICES, true]]);
    expect(fetchCoingeckoSimplePrices).toHaveBeenCalledOnce();
    const messages = warnings.mock.calls.flat().join(" ");
    expect(messages).toContain("circuit_outcome_write_failed");
    expect(messages).not.toContain("[primary-prices] CG price API failed:");
  });

  it("records a thrown provider fetch as one failed observation even if bookkeeping also fails", async () => {
    const db = failingBookkeepingDb();
    const plan = await admittedCgPlan(db);
    vi.mocked(fetchCoingeckoSimplePrices).mockRejectedValue(new Error("provider unavailable"));
    const outcomes = vi.spyOn(circuit, "recordOutcomeSafe");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.cgQuotes.size).toBe(0);
    expect(outcomes.mock.calls.map(([, source, success]) => [source, success])).toEqual([[CIRCUIT_SOURCE.CG_PRICES, false]]);
    expect(fetchCoingeckoSimplePrices).toHaveBeenCalledOnce();
    const messages = warnings.mock.calls.flat().join(" ");
    expect(messages).toContain("[primary-prices] CG price API failed:");
    expect(messages).toContain("circuit_outcome_write_failed");
  });

  it("records a returned upstream-error outcome as one failed observation", async () => {
    const db = failingBookkeepingDb();
    const plan = await admittedCgPlan(db);
    vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue({ kind: "upstream-error", value: new Map(), reason: "upstream-unavailable" });
    const outcomes = vi.spyOn(circuit, "recordOutcomeSafe");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.cgQuotes.size).toBe(0);
    expect(outcomes.mock.calls.map(([, source, success]) => [source, success])).toEqual([[CIRCUIT_SOURCE.CG_PRICES, false]]);
    expect(warnings.mock.calls.flat().join(" ")).not.toContain("[primary-prices] CG price API failed:");
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
    const plan = await buildPrimaryPricePlan([
      { id: "unlisted-test", name: "Unlisted", symbol: "ZZZZ" },
    ], mockD1([]));

    expect(plan.candidates).toEqual([]);
    expect(plan.geckoIds).toEqual([]);
    expect(plan.coinbaseSymbols).toEqual([]);
    expect(plan.krakenSymbols).toEqual([]);
    expect(plan.shouldFetchBitstamp).toBe(false);
    expect(plan.navPriceIds).toEqual([]);
    expect(Object.values(plan.sourceAllowed)).toEqual(Array(9).fill(false));
    expect(shouldAttemptFetch).not.toHaveBeenCalled();
  });

  it("values a non-USD reserve NAV quote at its admitted FX reference rate", async () => {
    const meta = TRACKED_META_BY_ID.get("eutbl-spiko")!;
    const config = meta.liveReservesConfig!;
    const fetchedAt = Math.floor(Date.now() / 1000) - 60;
    const fingerprint = computeLiveReserveConfigFingerprint(config);
    const db = mockD1([{
      match: "FROM reserve_composition",
      rows: [{
        stablecoin_id: "eutbl-spiko", fetched_at: fetchedAt, source: config.adapter,
        metadata: JSON.stringify({ navPerToken: 1.25, sourceTimestamp: fetchedAt }),
        config_fingerprint: fingerprint, attempt_id: "attempt-1",
        last_success_at: fetchedAt, last_success_attempt_id: "attempt-1",
        state_config_fingerprint: fingerprint, last_attempt_id: "attempt-1", pending_attempt_id: null,
      }],
    }]);
    const plan = await buildPrimaryPricePlan([
      { id: "eutbl-spiko", name: "EUTBL", symbol: "EUTBL", pegType: "peggedEUR" },
    ], db);
    expect(plan.navPriceIds).toEqual(["eutbl-spiko"]);

    const result = await collectPrimaryProviderQuotes({
      db,
      plan,
      references: {
        rates: { peggedEUR: 1.08 },
        type: "fresh",
        updatedAt: fetchedAt,
        typeByPeg: { peggedEUR: "fresh" },
      },
    });

    expect(result.quoteMaps.navPrices.get("eutbl-spiko")).toMatchObject({
      source: config.adapter,
      price: 1.25 * 1.08,
      metadata: { reserveFetchedAt: fetchedAt, navPerToken: 1.25, navUsdRate: 1.08 },
    });
  });

  it("keeps provider quotes when the reserve NAV telemetry query fails", async () => {
    const db = mockD1([{
      match: "FROM reserve_composition",
      rows: [],
      throwError: new Error("reserve database unavailable"),
    }]);
    const plan = await buildPrimaryPricePlan([
      { id: "eutbl-spiko", name: "EUTBL", symbol: "EUTBL", pegType: "peggedEUR" },
    ], db);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.navPrices.size).toBe(0);
    expect(warnings.mock.calls.flat().join(" ")).toContain(
      "[primary-prices] Failed to load reserve NAV telemetry: reserve database unavailable",
    );
  });

  it("collects CG ticker quotes and stamps their observation clock", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CG_TICKER);
    const db = mockD1([]);
    const plan = await buildPrimaryPricePlan([TEST_ASSET], db);
    vi.mocked(fetchCgTickerPricesDetailed).mockResolvedValue({
      prices: new Map([["test-usd", 1.01]]),
      successfulResponses: 1,
    });

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.cgTickerPrices.get("test-usd")).toBe(1.01);
    expect(result.quoteMaps.cgTickerObservedAt).toBeGreaterThan(0);
  });

  it("collects Coinbase quotes with their per-symbol observation clocks", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.COINBASE_PRICES);
    const db = mockD1([]);
    const plan = await buildPrimaryPricePlan([
      { id: "test-usdt", name: "Test USDT", symbol: "USDT" },
    ], db);
    expect(plan.coinbaseSymbols).toEqual(["USDT"]);
    vi.mocked(fetchCoinbasePrices).mockResolvedValue({
      kind: "ok",
      value: {
        prices: new Map([["USDT", 1.0004]]),
        observedAtBySymbol: new Map([["USDT", 1_700_000_000]]),
      },
    });

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.coinbasePrices.get("USDT")).toBe(1.0004);
    expect(result.quoteMaps.coinbaseObservedAtBySymbol.get("USDT")).toBe(1_700_000_000);
  });

  it("collects Curve pool quotes with their per-coin observation clocks", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CURVE_ONCHAIN);
    const coinId = CURVE_POOL_CONFIGS[0].stablecoinId;
    const db = mockD1([]);
    const plan = await buildPrimaryPricePlan([
      { id: coinId, name: "Curve coin", symbol: "CRVCOIN" },
    ], db);
    vi.mocked(fetchCurveOnchainPrices).mockResolvedValue({
      kind: "ok",
      value: {
        prices: new Map([[coinId, 0.9995]]),
        observedAtByCoinId: new Map([[coinId, 1_700_000_000]]),
        routeTypeByCoinId: new Map(),
        hopDepthByCoinId: new Map(),
      },
    });

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.curvePrices.get(coinId)).toBe(0.9995);
    expect(result.quoteMaps.curveObservedAtByCoinId.get(coinId)).toBe(1_700_000_000);
  });

  it("admits a fresh crvUSD oracle EMA as a primary quote", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => source === CIRCUIT_SOURCE.CURVE_ORACLE);
    const db = mockD1([]);
    const plan = await buildPrimaryPricePlan([
      { id: "crvusd-curve", name: "crvUSD", symbol: "CRVUSD" },
    ], db);
    const blockTimestamp = Math.floor(Date.now() / 1000) - 15;
    vi.mocked(fetchCurveOracleEma).mockResolvedValue({
      price: 0.9987,
      blockNumber: 123,
      blockTimestamp,
    });

    const result = await collectPrimaryProviderQuotes({ db, plan });

    expect(result.quoteMaps.curveOraclePrice).toBe(0.9987);
    expect(result.quoteMaps.curveOracleObservedAt).toBe(blockTimestamp);
  });

  it("does not fetch when required circuit admission rejects", async () => {
    const failure = new Error("admission unavailable");
    vi.mocked(shouldAttemptFetch).mockRejectedValue(failure);
    await expect(buildPrimaryPricePlan([TEST_ASSET], mockD1([]))).rejects.toBe(failure);
    expect(fetchCoingeckoSimplePrices).not.toHaveBeenCalled();
  });
});
