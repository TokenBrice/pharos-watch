import { describe, expect, it } from "vitest";
import felixMintAuthority from "../../data/stablecoins/domains/mint-authority/feusd-felix.json";
import usdkgReserves from "../../data/stablecoins/domains/reserves/usdkg-gold-dollar.json";
import usdkgMetadata from "../../data/stablecoins/coins/usdkg-gold-dollar.json";
import ejpyMetadata from "../../data/stablecoins/coins/ejpy-jbfd.json";
import usdcCompliance from "../../data/stablecoins/domains/compliance/usdc-circle.json";
import ousdMetadata from "../../data/stablecoins/coins/ousd-open-standard.json";
import ousdCompliance from "../../data/stablecoins/domains/compliance/ousd-open-standard.json";
import syrupUsdcMetadata from "../../data/stablecoins/coins/syrupusdc-maple.json";
import usd1Metadata from "../../data/stablecoins/coins/usd1-world-liberty-financial.json";
import usdtMetadata from "../../data/stablecoins/coins/usdt-tether.json";
import usdtReserves from "../../data/stablecoins/domains/reserves/usdt-tether.json";
import mechanismOverlays from "../../data/safety-score-v9/mechanism-review-overlays-v1.json";

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

  it("pins OUSD's pre-launch EY examination as scoped rather than current whole-token assurance", () => {
    const report = ousdMetadata.proofOfReserves.latestReport;
    expect(ousdMetadata.proofOfReserves.cadence).toBe("quarterly");
    expect(report).toMatchObject({
      periodEnd: "2026-08-31",
      liabilityReconciliation: "partial",
      confidence: "verified",
    });
    expect(report.reviewer).toContain("$40,690.16");
    expect(report.reviewer).toContain("0.0046%");
    expect(report.sources.map((source) => source.url)).toContain(
      "https://transparency.bridge.xyz/v0/stablecoins/ousd",
    );
    const overlay = mechanismOverlays.overlays.find((row) => row.assetId === "ousd-open-standard");
    expect(overlay?.components.assuranceAndReconciliation).toMatchObject({ quality: "limited" });
  });

  it("does not claim a published monthly attestation for OUSD's quarterly proof cadence", () => {
    // docs/genius-tracker.md: only a published attestation series supports
    // monthlyAttestationPresent; the single pre-launch EY examination and a
    // documented quarterly/optional engagement do not.
    expect(ousdMetadata.proofOfReserves.cadence).toBe("quarterly");
    expect(ousdCompliance.genius.monthlyAttestationPresent).toBe(false);
  });

  it("refreshes syrupUSDC's collateral dashboard pin and includes the third pool", () => {
    const report = syrupUsdcMetadata.proofOfReserves.latestReport;
    expect(report.reviewReference).toMatchObject({ date: "2026-10-30", reviewedAt: "2026-11-01" });
    expect(syrupUsdcMetadata.proofOfReserves.provider).toContain("syrupUSDG");
    expect(syrupUsdcMetadata.proofOfReserves.provider).toContain("$1,521.43M");
  });

  it("keeps USD1's liability-scope provenance on the same August report as its attestation pin", () => {
    const scope = usd1Metadata.liveReservesConfig.params.liabilityScope;
    expect(scope.reviewedAt).toBe("2026-10-01");
    expect(scope.evidenceRef).toContain("August 2026");
    expect(scope.evidenceRef).not.toContain("July 2026");
    expect(scope.evidenceRef).toContain("Canton");
  });

  it("pins USDT's Q3 2026 BDO composition and conserves its exact-dollar packet", () => {
    const report = usdtMetadata.proofOfReserves.latestReport;
    expect(report).toMatchObject({ periodEnd: "2026-09-30", publishedAt: "2026-10-30" });
    const packet = usdtMetadata.liveReservesConfig.params.reviewedComposition;
    expect(packet.asOf).toBe("2026-09-30");
    expect(packet.totalAssetsUsd).toBe(191451091374);
    expect(packet.rows.reduce((sum, row) => sum + row.dollars, 0)).toBe(packet.totalAssetsUsd);
    expect(usdtReserves.reserveReview.compositionAsOf).toBe("2026-09-30");
    const bitcoin = usdtReserves.reserves.find((row) => row.sourceKey === "tether:usdt:bitcoin");
    expect(bitcoin?.pct).toBe(4.370396);
    const disposition = usdtReserves.reserveReview.nonLinkDispositions.find(
      (row) => row.reserveName === "Bitcoin",
    );
    expect(disposition?.pct).toBe(bitcoin?.pct);
  });
});
