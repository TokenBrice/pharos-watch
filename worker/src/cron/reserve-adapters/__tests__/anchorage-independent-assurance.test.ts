import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { USDPT_INDEPENDENT_ASSURANCE_PROFILE } from "../anchorage-independent-assurance";
import { verifyFixtureIndex } from "./independent-assurance.test-support";


afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anchorage-independent-assurance (Deloitte Anchorage examinations)", () => {
  it("reconciles August reserves with both chain redeemable liabilities", () => {
    const manifest = getIndependentAssuranceManifest("USAT");
    expect(manifest.assuranceTier).toBe("independent-assurance");
    expect(manifest.conclusion).toBe("unmodified");
    expect(manifest.attestor).toBe("Deloitte & Touche LLP");
    expect(manifest.attestorIdentification).toMatchObject({
      method: "reviewed-inference",
      evidence: [expect.any(String), expect.any(String)],
      reReviewTrigger: expect.any(String),
    });
    expect(manifest.reportAsOf).toBe("2026-08-31T23:59:59Z");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "176391828",
      liabilityTotal: "175731350",
      reportedAssetDifference: "0",
      reportedLiabilityDifference: "0",
    });
    expect(manifest.liabilities).toEqual([
      { code: "ethereum", label: "Ethereum USAT redeemable tokens", amount: "175534959" },
      { code: "celo", label: "Celo USAT redeemable tokens", amount: "196391" },
    ]);
    expect(manifest.assets).toEqual([
      { code: "cash", label: "Cash", amount: "17477828" },
      { code: "reverse-repo", label: "Reverse repurchase agreements collateralized by U.S. Treasury securities, at fair value", amount: "158914000" },
    ]);
  });

  it("declares the independent-assurance descriptor for the AICPA examination", () => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS["anchorage-independent-assurance"];
    expect(definition.evidenceClass).toBe("independent");
    expect(definition.sourceOriginClass).toBe("independent-assurance");
  });




  it("selects the reviewed USDPT report on the USDPT index and fails closed on a newer unreviewed report", async () => {
    const reviewed = getIndependentAssuranceManifest("USDPT");
    const html =
      '<div class="accordion-dates-grid">' +
      '<a href="https://learn.anchorage.com/05.31.26_USDPT_Stablecoin_Attestation_Report_signed.pdf">May</a>' +
      '<a href="https://learn.anchorage.com/06.30.26_USDPT-Stablecoin-Attestation-Report.pdf">Jun</a>' +
      `<a href="${reviewed.reportUrl}">Aug</a>` +
      "</div>";
    await expect(verifyFixtureIndex(
      "USDPT", USDPT_INDEPENDENT_ASSURANCE_PROFILE, "anchorage-independent-assurance.html", html,
    )).rejects.toThrow("PDF byte length");

    const newer = html.replace(
      "</div>",
      '<a href="https://learn.anchorage.com/09.30.26_USDPT-Stablecoin-Attestation-Report.pdf">Sep</a></div>',
    );
    await expect(verifyFixtureIndex(
      "USDPT", USDPT_INDEPENDENT_ASSURANCE_PROFILE, "anchorage-independent-assurance.html", newer,
    )).rejects.toThrow("newer unreviewed report");
  });

});
