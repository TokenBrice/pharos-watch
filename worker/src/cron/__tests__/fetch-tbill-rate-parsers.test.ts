import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcbFixtures from "./fixtures/bcb-selic.json";

import { mockFetchRetry } from "../../test-helpers/cron";
import {
  BOE_SONIA_COMPOUNDED_INDEX_CSV_SNIPPET,
  CBRT_TLREF_JSON_SNIPPET,
  TREASURY_XML_SNIPPET,
} from "./rates-cron.test-support";

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

import { parseBanxicoSeries } from "../tbill-sources/banxico";
import { parseBcbSelicSeries, parseBcbSelicAnnualizedSeries } from "../tbill-sources/bcb";
import { parseBoeSoniaCompoundedIndexCsv } from "../tbill-sources/boe";
import { parseBojCallRateJson } from "../tbill-sources/boj";
import { parseBocValetSeries } from "../tbill-sources/boc";
import { parseCbrKeyRateXml } from "../tbill-sources/cbr";
import { parseCbrtEvdsSeries } from "../tbill-sources/cbrt";
import { parseEcbCompoundedEstrCsv } from "../tbill-sources/ecb";
import { parseFredLatest } from "../tbill-sources/fred";
import { parseNyFedEffrJson } from "../tbill-sources/nyfed";
import { parseRbaF1MoneyMarketCsv } from "../tbill-sources/rba";
import { parseSixSar3mcCsv } from "../tbill-sources/six";
import { parseTreasuryYieldXml } from "../tbill-sources/treasury";

const ECB_ESTR_3M_CSV_SNIPPET = `KEY,FREQ,BENCHMARK_ITEM,DATA_TYPE_EST,TIME_PERIOD,OBS_VALUE,OBS_STATUS,CONF_STATUS,PRE_BREAK_VALUE,COMMENT_OBS,CALCUL_START_DATE,CALCUL_END_DATE,TIME_FORMAT,BREAKS,COMMENT_TS,COMPILING_ORG,COVERAGE,DATA_COMP,DECIMALS,DISS_ORG,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,TIME_PER_COLLECT,TITLE,TITLE_COMPL,UNIT_INDEX_BASE,UNIT_MEASURE,UNIT_MULT
EST.B.EU000A2QQF32.CR,B,EU000A2QQF32,CR,2026-03-25,1.93576,A,F,,,,,P1D,,,,"ESA 2010 Sectors: S.121, S.122, S.123, S.124, S.125, S.126, S.127, S.128, S.129",,5,,,,,V,"Compounded euro short-term average rate, 3 months tenor","Compounded euro short-term average rate, 3 months tenor",,PC,0
EST.B.EU000A2QQF32.CR,B,EU000A2QQF32,CR,2026-03-26,1.9358,A,F,,,,,P1D,,,,"ESA 2010 Sectors: S.121, S.122, S.123, S.124, S.125, S.126, S.127, S.128, S.129",,5,,,,,V,"Compounded euro short-term average rate, 3 months tenor","Compounded euro short-term average rate, 3 months tenor",,PC,0
`;

const SIX_SAR3MC_CSV_SNIPPET = `date;end_date;start_date;symbol;value;day_count;dcc
25.03.2026;26.03.2026;24.12.2025;SAR3MC;-0.0539;92;360
24.03.2026;25.03.2026;24.12.2025;SAR3MC;-0.0539;91;360
23.03.2026;24.03.2026;24.12.2025;SAR3MC;-0.0540;90;360
`;


describe("parseEcbCompoundedEstrCsv", () => {
  it("extracts the latest ECB 3M compounded €STR observation", () => {
    expect(parseEcbCompoundedEstrCsv(ECB_ESTR_3M_CSV_SNIPPET)).toEqual({
      rate: 1.9358,
      recordDate: "2026-03-26",
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

describe("parseFredLatest", () => {
  // The St. Louis Fed loaders gate the latest observation against the real
  // clock, so freeze it: these fixtures are static dates.
  const FROZEN_NOW = new Date("2026-06-25T12:00:00Z");
  const DGS3MO_MAX_OBSERVATION_AGE_DAYS = 5;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts the latest valid DGS3MO observation inside the observation window", () => {
    expect(parseFredLatest("DATE,DGS3MO\n2026-06-23,3.72\n2026-06-24,3.71\n", DGS3MO_MAX_OBSERVATION_AGE_DAYS))
      .toEqual({ recordDate: "2026-06-24", rate: 3.71 });
  });

  it("skips missing-value rows but still guards the latest usable observation", () => {
    expect(parseFredLatest("DATE,DFF\n2026-03-02,4.33\n2026-06-25,.\n", DGS3MO_MAX_OBSERVATION_AGE_DAYS)).toBeNull();
    expect(parseFredLatest("DATE,DFF\n2026-06-24,4.33\n2026-06-25,.\n", DGS3MO_MAX_OBSERVATION_AGE_DAYS))
      .toEqual({ recordDate: "2026-06-24", rate: 4.33 });
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

  it("selects the latest start on or before the cutoff from unsorted candidates", () => {
    const result = parseBoeSoniaCompoundedIndexCsv(
      "DATE,IUDZOS2\n01 Apr 2026,101\n30 Dec 2025,99\n02 Jan 2026,100.5\n01 Jan 2026,100\n",
    );
    expect(result?.recordDate).toBe("2026-04-01");
    expect(result?.rate).toBeCloseTo(4.0555555556, 8);
  });

  it("annualizes a missing-date gap using 92 elapsed days", () => {
    const result = parseBoeSoniaCompoundedIndexCsv("DATE,IUDZOS2\n30 Dec 2025,100\n01 Apr 2026,101\n");
    expect(result?.recordDate).toBe("2026-04-01");
    expect(result?.rate).toBeCloseTo(3.9673913043, 8);
  });

  it("returns null without an observation at least 90 days old", () => {
    expect(parseBoeSoniaCompoundedIndexCsv("DATE,IUDZOS2\n02 Jan 2026,100\n01 Apr 2026,101\n")).toBeNull();
  });

  it("ignores invalid and nonpositive trailing index rows", () => {
    const result = parseBoeSoniaCompoundedIndexCsv(
      "DATE,IUDZOS2\n01 Jan 2026,100\n01 Apr 2026,101\n02 Apr 2026,ND\n03 Apr 2026,0\n04 Apr 2026,-1\n",
    );
    expect(result?.recordDate).toBe("2026-04-01");
    expect(result?.rate).toBeCloseTo(4.0555555556, 8);
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


describe("parseBcbSelicSeries", () => {
  it("annualizes the most recent daily SELIC observation", () => {
    const payload = JSON.stringify([{ data: "18/06/2026", valor: "0.050747" }]);
    expect(parseBcbSelicSeries(payload)).toEqual({
      rate: 13.638253562615565,
      recordDate: "2026-06-18",
    });
  });
  it("returns null for a single-row zero daily SELIC placeholder", () => {
    const payload = JSON.stringify([{ data: "18/06/2026", valor: "0.00" }]);
    expect(parseBcbSelicSeries(payload)).toBeNull();
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

  it.each([
    JSON.stringify({ erro: { statusCode: 500, detail: "Internal error" } }),
    "<html><title>Bad request!</title><body>Your request was rejected.</body></html>",
  ])("rejects an HTTP-200 provider error body instead of inventing a rate: %s", (payload) => {
    expect(parseBcbSelicSeries(payload)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseBcbSelicSeries("not json")).toBeNull();
  });
});

describe("SGS1178 effective annualized Selic", () => {
  it("keeps annual percent units and does not compound a second time", () => {
    expect(parseBcbSelicAnnualizedSeries(JSON.stringify(bcbFixtures.annualized))).toEqual({
      recordDate: "2026-06-24", rate: 13.65,
    });
    expect(parseBcbSelicSeries(JSON.stringify(bcbFixtures.daily))?.rate).toBeCloseTo(13.638253562615565, 12);
    expect(parseBcbSelicAnnualizedSeries('[{"data":"24/06/2026","valor":"13,65"}]')?.rate).toBe(13.65);
  });

  it.each(["0", "-1", "20.01", "13.65garbage", "13.65%", "1e1", "1,234.56", ""])(
    "rejects placeholders, out-of-bounds rates and ambiguous units: %s", value => {
      expect(parseBcbSelicAnnualizedSeries(JSON.stringify([{ data: "24/06/2026", valor: value }]))).toBeNull();
    },
  );

  it.each(["31/02/2026", "29/02/2026", "32/06/2026", "24/13/2026", "2026-06-24", "", null])(
    "rejects malformed or missing publisher dates: %s", data => {
      for (const parse of [parseBcbSelicSeries, parseBcbSelicAnnualizedSeries]) {
        expect(parse(JSON.stringify([{ data, valor: "0.050747" }]))).toBeNull();
      }
    },
  );

  it.each([JSON.stringify(bcbFixtures.errorEnvelope), bcbFixtures.html, "not json", "[]"])(
    "fails closed for recorded error shapes and malformed bodies", body => {
      expect(parseBcbSelicAnnualizedSeries(body)).toBeNull();
    },
  );
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
