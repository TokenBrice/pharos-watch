import { describe, it, expect } from "vitest";
import { adaptTetherTransparency, type TetherTransparencyResponse } from "../tether";

const SAMPLE: TetherTransparencyResponse = {
  data: {
    usdt: {
      total_assets: "145000000000",
      total_liabilities: "144500000000",
      shareholder_eq: "500000000",
    },
  },
};

describe("adaptTetherTransparency", () => {
  it("returns a single attestation slice", () => {
    const result = adaptTetherTransparency(SAMPLE);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0]).toMatchObject({
      name: "Issuer-attested reserves (coarse composition undisclosed in this feed)",
      risk: "medium",
    });
  });

  it("includes collateralization metadata", () => {
    const result = adaptTetherTransparency(SAMPLE);
    expect(result.metadata?.totalAssetsUsd).toBe(145_000_000_000);
    expect(result.metadata?.totalLiabilitiesUsd).toBe(144_500_000_000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.00346, 4);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "issuer-transparency-api",
      },
    });
  });

  it("throws on missing usdt data", () => {
    expect(() => adaptTetherTransparency({ data: {} } as TetherTransparencyResponse)).toThrow();
  });

  it("throws when total_assets is zero or negative (parse-failure guard)", () => {
    expect(() =>
      adaptTetherTransparency({
        data: {
          usdt: {
            total_assets: "0",
            total_liabilities: "100",
            shareholder_eq: "0",
          },
        },
      }),
    ).toThrow(/invalid or zero/);

    expect(() =>
      adaptTetherTransparency({
        data: {
          usdt: {
            total_assets: "not-a-number",
            total_liabilities: "100",
            shareholder_eq: "0",
          },
        },
      }),
    ).toThrow();
  });

  it("accepts numeric (non-string) fields", () => {
    const result = adaptTetherTransparency({
      data: {
        usdt: {
          total_assets: 100,
          total_liabilities: 50,
          shareholder_eq: 50,
        },
      },
    } as TetherTransparencyResponse);
    expect(result.metadata?.totalAssetsUsd).toBe(100);
    expect(result.metadata?.collateralizationRatio).toBe(2);
  });

  it("always reports unverified freshness (no source timestamp in payload)", () => {
    const result = adaptTetherTransparency(SAMPLE);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });
});
