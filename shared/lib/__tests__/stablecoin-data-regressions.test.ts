import { describe, expect, it } from "vitest";
import felixAsset from "../../data/stablecoins/coins/feusd-felix.json";
import usdkgAsset from "../../data/stablecoins/coins/usdkg-gold-dollar.json";

describe("stablecoin source-data regressions", () => {
  it("marks every Felix BorrowerOperations debt cap as admin-mutable", () => {
    const borrowerOperations = felixAsset.mintAuthority.controls.filter((control) =>
      control.label.endsWith("BorrowerOperations"),
    );

    expect(borrowerOperations).toHaveLength(4);
    for (const control of borrowerOperations) {
      expect(control.capDescription).toMatch(/admin can raise that cap/i);
      expect(control.canRaiseCap, control.label).toBe(true);
    }
  });

  it("keeps USDKG physical gold on the active reserve-risk rubric", () => {
    const physicalGold = usdkgAsset.reserves.find((reserve) => reserve.name.startsWith("Physical gold"));

    expect(physicalGold).toMatchObject({ pct: 100, risk: "very-low" });
    expect(physicalGold?.riskFactors).toEqual(
      expect.arrayContaining(["market", "custody", "counterparty", "legal", "liquidity", "concentration"]),
    );
    expect(usdkgAsset.reserveReview.compositionAsOf).toBe("2025-11-28");
  });
});
