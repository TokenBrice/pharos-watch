import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE, RISK_FREE_RATE_FALLBACK } from "../../lib/constants";
import { mockCircuitOutcomeRecord, mockFetchRetry } from "../../test-helpers/cron";
import {
  installCacheByKey,
  installBenchmarkFetch,
  makeBenchmarkCacheEntry,
  makeNewCurrencyFetchRoutes,
  makeRiskFreeRatesCacheRow,
  makeTbillFetchRoutes,
  makeUnavailableTbillFetchRoutes,
  type BenchmarkFetchRoutes,
} from "./rates-cron.test-support";
import { YIELD_BENCHMARK_KEY_VALUES } from "@shared/types/yield";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: vi.fn(), passthroughNonResponse: true }));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
  setCache: vi.fn(),
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

import {
  buildHardcodedUsdBenchmark,
  getBenchmarkKeyForPegCurrency,
  resolveBenchmarkForStablecoin,
  withYieldBenchmarkStaticMeta,
} from "../yield-sync/benchmarks";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { getCache, setCache } from "../../lib/db-cache";
import { logCronEvent } from "../../lib/cron-logger";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";

const TREASURY_XML_SNIPPET = `<QR_BC_CM><LIST_G_WEEK_OF_MONTH>
<G_WEEK_OF_MONTH><LIST_G_NEW_DATE>
<G_NEW_DATE><LIST_G_BC_CAT><G_BC_CAT>
<BC_3MONTH>3.71</BC_3MONTH>
</G_BC_CAT></LIST_G_BC_CAT><NEW_DATE>03-12-2026</NEW_DATE></G_NEW_DATE>
<G_NEW_DATE><LIST_G_BC_CAT><G_BC_CAT>
<BC_3MONTH>3.72</BC_3MONTH>
</G_BC_CAT></LIST_G_BC_CAT><NEW_DATE>03-13-2026</NEW_DATE></G_NEW_DATE>
</LIST_G_NEW_DATE></G_WEEK_OF_MONTH>
</LIST_G_WEEK_OF_MONTH></QR_BC_CM>`;

const BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET = "DATE,IUDZOS2\n01 Jan 2026,100\n01 Apr 2026,101\n";
// ALFRED graph CSV uses the same observation shape with a date-stamped series column.
const ALFRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET = "observation_date,IUDZOS2_20260625\n2026-01-01,100\n2026-04-01,101\n";
const CBRT_TLREF_JSON_SNIPPET = JSON.stringify({
  totalCount: 2,
  items: [
    { Tarih: "06-05-2026", TP_BISTTLREF_ORAN: "39.99" },
    { Tarih: "06-08-2026", TP_BISTTLREF_ORAN: "40.00" },
  ],
});
function mockTbillByUrl(overrides: BenchmarkFetchRoutes = {}, calls?: string[]) {
  installBenchmarkFetch(vi.mocked(fetchWithRetry), makeTbillFetchRoutes(overrides), calls);
}

function mockNewCurrencyByUrl(overrides: BenchmarkFetchRoutes = {}, calls?: string[]) {
  installBenchmarkFetch(vi.mocked(fetchWithRetry), makeNewCurrencyFetchRoutes(overrides), calls);
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchTbillRate", () => {
  const db = {} as D1Database;

  function latestCachePayload() {
    const calls = vi.mocked(setCache).mock.calls;
    const call = calls[calls.length - 1];
    expect(call?.[1]).toBe("risk_free_rate");
    return JSON.parse(String(call?.[2])) as {
      rate: number;
      source: string;
      fallbackMode: string | null;
      isFallback: boolean;
      recordDate: string | null;
    };
  }

  function latestStructuredCachePayload() {
    const call = [...vi.mocked(setCache).mock.calls]
      .reverse()
      .find((entry) => entry[1] === "risk_free_rates");
    expect(call).toBeDefined();
    return JSON.parse(String(call?.[2])) as {
      benchmarks: Record<string, {
        key: string;
        rate: number;
        source: string;
        isFallback: boolean;
        fallbackMode: string | null;
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
    const call = vi.mocked(setCache).mock.calls.find((entry) => entry[1] === key);
    expect(call).toBeDefined();
    return JSON.parse(String(call?.[2])) as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
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
    expect(metadata.fallbackMode).toBe("usd:circuit-open");
    expect(metadata.eurSource).toBe("ecb-estr-3m");
    expect(metadata.usdEffrSource).toBe("nyfed-effr");
    expect(metadata.gbpSource).toBe("fred-sonia-compounded-index");
    expect(latestCachePayload()).toMatchObject({
      rate: RISK_FREE_RATE_FALLBACK,
      source: "hardcoded-fallback",
      fallbackMode: "circuit-open",
      isFallback: true,
    });
    expect(calls.some((url) => url.includes("id=DGS3MO"))).toBe(false);
    expect(calls.some((url) => url.includes("treasury.gov"))).toBe(false);
    expect(calls.some((url) => url.includes("data-api.ecb.europa.eu"))).toBe(true);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("returns ok from benchmark feeds", async () => {
    mockTbillByUrl({
      "id=DGS3MO": (_url, opts) => {
        expect((opts?.headers as Record<string, string> | undefined)?.["User-Agent"])
          .toBe("Pharos/1.0 (+https://pharos.watch)");
        return new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 });
      },
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

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
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "fred-dgs3mo",
      fallbackMode: null,
      isFallback: false,
      recordDate: "2026-03-02",
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
    expect(metadata.gbpRecordDate).toBe("2026-04-01");
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
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
    mockTbillByUrl();
    installCacheByKey(vi.mocked(getCache), {
      [GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY]: {
        value: JSON.stringify({
          consecutiveRetainedRuns: 0,
          consecutiveFreshRuns: 1,
          lastFreshAt: 1774479600,
          lastFreshSource: "fred-sonia-compounded-index",
          lastFreshRecordDate: "2026-03-25",
        }),
        updatedAt: 1774479600,
      },
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(metadata).toMatchObject({
      gbpFreshPublicationStreak: 2,
      gbpFreshPublicationVerifiedTwice: true,
    });
    expect(cacheWritePayload(GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY)).toMatchObject({
      consecutiveFreshRuns: 2,
      lastFreshSource: "fred-sonia-compounded-index",
    });
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
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
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
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
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
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
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

    expect(setCache).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("retains last known good rate when both sources fail", async () => {
    mockUnavailableTbillByUrl();
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
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
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
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
});


describe("fetchTbillRate — new currency fetchers", () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
  });

  it("hits each new endpoint URL and parses its native shape", async () => {
    const calls: string[] = [];
    mockNewCurrencyByUrl({
      "banxico.org.mx": (_url, opts) => {
        const header = (opts?.headers as Record<string, string> | undefined)?.["Bmx-Token"];
        expect(header).toBe("test-token");
        return new Response(
          JSON.stringify({ bmx: { series: [{ datos: [{ fecha: "26/03/2026", dato: "10.45" }] }] } }),
          { status: 200 },
        );
      },
      "DailyInfoWebServ": (_url, opts) => {
        expect(opts?.method).toBe("POST");
        expect(String(opts?.body ?? "")).toContain("KeyRateXML");
        return new Response(
          "<KeyRate><KR><DT>2026-06-11T00:00:00+03:00</DT><Rate>14.50</Rate></KR></KeyRate>",
          { status: 200 },
        );
      },
      "evds3.tcmb.gov.tr/igmevdsms-dis/fe": (_url, opts) => {
        expect(opts?.method).toBe("POST");
        expect(String(opts?.body ?? "")).toContain('"series":"TP.BISTTLREF.ORAN"');
        return new Response(CBRT_TLREF_JSON_SNIPPET, { status: 200 });
      },
    }, calls);

    const result = await fetchTbillRate(db, undefined, { BANXICO_TOKEN: "test-token" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.usdEffrRate).toBe(4.33);
    expect(metadata.gbpRate).toBeCloseTo(4.05556, 5);
    expect(metadata.jpyRate).toBe(0.1);
    expect(metadata.audRate).toBe(4.3);
    expect(metadata.mxnRate).toBe(10.45);
    expect(metadata.brlRate).toBeCloseTo(13.638253562615565, 12);
    expect(metadata.cadRate).toBe(4.75);
    expect(metadata.rubRate).toBe(14.5);
    expect(metadata.tryRate).toBe(40);
    expect(calls.some((u) => u.includes("markets.newyorkfed.org"))).toBe(true);
    expect(calls.some((u) => u.includes("id=DFF"))).toBe(false);
    expect(calls.some((u) => u.includes("fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2"))).toBe(true);
    expect(calls.some((u) => u.includes("alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2"))).toBe(false);
    expect(calls.some((u) => u.includes("bankofengland.co.uk") && u.includes("SeriesCodes=IUDZOS2"))).toBe(false);
    expect(calls.some((u) => u.includes("stat-search.boj.or.jp"))).toBe(true);
    expect(calls.some((u) => u.includes("rba.gov.au/statistics/tables/csv/f1-data.csv"))).toBe(true);
    expect(calls.some((u) => u.includes("banxico.org.mx"))).toBe(true);
    expect(calls.some((u) => u.includes("api.bcb.gov.br"))).toBe(true);
    expect(calls.some((u) => u.includes("bankofcanada.ca/valet"))).toBe(true);
    expect(calls.some((u) => u.includes("cbr.ru/DailyInfoWebServ/DailyInfo.asmx"))).toBe(true);
    expect(calls.some((u) => u.includes("evds3.tcmb.gov.tr/igmevdsms-dis/fe"))).toBe(true);
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

  it("uses USD EFFR for USDGO when the rate-derived config requests it", () => {
    const benchmarks = buildRegistry({ USD_EFFR: true });
    const result = resolveBenchmarkForStablecoin({
      stablecoinId: "usdgo-osl",
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

  it("falls back to USD for USDGO when the optional EFFR benchmark is unavailable", () => {
    const benchmarks = buildRegistry();
    const result = resolveBenchmarkForStablecoin({
      stablecoinId: "usdgo-osl",
      benchmarks,
      benchmarkCurrency: "USD_EFFR",
    });

    expect(result.key).toBe("USD");
    expect(result.selectionMode).toBe("fallback-usd");
  });
});
