import { describe, expect, it } from "vitest";
import felixMintAuthority from "../../data/stablecoins/domains/mint-authority/feusd-felix.json";
import usdkgReserves from "../../data/stablecoins/domains/reserves/usdkg-gold-dollar.json";
import usdkgMetadata from "../../data/stablecoins/coins/usdkg-gold-dollar.json";
import ejpyMetadata from "../../data/stablecoins/coins/ejpy-jbfd.json";
import usdcCompliance from "../../data/stablecoins/domains/compliance/usdc-circle.json";

describe("stablecoin source-data regressions", () => {
  it("marks every Felix BorrowerOperations debt cap as admin-mutable", () => {
    const borrowerOperations = felixMintAuthority.mintAuthority.controls.filter((control) =>
      control.label.endsWith("BorrowerOperations"),
    );

    expect(borrowerOperations).toHaveLength(4);
    for (const control of borrowerOperations) {
      expect(control.canRaiseCap, control.label).toBe(true);
    }
  });

  it("keeps USDKG physical gold on the active reserve-risk rubric", () => {
    const physicalGold = usdkgReserves.reserves.find((reserve) => reserve.name.startsWith("Physical gold"));

    expect(physicalGold).toMatchObject({ pct: 100, risk: "very-low" });
    expect(physicalGold?.riskFactors).toEqual(
      expect.arrayContaining(["market", "custody", "counterparty", "legal", "liquidity", "concentration"]),
    );
    expect(usdkgReserves.reserveReview.compositionAsOf).toBe(usdkgMetadata.proofOfReserves.latestReport.periodEnd);
  });

  it("binds USDC's EBA significance designation to the exact European issuer without changing authorization", () => {
    expect(usdcCompliance.mica).toMatchObject({
      status: "authorized",
      tokenType: "EMT",
      authorizationType: "emi",
      competentAuthority: "ACPR",
      authorizedEntity: "Circle Internet Financial Europe SAS",
      significant: true,
    });
    expect(usdcCompliance.mica.references).toContainEqual({
      label: "EBA: USDC classified as a significant EMT on October 14, 2026; dual supervision announced to begin November 12, 2026 (official text via search index, accessed October 26, 2026)",
      url: "https://www.eba.europa.eu/publications-and-media/press-releases/eba-classifies-usdc-first-significant-e-money-token-european-union",
    });
  });

  it("keeps EJPY's fiscal-year target as prose instead of a calendar-year date", () => {
    expect(ejpyMetadata).toMatchObject({ status: "pre-launch", launchPhase: "announced", announcedDate: "2026-05" });
    expect("expectedLaunchDate" in ejpyMetadata).toBe(false);
    expect("dateHistory" in ejpyMetadata).toBe(false);
    expect(ejpyMetadata.launchPhaseDetail).toContain("within FY2026 (through March 2027)");
    expect(ejpyMetadata.milestones[0].sourceUrl).toBe("https://www.jbfd.org/news/joc-ejpy");
  });
});
