import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIRCUIT_SOURCE,
  RISK_FREE_RATE_FALLBACK,
} from "../../lib/constants";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
  setCache: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcome: vi.fn(),
}));

import {
  fetchTbillRate,
  parseBanxicoSeries,
  parseBcbSelicSeries,
  parseBocValetSeries,
  parseEcbCompoundedEstrCsv,
  parseSixSar3mcCsv,
  parseTreasuryYieldXml,
} from "../fetch-tbill-rate";
import {
  buildHardcodedUsdBenchmark,
  getBenchmarkKeyForPegCurrency,
  resolveBenchmarkForStablecoin,
  withYieldBenchmarkStaticMeta,
} from "../yield-sync/benchmarks";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { getCache, setCache } from "../../lib/db-cache";
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

function cloneResponse(response: Response | null): Response | null {
  if (!response) return null;
  return response.clone();
}

function mockByUrl(mapping: Record<string, Response | null>) {
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
    for (const [pattern, response] of Object.entries(mapping)) {
      if (url.includes(pattern)) return cloneResponse(response);
    }
    return null;
  });
}

/** Mocks every non-USD/EUR/CHF benchmark endpoint with a successful response. Used to
 *  isolate USD/EUR/CHF-specific test cases from added benchmark coverage. */
function okExtendedBenchmarkMocks(): Record<string, Response> {
  return {
    "id=IUDSOIA": new Response("DATE,IUDSOIA\n2026-03-02,5.20\n", { status: 200 }),
    "id=IRSTCB01JPM156N": new Response("DATE,IRSTCB01JPM156N\n2026-03-02,0.10\n", { status: 200 }),
    "id=IR3TIB01AUM156N": new Response("DATE,IR3TIB01AUM156N\n2026-03-02,4.30\n", { status: 200 }),
    "banxico.org.mx": new Response(JSON.stringify({
      bmx: { series: [{ datos: [{ fecha: "26/03/2026", dato: "10.45" }] }] },
    }), { status: 200 }),
    "api.bcb.gov.br": new Response(JSON.stringify([{ data: "26/03/2026", valor: "12.75" }]), { status: 200 }),
    "bankofcanada.ca/valet": new Response(JSON.stringify({
      observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
    }), { status: 200 }),
  };
}

/** Banxico requires a token; pass via env. */
const BANXICO_TEST_ENV = { BANXICO_TOKEN: "test-token" } as const;

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

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(undefined);
  });

  it("returns degraded when circuit is already open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("circuit-open");
    expect(latestCachePayload()).toMatchObject({
      rate: RISK_FREE_RATE_FALLBACK,
      source: "hardcoded-fallback",
      fallbackMode: "circuit-open",
      isFallback: true,
    });
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("returns ok from benchmark feeds", async () => {
    mockByUrl({
      "data-api.ecb.europa.eu": new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 }),
      "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
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
    expect(metadata.eurSource).toBe("ecb-estr-3m");
    expect(metadata.eurRate).toBe(1.9358);
    expect(metadata.chfSource).toBe("six-sar3mc");
    expect(metadata.chfRate).toBe(-0.0539);
    expect(metadata.gbpSource).toBe("fred-iudsoia");
    expect(metadata.gbpRate).toBe(5.20);
    expect(metadata.jpySource).toBe("fred-jpy-overnight");
    expect(metadata.jpyRate).toBe(0.10);
    expect(metadata.audSource).toBe("fred-aud-3m");
    expect(metadata.audRate).toBe(4.30);
    expect(metadata.mxnSource).toBe("banxico-cetes-28d");
    expect(metadata.mxnRate).toBe(10.45);
    expect(metadata.brlSource).toBe("bcb-selic");
    expect(metadata.brlRate).toBe(12.75);
    expect(metadata.cadSource).toBe("boc-valet-v122530");
    expect(metadata.cadRate).toBe(4.75);
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, true);
    expect(latestCachePayload()).toMatchObject({
      rate: 3.72,
      source: "fred-dgs3mo",
      fallbackMode: null,
      isFallback: false,
      recordDate: "2026-03-02",
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
    });

    const result = await fetchTbillRate(db, undefined, BANXICO_TEST_ENV);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe(
      "usd:all-sources-failed,eur:ecb-failed,chf:six-saron-failed,gbp:fred-sonia-failed,jpy:fred-jpy-failed,mxn:banxico-cetes-failed,brl:bcb-selic-failed,aud:fred-aud-failed,cad:boc-corra-failed",
    );
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    expect(latestCachePayload()).toMatchObject({
      rate: RISK_FREE_RATE_FALLBACK,
      source: "hardcoded-fallback",
      fallbackMode: "all-sources-failed",
      isFallback: true,
    });
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
      "usd:all-sources-failed-retained,eur:ecb-failed,chf:six-saron-failed,gbp:fred-sonia-failed,jpy:fred-jpy-failed,mxn:banxico-cetes-failed,brl:bcb-selic-failed,aud:fred-aud-failed,cad:boc-corra-failed",
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
      "usd:all-sources-failed-retained,eur:ecb-failed,chf:six-saron-failed,gbp:fred-sonia-failed,jpy:fred-jpy-failed,mxn:banxico-cetes-failed,brl:bcb-selic-failed,aud:fred-aud-failed,cad:boc-corra-failed",
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
        series: [{
          datos: [
            { fecha: "25/03/2026", dato: "10.43" },
            { fecha: "26/03/2026", dato: "10.45" },
          ],
        }],
      },
    });
    expect(parseBanxicoSeries(payload)).toEqual({ rate: 10.45, recordDate: "2026-03-26" });
  });

  it("skips invalid trailing rows and returns the latest valid observation", () => {
    const payload = JSON.stringify({
      bmx: {
        series: [{
          datos: [
            { fecha: "25/03/2026", dato: "10.43" },
            { fecha: "26/03/2026", dato: "N/E" },
          ],
        }],
      },
    });
    expect(parseBanxicoSeries(payload)).toEqual({ rate: 10.43, recordDate: "2026-03-25" });
  });

  it("returns null on malformed JSON", () => {
    expect(parseBanxicoSeries("not json")).toBeNull();
  });
});

describe("parseBcbSelicSeries", () => {
  it("extracts the most recent SELIC observation", () => {
    const payload = JSON.stringify([{ data: "26/03/2026", valor: "12.75" }]);
    expect(parseBcbSelicSeries(payload)).toEqual({ rate: 12.75, recordDate: "2026-03-26" });
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

describe("fetchTbillRate — new currency fetchers", () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(getCache).mockReset().mockResolvedValue(null);
    vi.mocked(setCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(undefined);
  });

  it("hits each new endpoint URL and parses its native shape", async () => {
    const calls: string[] = [];
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string, opts?: RequestInit) => {
      calls.push(url);
      if (url.includes("id=DGS3MO")) {
        return new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 });
      }
      if (url.includes("data-api.ecb.europa.eu")) {
        return new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 });
      }
      if (url.includes("oauth/token")) {
        return new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("report-download")) {
        return new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } });
      }
      if (url.includes("id=IUDSOIA")) {
        return new Response("DATE,IUDSOIA\n2026-03-02,5.20\n", { status: 200 });
      }
      if (url.includes("id=IRSTCB01JPM156N")) {
        return new Response("DATE,IRSTCB01JPM156N\n2026-03-02,0.10\n", { status: 200 });
      }
      if (url.includes("id=IR3TIB01AUM156N")) {
        return new Response("DATE,IR3TIB01AUM156N\n2026-03-02,4.30\n", { status: 200 });
      }
      if (url.includes("banxico.org.mx")) {
        const header = (opts?.headers as Record<string, string> | undefined)?.["Bmx-Token"];
        expect(header).toBe("test-token");
        return new Response(JSON.stringify({
          bmx: { series: [{ datos: [{ fecha: "26/03/2026", dato: "10.45" }] }] },
        }), { status: 200 });
      }
      if (url.includes("api.bcb.gov.br")) {
        return new Response(JSON.stringify([{ data: "26/03/2026", valor: "12.75" }]), { status: 200 });
      }
      if (url.includes("bankofcanada.ca/valet")) {
        return new Response(JSON.stringify({
          observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
        }), { status: 200 });
      }
      return null;
    });

    const result = await fetchTbillRate(db, undefined, { BANXICO_TOKEN: "test-token" });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.gbpRate).toBe(5.20);
    expect(metadata.jpyRate).toBe(0.10);
    expect(metadata.audRate).toBe(4.30);
    expect(metadata.mxnRate).toBe(10.45);
    expect(metadata.brlRate).toBe(12.75);
    expect(metadata.cadRate).toBe(4.75);
    expect(calls.some((u) => u.includes("IUDSOIA"))).toBe(true);
    expect(calls.some((u) => u.includes("IRSTCB01JPM156N"))).toBe(true);
    expect(calls.some((u) => u.includes("IR3TIB01AUM156N"))).toBe(true);
    expect(calls.some((u) => u.includes("banxico.org.mx"))).toBe(true);
    expect(calls.some((u) => u.includes("api.bcb.gov.br"))).toBe(true);
    expect(calls.some((u) => u.includes("bankofcanada.ca/valet"))).toBe(true);
  });

  it("skips Banxico when BANXICO_TOKEN is missing", async () => {
    const calls: string[] = [];
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes("id=DGS3MO")) {
        return new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 });
      }
      if (url.includes("data-api.ecb.europa.eu")) {
        return new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 });
      }
      if (url.includes("oauth/token")) {
        return new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("report-download")) {
        return new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } });
      }
      if (url.includes("id=IUDSOIA")) {
        return new Response("DATE,IUDSOIA\n2026-03-02,5.20\n", { status: 200 });
      }
      if (url.includes("id=IRSTCB01JPM156N")) {
        return new Response("DATE,IRSTCB01JPM156N\n2026-03-02,0.10\n", { status: 200 });
      }
      if (url.includes("id=IR3TIB01AUM156N")) {
        return new Response("DATE,IR3TIB01AUM156N\n2026-03-02,4.30\n", { status: 200 });
      }
      if (url.includes("api.bcb.gov.br")) {
        return new Response(JSON.stringify([{ data: "26/03/2026", valor: "12.75" }]), { status: 200 });
      }
      if (url.includes("bankofcanada.ca/valet")) {
        return new Response(JSON.stringify({
          observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
        }), { status: 200 });
      }
      return null;
    });

    const result = await fetchTbillRate(db, undefined, { BANXICO_TOKEN: undefined });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(calls.some((u) => u.includes("banxico.org.mx"))).toBe(false);
    expect(metadata.mxnSource).toBeNull();
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
              SGD: null,
            },
          }),
          updatedAt: 1774479600,
        } as never;
      }
      return null as never;
    });
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("id=DGS3MO")) {
        return new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 });
      }
      if (url.includes("data-api.ecb.europa.eu")) {
        return new Response(ECB_ESTR_3M_CSV_SNIPPET, { status: 200 });
      }
      if (url.includes("oauth/token")) {
        return new Response(SIX_GUEST_TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("report-download")) {
        return new Response(SIX_SAR3MC_CSV_SNIPPET, { status: 200, headers: { "Content-Type": "text/csv" } });
      }
      if (url.includes("id=IUDSOIA")) {
        return new Response("DATE,IUDSOIA\n2026-03-02,5.20\n", { status: 200 });
      }
      if (url.includes("id=IRSTCB01JPM156N")) {
        return new Response("DATE,IRSTCB01JPM156N\n2026-03-02,0.10\n", { status: 200 });
      }
      if (url.includes("id=IR3TIB01AUM156N")) {
        return new Response("DATE,IR3TIB01AUM156N\n2026-03-02,4.30\n", { status: 200 });
      }
      if (url.includes("banxico.org.mx")) {
        return null;
      }
      if (url.includes("api.bcb.gov.br")) {
        return new Response(JSON.stringify([{ data: "26/03/2026", valor: "12.75" }]), { status: 200 });
      }
      if (url.includes("bankofcanada.ca/valet")) {
        return new Response(JSON.stringify({
          observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }],
        }), { status: 200 });
      }
      return null;
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
  });

  it("returns null for currencies without a fetcher so callers fall back to USD", () => {
    expect(getBenchmarkKeyForPegCurrency("SGD")).toBeNull();
    expect(getBenchmarkKeyForPegCurrency("TRY")).toBeNull();
    expect(getBenchmarkKeyForPegCurrency("AED")).toBeNull();
    expect(getBenchmarkKeyForPegCurrency(null)).toBeNull();
    expect(getBenchmarkKeyForPegCurrency(undefined)).toBeNull();
  });
});

describe("resolveBenchmarkForStablecoin", () => {
  function buildMeta(key: "USD" | "EUR" | "CHF" | "GBP" | "JPY" | "MXN" | "BRL" | "AUD" | "CAD" | "SGD") {
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

  function buildRegistry(overrides: Partial<Record<"EUR" | "CHF" | "GBP" | "JPY" | "MXN" | "BRL" | "AUD" | "CAD", boolean>> = {}) {
    return {
      USD: buildHardcodedUsdBenchmark("test"),
      EUR: overrides.EUR ? buildMeta("EUR") : null,
      CHF: overrides.CHF ? buildMeta("CHF") : null,
      GBP: overrides.GBP ? buildMeta("GBP") : null,
      JPY: overrides.JPY ? buildMeta("JPY") : null,
      MXN: overrides.MXN ? buildMeta("MXN") : null,
      BRL: overrides.BRL ? buildMeta("BRL") : null,
      AUD: overrides.AUD ? buildMeta("AUD") : null,
      CAD: overrides.CAD ? buildMeta("CAD") : null,
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
});
