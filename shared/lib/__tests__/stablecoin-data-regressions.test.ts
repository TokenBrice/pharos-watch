import { describe, expect, it } from "vitest";
import felixMintAuthority from "../../data/stablecoins/domains/mint-authority/feusd-felix.json";
import usdkgReserves from "../../data/stablecoins/domains/reserves/usdkg-gold-dollar.json";

describe("stablecoin source-data regressions", () => {
  it("marks every Felix BorrowerOperations debt cap as admin-mutable", () => {
    const borrowerOperations = felixMintAuthority.mintAuthority.controls.filter((control) =>
      control.label.endsWith("BorrowerOperations"),
    );

    expect(borrowerOperations).toHaveLength(4);
    for (const control of borrowerOperations) {
      expect(control.capDescription).toMatch(/admin can raise that cap/i);
      expect(control.canRaiseCap, control.label).toBe(true);
    }
  });

  it("keeps USDKG physical gold on the active reserve-risk rubric", () => {
    const physicalGold = usdkgReserves.reserves.find((reserve) => reserve.name.startsWith("Physical gold"));

    expect(physicalGold).toMatchObject({ pct: 100, risk: "very-low" });
    expect(physicalGold?.riskFactors).toEqual(
      expect.arrayContaining(["market", "custody", "counterparty", "legal", "liquidity", "concentration"]),
    );
    // Lockstep pin: composition is anchored to the 2025-11-28 Kreston AUP that
    // latestReport records, not the later live transparency-page read.
    expect(usdkgReserves.reserveReview.compositionAsOf).toBe("2025-11-28");
  });
});
