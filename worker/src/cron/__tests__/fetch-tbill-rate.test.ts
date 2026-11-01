import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcbFixtures from "./fixtures/bcb-selic.json";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";
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
import { YIELD_BENCHMARK_KEY_VALUES } from "@shared/types/yield";
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

import { buildHardcodedUsdBenchmark, getBenchmarkKeyForPegCurrency, resolveBenchmarkForStablecoin, toYieldBenchmarkRegistry, withYieldBenchmarkStaticMeta } from "../yield-sync/benchmarks";
import { classifyYieldBenchmarkFreshness, YIELD_BENCHMARK_RECORD_MAX_AGE_SEC } from "@shared/lib/yield-benchmark-freshness";
import { loadRiskFreeRateRegistryWithState } from "../yield-sync/state";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { getCache } from "../../lib/db-cache";
import { logCronEvent } from "../../lib/cron-logger";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";

// ALFRED graph CSV uses the same observation shape with a date-stamped series column.
const ALFRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET = "observation_date,IUDZOS2_20260625\n2026-03-26,100\n2026-06-24,101\n";

// FRED and NY Fed observations enforce the shared per-key five-day budget.
// The shared routes ship static 2026-03 rows, so override them with fresh rows
// relative to FROZEN_NOW; tests that exercise a stale or future-dated feed pass
// their own override on top.
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
const GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY = "fetch-tbill-rate:gbp-retained-fallback-streak";

// The St. Louis Fed SONIA mirrors gate their latest observation against the
// real clock (140-day staleness / 1-day future-skew window in
// tbill-sources/fred.ts). Freeze Date so the static 2026 fixtures stay inside
// that window instead of silently rerouting GBP to the BoE fallback once the
// wall clock drifts past the fixtures.
const FROZEN_NOW = new Date("2026-06-25T12:00:00Z");
const fixtures = createLatestSchemaFixtureTracker();
let db: D1Database;
let sqlite: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
  ({ db, sqlite } = fixtures.open());
});

afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

describe("fetchTbillRate", () => {

  function latestCachePayload() {
    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("risk_free_rate");
    expect(row).toBeDefined();
    return JSON.parse(String(row?.value)) as {
      rate: number;
      source: string;
      fallbackMode: string | null;
      isFallback: boolean;
      recordDate: string | null;
    };
  }

  function latestStructuredCachePayload() {
    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("risk_free_rates");
    expect(row).toBeDefined();
    return JSON.parse(String(row?.value)) as {
      benchmarks: Record<string, {
        key: string;
        rate: number;
        source: string;
        isFallback: boolean;
        fallbackMode: string | null;
        recordDate: string | null;
      } | null>;
    };
  }

  function previousRiskFreeRatesCacheWithGbp() {
    return makeRiskFreeRatesCacheRow({
      USD: makeBenchmarkCacheEntry({
        key: "USD",
        label: "USD 3M T-Bill",
        rate: 3.72,
        recordDate: "2026-03-02",
        fetchedAt: 1773100800,
        source: "fred-dgs3mo",
      }),
      GBP: makeBenchmarkCacheEntry({
        key: "GBP",
        label: "GBP 3M compounded SONIA",
        rate: 4.05,
        recordDate: "2026-03-25",
        source: "fred-sonia-compounded-index",
      }),
    }, 1774479600);
  }

  function cacheWritePayload(key: string) {
    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key);
    expect(row).toBeDefined();
    return JSON.parse(String(row?.value)) as Record<string, unknown>;
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toContain("usd:circuit-open");
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
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
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.usdSource).toBe("fred-dgs3mo");
    expect(metadata.usdRate).toBe(3.72);
    expect(metadata.usdEffrSource).toBe("nyfed-effr");
    expect(metadata.usdEffrRate).toBe(4.33);
    expect(metadata.eurSource).toBe("ecb-estr-3m");
    expect(metadata.eurRate).toBe(1.9358);
    expect(metadata.chfSource).toBe("six-sar3mc");
    expect(metadata.chfRate).toBe(-0.0539);
    expect(metadata.gbpSource).toBe("fred-sonia-compounded-index");
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
    expect(metadata.gbpResponseAttemptCount).toBe(1);
    expect(metadata.gbpResponseAttempts).toEqual([
      expect.objectContaining({
        provider: "fred-sonia-compounded-index",
        status: 200,
        parsed: true,
        failure: null,
      }),
    ]);
    expect(metadata.jpySource).toBe("boj-call-rate");
    expect(metadata.jpyRate).toBe(0.1);
    expect(metadata.audSource).toBe("rba-cash-rate-target");
    expect(metadata.audRate).toBe(4.3);
    expect(metadata.mxnSource).toBe("banxico-cetes-28d");
    expect(metadata.mxnRate).toBe(10.45);
    expect(metadata.brlSource).toBe("bcb-selic");
    expect(metadata.brlRate).toBeCloseTo(13.638253562615565, 12);
    expect(metadata.cadSource).toBe("boc-valet-v122530");
    expect(metadata.cadRate).toBe(4.75);
    expect(metadata.rubSource).toBe("cbr-key-rate");
    expect(metadata.rubRate).toBe(14.5);
    expect(metadata.trySource).toBe("cbrt-evds-tlref");
    expect(metadata.tryRate).toBe(40);
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:USD", true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "fred-dgs3mo",
      fallbackMode: null,
      isFallback: false,
      recordDate: FRESH_FRED_OBSERVATION_DATE,
    });
    expect(latestStructuredCachePayload().benchmarks.USD_EFFR).toMatchObject({
      key: "USD_EFFR",
      rate: 4.33,
      source: "nyfed-effr",
      isFallback: false,
      fallbackMode: null,
    });
    expect(latestStructuredCachePayload().benchmarks.TRY).toMatchObject({
      key: "TRY",
      rate: 40,
      source: "cbrt-evds-tlref",
      isFallback: false,
      fallbackMode: null,
    });
    expect(Object.keys(latestStructuredCachePayload().benchmarks)).toEqual([...YIELD_BENCHMARK_KEY_VALUES]);
    expect(latestStructuredCachePayload().benchmarks.AUD).toMatchObject({
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
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.audSource).toBe(source);
    expect(metadata.audRate).toBe(rate);
    const expected = {
      key: "AUD", rate, recordDate: "2026-06-24", source, label,
      isProxy, isFallback: isProxy, fallbackMode: isProxy ? "aud-interbank-overnight-proxy" : null,
      lastMarketRate: rate, lastMarketSource: source,
    };
    expect(latestStructuredCachePayload().benchmarks.AUD).toMatchObject(expected);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeCacheRow(cacheWritePayload("risk_free_rates"), FROZEN_NOW.getTime() / 1000),
    });
    const loaded = await loadRiskFreeRateRegistryWithState(db);
    expect(loaded.cacheState).toBe("valid");
    expect(toYieldBenchmarkRegistry(loaded.registry).AUD).toMatchObject(expected);
  });

  it("fetches every benchmark descriptor on each daily run", async () => {
    const calls: string[] = [];
    mockTbillByUrl({}, calls);

    await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);

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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);

    expect(result.status).toBe("degraded");
    expect(calls.filter((url) => url.includes("data-api.ecb.europa.eu"))).toHaveLength(0);
    expect(calls.filter((url) => url.includes("report-download"))).toHaveLength(1);
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:CHF", true);
  });

  it("falls back to the ALFRED SONIA index when the FRED mirror is unreachable", async () => {
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": null,
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": (_url, opts) => {
        expect((opts?.headers as Record<string, string> | undefined)?.["User-Agent"])
          .toBe("Pharos/1.0 (+https://pharos.watch)");
        return new Response(ALFRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 });
      },
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.gbpSource).toBe("alfred-sonia-compounded-index");
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
    expect(metadata.gbpResponseResolvedProvider).toBe("alfred-sonia-compounded-index");
    expect(metadata.gbpResponseAttempts).toEqual([
      expect.objectContaining({
        provider: "fred-sonia-compounded-index",
        status: null,
        parsed: false,
        failure: "transport-failed",
      }),
      expect.objectContaining({
        provider: "alfred-sonia-compounded-index",
        status: 200,
        parsed: true,
        failure: null,
      }),
    ]);
  });

  it("falls back to ALFRED when the FRED SONIA index is stale", async () => {
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": new Response(
        "observation_date,IUDZOS2\n2000-01-01,100\n2000-04-01,101\n",
        { status: 200 },
      ),
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": new Response(
        ALFRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET,
        { status: 200 },
      ),
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.gbpSource).toBe("alfred-sonia-compounded-index");
    expect(metadata.gbpRecordDate).toBe("2026-06-24");
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
  });

  it("falls through a frozen 36-day-old FRED SONIA mirror to the current ALFRED observation", async () => {
    // The FRED mirror answers HTTP 200 with an unbounded historical CSV but has
    // stopped updating; ALFRED's copy carries the current print.
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": new Response(
        "observation_date,IUDZOS2\n2026-02-15,100\n2026-05-20,101\n",
        { status: 200 },
      ),
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": new Response(
        "observation_date,IUDZOS2_20260623\n2026-03-25,100\n2026-06-23,101\n",
        { status: 200 },
      ),
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.gbpSource).toBe("alfred-sonia-compounded-index");
    expect(metadata.gbpRecordDate).toBe("2026-06-23");
    expect(metadata.fallbackMode).toBeNull();

    const persisted = latestStructuredCachePayload();
    expect(persisted.benchmarks.GBP).toMatchObject({
      source: "alfred-sonia-compounded-index",
      recordDate: "2026-06-23",
      isFallback: false,
      fallbackMode: null,
    });

    // The persisted print must satisfy the same shared GBP bound the consumer
    // applies; a 36-day-old mirror print would classify stale there.
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeCacheRow(cacheWritePayload("risk_free_rates"), FROZEN_NOW.getTime() / 1000),
    });
    const loaded = await loadRiskFreeRateRegistryWithState(db);
    expect(loaded.cacheState).toBe("valid");
    const gbp = loaded.registry.GBP!;
    expect(classifyYieldBenchmarkFreshness(gbp, {
      recordDate: gbp.recordDate,
      maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.GBP,
      nowSec: FROZEN_NOW.getTime() / 1000,
    })).toBe("healthy");
  });

  it("falls back to the BoE SONIA index when St. Louis Fed SONIA observations are future dated", async () => {
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": new Response(
        "observation_date,IUDZOS2\n2099-01-01,100\n2099-04-01,101\n",
        { status: 200 },
      ),
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": new Response(
        "observation_date,IUDZOS2_20990401\n2099-01-01,100\n2099-04-01,101\n",
        { status: 200 },
      ),
      "bankofengland.co.uk": new Response(BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 }),
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.gbpSource).toBe("boe-sonia-compounded-index");
    expect(metadata.gbpRecordDate).toBe("2026-04-01");
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
    expect(metadata.gbpResponseAttempts).toEqual([
      expect.objectContaining({ provider: "fred-sonia-compounded-index", failure: "parse-failed" }),
      expect.objectContaining({ provider: "alfred-sonia-compounded-index", failure: "parse-failed" }),
      expect.objectContaining({ provider: "boe-sonia-compounded-index", parsed: true, failure: null }),
    ]);
  });

  it("falls back to the BoE SONIA index when the St. Louis Fed mirrors are unreachable", async () => {
    mockTbillByUrl({
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": null,
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": null,
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.gbpSource).toBe("boe-sonia-compounded-index");
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
        currency: "GBP",
        source: "fred-sonia-compounded-index",
        fallbackMode: "gbp-sonia-compounded-index-failed-retained",
        lastMarketSource: "fred-sonia-compounded-index",
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
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
    await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const firstGeneration = cacheWritePayload("risk_free_rates").generationId;
    mockTbillByUrl();

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
    await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const previousGenerationId = cacheWritePayload("risk_free_rates").generationId;
    let registryReads = 0;
    vi.mocked(getCache).mockImplementation(async (database, key) => {
      if (key === "risk_free_rates" && ++registryReads === 2) {
        throw new Error("previous generation unavailable");
      }
      return cache.getCache(database, key);
    });
    mockTbillByUrl();

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const generationId = cacheWritePayload("risk_free_rates").generationId;
    expect(result.status).toBe("ok");
    expect(generationId).not.toBe(previousGenerationId);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
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
    expect(latestCachePayload().rate).toBe(latestStructuredCachePayload().benchmarks.USD?.rate);
    mockTbillByUrl();
    const recovered = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    expect(JSON.parse(recovered.metadata ?? "{}")).toMatchObject({
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
      await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
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
          latestStructuredCachePayload().benchmarks.USD?.rate,
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
    await expect(fetchTbillRate(db, undefined, BANXICO_TEST_ENV)).resolves.toMatchObject({ status: "ok" });
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
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    expect(JSON.parse(result.metadata ?? "{}")).not.toHaveProperty("usdFreshPublicationVerifiedTwice");
    expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all()).toEqual([
      { key: "risk_free_rate" }, { key: "risk_free_rates" },
    ]);
    expect(logCronEvent).not.toHaveBeenCalled();
  });

  it("falls back to Treasury XML when FRED fails", async () => {
    mockTbillByUrl({
      "id=DGS3MO": null,
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.usdSource).toBe("treasury-yield-xml");
    expect(metadata.usdRate).toBe(3.72);
    expect(metadata.fallbackMode).toBeNull();
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:USD", true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "treasury-yield-xml",
      fallbackMode: null,
      isFallback: false,
      recordDate: "2026-03-13",
    });
  });

  it("falls back to FRED DFF when the NY Fed EFFR feed fails", async () => {
    mockTbillByUrl({
      "markets.newyorkfed.org": null,
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.usdEffrSource).toBe("fred-dff");
    expect(metadata.usdEffrRate).toBe(4.33);
    expect(latestStructuredCachePayload().benchmarks.USD_EFFR).toMatchObject({
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
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ usdEffrSource: "fred-dff", usdEffrRate: 4.33 });
    expect(calls.some((url) => url.includes("id=DFF"))).toBe(true);
    expect(latestStructuredCachePayload().benchmarks.USD_EFFR).toMatchObject({
      rate: 4.33, source: "fred-dff", isFallback: false, fallbackMode: null,
      recordDate: FRESH_FRED_OBSERVATION_DATE,
    });
  });


  it("falls back to Treasury XML when FRED returns invalid data", async () => {
    mockTbillByUrl({
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,.\n", { status: 200 }),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.usdSource).toBe("treasury-yield-xml");
    expect(metadata.usdRate).toBe(3.72);
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:USD", true);
  });

  it("retains the last EUR benchmark when the ECB feed fails", async () => {
    mockTbillByUrl({
      "data-api.ecb.europa.eu": null,
    });
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          label: "USD 3M T-Bill",
          rate: 3.72,
          recordDate: "2026-03-02",
          fetchedAt: 1773100800,
          source: "fred-dgs3mo",
        }),
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.eurSource).toBe("ecb-estr-3m");
    expect(metadata.eurRate).toBe(1.94);
    expect(metadata.fallbackMode).toBe("eur:ecb-failed-retained");
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
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
    expect(latestStructuredCachePayload().benchmarks.BRL).toMatchObject(retained);
    expect(metadata.retainedFallbackBenchmarks).toEqual([
      expect.objectContaining({ key: "BRL", retained: true, fetchedAt: observedAt, lastMarketFetchedAt: observedAt }),
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

      const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
      const metadata = JSON.parse(result.metadata ?? "{}");
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
      const entry = latestStructuredCachePayload().benchmarks.BRL!;
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
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.brlResponseAttempts[1]).toMatchObject({ parsed: true, failure });
    expect(latestStructuredCachePayload().benchmarks.BRL).toMatchObject({
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
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    expect(JSON.parse(result.metadata ?? "{}").brlSource).toBe("bcb-selic");
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
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    expect(JSON.parse(result.metadata ?? "{}").brlSource).toBe(source);
  });

  it("bounds response MIME diagnostics and never persists an error body", async () => {
    const mime = `text/${"x".repeat(200)}`;
    mockTbillByUrl({
      "api.bcb.gov.br": new Response(bcbFixtures.html, { headers: { "Content-Type": `${mime}; charset=utf-8` } }),
    });
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.brlResponseAttempts).toHaveLength(2);
    for (const attempt of metadata.brlResponseAttempts) {
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
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          label: "USD 3M T-Bill",
          rate: 3.72,
          recordDate: "2026-03-02",
          fetchedAt: 1773100800,
          source: "fred-dgs3mo",
        }),
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.72,
          recordDate: "2026-03-02",
          fetchedAt: 1773100800,
          source: "fred-dgs3mo",
        }),
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.usdEffrSource).toBe("fred-dff");
    expect(metadata.usdEffrRate).toBe(4.31);
    expect(metadata.fallbackMode).toBe("usd_effr:usd-effr-sources-failed-retained");
    expect(latestStructuredCachePayload().benchmarks.USD_EFFR).toMatchObject({
      key: "USD_EFFR",
      rate: 4.31,
      source: "fred-dff",
      isFallback: true,
      fallbackMode: "usd-effr-sources-failed-retained",
    });
  });

  it("returns degraded when both sources fail", async () => {
    mockUnavailableTbillByUrl();

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe(
      "usd:all-sources-failed,usd_effr:usd-effr-sources-failed,eur:ecb-failed,chf:six-saron-failed,gbp:gbp-sonia-compounded-index-failed,jpy:jpy-call-rate-failed,mxn:banxico-cetes-failed,brl:bcb-selic-failed,aud:aud-cash-rate-failed,cad:boc-corra-failed,rub:cbr-key-rate-failed,try:cbrt-tlref-failed",
    );
    expect(recordOutcome).toHaveBeenCalledWith(db, "TREASURY_RATES:USD", false);
    expect(latestCachePayload()).toMatchObject({
      rate: RISK_FREE_RATE_FALLBACK,
      source: "hardcoded-fallback",
      fallbackMode: "all-sources-failed",
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

  it("retains last known good rate when both sources fail", async () => {
    mockUnavailableTbillByUrl();
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rate: {
          value: JSON.stringify({
            rate: 3.91,
            recordDate: "2026-03-07",
            fetchedAt: 1773100800,
            source: "fred-dgs3mo",
            isFallback: false,
            fallbackMode: null,
          }),
          updatedAt: 1773100800,
      },
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
    });
  });

  it("retains the last market-derived rate across consecutive degraded fallback days", async () => {
    mockUnavailableTbillByUrl();
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rate: {
          value: JSON.stringify({
            rate: 3.91,
            recordDate: "2026-03-07",
            fetchedAt: 1773100800,
            source: "fred-dgs3mo",
            isFallback: true,
            fallbackMode: "all-sources-failed-retained",
            lastMarketRate: 3.91,
            lastMarketRecordDate: "2026-03-07",
            lastMarketFetchedAt: 1773100800,
            lastMarketSource: "fred-dgs3mo",
          }),
          updatedAt: 1773104400,
      },
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
      lastMarketRate: 3.91,
      lastMarketSource: "fred-dgs3mo",
    });
  });

  it("rejects a published-rate unit drift and retains the previous USD observation", async () => {
    const driftedSnippet = TREASURY_XML_SNIPPET.replaceAll("3.72", "0.43").replaceAll("3.71", "0.43");
    mockTbillByUrl({
      "id=DGS3MO": new Response(`DATE,DGS3MO\n${FRESH_FRED_OBSERVATION_DATE},0.43\n`, { status: 200 }),
      "home.treasury.gov": new Response(driftedSnippet, { status: 200 }),
    });
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(String(metadata.fallbackMode)).toContain("usd:usd-rate-out-of-band-retained");
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "fred-dgs3mo",
      fallbackMode: "usd-rate-out-of-band-retained",
      isFallback: true,
    });
    expect(logCronEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: "benchmark-rate-out-of-band",
      metadata: expect.objectContaining({ key: "USD", rate: 0.43, previousMarketRate: 3.72 }),
    }));
  });

  it("falls through to the independent Treasury feed when FRED drifts out of band", async () => {
    mockTbillByUrl({
      "id=DGS3MO": new Response(`DATE,DGS3MO\n${FRESH_FRED_OBSERVATION_DATE},0.43\n`, { status: 200 }),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(String(metadata.fallbackMode)).not.toContain("usd-rate-out-of-band");
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "treasury-yield-xml",
      isFallback: false,
    });
    expect(logCronEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: "benchmark-rate-out-of-band",
    }));
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
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.72,
          recordDate: "2026-03-02",
          fetchedAt: 1773100800,
          source: "fred-dgs3mo",
        }),
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
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.mxnSource).toBe("banxico-cetes-28d");
    expect(metadata.mxnRate).toBe(10.45);
    expect(String(metadata.fallbackMode)).toContain("mxn:banxico-cetes-failed-retained");
  });
});

describe("getBenchmarkKeyForPegCurrency", () => {
  it("routes each supported peg currency to its native benchmark key", () => {
    expect(getBenchmarkKeyForPegCurrency("USD")).toBe("USD");
    expect(getBenchmarkKeyForPegCurrency("EUR")).toBe("EUR");
    expect(getBenchmarkKeyForPegCurrency("CHF")).toBe("CHF");
    expect(getBenchmarkKeyForPegCurrency("GBP")).toBe("GBP");
    expect(getBenchmarkKeyForPegCurrency("JPY")).toBe("JPY");
    expect(getBenchmarkKeyForPegCurrency("MXN")).toBe("MXN");
    expect(getBenchmarkKeyForPegCurrency("BRL")).toBe("BRL");
    expect(getBenchmarkKeyForPegCurrency("AUD")).toBe("AUD");
    expect(getBenchmarkKeyForPegCurrency("CAD")).toBe("CAD");
    expect(getBenchmarkKeyForPegCurrency("RUB")).toBe("RUB");
    expect(getBenchmarkKeyForPegCurrency("TRY")).toBe("TRY");
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
    key: "USD" | "USD_EFFR" | "EUR" | "CHF" | "GBP" | "JPY" | "MXN" | "BRL" | "AUD" | "CAD" | "RUB" | "TRY" | "SGD",
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
    overrides: Partial<Record<
      "USD_EFFR" | "EUR" | "CHF" | "GBP" | "JPY" | "MXN" | "BRL" | "AUD" | "CAD" | "RUB" | "TRY",
      boolean
    >> = {},
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

  it("keeps the fetch-age and fallback rules when no observation bound is supplied", () => {
    expect(classifyYieldBenchmarkFreshness({ ageSeconds: 60, isFallback: true, fallbackMode: "x" })).toBe("degraded");
    expect(classifyYieldBenchmarkFreshness({ ageSeconds: null, isFallback: false, fallbackMode: null })).toBe("stale");
  });

});

describe("fetchTbillRate — benchmark observation guard and registry integrity", () => {
  const RETRY_BOUND_SEC = 24 * 3600;

  function runMetadata(result: { metadata?: string }) {
    return JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
  }

  function writtenBenchmarks() {
    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("risk_free_rates");
    expect(row).toBeDefined();
    return (JSON.parse(String(row?.value)) as {
      benchmarks: Record<string, {
        rate: number;
        source: string;
        isFallback: boolean;
        fallbackMode: string | null;
        recordDate: string | null;
      } | null>;
    }).benchmarks;
  }

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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);

    expect(runMetadata(result).usdSource).toBe("treasury-yield-xml");
    expect(writtenBenchmarks().USD).toMatchObject({
      rate: 3.72,
      source: "treasury-yield-xml",
      isFallback: false,
      recordDate: "2026-03-13",
    });
  });

  it("rejects a future-dated DGS3MO row instead of publishing it as market data", async () => {
    mockTbillByUrl({
      "id=DGS3MO": new Response("DATE,DGS3MO\n2099-01-01,3.72\n", { status: 200 }),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);

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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = runMetadata(result);

    expect(metadata.registryCacheState).toBe("invalid");
    expect(metadata.registryCacheWrite).toBe("skipped-unreadable-cache");
    expect(cacheKeysWritten()).not.toContain("risk_free_rates");
    expect(cacheKeysWritten()).not.toContain("risk_free_rate");
  });

  it("skips the hourly retry while the registry still carries a recent market observation", async () => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({
          key: "USD",
          rate: 3.91,
          recordDate: FRESH_FRED_OBSERVATION_DATE,
          fetchedAt: fetchedAt - 3600,
          source: "fred-dgs3mo",
        }),
      }, fetchedAt - 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, {
      minRegistryAgeSec: RETRY_BOUND_SEC,
    });

    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(runMetadata(result)).toMatchObject({
      skipped: true,
      skipReason: "risk-free-registry-fresh",
      minRegistryAgeSec: RETRY_BOUND_SEC,
    });
    expect(calls).toEqual([]);
    expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([]);
  });

  it("does not force hourly catch-up for an unused old policy-rate record", async () => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({ key: "USD", rate: 3.91, recordDate: FRESH_FRED_OBSERVATION_DATE,
          fetchedAt: fetchedAt - 3600, source: "fred-dgs3mo" }),
        CAD: makeBenchmarkCacheEntry({ key: "CAD", rate: 2.25, recordDate: "2025-01-01",
          fetchedAt: fetchedAt - 3600, source: "boc-valet-v122530" }),
      }, fetchedAt - 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, { minRegistryAgeSec: RETRY_BOUND_SEC });
    expect(result.status).toBe("skipped_neutral");
    expect(calls).toEqual([]);
  });

  it("refreshes an expired observation even when the last fetch is recent", async () => {
    const fetchedAt = Math.floor(FROZEN_NOW.getTime() / 1000);
    const oldRecordDate = new Date(FROZEN_NOW.getTime() - 6 * 86400_000).toISOString().slice(0, 10);
    installCacheByKey(vi.mocked(getCache), {
      risk_free_rates: makeRiskFreeRatesCacheRow({
        USD: makeBenchmarkCacheEntry({ key: "USD", rate: 3.91, recordDate: oldRecordDate,
          fetchedAt: fetchedAt - 3600, source: "fred-dgs3mo" }),
      }, fetchedAt - 3600),
    });
    const calls: string[] = [];
    mockTbillByUrl({}, calls);
    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV, { minRegistryAgeSec: RETRY_BOUND_SEC });
    expect(result.status).not.toBe("skipped_neutral");
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

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);

    expect(result.status).toBe("ok");
    expect(calls.some((url) => url.includes("id=DGS3MO"))).toBe(true);
  });
});
