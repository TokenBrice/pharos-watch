import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { verifyIndependentAssuranceReport } from "../independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import { USAT_INDEPENDENT_ASSURANCE_PROFILE, USDPT_INDEPENDENT_ASSURANCE_PROFILE } from "../anchorage-independent-assurance";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");


function indexFixture(): string {
  return readFileSync(resolve(TEST_DIR, "fixtures", "anchorage-independent-assurance.html"), "utf8");
}

function installFetch(html: string, product: "USAT" | "USDPT" = "USAT") {
  const reviewed = getIndependentAssuranceManifest(product);
  return installAdapterNetwork({
    html: {
      [reviewed.officialIndexUrl]: html,
      [reviewed.reportUrl]: {
        body: new TextDecoder().decode(PDF_BYTES),
        headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) },
      },
    },
  });
}

async function verifyIndex(product: "USAT" | "USDPT" = "USAT") {
  const reviewed = getIndependentAssuranceManifest(product);
  await verifyIndependentAssuranceReport({
    manifest: reviewed,
    indexUrl: reviewed.officialIndexUrl,
    indexHost: "www.anchorage.com",
    reportHosts: ["learn.anchorage.com"],
    profile: product === "USDPT" ? USDPT_INDEPENDENT_ASSURANCE_PROFILE : USAT_INDEPENDENT_ASSURANCE_PROFILE,
    signal: new AbortController().signal,
  });
}


afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anchorage-independent-assurance (Deloitte Anchorage examinations)", () => {
  it("reviews the July 2026 examination and reconciles both chain liabilities", () => {
    const manifest = getIndependentAssuranceManifest("USAT");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestor).toBe("Deloitte & Touche LLP");
    expect(manifest.attestorIdentification).toMatchObject({
      method: "reviewed-inference",
      evidence: [expect.any(String), expect.any(String)],
      reReviewTrigger: expect.any(String),
    });
    expect(manifest.reportAsOf).toBe("2026-07-31T23:59:59Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "175906606",
      liabilityTotal: "175245527",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(manifest.liabilities).toEqual([
      { code: "ethereum", label: "Ethereum USAT redeemable tokens", amount: "175204971" },
      { code: "celo", label: "Celo USAT redeemable tokens", amount: "40556" },
    ]);
    expect(manifest.assets).toEqual([
      { code: "cash", label: "Cash", amount: "17507606" },
      { code: "reverse-repo", label: "Reverse repurchase agreements collateralized by U.S. Treasury securities, at fair value", amount: "158399000" },
    ]);
  });

  it("declares the independent-assurance descriptor for the AICPA examination", () => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS["anchorage-independent-assurance"];
    expect(definition.evidenceClass).toBe("independent");
    expect(definition.sourceOriginClass).toBe("independent-assurance");
  });

  it("parses the real index shape and reaches the PDF byte-verification gate", async () => {
    installFetch(indexFixture());
    await expect(verifyIndex()).rejects.toThrow("PDF byte length");
  });

  it("fails closed when a newer unreviewed report appears on the index", async () => {
    const html = indexFixture() +
      '<a href="https://learn.anchorage.com/08.31.26_USAT-Stablecoin-Attestation-Report.pdf">Aug</a>';
    installFetch(html);
    await expect(verifyIndex()).rejects.toThrow("newer unreviewed report");
  });

  it("fails closed when the reviewed report is duplicated at the latest date", async () => {
    const html = indexFixture() +
      '<a href="https://learn.anchorage.com/07.31.26_USAT-Stablecoin-Attestation-Report-revised.pdf">Jul revised</a>';
    installFetch(html);
    await expect(verifyIndex()).rejects.toThrow("reviewed report URL is missing or duplicated");
  });

  it("fails closed when the latest report href is dropped from the Anchorage index", async () => {
    const reviewed = getIndependentAssuranceManifest("USAT");
    const network = installAdapterNetwork({
      html: {
        [reviewed.officialIndexUrl]: "<a data-report-url=\"07.31.26_USAT-Stablecoin-Attestation-Report.pdf\">July</a>",
      },
    });

    await expect(verifyIndex()).rejects.toThrow(/reviewed report URL is missing or duplicated/);
    expect(network.requests.map((request) => request.url)).toEqual([reviewed.officialIndexUrl]);
  });


  it("reviews the July 2026 USDPT examination and reconciles the Solana liability", () => {
    const manifest = getIndependentAssuranceManifest("USDPT");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestor).toBe("Deloitte & Touche LLP");
    expect(manifest.reportAsOf).toBe("2026-07-31T23:59:59Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "6935076",
      liabilityTotal: "6823001",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(manifest.assets).toEqual([
      { code: "cash", label: "Cash in FDIC-insured demand deposit accounts at major commercial banks", amount: "683861" },
      { code: "money-market-funds", label: "Money market funds, at net asset value", amount: "6251215" },
    ]);
    expect(manifest.liabilities).toEqual([
      { code: "solana", label: "Solana USDPT redeemable tokens outstanding", amount: "6823001" },
    ]);
  });

  it("selects the reviewed USDPT report on the USDPT index and fails closed on a newer unreviewed report", async () => {
    const reviewed = getIndependentAssuranceManifest("USDPT");
    const html =
      '<div class="accordion-dates-grid">' +
      '<a href="https://learn.anchorage.com/05.31.26_USDPT_Stablecoin_Attestation_Report_signed.pdf">May</a>' +
      '<a href="https://learn.anchorage.com/06.30.26_USDPT-Stablecoin-Attestation-Report.pdf">Jun</a>' +
      `<a href="${reviewed.reportUrl}">Jul</a>` +
      "</div>";
    installFetch(html, "USDPT");
    await expect(verifyIndex("USDPT")).rejects.toThrow("PDF byte length");

    const newer = html.replace(
      "</div>",
      '<a href="https://learn.anchorage.com/08.31.26_USDPT-Stablecoin-Attestation-Report.pdf">Aug</a></div>',
    );
    installFetch(newer, "USDPT");
    await expect(verifyIndex("USDPT")).rejects.toThrow("newer unreviewed report");
  });

});
