import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { mockD1 } from "@shared/test-utils/mock-d1";
import * as circuit from "../../../lib/circuit-breaker";
import { fetchCoingeckoSimplePrices } from "../../../lib/coingecko-simple-price";
import { shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { buildPrimaryPricePlan, collectPrimaryProviderQuotes } from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset } from "../enrich-prices-shared";

vi.mock("../../../lib/circuit-breaker", async (importOriginal) => {
  const actual = await importOriginal<typeof circuit>();
  return {
    ...actual,
    shouldAttemptFetch: vi.fn(async () => false),
    recoverBreakerOnNoCandidate: vi.fn(async () => {}),
  };
});
vi.mock("../../../lib/coingecko-simple-price", () => ({ fetchCoingeckoSimplePrices: vi.fn() }));

vi.mock("../../../lib/depeg-helpers", () => ({
  createDexPriceSourceLoadTelemetry: vi.fn(() => ({
    staleRows: [],
    malformedRows: [],
  })),
  loadDexPriceRows: vi.fn(async () => new Map()),
  loadDexPriceSources: vi.fn(async () => new Map()),
}));

const TEST_ASSET: PeggedAsset = {
  id: "test-usd",
  name: "Test USD",
  symbol: "TUSD",
  geckoId: "test-usd",
  pegType: "peggedUSD",
};

describe("critical publication provider collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fetchCoingeckoSimplePrices).mockReset();
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
      CIRCUIT_SOURCE.REDSTONE_PRICES,
      CIRCUIT_SOURCE.CURVE_ONCHAIN,
      CIRCUIT_SOURCE.CURVE_ORACLE,
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

  it("does not fetch when required circuit admission rejects", async () => {
    const failure = new Error("admission unavailable");
    vi.mocked(shouldAttemptFetch).mockRejectedValue(failure);
    await expect(buildPrimaryPricePlan([TEST_ASSET], mockD1([]))).rejects.toBe(failure);
    expect(fetchCoingeckoSimplePrices).not.toHaveBeenCalled();
  });
});
