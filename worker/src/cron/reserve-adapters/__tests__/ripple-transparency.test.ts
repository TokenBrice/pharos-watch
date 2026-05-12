import { describe, expect, it } from "vitest";
import { adaptRippleTransparency } from "../ripple-transparency";

const RIPPLE_HTML = `
<h5>Total Circulating RLUSD</h5>
<p>$1,443.7M</p>
<h5>RLUSD Reserve Funds</h5>
<p>$1,546.6M</p>
<p>As of <!-- -->04/30/2026</p>
`;

describe("adaptRippleTransparency", () => {
  it("parses RLUSD reserves and source timestamp", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML);

    expect(result.slices).toEqual([
      {
        name: "U.S. dollars and other cash equivalents",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.metadata).toMatchObject({
      circulatingUsd: 1_443_700_000,
      reservesUsd: 1_546_600_000,
      collateralizationRatio: 1_546_600_000 / 1_443_700_000,
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 3, 30) / 1000,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("emits a degraded warning when reserves do not cover supply", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML.replace("$1,546.6M", "$900.0M"));

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
      }),
    ]);
  });

  it("throws when the source date is missing", () => {
    expect(() => adaptRippleTransparency(RIPPLE_HTML.replace("04/30/2026", ""))).toThrow(/layout-changed/);
  });
});
