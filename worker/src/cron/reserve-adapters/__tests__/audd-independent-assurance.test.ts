import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { AUDD_INDEPENDENT_ASSURANCE_PROFILE, fetchAuddIndependentAssuranceReserves } from "../audd-independent-assurance";
import { fetchIndependentAssuranceReserves, verifyIndependentAssuranceReport } from "../independent-assurance";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");

vi.mock("../independent-assurance", async () => {
  const actual = await vi.importActual<typeof import("../independent-assurance")>("../independent-assurance");
  return { ...actual, fetchIndependentAssuranceReserves: vi.fn() };
});

function indexFixture(): string {
  return readFileSync(resolve(TEST_DIR, "fixtures", "audd-independent-assurance.html"), "utf8");
}

function installFetch(html: string) {
  const reviewed = getIndependentAssuranceManifest("AUDD");
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === reviewed.officialIndexUrl) {
      return new Response(html, { headers: { "content-type": "text/html" } });
    }
    if (url === reviewed.reportUrl) {
      return new Response(PDF_BYTES, {
        headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) },
      });
    }
    throw new Error(`unexpected fixture request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

  it("dispatches the bound coin through the publisher adapter and validates output", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "audd-novatti");
    expect(coin?.liveReservesConfig).toMatchObject({
      adapter: "audd-independent-assurance",
      semantics: "attestation-mix",
    });
    vi.mocked(fetchIndependentAssuranceReserves).mockResolvedValue({
      slices: [{ name: "AUD cash", pct: 100, risk: "very-low", assetClass: "bank-deposit" }],
      metadata: { sourceTimestamp: 1_787_219_940, freshnessMode: "verified" },
    });
    const result = await fetchAuddIndependentAssuranceReserves(
      coin!, coin!.liveReservesConfig!, new AbortController().signal,
    );
    expect(result.slices[0].name).toBe("AUD cash");
    expect(vi.mocked(fetchIndependentAssuranceReserves)).toHaveBeenCalledWith(
      coin!, coin!.liveReservesConfig!, expect.any(AbortSignal), AUDD_INDEPENDENT_ASSURANCE_PROFILE,
      { product: "AUDD", profile: "audd-v1", indexHost: "www.audd.digital", reportHosts: ["www.audd.digital"] },
      undefined,
    );

    const adapter = getReserveAdapter("audd-independent-assurance");
    expect(adapter?.evidenceClass).toBe("static-validated");
    expect(validateAdapterOutput(
      {
        slices: [{ name: "AUD cash", pct: 100, risk: "very-low" }],
        metadata: { sourceTimestamp: 1_787_219_940, freshnessMode: "verified" },
      },
      { adapter: adapter!, now: 1_787_219_940 + 3_000_000 },
    ).valid).toBe(true);
  });
});
