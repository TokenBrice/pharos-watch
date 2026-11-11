import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import wars from "@shared/data/stablecoins/coins/wars-argentine-peso.json";
import wbrl from "@shared/data/stablecoins/coins/wbrl-ripio.json";
import wcop from "@shared/data/stablecoins/coins/wcop-ripio.json";
import wmxn from "@shared/data/stablecoins/coins/wmxn-ripio.json";
import zarp from "@shared/data/stablecoins/coins/zarp-zarp.json";
import usdu from "@shared/data/stablecoins/coins/usdu-universal.json";
import zarsc from "@shared/data/stablecoins/coins/zarsc-supercoin.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adaptAttestationPdfIndex,
  fetchAttestationPdfIndexReserves,
  type AttestationPdfIndexParams,
} from "../attestation-pdf-index";
import { expectValidAdapterOutput, installAdapterNetwork } from "./reserve-adapter.test-support";
import ripioJune from "./fixtures/ripio-wfiat-june-2026.json";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ZARSC_SUPERCOIN_HTML = readFileSync(join(FIXTURES_DIR, "zarsc-supercoin.html"), "utf8");

const CONFIGURED_PARAMS: AttestationPdfIndexParams = {
  slices: [
    { name: "U.S. Treasury Bills", pct: 80, risk: "very-low" },
    { name: "Cash deposits", pct: 20, risk: "low" },
  ],
};

function buildConfig(url = "https://issuer.example/transparency/"): LiveReservesConfig {
  return {
    adapter: "attestation-pdf-index",
    version: 1,
    semantics: "attestation-mix",
    inputs: {
      primary: { kind: "http-html", url },
    },
    params: { slices: CONFIGURED_PARAMS.slices },
  };
}

describe("adaptAttestationPdfIndex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([0, 0.5, 2])("retains raw percentage drift %s without repairing configured slices", (drift) => {
    const result = adaptAttestationPdfIndex('<a href="/reports/2026-08-31-attestation.pdf">August report</a>', {
      slices: [{ name: "Cash", pct: 80 + drift, risk: "low" }, { name: "Fund", pct: 20, risk: "low" }],
    });
    expect(result.metadata?.diag?.rawSumDeviation).toBe(drift);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100 + drift, 10);
  });

  it("rejects raw configured-slice drift above the existing two-point boundary", () => {
    expect(() => adaptAttestationPdfIndex("", {
      slices: [{ name: "Cash", pct: 102.01, risk: "low" }],
    })).toThrow();
  });

  it.each(["2026-09-12-report.pdf", "USDU Examination Report - SEP 26 SIGNED.pdf"])("withholds freshness for unreviewed %s", (filename) => {
    const url = "https://issuer.example/reports/reviewed-report.pdf";
    const params = parseLiveReserveAdapterParams("attestation-pdf-index", {
      ...CONFIGURED_PARAMS,
      linkMatch: "report", reviewedReport: { url, balanceDate: "2026-08-01" },
    });
    const result = adaptAttestationPdfIndex(`<a href="${url}">August report</a>`, params);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 7, 1) / 1000,
      reportBalanceDate: "2026-08-01",
      freshnessMode: "verified",
    });
    const newer = adaptAttestationPdfIndex(
      `<a href="https://issuer.example/reports/${filename}">Report</a><a href="${url}">Report</a>`,
      params,
    );
    expect(newer.metadata?.sourceTimestamp).toBeUndefined();
    expect(newer.metadata?.freshnessMode).toBe("unverified");
    expect(newer.warnings).toContainEqual(expect.objectContaining({ code: "attestation-report-basis-unreviewed", effect: "degraded" }));
    expect(() => parseLiveReserveAdapterParams("attestation-pdf-index", {
      ...params, reviewedReport: { url, balanceDate: "2026-02-30" },
    })).toThrow();
  });

  it("parses Solomon's GitHub attestation index", () => {
    const result = adaptAttestationPdfIndex(`
      <a href="/SolomonLabs/attestations/blob/main/ceffu/2026/2026-03-01.pdf">2026-03-01.pdf</a>
      <a href="/SolomonLabs/attestations/blob/main/ceffu/2026/2026-04-01.pdf">2026-04-01.pdf</a>
    `, CONFIGURED_PARAMS, {
      indexUrl: "https://github.com/SolomonLabs/attestations/tree/main/ceffu/2026",
    });

    expect(result.metadata).toMatchObject({
      reportDate: "2026-04-01",
      reportPdfUrl: "https://github.com/SolomonLabs/attestations/blob/main/ceffu/2026/2026-04-01.pdf",
    });
  });

  it("selects the newest dated PDF link and emits configured reserve slices", () => {
    const html = `
      <a href="/reports/2026-01-31-attestation.pdf">January 2026 attestation</a>
      <a href="/reports/2026-02-28-attestation.pdf">February 2026 attestation</a>
      <a href="/reports/2025-12-31-attestation.pdf">December 2025 attestation</a>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS, {
      indexUrl: "https://issuer.example/transparency/",
    });

    expect(result.slices).toEqual(CONFIGURED_PARAMS.slices);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
      freshnessMode: "verified",
      reportDate: "2026-02-28",
      reportDateLabel: "February 28, 2026",
      reportDatePrecision: "day",
      reportDateSource: "href",
      reportPdfHref: "/reports/2026-02-28-attestation.pdf",
      reportPdfPath: "/reports/2026-02-28-attestation.pdf",
      reportPdfUrl: "https://issuer.example/reports/2026-02-28-attestation.pdf",
      reportLinkText: "February 2026 attestation",
      compositionMode: "configured-static-slices",
      compositionSource: "configured-static-slices",
    });
    expect(result.metadata).not.toHaveProperty("redemption");
  });

  it("preserves the complete curated reserve-slice shape", () => {
    const slices: AttestationPdfIndexParams["slices"] = [
      {
        sourceKey: "custody:solomon",
        name: "Ceffu-custodied treasury bills",
        pct: 60,
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
        blacklistable: true,
        blacklistabilityExposure: "yes",
        assetClass: "treasury-bill",
        issuerOrObligor: "Ceffu",
        riskFactors: ["credit", "custody"],
        liquidityHorizon: "one-day",
        maturityDaysMax: 90,
      },
      {
        name: "Cash",
        pct: 40,
        risk: "very-low",
      },
    ];

    const result = adaptAttestationPdfIndex(
      '<a href="/reports/2026-02-28-attestation.pdf">February report</a>',
      { slices },
    );

    expect(result.slices).toEqual(slices);
  });

  it.each([
    [
      "uses end-of-month freshness for month-only report dates",
      `
      <a href="/attestations/2026_january.pdf">View January report</a>
      <a href="/attestations/2026_february.pdf">View February report</a>
      <a href="/attestations/2025_december.pdf">View December report</a>
    `,
      {
        sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
        reportDate: "2026-02-28",
        reportDateLabel: "February 28, 2026",
        reportDatePrecision: "month",
        reportPeriod: "February 2026",
        reportPdfPath: "/attestations/2026_february.pdf",
      },
    ],
    [
      "uses the href date before link text publication dates",
      `
      <a href="/reports/reserve-report-2026-02-28.pdf">
        Published March 4, 2026
      </a>
    `,
      {
        sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
        reportDate: "2026-02-28",
        reportDateSource: "href",
      },
    ],
    [
      "prefers an explicit day in a URL over the surrounding month-year text",
      `
      <a href="/reports/XSGD%20Reserve%20Account%20Report%20(15%20Mar%202026)%20(1).pdf">
        XSGD Attestation Report Mar 2026
      </a>
    `,
      {
        sourceTimestamp: Date.UTC(2026, 2, 15) / 1000,
        reportDate: "2026-03-15",
        reportDateLabel: "March 15, 2026",
        reportDatePrecision: "day",
      },
    ],
    [
      "parses day-first numeric report dates from PDF filenames before upload-path months",
      `
      <a href="https://issuer.example/wp-content/uploads/2026/04/SALVUS_Attestation_relative_au_nombre_de_jetons_EUROP_31_03_2026.pdf">
        Download as .pdf
      </a>
      <a href="https://issuer.example/wp-content/uploads/2025/07/Attestation_regarding_the_number_of_EUROP_tokens_as_of_30_06_25.pdf">
        Download as .pdf
      </a>
    `,
      {
        sourceTimestamp: Date.UTC(2026, 2, 31) / 1000,
        reportDate: "2026-03-31",
        reportDateLabel: "March 31, 2026",
        reportDatePrecision: "day",
        reportDateSource: "href",
      },
    ],
    [
      "normalizes two-digit years in day-first numeric PDF filenames",
      `
      <a href="/reports/Attestation_regarding_the_number_of_EUROP_tokens_as_of_30_06_25.pdf">
        Download as .pdf
      </a>
    `,
      {
        sourceTimestamp: Date.UTC(2025, 5, 30) / 1000,
        reportDate: "2025-06-30",
        reportDateLabel: "June 30, 2025",
        reportDatePrecision: "day",
      },
    ],
    [
      "parses compact YYYYMMDD report dates in PDF filenames",
      `
      <a href="https://action.ripio.com/hubfs/2025/wFIAT/ATTESTATION/31_12_2025__wBRL__Token-Certification.pdf">
        wBRL certification
      </a>
      <a href="https://action.ripio.com/hubfs/2026/wFIAT/ATTESTATION/20260331__wBRL__Token-Certification.pdf">
        wBRL certification
      </a>
    `,
      {
        sourceTimestamp: Date.UTC(2026, 2, 31) / 1000,
        reportDate: "2026-03-31",
        reportDateLabel: "March 31, 2026",
        reportDatePrecision: "day",
        reportDateSource: "href",
        reportPdfPath: "/hubfs/2026/wFIAT/ATTESTATION/20260331__wBRL__Token-Certification.pdf",
      },
    ],
  ] as const)("%s", (_name, html, expectedMetadata) => {
    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);
    expect(result.metadata).toMatchObject(expectedMetadata);
  });

  it("falls back to link text when the PDF href itself is not dated", () => {
    const html = `
      <a href="./latest-attestation.pdf">
        <span>March 31, 2026</span> independent attestation
      </a>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS, {
      indexUrl: "https://issuer.example/transparency/index.html",
    });

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 2, 31) / 1000,
      reportDate: "2026-03-31",
      reportDateSource: "text",
      reportPdfPath: "/transparency/latest-attestation.pdf",
      reportPdfUrl: "https://issuer.example/transparency/latest-attestation.pdf",
      reportLinkText: "March 31, 2026 independent attestation",
    });
  });

  it.each([wars, wbrl, wcop, wmxn])("reads $id's reviewed balance date rather than its upload folder", (coin) => {
    const config = coin.liveReservesConfig as LiveReservesConfig;
    const params = parseLiveReserveAdapterParams("attestation-pdf-index", config.params);
    const report = params.reviewedReport!;
    const result = adaptAttestationPdfIndex(ripioJune.html, params, { indexUrl: ripioJune.sourceUrl });
    const balanceDateMs = Date.parse(`${report.balanceDate}T00:00:00Z`);
    // The published report date comes from the month.day.year filename in the
    // reviewed URL; derive it so advancing the reviewed report does not need a
    // literal edit here.
    const numericDate = report.url.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    expect(numericDate, "reviewed report URL carries a month.day.year date").not.toBeNull();
    const reportDate = `${numericDate![3]}-${numericDate![1]}-${numericDate![2]}`;

    expect(result.metadata).toMatchObject({
      sourceTimestamp: balanceDateMs / 1000,
      reportDate,
      reportDatePrecision: "day",
      reportBalanceDate: report.balanceDate,
      reportPdfUrl: report.url,
      freshnessMode: "verified",
    });
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(config.scoring?.maxSourceAgeSec).toBeUndefined();
    const inCycle = expectValidAdapterOutput("attestation-pdf-index", result, {
      now: balanceDateMs / 1000 + 100 * 86_400,
    });
    expect(inCycle.warnings.some((warning) => warning.code === "stale-source-data")).toBe(false);
    const validation = expectValidAdapterOutput("attestation-pdf-index", result, {
      now: balanceDateMs / 1000 + 151 * 86_400,
    });
    expect(validation.warnings).toContainEqual(expect.objectContaining({ code: "stale-source-data", effect: "degraded" }));
    expect(validation.warnings.some((warning) => warning.code === "stale-redemption-source-timestamp")).toBe(false);
  });

  it("keeps USDU's reviewed reserve clock without fabricated redemption", () => {
    const config = usdu.liveReservesConfig as LiveReservesConfig;
    const params = parseLiveReserveAdapterParams("attestation-pdf-index", config.params);
    const report = params.reviewedReport!;
    const result = adaptAttestationPdfIndex(`<a href="/August-2026-USDU-Examination-Report.pdf">Report</a><a href="${report.url}">USDU Examination report</a>`, params);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.parse(`${report.balanceDate}T00:00:00Z`) / 1000,
      reportBalanceDate: report.balanceDate, reportPdfUrl: report.url,
    });
    expect(result.metadata).not.toHaveProperty("redemption");
    const maxSourceAgeSec = config.scoring?.maxSourceAgeSec;
    expect(maxSourceAgeSec).toBe(70 * 86_400);
    const inCycle = expectValidAdapterOutput("attestation-pdf-index", result, { now: Date.UTC(2026, 10, 20) / 1000, maxSourceAgeSec });
    expect(inCycle.warnings.some((warning) => warning.code === "stale-source-data")).toBe(false);
    const validation = expectValidAdapterOutput("attestation-pdf-index", result, { now: Date.UTC(2026, 11, 10) / 1000, maxSourceAgeSec });
    expect(validation.warnings).toContainEqual(expect.objectContaining({ code: "stale-source-data", effect: "degraded" }));
    expect(validation.warnings.some((warning) => warning.code === "stale-redemption-source-timestamp")).toBe(false);
  });

  it("binds Supercoin's double-encoded September report without using its October signing date", () => {
    const params = parseLiveReserveAdapterParams("attestation-pdf-index", zarsc.liveReservesConfig.params);
    const url = "https://cdn.prod.website-files.com/6a46ac9899c74f98e01a0974/6ad8adcc2dde2a518e28202b_6ad8acbed517875aae5c68c9_ZARsc%2520Proof%2520of%2520Reserves%2520Report%2520(Agreed-Upon%2520Procedures)%2520-%2520Sept%2520Snapshot%25202026-09-30%25201400%2520UTC.pdf";
    const result = adaptAttestationPdfIndex(`<a href="${url}">Sept</a>`, params);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 8, 30) / 1000,
      reportDate: "2026-09-30",
      reportBalanceDate: "2026-09-30",
      reportPdfUrl: url,
      freshnessMode: "verified",
    });
    expect(result.slices).toEqual(params.slices);
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(expectValidAdapterOutput("attestation-pdf-index", result, {
      now: Date.UTC(2026, 9, 21) / 1000,
    }).warnings).toEqual([]);
  });

  it("dates the captured Supercoin September report from its reviewed balance date", () => {
    const params = parseLiveReserveAdapterParams("attestation-pdf-index", zarsc.liveReservesConfig.params);
    const result = adaptAttestationPdfIndex(ZARSC_SUPERCOIN_HTML, params, {
      indexUrl: "https://www.supercoin.co.za/assurance-reports",
    });
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.parse("2026-09-30T00:00:00Z") / 1000,
      freshnessMode: "verified",
      reportPdfUrl: "https://cdn.prod.website-files.com/6a46ac9899c74f98e01a0974/6ad8adcc2dde2a518e28202b_6ad8acbed517875aae5c68c9_ZARsc%2520Proof%2520of%2520Reserves%2520Report%2520(Agreed-Upon%2520Procedures)%2520-%2520Sept%2520Snapshot%25202026-09-30%25201400%2520UTC.pdf",
      compositionSource: "configured-static-slices",
    });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("uses ZARP's reviewed September balances rather than the October report date", () => {
    const params = parseLiveReserveAdapterParams("attestation-pdf-index", zarp.liveReservesConfig.params);
    const result = adaptAttestationPdfIndex(`<a href="${params.reviewedReport!.url}">October 2026 report</a>`, params);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 8, 30) / 1000,
      reportBalanceDate: "2026-09-30",
      reportDate: "2026-10-01",
      freshnessMode: "verified",
    });
    const validation = expectValidAdapterOutput("attestation-pdf-index", result, { now: Date.UTC(2026, 9, 13) / 1000 });
    expect(validation.warnings).toEqual([]);
    expect(result.metadata).not.toHaveProperty("redemption");
  });

  it("preserves day-first interpretation for ambiguous numeric filenames", () => {
    const result = adaptAttestationPdfIndex(
      '<a href="https://issuer.example/attestation-06.07.2026.pdf">Report</a>',
      CONFIGURED_PARAMS,
    );
    expect(result.metadata?.reportDate).toBe("2026-07-06");
  });

  it("ignores 8-digit tokens that are not valid dates in PDF filenames", () => {
    const html = `
      <a href="https://action.ripio.com/hubfs/2026/wFIAT/ATTESTATION/12345678__wBRL__Token-Certification.pdf">
        wBRL certification
      </a>
    `;

    expect(() => adaptAttestationPdfIndex(html, CONFIGURED_PARAMS)).toThrow("layout-changed");
  });

  it("selects the currency-specific certificate when linkMatch is configured", () => {
    const html = `
      <a href="https://action.ripio.com/hubfs/2026/wFIAT/ATTESTATION/20260331__wBRL__Token-Certification.pdf">wBRL certification</a>
      <a href="https://action.ripio.com/hubfs/2026/wFIAT/ATTESTATION/20260331__wCOP__Token-Certification.pdf">wCOP certification</a>
    `;

    const result = adaptAttestationPdfIndex(html, { ...CONFIGURED_PARAMS, linkMatch: "wCOP" });

    expect(result.metadata).toMatchObject({
      reportDate: "2026-03-31",
      reportPdfUrl: "https://action.ripio.com/hubfs/2026/wFIAT/ATTESTATION/20260331__wCOP__Token-Certification.pdf",
    });
    expect(result.warnings).toBeUndefined();
  });

  it("omits reportPdfUrl and warns when no link matches the configured currency token", () => {
    const html = `
      <a href="https://action.ripio.com/hubfs/2026/wFIAT/ATTESTATION/20260331__wBRL__Token-Certification.pdf">wBRL certification</a>
    `;

    const result = adaptAttestationPdfIndex(html, { ...CONFIGURED_PARAMS, linkMatch: "wPEN" });

    expect(result.slices).toEqual(CONFIGURED_PARAMS.slices);
    expect(result.metadata).not.toHaveProperty("reportPdfUrl");
    expect(result.metadata).not.toHaveProperty("reportPdfHref");
    expect(result.metadata).not.toHaveProperty("reportDate");
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "attestation-pdf-index-link-unmatched",
      effect: "info",
    })]);
  });

  it("discovers dated PDFs in gated Webflow data attributes", () => {
    const html = `
      <button
        data-gated-asset="XSGD Attestation Report Jan 2026"
        data-gated-url="https://cdn.example/reports/xsgd-report-2026-Jan.pdf"
      ></button>
      <button
        data-gated-asset="XSGD Attestation Report Feb 2026"
        data-gated-url="https://cdn.example/reports/xsgd-report-2026-Feb.pdf"
      ></button>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
      reportDate: "2026-02-28",
      reportDatePrecision: "month",
      reportPeriod: "February 2026",
      reportPdfUrl: "https://cdn.example/reports/xsgd-report-2026-Feb.pdf",
      reportLinkText: "XSGD Attestation Report Feb 2026",
    });
  });

  it("ignores a newer gated whitepaper and keeps the latest dated reserve report", () => {
    const html = `
      <button
        data-gated-asset="XSGD Attestation Report May 2026"
        data-gated-url="https://cdn.example/XSGD_Reserve_Account_Report_(31_May_2026).pdf"
      ></button>
      <button
        data-gated-asset="XSGD Whitepaper"
        data-gated-url="https://cdn.example/reports/XSGD_Whitepaper_Last_Update_July_2026.docx.pdf"
      ></button>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 4, 31) / 1000,
      reportDate: "2026-05-31",
      reportPdfUrl: "https://cdn.example/XSGD_Reserve_Account_Report_(31_May_2026).pdf",
      reportLinkText: "XSGD Attestation Report May 2026",
    });
  });

  it("throws layout-changed when no dated PDF report link is present", () => {
    const html = `
      <a href="/reports/latest-attestation.pdf">Latest attestation</a>
      <a href="/reports/terms.pdf">Terms</a>
    `;

    expect(() => adaptAttestationPdfIndex(html, CONFIGURED_PARAMS)).toThrow("layout-changed");
  });

  it("rejects missing configured slices", () => {
    const html = '<a href="/reports/2026-02-28-attestation.pdf">February report</a>';

    expect(() => adaptAttestationPdfIndex(html, { slices: [] })).toThrow("params invalid.slices");
  });

  it("rejects an off-sum configured composition", () => {
    expect(() =>
      parseLiveReserveAdapterParams("attestation-pdf-index", {
        slices: [
          { name: "U.S. Treasury Bills", pct: 50, risk: "very-low" },
          { name: "Cash deposits", pct: 40, risk: "low" },
        ],
      }),
    ).toThrow("attestation-pdf-index adapter params invalid.slices");
  });
});

describe("fetchAttestationPdfIndexReserves", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the primary HTML input and resolves relative report URLs against that page", async () => {
    const html = '<a href="reports/2026-04-30-attestation.pdf">April 2026 report</a>';
    const network = installAdapterNetwork({
      html: {
        "https://issuer.example/transparency/index.html": {
          body: html,
          status: 200,
          headers: { "content-type": "text/html" },
        },
      },
    });

    const result = await fetchAttestationPdfIndexReserves(
      {} as StablecoinMeta,
      buildConfig("https://issuer.example/transparency/index.html"),
      new AbortController().signal,
    );

    expect(network.requests).toEqual([{ url: "https://issuer.example/transparency/index.html", method: "GET" }]);
    expect(result.slices).toEqual(CONFIGURED_PARAMS.slices);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 3, 30) / 1000,
      reportPdfPath: "/transparency/reports/2026-04-30-attestation.pdf",
      reportPdfUrl: "https://issuer.example/transparency/reports/2026-04-30-attestation.pdf",
      compositionMode: "configured-static-slices",
    });
  });

  it("fetches dated report HTML through the common network route", async () => {
    const html = '<a href="/reports/EUROP_Reserve_Report_31_05_2026.pdf">May 2026 report</a>';
    const network = installAdapterNetwork({
      html: {
        "https://schuman.io/reserve-attestations/": {
          body: html,
          status: 200,
          headers: { "content-type": "text/html" },
        },
      },
    });
    const result = await fetchAttestationPdfIndexReserves(
      {} as StablecoinMeta,
      buildConfig("https://schuman.io/reserve-attestations/"),
      new AbortController().signal,
    );

    expect(network.requests).toEqual([{ url: "https://schuman.io/reserve-attestations/", method: "GET" }]);
    expect(result.metadata).toMatchObject({
      reportDate: "2026-05-31",
      reportPdfPath: "/reports/EUROP_Reserve_Report_31_05_2026.pdf",
    });
  });
  it("fails closed when the report href field is renamed upstream", async () => {
    const url = "https://issuer.example/transparency/index.html";
    const network = installAdapterNetwork({
      html: {
        [url]: '<a data-report-url="/reports/2026-04-30-attestation.pdf">April 2026 report</a>',
      },
    });

    await expect(fetchAttestationPdfIndexReserves(
      {} as StablecoinMeta,
      buildConfig(url),
      new AbortController().signal,
    )).rejects.toThrow("layout-changed");
    expect(network.requests).toEqual([{ url, method: "GET" }]);
  });

  it("rejects an oversized index page instead of parsing it", async () => {
    const url = "https://issuer.example/transparency/index.html";
    installAdapterNetwork({
      html: {
        [url]: { body: "x".repeat(1024 * 1024 + 1), headers: { "content-type": "text/html" } },
      },
    });

    await expect(fetchAttestationPdfIndexReserves(
      {} as StablecoinMeta,
      buildConfig(url),
      new AbortController().signal,
    )).rejects.toThrow("Response body exceeded 1048576 bytes");
  });
});
