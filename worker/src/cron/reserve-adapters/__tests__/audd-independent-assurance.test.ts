import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { AUDD_INDEPENDENT_ASSURANCE_PROFILE } from "../audd-independent-assurance";
import { verifyIndependentAssuranceReport } from "../independent-assurance";

import { installAdapterNetwork } from "./reserve-adapter.test-support";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");


function indexFixture(): string {
  return readFileSync(resolve(TEST_DIR, "fixtures", "audd-independent-assurance.html"), "utf8");
}

function installFetch(html: string) {
  const reviewed = getIndependentAssuranceManifest("AUDD");
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

async function verifyIndex() {
  const reviewed = getIndependentAssuranceManifest("AUDD");
  await verifyIndependentAssuranceReport({
    manifest: reviewed,
    indexUrl: reviewed.officialIndexUrl,
    indexHost: "www.audd.digital",
    reportHosts: ["www.audd.digital"],
    profile: AUDD_INDEPENDENT_ASSURANCE_PROFILE,
    signal: new AbortController().signal,
  });
}

describe("audd-independent-assurance (William Buck ASRS 4400 AUP)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the August 2026 agreed-upon-procedures report and reconciles every chain's circulation", () => {
    const manifest = getIndependentAssuranceManifest("AUDD");
    expect(manifest.assuranceTier).toBe("agreed-upon-procedures");
    expect(manifest.attestor).toBe("William Buck Audit (Vic) Pty Ltd");
    expect(manifest.reportAsOf).toBe("2026-08-31T23:59:00Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "11544609.77",
      liabilityTotal: "11408211.96",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    for (const chain of ["stellar", "xrpl", "ethereum", "solana", "hedera", "base", "xdc", "redbelly"]) {
      expect(manifest.liabilities.some((row) => row.code === chain && Number(row.amount) > 0)).toBe(true);
    }
    expect(manifest.assets).toEqual([
      { code: "banking-circle", label: "AUD cash held at Banking Circle (AUDC Reserve Account)", amount: "288159.90" },
      { code: "westpac", label: "AUD cash held at Westpac under the AMAL Bare Trust", amount: "11256449.87" },
    ]);
  });

  it("declares the static-validated / issuer-attested descriptor for a non-assurance engagement", () => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS["audd-independent-assurance"];
    expect(definition.evidenceClass).toBe("static-validated");
    expect(definition.sourceOriginClass).toBe("issuer-attested");
    expect(definition.sourceModel).toBe("validated-static");
  });

  it("parses the real index shape and reaches the PDF byte-verification gate", async () => {
    installFetch(indexFixture());
    await expect(verifyIndex()).rejects.toThrow("PDF byte length");
  });

  it("fails closed when a newer unreviewed report appears on the index", async () => {
    const html = indexFixture() +
      '<a href="https://www.audd.digital/wp-content/uploads/2026/10/AUDC-Agreed-upon-procedures-report-Sep26_.pdf">September 2026</a>';
    installFetch(html);
    await expect(verifyIndex()).rejects.toThrow("newer unreviewed report");
  });

  it("rejects a candidate whose date cannot be derived from its filename", async () => {
    const html = indexFixture() +
      '<a href="https://www.audd.digital/wp-content/uploads/2026/10/AUDC-Agreed-upon-procedures-report-Undated.pdf">Undated</a>';
    installFetch(html);
    await expect(verifyIndex()).rejects.toThrow("ambiguous report date");
  });

  it("fails closed when the latest report href is renamed on the AUDD index", async () => {
    const reviewed = getIndependentAssuranceManifest("AUDD");
    const network = installAdapterNetwork({
      html: {
        [reviewed.officialIndexUrl]: "<a data-report-url=\"AUDC-Agreed-upon-procedures-report-Aug26_.pdf\">August 2026</a>",
      },
    });

    await expect(verifyIndex()).rejects.toThrow(/reviewed report URL is missing or duplicated/);
    expect(network.requests.map((request) => request.url)).toEqual([reviewed.officialIndexUrl]);
  });

});
