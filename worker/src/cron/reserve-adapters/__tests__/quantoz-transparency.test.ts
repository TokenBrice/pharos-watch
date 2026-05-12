import { describe, expect, it } from "vitest";
import { adaptQuantozTransparency } from "../quantoz-transparency";

const QUANTOZ_HTML = `
<div class="text-style-tagline gradient-normal">UPDATED: April 20th, 2026</div>
<div>Reserve Status Overview</div>
<div role="row" class="table5_item">
  <div role="cell"><div class="text-weight-medium">EURQ</div></div>
  <div role="cell"><div>€3.881.707</div></div>
  <div role="cell"><div>100,20%</div></div>
  <div role="cell"><div><strong>30% / 70%</strong></div></div>
</div>
<div role="row" class="table5_item">
  <div role="cell"><div class="text-weight-medium">USDQ</div></div>
  <div role="cell"><div>$6.099.501</div></div>
  <div role="cell"><div>100,67%</div></div>
  <div role="cell"><div><strong>30% / 70%</strong></div></div>
</div>
`;

describe("adaptQuantozTransparency", () => {
  it("parses EURQ reserve composition and source timestamp", () => {
    const result = adaptQuantozTransparency(QUANTOZ_HTML, "EURQ");

    expect(result.slices).toEqual([
      { name: "Government bonds (Netherlands, Germany, and US)", pct: 70, risk: "very-low" },
      { name: "Cash deposits at Tier 1 European banks", pct: 30, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      token: "EURQ",
      totalSupply: 3_881_707,
      reserveRatioPct: 100.2,
      cashPct: 30,
      governmentBondPct: 70,
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 3, 20) / 1000,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("parses USDQ reserve composition and source timestamp", () => {
    const result = adaptQuantozTransparency(QUANTOZ_HTML, "USDQ");

    expect(result.metadata).toMatchObject({
      token: "USDQ",
      totalSupply: 6_099_501,
      reserveRatioPct: 100.67,
    });
  });

  it("emits a degraded warning when the reserve ratio is below threshold", () => {
    const result = adaptQuantozTransparency(QUANTOZ_HTML.replace("100,67%", "99,00%"), "USDQ");

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
      }),
    ]);
  });

  it("throws when the update timestamp is missing", () => {
    expect(() => adaptQuantozTransparency(QUANTOZ_HTML.replace("UPDATED: April 20th, 2026", ""), "EURQ"))
      .toThrow(/layout-changed/);
  });
});
