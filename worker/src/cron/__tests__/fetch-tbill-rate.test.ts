import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIRCUIT_SOURCE, RISK_FREE_RATE_FALLBACK } from "../../lib/constants";
import { mockCircuitOutcomeRecord, mockFetchRetry } from "../../test-helpers/cron";

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
  parseBanxicoSeries,
  parseBcbSelicSeries,
  parseBoeSoniaCsv,
  parseBoeSoniaCompoundedIndexCsv,
  parseBojCallRateJson,
  parseBocValetSeries,
  parseCbrKeyRateXml,
  parseCbrtEvdsSeries,
  parseEcbCompoundedEstrCsv,
  parseNyFedEffrJson,
  parseRbaF1MoneyMarketCsv,
  parseSixSar3mcCsv,
  parseTreasuryYieldXml,
} from "../fetch-tbill-rate";
import { parseEtherfuseCetesStablebondPage } from "../yield-sync/etherfuse-cetes";
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

const ECB_ESTR_3M_CSV_SNIPPET = `KEY,FREQ,BENCHMARK_ITEM,DATA_TYPE_EST,TIME_PERIOD,OBS_VALUE,OBS_STATUS,CONF_STATUS,PRE_BREAK_VALUE,COMMENT_OBS,CALCUL_START_DATE,CALCUL_END_DATE,TIME_FORMAT,BREAKS,COMMENT_TS,COMPILING_ORG,COVERAGE,DATA_COMP,DECIMALS,DISS_ORG,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,TIME_PER_COLLECT,TITLE,TITLE_COMPL,UNIT_INDEX_BASE,UNIT_MEASURE,UNIT_MULT
EST.B.EU000A2QQF32.CR,B,EU000A2QQF32,CR,2026-03-25,1.93576,A,F,,,,,P1D,,,,"ESA 2010 Sectors: S.121, S.122, S.123, S.124, S.125, S.126, S.127, S.128, S.129",,5,,,,,V,"Compounded euro short-term average rate, 3 months tenor","Compounded euro short-term average rate, 3 months tenor",,PC,0
EST.B.EU000A2QQF32.CR,B,EU000A2QQF32,CR,2026-03-26,1.9358,A,F,,,,,P1D,,,,"ESA 2010 Sectors: S.121, S.122, S.123, S.124, S.125, S.126, S.127, S.128, S.129",,5,,,,,V,"Compounded euro short-term average rate, 3 months tenor","Compounded euro short-term average rate, 3 months tenor",,PC,0
`;

const SIX_GUEST_TOKEN_RESPONSE = JSON.stringify({
  token_type: "Bearer",
  expires_in: 3000,
  access_token: "guest-token",
});

const SIX_SAR3MC_CSV_SNIPPET = `date;end_date;start_date;symbol;value;day_count;dcc
25.03.2026;26.03.2026;24.12.2025;SAR3MC;-0.0539;92;360
24.03.2026;25.03.2026;24.12.2025;SAR3MC;-0.0539;91;360
23.03.2026;24.03.2026;24.12.2025;SAR3MC;-0.0540;90;360
`;

const FRED_DFF_CSV_SNIPPET = "DATE,DFF\n2026-03-02,4.33\n";
const NYFED_EFFR_JSON_SNIPPET = JSON.stringify({
  refRates: [
    { effectiveDate: "2026-03-02", type: "EFFR", percentRate: 4.33 },
  ],
});
const BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET = "DATE,IUDZOS2\n01 Jan 2026,100\n01 Apr 2026,101\n";
// FRED mirror of the same IUDZOS2 series, ISO dates — derives to the same rate.
const FRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET = "observation_date,IUDZOS2\n2026-01-01,100\n2026-04-01,101\n";
// ALFRED graph CSV uses the same observation shape with a date-stamped series column.
const ALFRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET = "observation_date,IUDZOS2_20260625\n2026-01-01,100\n2026-04-01,101\n";
const CBRT_TLREF_JSON_SNIPPET = JSON.stringify({
  totalCount: 2,
  items: [
    { Tarih: "06-05-2026", TP_BISTTLREF_ORAN: "39.99" },
    { Tarih: "06-08-2026", TP_BISTTLREF_ORAN: "40.00" },
  ],
});
const CBR_KEY_RATE_XML_SNIPPET = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <KeyRateXMLResponse xmlns="http://web.cbr.ru/">
      <KeyRateXMLResult>
        <KR><DT>2026-06-09T00:00:00+03:00</DT><Rate>18.00</Rate></KR>
        <KR><DT>2026-06-11T00:00:00+03:00</DT><Rate>14.50</Rate></KR>
      </KeyRateXMLResult>
    </KeyRateXMLResponse>
  </soap:Body>
</soap:Envelope>`;

const ETHERFUSE_CETES_HTML = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      cachedStablebondsLookup: {
        calculatedAt: "2026-05-19T14:24:43.661467807+00:00",
      },
      cachedBonds: [
        {
          issuanceNumber: 110,
          currentIssuance: {
            address: "2p3sFHSkC7f8WoxenAgcpGbKjDYHtAScMuJPft47o5cS",
            startingTokenAmount: "1.162263",
            endingTokenAmount: "1.163506",
            startDate: 1778798112000,
            endDate: 1779402912000,
            interestRateBps: 558,
            status: 1,
          },
          mint: {
            symbol: "CETES",
            currentTokenAmount: "1.163091",
          },
        },
      ],
    },
  },
})}</script></body></html>`;

type MockUrlResponse = Response | null | ((url: string, opts?: RequestInit) => Response | null);

function cloneResponse(response: Response | null): Response | null {
  if (!response) return null;
  return response.clone();
}

function mockByUrl(mapping: Record<string, MockUrlResponse>, calls?: string[]) {
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string, opts?: RequestInit) => {
    calls?.push(url);
    for (const [pattern, response] of Object.entries(mapping)) {
      if (url.includes(pattern)) {
        const resolved = typeof response === "function" ? response(url, opts) : response;
        return cloneResponse(resolved);
      }
    }
    return null;
  });
}

/** Mocks every extended benchmark endpoint with a successful response. Used to
 *  isolate provider-specific test cases from added benchmark coverage. */
function okExtendedBenchmarkMocks(): Record<string, MockUrlResponse> {
  return {
    "markets.newyorkfed.org": new Response(NYFED_EFFR_JSON_SNIPPET, { status: 200 }),
    "id=DFF": new Response(FRED_DFF_CSV_SNIPPET, { status: 200 }),
    "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": (_url, opts) => {
      expect((opts?.headers as Record<string, string> | undefined)?.["User-Agent"])
        .toBe("Pharos/1.0 (+https://pharos.watch)");
      return new Response(FRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 });
    },
    "bankofengland.co.uk": new Response(BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 }),
    "stat-search.boj.or.jp": new Response(JSON.stringify({
      RESULTSET: [{
        SERIES_CODE: "STRDCLUCON",
        VALUES: { SURVEY_DATES: [20260302], VALUES: [0.1] },
      }],
    }), { status: 200 }),
    "rba.gov.au/statistics/tables/csv/f1-data.csv": new Response(
      "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate\n"
      + "02-Mar-2026,4.30,,4.31\n",
      { status: 200 },
    ),
    "banxico.org.mx": new Response(
      JSON.stringify({
        bmx: { series: [{ datos: [{ fecha: "26/03/2026", dato: "10.45" }] }] },
      }),
      { status: 200 },
    ),
    "api.bcb.gov.br": new Response(JSON.stringify([{ data: "26/03/2026", valor: "0.050747" }]), { status: 200 }),
    "bankofcanada.ca/valet": new Response(
      JSON.stringify({
        observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
      }),
      { status: 200 },
    ),
    "DailyInfoWebServ": new Response(CBR_KEY_RATE_XML_SNIPPET, { status: 200, headers: { "Content-Type": "text/xml" } }),
    "evds3.tcmb.gov.tr/igmevdsms-dis/fe": new Response(CBRT_TLREF_JSON_SNIPPET, { status: 200 }),
  };
}

/** Banxico requires a token; pass via env. */
const BANXICO_TEST_ENV = { BANXICO_TOKEN: "test-token" } as const;
const GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY = "fetch-tbill-rate:gbp-retained-fallback-streak";

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
    return {
      value: JSON.stringify({
        version: 1,
        benchmarks: {
          USD: {
            key: "USD",
            label: "USD 3M T-Bill",
            currency: "USD",
            rate: 3.72,
            recordDate: "2026-03-02",
            fetchedAt: 1773100800,
            source: "fred-dgs3mo",
            isFallback: false,
            fallbackMode: null,
            isProxy: false,
            lastMarketRate: 3.72,
            lastMarketRecordDate: "2026-03-02",
            lastMarketFetchedAt: 1773100800,
            lastMarketSource: "fred-dgs3mo",
          },
          GBP: {
            key: "GBP",
            label: "GBP 3M compounded SONIA",
            currency: "GBP",
            rate: 4.05,
            recordDate: "2026-03-25",
            fetchedAt: 1774479600,
            source: "fred-sonia-compounded-index",
            isFallback: false,
            fallbackMode: null,
            isProxy: false,
            lastMarketRate: 4.05,
            lastMarketRecordDate: "2026-03-25",
            lastMarketFetchedAt: 1774479600,
            lastMarketSource: "fred-sonia-compounded-index",
          },
        },
      }),
      updatedAt: 1774479600,
    } as never;
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
    }, calls);

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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": (_url, opts) => {
        expect((opts?.headers as Record<string, string> | undefined)?.["User-Agent"])
          .toBe("Pharos/1.0 (+https://pharos.watch)");
        return new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 });
      },
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
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
  });

  it("falls back to the ALFRED SONIA index when the FRED mirror is unreachable", async () => {
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": null,
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": null,
      "bankofengland.co.uk": null,
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") {
        return previousRiskFreeRatesCacheWithGbp();
      }
      return null as never;
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
      "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": null,
      "alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2": null,
      "bankofengland.co.uk": null,
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") return previousRiskFreeRatesCacheWithGbp();
      if (key === GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY) {
        return {
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
        } as never;
      }
      return null as never;
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY) {
        return {
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
        } as never;
      }
      return null as never;
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => key === GBP_RETAINED_FALLBACK_STREAK_CACHE_KEY
      ? {
          value: JSON.stringify({
            consecutiveRetainedRuns: 0,
            consecutiveFreshRuns: 1,
            lastFreshAt: 1774479600,
            lastFreshSource: "fred-sonia-compounded-index",
            lastFreshRecordDate: "2026-03-25",
          }),
          updatedAt: 1774479600,
        } as never
      : null as never);

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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": null,
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      ...okExtendedBenchmarkMocks(),
      "markets.newyorkfed.org": null,
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
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
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,.\n", { status: 200 }),
      "home.treasury.gov": new Response(TREASURY_XML_SNIPPET, { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.usdSource).toBe("treasury-yield-xml");
    expect(metadata.usdRate).toBe(3.72);
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
  });

  it("retains the last EUR benchmark when the ECB feed fails", async () => {
    mockByUrl({
      "data-api.ecb.europa.eu": null,
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
      ...okExtendedBenchmarkMocks(),
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") {
        return {
          value: JSON.stringify({
            version: 1,
            benchmarks: {
              USD: {
                key: "USD",
                label: "USD 3M T-Bill",
                currency: "USD",
                rate: 3.72,
                recordDate: "2026-03-02",
                fetchedAt: 1773100800,
                source: "fred-dgs3mo",
                isFallback: false,
                fallbackMode: null,
                isProxy: false,
                lastMarketRate: 3.72,
                lastMarketRecordDate: "2026-03-02",
                lastMarketFetchedAt: 1773100800,
                lastMarketSource: "fred-dgs3mo",
              },
              EUR: {
                key: "EUR",
                label: "EUR 3M compounded €STR",
                currency: "EUR",
                rate: 1.94,
                recordDate: "2026-03-24",
                fetchedAt: 1774393200,
                source: "ecb-estr-3m",
                isFallback: false,
                fallbackMode: null,
                isProxy: false,
                lastMarketRate: 1.94,
                lastMarketRecordDate: "2026-03-24",
                lastMarketFetchedAt: 1774393200,
                lastMarketSource: "ecb-estr-3m",
              },
              CHF: null,
            },
          }),
          updatedAt: 1774393200,
        } as never;
      }
      return null as never;
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.eurSource).toBe("ecb-estr-3m");
    expect(metadata.eurRate).toBe(1.94);
    expect(metadata.fallbackMode).toBe("eur:ecb-failed-retained");
  });

  it("retains the last CHF benchmark when the SIX SARON fetch fails", async () => {
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "oauth/token": null,
      "report-download": null,
      ...okExtendedBenchmarkMocks(),
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") {
        return {
          value: JSON.stringify({
            version: 1,
            benchmarks: {
              USD: {
                key: "USD",
                label: "USD 3M T-Bill",
                currency: "USD",
                rate: 3.72,
                recordDate: "2026-03-02",
                fetchedAt: 1773100800,
                source: "fred-dgs3mo",
                isFallback: false,
                fallbackMode: null,
                isProxy: false,
                lastMarketRate: 3.72,
                lastMarketRecordDate: "2026-03-02",
                lastMarketFetchedAt: 1773100800,
                lastMarketSource: "fred-dgs3mo",
              },
              EUR: null,
              CHF: {
                key: "CHF",
                label: "CHF 3M compounded SARON",
                currency: "CHF",
                rate: -0.0539,
                recordDate: "2026-03-25",
                fetchedAt: 1774479600,
                source: "six-sar3mc",
                isFallback: false,
                fallbackMode: null,
                isProxy: false,
                lastMarketRate: -0.0539,
                lastMarketRecordDate: "2026-03-25",
                lastMarketFetchedAt: 1774479600,
                lastMarketSource: "six-sar3mc",
              },
            },
          }),
          updatedAt: 1774479600,
        } as never;
      }
      return null as never;
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.chfSource).toBe("six-sar3mc");
    expect(metadata.chfRate).toBe(-0.0539);
    expect(metadata.fallbackMode).toBe("chf:six-saron-failed-retained");
  });

  it("retains the last USD EFFR benchmark when both EFFR feeds fail", async () => {
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      ...okExtendedBenchmarkMocks(),
      "markets.newyorkfed.org": null,
      "id=DFF": null,
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } }),
    });
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") {
        return {
          value: JSON.stringify({
            version: 1,
            benchmarks: {
              USD: {
                key: "USD",
                rate: 3.72,
                recordDate: "2026-03-02",
                fetchedAt: 1773100800,
                source: "fred-dgs3mo",
                isFallback: false,
                fallbackMode: null,
                lastMarketRate: 3.72,
                lastMarketRecordDate: "2026-03-02",
                lastMarketFetchedAt: 1773100800,
                lastMarketSource: "fred-dgs3mo",
              },
              USD_EFFR: {
                key: "USD_EFFR",
                rate: 4.31,
                recordDate: "2026-03-01",
                fetchedAt: 1773014400,
                source: "fred-dff",
                isFallback: false,
                fallbackMode: null,
                lastMarketRate: 4.31,
                lastMarketRecordDate: "2026-03-01",
                lastMarketFetchedAt: 1773014400,
                lastMarketSource: "fred-dff",
              },
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
            },
          }),
          updatedAt: 1774479600,
        } as never;
      }
      return null as never;
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
    mockByUrl({
      "data-api.ecb.europa.eu": null,
      "fred.stlouisfed.org": null,
      "home.treasury.gov": null,
      "oauth/token": null,
      "report-download": null,
      "banxico.org.mx": null,
      "api.bcb.gov.br": null,
      "bankofcanada.ca/valet": null,
      "DailyInfoWebServ": null,
    });

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
    mockByUrl({
      "data-api.ecb.europa.eu": null,
      "fred.stlouisfed.org": null,
      "home.treasury.gov": null,
      "oauth/token": null,
      "report-download": null,
      "banxico.org.mx": null,
      "api.bcb.gov.br": null,
      "bankofcanada.ca/valet": null,
      "DailyInfoWebServ": null,
    });
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") return null as never;
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 3.91,
            recordDate: "2026-03-07",
            fetchedAt: 1773100800,
            source: "fred-dgs3mo",
            isFallback: false,
            fallbackMode: null,
          }),
          updatedAt: 1773100800,
        } as never;
      }
      return null as never;
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
    mockByUrl({
      "data-api.ecb.europa.eu": null,
      "fred.stlouisfed.org": null,
      "home.treasury.gov": null,
      "oauth/token": null,
      "report-download": null,
      "banxico.org.mx": null,
      "api.bcb.gov.br": null,
      "bankofcanada.ca/valet": null,
      "DailyInfoWebServ": null,
    });
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") return null as never;
      if (key === "risk_free_rate") {
        return {
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
        } as never;
      }
      return null as never;
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

describe("parseEcbCompoundedEstrCsv", () => {
  it("extracts the latest ECB 3M compounded €STR observation", () => {
    expect(parseEcbCompoundedEstrCsv(ECB_ESTR_3M_CSV_SNIPPET)).toEqual({
      rate: 1.9358,
      recordDate: "2026-03-26",
    });
  });
});

describe("parseBoeSoniaCsv", () => {
  it("extracts the latest Bank of England SONIA observation", () => {
    expect(parseBoeSoniaCsv("DATE,IUDSOIA\n01 Jun 2026,3.7291\n03 Jun 2026,3.7306\n")).toEqual({
      rate: 3.7306,
      recordDate: "2026-06-03",
    });
  });

  it("skips malformed trailing rows", () => {
    expect(parseBoeSoniaCsv("DATE,IUDSOIA\n01 Jun 2026,3.7291\nnot-a-date,3.8\n")).toEqual({
      rate: 3.7291,
      recordDate: "2026-06-01",
    });
  });
});

describe("parseNyFedEffrJson", () => {
  it("extracts the latest NY Fed EFFR observation", () => {
    const payload = JSON.stringify({
      refRates: [
        { effectiveDate: "2026-03-01", type: "EFFR", percentRate: 4.31 },
        { effectiveDate: "2026-03-02", type: "EFFR", percentRate: 4.33 },
      ],
    });
    expect(parseNyFedEffrJson(payload)).toEqual({
      rate: 4.33,
      recordDate: "2026-03-02",
      source: "nyfed-effr",
    });
  });

  it("skips invalid trailing NY Fed rows", () => {
    const payload = JSON.stringify({
      refRates: [
        { effectiveDate: "2026-03-01", type: "EFFR", percentRate: 4.31 },
        { effectiveDate: "2026-03-02", type: "EFFR", percentRate: "." },
      ],
    });
    expect(parseNyFedEffrJson(payload)).toEqual({
      rate: 4.31,
      recordDate: "2026-03-01",
      source: "nyfed-effr",
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseNyFedEffrJson("not json")).toBeNull();
  });
});

describe("parseBoeSoniaCompoundedIndexCsv", () => {
  it("annualizes the trailing 90-day rate from the SONIA Compounded Index", () => {
    const result = parseBoeSoniaCompoundedIndexCsv(BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET);
    expect(result?.recordDate).toBe("2026-04-01");
    expect(result?.rate).toBeCloseTo(4.05556, 5);
  });

  it("accepts two-digit years from legacy IADB exports", () => {
    const result = parseBoeSoniaCompoundedIndexCsv("DATE,IUDZOS2\n01 Jan 26,100\n01 Apr 26,101\n");
    expect(result?.recordDate).toBe("2026-04-01");
    expect(result?.rate).toBeCloseTo(4.05556, 5);
  });
});

describe("parseBojCallRateJson", () => {
  it("extracts the latest Bank of Japan call-rate observation", () => {
    const payload = JSON.stringify({
      RESULTSET: [{
        SERIES_CODE: "STRDCLUCON",
        VALUES: {
          SURVEY_DATES: [20260601, 20260602, 20260603],
          VALUES: [0.726, 0.727, 0.728],
        },
      }],
    });
    expect(parseBojCallRateJson(payload)).toEqual({
      rate: 0.728,
      recordDate: "2026-06-03",
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseBojCallRateJson("not json")).toBeNull();
  });
});

describe("parseRbaF1MoneyMarketCsv", () => {
  it("extracts the latest RBA cash-rate target observation", () => {
    const payload = [
      "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate",
      "03-Jun-2026,4.35,,4.35",
      "04-Jun-2026,4.35,,4.35",
      "05-Jun-2026,,,,",
    ].join("\n");
    expect(parseRbaF1MoneyMarketCsv(payload)).toEqual({
      rate: 4.35,
      recordDate: "2026-06-04",
    });
  });

  it("falls back to the interbank overnight column when the target column is blank", () => {
    const payload = [
      "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate",
      "04-Jun-2026,,,4.36",
    ].join("\n");
    expect(parseRbaF1MoneyMarketCsv(payload)).toEqual({
      rate: 4.36,
      recordDate: "2026-06-04",
    });
  });
});

describe("parseTreasuryYieldXml", () => {
  it("extracts the latest BC_3MONTH rate and date", () => {
    const result = parseTreasuryYieldXml(TREASURY_XML_SNIPPET);
    expect(result).toEqual({ recordDate: "2026-03-13", rate: 3.72 });
  });

  it("returns null for empty or non-XML input", () => {
    expect(parseTreasuryYieldXml("")).toBeNull();
    expect(parseTreasuryYieldXml("not xml at all")).toBeNull();
  });

  it("returns null when BC_3MONTH is missing", () => {
    const xml = `<G_NEW_DATE><NEW_DATE>03-13-2026</NEW_DATE></G_NEW_DATE>`;
    expect(parseTreasuryYieldXml(xml)).toBeNull();
  });

  it("skips entries with invalid rates", () => {
    const xml = `<G_NEW_DATE><BC_3MONTH>NaN</BC_3MONTH><NEW_DATE>03-12-2026</NEW_DATE></G_NEW_DATE>
<G_NEW_DATE><BC_3MONTH>3.65</BC_3MONTH><NEW_DATE>03-13-2026</NEW_DATE></G_NEW_DATE>`;
    const result = parseTreasuryYieldXml(xml);
    expect(result).toEqual({ recordDate: "2026-03-13", rate: 3.65 });
  });
});

describe("parseSixSar3mcCsv", () => {
  it("extracts the latest delayed public SAR3MC print", () => {
    expect(parseSixSar3mcCsv(SIX_SAR3MC_CSV_SNIPPET)).toEqual({
      rate: -0.0539,
      recordDate: "2026-03-25",
    });
  });
});

describe("parseBanxicoSeries", () => {
  it("extracts the most recent CETES observation", () => {
    const payload = JSON.stringify({
      bmx: {
        series: [
          {
            datos: [
              { fecha: "25/03/2026", dato: "10.43" },
              { fecha: "26/03/2026", dato: "10.45" },
            ],
          },
        ],
      },
    });
    expect(parseBanxicoSeries(payload)).toEqual({ rate: 10.45, recordDate: "2026-03-26" });
  });

  it("skips invalid trailing rows and returns the latest valid observation", () => {
    const payload = JSON.stringify({
      bmx: {
        series: [
          {
            datos: [
              { fecha: "25/03/2026", dato: "10.43" },
              { fecha: "26/03/2026", dato: "N/E" },
            ],
          },
        ],
      },
    });
    expect(parseBanxicoSeries(payload)).toEqual({ rate: 10.43, recordDate: "2026-03-25" });
  });

  it("returns null on malformed JSON", () => {
    expect(parseBanxicoSeries("not json")).toBeNull();
  });
});

describe("parseEtherfuseCetesStablebondPage", () => {
  it("extracts the current CETES issuance rate from Etherfuse Next data", () => {
    expect(parseEtherfuseCetesStablebondPage(ETHERFUSE_CETES_HTML)).toEqual({
      apyPercent: 5.58,
      recordDate: "2026-05-14",
      observedAtSec: 1779200683,
      startSec: 1778798112,
      endSec: 1779402912,
      issuanceAddress: "2p3sFHSkC7f8WoxenAgcpGbKjDYHtAScMuJPft47o5cS",
      issuanceNumber: 110,
      startingTokenAmount: 1.162263,
      endingTokenAmount: 1.163506,
      currentTokenAmount: 1.163091,
    });
  });

  it("returns null when the Etherfuse page does not expose a CETES issuance rate", () => {
    expect(parseEtherfuseCetesStablebondPage("<html></html>")).toBeNull();
  });
});

describe("parseBcbSelicSeries", () => {
  it("annualizes the most recent daily SELIC observation", () => {
    const payload = JSON.stringify([{ data: "18/06/2026", valor: "0.050747" }]);
    expect(parseBcbSelicSeries(payload)).toEqual({
      rate: 13.638253562615565,
      recordDate: "2026-06-18",
    });
  });

  it("skips implausible annualized SELIC observations", () => {
    const payload = JSON.stringify([
      { data: "17/06/2026", valor: "0.050747" },
      { data: "18/06/2026", valor: "12.75" },
    ]);
    expect(parseBcbSelicSeries(payload)).toEqual({
      rate: 13.638253562615565,
      recordDate: "2026-06-17",
    });
  });

  it("skips impossible negative daily SELIC observations before annualization", () => {
    const payload = JSON.stringify([
      { data: "17/06/2026", valor: "0.050747" },
      { data: "18/06/2026", valor: "-200.05" },
    ]);
    expect(parseBcbSelicSeries(payload)).toEqual({
      rate: 13.638253562615565,
      recordDate: "2026-06-17",
    });
  });

  it("returns null when every SELIC observation has an impossible negative daily rate", () => {
    const payload = JSON.stringify([{ data: "18/06/2026", valor: "-200.05" }]);
    expect(parseBcbSelicSeries(payload)).toBeNull();
  });

  it("returns null when array is empty", () => {
    expect(parseBcbSelicSeries("[]")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseBcbSelicSeries("not json")).toBeNull();
  });
});

describe("parseBocValetSeries", () => {
  it("extracts the most recent V122530 observation", () => {
    const payload = JSON.stringify({
      observations: [
        { d: "2026-03-25", V122530: { v: "4.75" } },
        { d: "2026-03-26", V122530: { v: "4.74" } },
      ],
    });
    expect(parseBocValetSeries(payload, "V122530")).toEqual({ rate: 4.74, recordDate: "2026-03-26" });
  });

  it("skips invalid trailing rows and returns the latest valid observation", () => {
    const payload = JSON.stringify({
      observations: [
        { d: "2026-03-25", V122530: { v: "4.75" } },
        { d: "2026-03-26", V122530: { v: null } },
      ],
    });
    expect(parseBocValetSeries(payload, "V122530")).toEqual({ rate: 4.75, recordDate: "2026-03-25" });
  });

  it("returns null when the series code is missing", () => {
    const payload = JSON.stringify({ observations: [{ d: "2026-03-26" }] });
    expect(parseBocValetSeries(payload, "V122530")).toBeNull();
  });
});

describe("parseCbrKeyRateXml", () => {
  it("extracts the newest CBR key-rate observation from the SOAP response", () => {
    const payload = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<KeyRateXMLResponse xmlns="http://web.cbr.ru/"><KeyRateXMLResult><KeyRate xmlns="">
<KR><DT>2026-06-10T00:00:00+03:00</DT><Rate>14.50</Rate></KR>
<KR><DT>2026-06-11T00:00:00+03:00</DT><Rate>14.50</Rate></KR>
</KeyRate></KeyRateXMLResult></KeyRateXMLResponse>
</soap:Body></soap:Envelope>`;

    expect(parseCbrKeyRateXml(payload)).toEqual({
      rate: 14.5,
      recordDate: "2026-06-11",
    });
  });

  it("skips invalid rows and enforces the RUB-specific sanity band", () => {
    const payload = `<KeyRate><KR><DT>2026-06-11T00:00:00+03:00</DT><Rate>125.00</Rate></KR></KeyRate>`;
    expect(parseCbrKeyRateXml(payload)).toBeNull();
  });
});

describe("parseCbrtEvdsSeries", () => {
  it("extracts the latest BIST TLREF observation above the standard 20% cap", () => {
    expect(parseCbrtEvdsSeries(CBRT_TLREF_JSON_SNIPPET)).toEqual({
      rate: 40,
      recordDate: "2026-06-08",
    });
  });

  it("skips invalid trailing rows and returns the latest valid TLREF observation", () => {
    const payload = JSON.stringify({
      items: [
        { Tarih: "06-05-2026", TP_BISTTLREF_ORAN: "39.99" },
        { Tarih: "06-08-2026", TP_BISTTLREF_ORAN: "ND" },
      ],
    });
    expect(parseCbrtEvdsSeries(payload)).toEqual({
      rate: 39.99,
      recordDate: "2026-06-05",
    });
  });

  it("returns null when the TRY observation exceeds the TRY-specific sanity band", () => {
    const payload = JSON.stringify({
      items: [{ Tarih: "06-08-2026", TP_BISTTLREF_ORAN: "125.00" }],
    });
    expect(parseCbrtEvdsSeries(payload)).toBeNull();
  });

  it("selects the newest valid TLREF observation regardless of response order", () => {
    const payload = JSON.stringify({
      items: [
        { Tarih: "06-08-2026", TP_BISTTLREF_ORAN: "40.00" },
        { Tarih: "06-05-2026", TP_BISTTLREF_ORAN: "39.99" },
      ],
    });
    expect(parseCbrtEvdsSeries(payload)).toEqual({
      rate: 40,
      recordDate: "2026-06-08",
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
    mockByUrl(
      {
        "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
        "markets.newyorkfed.org": new Response(NYFED_EFFR_JSON_SNIPPET, { status: 200 }),
        "id=DFF": new Response(FRED_DFF_CSV_SNIPPET, { status: 200 }),
        "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
        "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
        "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        }),
        "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": new Response(FRED_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 }),
        "bankofengland.co.uk": new Response(BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 }),
        "stat-search.boj.or.jp": new Response(JSON.stringify({
          RESULTSET: [{
            SERIES_CODE: "STRDCLUCON",
            VALUES: { SURVEY_DATES: [20260302], VALUES: [0.1] },
          }],
        }), { status: 200 }),
        "rba.gov.au/statistics/tables/csv/f1-data.csv": new Response(
          "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate\n"
          + "02-Mar-2026,4.30,,4.31\n",
          { status: 200 },
        ),
        "banxico.org.mx": (_url, opts) => {
          const header = (opts?.headers as Record<string, string> | undefined)?.["Bmx-Token"];
          expect(header).toBe("test-token");
          return new Response(
            JSON.stringify({
              bmx: { series: [{ datos: [{ fecha: "26/03/2026", dato: "10.45" }] }] },
            }),
            { status: 200 },
          );
        },
        "api.bcb.gov.br": new Response(JSON.stringify([{ data: "26/03/2026", valor: "0.050747" }]), { status: 200 }),
        "bankofcanada.ca/valet": new Response(
          JSON.stringify({
            observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
          }),
          { status: 200 },
        ),
        "cbr.ru/DailyInfoWebServ/DailyInfo.asmx": (_url, opts) => {
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
      },
      calls,
    );

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
    mockByUrl(
      {
        "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
        "markets.newyorkfed.org": new Response(NYFED_EFFR_JSON_SNIPPET, { status: 200 }),
        "id=DFF": new Response(FRED_DFF_CSV_SNIPPET, { status: 200 }),
        "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
        "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
        "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        }),
        "bankofengland.co.uk": new Response(BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 }),
        "stat-search.boj.or.jp": new Response(JSON.stringify({
          RESULTSET: [{
            SERIES_CODE: "STRDCLUCON",
            VALUES: { SURVEY_DATES: [20260302], VALUES: [0.1] },
          }],
        }), { status: 200 }),
        "rba.gov.au/statistics/tables/csv/f1-data.csv": new Response(
          "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate\n"
          + "02-Mar-2026,4.30,,4.31\n",
          { status: 200 },
        ),
        "api.bcb.gov.br": new Response(JSON.stringify([{ data: "26/03/2026", valor: "0.050747" }]), { status: 200 }),
        "bankofcanada.ca/valet": new Response(
          JSON.stringify({
            observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
          }),
          { status: 200 },
        ),
        "cbr.ru/DailyInfoWebServ/DailyInfo.asmx": new Response(
          "<KeyRate><KR><DT>2026-06-11T00:00:00+03:00</DT><Rate>14.50</Rate></KR></KeyRate>",
          { status: 200 },
        ),
        "evds3.tcmb.gov.tr/igmevdsms-dis/fe": new Response(CBRT_TLREF_JSON_SNIPPET, { status: 200 }),
      },
      calls,
    );

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
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rates") {
        return {
          value: JSON.stringify({
            version: 1,
            benchmarks: {
              USD: {
                key: "USD",
                rate: 3.72,
                recordDate: "2026-03-02",
                fetchedAt: 1773100800,
                source: "fred-dgs3mo",
                isFallback: false,
                fallbackMode: null,
                lastMarketRate: 3.72,
                lastMarketRecordDate: "2026-03-02",
                lastMarketFetchedAt: 1773100800,
                lastMarketSource: "fred-dgs3mo",
              },
              EUR: null,
              CHF: null,
              GBP: null,
              JPY: null,
              MXN: {
                key: "MXN",
                rate: 10.45,
                recordDate: "2026-03-26",
                fetchedAt: 1774479600,
                source: "banxico-cetes-28d",
                isFallback: false,
                fallbackMode: null,
                lastMarketRate: 10.45,
                lastMarketRecordDate: "2026-03-26",
                lastMarketFetchedAt: 1774479600,
                lastMarketSource: "banxico-cetes-28d",
              },
              BRL: null,
              AUD: null,
              CAD: null,
              RUB: null,
              TRY: null,
              SGD: null,
            },
          }),
          updatedAt: 1774479600,
        } as never;
      }
      return null as never;
    });
    mockByUrl({
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
      "markets.newyorkfed.org": new Response(NYFED_EFFR_JSON_SNIPPET, { status: 200 }),
      "id=DFF": new Response(FRED_DFF_CSV_SNIPPET, { status: 200 }),
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "oauth/token": new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 }),
      "report-download": new Response(SIX_SAR3MC_CSV_SNIPPET, {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      }),
      "bankofengland.co.uk": new Response(BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET, { status: 200 }),
      "stat-search.boj.or.jp": new Response(JSON.stringify({
        RESULTSET: [{
          SERIES_CODE: "STRDCLUCON",
          VALUES: { SURVEY_DATES: [20260302], VALUES: [0.1] },
        }],
      }), { status: 200 }),
      "rba.gov.au/statistics/tables/csv/f1-data.csv": new Response(
        "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate\n"
        + "02-Mar-2026,4.30,,4.31\n",
        { status: 200 },
      ),
      "banxico.org.mx": null,
      "api.bcb.gov.br": new Response(JSON.stringify([{ data: "26/03/2026", valor: "0.050747" }]), { status: 200 }),
      "bankofcanada.ca/valet": new Response(
        JSON.stringify({
          observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
        }),
        { status: 200 },
      ),
      "evds3.tcmb.gov.tr/igmevdsms-dis/fe": new Response(CBRT_TLREF_JSON_SNIPPET, { status: 200 }),
    });

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
