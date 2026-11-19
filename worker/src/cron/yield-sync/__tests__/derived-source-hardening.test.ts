import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { YIELD_ADAPTER_MANIFEST } from "../../../lib/yield-config/yield-config";
import { INTENTIONAL_GAP_REASONS } from "../../../lib/yield-config/yield-config-rate-sources";
import { isPriceDerivedYieldEligible } from "../../../lib/yield-config/yield-config-registry";
import { appendLinkedVariantParentYieldSources } from "../resolve-linked-variants";
import { resolveTrackedYieldSources } from "../resolve-observations";
import { getPriceDerivedApy } from "../state";
import { buildHardcodedUsdBenchmark, type ParsedYieldBenchmarkMeta } from "../benchmarks";
import { baseEvaluationInput, freshUsdBenchmark, resolvedYield } from "../../__tests__/yield-evaluation.test-support";
import { evaluateYieldSourcesCooperative } from "../evaluation";
import { parseRiskFreeRateCache } from "../cache";
import { buildHistoryKey } from "../history-evidence";
import { buildYieldPublicationViews } from "../publication-decisions";
import { buildYieldRankingsPayloadFromEvaluatedSources } from "../publication-rankings";
import { makeSafetySnapshotMeta, makeYieldSourceMeta } from "../../__tests__/yield-publication.test-support";

vi.mock("../sources-optional", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources-optional")>();

  return {
    ...actual,
    TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID: new Map(),
    STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: [],
  };
});

const now = 1790467200;
const excluded = ["vbill-vaneck", "stkgho-umbrella-aave", "bc3m-backed"];
const frozenExcluded = ["usdb-blast", "usda-avalon"];

function benchmarks() {
  const registry = baseEvaluationInput().riskFreeRates;
  const usd: ParsedYieldBenchmarkMeta = { ...freshUsdBenchmark(now), recordDate: "2026-09-26", lastMarketRecordDate: "2026-09-26" };
  return { ...registry, USD: usd, USD_EFFR: { ...usd, key: "USD_EFFR" as const, rate: 3.6 } };
}

async function resolve(product = benchmarks().USD, price = 1.001, previousRate = 1) {
  const db = mockD1([
    { match: "pharos:yield-sync:tier1-previous-rate", rows: [{ stablecoin_id: "sdai-sky", exchange_rate: previousRate, recorded_at: now - 7 * DAY_SECONDS }] },
    { match: "yield-sync:price-anchor", rows: [{ price: 1, price_observed_at: now - 30 * DAY_SECONDS }] },
    { match: "yield-sync:price-latest", rows: [{ price, price_observed_at: now }] },
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
    for (const id of frozenExcluded) {
      expect(result.resolved.some((entry) => entry.id === id && entry.yield?.dataSource === "price-derived")).toBe(false);
      expect(YIELD_ADAPTER_MANIFEST.find((entry) => entry.stablecoinId === id)).toBeUndefined();
    }
    for (const id of ["aa-falconx-mev-capital", "stusd-stoneyield"]) {
      expect(result.resolved.find((entry) => entry.id === id && entry.yield?.dataSource === "price-derived")?.yield?.currentApy).toBeCloseTo((Math.pow(price, 365.25 / 30) - 1) * 100);
    }
    expect(isPriceDerivedYieldEligible("usda-avalon")).toBe(false);
    expect(isPriceDerivedYieldEligible("aa-falconx-mev-capital", INTENTIONAL_GAP_REASONS["stkgho-umbrella-aave"])).toBe(false);
  });

  it.each([true, false])("does not mistake gold USD movement for xGLD return (RPC available: %s)", async (rpcAvailable) => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const riskFreeRates = benchmarks();
    const result = await resolveTrackedYieldSources({
      db: mockD1([
        { match: "pharos:yield-sync:tier1-previous-rate", rows: [
          { stablecoin_id: "xgld-unitas", exchange_rate: 1, recorded_at: now - 7 * DAY_SECONDS },
        ] },
        { match: "yield-sync:price-anchor", rows: [{ price: 1, price_observed_at: now - 30 * DAY_SECONDS }] },
        { match: "yield-sync:price-latest", rows: [{ price: 1.01, price_observed_at: now }] },
      ]),
      startSec: now, sevenDaysAgoSec: now - 7 * DAY_SECONDS, dlPools: [],
      onChainRates: rpcAvailable ? new Map([["xgld-unitas", { rate: 1.05 ** (7 / 365.25) }]]) : new Map(),
      safetyScores: new Map(), riskFreeRates,
    });
    const goldSources = result.resolved.filter((entry) => entry.id === "xgld-unitas" && entry.yield != null);
    if (rpcAvailable) {
      expect(goldSources).toHaveLength(1);
      expect(goldSources[0].yield).toMatchObject({ dataSource: "onchain", returnDenomination: "XAUt" });
      expect(goldSources[0].yield?.currentApy).toBeCloseTo(5);
      const { evaluatedSources, bestSourceKeyByCoin, medianApy } = await evaluateYieldSourcesCooperative(baseEvaluationInput({
        startSec: now, resolved: goldSources, riskFreeRates,
        safetyScores: new Map([["xgld-unitas", { score: 80, grade: "B+" }]]),
        sourceHistory: new Map([[buildHistoryKey("xgld-unitas", "onchain:xgld-unitas"), [{
          stablecoin_id: "xgld-unitas", source_key: "onchain:xgld-unitas", is_best: 1,
          apy: 5, recorded_at: now - DAY_SECONDS, source_tvl_usd: null,
          data_source: "onchain", yield_source: "Unitas", yield_type: "nav-appreciation",
        }]]]),
      }));
      const dlPoolsMeta = makeYieldSourceMeta();
      const { viewsByCoinId, provenanceByKey } = buildYieldPublicationViews({
        evaluatedSources, bestSourceKeyByCoin, startSec: now, dlPoolsMeta,
      });
      const { rankings: [row] } = buildYieldRankingsPayloadFromEvaluatedSources({
        evaluatedSources, publicationViews: viewsByCoinId, rankingProvenanceByKey: provenanceByKey,
        riskFreeRate: riskFreeRates.USD.rate, riskFreeRateMeta: riskFreeRates.USD, dlPoolsMeta, medianApy,
        safetySnapshot: makeSafetySnapshotMeta(), startSec: now,
      });
      expect(row).toMatchObject({
        excessYield: null, pharosYieldScore: null, pysNullReason: "missing-inputs",
        yieldSource: expect.stringContaining("XAUt"),
        warningSignals: expect.arrayContaining(["benchmark-unit-mismatch"]),
        provenance: { evidenceCompleteness: 0.5714, scoreQualification: "NR" },
      });
      expect(row.currentApy).toBeCloseTo(5);
      expect(row.provenance).not.toHaveProperty("benchmarkFreshness");
    } else {
      expect(goldSources).toEqual([]);
    }
    for (const id of ["fpi-frax", "isc-international-stable-currency"]) {
      expect(result.resolved.find((entry) => entry.id === id && entry.yield?.dataSource === "price-derived")
        ?.yield?.currentApy).toBeCloseTo((Math.pow(1.01, 365.25 / 30) - 1) * 100);
    }
  });

  it("does not project a bootstrap anchor into a parent yield opportunity", () => {
    const sources = [{ id: "xgld-unitas", symbol: "xGLD", yield: resolvedYield({
      observationKind: "anchor-only", dataSource: "onchain", sourceKey: "onchain:xgld-unitas",
      currentApy: 0, apyBase: null, exchangeRate: 1,
    }) }];
    expect(appendLinkedVariantParentYieldSources(sources)).toBe(0);
    expect(sources).toHaveLength(1);
  });

  it("rejects hardcoded product yield despite a healthy comparison hurdle", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const result = await resolve(buildHardcodedUsdBenchmark("missing-cache"));
    const rateDerived = result.resolved.filter((entry) => entry.yield?.dataSource === "rate-derived");
    expect(rateDerived.map((entry) => entry.id)).toEqual([]);
  });

  it("requires the configured TRY product rate for wiTRY even when USD is healthy", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const result = await resolve();
    const productIds = result.resolved.filter((entry) => entry.yield?.dataSource === "rate-derived").map((entry) => entry.id);
    expect(productIds).toContain("ustbl-spiko");
    expect(productIds).not.toContain("witry-brix");
  });

  it.each([null, undefined, "invalid", Number.NaN])("never substitutes cache time for structured product timestamps %s", async (timestamp) => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const product = parseRiskFreeRateCache(JSON.stringify({
      ...benchmarks().USD, fetchedAt: timestamp, lastMarketFetchedAt: timestamp,
    }), now, now)!;
    expect(product).toMatchObject({ fetchedAt: null, lastMarketFetchedAt: null, ageSeconds: null });
    const result = await resolve(product);
    const entry = result.resolved.find((row) => row.id === "ustbl-spiko" && row.yield?.dataSource === "rate-derived");
    expect(entry?.yield).toMatchObject({ sourceObservedAt: now - DAY_SECONDS, sourceFetchedAt: null });
    const evaluated = await evaluateYieldSourcesCooperative(baseEvaluationInput({ startSec: now, resolved: entry ? [entry] : [], riskFreeRates: result.riskFreeRates }), { yieldToEventLoop: () => Promise.resolve() });
    expect(evaluated.evaluatedSources[0]).toMatchObject({ sourceFreshness: "stale", pharosYieldScore: null });
  });

  it("retains valid structured observation clocks and isolates legacy scalar cache-time policy", () => {
    const valid = parseRiskFreeRateCache(JSON.stringify(benchmarks().USD), now + 60, now + 60)!;
    expect(valid).toMatchObject({ fetchedAt: now, lastMarketFetchedAt: now, ageSeconds: 60 });
    const legacy = parseRiskFreeRateCache("3.7", now, now + 60)!;
    expect(legacy).toMatchObject({ source: "legacy-scalar", fetchedAt: now, lastMarketFetchedAt: now, ageSeconds: 60 });
  });

  it.each(["healthy", "degraded", "stale"] as const)("preserves %s product evidence independently of EFFR", async (freshness) => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const product = benchmarks().USD;
    product.recordDate = freshness === "stale" ? "2026-08-01" : "2026-09-25";
    if (freshness === "degraded") { product.isFallback = true; product.fallbackMode = "retained"; }
    const result = await resolve(product);
    const entry = result.resolved.find((row) => row.id === "ustbl-spiko" && row.yield?.dataSource === "rate-derived");
    expect(entry?.yield?.sourceObservedAt).toBe(Date.parse(product.recordDate) / 1_000);
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
    const evaluated = await evaluateYieldSourcesCooperative(input, { yieldToEventLoop: () => Promise.resolve() });
    const row = evaluated.evaluatedSources[0];
    expect(row?.sourceFreshness).toBe(freshness === "stale" ? "stale" : "fresh");
    if (freshness === "stale") expect(row?.pharosYieldScore).toBeNull();
    if (freshness === "degraded") expect(row?.warnings).toContain("reference-benchmark-degraded");
    if (freshness === "healthy") expect(row?.pharosYieldScore).toBeTypeOf("number");
  });

  it.each(["fred-dgs3mo", "treasury-yield-xml"])("models APY from the %s fixing, keeping its date across refetches", async (source) => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const product = { ...benchmarks().USD, source, rate: 4, recordDate: "2026-09-25" };
    for (const fetchedAt of [now - DAY_SECONDS, now]) {
      const result = await resolve({ ...product, fetchedAt, lastMarketFetchedAt: fetchedAt });
      const candidate = result.resolved.find((entry) => entry.id === "buidl-blackrock" && entry.yield?.dataSource === "rate-derived")?.yield;
      expect(candidate?.currentApy).toBeCloseTo(3.84);
      expect(candidate).toMatchObject({
        sourceObservedAt: now - 2 * DAY_SECONDS,
        sourceFetchedAt: fetchedAt,
        benchmarkOverrideKey: "USD_EFFR",
      });
    }
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
          { match: "yield-sync:price-latest", rows: [] },
        ]), startSec: now, sevenDaysAgoSec: now - 7 * DAY_SECONDS,
        dlPools: [], onChainRates: new Map(), safetyScores: new Map(), riskFreeRates,
      });
      for (const id of ["ustbl-spiko", "eutbl-spiko"]) {
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
        const row = (await evaluateYieldSourcesCooperative(input, { yieldToEventLoop: () => Promise.resolve() })).evaluatedSources[0];
        const productKey = id === "ustbl-spiko" ? "USD" : "EUR";
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

  it.each(["latest", "anchor"])("retries mandatory %s prices without changing APY/clocks; aborts and exhausts", async (read) => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const error = new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window");
    for (const mode of ["recover", "abort", "exhaust"]) {
      const latest = { match: "yield-sync:price-latest", rows: [{ price: 1.01, price_observed_at: now - 1 }] };
      const anchor = { match: "yield-sync:price-anchor", rows: [{ price: 1, price_observed_at: now - 30 * DAY_SECONDS + 1 }] };
      const failed = { ...(read === "latest" ? latest : anchor), throwError: error as unknown };
      const db = mockD1(read === "latest" ? [failed, anchor] : [latest, failed]);
      const controller = new AbortController();
      const pending = getPriceDerivedApy(db, "sdai-sky", controller.signal);
      const checked = mode === "recover" ? pending : expect(pending).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(9_999);
      const initialReadCount = read === "latest" ? 1 : 2;
      expect(db.getHistory()).toHaveLength(initialReadCount);
      if (mode === "abort") controller.abort(error);
      if (mode === "recover") failed.throwError = undefined;
      await vi.runAllTimersAsync();
      if (mode === "recover") expect(await checked).toEqual({
        apy: (Math.pow(1.01, 365.25 / (30 - 2 / DAY_SECONDS)) - 1) * 100,
        sourceObservedAt: now - 1, comparisonAnchorObservedAt: now - 30 * DAY_SECONDS + 1,
      });
      else await checked;
      expect(db.getHistory()).toHaveLength(mode === "abort" ? initialReadCount : mode === "recover" ? 3 : initialReadCount + 3);
    }
  });

  it("selects the latest admissible quote and anchors by quote time", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare(`INSERT INTO supply_history
        (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at) VALUES (?, ?, 1e6, ?, ?)`);
      const id = "filqa-fidelity-international";
      const quoteAt = now - DAY_SECONDS + 60;
      const anchorAt = quoteAt - 8 * DAY_SECONDS;
      insert.run(id, now - 8 * DAY_SECONDS, 1, anchorAt);
      insert.run(id, now - DAY_SECONDS, Math.pow(1.05, 8 / 365.25), quoteAt);
      insert.run(id, now, 1, quoteAt - 3_600);
      insert.run(id, now + DAY_SECONDS, 10, now + 60);

      const result = await getPriceDerivedApy(db, id);
      expect(result).toMatchObject({ sourceObservedAt: quoteAt, comparisonAnchorObservedAt: anchorAt });
      expect(result?.apy).toBeCloseTo(5);
    } finally {
      sqlite.close();
    }
  });

  it("rejects overflowing price annualization rather than returning a zero observation", async () => {
    vi.useFakeTimers().setSystemTime(now * 1000);
    const db = mockD1([
      { match: "yield-sync:price-anchor", rows: [{ price: 1e-20, price_observed_at: now - 7 * DAY_SECONDS }] },
      { match: "yield-sync:price-latest", rows: [{ price: 1, price_observed_at: now }] },
    ]);
    expect(await getPriceDerivedApy(db, "sdai-sky")).toBeNull();
  });
});
