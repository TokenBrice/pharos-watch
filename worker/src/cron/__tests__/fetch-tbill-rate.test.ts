import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcbFixtures from "./fixtures/bcb-selic.json";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/yield-config/policy";
import { mockCircuitOutcomeRecord, mockFetchRetry } from "../../test-helpers/cron";
import {
  BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET,
  installCacheByKey,
  installBenchmarkFetch,
  makeBenchmarkCacheEntry,
  makeCacheRow,
  makeNewCurrencyFetchRoutes,
  makeRiskFreeRatesCacheRow,
  makeTbillFetchRoutes,
  makeUnavailableTbillFetchRoutes,
  TREASURY_XML_SNIPPET,
  type BenchmarkFetchRoutes,
} from "./rates-cron.test-support";
import { YIELD_BENCHMARK_KEY_VALUES, type YieldBenchmarkKey, type YieldBenchmarkRegistry } from "@shared/types/yield";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { DatabaseSync } from "node:sqlite";
import type * as DbCache from "../../lib/db-cache";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: vi.fn(), passthroughNonResponse: true }));

vi.mock("../../lib/db-cache", async (importOriginal) => ({
  ...await importOriginal<typeof DbCache>(),
  getCache: vi.fn(),
}));

vi.mock("../../lib/cron-logger", () => ({
  logCronEvent: vi.fn(async (_db: D1Database, event: Record<string, unknown>) => ({
    event: "cron_event",
    severity: "info",
    recordedAt: 1774479600,
    ...event,
  })),
  recordCronFailure: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcome: vi.fn(),
}));

import {
  fetchTbillRate,
} from "../fetch-tbill-rate";

import { type ParsedYieldBenchmarkMeta, buildHardcodedUsdBenchmark, getBenchmarkKeyForPegCurrency, resolveBenchmarkForStablecoin, toYieldBenchmarkRegistry, withYieldBenchmarkStaticMeta } from "../yield-sync/benchmarks";
import { classifyYieldBenchmarkFreshness, YIELD_BENCHMARK_RECORD_MAX_AGE_SEC } from "@shared/lib/yield-benchmark-freshness";
import { loadRiskFreeRateRegistryWithState } from "../yield-sync/state";
import { GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY as GBP_MARKER, USD_FRESH_STREAK_CACHE_KEY as USD_MARKER } from "../yield-sync/benchmark-monitor";
import { BENCHMARK_RESOLUTION_POLICIES } from "../tbill-sources/providers";
import { buildFailedBenchmarkResponseDiagnostics } from "../tbill-sources/metadata";
import { compactCronMetadataForPersistence } from "../../lib/cron-metadata-persistence";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { getCache } from "../../lib/db-cache";
import { logCronEvent } from "../../lib/cron-logger";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";

// ALFRED graph CSV uses the same observation shape with a date-stamped series column.
const ALFRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET = "observation_date,IUDZOS2_20260625\n2026-03-26,100\n2026-06-24,101\n";

// Fresh rows relative to FROZEN_NOW keep the five-day observation guard active.
const FRESH_FRED_OBSERVATION_DATE = "2026-06-24";
const FRESH_FRED_ROUTES: BenchmarkFetchRoutes = {
  "id=DGS3MO": new Response(`DATE,DGS3MO\n${FRESH_FRED_OBSERVATION_DATE},3.72\n`, { status: 200 }),
  "id=DFF": new Response(`DATE,DFF\n${FRESH_FRED_OBSERVATION_DATE},4.33\n`, { status: 200 }),
  "markets.newyorkfed.org": Response.json({
    refRates: [{ type: "EFFR", effectiveDate: FRESH_FRED_OBSERVATION_DATE, percentRate: 4.33 }],
  }),
  "api.bcb.gov.br": Response.json(bcbFixtures.daily),
};

function mockTbillByUrl(overrides: BenchmarkFetchRoutes = {}, calls?: string[]) {
  installBenchmarkFetch(vi.mocked(fetchWithRetry), makeTbillFetchRoutes({ ...FRESH_FRED_ROUTES, ...overrides }), calls);
}

function mockNewCurrencyByUrl(overrides: BenchmarkFetchRoutes = {}, calls?: string[]) {
  installBenchmarkFetch(
    vi.mocked(fetchWithRetry),
    makeNewCurrencyFetchRoutes({ ...FRESH_FRED_ROUTES, ...overrides }),
    calls,
  );
}

function mockUnavailableTbillByUrl(calls?: string[]) {
  installBenchmarkFetch(vi.mocked(fetchWithRetry), makeUnavailableTbillFetchRoutes(), calls);
}

/** Banxico requires a token; pass via env. */
const BANXICO_TEST_ENV = { BANXICO_TOKEN: "test-token" } as const;
const runBenchmarks = () => fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
function runMetadata(result: { metadata?: string }) {
  return JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
}
const GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY = "fetch-tbill-rate:gbp-retained-fallback-streak";

// Freeze Date so fixture age cannot silently reroute the SONIA fallback.
const FROZEN_NOW = new Date("2026-06-25T12:00:00Z");
const fixtures = createLatestSchemaFixtureTracker();
let db: D1Database;
let sqlite: DatabaseSync;

function cacheWritePayload<T = Record<string, unknown>>(key: string) {
  const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key);
  expect(row).toBeDefined();
  return JSON.parse(String(row?.value)) as T;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
  ({ db, sqlite } = fixtures.open());
});

afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

const priorUsd = { key: "USD", rate: 3.72, recordDate: "2026-03-02", fetchedAt: 1773100800, source: "fred-dgs3mo" };
const writtenBenchmarks = () => cacheWritePayload<{ benchmarks: YieldBenchmarkRegistry }>("risk_free_rates").benchmarks;

describe("fetchTbillRate", () => {

  const latestCachePayload = () => cacheWritePayload<ParsedYieldBenchmarkMeta>("risk_free_rate");

  function installBaselineUsdCache() {
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rate: {
        value: JSON.stringify({
          rate: 3.72,
          recordDate: "2026-03-07",
          fetchedAt: 1773100800,
          source: "fred-dgs3mo",
          isFallback: false,
          fallbackMode: null,
        }),
        updatedAt: 1773100800,
      },
    });
  }

  function mockUsdRate(rate: string) {
    mockTbillByUrl({
      "id=DGS3MO": new Response(`DATE,DGS3MO\n${FRESH_FRED_OBSERVATION_DATE},${rate}\n`),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET.replaceAll("3.71", rate).replaceAll("3.72", rate)),
    });
  }

  function installWrittenBenchmarkCache() {
    const read = (key: string) => {
      const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(key) as
        | { value: string; updated_at: number }
        | undefined;
      expect(row).toBeDefined();
      return { value: row!.value, updatedAt: row!.updated_at };
    };
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rate: read("risk_free_rate"),
      risk_free_rates: read("risk_free_rates"),
    });
  }

  function previousRiskFreeRatesCacheWithGbp() {
    return makeRiskFreeRatesCacheRow({
      USD: makeBenchmarkCacheEntry({ ...priorUsd, label: "USD 3M T-Bill" }),
      GBP: makeBenchmarkCacheEntry({
        key: "GBP",
        label: "GBP 3M compounded SONIA",
        rate: 4.05,
        recordDate: "2026-03-25",
        source: "fred-sonia-compounded-index",
      }),
    }, 1774479600);
  }



  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(logCronEvent).mockClear();
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns degraded when circuit is already open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const calls: string[] = [];
    mockTbillByUrl({}, calls);

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toContain("usd:circuit-open");
    expect(metadata.failedBenchmarkResponseAttempts).toEqual(expect.arrayContaining(YIELD_BENCHMARK_KEY_VALUES
      .filter(key => key !== "SGD").map(key => ({ key, failureMode: "circuit-open", attempts: [] }))));

    expect(metadata.eurSource).toBeNull();
    expect(metadata.usdEffrSource).toBeNull();
    expect(latestCachePayload()).toMatchObject({
      rate: RISK_FREE_RATE_FALLBACK,
      source: "hardcoded-fallback",
      fallbackMode: "circuit-open",
      isFallback: true,
    });
    expect(calls.some((url) => url.includes("id=DGS3MO"))).toBe(false);
    expect(calls.some((url) => url.includes("treasury.gov"))).toBe(false);
    expect(calls.some((url) => url.includes("data-api.ecb.europa.eu"))).toBe(false);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("returns ok from benchmark feeds", async () => {
    mockTbillByUrl();

    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    const requests = vi.mocked(fetchWithRetry).mock.calls;
    const requestOptions = (part: string) => {
      const request = requests.find(([url]) => String(url).includes(part));
      expect(request, part).toBeDefined();
      return request![1];
    };
    expect(new Headers(requestOptions("id=DGS3MO")?.headers).get("User-Agent"))
      .toBe("Pharos/1.0 (+https://pharos.watch)");
    expect(new Headers(requestOptions("banxico.org.mx")?.headers).get("Bmx-Token")).toBe("test-token");
    expect(requestOptions("DailyInfoWebServ")?.method).toBe("POST");
    expect(String(requestOptions("DailyInfoWebServ")?.body)).toContain("KeyRateXML");
    expect(requestOptions("evds3.tcmb.gov.tr/igmevdsms-dis/fe")?.method).toBe("POST");
    expect(JSON.parse(String(requestOptions("evds3.tcmb.gov.tr/igmevdsms-dis/fe")?.body)))
      .toMatchObject({ series: "TP.BISTTLREF.ORAN" });
    const urls = requests.map(([url]) => String(url));
    for (const fallback of ["id=DFF", "alfred.stlouisfed.org", "bankofengland.co.uk", "home.treasury.gov"]) {
      expect(urls.filter((url) => url.includes(fallback))).toEqual([]);
    }

    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({
      fallbackMode: null, usdSource: "fred-dgs3mo",
      usdRate: 3.72, usdEffrSource: "nyfed-effr",
      usdEffrRate: 4.33, eurSource: "ecb-estr-3m",
      eurRate: 1.9358, chfSource: "six-sar3mc",
      chfRate: -0.0539, gbpSource: "fred-sonia-compounded-index",
      gbpResponseAttemptCount: 1, jpySource: "boj-call-rate",
      jpyRate: 0.1, audSource: "rba-cash-rate-target",
      audRate: 4.3, mxnSource: "banxico-cetes-28d",
      mxnRate: 10.45, brlSource: "bcb-selic",
      cadSource: "boc-valet-v122530", cadRate: 4.75,
      rubSource: "cbr-key-rate", rubRate: 14.5,
      trySource: "cbrt-evds-tlref", tryRate: 40,
    });
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
    expect(metadata.gbpResponseAttempts).toEqual([
      expect.objectContaining({
        provider: "fred-sonia-compounded-index",
        status: 200,
        parsed: true,
        failure: null,
      }),
    ]);
    expect(metadata.brlRate).toBeCloseTo(13.638253562615565, 12);
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:USD", true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "fred-dgs3mo",
      fallbackMode: null,
      isFallback: false,
      recordDate: FRESH_FRED_OBSERVATION_DATE,
    });
    expect(writtenBenchmarks().USD_EFFR).toMatchObject({
      key: "USD_EFFR",
      rate: 4.33,
      source: "nyfed-effr",
      isFallback: false,
      fallbackMode: null,
    });
    expect(writtenBenchmarks().TRY).toMatchObject({
      key: "TRY",
      rate: 40,
      source: "cbrt-evds-tlref",
      isFallback: false,
      fallbackMode: null,
    });
    expect(Object.keys(writtenBenchmarks())).toEqual([...YIELD_BENCHMARK_KEY_VALUES]);
    expect(writtenBenchmarks().AUD).toMatchObject({
      rate: 4.3, source: "rba-cash-rate-target", label: "AUD cash-rate target",
      isProxy: false, isFallback: false, fallbackMode: null,
    });
  });

  it.each([
    ["4.35", 4.35, "rba-cash-rate-target", "AUD cash-rate target", false],
    ["", 4.36, "rba-interbank-overnight", "AUD interbank overnight (cash-rate proxy)", true],
  ] as const)("persists and publicly projects RBA target '%s' with its consumed series", async (target, rate, source, label, isProxy) => {
    mockTbillByUrl({
      "rba.gov.au/statistics/tables/csv/f1-data.csv": new Response(
        `23-Jun-2026,4.35,,4.36\n24-Jun-2026,${target},,4.36\n`, { status: 200 },
      ),
    });
    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({ audSource: source, audRate: rate, fallbackMode: null });
    const expected = {
      key: "AUD", rate, recordDate: "2026-06-24", source, label,
      isProxy, isFallback: isProxy, fallbackMode: isProxy ? "aud-interbank-overnight-proxy" : null,
      lastMarketRate: rate, lastMarketSource: source,
    };
    expect(writtenBenchmarks().AUD).toMatchObject(expected);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeCacheRow(cacheWritePayload("risk_free_rates"), FROZEN_NOW.getTime() / 1000),
    });
    const loaded = await loadRiskFreeRateRegistryWithState(db);
    expect(loaded.cacheState).toBe("valid");
    expect(toYieldBenchmarkRegistry(loaded.registry).AUD).toMatchObject(expected);
    const previous = writtenBenchmarks().AUD!;
    installWrittenBenchmarkCache();
    vi.setSystemTime(FROZEN_NOW.getTime() + 3600_000);
    mockTbillByUrl({ "rba.gov.au/statistics/tables/csv/f1-data.csv": null });
    const failed = await runBenchmarks();
    const failedMeta = runMetadata(failed);
    expect(failed.status).toBe("degraded");
    expect(failedMeta.fallbackMode).toBe("aud:aud-cash-rate-failed-retained");
    expect(failedMeta.resolvedBenchmarkKeys).not.toContain("AUD");
    expect(writtenBenchmarks().AUD).toMatchObject({ rate, recordDate: previous.recordDate,
      fetchedAt: previous.fetchedAt, fallbackMode: "aud-cash-rate-failed-retained" });
  });

  it("fetches every benchmark descriptor on each daily run", async () => {
    const calls: string[] = [];
    mockTbillByUrl({}, calls);

    await runBenchmarks();
    await runBenchmarks();

    expect(calls.filter((url) => url.includes("data-api.ecb.europa.eu"))).toHaveLength(2);
    expect(calls.filter((url) => url.includes("id=DGS3MO"))).toHaveLength(2);
    expect(calls.filter((url) => url.includes("report-download"))).toHaveLength(2);
    const circuitOutcomes = vi.mocked(recordOutcome).mock.calls.map(([, key]) => key);
    for (const key of YIELD_BENCHMARK_KEY_VALUES.filter((key) => key !== "SGD")) {
      expect(circuitOutcomes.filter((circuitKey) => circuitKey === `TREASURY_RATES:${key}`)).toHaveLength(2);
    }
  });

  it("isolates an open descriptor circuit from the other descriptors", async () => {
    const calls: string[] = [];
    mockTbillByUrl({}, calls);
    vi.mocked(shouldAttemptFetch).mockImplementation(
      async (_db, source) => source !== "TREASURY_RATES:EUR",
    );

    const result = await runBenchmarks();

    expect(result.status).toBe("degraded");
    expect(calls.filter((url) => url.includes("data-api.ecb.europa.eu"))).toHaveLength(0);
    expect(calls.filter((url) => url.includes("report-download"))).toHaveLength(1);
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:CHF", true);
  });

  it.each([
    ["unreachable", null, "2026-06-24"],
    ["stale", "observation_date,IUDZOS2\n2000-01-01,100\n2000-04-01,101\n", "2026-06-24"],
    ["frozen 36 days", "observation_date,IUDZOS2\n2026-02-15,100\n2026-05-20,101\n", "2026-06-23"],
  ] as const)("falls through %s FRED SONIA evidence to current ALFRED", async (_kind, fredCsv, recordDate) => {
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": fredCsv == null ? null : new Response(fredCsv),
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": (_url, opts) => {
        expect((opts?.headers as Record<string, string> | undefined)?.["User-Agent"])
          .toBe("Pharos/1.0 (+https://pharos.watch)");
        return new Response(recordDate === "2026-06-24" ? ALFRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET
          : "observation_date,IUDZOS2_20260623\n2026-03-25,100\n2026-06-23,101\n");
      },
    });
    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({ gbpSource: "alfred-sonia-compounded-index", gbpRecordDate: recordDate,
      gbpResponseResolvedProvider: "alfred-sonia-compounded-index", fallbackMode: null });
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
    expect(metadata.gbpResponseAttempts).toEqual([
      expect.objectContaining({ provider: "fred-sonia-compounded-index", status: fredCsv == null ? null : 200,
        parsed: false, failure: fredCsv == null ? "transport-failed" : "parse-failed" }),
      expect.objectContaining({ provider: "alfred-sonia-compounded-index", status: 200, parsed: true, failure: null }),
    ]);
    expect(writtenBenchmarks().GBP).toMatchObject({ source: "alfred-sonia-compounded-index", recordDate,
      isFallback: false, fallbackMode: null });
    // The persisted print must satisfy the consumer's shared GBP bound.
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeCacheRow(cacheWritePayload("risk_free_rates"), FROZEN_NOW.getTime() / 1000),
    });
    const loaded = await loadRiskFreeRateRegistryWithState(db);
    expect(loaded.cacheState).toBe("valid");
    const gbp = loaded.registry.GBP!;
    expect(classifyYieldBenchmarkFreshness(gbp, {
      recordDate: gbp.recordDate, maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.GBP,
      nowSec: FROZEN_NOW.getTime() / 1000,
    })).toBe("healthy");
  });

  it.each([false, true])("falls back to BoE when St. Louis Fed SONIA is unavailable (future=%s)", async (future) => {
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": future
        ? new Response("observation_date,IUDZOS2\n2099-01-01,100\n2099-04-01,101\n") : null,
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": future
        ? new Response("observation_date,IUDZOS2_20990401\n2099-01-01,100\n2099-04-01,101\n") : null,
      "bankofengland.co.uk": new Response(BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET),
    });
    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({ gbpSource: "boe-sonia-compounded-index", gbpRecordDate: "2026-04-01" });
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
    expect(metadata.gbpResponseAttempts).toEqual([
      expect.objectContaining({ provider: "fred-sonia-compounded-index", failure: future ? "parse-failed" : "transport-failed" }),
      expect.objectContaining({ provider: "alfred-sonia-compounded-index", failure: future ? "parse-failed" : "transport-failed" }),
      expect.objectContaining({ provider: "boe-sonia-compounded-index", parsed: true, failure: null }),
    ]);
  });

  it("surfaces a retained GBP SONIA fallback as structured metadata", async () => {
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": null,
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": null,
      "bankofengland.co.uk": null,
    });
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: previousRiskFreeRatesCacheWithGbp(),
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("gbp:gbp-sonia-compounded-index-failed-retained");
    expect(metadata.gbpSource).toBe("fred-sonia-compounded-index");
    expect(metadata.gbpRate).toBe(4.05);
    expect(metadata.gbpRetainedFallbackActive).toBe(true);
    expect(metadata.gbpRetainedFallbackStreak).toBe(1);
    expect(metadata.gbpRetainedFallbackEventThreshold).toBe(2);
    expect(metadata.gbpResponseResolvedProvider).toBeNull();
    expect(metadata.gbpResponseAttempts).toEqual([
      expect.objectContaining({ provider: "fred-sonia-compounded-index", failure: "transport-failed" }),
      expect.objectContaining({ provider: "alfred-sonia-compounded-index", failure: "transport-failed" }),
      expect.objectContaining({ provider: "boe-sonia-compounded-index", failure: "transport-failed" }),
    ]);
    expect(metadata.fallbackBenchmarkCount).toBe(1);
    expect(metadata.retainedFallbackBenchmarkCount).toBe(1);
    expect(metadata.retainedFallbackBenchmarks).toEqual([
      expect.objectContaining({
        key: "GBP",
        source: "fred-sonia-compounded-index",
        fallbackMode: "gbp-sonia-compounded-index-failed-retained",
        retained: true,
      }),
    ]);
    expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
      consecutiveRetainedRuns: 1,
      lastFallbackMode: "gbp-sonia-compounded-index-failed-retained",
      lastMarketSource: "fred-sonia-compounded-index",
      lastMarketRecordDate: "2026-03-25",
    });
    expect(logCronEvent).not.toHaveBeenCalled();
  });

  it("logs a structured warning when the retained GBP SONIA fallback repeats", async () => {
    const legacyLastAlertedAt = Math.floor(Date.now() / 1000) - 3600;
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": null,
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": null,
      "bankofengland.co.uk": null,
    });
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: previousRiskFreeRatesCacheWithGbp(),
      [GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY]: {
        value: JSON.stringify({
          consecutiveRetainedRuns: 1,
          firstRetainedAt: 1774479600,
          lastRetainedAt: 1774479600,
          lastAlertedAt: legacyLastAlertedAt,
          lastFallbackMode: "gbp-sonia-compounded-index-failed-retained",
          lastMarketSource: "fred-sonia-compounded-index",
          lastMarketRecordDate: "2026-03-25",
          lastMarketFetchedAt: 1774479600,
        }),
        updatedAt: 1774479600,
      },
    });

    const result = await fetchTbillRate(db, undefined, {
      ...BANXICO_TEST_ENV,
    });
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata).toMatchObject({
      gbpRetainedFallbackActive: true,
      gbpRetainedFallbackStreak: 2,
      gbpRetainedFallbackEventThreshold: 2,
    });
    expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
      consecutiveRetainedRuns: 2,
      firstRetainedAt: 1774479600,
      lastFallbackMode: "gbp-sonia-compounded-index-failed-retained",
      lastMarketSource: "fred-sonia-compounded-index",
    });
    expect(logCronEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        job: "fetch-tbill-rate",
        eventType: "gbp-retained-fallback-repeated",
        severity: "warning",
        metadata: expect.objectContaining({
          consecutiveRetainedRuns: 2,
          threshold: 2,
          fallbackMode: "gbp-sonia-compounded-index-failed-retained",
          lastMarketSource: "fred-sonia-compounded-index",
          lastMarketRecordDate: "2026-03-25",
        }),
      }),
    );
  });

  it("resets the retained GBP SONIA fallback monitor after source recovery", async () => {
    mockTbillByUrl();
    installCacheByKey(vi.mocked(getCache), {
      [GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY]: {
        value: JSON.stringify({
          consecutiveRetainedRuns: 2,
          firstRetainedAt: 1774479600,
          lastRetainedAt: 1774566000,
          lastAlertedAt: 1774566000,
          lastFallbackMode: "gbp-sonia-compounded-index-failed-retained",
          lastMarketSource: "fred-sonia-compounded-index",
          lastMarketRecordDate: "2026-03-25",
          lastMarketFetchedAt: 1774479600,
        }),
        updatedAt: 1774566000,
      },
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({
      gbpRetainedFallbackActive: false,
      gbpRetainedFallbackStreak: 0,
      gbpRetainedFallbackRecoveredAt: expect.any(Number),
      gbpFreshPublicationStreak: 1,
      gbpFreshPublicationVerifiedTwice: false,
    });
    expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
      consecutiveRetainedRuns: 0,
      recoveredSource: "fred-sonia-compounded-index",
    });
    expect(logCronEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        job: "fetch-tbill-rate",
        eventType: "gbp-retained-fallback-recovered",
        severity: "info",
        metadata: expect.objectContaining({
          previousConsecutiveRetainedRuns: 2,
          recoveredSource: "fred-sonia-compounded-index",
          lastFallbackMode: "gbp-sonia-compounded-index-failed-retained",
        }),
      }),
    );
  });

  it("verifies GBP delivery after two consecutive fresh publications", async () => {
    const cache = await vi.importActual<typeof DbCache>("../../lib/db-cache");
    vi.mocked(getCache).mockImplementation(cache.getCache);
    mockTbillByUrl();
    await runBenchmarks();
    const firstGeneration = cacheWritePayload("risk_free_rates").generationId;
    mockTbillByUrl();

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(metadata).toMatchObject({
      gbpFreshPublicationStreak: 2,
      gbpFreshPublicationVerifiedTwice: true,
    });
    expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
      consecutiveFreshRuns: 2,
      lastFreshSource: "fred-sonia-compounded-index",
      generationId: expect.any(String),
    });
    expect(cacheWritePayload("risk_free_rates").generationId).not.toBe(firstGeneration);
    for (const key of ["fetch-tbill-rate:usd-fresh-streak", GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY]) {
      expect(cacheWritePayload(key)).toMatchObject({
        consecutiveFreshRuns: 2,
        generationId: cacheWritePayload("risk_free_rates").generationId,
      });
    }
  });

  it("publishes with an unknown predecessor when the previous-generation read fails", async () => {
    const cache = await vi.importActual<typeof DbCache>("../../lib/db-cache");
    vi.mocked(getCache).mockImplementation(cache.getCache);
    mockTbillByUrl();
    await runBenchmarks();
    const previousGenerationId = cacheWritePayload("risk_free_rates").generationId;
    let registryReads = 0;
    vi.mocked(getCache).mockImplementation(async (database, key) => {
      if (key === "risk_free_rates" && ++registryReads === 2) {
        throw new Error("previous generation unavailable");
      }
      return cache.getCache(database, key);
    });
    mockTbillByUrl();

    const result = await runBenchmarks();
    const generationId = cacheWritePayload("risk_free_rates").generationId;
    expect(result.status).toBe("ok");
    expect(generationId).not.toBe(previousGenerationId);
    expect(runMetadata(result)).toMatchObject({
      generationId,
      previousGenerationId: null,
      previousGenerationUnavailableReason: "benchmark-previous-generation-read-failed",
      registryCacheWrite: "written",
      gbpFreshPublicationStreak: 1,
      gbpFreshPublicationVerifiedTwice: false,
      usdFreshPublicationStreak: 1,
      usdFreshPublicationVerifiedTwice: false,
    });
    for (const key of ["fetch-tbill-rate:usd-fresh-streak", GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY]) {
      expect(cacheWritePayload(key)).toMatchObject({ consecutiveFreshRuns: 1, generationId });
    }
    expect(latestCachePayload().rate).toBe(writtenBenchmarks().USD?.rate);
    mockTbillByUrl();
    const recovered = await runBenchmarks();
    expect(runMetadata(recovered)).toMatchObject({
      previousGenerationId: generationId,
      previousGenerationUnavailableReason: null,
      gbpFreshPublicationStreak: 2,
      usdFreshPublicationStreak: 2,
    });
  });

  it.each(["registry-write", "abort-before-commit", "ambiguous-uncommitted", "ambiguous-committed", "confirmed", "confirmed-aborted"] as const)(
    "keeps recovery evidence atomic with publication (%s)", async (failure) => {
      const cache = await vi.importActual<typeof DbCache>("../../lib/db-cache");
      vi.mocked(getCache).mockImplementation(cache.getCache);
      mockTbillByUrl();
      await runBenchmarks();
      const marker = cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY);
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(
        JSON.stringify({ ...marker, consecutiveFreshRuns: 0, consecutiveRetainedRuns: 2 }),
        GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY,
      );
      const before = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
      const controller = new AbortController();
      let preparedWrites = 0;
      const prepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (sql.startsWith("INSERT INTO cache")) {
          preparedWrites += 1;
          if (failure === "abort-before-commit" && preparedWrites === 4) controller.abort(new Error("before commit"));
        }
        return statement;
      });
      if (failure === "registry-write") {
        sqlite.exec(`CREATE TRIGGER fail_benchmark_registry BEFORE INSERT ON cache
          WHEN NEW.key = 'risk_free_rates' BEGIN SELECT RAISE(ABORT, 'registry rejected'); END`);
      }
      const batch = db.batch.bind(db);
      const batchSpy = vi.spyOn(db, "batch");
      if (failure.startsWith("ambiguous")) {
        batchSpy.mockImplementationOnce(async (statements) => {
          if (failure === "ambiguous-committed") await batch(statements);
          throw new Error("acknowledgement lost");
        });
      }
      if (failure === "confirmed-aborted") {
        batchSpy.mockImplementationOnce(async (statements) => {
          const results = await batch(statements);
          controller.abort(new Error("after confirmed commit"));
          return results;
        });
      }
      vi.mocked(logCronEvent).mockClear();
      if (failure.startsWith("confirmed")) {
        vi.mocked(logCronEvent).mockImplementationOnce(async (_database, event) => {
          expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
            consecutiveRetainedRuns: 0, generationId: cacheWritePayload("risk_free_rates").generationId,
          });
          return { ...event, event: "cron_event", severity: event.severity ?? "info", recordedAt: Date.now() / 1000 };
        });
      }
      mockTbillByUrl();
      const publication = fetchTbillRate(db, controller.signal, BANXICO_TEST_ENV);
      if (failure.startsWith("confirmed")) await expect(publication).resolves.toMatchObject({ status: "ok" });
      else await expect(publication).rejects.toThrow(
        failure === "registry-write" ? "registry rejected"
          : failure === "abort-before-commit" ? "before commit"
            : "acknowledgement lost",
      );
      if (failure === "abort-before-commit") expect(batchSpy).not.toHaveBeenCalled();
      if (failure.startsWith("confirmed") || failure === "ambiguous-committed") {
        const generationId = cacheWritePayload("risk_free_rates").generationId;
        expect(generationId).not.toBe(marker.generationId);
        expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
          generationId, consecutiveRetainedRuns: 0, consecutiveFreshRuns: 1,
        });
        expect(cacheWritePayload("fetch-tbill-rate:usd-fresh-streak")).toMatchObject({
          generationId, consecutiveFreshRuns: 2,
        });
        expect(cacheWritePayload("risk_free_rate").rate).toBe(
          writtenBenchmarks().USD?.rate,
        );
      } else {
        expect(sqlite.prepare("SELECT * FROM cache ORDER BY key").all()).toEqual(before);
      }
      expect(logCronEvent).toHaveBeenCalledTimes(failure.startsWith("confirmed") ? 1 : 0);
      prepareSpy.mockRestore();
      batchSpy.mockRestore();
    },
  );

  it("does not make optional event delivery a prerequisite for committed recovery", async () => {
    mockTbillByUrl();
    installCacheByKey(vi.mocked(getCache), {
      [GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY]: makeCacheRow({ consecutiveRetainedRuns: 2 }, Math.floor(FROZEN_NOW.getTime() / 1000)),
    });
    vi.mocked(logCronEvent).mockRejectedValueOnce(new Error("event unavailable"));
    await expect(runBenchmarks()).resolves.toMatchObject({ status: "ok" });
    expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
      consecutiveRetainedRuns: 0, consecutiveFreshRuns: 1,
      generationId: cacheWritePayload("risk_free_rates").generationId,
    });
  });

  it("does not certify a fresh candidate when either monitor read fails", async () => {
    const cache = await vi.importActual<typeof DbCache>("../../lib/db-cache");
    vi.mocked(getCache).mockImplementation(async (database, key) => {
      if (key.includes("streak")) throw new Error("monitor unavailable");
      return cache.getCache(database, key);
    });
    mockTbillByUrl();
    const result = await runBenchmarks();
    expect(runMetadata(result)).not.toHaveProperty("usdFreshPublicationVerifiedTwice");
    expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all()).toEqual([
      { key: "risk_free_rate" }, { key: "risk_free_rates" },
    ]);
    expect(logCronEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["unreachable", null], ["invalid", "DATE,DGS3MO\n2026-03-02,.\n"],
    ["drift", `DATE,DGS3MO\n${FRESH_FRED_OBSERVATION_DATE},0.43\n`],
  ] as const)("falls back to independent Treasury XML after %s FRED evidence", async (kind, csv) => {
    mockTbillByUrl({
      "id=DGS3MO": csv == null ? null : new Response(csv),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET),
    });
    if (kind === "drift") installBaselineUsdCache();
    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({ usdSource: "treasury-yield-xml", usdRate: 3.72, fallbackMode: null });
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:USD", true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72, source: "treasury-yield-xml", fallbackMode: null, isFallback: false, recordDate: "2026-03-13",
    });
    if (kind === "drift") {
      expect(String(metadata.fallbackMode)).not.toContain("usd-rate-out-of-band");
      expect(logCronEvent).toHaveBeenCalledWith(db, expect.objectContaining({ eventType: "benchmark-rate-out-of-band" }));
    }
  });

  it("falls back to FRED DFF when the NY Fed EFFR feed fails", async () => {
    mockTbillByUrl({
      "markets.newyorkfed.org": null,
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("ok");
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.usdEffrSource).toBe("fred-dff");
    expect(metadata.usdEffrRate).toBe(4.33);
    expect(writtenBenchmarks().USD_EFFR).toMatchObject({
      key: "USD_EFFR",
      rate: 4.33,
      source: "fred-dff",
      isFallback: false,
      fallbackMode: null,
    });
  });

  it.each(["2026-03-01", "2099-01-01"])("falls through an out-of-budget NY Fed observation (%s) to current DFF", async (recordDate) => {
    const calls: string[] = [];
    mockTbillByUrl({
      "markets.newyorkfed.org": Response.json({
        refRates: [{ type: "EFFR", effectiveDate: recordDate, percentRate: 9.99 }],
      }),
    }, calls);
    const result = await runBenchmarks();
    expect(runMetadata(result)).toMatchObject({ usdEffrSource: "fred-dff", usdEffrRate: 4.33 });
    expect(calls.some((url) => url.includes("id=DFF"))).toBe(true);
    expect(writtenBenchmarks().USD_EFFR).toMatchObject({
      rate: 4.33, source: "fred-dff", isFallback: false, fallbackMode: null,
      recordDate: FRESH_FRED_OBSERVATION_DATE,
    });
  });


  it("retains the last EUR benchmark when the ECB feed fails", async () => {
    mockTbillByUrl({
      "data-api.ecb.europa.eu": null,
    });
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({ ...priorUsd, label: "USD 3M T-Bill" }),
        EUR: makeBenchmarkCacheEntry({
          key: "EUR",
          label: "EUR 3M compounded €STR",
          rate: 1.94,
          recordDate: "2026-03-24",
          fetchedAt: 1774393200,
          source: "ecb-estr-3m",
        }),
        CHF: null,
      }, 1774393200),
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata.eurSource).toBe("ecb-estr-3m");
    expect(metadata.eurRate).toBe(1.94);
    expect(metadata.fallbackMode).toBe("eur:ecb-failed-retained");
    expect(metadata.failedBenchmarkResponseAttempts).toEqual([{
      key: "EUR", failureMode: "ecb-failed-retained",
      attempts: [expect.objectContaining({ provider: "ecb-estr-3m", failure: "transport-failed", status: null })],
    }]);
  });

  it.each([
    ["application/json", JSON.stringify(bcbFixtures.errorEnvelope)],
    ["text/html", bcbFixtures.html],
  ])("retains original BRL market provenance for a BCB HTTP-200 %s error body", async (contentType, body) => {
    mockTbillByUrl({
      "api.bcb.gov.br": new Response(body, { status: 200, headers: { "Content-Type": contentType } }),
    });
    const observedAt = 1782216000;
    const retainedRate = 13.649989315282562;
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.72,
          recordDate: "2026-06-23",
          fetchedAt: observedAt,
          source: "fred-dgs3mo",
        }),
        BRL: makeBenchmarkCacheEntry({
          key: "BRL",
          rate: retainedRate,
          recordDate: "2026-06-23",
          fetchedAt: observedAt,
          source: "bcb-selic",
        }),
      }, observedAt),
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    const retained = {
      rate: retainedRate,
      recordDate: "2026-06-23",
      fetchedAt: observedAt,
      source: "bcb-selic",
      isFallback: true,
      fallbackMode: "bcb-selic-failed-retained",
      lastMarketRate: retainedRate,
      lastMarketRecordDate: "2026-06-23",
      lastMarketFetchedAt: observedAt,
      lastMarketSource: "bcb-selic",
    };
    expect(result.status).toBe("degraded");
    expect(metadata.reason).toBe("brl:bcb-selic-failed-retained");
    expect(metadata.brlResponseAttempts).toEqual(["bcb-selic", "bcb-selic-1178"].map(provider => ({
      provider,
      status: 200,
      contentType,
      bodyBytes: new TextEncoder().encode(body).length,
      parsed: false,
      recordDate: null,
      failure: contentType === "application/json" ? "upstream-error" : "html-body",
      ...(contentType === "application/json" ? { upstreamStatus: 500 } : {}),
    })));
    expect(writtenBenchmarks().BRL).toMatchObject(retained);
    expect(metadata.retainedFallbackBenchmarks).toEqual([
      expect.objectContaining({ key: "BRL", retained: true, fetchedAt: observedAt }),
    ]);
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:BRL", false);
  });

  it.each(["transport", "stale", "future", "html", "error", "zero", "bad-date"])(
    "tries same-instrument SGS1178 sequentially after SGS11 %s failure", async failure => {
      const calls: string[] = [];
      const primary = failure === "transport" ? null
        : failure === "html" ? new Response(bcbFixtures.html)
        : failure === "error" ? Response.json(bcbFixtures.errorEnvelope)
        : Response.json([{ data: failure === "stale" ? "19/06/2026"
          : failure === "future" ? "26/06/2026" : failure === "bad-date" ? "31/02/2026" : "24/06/2026",
          valor: failure === "zero" ? "0.00" : "0.050747" }]);
      mockTbillByUrl({
        "api.bcb.gov.br": url => url.includes("sgs.1178/") ? Response.json(bcbFixtures.annualized) : primary,
      }, calls);

      const result = await runBenchmarks();
      const metadata = runMetadata(result);
      expect(result.status).toBe("ok");
      expect(metadata.brlSource).toBe("bcb-selic-1178");
      expect(metadata.brlRate).toBe(13.65);
      expect(metadata.brlResponseAttempts).toEqual([
        expect.objectContaining({ provider: "bcb-selic", failure: {
          transport: "transport-failed", stale: "stale-record", future: "future-record",
          html: "html-body", error: "upstream-error", zero: "parse-failed", "bad-date": "parse-failed",
        }[failure] }),
        expect.objectContaining({ provider: "bcb-selic-1178", parsed: true, failure: null, recordDate: "2026-06-24" }),
      ]);
      expect(calls.filter(url => url.includes("api.bcb.gov.br"))).toEqual([
        expect.stringContaining("sgs.11/"), expect.stringContaining("sgs.1178/"),
      ]);
      for (const request of vi.mocked(fetchWithRetry).mock.calls.filter(([url]) => String(url).includes("api.bcb.gov.br"))) {
        expect(request[3]).toMatchObject({ maxResponseBytes: 16 * 1024 });
      }
      expect(vi.mocked(recordOutcome).mock.calls.filter(([, key]) => key === "TREASURY_RATES:BRL"))
        .toEqual([[db, "TREASURY_RATES:BRL", true]]);
      expect(metadata.usdSource).toBe("fred-dgs3mo");
      expect(metadata.eurSource).toBe("ecb-estr-3m");
      const entry = writtenBenchmarks().BRL!;
      expect(entry).toMatchObject({
        key: "BRL", label: "BRL SELIC over", currency: "BRL", source: "bcb-selic-1178",
        rate: 13.65, recordDate: "2026-06-24", isFallback: false, fallbackMode: null,
        lastMarketRate: 13.65, lastMarketSource: "bcb-selic-1178",
        fetchedAt: FROZEN_NOW.getTime() / 1000, lastMarketFetchedAt: FROZEN_NOW.getTime() / 1000,
      });
      // Round-trip through the real registry reader and shared freshness authority.
      installCacheByKey(vi.mocked(getCache), {
        risk_free_rates: makeCacheRow(cacheWritePayload("risk_free_rates"), FROZEN_NOW.getTime() / 1000),
      });
      const loaded = await loadRiskFreeRateRegistryWithState(db);
      expect(loaded.registry.BRL?.source).toBe("bcb-selic-1178");
      expect(loaded.cacheState).toBe("valid");
      const benchmark = loaded.registry.BRL!;
      const freshnessOptions = {
        recordDate: benchmark.recordDate,
        maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.BRL,
        nowSec: Date.now() / 1000,
      };
      expect(classifyYieldBenchmarkFreshness(benchmark, freshnessOptions)).toBe("healthy");
      expect(classifyYieldBenchmarkFreshness({ ...benchmark, ageSeconds: 48 * 3600 }, freshnessOptions)).toBe("healthy");
      expect(classifyYieldBenchmarkFreshness({ ...benchmark, ageSeconds: 48 * 3600 + 1 }, freshnessOptions)).toBe("stale");
    },
  );

  it.each([
    ["19/06/2026", "stale-record"], ["26/06/2026", "future-record"],
  ])("rejects SGS1178 publisher date %s without refreshing prior annualized-source clocks", async (data, failure) => {
    const observedAt = 1782216000;
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        BRL: makeBenchmarkCacheEntry({
          key: "BRL", source: "bcb-selic-1178", rate: 13.65, recordDate: "2026-06-23", fetchedAt: observedAt,
        }),
      }, observedAt),
    });
    mockTbillByUrl({
      "api.bcb.gov.br": url => url.includes("sgs.1178/") ? Response.json([{ data, valor: "13.65" }]) : null,
    });
    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    expect((metadata.brlResponseAttempts as unknown[])[1]).toMatchObject({ parsed: true, failure });
    expect(writtenBenchmarks().BRL).toMatchObject({
      source: "bcb-selic-1178", recordDate: "2026-06-23", fetchedAt: observedAt,
      lastMarketSource: "bcb-selic-1178", lastMarketRecordDate: "2026-06-23", lastMarketFetchedAt: observedAt,
      isFallback: true, fallbackMode: "bcb-selic-failed-retained",
    });
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:BRL", false);
  });

  it("admits the inclusive five-day publisher boundary and skips SGS1178", async () => {
    vi.setSystemTime(new Date("2026-06-25T00:00:00Z"));
    const calls: string[] = [];
    mockTbillByUrl({ "api.bcb.gov.br": Response.json([{ data: "20/06/2026", valor: "0.050747" }]) }, calls);
    const result = await runBenchmarks();
    expect(runMetadata(result).brlSource).toBe("bcb-selic");
    expect(calls.some(url => url.includes("sgs.1178/"))).toBe(false);
    expect(classifyYieldBenchmarkFreshness(
      { ageSeconds: 0, isFallback: false, fallbackMode: null },
      { recordDate: "2026-06-20", nowSec: Date.now() / 1000 + 1, maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.BRL },
    )).toBe("stale");
  });

  it.each([
    ["2026-06-25T23:55:00Z", "bcb-selic-1178"],
    ["2026-06-25T23:54:59Z", null],
  ])("uses the shared five-minute future-skew allowance at %s", async (now, source) => {
    vi.setSystemTime(new Date(now));
    mockTbillByUrl({
      "api.bcb.gov.br": url => url.includes("sgs.1178/") ? Response.json([{ data: "26/06/2026", valor: "13.65" }]) : null,
    });
    const result = await runBenchmarks();
    expect(runMetadata(result).brlSource).toBe(source);
  });

  it("bounds response MIME diagnostics and never persists an error body", async () => {
    const mime = `text/${"x".repeat(200)}`;
    mockTbillByUrl({
      "api.bcb.gov.br": new Response(bcbFixtures.html, { headers: { "Content-Type": `${mime}; charset=utf-8` } }),
    });
    const result = await runBenchmarks();
    const metadata = runMetadata(result);
    expect(metadata.brlResponseAttempts).toHaveLength(2);
    for (const attempt of metadata.brlResponseAttempts as unknown[]) {
      expect(attempt).toMatchObject({ failure: "html-body", contentType: mime.slice(0, 100) });
    }
    expect(result.metadata).not.toContain("<html>");
    expect(result.metadata).not.toContain("suporte.ti");
  });

  it("does not start SGS1178 or publish when the inherited deadline aborts SGS11", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    mockTbillByUrl({
      "api.bcb.gov.br": () => { controller.abort(new Error("slot deadline")); return null; },
    }, calls);
    await expect(fetchTbillRate(db, controller.signal, BANXICO_TEST_ENV)).rejects.toThrow("slot deadline");
    expect(calls.filter(url => url.includes("api.bcb.gov.br"))).toHaveLength(1);
    expect(vi.mocked(recordOutcome).mock.calls.some(([, key]) => key === "TREASURY_RATES:BRL")).toBe(false);
    expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([]);
  });

  it("retains the last CHF benchmark when the SIX SARON fetch fails", async () => {
    mockTbillByUrl({
      "oauth/token": null,
      "report-download": null,
    });
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({ ...priorUsd, label: "USD 3M T-Bill" }),
        EUR: null,
        CHF: makeBenchmarkCacheEntry({
          key: "CHF",
          label: "CHF 3M compounded SARON",
          rate: -0.0539,
          recordDate: "2026-03-25",
          source: "six-sar3mc",
        }),
      }, 1774479600),
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata.chfSource).toBe("six-sar3mc");
    expect(metadata.chfRate).toBe(-0.0539);
    expect(metadata.fallbackMode).toBe("chf:six-saron-failed-retained");
  });

  it("retains the last USD EFFR benchmark when both EFFR feeds fail", async () => {
    mockTbillByUrl({
      "markets.newyorkfed.org": null,
      "id=DFF": null,
    });
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry(priorUsd),
        USD_EFFR: makeBenchmarkCacheEntry({
          key: "USD_EFFR",
          rate: 4.31,
          recordDate: "2026-03-01",
          fetchedAt: 1773014400,
          source: "fred-dff",
        }),
        EUR: null,
        CHF: null,
        GBP: null,
        JPY: null,
        MXN: null,
        BRL: null,
        AUD: null,
        CAD: null,
        RUB: null,
        TRY: null,
        SGD: null,
      }, 1774479600),
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata.usdEffrSource).toBe("fred-dff");
    expect(metadata.usdEffrRate).toBe(4.31);
    expect(metadata.fallbackMode).toBe("usd_effr:usd-effr-sources-failed-retained");
    expect(writtenBenchmarks().USD_EFFR).toMatchObject({
      key: "USD_EFFR",
      rate: 4.31,
      source: "fred-dff",
      isFallback: true,
      fallbackMode: "usd-effr-sources-failed-retained",
    });
  });

  it.each([false, true])("records all failed sources through compaction (retained=%s)", async retained => {
    if (retained) {
      mockTbillByUrl();
      await runBenchmarks();
      installWrittenBenchmarkCache();
    }
    mockUnavailableTbillByUrl();

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    const reasons = "usd:all-sources-failed,usd_effr:usd-effr-sources-failed,eur:ecb-failed,chf:six-saron-failed,gbp:gbp-sonia-compounded-index-failed,jpy:jpy-call-rate-failed,mxn:banxico-cetes-failed,brl:bcb-selic-failed,aud:aud-cash-rate-failed,cad:boc-corra-failed,rub:cbr-key-rate-failed,try:cbrt-tlref-failed";
    expect(metadata.fallbackMode).toBe(reasons.split(",").map(reason => reason + (retained ? "-retained" : "")).join(","));
    const diagnostic = { status: 503, failure: "http-status" as const,
      contentType: "x".repeat(100), bodyBytes: 1000000, parsed: false, recordDate: null };
    const bounded = buildFailedBenchmarkResponseDiagnostics(YIELD_BENCHMARK_KEY_VALUES.filter(key => key !== "SGD").map(key => ({
      key, parsed: null, meta: null, failureMode: BENCHMARK_RESOLUTION_POLICIES[key].failureMode + (retained ? "-retained" : ""),
      responseDiagnostics: Array(4).fill({ ...diagnostic, provider: BENCHMARK_RESOLUTION_POLICIES[key].orderedProviders[0].source }),
    })));
    const legacy = Object.fromEntries(([
      ["gbpResponseAttempts", 3, "alfred-sonia-compounded-index"], ["brlResponseAttempts", 2, "bcb-selic-1178"],
    ] as const).map(([key, count, provider]) => [key, Array(count).fill({ ...diagnostic, provider })]));
    const valid = { ...metadata, ...legacy, schedulerAttemptKey: "x".repeat(200) };
    expect(new TextEncoder().encode(JSON.stringify(valid)).length).toBeLessThanOrEqual(8192);
    const input = { ...valid, ...bounded };
    const persisted = compactCronMetadataForPersistence(JSON.stringify({ ...input, payload: "x".repeat(10000) }), undefined, "fetch-tbill-rate");
    expect(persisted.compacted).toBe(true);
    expect(persisted.persistedBytes).toBeLessThanOrEqual(8192);
    expect(JSON.parse(persisted.metadata!)).toMatchObject(bounded);
    for (const failure of bounded.failedBenchmarkResponseAttempts!) {
      expect(failure).toMatchObject({ attemptCount: 4, omittedAttemptCount: 1 });
      expect(failure.attempts).toHaveLength(3);
    }
    expect(metadata.failedBenchmarkResponseAttempts).toEqual(expect.arrayContaining(YIELD_BENCHMARK_KEY_VALUES
      .filter(key => key !== "SGD").map(key => expect.objectContaining({ key,
        attempts: expect.arrayContaining([expect.objectContaining({ failure: "transport-failed" })]),
      }))));
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:USD", false);
    expect(latestCachePayload()).toMatchObject({
      rate: retained ? 3.72 : RISK_FREE_RATE_FALLBACK,
      source: retained ? "fred-dgs3mo" : "hardcoded-fallback",
      fallbackMode: retained ? "all-sources-failed-retained" : "all-sources-failed",
      isFallback: true,
    });
  });

  it("rethrows abort errors instead of writing fallback benchmarks", async () => {
    vi.mocked(fetchWithRetry).mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(fetchTbillRate(db, new AbortController().signal, BANXICO_TEST_ENV)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([]);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains USD market evidence across fallback days: %s", async (consecutive) => {
    mockUnavailableTbillByUrl();
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rate: makeCacheRow({ rate: 3.91, recordDate: "2026-03-07", fetchedAt: 1773100800,
        source: "fred-dgs3mo", isFallback: consecutive, fallbackMode: consecutive ? "all-sources-failed-retained" : null,
        ...(consecutive ? { lastMarketRate: 3.91, lastMarketRecordDate: "2026-03-07",
          lastMarketFetchedAt: 1773100800, lastMarketSource: "fred-dgs3mo" } : {}),
      }, consecutive ? 1773104400 : 1773100800),
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe(
      "usd:all-sources-failed-retained,usd_effr:usd-effr-sources-failed,eur:ecb-failed,chf:six-saron-failed,gbp:gbp-sonia-compounded-index-failed,jpy:jpy-call-rate-failed,mxn:banxico-cetes-failed,brl:bcb-selic-failed,aud:aud-cash-rate-failed,cad:boc-corra-failed,rub:cbr-key-rate-failed,try:cbrt-tlref-failed",
    );
    expect(latestCachePayload()).toMatchObject({
      rate: 3.91,
      source: "fred-dgs3mo",
      fallbackMode: "all-sources-failed-retained",
      isFallback: true,
      recordDate: "2026-03-07",
      ...(consecutive ? { lastMarketRate: 3.91, lastMarketSource: "fred-dgs3mo" } : {}),
    });
  });

  it("accepts a persistent genuine level shift on the second consecutive observation", async () => {
    mockUsdRate("2.4");
    installBaselineUsdCache();

    const first = await runBenchmarks();
    expect(first.status).toBe("degraded");
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      fallbackMode: "usd-rate-out-of-band-retained",
      isFallback: true,
      lastRejectedMarketRate: 2.4,
    });

    installWrittenBenchmarkCache();
    const second = await runBenchmarks();
    const metadata = runMetadata(second);
    expect(second.status).toBe("ok");
    expect(metadata.benchmarkRateConfirmations).toEqual([
      expect.objectContaining({
        key: "USD",
        rate: 2.4,
        previousMarketRate: 3.72,
        previousRejectedMarketRate: 2.4,
      }),
    ]);
    expect(metadata.quality).toEqual({
      reason: "benchmark-rate-level-shift-confirmed",
      confirmedKeys: ["USD"],
    });
    expect(latestCachePayload()).toMatchObject({
      rate: 2.4,
      source: "fred-dgs3mo",
      isFallback: false,
      lastRejectedMarketRate: null,
    });
  });

  it("rejects a one-off level spike and recovers on the next inside-band observation", async () => {
    mockUsdRate("2.4");
    installBaselineUsdCache();

    const spike = await runBenchmarks();
    expect(spike.status).toBe("degraded");
    expect(latestCachePayload().lastRejectedMarketRate).toBe(2.4);

    installWrittenBenchmarkCache();
    mockTbillByUrl({});
    const recovered = await runBenchmarks();
    const metadata = runMetadata(recovered);
    expect(recovered.status).toBe("ok");
    expect(metadata.benchmarkRateConfirmations).toBeUndefined();
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      isFallback: false,
      lastRejectedMarketRate: null,
    });
  });

  it("keeps a persistent 100x unit drift rejected instead of confirming it", async () => {
    mockUsdRate("0.43");
    installBaselineUsdCache();

    const first = await runBenchmarks();
    expect(first.status).toBe("degraded");
    expect(String(runMetadata(first).fallbackMode)).toContain("usd:usd-rate-out-of-band-retained");
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72, source: "fred-dgs3mo", fallbackMode: "usd-rate-out-of-band-retained",
      isFallback: true, lastRejectedMarketRate: 0.43,
    });
    expect(logCronEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: "benchmark-rate-out-of-band",
      metadata: expect.objectContaining({ key: "USD", rate: 0.43, previousMarketRate: 3.72 }),
    }));

    installWrittenBenchmarkCache();
    const second = await runBenchmarks();
    const metadata = runMetadata(second);
    expect(second.status).toBe("degraded");
    expect(metadata.benchmarkRateConfirmations).toBeUndefined();
    expect(String(metadata.fallbackMode)).toContain("usd:usd-rate-out-of-band-retained");
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      isFallback: true,
      lastRejectedMarketRate: 0.43,
    });
  });


});


describe("fetchTbillRate — new currency fetchers", () => {

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
  });

  it("skips Banxico when BANXICO_TOKEN is missing", async () => {
    const calls: string[] = [];
    mockNewCurrencyByUrl({}, calls);

    const result = await fetchTbillRate(db, undefined, { BANXICO_TOKEN: undefined });
    const metadata = runMetadata(result);

    expect(calls.some((u) => u.includes("banxico.org.mx"))).toBe(false);
    expect(calls.some((u) => u.includes("app.etherfuse.com/bonds/cetes"))).toBe(false);
    expect(metadata.mxnSource).toBeNull();
    expect(metadata.mxnRate).toBeNull();
    expect(metadata.mxnRecordDate).toBeNull();
    expect(result.status).toBe("degraded");
    expect(String(metadata.fallbackMode)).toContain("mxn:banxico-token-missing");
  });

  it("retains the last MXN benchmark when the Banxico fetch fails", async () => {
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry(priorUsd),
        EUR: null,
        CHF: null,
        GBP: null,
        JPY: null,
        MXN: makeBenchmarkCacheEntry({
          key: "MXN",
          rate: 10.45,
          recordDate: "2026-03-26",
          source: "banxico-cetes-28d",
        }),
        BRL: null,
        AUD: null,
        CAD: null,
        RUB: null,
        TRY: null,
        SGD: null,
      }, 1774479600),
    });
    mockNewCurrencyByUrl({ "banxico.org.mx": null });

    const result = await fetchTbillRate(db, undefined, { BANXICO_TOKEN: "test-token" });
    const metadata = runMetadata(result);

    expect(result.status).toBe("degraded");
    expect(metadata.mxnSource).toBe("banxico-cetes-28d");
    expect(metadata.mxnRate).toBe(10.45);
    expect(String(metadata.fallbackMode)).toContain("mxn:banxico-cetes-failed-retained");
  });
});

describe("getBenchmarkKeyForPegCurrency", () => {
  it("routes each supported peg currency to its native benchmark key", () => {
    for (const key of YIELD_BENCHMARK_KEY_VALUES.filter(key => key !== "USD_EFFR" && key !== "SGD")) {
      expect(getBenchmarkKeyForPegCurrency(key)).toBe(key);
    }
  });

  it("returns null for currencies without a fetcher so callers fall back to USD", () => {
    expect(getBenchmarkKeyForPegCurrency("SGD")).toBeNull();
    expect(getBenchmarkKeyForPegCurrency("AED")).toBeNull();
    expect(getBenchmarkKeyForPegCurrency(null)).toBeNull();
    expect(getBenchmarkKeyForPegCurrency(undefined)).toBeNull();
  });
});

describe("resolveBenchmarkForStablecoin", () => {
  function buildMeta(
    key: YieldBenchmarkKey,
  ) {
    return {
      ...withYieldBenchmarkStaticMeta(key, {
        rate: 1,
        recordDate: "2026-03-26",
        fetchedAt: 1774479600,
        ageSeconds: 0,
        source: `${key.toLowerCase()}-test`,
        isFallback: false,
        fallbackMode: null,
      }),
      lastMarketRate: 1,
      lastMarketRecordDate: "2026-03-26",
      lastMarketFetchedAt: 1774479600,
      lastMarketSource: `${key.toLowerCase()}-test`,
    };
  }

  function buildRegistry(
    overrides: Partial<Record<Exclude<YieldBenchmarkKey, "USD" | "SGD">, boolean>> = {},
  ) {
    return {
      USD: buildHardcodedUsdBenchmark("test"),
      USD_EFFR: overrides.USD_EFFR ? buildMeta("USD_EFFR") : null,
      EUR: overrides.EUR ? buildMeta("EUR") : null,
      CHF: overrides.CHF ? buildMeta("CHF") : null,
      GBP: overrides.GBP ? buildMeta("GBP") : null,
      JPY: overrides.JPY ? buildMeta("JPY") : null,
      MXN: overrides.MXN ? buildMeta("MXN") : null,
      BRL: overrides.BRL ? buildMeta("BRL") : null,
      AUD: overrides.AUD ? buildMeta("AUD") : null,
      CAD: overrides.CAD ? buildMeta("CAD") : null,
      RUB: overrides.RUB ? buildMeta("RUB") : null,
      TRY: overrides.TRY ? buildMeta("TRY") : null,
      SGD: null,
    };
  }

  it("falls back to USD for non-USD pegs whose native benchmark is unavailable", () => {
    const benchmarks = buildRegistry({}); // all non-USD missing
    const result = resolveBenchmarkForStablecoin({
      stablecoinId: "cetes-etherfuse",
      benchmarks,
    });
    expect(result.key).toBe("USD");
    expect(result.selectionMode).toBe("fallback-usd");
  });

  it("routes the MXN-pegged CETES asset to MXN when the native benchmark is available", () => {
    // NOTE: CETES (Etherfuse) is itself a tokenized 28-day CETES bond. With the MXN
    // benchmark = CETES 28d, the spread becomes ~0%, under-rewarding the asset.
    // This is wired here; a future "tokenized-treasury-uses-overnight-rate" rule
    // can override per-source if/when introduced.
    const benchmarks = buildRegistry({ MXN: true });
    const result = resolveBenchmarkForStablecoin({
      stablecoinId: "cetes-etherfuse",
      benchmarks,
    });
    expect(result.key).toBe("MXN");
    expect(result.selectionMode).toBe("native");
  });

  it("uses USD EFFR when a rate-derived config requests it explicitly", () => {
    const benchmarks = buildRegistry({ USD_EFFR: true });
    const result = resolveBenchmarkForStablecoin({
      stablecoinId: "effr-linked-product",
      benchmarks,
      benchmarkCurrency: "USD_EFFR",
    });

    expect(result.key).toBe("USD_EFFR");
    expect(result.selectionMode).toBe("manual-override");
    expect(result.meta.source).toBe("usd_effr-test");
  });

  it("routes the TRY-pegged wiTRY asset to TRY when the native benchmark is available", () => {
    const benchmarks = buildRegistry({ TRY: true });
    const result = resolveBenchmarkForStablecoin({
      stablecoinId: "witry-brix",
      benchmarks,
    });
    expect(result.key).toBe("TRY");
    expect(result.selectionMode).toBe("native");
  });

  it("falls back to USD when an explicitly requested EFFR benchmark is unavailable", () => {
    const benchmarks = buildRegistry();
    const result = resolveBenchmarkForStablecoin({
      stablecoinId: "effr-linked-product",
      benchmarks,
      benchmarkCurrency: "USD_EFFR",
    });

    expect(result.key).toBe("USD");
    expect(result.selectionMode).toBe("fallback-usd");
  });
});

describe("classifyYieldBenchmarkFreshness", () => {
  const FRESH_FETCH = { ageSeconds: 3600, isFallback: false, fallbackMode: null };

  it("stays healthy while the observation is inside its key bound", () => {
    expect(classifyYieldBenchmarkFreshness(FRESH_FETCH, {
      recordDate: "2026-06-23",
      maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD,
    })).toBe("healthy");
  });

  it("goes stale on an observation older than the key bound even when the fetch just succeeded", () => {
    expect(classifyYieldBenchmarkFreshness(FRESH_FETCH, {
      recordDate: "2026-03-02",
      maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD,
    })).toBe("stale");
  });

  it("applies the bound per key: a 42-day-old CAD print is current where USD would be stale", () => {
    const recordDate = "2026-05-14";
    expect(classifyYieldBenchmarkFreshness(FRESH_FETCH, {
      recordDate,
      maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.CAD,
    })).toBe("healthy");
    expect(classifyYieldBenchmarkFreshness(FRESH_FETCH, {
      recordDate,
      maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD,
    })).toBe("stale");
  });

});

describe("fetchTbillRate — benchmark observation guard and registry integrity", () => {
  const RETRY_BOUND_SEC = 24 * 3600;

  const writtenBenchmarks = () => cacheWritePayload<{ benchmarks: YieldBenchmarkRegistry }>("risk_free_rates").benchmarks;

  function cacheKeysWritten(): string[] {
    return sqlite.prepare("SELECT key FROM cache ORDER BY key").all().map((row) => String(row.key));
  }

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(logCronEvent).mockClear();
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
  });

  it("falls back to Treasury.gov when the FRED DGS3MO CSV is months old", async () => {
    mockTbillByUrl({
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });

    const result = await runBenchmarks();

    expect(runMetadata(result).usdSource).toBe("treasury-yield-xml");
    expect(writtenBenchmarks().USD).toMatchObject({
      rate: 3.72,
      source: "treasury-yield-xml",
      isFallback: false,
      recordDate: "2026-03-13",
    });
  });

  it.each(["oversized", "stalled", "legacy-bcb", "legacy-bcb-exhausted"])("preserves terminal 403 transport: %s", async (kind) => {
    vi.useFakeTimers();
    const retry = await import("../../lib/fetch-retry");
    const actual = await vi.importActual<typeof retry>("../../lib/fetch-retry");
    const read = vi.spyOn(retry, "fetchTextWithRetry").mockImplementation(actual.fetchTextWithRetry);
    const legacy = kind.startsWith("legacy-bcb");
    const exhausted = kind.endsWith("exhausted");
    const physical = vi.fn(async (): Promise<Response> => legacy && !exhausted && physical.mock.calls.length === 2
      ? Response.json([{ data: "11/11/2026", valor: "0.055" }]) : new Response(new ReadableStream({
        pull(controller) { if (kind !== "stalled") controller.enqueue(new Uint8Array((legacy ? 16 * 1024 : 16 * 1024 * 1024) + 1)); },
      }, { highWaterMark: 0 }), { status: 403, headers: { "Content-Type": "text/html" } }));
    vi.stubGlobal("fetch", physical);
    try {
      const { tryBocCorra } = await import("../tbill-sources/boc");
      const { tryBcbSelic } = await import("../tbill-sources/bcb");
      const observe = vi.fn();
      const pending = (legacy ? tryBcbSelic : tryBocCorra)(undefined, observe);
      await vi.runAllTimersAsync();
      if (legacy) {
        expect(await pending).toEqual(exhausted ? null : { rate: 14.862077781254435, recordDate: "2026-11-11" });
        expect(physical).toHaveBeenCalledTimes(exhausted ? 3 : 2);
        if (exhausted) expect(observe).toHaveBeenCalledExactlyOnceWith({ status: null, contentType: null, bodyBytes: 0, parsed: false, recordDate: null, failure: "transport-failed" });
      } else {
        expect(await pending).toBeNull();
        expect(physical).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 403, failure: "http-status", bodyBytes: 0 }));
        expect(Date.now()).toBe(FROZEN_NOW.getTime());
      }
    } finally {
      read.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rejects a future-dated DGS3MO row instead of publishing it as market data", async () => {
    mockTbillByUrl({
      "id=DGS3MO": new Response("DATE,DGS3MO\n2099-01-01,3.72\n", { status: 200 }),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });

    const result = await runBenchmarks();

    expect(runMetadata(result).usdSource).toBe("treasury-yield-xml");
    expect(writtenBenchmarks().USD?.recordDate).toBe("2026-03-13");
  });

  it("retains the previous USD_EFFR instead of publishing a months-old DFF row", async () => {
    const retainedEpochSec = Math.floor(FROZEN_NOW.getTime() / 1000) - 48 * 3600;
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.72,
          recordDate: FRESH_FRED_OBSERVATION_DATE,
          fetchedAt: retainedEpochSec,
          source: "fred-dgs3mo",
        }),
        USD_EFFR: makeBenchmarkCacheEntry({
          key: "USD_EFFR",
          rate: 4.31,
          recordDate: "2026-03-01",
          fetchedAt: retainedEpochSec,
          source: "fred-dff",
        }),
        EUR: null,
        CHF: null,
        GBP: null,
        JPY: null,
        MXN: null,
        BRL: null,
        AUD: null,
        CAD: null,
        RUB: null,
        TRY: null,
        SGD: null,
      }, retainedEpochSec),
    });
    mockTbillByUrl({
      "markets.newyorkfed.org": Response.json({
        refRates: [{ type: "EFFR", effectiveDate: "2026-03-01", percentRate: 9.99 }],
      }),
      "id=DFF": new Response("DATE,DFF\n2026-03-01,9.99\n", { status: 200 }),
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(metadata.usdEffrRate).toBe(4.31);
    expect(String(metadata.fallbackMode)).toContain("usd_effr:usd-effr-sources-failed-retained");
    expect(writtenBenchmarks().USD_EFFR).toMatchObject({
      rate: 4.31,
      isFallback: true,
      fallbackMode: "usd-effr-sources-failed-retained",
      recordDate: "2026-03-01",
      lastMarketFetchedAt: retainedEpochSec,
    });
  });

  it("marks an unparseable USD member invalid, preserves readable keys, and skips replacement", async () => {
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: { key: "USD", rate: "not-a-number" },
        EUR: makeBenchmarkCacheEntry({
          key: "EUR",
          rate: 1.94,
          recordDate: "2026-03-24",
          source: "ecb-estr-3m",
        }),
      }, 1774479600),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockUnavailableTbillByUrl();

    const loaded = await loadRiskFreeRateRegistryWithState(db, 1774479600);
    expect(loaded.cacheState).toBe("invalid");
    expect(loaded.registry.EUR).toMatchObject({
      rate: 1.94,
      source: "ecb-estr-3m",
    });

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(metadata.registryCacheState).toBe("invalid");
    expect(metadata.registryCacheWrite).toBe("skipped-unreadable-cache");
    expect(cacheKeysWritten()).not.toContain("risk_free_rates");
    expect(cacheKeysWritten()).not.toContain("risk_free_rate");
  });

  it("leaves an unreadable registry untouched when the run resolved no benchmark", async () => {
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeCacheRow("not-json-at-all", 1774479600),
      risk_free_rate: null,
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockUnavailableTbillByUrl();

    const result = await runBenchmarks();
    const metadata = runMetadata(result);

    expect(metadata.registryCacheState).toBe("invalid");
    expect(metadata.registryCacheWrite).toBe("skipped-unreadable-cache");
    expect(cacheKeysWritten()).not.toContain("risk_free_rates");
    expect(cacheKeysWritten()).not.toContain("risk_free_rate");
  });

  it.each([null, "CAD"] as const)("skips hourly refresh with recent USD and unused %s policy evidence", async (key) => {
    const fetchedAt = FROZEN_NOW.getTime() / 1000;
    const USD = makeBenchmarkCacheEntry({ key: "USD", rate: 3.91, recordDate: FRESH_FRED_OBSERVATION_DATE,
      fetchedAt: fetchedAt - 3600, source: "fred-dgs3mo" });
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        ...Object.fromEntries(YIELD_BENCHMARK_KEY_VALUES.filter(key => key !== "SGD").map(key => [key, { ...USD, key }])),
        ...(key ? { [key]: makeBenchmarkCacheEntry({ key, rate: 2.25, recordDate: "2025-01-01",
          fetchedAt: fetchedAt - 3600, source: "boc-valet-v122530" }) } : {}),
      }, fetchedAt - 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, { minRegistryAgeSec: RETRY_BOUND_SEC });
    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(runMetadata(result)).toMatchObject({ skipped: true, skipReason: "risk-free-registry-fresh", minRegistryAgeSec: RETRY_BOUND_SEC });
    expect(calls).toEqual([]);
    expect(cacheKeysWritten()).toEqual([]);
  });

  it.each([false, true])("retries EUR while carrying AUD proxy and expired CAD (recovery=%s)", async (recovery) => {
    const now = FROZEN_NOW.getTime() / 1000;
    const USD = makeBenchmarkCacheEntry({ key: "USD", rate: 3.91, recordDate: FRESH_FRED_OBSERVATION_DATE,
      fetchedAt: now - 3600, source: "fred-dgs3mo" });
    const row = makeRiskFreeRatesCacheRow({
      ...Object.fromEntries(YIELD_BENCHMARK_KEY_VALUES.filter(key => key !== "SGD").map(key => [key, { ...USD, key }])), USD,
      EUR: { ...makeBenchmarkCacheEntry({ key: "EUR", rate: 1.94, recordDate: FRESH_FRED_OBSERVATION_DATE,
        fetchedAt: now - 7200, source: "ecb-estr-3m" }), isFallback: true, fallbackMode: "ecb-failed-retained" },
      AUD: makeBenchmarkCacheEntry({ key: "AUD", rate: 4.36, recordDate: FRESH_FRED_OBSERVATION_DATE,
        fetchedAt: now - 3600, source: "rba-interbank-overnight", isProxy: true,
        isFallback: true, fallbackMode: "aud-interbank-overnight-proxy" }),
      CAD: { ...USD, key: "CAD", recordDate: "2025-01-01" },
    }, now - 3600);
    const marker = { generationId: "old", consecutiveFreshRuns: 2, lastFreshAt: now - 3600 };
    row.value = JSON.stringify({ ...JSON.parse(row.value), generationId: "old" });
    installCacheByKey(vi.mocked(getCache), { risk_free_rates: row,
      [USD_MARKER]: makeCacheRow(marker, now - 3600), [GBP_MARKER]: makeCacheRow(marker, now - 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl(recovery ? {} : { "data-api.ecb.europa.eu": null }, calls);
    const options = { minRegistryAgeSec: RETRY_BOUND_SEC };
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, options);
    expect(result.status).toBe(recovery ? "ok" : "degraded");
    expect(runMetadata(result)).toMatchObject({ fallbackMode: recovery ? null : "eur:ecb-failed-retained",
      resolvedBenchmarkKeys: recovery ? ["EUR"] : [] });
    expect(calls).toEqual([expect.stringContaining("data-api.ecb.europa.eu")]);
    expect(writtenBenchmarks().USD).toMatchObject(USD);
    expect(writtenBenchmarks()).toMatchObject({ EUR: { fetchedAt: recovery ? now : now - 7200 },
      AUD: { rate: 4.36, recordDate: FRESH_FRED_OBSERVATION_DATE, fetchedAt: now - 3600,
        source: "rba-interbank-overnight", fallbackMode: "aud-interbank-overnight-proxy" },
      CAD: { recordDate: "2025-01-01", fetchedAt: now - 3600 } });
    const stored = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key='risk_free_rates'").get()!;
    for (const key of [USD_MARKER, GBP_MARKER]) {
      const saved = sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)!;
      expect(JSON.parse(String(saved.value))).toEqual({ ...marker, generationId: JSON.parse(String(stored.value)).generationId });
    }
    installCacheByKey(vi.mocked(getCache), { risk_free_rates: makeCacheRow(stored.value, Number(stored.updated_at)) });
    vi.setSystemTime(FROZEN_NOW.getTime() + 3599_000);
    expect((await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, options)).status).toBe("skipped_neutral");
    expect(calls).toHaveLength(1);
  });

  it("retries unavailable CHF/JPY after EUR recovers until each recovers", async () => {
    const now = FROZEN_NOW.getTime() / 1000;
    installCacheByKey(vi.mocked(getCache), { risk_free_rates: makeRiskFreeRatesCacheRow({
      EUR: makeBenchmarkCacheEntry({ key: "EUR", source: "ecb-estr-3m", rate: 1.94,
        recordDate: FRESH_FRED_OBSERVATION_DATE, fetchedAt: now - 3600 }),
    }, now - 3600) });
    const failed = { "oauth/token": null, "stat-search.boj.or.jp": null };
    mockTbillByUrl({ ...failed, "data-api.ecb.europa.eu": null });
    expect((await runBenchmarks()).status).toBe("degraded");
    expect(writtenBenchmarks()).toMatchObject({ CHF: null, JPY: null, EUR: { fallbackMode: "ecb-failed-retained" } });
    const cache = await vi.importActual<typeof DbCache>("../../lib/db-cache");
    vi.mocked(getCache).mockImplementation(cache.getCache);
    for (const [hour, overrides, count, reason, resolved] of [
      [1, failed, 3, "chf:six-saron-failed,jpy:jpy-call-rate-failed", ["EUR"]],
      [3, failed, 2, "chf:six-saron-failed,jpy:jpy-call-rate-failed", []],
      [5, { "oauth/token": null }, 2, "chf:six-saron-failed", ["JPY"]],
      [7, {}, 2, null, ["CHF"]],
    ] as const) {
      vi.setSystemTime((now + hour * 3600) * 1000);
      const before = writtenBenchmarks();
      const calls: string[] = [];
      mockTbillByUrl(overrides, calls);
      const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, { minRegistryAgeSec: RETRY_BOUND_SEC });
      expect(result.status).toBe(reason ? "degraded" : "ok");
      expect(runMetadata(result)).toMatchObject({ fallbackMode: reason, resolvedBenchmarkKeys: resolved, ...(reason ? { reason } : {}) });
      expect(calls).toHaveLength(count);
      for (const key of YIELD_BENCHMARK_KEY_VALUES) {
        if (resolved.some(id => id === key)) expect(writtenBenchmarks()[key]).toMatchObject({ fetchedAt: now + hour * 3600, isFallback: false });
        else expect(writtenBenchmarks()[key]).toEqual(before[key]);
      }
    }
  });

  it.each(["MXN", "JPY"] as const)("keeps selective %s admission denial unavailable without HTTP", async (key) => {
    const now = FROZEN_NOW.getTime() / 1000;
    const healthy = makeBenchmarkCacheEntry({ key: "USD", rate: 3.91, recordDate: FRESH_FRED_OBSERVATION_DATE,
      fetchedAt: now - 3600, source: "fred-dgs3mo" });
    const before = Object.fromEntries(YIELD_BENCHMARK_KEY_VALUES.map(id => [id,
      id === key || id === "SGD" ? null : { ...healthy, key: id }]));
    installCacheByKey(vi.mocked(getCache), { risk_free_rates: makeRiskFreeRatesCacheRow(before, now - 3600) });
    if (key === "JPY") vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const calls: string[] = [];
    mockTbillByUrl({}, calls);
    const result = await fetchTbillRate(db, undefined, {}, { minRegistryAgeSec: RETRY_BOUND_SEC });
    const reason = key === "MXN" ? "banxico-token-missing" : "circuit-open";
    expect(result.status).toBe("degraded");
    expect(runMetadata(result)).toMatchObject({ fallbackMode: `${key.toLowerCase()}:${reason}`,
      resolvedBenchmarkKeys: [], failedBenchmarkResponseAttempts: [{ key, failureMode: reason, attempts: [] }] });
    expect(calls).toEqual([]);
    expect(vi.mocked(shouldAttemptFetch).mock.calls.map(([, source]) => source)).toEqual([`TREASURY_RATES:${key}`]);
    expect(writtenBenchmarks()).toMatchObject(before);
  });

  it.each([false, true])("refreshes expired USD without renewing failed evidence (failure=%s)", async (failure) => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    const oldRecordDate = new Date(FROZEN_NOW.getTime() - 6 * 86400_000).toISOString().slice(0, 10);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({ key: "USD", rate: 3.91, recordDate: oldRecordDate,
          fetchedAt: fetchedAt - 3600, source: "fred-dgs3mo" }),
      }, fetchedAt - 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl(failure ? { "id=DGS3MO": null, "treasury.gov": null } : {}, calls);
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, { minRegistryAgeSec: RETRY_BOUND_SEC });
    expect(result.status).toBe(failure ? "degraded" : "ok");
    expect(runMetadata(result).fallbackMode).toBe(failure ? "usd:all-sources-failed-retained" : null);
    expect(writtenBenchmarks().USD).toMatchObject({ rate: failure ? 3.91 : 3.72,
      recordDate: failure ? oldRecordDate : FRESH_FRED_OBSERVATION_DATE,
      fetchedAt: failure ? fetchedAt - 3600 : fetchedAt });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("refreshes a T+1 series nearing its record bound even while USD is fresh", async () => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    const nearBoundDate = new Date(FROZEN_NOW.getTime() - 4.5 * 86400_000).toISOString().slice(0, 10);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({ key: "USD", rate: 3.91, recordDate: FRESH_FRED_OBSERVATION_DATE,
          fetchedAt: fetchedAt - 3600, source: "fred-dgs3mo" }),
        GBP: makeBenchmarkCacheEntry({ key: "GBP", rate: 4.1, recordDate: nearBoundDate,
          fetchedAt: fetchedAt - 3600, source: "fred-sonia-compounded-index" }),
      }, fetchedAt - 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, { minRegistryAgeSec: RETRY_BOUND_SEC });
    expect(result.status).not.toBe("skipped_neutral");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("refreshes from the hourly retry when the newest market observation exceeds the bound", async () => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.91,
          recordDate: "2026-06-23",
          fetchedAt: fetchedAt - 25 * 3600,
          source: "fred-dgs3mo",
        }),
      }, fetchedAt - 25 * 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, {
      minRegistryAgeSec: RETRY_BOUND_SEC,
    });

    expect(result.status).toBe("ok");
    expect(calls.some((url) => url.includes("id=DGS3MO"))).toBe(true);
    expect(writtenBenchmarks().USD?.source).toBe("fred-dgs3mo");
  });

  it("refreshes when USD has no recent observation even though another key does", async () => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.91,
          recordDate: "2026-06-18",
          fetchedAt: fetchedAt - 26 * 3600,
          source: "fred-dgs3mo",
        }),
        EUR: makeBenchmarkCacheEntry({
          key: "EUR",
          rate: 1.94,
          recordDate: "2026-06-24",
          fetchedAt: fetchedAt - 600,
          source: "ecb-estr-3m",
        }),
      }, fetchedAt - 600),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, {
      minRegistryAgeSec: RETRY_BOUND_SEC,
    });

    expect(result.status).toBe("ok");
    expect(calls.some((url) => url.includes("id=DGS3MO"))).toBe(true);
  });

  it("keeps the canonical daily invocation unconditional", async () => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.91,
          recordDate: FRESH_FRED_OBSERVATION_DATE,
          fetchedAt: fetchedAt - 60,
          source: "fred-dgs3mo",
        }),
      }, fetchedAt - 60),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);

    const result = await runBenchmarks();

    expect(result.status).toBe("ok");
    expect(calls.some((url) => url.includes("id=DGS3MO"))).toBe(true);
  });
});
