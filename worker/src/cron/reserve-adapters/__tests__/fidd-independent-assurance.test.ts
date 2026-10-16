import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  fiddIndependentAssuranceProfile,
  fiddReportDate,
} from "../fidd-independent-assurance";
import { verifyIndependentAssuranceReport } from "../independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import type { AdapterHttpResponse } from "./reserve-adapter.test-support";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");

const VIEWER_URL = "https://fwc.widen.net/s/jgdsvvsknq/fidelity-digital-assets---fidd-reserve-attestation-report---august-2026";
const SEPTEMBER_VIEWER_URL = "https://fwc.widen.net/s/nextreport/fidelity-digital-assets---fidd-reserve-attestation-report---september-2026";
const CDN_PDF_URL =
  "https://cf-store.widencdn.net/fwc/1/4/7/147b4558-cc40-4196-b5a8-d5ad517e019a.pdf?response-content-type=application%2Fpdf";

/**
 * Fidelity's WAF answers 403 to crawler user agents without a contact URI —
 * the prod failures hit both the shared browser-shaped index UA and the
 * neutral Pharos UA — so the responder enforces that observed rule instead of
 * answering any user agent.
 */
function fidelityIndex(indexHtml: string) {
  return (request: Request): string | AdapterHttpResponse =>
    /\+https?:\/\//.test(request.headers.get("user-agent") ?? "")
      ? { body: indexHtml, headers: { "content-type": "text/html; charset=utf-8" } }
      : { status: 403, body: "Forbidden" };
}

function indexFixture(withViewerLink = true): string {
  return `<html><body>${withViewerLink
    ? `<a href="${VIEWER_URL}">August</a>`
    : ""}<a href="https://fwc.widen.net/s/gbhfm2zv87/fidelity-digital-assets---fidd-reserve-attestation-report---june-2026">June</a></body></html>`;
}

function viewerFixture(withDownloadAnchor = true): string {
  return `<html><head><title>Fidelity-Digital-Assets---FIDD-Reserve-Attestation-Report---August-2026.pdf</title></head><body>${withDownloadAnchor
    ? `<a id="download" href="/content/z6rtnzs3v9/original/Fidelity-Digital-Assets---FIDD-Reserve-Attestation-Report---August-2026.pdf?u=5lvvtn&amp;download=true"><span>Download</span></a>`
    : ""}</body></html>`;
}

function installFetch(indexHtml: string, viewerHtml: string) {
  const reviewed = getIndependentAssuranceManifest("FIDD");
  return installAdapterNetwork({
    html: {
      [reviewed.officialIndexUrl]: fidelityIndex(indexHtml),
      [VIEWER_URL]: viewerHtml,
      // The reviewed fwc.widen.net URL 303-redirects to the Widen CDN.
      [reviewed.reportUrl]: {
        body: new TextDecoder().decode(PDF_BYTES),
        url: CDN_PDF_URL,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(PDF_BYTES.length),
        },
      },
    },
  });
}

/** The coin's own reviewed params, so the checks below run the configured allowlist. */
function fiddParams(): { indexHost: string; reportHosts: readonly string[]; viewerUrlPattern: string } {
  const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "fidd-fidelity");
  const params = coin!.liveReservesConfig!.params!;
  return {
    indexHost: params.indexHost as string,
    reportHosts: params.reportHosts as readonly string[],
    viewerUrlPattern: params.viewerUrlPattern as string,
  };
}

async function verifyIndex(overrides: { reportHosts?: readonly string[] } = {}) {
  const reviewed = getIndependentAssuranceManifest("FIDD");
  const params = fiddParams();
  await verifyIndependentAssuranceReport({
    manifest: reviewed,
    indexUrl: reviewed.officialIndexUrl,
    indexHost: params.indexHost,
    reportHosts: overrides.reportHosts ?? params.reportHosts,
    profile: fiddIndependentAssuranceProfile(params.viewerUrlPattern),
    signal: new AbortController().signal,
  });
}

describe("fidd-independent-assurance (PwC FIDD examination)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the August 31, 2026 PwC examination with the August 31 column figures", () => {
    const manifest = getIndependentAssuranceManifest("FIDD");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.attestor).toBe("PricewaterhouseCoopers LLP");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.reportAsOf).toBe("2026-08-31T17:00:00-04:00");
    expect(manifest.reportIssuedAt).toBe("2026-09-25T23:59:00-04:00");
    expect(manifest.assets).toEqual([
      { code: "cash-deposits", label: expect.stringContaining("Cash deposits held in bank deposit accounts"), amount: "20717851.25" },
      { code: "us-treasury-bills", label: "U.S. Treasury bills (August 31 column)", amount: "31173738.08" },
    ]);
    expect(manifest.liabilities).toEqual([
      { code: "ethereum", label: expect.stringContaining("Ethereum Mainnet tokens"), amount: "49290319" },
    ]);
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "51891589.33",
      liabilityTotal: "49290319",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
      reserveShortfall: "0",
    });
  });

  it("declares the independent-assurance descriptor", () => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS["fidd-independent-assurance"];
    expect(definition.evidenceClass).toBe("independent");
    expect(definition.sourceOriginClass).toBe("independent-assurance");
    expect(definition.redemptionTelemetry).toEqual({ capacity: "none", fee: "none" });
  });

  it("derives the report year from dated viewer and PDF names", () => {
    expect(fiddReportDate("https://fwc.widen.net/s/id/report---august26", "")).toBe("2026-08-31");
    expect(fiddReportDate(VIEWER_URL, "")).toBe("2026-08-31");
    expect(fiddReportDate("https://fwc.widen.net/content/report---august-2026.pdf", "")).toBe("2026-08-31");
    expect(fiddReportDate("https://fwc.widen.net/content/report---january2027.pdf", "")).toBe("2027-01-31");
  });

  it("selects the newest matching dated viewer link", async () => {
    installAdapterNetwork({
      html: {
        [SEPTEMBER_VIEWER_URL]: viewerFixture().replaceAll("August-2026", "September-2026"),
      },
    });
    const profile = fiddIndependentAssuranceProfile(fiddParams().viewerUrlPattern);
    const prepared = await profile.prepareIndexHtml!(
      `${indexFixture()}<a href="${SEPTEMBER_VIEWER_URL}">September</a>`,
      new AbortController().signal,
    );
    expect(prepared).toContain("September-2026.pdf");
  });


  it("fails closed when no dated viewer link is present on the official index", async () => {
    installFetch("<a href=\"https://fwc.widen.net/s/id/fidelity-digital-assets---fidd-reserve-attestation-report---undated\">Report</a>", viewerFixture());
    await expect(verifyIndex())
      .rejects.toThrow("no dated attestation viewer link found");
  });

  it("fails closed when the viewer page no longer serves a download anchor", async () => {
    installFetch(indexFixture(), viewerFixture(false));
    await expect(verifyIndex())
      .rejects.toThrow("download link is missing from the Widen viewer page");
  });

});
