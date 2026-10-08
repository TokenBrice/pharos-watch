import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import {
  getAuthoredDefaultFlagIssues,
  getCommodityProtocolSlugIssue,
  getCommodityAllocatedPegMatchIssues,
  getDependencyReserveOverlapIssues,
  getReservePublicLabelIssues,
  getReserveDependencyTypeLinkIssues,
  getLiveReserveDependencyTypeLinkIssues,
  getListingGovernanceIssues,
  getTerminalLiveReserveConfigIssue,
  getExpiredReserveSupplyAdmissionBootstrapIssue,
} from "../ci/check-stablecoin-data";

describe("terminal live-reserve binding gate", () => {
  const config: NonNullable<StablecoinMeta["liveReservesConfig"]> = {
    adapter: "jpmorgan-nav", version: 1, semantics: "single-asset",
    inputs: { primary: { kind: "http-html", url: "https://example.com/nav" } },
  };
  it("rejects an authored bootstrap from UTC start of its review deadline until removed or re-authorized", () => {
    const authorized = { liveReservesConfig: { ...config, bootstrapForSupplyAdmission: { reviewBy: "2026-10-10" } } };
    expect(getExpiredReserveSupplyAdmissionBootstrapIssue(authorized, Date.parse("2026-10-09T23:59:59Z"))).toBeNull();
    expect(getExpiredReserveSupplyAdmissionBootstrapIssue(authorized, Date.parse("2026-10-10T00:00:00Z"))).not.toBeNull();
    expect(getExpiredReserveSupplyAdmissionBootstrapIssue(authorized, Date.parse("2026-10-11T00:00:00Z"))).not.toBeNull();
    expect(getExpiredReserveSupplyAdmissionBootstrapIssue({ liveReservesConfig: config }, Date.parse("2026-10-11T00:00:00Z"))).toBeNull();
    expect(getExpiredReserveSupplyAdmissionBootstrapIssue({
      liveReservesConfig: { ...config, bootstrapForSupplyAdmission: { reviewBy: "2026-11-10" } },
    }, Date.parse("2026-10-11T00:00:00Z"))).toBeNull();
    expect(getExpiredReserveSupplyAdmissionBootstrapIssue({})).toBeNull();
  });
  it.each(["frozen", "delisted"] as const)("rejects unsuspended %s bindings but retains archived evidence", (status) => {
    expect(getTerminalLiveReserveConfigIssue({ status, liveReservesConfig: config })).not.toBeNull();
    expect(getTerminalLiveReserveConfigIssue({ status })).toBeNull();
    expect(getTerminalLiveReserveConfigIssue({ status, liveReservesConfig: {
      ...config, suspended: { since: "2026-10-07", reason: "operator hold" },
    } })).toBeNull();
  });
  it.each(["active", "quarantined", "pre-launch"] as const)("allows %s research/producer bindings", (status) => {
    expect(getTerminalLiveReserveConfigIssue({ status, liveReservesConfig: config })).toBeNull();
  });
});

describe("authored linked reserve type gate", () => {
  it("rejects a missing type without rejecting typed or unlinked holdings", () => {
    const reserves = [
      { name: "Untyped USDC", pct: 40, risk: "low" as const, coinId: "usdc-circle" },
      { name: "Typed USDT", pct: 40, risk: "low" as const, coinId: "usdt-tether", depType: "collateral" as const },
      { name: "Cash", pct: 20, risk: "low" as const },
    ];
    expect(getReserveDependencyTypeLinkIssues({ reserves })).toHaveLength(1);
    expect(getReserveDependencyTypeLinkIssues({ reserves: [{ ...reserves[0], depType: "collateral" }, ...reserves.slice(1)] })).toEqual([]);
  });

  it("requires reviewed type and identity pairs in nested live declarations", () => {
    expect(getLiveReserveDependencyTypeLinkIssues({ assets: [
      { coinId: "usdc-circle" },
      { coinId: "usdt-tether", depType: "guessed" },
      { depType: "collateral" },
      { coinId: "dai-maker", depType: "mechanism" },
      { name: "Cash" },
    ] })).toEqual([
      "liveReservesConfig.params.assets[0].coinId requires a valid depType declaration",
      "liveReservesConfig.params.assets[1].coinId requires a valid depType declaration",
      "liveReservesConfig.params.assets[2].depType requires a coinId declaration",
    ]);
    expect(getLiveReserveDependencyTypeLinkIssues({
      asset: { coinId: "usdc-circle", depType: "collateral" },
    })).toEqual([]);
  });
});

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

  it.each(["control-operator", "exit-dependency", "oracle-nav"] as const)(
    "allows a sourced %s anchor alongside the reserve-owned basket",
    (economicRole) => {
      expect(getDependencyReserveOverlapIssues({
        dependencies: [{ id: "usdtb-ethena", weight: 0.001, type: "collateral" }],
        reserves: [{
          name: "USDtb backing", pct: 30, risk: "low", coinId: "usdtb-ethena", depType: "collateral",
        }],
        dependencyReview: {
          reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified",
          sources: [{ label: "Issuer rails", url: "https://example.com/rails" }],
          rationale: "The role is separate from the backing allocation.",
          relationships: [{
            id: "usdtb-ethena", weight: 0.001, type: "collateral", economicRole,
            reason: "Reviewed distinct role.",
          }],
        },
      })).toEqual([]);
    },
  );

  it("does not exempt an explicitly reviewed default-role collateral duplicate", () => {
    expect(getDependencyReserveOverlapIssues({
      dependencies: [{ id: "usdtb-ethena", weight: 0.001, type: "collateral" }],
      reserves: [{
        name: "USDtb backing", pct: 30, risk: "low", coinId: "usdtb-ethena", depType: "collateral",
      }],
      dependencyReview: {
        reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified",
        sources: [{ label: "Issuer backing", url: "https://example.com/backing" }],
        rationale: "Redundant backing claim.",
        relationships: [{
          id: "usdtb-ethena", weight: 0.001, type: "collateral", economicRole: "basket-exposure",
          reason: "The reserve already owns this exposure.",
        }],
      },
    })).toEqual([
      "usdtb-ethena::collateral is authored in both dependencies and linked reserves; keep reserve-backed relationships only in reserves",
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

describe("listing class during unresolved mechanism review", () => {
  const coin: StablecoinMeta = {
    id: "fixture-usd",
    name: "Fixture USD",
    symbol: "FUSD",
    flags: {
      backing: "crypto-backed",
      governance: "centralized-dependent",
      pegCurrency: "USD",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
  };
  const decisions = {
    schemaVersion: 1,
    policyVersion: "fixture",
    listingClassById: { "fixture-usd": "stable-value-investment" },
  };
  const review: NonNullable<StablecoinMeta["mechanismArchetypeReview"]> = {
    disposition: "unresolved",
    reviewedAt: "2026-10-03",
    reviewer: "Fixture reviewer",
    rationale: "Exact-token identity and holder claim remain unverified.",
    sources: [{ label: "Issuer disclosure", url: "https://example.com/token" }],
  };

  it("holds the non-core ledger class while a sourced dated review is unresolved", () => {
    expect(getListingGovernanceIssues([{ ...coin, mechanismArchetypeReview: review }], decisions)).toEqual([]);
  });

  it.each(["core-stablecoin", "cash-equivalent"])("rejects unjustified %s promotion during unresolved review", (listingClass) => {
    expect(getListingGovernanceIssues([{ ...coin, mechanismArchetypeReview: review }], {
      ...decisions, listingClassById: { [coin.id]: listingClass },
    })).toContain(`listing-decisions.json class for "fixture-usd" is ${listingClass}; expected stable-value-investment`);
    expect(getListingGovernanceIssues([{ ...coin, variantOf: "usdc-circle", mechanismArchetypeReview: review }], {
      ...decisions, listingClassById: { [coin.id]: listingClass },
    })).toContain(`listing-decisions.json class for "fixture-usd" is ${listingClass}; expected stablecoin-variant`);
  });

  it("retains known NAV precedence during unresolved review", () => {
    expect(getListingGovernanceIssues([{ ...coin, flags: { ...coin.flags, navToken: true }, mechanismArchetypeReview: review }], {
      ...decisions, listingClassById: { [coin.id]: "cash-equivalent" },
    })).toEqual([]);
  });

  it("resumes normal core precedence once the review is resolved without an archetype", () => {
    const resolvedCoin = { ...coin, mechanismArchetypeReview: { ...review, disposition: "resolved" as const } };
    expect(getListingGovernanceIssues([resolvedCoin], decisions)).toEqual([
      'listing-decisions.json class for "fixture-usd" is stable-value-investment; expected core-stablecoin',
    ]);
    expect(getListingGovernanceIssues([resolvedCoin], {
      ...decisions, listingClassById: { "fixture-usd": "core-stablecoin" },
    })).toEqual([]);
  });

  it.each([
    { ...review, reviewedAt: "not-a-date" },
    { ...review, sources: [] },
    { ...review, sources: [{ label: "Invalid source", url: "not-a-url" }] },
  ])("does not hold a class on invalid review provenance", (invalidReview) => {
    expect(getListingGovernanceIssues([{ ...coin, mechanismArchetypeReview: invalidReview }], decisions)).toEqual([
      'listing-decisions.json class for "fixture-usd" is stable-value-investment; expected core-stablecoin',
    ]);
  });

  it("keeps delisting precedence and does not admit active excluded rows through the hold", () => {
    expect(getListingGovernanceIssues([{
      ...coin, status: "delisted", mechanismArchetypeReview: review,
    }], { ...decisions, listingClassById: { "fixture-usd": "excluded" } })).toEqual([]);
    expect(getListingGovernanceIssues([{
      ...coin, mechanismArchetypeReview: review,
    }], { ...decisions, listingClassById: { "fixture-usd": "excluded" } })).toContain(
      'listing-decisions.json marks non-delisted "fixture-usd" as excluded',
    );
  });
});
