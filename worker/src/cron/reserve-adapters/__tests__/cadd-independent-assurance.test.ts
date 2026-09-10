import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import {
  getIndependentAssuranceManifest,
  reconcileIndependentAssuranceManifest,
} from "@shared/lib/independent-assurance";
import { CADD_INDEPENDENT_ASSURANCE_PROFILE } from "../cadd-independent-assurance";
import { verifyIndependentAssuranceReport } from "../independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");
const INDEX_HOST = "tetradg.com";
const REPORT_HOSTS = ["drive.google.com", "drive.usercontent.google.com"];
const AUGUST_ANCHOR =
  '<li data-section-id="mpyslq"><a href="https://drive.google.com/file/d/1AugFailsClosedPlaceholderID/view?usp=sharing" target="_blank" rel="noopener">August 2026 attestation</a></li>';


function indexFixture(): string {
  return readFileSync(
    resolve(TEST_DIR, "fixtures", "cadd-independent-assurance.html"),
    "utf8",
  );
}

function installFetch(html: string) {
  const reviewed = getIndependentAssuranceManifest("CADD");
  return installAdapterNetwork({
    html: {
      [reviewed.officialIndexUrl]: html,
      [reviewed.reportUrl]: {
        body: new TextDecoder().decode(PDF_BYTES),
        headers: {
          "content-type": "application/pdf",
          "content-length": String(PDF_BYTES.length),
        },
      },
    },
  });
}

async function verifyIndex() {
  const reviewed = getIndependentAssuranceManifest("CADD");
  await verifyIndependentAssuranceReport({
    manifest: reviewed,
    indexUrl: reviewed.officialIndexUrl,
    indexHost: INDEX_HOST,
    reportHosts: REPORT_HOSTS,
    profile: CADD_INDEPENDENT_ASSURANCE_PROFILE,
    signal: new AbortController().signal,
  });
}

describe("cadd-independent-assurance (Baker Tilly CSAE 3000)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the July 31 2026 reasonable assurance report and reconciles CAD circulation across Base, Tempo and Ethereum", () => {
    const manifest = getIndependentAssuranceManifest("CADD");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestor).toBe("Baker Tilly WM LLP");
    expect(manifest.reportAsOf).toBe("2026-07-31T23:59:00Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "1194448.5",
      liabilityTotal: "1188399.38",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(manifest.assets).toEqual([
      { code: "cad-cash", label: "Canadian Dollar Cash", amount: "1194448.5" },
    ]);
    expect(manifest.liabilities).toHaveLength(1);
    const liability = manifest.liabilities[0];
    for (const chain of ["Base", "Tempo", "Ethereum"]) {
      expect(liability.label).toContain(chain);
    }
    expect(liability.amount).toBe("1188399.38");
  });

  it("declares the independent / independent-assurance descriptor", () => {
    const definition =
      LIVE_RESERVE_ADAPTER_DEFINITIONS["cadd-independent-assurance"];
    expect(definition.evidenceClass).toBe("independent");
    expect(definition.sourceOriginClass).toBe("independent-assurance");
    expect(definition.primaryInputKinds).toEqual(["http-html"]);
  });

  it("rewrites Drive share links to direct downloads and dates candidates from anchor text", async () => {
    const prepared = await CADD_INDEPENDENT_ASSURANCE_PROFILE.prepareIndexHtml!(
      indexFixture(),
      new AbortController().signal,
      undefined,
    );
    expect(prepared).not.toContain("view?usp=sharing");
    expect(prepared).toContain(
      getIndependentAssuranceManifest("CADD").reportUrl,
    );
    const date = CADD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate!;
    expect(date("", "June 2026 attestation")).toBe("2026-06-30");
    expect(date("", "July 2026 attestation")).toBe("2026-07-31");
    expect(date("", "Daily Reserve Ratio Reports")).toBeNull();
    expect(
      CADD_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
        "",
        "Daily Reserve Ratio Reports ",
      ),
    ).toBe(false);
    expect(
      CADD_INDEPENDENT_ASSURANCE_PROFILE.isReportCandidate(
        "",
        "June 2026 attestation",
      ),
    ).toBe(true);
  });

  it("parses the real index shape and reaches the PDF byte-verification gate", async () => {
    installFetch(indexFixture());
    await expect(verifyIndex()).rejects.toThrow(
      "PDF byte length",
    );
  });

  it("fails closed when a newer unreviewed attestation appears on the index", async () => {
    const html = indexFixture() + AUGUST_ANCHOR;
    installFetch(html);
    await expect(verifyIndex()).rejects.toThrow("newer unreviewed report");
  });

  it("rejects an attestation whose anchor text carries no date", async () => {
    const html =
      indexFixture() +
      '<a href="https://drive.google.com/file/d/1AAAAAAA/view?usp=sharing">Attestation</a>';
    installFetch(html);
    await expect(verifyIndex()).rejects.toThrow("ambiguous report date");
  });

});
