import { createHash } from "node:crypto";
import * as assurance from "@shared/lib/independent-assurance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, independentAssuranceSourceTimestamp, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { FDUSD_INDEPENDENT_ASSURANCE_PROFILE } from "../fdusd-independent-assurance-profile";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";
import { PDF_BYTES, installFetch, verifyFixtureIndex } from "./independent-assurance.test-support";


const reviewed = getIndependentAssuranceManifest("FDUSD");

const FEB_2026_HREF =
  "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/69b8bb692133e7d22020f80a_FD121_(BVI)_-_ISAE3000_Attestation_Report_on_Reserves_Account_(Feb_2026)_(FINAL).pdf";
const SEP_2025_HREF =
  "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/68f09f623c0571b23acecbcc_ISAE3000_-_Attestion_Report_on_Reserves_Account_(Sept_2025)_Final.pdf";


// Webflow CDN cohort: the June signed-image report (no ISAE 3000 marker) and a
// whitepaper handout carrying an ISAE 3000 label must both stay out of the
// candidate set; only the reviewed August AOGB report may remain.
const OFF_COHORT_LINKS = `
  <a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/6a55fa1246d16025bd7f7d87_FDUSD%20Reserve%20accounts%20Report_JUN%202026%20(signed%20by%20Accountant).pdf">June 2026</a>
  <a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/FDUSD-ISAE3000-Whitepaper-July-2026.pdf">Whitepaper</a>
`;

function indexHtml(extra = ""): string {
  return `
    ${OFF_COHORT_LINKS}
    <a href="${reviewed.reportUrl}">ISAE 3000 Attestation Report August 2026</a>
    ${extra}
  `;
}


describe("fdusd-independent-assurance (AOGB ISAE 3000 limited assurance)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reconciles the August 2026 report across every native FDUSD chain", () => {
    expect(reviewed.assuranceTier).toBe("independent-assurance");
    expect(reviewed.attestor).toBe("AOGB CPA Limited");
    expect(reviewed.reportAsOf).toBe("2026-08-31T21:00:00-04:00");
    expect(reviewed.reportDate).toBe("2026-08-31");
    const reconciliation = reconcileIndependentAssuranceManifest(reviewed);
    expect(reconciliation).toMatchObject({
      computedAssetTotal: "336969677.04",
      liabilityTotal: "335636418.35",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(reconciliation.collateralizationRatio).toBeCloseTo(336969677.04 / 335636418.35, 12);
    for (const chain of ["ethereum", "bsc", "sui", "solana", "arbitrum", "ton"]) {
      expect(
        reviewed.liabilities.some((row) => row.code === chain && Number(row.amount) > 0),
        `missing positive ${chain} liability row`,
      ).toBe(true);
    }
    // The liability chain set sums to the reported total exactly; dropping any
    // chain (here TON) must fail the reconciliation.
    expect(reconciliation.liabilityTotal).toBe("335636418.35");
    expect(() =>
      reconcileIndependentAssuranceManifest({
        ...reviewed,
        liabilities: reviewed.liabilities.filter((row) => row.code !== "ton"),
      }),
    ).toThrow("liability total 335635330.7 does not match manifest 335636418.35");
  });

  it("measures freshness from the examined instant, 25h past the 00:00Z misdate", () => {
    const timestamp = independentAssuranceSourceTimestamp(reviewed);
    expect(timestamp).toBe(Date.parse("2026-09-01T01:00:00Z") / 1000);
    expect(timestamp - Date.parse("2026-08-31T00:00:00Z") / 1000).toBe(25 * 3_600);
  });

  it("keeps maturity dates out of the Treasury slice label", () => {
    expect(FDUSD_INDEPENDENT_ASSURANCE_PROFILE.classifications["treasury-bills"].name).toBe(
      "U.S. Treasury Bills",
    );
  });


  it("dates every row of the live Webflow index, including underscore-separated CDN filenames", async () => {
    // Regression: the live index pairs "(Feb_2026)" and "(Sept_2025)" filenames
    // with "(July 2026)"-style names, and the fence reads an undated candidate as
    // proof the index changed shape, so a missed underscore separator errored the
    // whole sync instead of publishing the reviewed August report.
    expect(FDUSD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate?.(FEB_2026_HREF, "Download")).toBe(
      "2026-02-28",
    );
    expect(FDUSD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate?.(SEP_2025_HREF, "Download")).toBe(
      "2025-09-30",
    );
    await expect(verifyFixtureIndex(
      "FDUSD", FDUSD_INDEPENDENT_ASSURANCE_PROFILE, "fdusd-independent-assurance.html",
    )).rejects.toThrow(`PDF byte length ${PDF_BYTES.length} does not match reviewed ${reviewed.reportByteLength}`);
  });

  it("derives the report month only from the reviewed CDN filename convention", () => {
    expect(FDUSD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate?.(
      FEB_2026_HREF,
      "ISAE 3000 Attestation Report August 2026",
    )).toBe("2026-02-28");
    expect(FDUSD_INDEPENDENT_ASSURANCE_PROFILE.reportDateFromCandidate?.(
      "https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/ISAE3000-attestation-report.pdf",
      "ISAE 3000 Attestation Report August 2026",
    )).toBeNull();
  });


  it("rejects an ISAE 3000 candidate whose report month cannot be derived", async () => {
    const html = indexHtml(
      '<a href="https://cdn.prod.website-files.com/675ab99bf1f7ea944d49a55b/ISAE3000-attestation-report.pdf">Latest</a>',
    );
    await expect(verifyFixtureIndex(
      "FDUSD", FDUSD_INDEPENDENT_ASSURANCE_PROFILE, "fdusd-independent-assurance.html", html,
    )).rejects.toThrow("ambiguous report date");
  });

  it("validates the bound coin through real index, PDF and reconciliation checks", async () => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === "fdusd-first-digital");
    if (!coin?.liveReservesConfig) throw new Error("missing FDUSD config");
    vi.spyOn(assurance, "getIndependentAssuranceManifest").mockReturnValue({
      ...reviewed,
      reportByteLength: PDF_BYTES.length,
      reportSha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
    });
    installFetch("FDUSD", indexHtml());
    const adapter = getReserveAdapter("fdusd-independent-assurance")!;
    const result = await adapter.fetch(coin, coin.liveReservesConfig, new AbortController().signal);
    expect(result.slices).toHaveLength(3);
    expect(result.slices.map((slice) => slice.sourceKey)).toEqual(expect.arrayContaining([
      "fdusd-independent-assurance:fdusd:treasury-bills",
      "fdusd-independent-assurance:fdusd:fixed-deposits",
      "fdusd-independent-assurance:fdusd:custody-cash",
    ]));
    expect(result.slices.reduce((total, slice) => total + slice.pct, 0)).toBeCloseTo(100, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(336969677.04 / 335636418.35, 12);
    expect(result.metadata?.sourceTimestamp).toBe(independentAssuranceSourceTimestamp(reviewed));
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(validateAdapterOutput(
      result,
      { adapter, now: independentAssuranceSourceTimestamp(reviewed) + 60 },
    ).valid).toBe(true);
  });
});
