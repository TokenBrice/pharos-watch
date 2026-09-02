import { describe, expect, it } from "vitest";
import {
  getAuthoredDefaultFlagIssues,
  getCommodityProtocolSlugIssue,
  getCommodityAllocatedPegMatchIssues,
  getDependencyReserveOverlapIssues,
  getReservePublicLabelIssues,
} from "../ci/check-stablecoin-data";

describe("stablecoin source flag default omission", () => {
  it("flags authored schema defaults", () => {
    expect(
      getAuthoredDefaultFlagIssues({
        flags: {
          backing: "crypto-backed",
          pegCurrency: "USD",
          governance: "centralized",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      }),
    ).toEqual([
      'flags.pegCurrency sets the schema default "USD"; omit this key from the source file',
      "flags.yieldBearing sets the schema default false; omit this key from the source file",
      "flags.rwa sets the schema default false; omit this key from the source file",
      "flags.navToken sets the schema default false; omit this key from the source file",
    ]);
  });

  it("allows non-default authored flag values", () => {
    expect(
      getAuthoredDefaultFlagIssues({
        flags: {
          backing: "crypto-backed",
          pegCurrency: "EUR",
          governance: "centralized",
          yieldBearing: true,
          rwa: true,
          navToken: true,
        },
      }),
    ).toEqual([]);
  });
});

describe("commodity protocol identity guard", () => {
  const flags = {
    backing: "rwa-backed",
    pegCurrency: "GOLD",
    governance: "centralized",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  } as never;

  it("flags a commodity protocol umbrella slug", () => {
    const issue = getCommodityProtocolSlugIssue({
      id: "vnxau-vnx",
      name: "VNX Gold",
      symbol: "VNXAU",
      flags,
      protocolSlug: "vnx",
    } as never);

    expect(issue).toContain("non-dedicated protocolSlug");
    expect(issue).toContain("vnx");
  });

  it("accepts the dedicated Tether Gold protocol slug", () => {
    expect(getCommodityProtocolSlugIssue({ flags, protocolSlug: "tether-gold" } as never)).toBeNull();
  });
});

describe("stablecoin dependency/reserve source ownership", () => {
  it("allows manual and reserve-derived relationships to coexist when their keys differ", () => {
    expect(
      getDependencyReserveOverlapIssues({
        dependencies: [{ id: "usdc-circle", weight: 0.2, type: "mechanism" }],
        reserves: [
          {
            name: "USDC collateral",
            pct: 100,
            risk: "very-low",
            coinId: "usdc-circle",
            depType: "collateral",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects a relationship duplicated across dependencies and linked reserves", () => {
    expect(
      getDependencyReserveOverlapIssues({
        dependencies: [{ id: "usdc-circle", weight: 1, type: "collateral" }],
        reserves: [
          {
            name: "USDC collateral",
            pct: 100,
            risk: "very-low",
            coinId: "usdc-circle",
            depType: "collateral",
          },
        ],
      }),
    ).toEqual([
      "usdc-circle::collateral is authored in both dependencies and linked reserves; " +
        "keep reserve-backed relationships only in reserves",
    ]);
  });
});

describe("commodity-allocated peg-match guard", () => {
  const goldRow = {
    name: "Allocated gold bars",
    pct: 100,
    risk: "very-low",
    assetClass: "commodity-allocated",
  } as never;
  const flagsFor = (pegCurrency: string) =>
    ({ backing: "rwa", pegCurrency, governance: "centralized", yieldBearing: false, rwa: true, navToken: false }) as never;

  it("admits commodity-allocated rows only on metal pegs", () => {
    expect(
      getCommodityAllocatedPegMatchIssues({ flags: flagsFor("GOLD"), reserves: [goldRow] }),
    ).toEqual([]);
    expect(
      getCommodityAllocatedPegMatchIssues({ flags: flagsFor("SILVER"), reserves: [goldRow] }),
    ).toEqual([]);
  });

  it("rejects commodity-allocated rows on non-metal pegs (usdkg class)", () => {
    const issues = getCommodityAllocatedPegMatchIssues({ flags: flagsFor("USD"), reserves: [goldRow] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("commodity-allocated");
    expect(issues[0]).toContain("USD");
  });
});

describe("reserve public-label guard", () => {
  it("keeps reserve names within the Safety Score V9 backing component label limit", () => {
    expect(
      getReservePublicLabelIssues({
        reserves: [
          {
            name: "A".repeat(160),
            pct: 100,
            risk: "low",
          },
        ],
      } as never),
    ).toEqual([]);

    const issues = getReservePublicLabelIssues({
      reserves: [
        {
          name: ` ${"A".repeat(161)} `,
          pct: 100,
          risk: "low",
        },
      ],
    } as never);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("is 161 characters");
    expect(issues[0]).toContain("capped at 160 characters");
  });
});
