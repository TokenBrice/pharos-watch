import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");

function runSbc(indexHtml: string) {
  const reviewed = getIndependentAssuranceManifest("SBC");
  return runAdapter("sbc-independent-assurance", "sbc-brale", {
    network: installAdapterNetwork({
      html: {
        [reviewed.officialIndexUrl]: indexHtml,
        [reviewed.reportUrl]: new TextDecoder().decode(PDF_BYTES),
      },
    }),
  });
}

function indexFixture(): string {
  return `<html><body>
    <a href="/assets/reports/SBC-Stable-Coin-Reserve-Attestation-Report-05-2026.pdf">May</a>
    <a href="/assets/reports/SBC-Stable-Coin-Reserve-Attestation-Report-06-2026.pdf">Jun</a>
    <a href="/assets/reports/SBC-Stable-Coin-Reserve-Attestation-Report-07-2026.pdf">Jul</a>
  </body></html>`;
}

describe("sbc-independent-assurance (MCCPA SBC examination)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the July 31, 2026 MCCPA examination and preserves the examiner limitation", () => {
    const manifest = getIndependentAssuranceManifest("SBC");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.attestor).toBe("Michael Coglianese, CPA, P.C. (MCCPA)");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.reportAsOf).toBe("2026-07-31T23:50:00-04:00");
    expect(manifest.reportIssuedAt).toBe("2026-08-11T23:59:00-05:00");
    expect(manifest.engagement).toContain("independently confirm the authenticity and accuracy");
    expect(manifest.assets).toEqual([
      { code: "cash-and-cash-equivalents", label: expect.stringContaining("Cash and cash equivalents"), amount: "5972459" },
      { code: "us-government-backed-debt", label: "U.S. government backed debt", amount: "751220" },
    ]);
    expect(manifest.liabilities).toEqual([
      { code: "all-supported-blockchains", label: expect.stringContaining("SBC issued across all supported blockchains"), amount: "6723679" },
    ]);
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "6723679",
      liabilityTotal: "6723679",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
      collateralizationRatio: 1,
      reserveShortfall: "0",
    });
  });

  it("declares the independent-assurance descriptor", () => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS["sbc-independent-assurance"];
    expect(definition.evidenceClass).toBe("independent");
    expect(definition.sourceOriginClass).toBe("independent-assurance");
    expect(definition.redemptionTelemetry).toEqual({ capacity: "none", fee: "none" });
  });

  it("parses the real index shape and reaches the PDF byte-verification gate", async () => {
    await expect(runSbc(indexFixture())).rejects.toThrow("PDF byte length");
  });

  it("fails closed when a newer unreviewed report appears on the index", async () => {
    const html = indexFixture() +
      '<a href="/assets/reports/SBC-Stable-Coin-Reserve-Attestation-Report-08-2026.pdf">Aug</a>';
    await expect(runSbc(html)).rejects.toThrow("newer unreviewed report");
  });

  it("fails closed when a candidate date cannot be derived from its filename", async () => {
    const html = indexFixture() +
      '<a href="/assets/reports/SBC-Stable-Coin-Reserve-Attestation-Report-Undated.pdf">Undated</a>';
    await expect(runSbc(html)).rejects.toThrow("ambiguous report date");
  });

  it("dispatches the bound coin through the publisher adapter before PDF verification", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "sbc-brale");
    expect(coin?.liveReservesConfig).toMatchObject({
      adapter: "sbc-independent-assurance",
      semantics: "attestation-mix",
      inputs: { primary: { kind: "http-html", url: "https://brale.xyz/stablecoins/SBC" } },
      params: {
        product: "SBC",
        profile: "sbc-v1",
        indexHost: "brale.xyz",
        reportHosts: ["brale.xyz"],
      },
    });
    await expect(runSbc(indexFixture())).rejects.toThrow("PDF byte length");
  });
});
