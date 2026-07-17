import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adaptAttestationPdfIndex,
  fetchAttestationPdfIndexReserves,
  type AttestationPdfIndexParams,
} from "../attestation-pdf-index";
import { HTML_ACCEPT_HEADER, NEUTRAL_ADAPTER_HEADERS } from "../request";

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
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
        routeStatus: "unknown",
      },
    });
    expect(String(result.metadata?.compositionNote)).toContain("full PDF parsing");
  });

  it("uses end-of-month freshness for month-only report dates", () => {
    const html = `
      <a href="/attestations/2026_january.pdf">View January report</a>
      <a href="/attestations/2026_february.pdf">View February report</a>
      <a href="/attestations/2025_december.pdf">View December report</a>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
      reportDate: "2026-02-28",
      reportDateLabel: "February 28, 2026",
      reportDatePrecision: "month",
      reportPeriod: "February 2026",
      reportPdfPath: "/attestations/2026_february.pdf",
    });
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

  it("uses the href date before link text publication dates", () => {
    const html = `
      <a href="/reports/reserve-report-2026-02-28.pdf">
        Published March 4, 2026
      </a>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
      reportDate: "2026-02-28",
      reportDateSource: "href",
    });
  });

  it("prefers an explicit day in a URL over the surrounding month-year text", () => {
    const html = `
      <a href="/reports/XSGD%20Reserve%20Account%20Report%20(15%20Mar%202026)%20(1).pdf">
        XSGD Attestation Report Mar 2026
      </a>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 2, 15) / 1000,
      reportDate: "2026-03-15",
      reportDateLabel: "March 15, 2026",
      reportDatePrecision: "day",
    });
  });

  it("parses day-first numeric report dates from PDF filenames before upload-path months", () => {
    const html = `
      <a href="https://issuer.example/wp-content/uploads/2026/04/SALVUS_Attestation_relative_au_nombre_de_jetons_EUROP_31_03_2026.pdf">
        Download as .pdf
      </a>
      <a href="https://issuer.example/wp-content/uploads/2025/07/Attestation_regarding_the_number_of_EUROP_tokens_as_of_30_06_25.pdf">
        Download as .pdf
      </a>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 2, 31) / 1000,
      reportDate: "2026-03-31",
      reportDateLabel: "March 31, 2026",
      reportDatePrecision: "day",
      reportDateSource: "href",
    });
  });

  it("normalizes two-digit years in day-first numeric PDF filenames", () => {
    const html = `
      <a href="/reports/Attestation_regarding_the_number_of_EUROP_tokens_as_of_30_06_25.pdf">
        Download as .pdf
      </a>
    `;

    const result = adaptAttestationPdfIndex(html, CONFIGURED_PARAMS);

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2025, 5, 30) / 1000,
      reportDate: "2025-06-30",
      reportDateLabel: "June 30, 2025",
      reportDatePrecision: "day",
    });
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
});

describe("fetchAttestationPdfIndexReserves", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the primary HTML input and resolves relative report URLs against that page", async () => {
    const html = '<a href="reports/2026-04-30-attestation.pdf">April 2026 report</a>';
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(html, {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAttestationPdfIndexReserves(
      {} as StablecoinMeta,
      buildConfig("https://issuer.example/transparency/index.html"),
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://issuer.example/transparency/index.html",
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "https://issuer.example",
          Referer: "https://issuer.example/transparency/index.html",
          "Accept-Language": "en-US,en;q=0.9",
        }),
      }),
    );
    expect(result.slices).toEqual(CONFIGURED_PARAMS.slices);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.UTC(2026, 3, 30) / 1000,
      reportPdfPath: "/transparency/reports/2026-04-30-attestation.pdf",
      reportPdfUrl: "https://issuer.example/transparency/reports/2026-04-30-attestation.pdf",
      compositionMode: "configured-static-slices",
    });
  });

  it("uses neutral HTML headers first for Schuman reserve-audit pages", async () => {
    const html = '<a href="/reports/EUROP_Reserve_Report_31_05_2026.pdf">May 2026 report</a>';
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(html, {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAttestationPdfIndexReserves(
      {} as StablecoinMeta,
      buildConfig("https://schuman.io/reserve-audits/"),
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://schuman.io/reserve-audits/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: HTML_ACCEPT_HEADER,
          ...NEUTRAL_ADAPTER_HEADERS,
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Origin");
    expect(result.metadata).toMatchObject({
      reportDate: "2026-05-31",
      reportPdfPath: "/reports/EUROP_Reserve_Report_31_05_2026.pdf",
    });
  });
});
