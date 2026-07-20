import { describe, expect, it } from "vitest";
import { adaptRippleTransparency, parseRippleReserveBreakdown } from "../ripple-transparency";

const RIPPLE_HTML = `
<h5>Total Circulating RLUSD</h5>
<p>$1,443.7M</p>
<h5>RLUSD Reserve Funds</h5>
<p>$1,546.6M</p>
<p>As of <!-- -->04/30/2026</p>
`;

const RIPPLE_HTML_WITH_BREAKDOWN = `
<h5>Total Circulating RLUSD</h5>
<p>$1,443.7M</p>
<h5>RLUSD Reserve Funds</h5>
<p>$1,546.6M</p>
<p>As of <!-- -->04/30/2026</p>
<table>
<tr><td>U.S. Treasury bills</td><td>60.10%</td></tr>
<tr><td>Government money-market funds</td><td>25.20%</td></tr>
<tr><td>Cash and deposit accounts</td><td>14.70%</td></tr>
</table>
`;

describe("adaptRippleTransparency", () => {
  it("parses RLUSD reserves and source timestamp", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML);

    expect(result.metadata).toMatchObject({
      circulatingUsd: 1_443_700_000,
      reservesUsd: 1_546_600_000,
      collateralizationRatio: 1_546_600_000 / 1_443_700_000,
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 3, 30) / 1000,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("itemizes slices per the attested May 2026 composition when the payload lacks a breakdown", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML);

    expect(result.slices).toEqual([
      {
        name: "U.S. Treasury bills",
        pct: 65.41,
        risk: "very-low",
        assetClass: "treasury-bill",
        issuerOrObligor: "United States Treasury",
        riskFactors: ["duration", "liquidity", "custody"],
        liquidityHorizon: "one-day",
        maturityDaysMax: 92,
      },
      {
        name: "Government money-market funds",
        pct: 19.44,
        risk: "very-low",
        assetClass: "money-market-fund",
        issuerOrObligor: "DFS-approved government money-market funds",
        riskFactors: ["counterparty", "liquidity", "custody"],
        liquidityHorizon: "one-day",
      },
      {
        name: "Cash and deposit accounts",
        pct: 15.15,
        risk: "very-low",
        assetClass: "bank-deposit",
        issuerOrObligor: "DFS-approved depository institutions",
        riskFactors: ["counterparty", "custody", "concentration"],
        liquidityHorizon: "immediate",
      },
    ]);
  });

  it("derives the split from the payload when it carries an asset-class breakdown", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML_WITH_BREAKDOWN);

    expect(result.slices.map((slice) => [slice.name, slice.pct])).toEqual([
      ["U.S. Treasury bills", 60.1],
      ["Government money-market funds", 25.2],
      ["Cash and deposit accounts", 14.7],
    ]);
  });

  it("falls back to the attested split when the payload breakdown does not reconcile", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML_WITH_BREAKDOWN.replace("60.10%", "30.10%"));

    expect(result.slices.map((slice) => slice.pct)).toEqual([65.41, 19.44, 15.15]);
  });

  it("falls back to the attested split when percentages are malformed numeric tokens", () => {
    const result = adaptRippleTransparency(
      RIPPLE_HTML_WITH_BREAKDOWN.replace("60.10%", "1060.10%")
        .replace("25.20%", "1025.20%")
        .replace("14.70%", "1014.70%"),
    );

    expect(result.slices.map((slice) => slice.pct)).toEqual([65.41, 19.44, 15.15]);
  });

  it("keeps the undercollateralization breaker on the aggregate ratio", () => {
    const result = adaptRippleTransparency(RIPPLE_HTML.replace("$1,546.6M", "$900.0M"));

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
      }),
    ]);
    expect(result.slices.map((slice) => slice.pct)).toEqual([65.41, 19.44, 15.15]);
  });

  it("throws when the source date is missing", () => {
    expect(() => adaptRippleTransparency(RIPPLE_HTML.replace("04/30/2026", ""))).toThrow(/layout-changed/);
  });
});

describe("parseRippleReserveBreakdown", () => {
  it("returns null when no class labels are present", () => {
    expect(parseRippleReserveBreakdown("Total Circulating RLUSD $1,443.7M")).toBeNull();
  });

  it("returns null when a class percentage is missing", () => {
    expect(parseRippleReserveBreakdown("U.S. Treasury bills 65.41%, Government money-market funds 19.44%")).toBeNull();
  });

  it("rejects percentage suffixes inside malformed numeric tokens", () => {
    expect(
      parseRippleReserveBreakdown(
        "U.S. Treasury bills 1060.10%, Government money-market funds 1025.20%, Cash and deposit accounts 1014.70%",
      ),
    ).toBeNull();
  });

  it("does not borrow the next class percentage when the labeled token is malformed", () => {
    expect(
      parseRippleReserveBreakdown(
        "U.S. Treasury bills 1060.10%, Government money-market funds 25.20%, Cash and deposit accounts 14.70%",
      ),
    ).toBeNull();
  });

  it("rejects over-precision percentages instead of parsing a valid-looking prefix", () => {
    expect(
      parseRippleReserveBreakdown(
        "U.S. Treasury bills 60.1000000%, Government money-market funds 25.20%, Cash and deposit accounts 14.70%",
      ),
    ).toBeNull();
  });
});
