import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { fetchAnchorageIndependentAssuranceReserves, USDPT_INDEPENDENT_ASSURANCE_PROFILE, USAT_INDEPENDENT_ASSURANCE_PROFILE } from "../anchorage-independent-assurance";
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
  return readFileSync(resolve(TEST_DIR, "fixtures", "anchorage-independent-assurance.html"), "utf8");
}

function installFetch(html: string, product: "USAT" | "USDPT" = "USAT") {
  const reviewed = getIndependentAssuranceManifest(product);
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

describe("anchorage-independent-assurance (Deloitte Anchorage examinations)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reviews the July 2026 examination and reconciles both chain liabilities", () => {
    const manifest = getIndependentAssuranceManifest("USAT");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestor).toBe("Deloitte & Touche LLP");
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

  it("dispatches the bound coin through the publisher adapter and validates output", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "usat-tether");
    expect(coin?.liveReservesConfig).toMatchObject({
      adapter: "anchorage-independent-assurance",
      semantics: "attestation-mix",
    });
    vi.mocked(fetchIndependentAssuranceReserves).mockResolvedValue({
      slices: [{ name: "Cash at major commercial banks", pct: 10, risk: "very-low", assetClass: "bank-deposit" }],
      metadata: { sourceTimestamp: 1_785_542_399, freshnessMode: "verified" },
    });
    const result = await fetchAnchorageIndependentAssuranceReserves(
      coin!, coin!.liveReservesConfig!, new AbortController().signal,
    );
    expect(result.slices[0].name).toBe("Cash at major commercial banks");
    expect(vi.mocked(fetchIndependentAssuranceReserves)).toHaveBeenCalledWith(
      coin!, coin!.liveReservesConfig!, expect.any(AbortSignal), USAT_INDEPENDENT_ASSURANCE_PROFILE,
      { product: "USAT", profile: "usat-v1", indexHost: "www.anchorage.com", reportHosts: ["learn.anchorage.com"] },
      undefined,
    );

    const adapter = getReserveAdapter("anchorage-independent-assurance");
    expect(adapter?.evidenceClass).toBe("independent");
    expect(validateAdapterOutput(
      {
        slices: [{ name: "Cash", pct: 100, risk: "very-low" }],
        metadata: { sourceTimestamp: 1_785_542_399, freshnessMode: "verified" },
      },
      { adapter: adapter!, now: 1_785_542_399 + 3_000_000 },
    ).valid).toBe(true);
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

  it("dispatches the bound USDPT coin through the publisher adapter and validates output", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "usdpt-western-union");
    expect(coin?.liveReservesConfig).toMatchObject({
      adapter: "anchorage-independent-assurance",
      semantics: "attestation-mix",
    });
    vi.mocked(fetchIndependentAssuranceReserves).mockResolvedValue({
      slices: [{ name: "Money market funds, at net asset value", pct: 90.1391, risk: "low", assetClass: "money-market-fund" }],
      metadata: { sourceTimestamp: 1_785_542_399, freshnessMode: "verified" },
    });
    const result = await fetchAnchorageIndependentAssuranceReserves(
      coin!, coin!.liveReservesConfig!, new AbortController().signal,
    );
    expect(result.slices[0].name).toBe("Money market funds, at net asset value");
    expect(vi.mocked(fetchIndependentAssuranceReserves)).toHaveBeenCalledWith(
      coin!, coin!.liveReservesConfig!, expect.any(AbortSignal), USDPT_INDEPENDENT_ASSURANCE_PROFILE,
      { product: "USDPT", profile: "usdpt-v1", indexHost: "www.anchorage.com", reportHosts: ["learn.anchorage.com"] },
      undefined,
    );
  });
});
