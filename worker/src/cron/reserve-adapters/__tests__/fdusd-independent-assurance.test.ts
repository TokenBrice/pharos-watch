import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, independentAssuranceSourceTimestamp, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { FDUSD_INDEPENDENT_ASSURANCE_PROFILE, fetchFdusdIndependentAssuranceReserves } from "../fdusd-independent-assurance";
import { fetchIndependentAssuranceReserves, verifyIndependentAssuranceReport } from "../independent-assurance";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

vi.mock("../independent-assurance", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../independent-assurance");
  return { ...actual, fetchIndependentAssuranceReserves: vi.fn() };
});

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");
const reviewed = getIndependentAssuranceManifest("FDUSD");

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FEB_2026_HREF =
  "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/69b8bb692133e7d22020f80a_FD121_(BVI)_-_ISAE3000_Attestation_Report_on_Reserves_Account_(Feb_2026)_(FINAL).pdf";
const SEP_2025_HREF =
  "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/68f09f623c0571b23acecbcc_ISAE3000_-_Attestion_Report_on_Reserves_Account_(Sept_2025)_Final.pdf";

// The live Webflow index capture: every ISAE 3000 row the newer-report fence
// dates, including the Feb 2026 and Sept 2025 rows whose CDN filenames separate
// the report month and year with an underscore instead of a space.
const LIVE_INDEX_FIXTURE = resolve(TEST_DIR, "fixtures", "fdusd-independent-assurance.html");

// Webflow CDN cohort: the June signed-image report (no ISAE 3000 marker) and a
// whitepaper handout carrying an ISAE 3000 label must both stay out of the
// candidate set; only the reviewed July AOGB report may remain.
const OFF_COHORT_LINKS = `
  <a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/6a55fa1246d16025bd7f7d87_FDUSD%20Reserve%20accounts%20Report_JUN%202026%20(signed%20by%20Accountant).pdf">June 2026</a>
  <a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/FDUSD-ISAE3000-Whitepaper-July-2026.pdf">Whitepaper</a>
`;

function indexHtml(extra = ""): string {
  return `
    ${OFF_COHORT_LINKS}
    <a href="${reviewed.reportUrl}">ISAE 3000 Attestation Report July 2026</a>
    ${extra}
  `;
}

function installFetch(html: string) {
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

function verifyIndex() {
  return verifyIndependentAssuranceReport({
    manifest: reviewed,
    indexUrl: reviewed.officialIndexUrl,
    indexHost: "firstdigitallabs.webflow.io",
    reportHosts: ["cdn.prod.website-files.com"],
    profile: FDUSD_INDEPENDENT_ASSURANCE_PROFILE,
    signal: new AbortController().signal,
  });
}

describe("fdusd-independent-assurance (AOGB ISAE 3000 limited assurance)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reconciles the July 2026 report across every native FDUSD chain", () => {
    expect(reviewed.assuranceTier).toBe("independent-assurance");
    expect(reviewed.attestor).toBe("AOGB CPA Limited");
    expect(reviewed.reportAsOf).toBe("2026-07-31T21:00:00-04:00");
    expect(reviewed.reportDate).toBe("2026-07-31");
    const reconciliation = reconcileIndependentAssuranceManifest(reviewed);
    expect(reconciliation).toMatchObject({
      computedAssetTotal: "351643471.73",
      liabilityTotal: "350156619.24",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(reconciliation.collateralizationRatio).toBeCloseTo(351643471.73 / 350156619.24, 12);
    for (const chain of ["ethereum", "bsc", "sui", "solana", "arbitrum", "ton"]) {
      expect(
        reviewed.liabilities.some((row) => row.code === chain && Number(row.amount) > 0),
        `missing positive ${chain} liability row`,
      ).toBe(true);
    }
    // The liability chain set sums to the reported total exactly; dropping any
    // chain (here TON) must fail the reconciliation.
    expect(reconciliation.liabilityTotal).toBe("350156619.24");
    expect(() =>
      reconcileIndependentAssuranceManifest({
        ...reviewed,
        liabilities: reviewed.liabilities.filter((row) => row.code !== "ton"),
      }),
    ).toThrow("liability total 350155531.59 does not match manifest 350156619.24");
  });

  it("measures freshness from the examined instant, 25h past the 00:00Z misdate", () => {
    const timestamp = independentAssuranceSourceTimestamp(reviewed);
    expect(timestamp).toBe(Date.parse("2026-08-01T01:00:00Z") / 1000);
    expect(timestamp - Date.parse("2026-07-31T00:00:00Z") / 1000).toBe(25 * 3_600);
  });

  it("selects the reviewed report on the Webflow index and reaches the PDF byte gate", async () => {
    installFetch(indexHtml());
    await expect(verifyIndex()).rejects.toThrow(
      `PDF byte length ${PDF_BYTES.length} does not match reviewed ${reviewed.reportByteLength}`,
    );
  });

  it("dates every row of the live Webflow index, including underscore-separated CDN filenames", async () => {
    // Regression: the live index pairs "(Feb_2026)" and "(Sept_2025)" filenames
    // with "(July 2026)"-style names, and the fence reads an undated candidate as
    // proof the index changed shape, so a missed underscore separator errored the
    // whole sync instead of publishing the reviewed July report.
    expect(FDUSD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate?.(FEB_2026_HREF, "Download")).toBe(
      "2026-02-28",
    );
    expect(FDUSD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate?.(SEP_2025_HREF, "Download")).toBe(
      "2025-09-30",
    );
    installFetch(readFileSync(LIVE_INDEX_FIXTURE, "utf8"));
    await expect(verifyIndex()).rejects.toThrow(
      `PDF byte length ${PDF_BYTES.length} does not match reviewed ${reviewed.reportByteLength}`,
    );
  });

  it("fails closed when a newer unreviewed ISAE 3000 report appears", async () => {
    installFetch(indexHtml(
      '<a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/cafe_ISAE3000%20-%20Attestation%20Report%20on%20Reserves%20Account%20August%202026.pdf">August 2026</a>',
    ));
    await expect(verifyIndex()).rejects.toThrow("newer unreviewed report");
  });

  it("rejects an ISAE 3000 candidate whose report month cannot be derived", async () => {
    installFetch(indexHtml(
      '<a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/ISAE3000-attestation-report.pdf">Latest</a>',
    ));
    await expect(verifyIndex()).rejects.toThrow("ambiguous report date");
  });

  it("dispatches the bound coin through the publisher adapter and validates output", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "fdusd-first-digital");
    expect(coin?.liveReservesConfig).toMatchObject({
      adapter: "fdusd-independent-assurance",
      version: 2,
      semantics: "attestation-mix",
    });
    vi.mocked(fetchIndependentAssuranceReserves).mockResolvedValue({
      slices: [{
        name: "U.S. Treasury Bills (maturities 11-Aug-26 through 22-Sep-26)",
        pct: 75.9,
        risk: "very-low",
        assetClass: "treasury-bill",
      }],
      metadata: { sourceTimestamp: Date.parse("2026-08-01T01:00:00Z") / 1000, freshnessMode: "verified" },
    });
    const result = await fetchFdusdIndependentAssuranceReserves(
      coin!, coin!.liveReservesConfig!, new AbortController().signal,
    );
    expect(result.slices[0].name).toContain("Treasury Bills");
    expect(vi.mocked(fetchIndependentAssuranceReserves)).toHaveBeenCalledWith(
      coin!, coin!.liveReservesConfig!, expect.any(AbortSignal), FDUSD_INDEPENDENT_ASSURANCE_PROFILE,
      {
        product: "FDUSD",
        profile: "fdusd-v1",
        indexHost: "firstdigitallabs.webflow.io",
        reportHosts: ["cdn.prod.website-files.com"],
      },
      undefined,
    );

    const adapter = getReserveAdapter("fdusd-independent-assurance");
    expect(adapter?.evidenceClass).toBe("independent");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["fdusd-independent-assurance"].sourceOriginClass).toBe("independent-assurance");
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["fdusd-independent-assurance"].provenance.status).toBe("active");
    expect(validateAdapterOutput(
      {
        slices: [{ name: "U.S. Treasury Bills", pct: 100, risk: "very-low" }],
        metadata: { sourceTimestamp: Date.parse("2026-08-01T01:00:00Z") / 1000, freshnessMode: "verified" },
      },
      { adapter: adapter!, now: Date.parse("2026-08-01T01:00:00Z") / 1000 + 3_000_000 },
    ).valid).toBe(true);
  });
});
