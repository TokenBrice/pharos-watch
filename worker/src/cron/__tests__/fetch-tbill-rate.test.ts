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
  parseEcbCompoundedEstrCsv,
  parseSixSar3mcCsv,
  parseTreasuryYieldXml,
} from "../fetch-tbill-rate";
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
    });

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.usdSource).toBe("fred-dgs3mo");
    expect(metadata.usdRate).toBe(3.72);
    expect(metadata.eurSource).toBe("ecb-estr-3m");
    expect(metadata.eurRate).toBe(1.9358);
    expect(metadata.chfSource).toBe("six-sar3mc");
    expect(metadata.chfRate).toBe(-0.0539);
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
    });

    const result = await fetchTbillRate(db);
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
    });

    const result = await fetchTbillRate(db);
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

    const result = await fetchTbillRate(db);
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

    const result = await fetchTbillRate(db);
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
    });

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("usd:all-sources-failed,eur:ecb-failed,chf:six-saron-failed");
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

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("usd:all-sources-failed-retained,eur:ecb-failed,chf:six-saron-failed");
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

    const result = await fetchTbillRate(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toBe("usd:all-sources-failed-retained,eur:ecb-failed,chf:six-saron-failed");
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
