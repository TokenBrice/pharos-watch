import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { YIELD_ADAPTER_MANIFEST } from "../../../lib/yield-config/yield-config";
import { INTENTIONAL_GAP_REASONS } from "../../../lib/yield-config/yield-config-rate-sources";
import { isPriceDerivedYieldEligible } from "../../../lib/yield-config/yield-config-registry";
import { resolveTrackedYieldSources } from "../resolve-tracked-sources";
import { getPriceDerivedApy } from "../sources-riskfree";
import { buildHardcodedUsdBenchmark, type ParsedYieldBenchmarkMeta } from "../benchmarks";
import { baseEvaluationInput, freshUsdBenchmark } from "../../__tests__/yield-evaluation.test-support";
import { evaluateYieldSources } from "../evaluation";

vi.mock("../tracked-optional-source-registry", () => ({
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID: new Map(),
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: [],
}));

const now = 1790467200;
const excluded = ["vbill-vaneck", "stkgho-umbrella-aave", "usdb-blast", "bc3m-backed"];

function benchmarks() {
  const registry = baseEvaluationInput().riskFreeRates;
  const usd: ParsedYieldBenchmarkMeta = { ...freshUsdBenchmark(now), recordDate: "2026-09-26", lastMarketRecordDate: "2026-09-26" };
  return { ...registry, USD: usd, USD_EFFR: { ...usd, key: "USD_EFFR" as const, rate: 3.6 } };
}

async function resolve(product = benchmarks().USD, price = 1.001, previousRate = 1) {
  const db = mockD1([
    { match: "pharos:yield-sync:tier1-previous-rate", rows: [{ stablecoin_id: "sdai-sky", exchange_rate: previousRate, recorded_at: now - 7 * DAY_SECONDS }] },
    { match: "snapshot_date BETWEEN", rows: [{ price: 1, snapshot_date: now - 30 * DAY_SECONDS }] },
    { match: "SELECT price, snapshot_date FROM supply_history", rows: [{ price, snapshot_date: now }] },
  ]);
  const riskFreeRates = { ...benchmarks(), USD: product };
  const result = await resolveTrackedYieldSources({ db, startSec: now, sevenDaysAgoSec: now - 7 * DAY_SECONDS,
    dlPools: [], onChainRates: new Map([["sdai-sky", { rate: 1 }]]), safetyScores: new Map(), riskFreeRates });
  return { ...result, riskFreeRates };
}

afterEach(() => vi.useRealTimers());

describe("derived source admission", () => {
  it.each([1, 1.001])("does not annualize distributed rewards, rebases, or EUR NAV at price %s", async (price) => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const result = await resolve(undefined, price);
    for (const id of excluded) {
      expect(result.resolved.some((entry) => entry.id === id && entry.yield?.dataSource === "price-derived")).toBe(false);
      expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === id)?.strategies.some((entry) => entry.kind === "price-derived")).toBe(false);
    }
    for (const id of ["aa-falconx-mev-capital", "stusd-stoneyield"]) {
      expect(result.resolved.find((entry) => entry.id === id && entry.yield?.dataSource === "price-derived")?.yield?.currentApy).toBeCloseTo((Math.pow(price, 365.25 / 30) - 1) * 100);
    }
    expect(isPriceDerivedYieldEligible("usda-avalon")).toBe(false);
    expect(isPriceDerivedYieldEligible("aa-falconx-mev-capital", INTENTIONAL_GAP_REASONS["stkgho-umbrella-aave"])).toBe(false);
  });

  it("rejects hardcoded product yield despite a healthy comparison hurdle", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const result = await resolve(buildHardcodedUsdBenchmark("missing-cache"));
    const rateDerived = result.resolved.filter((entry) => entry.yield?.dataSource === "rate-derived");
    expect(rateDerived.map((entry) => entry.id)).toEqual(["usdgo-osl"]);
    expect(rateDerived[0].yield?.currentApy).toBeCloseTo(3.6 - 0.38);
  });

  it("never substitutes run time for missing product observation timestamps", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const result = await resolve({ ...benchmarks().USD, fetchedAt: null, lastMarketFetchedAt: null });
    const entry = result.resolved.find((row) => row.id === "ustbl-spiko" && row.yield?.dataSource === "rate-derived");
    expect(entry?.yield?.sourceObservedAt).toBeNull();
    const evaluated = evaluateYieldSources(baseEvaluationInput({ startSec: now, resolved: entry ? [entry] : [], riskFreeRates: result.riskFreeRates }));
    expect(evaluated.evaluatedSources[0]).toMatchObject({ sourceFreshness: "unknown", pharosYieldScore: null });
  });

  it.each(["healthy", "degraded", "stale"] as const)("preserves %s product evidence independently of EFFR", async (freshness) => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const product = benchmarks().USD;
    if (freshness === "stale") product.recordDate = "2026-08-01";
    if (freshness === "degraded") { product.isFallback = true; product.fallbackMode = "retained"; }
    const result = await resolve(product);
    const entry = result.resolved.find((row) => row.id === "ustbl-spiko" && row.yield?.dataSource === "rate-derived");
    expect(entry?.yield?.sourceObservedAt).toBe(now);
    expect(entry?.yield?.currentApy).toBeCloseTo(4.1);
    const input = baseEvaluationInput({
      startSec: now,
      resolved: entry ? [entry] : [],
      riskFreeRates: result.riskFreeRates,
      safetyScores: new Map([["ustbl-spiko", { score: 80, grade: "B+" }]]),
      sourceHistory: new Map([["ustbl-spiko::rate-derived", [1, 2].map((day) => ({
        stablecoin_id: "ustbl-spiko", source_key: "rate-derived", recorded_at: now - day * DAY_SECONDS,
        is_best: 1, apy: 4.1, source_tvl_usd: null, data_source: "rate-derived",
        yield_source: null, yield_type: null,
      }))]]),
    });
    const evaluated = evaluateYieldSources(input);
    const row = evaluated.evaluatedSources[0];
    expect(row?.sourceFreshness).toBe(freshness === "stale" ? "stale" : "fresh");
    if (freshness === "stale") expect(row?.pharosYieldScore).toBeNull();
    if (freshness === "degraded") expect(row?.warnings).toContain("reference-benchmark-degraded");
    if (freshness === "healthy") expect(row?.pharosYieldScore).toBeTypeOf("number");
  });

  it("assesses product, hurdle and non-USD normalization independently through resolve and evaluate", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    for (const expired of [null, "USD", "USD_EFFR", "EUR"] as const) {
      const riskFreeRates = {
        ...benchmarks(),
        EUR: { ...benchmarks().USD, key: "EUR" as const, currency: "EUR" },
      };
      if (expired) riskFreeRates[expired].recordDate = "2026-08-01";
      const result = await resolveTrackedYieldSources({
        db: mockD1([
          { match: "pharos:yield-sync:tier1-previous-rate", rows: [] },
          { match: "snapshot_date BETWEEN", rows: [] },
          { match: "SELECT price, snapshot_date FROM supply_history", rows: [] },
        ]), startSec: now, sevenDaysAgoSec: now - 7 * DAY_SECONDS,
        dlPools: [], onChainRates: new Map(), safetyScores: new Map(), riskFreeRates,
      });
      for (const id of ["usdgo-osl", "ustbl-spiko", "eutbl-spiko"]) {
        const entry = result.resolved.find((row) => row.id === id && row.yield?.dataSource === "rate-derived")!;
        const input = baseEvaluationInput({
          startSec: now, resolved: [entry], riskFreeRates,
          safetyScores: new Map([[id, { score: 80, grade: "B+" }]]),
          sourceHistory: new Map([[`${id}::rate-derived`, [1, 2].map((day) => ({
            stablecoin_id: id, source_key: "rate-derived", recorded_at: now - day * DAY_SECONDS,
            is_best: 1, apy: entry.yield!.currentApy, source_tvl_usd: null, data_source: "rate-derived",
            yield_source: null, yield_type: null,
          }))]]),
        });
        const row = evaluateYieldSources(input).evaluatedSources[0];
        const productKey = id === "usdgo-osl" ? "USD_EFFR" : id === "ustbl-spiko" ? "USD" : "EUR";
        const hurdleKey = id === "eutbl-spiko" ? "EUR" : "USD_EFFR";
        const reason = expired === productKey ? "source-stale"
          : expired === hurdleKey || (id === "eutbl-spiko" && expired === "USD") ? "benchmark-stale" : null;
        expect(row.pysNullReason, `${id}/${expired}`).toBe(reason);
        expect(row.sourceFreshness).toBe(reason === "source-stale" ? "stale" : "fresh");
        if (reason) expect(row.pharosYieldScore).toBeNull();
        else expect(row.pharosYieldScore).toBeTypeOf("number");
      }
    }
  });

  it("rejects overflow before admitting an on-chain source or its exchange-rate anchor", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const result = await resolve(undefined, 1, 1e-20);
    expect(result.resolved.some((entry) => entry.id === "sdai-sky" && entry.yield?.dataSource === "onchain")).toBe(false);
    expect(result.envelopeRejections).toContainEqual(expect.objectContaining({ stablecoinId: "sdai-sky", computedApy: null, rejectionReason: "non-finite-annualization" }));
  });

  it("rejects overflowing price annualization rather than returning a zero observation", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const db = mockD1([
      { match: "snapshot_date BETWEEN", rows: [{ price: 1e-20, snapshot_date: now - 7 * DAY_SECONDS }] },
      { match: "SELECT price, snapshot_date FROM supply_history", rows: [{ price: 1, snapshot_date: now }] },
    ]);
    expect(await getPriceDerivedApy(db, "sdai-sky")).toBeNull();
  });
});
