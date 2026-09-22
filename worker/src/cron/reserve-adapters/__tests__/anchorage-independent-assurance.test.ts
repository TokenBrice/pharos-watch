import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { USDPT_INDEPENDENT_ASSURANCE_PROFILE } from "../anchorage-independent-assurance";
import { verifyFixtureIndex } from "./independent-assurance.test-support";


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
    await expect(verifyFixtureIndex(
      "USDPT", USDPT_INDEPENDENT_ASSURANCE_PROFILE, "anchorage-independent-assurance.html", html,
    )).rejects.toThrow("PDF byte length");

    const newer = html.replace(
      "</div>",
      '<a href="https://learn.anchorage.com/08.31.26_USDPT-Stablecoin-Attestation-Report.pdf">Aug</a></div>',
    );
    await expect(verifyFixtureIndex(
      "USDPT", USDPT_INDEPENDENT_ASSURANCE_PROFILE, "anchorage-independent-assurance.html", newer,
    )).rejects.toThrow("newer unreviewed report");
  });

});
