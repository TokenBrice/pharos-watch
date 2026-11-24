import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  computeLiveReserveConfigFingerprint,
  isReserveSupplyAdmissionBootstrapAuthorized,
} from "@shared/lib/live-reserve-adapters";
import {
  getCollidingSymbolContractIssues,
  getCommodityProtocolSlugIssue,
  getContractDeploymentIssues,
  getCrossCoinDeploymentCollisionIssues,
  getCommodityAllocatedPegMatchIssues,
  getDependencyReserveOverlapIssues,
  getRemovedStablecoinRedirectIssues,
  getReservePublicLabelIssues,
  getReserveDependencyTypeLinkIssues,
  getLiveReserveDependencyTypeLinkIssues,
  getListingGovernanceIssues,
  getUnlinkedActiveTokenizedFundWarnings,
  REVIEWED_LIVE_ADAPTER_ONLY_TOKENIZED_FUND_LINKS,
  getTerminalLiveReserveConfigIssue,
  getExpiredReserveSupplyAdmissionBootstrapIssue,
  getOverdueListingStatusReviewIssue,
  getPegRuntimeSupportIssue,
} from "../ci/check-stablecoin-data";

describe("OTHER promotion gate", () => {
  it.each([
    ["pre-launch", false, null],
    ["active", false, expect.stringContaining("independent same-unit reference")],
    ["active", true, null],
  ] as const)("checks %s OTHER listings with navToken=%s", (status, navToken, expected) => {
    const { flags } = TRACKED_META_BY_ID.get("sekau-allunity")!;
    expect(getPegRuntimeSupportIssue({ status, flags: { ...flags, navToken } })).toEqual(expected);
  });
});

describe("per-coin deployment identity gate", () => {
  it("retains duplicate rejection across primary/traded arrays without folding native identity case", () => {
    const deployment = { chain: "ethereum", address: "0xabcdef0000000000000000000000000000000000", decimals: 6 };
    expect(getContractDeploymentIssues({
      contracts: [deployment],
      tradedContracts: [{ ...deployment, address: "0xABCDEF0000000000000000000000000000000000" }],
    } as StablecoinMeta)).toEqual([expect.stringContaining("tradedContracts[0] duplicates contracts[0]")]);
    expect(getContractDeploymentIssues({
      contracts: [{ chain: "solana", address: "A".repeat(32), decimals: 6 }],
      tradedContracts: [{ chain: "solana", address: "a".repeat(32), decimals: 6 }],
    } as StablecoinMeta)).toEqual([]);
  });

  it("rejects one chain deployment shared by two coins after resolver normalization", () => {
    const coin = (id: string, address: string) => ({ id, contracts: [{ chain: "xrpl", address, decimals: 6 }] }) as StablecoinMeta;
    expect(getCrossCoinDeploymentCollisionIssues([
      coin("a", "USDQ.rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs"),
      coin("b", "5553445100000000000000000000000000000000-rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs"),
    ])).toEqual([expect.stringContaining("b and a share the deployment xrpl:")]);
  });
});

describe("overdue listing status review warning", () => {
  const launched = {
    status: "pre-launch" as const,
    launchPhase: "launched" as const,
    listingStatusReview: { changedAt: "2026-10-01", reason: "No admitted price lane yet.", reviewBy: "2026-11-30" },
  };
  const quarantined = { ...launched, status: "quarantined" as const, launchPhase: undefined };
  it("warns from UTC start of reviewBy for launched pre-launch rows", () => {
    expect(getOverdueListingStatusReviewIssue(launched, Date.parse("2026-11-29T23:59:59Z"))).toBeNull();
    expect(getOverdueListingStatusReviewIssue(launched, Date.parse("2026-11-30T00:00:00Z"))).toContain("promote it");
    expect(getOverdueListingStatusReviewIssue({ ...launched, launchPhase: "beta" }, Date.parse("2027-01-01T00:00:00Z"))).toBeNull();
  });
  it("names overdue quarantine reviews independent of adapter configuration", () => {
    expect(getOverdueListingStatusReviewIssue(quarantined, Date.parse("2026-11-29T23:59:59Z"))).toBeNull();
    const issue = getOverdueListingStatusReviewIssue(quarantined, Date.parse("2026-11-30T00:00:00Z"));
    expect(issue).toContain("listingStatusReview.reviewBy 2026-11-30");
    expect(issue).toContain("fresh evidence");
    expect(getOverdueListingStatusReviewIssue(quarantined, Date.parse("2026-12-15T00:00:00Z"))).toContain("2026-11-30");
  });
  it("ignores missing, invalid and future dates and other lifecycle states", () => {
    const now = Date.parse("2027-06-01T00:00:00Z");
    for (const review of [undefined, { ...quarantined.listingStatusReview, reviewBy: undefined }, { ...quarantined.listingStatusReview, reviewBy: "not-a-date" }, { ...quarantined.listingStatusReview, reviewBy: "2027-12-31" }]) {
      expect(getOverdueListingStatusReviewIssue({ ...quarantined, listingStatusReview: review } as never, now)).toBeNull();
    }
    for (const status of ["active", "frozen", "delisted"] as const) {
      expect(getOverdueListingStatusReviewIssue({ ...launched, status } as never, now)).toBeNull();
    }
    expect(getOverdueListingStatusReviewIssue({ ...launched, launchPhase: "pilot" } as never, now)).toBeNull();
  });
  it("does not mutate its input", () => {
    const input = structuredClone(quarantined);
    getOverdueListingStatusReviewIssue(input, Date.parse("2027-06-01T00:00:00Z"));
    expect(input).toEqual(quarantined);
  });
});

describe("colliding symbol contract identity", () => {
  const deployment = { chain: "ethereum", address: "0xabcdef0000000000000000000000000000000000", decimals: 6 };
  const coin = (id: string, symbol: string, overrides: Record<string, unknown> = {}) =>
    ({ id, symbol, ...overrides }) as unknown as StablecoinMeta;

  it("rejects a namesake with neither a contract footprint nor an external provider id", () => {
    expect(getCollidingSymbolContractIssues([
      coin("alpha-usd", "FIX", { contracts: [deployment] }),
      coin("beta-usd", "FIX"),
    ])).toEqual([expect.stringContaining("beta-usd")]);
  });

  it("admits contract, traded-contract and provider-id disambiguation", () => {
    expect(getCollidingSymbolContractIssues([
      coin("alpha-usd", "FIX", { contracts: [deployment] }),
      coin("beta-usd", "FIX", { tradedContracts: [deployment] }),
      coin("gamma-usd", "FIX", { geckoId: "fixture-coin" }),
      coin("delta-usd", "FIX", { cmcSlug: "fixture-coin" }),
    ])).toEqual([]);
    expect(getCollidingSymbolContractIssues([coin("alpha-usd", "FIX"), coin("solo-usd", "SOLO")])).toEqual([]);
  });
});

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
  it("retires an expired bootstrap without reauthorizing recovery or changing reserve identity", () => {
    const expiryMs = Date.parse("2026-10-10T00:00:00Z");
    expect(config.bootstrapForSupplyAdmission).toBeUndefined();
    expect(getExpiredReserveSupplyAdmissionBootstrapIssue({ liveReservesConfig: config }, expiryMs)).toBeNull();
    expect(isReserveSupplyAdmissionBootstrapAuthorized(config, expiryMs - 1)).toBe(false);
    expect(isReserveSupplyAdmissionBootstrapAuthorized(config, expiryMs)).toBe(false);
    expect(computeLiveReserveConfigFingerprint(config)).toBe(computeLiveReserveConfigFingerprint({
      ...config, bootstrapForSupplyAdmission: { reviewBy: "2026-10-10" },
    }));
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

describe("listing class precedence and unresolved mechanism review", () => {
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
    policyVersion: "2.0",
    listingClassById: { "fixture-usd": "review-hold" },
  };
  const review: NonNullable<StablecoinMeta["mechanismArchetypeReview"]> = {
    disposition: "unresolved",
    reviewedAt: "2026-10-03",
    reviewer: "Fixture reviewer",
    rationale: "Exact-token identity and holder claim remain unverified.",
    sources: [{ label: "Issuer disclosure", url: "https://example.com/token" }],
  };

  it("holds review-hold while a sourced dated review is unresolved, even with navToken set", () => {
    expect(getListingGovernanceIssues([{ ...coin, mechanismArchetypeReview: review }], decisions)).toEqual([]);
    expect(getListingGovernanceIssues([
      { ...coin, flags: { ...coin.flags, navToken: true }, mechanismArchetypeReview: review },
    ], decisions)).toEqual([]);
  });

  it.each(["core-stablecoin", "tokenized-fund"])("rejects %s during unresolved review and preserves variant precedence", (listingClass) => {
    expect(getListingGovernanceIssues([{ ...coin, mechanismArchetypeReview: review }], {
      ...decisions, listingClassById: { [coin.id]: listingClass },
    })).toContain(
      `listing-decisions.json class for "fixture-usd" is ${listingClass}; expected review-hold (unresolved mechanism review)`,
    );
    expect(getListingGovernanceIssues([{ ...coin, variantOf: "usdc-circle", mechanismArchetypeReview: review }], {
      ...decisions, listingClassById: { [coin.id]: listingClass },
    })).toContain(
      `listing-decisions.json class for "fixture-usd" is ${listingClass}; expected stablecoin-variant (variantOf "usdc-circle")`,
    );
  });

  it("accepts authored core-stablecoin or tokenized-fund regardless of navToken or archetype", () => {
    for (const listingClass of ["core-stablecoin", "tokenized-fund"] as const) {
      expect(getListingGovernanceIssues([
        { ...coin, mechanismArchetype: "tbill", flags: { ...coin.flags, navToken: true } },
      ], { ...decisions, listingClassById: { [coin.id]: listingClass } })).toEqual([]);
      expect(getListingGovernanceIssues([
        { ...coin, mechanismArchetype: "rwa-credit-fund", flags: { ...coin.flags, navToken: false } },
      ], { ...decisions, listingClassById: { [coin.id]: listingClass } })).toEqual([]);
    }
    expect(getListingGovernanceIssues([coin], {
      ...decisions, listingClassById: { [coin.id]: "stablecoin-variant" },
    })).toEqual([
      'listing-decisions.json class for "fixture-usd" is stablecoin-variant (variantOf is absent); expected core-stablecoin or tokenized-fund',
    ]);
  });

  it("requires authored core-stablecoin or tokenized-fund once the review is resolved without an archetype", () => {
    const resolvedCoin = { ...coin, mechanismArchetypeReview: { ...review, disposition: "resolved" as const } };
    expect(getListingGovernanceIssues([resolvedCoin], decisions)).toEqual([
      'listing-decisions.json class for "fixture-usd" is review-hold (no valid unresolved mechanism review with null mechanismArchetype); expected core-stablecoin or tokenized-fund',
    ]);
    for (const listingClass of ["core-stablecoin", "tokenized-fund"] as const) {
      expect(getListingGovernanceIssues([resolvedCoin], {
        ...decisions, listingClassById: { "fixture-usd": listingClass },
      })).toEqual([]);
    }
  });

  it.each([
    { ...review, reviewedAt: "not-a-date" },
    { ...review, sources: [] },
    { ...review, sources: [{ label: "Invalid source", url: "not-a-url" }] },
  ])("does not hold review-hold on invalid review provenance", (invalidReview) => {
    expect(getListingGovernanceIssues([{ ...coin, mechanismArchetypeReview: invalidReview }], decisions)).toEqual([
      'listing-decisions.json class for "fixture-usd" is review-hold (no valid unresolved mechanism review with null mechanismArchetype); expected core-stablecoin or tokenized-fund',
    ]);
  });

  it("keeps delisting precedence and does not admit active excluded rows through the hold", () => {
    expect(getListingGovernanceIssues([{
      ...coin, status: "delisted", mechanismArchetypeReview: review,
    }], { ...decisions, listingClassById: { "fixture-usd": "excluded" } })).toEqual([]);
    expect(getListingGovernanceIssues([{
      ...coin, status: "delisted", mechanismArchetypeReview: review,
    }], decisions)).toEqual([
      'listing-decisions.json class for "fixture-usd" is review-hold; delisted assets must be excluded',
    ]);
    expect(getListingGovernanceIssues([{
      ...coin, status: "delisted", variantOf: "usdc-circle",
    }], { ...decisions, listingClassById: { "fixture-usd": "excluded" } })).toEqual([]);
    expect(getListingGovernanceIssues([{
      ...coin, status: "delisted", variantOf: "usdc-circle",
    }], { ...decisions, listingClassById: { "fixture-usd": "stablecoin-variant" } })).toEqual([
      'listing-decisions.json class for "fixture-usd" is stablecoin-variant; delisted assets must be excluded',
    ]);
    expect(getListingGovernanceIssues([{
      ...coin, mechanismArchetypeReview: review,
    }], { ...decisions, listingClassById: { "fixture-usd": "excluded" } })).toContain(
      'listing-decisions.json marks non-delisted "fixture-usd" as excluded',
    );
  });

  it("enforces policyVersion 2.0, retired classes, variant/archetype edges, priceBasis/exitMechanism, and ledger coverage", () => {
    expect(getListingGovernanceIssues([coin], {
      ...decisions, policyVersion: "1.0", listingClassById: { [coin.id]: "core-stablecoin" },
    })).toEqual([expect.stringContaining("listing-decisions.json[policyVersion]")]);
    for (const retired of ["cash-equivalent", "stable-value-investment"]) {
      expect(getListingGovernanceIssues([coin], {
        ...decisions, listingClassById: { [coin.id]: retired },
      })).toEqual([expect.stringContaining("listing-decisions.json[listingClassById.fixture-usd]")]);
    }
    expect(getListingGovernanceIssues([{ ...coin, variantOf: "usdc-circle", mechanismArchetypeReview: review }], {
      ...decisions, listingClassById: { [coin.id]: "stablecoin-variant" },
    })).toEqual([]);
    expect(getListingGovernanceIssues([{ ...coin, variantOf: "usdc-circle", mechanismArchetypeReview: review }], decisions)).toEqual([
      'listing-decisions.json class for "fixture-usd" is review-hold; expected stablecoin-variant (variantOf "usdc-circle")',
    ]);
    expect(getListingGovernanceIssues([{ ...coin, mechanismArchetype: "tbill", mechanismArchetypeReview: review }], decisions)).toEqual([
      'listing-decisions.json class for "fixture-usd" is review-hold (no valid unresolved mechanism review with null mechanismArchetype); expected core-stablecoin or tokenized-fund',
    ]);
    expect(getListingGovernanceIssues([{
      ...coin, priceBasis: "contractual-par", exitMechanism: "discretionary",
    }], { ...decisions, listingClassById: { [coin.id]: "core-stablecoin" } })).toEqual([
      'priceBasis is reserved for sourced delisting records; remove it from "fixture-usd"',
      'exitMechanism is reserved for sourced delisting records; remove it from "fixture-usd"',
    ]);
    expect(getListingGovernanceIssues([{
      ...coin, status: "delisted", priceBasis: "contractual-par", exitMechanism: "discretionary",
    }], { ...decisions, listingClassById: { [coin.id]: "excluded" } })).toEqual([]);
    expect(getListingGovernanceIssues([coin], {
      ...decisions, listingClassById: { "unknown-id": "core-stablecoin", "xai-silo-finance": "core-stablecoin" },
    })).toEqual([
      'listing-decisions.json references unknown catalog ID "unknown-id"',
      'listing-decisions.json must classify cemetery ID "xai-silo-finance" as excluded',
      'listing-decisions.json is missing catalog ID "fixture-usd"',
    ]);
  });

  it("warns when an active tokenized-fund lacks an active non-fund static linker or reviewed adapter allowance", () => {
    const fund: StablecoinMeta = { ...coin, id: "fund-a", symbol: "FA" };
    const peerFund: StablecoinMeta = { ...coin, id: "fund-b", symbol: "FB", dependencies: [{ id: "fund-a", weight: 1, type: "collateral" }] };
    const delistedLinker: StablecoinMeta = { ...coin, id: "dead-a", symbol: "DA", status: "delisted", dependencies: [{ id: "fund-a", weight: 1, type: "collateral" }] };
    const nonLinkCore: StablecoinMeta = {
      ...coin,
      id: "core-a",
      symbol: "CA",
      reserveReview: {
        reviewedAt: "2026-11-24",
        reviewer: "Fixture",
        confidence: "verified",
        sources: [{ label: "Fixture", url: "https://example.com/reserves" }],
        rationale: "Fixture review",
        compositionBasis: "Fixture basis",
        scope: "full-composition",
        knownUnknownExposure: "None",
        knownUnknownExposurePct: 0,
        nonLinkDispositions: [{ reserveIndex: 0, reserveName: "Fund A", pct: 20, disposition: "basket-needs-split", candidateCoinIds: ["fund-a"], rationale: "unlinked" }],
      },
    };
    const baseDecisions = {
      schemaVersion: 1,
      policyVersion: "2.0",
      listingClassById: { "fund-a": "tokenized-fund", "fund-b": "tokenized-fund", "dead-a": "excluded", "core-a": "core-stablecoin" },
    };

    expect(getUnlinkedActiveTokenizedFundWarnings([fund, peerFund, delistedLinker, nonLinkCore], baseDecisions, {})).toEqual([
      expect.stringContaining('active tokenized-fund "fund-a"'),
      expect.stringContaining('active tokenized-fund "fund-b"'),
    ]);
    expect(getUnlinkedActiveTokenizedFundWarnings([
      fund,
      { ...nonLinkCore, dependencies: [{ id: "fund-a", weight: 0.2, type: "collateral" }] },
    ], baseDecisions, {})).toEqual([]);
    expect(getUnlinkedActiveTokenizedFundWarnings([
      fund,
      { ...nonLinkCore, reserves: [{ name: "Fund A", pct: 50, risk: "low", coinId: "fund-a", depType: "collateral" }] },
    ], baseDecisions, {})).toEqual([]);
    expect(getUnlinkedActiveTokenizedFundWarnings([
      fund,
      {
        ...nonLinkCore,
        dependencyReview: {
          reviewedAt: "2026-11-24", reviewer: "Fixture", confidence: "verified",
          sources: [{ label: "Docs", url: "https://example.com" }], rationale: "Linked.",
          relationships: [{ id: "fund-a", weight: 0.2, type: "collateral", reason: "Reserve." }],
        },
      },
    ], baseDecisions, {})).toEqual([]);
    expect(getUnlinkedActiveTokenizedFundWarnings([{ ...fund, status: "quarantined" }], baseDecisions, {})).toEqual([]);
    expect(getUnlinkedActiveTokenizedFundWarnings([
      { ...coin, id: "jaaa-janus-henderson-anemoy", symbol: "JAAA" },
      { ...coin, id: "jtrsy-anemoy", symbol: "JTRSY" },
    ], {
      ...baseDecisions,
      listingClassById: { "jaaa-janus-henderson-anemoy": "tokenized-fund", "jtrsy-anemoy": "tokenized-fund" },
    }, REVIEWED_LIVE_ADAPTER_ONLY_TOKENIZED_FUND_LINKS)).toEqual([]);
  });
});

describe("removed-stablecoin redirect guard", () => {
  const removed = [{
    id: "old-coin", name: "Old Coin", symbol: "OLD", pegCurrency: "USD" as const,
    removedAt: "2026-07-19", reason: "no-live-data" as const, cemeteryId: "old-coin",
  }];
  const redirects = (destination = "/cemetery/#old-coin", status = "301") =>
    [`/stablecoin/old-coin ${destination} ${status}`, `/stablecoin/old-coin/* ${destination} ${status}`].join("\n");
  const options = { removed, cemeteryIds: new Set(["old-coin"]) };

  it.each([
    {
      name: "passes a clean redirect pair",
      source: redirects(),
      options,
      expected: [],
    },
    {
      name: "permits Dinari re-admission after its retirement rules and ledger row are removed",
      source: redirects(),
      options: { ...options, trackedIds: new Set(["usd-dinari"]) },
      expected: [],
    },
    {
      name: "flags a missing forward redirect",
      source: `/stablecoin/old-coin/* /cemetery/#old-coin 301`,
      options,
      expected: ["/stablecoin/old-coin: expected a 301 to /cemetery/#old-coin"],
    },
    {
      name: "flags a temporary redirect status",
      source: redirects("/cemetery/#old-coin", "302"),
      options,
      expected: [
        "/stablecoin/old-coin: expected a 301 to /cemetery/#old-coin",
        "/stablecoin/old-coin/*: expected a 301 to /cemetery/#old-coin",
      ],
    },
    {
      name: "flags a wrong destination",
      source: redirects("/stablecoins/usd/"),
      options,
      expected: [
        "/stablecoin/old-coin: expected a 301 to /cemetery/#old-coin",
        "/stablecoin/old-coin/*: expected a 301 to /cemetery/#old-coin",
      ],
    },
    {
      name: "flags reverse drift to an unnamed retired profile",
      source: `${redirects()}\n/stablecoin/ghost-coin /coverage/ 301`,
      options,
      expected: ["/stablecoin/ghost-coin: redirect points at a retired profile the removal list does not name"],
    },
    {
      name: "flags a still-tracked removed stablecoin",
      source: redirects(),
      options: { ...options, trackedIds: new Set(["old-coin"]) },
      expected: ["old-coin: removed stablecoin is still in the tracked registry"],
    },
    {
      name: "fails closed on an empty removal list",
      source: "",
      options: { removed: [] },
      expected: ["removed-stablecoin list is empty, so no retired profile redirect can be verified"],
    },
  ])("$name", ({ source, options: guardOptions, expected }) => {
    expect(getRemovedStablecoinRedirectIssues(source, guardOptions)).toEqual(expected);
  });
});
