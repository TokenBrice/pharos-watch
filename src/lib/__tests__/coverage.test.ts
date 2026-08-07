import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry, StablecoinMeta } from "@shared/types";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import type { CoverageFeatureKey } from "@/lib/coverage-types";
import { buildCoverageFeatureSummary, buildCoverageRow, COVERAGE_FEATURES } from "@/lib/coverage";
import { coverageFeature as blacklistCoverageFeature } from "@/lib/coverage/blacklist";
import { coverageFeature as dependencyCoverageFeature } from "@/lib/coverage/dependency";
import { coverageFeature as dexCoverageFeature } from "@/lib/coverage/dex";
import { coverageFeature as flowCoverageFeature } from "@/lib/coverage/flows";
import { coverageFeature as mintAuthorityCoverageFeature } from "@/lib/coverage/mint-authority";
import { coverageFeature as priceCoverageFeature } from "@/lib/coverage/price";
import { coverageFeature as redemptionCoverageFeature } from "@/lib/coverage/redemption";
import { coverageFeature as reserveCoverageFeature } from "@/lib/coverage/reserves";
import { coverageFeature as safetyCoverageFeature } from "@/lib/coverage/safety";
import { coverageFeature as yieldCoverageFeature } from "@/lib/coverage/yield";
import { COVERAGE_BREAKDOWN_VISUAL_CLASSES } from "@/lib/coverage-page-config";

type TestCoin = StablecoinMeta & { mintAuthoritySummary?: MintAuthorityCoverageSummary };

function makeCoin(overrides?: Partial<TestCoin>): TestCoin {
  return {
    id: "test-usd",
    name: "Test USD",
    symbol: "TUSDX",
    flags: {
      backing: "rwa-backed",
      governance: "centralized",
      pegCurrency: "USD",
      yieldBearing: false,
      rwa: true,
      navToken: false,
    },
    ...overrides,
  };
}

function makeRedemptionEntry(overrides?: Partial<RedemptionBackstopEntry>): RedemptionBackstopEntry {
  return {
    stablecoinId: "test-usd",
    score: 72,
    dexLiquidityScore: 58,
    accessScore: 100,
    settlementScore: 100,
    executionCertaintyScore: 100,
    capacityScore: 60,
    outputAssetQualityScore: 100,
    costScore: 40,
    routeFamily: "psm-swap",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    provider: "supply-ratio-model",
    sourceMode: "estimated",
    resolutionState: "resolved",
    routeStatus: "open",
    routeStatusSource: "static-config",
    holderEligibility: "any-holder",
    capacityConfidence: "documented-bound",
    capacitySemantics: "immediate-bounded",
    feeConfidence: "undisclosed-reviewed",
    feeModelKind: "undisclosed-reviewed",
    modelConfidence: "medium",
    immediateCapacityUsd: 10_000_000,
    immediateCapacityRatio: 0.15,
    feeBps: null,
    queueEnabled: false,
    methodologyVersion: "1.1",
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

type CoverageRowOverrides = Partial<Parameters<typeof buildCoverageRow>[0]>;
type CoverageRowIdentity = readonly [id: string, symbol: string];

function makeCoverageRow([id, symbol]: CoverageRowIdentity, overrides: CoverageRowOverrides = {}) {
  const { coin, ...inputOverrides } = overrides;
  return buildCoverageRow({
    coin: { ...(coin ?? makeCoin()), id, symbol },
    marketCapUsd: 100,
    hasPegCoverage: true,
    safetyScore: 82,
    dexCoverageClass: "primary",
    redemptionEntry: null,
    hasYieldCoverage: false,
    flowCoverageStatus: null,
    hasDependencyCoverage: false,
    ...inputOverrides,
  });
}

function coverageFeature(key: CoverageFeatureKey) {
  return COVERAGE_FEATURES.find((feature) => feature.key === key)!;
}

describe("coverage helpers", () => {
  it("marks NAV tokens as price-only instead of depeg-tracked", () => {
    const status = priceCoverageFeature.resolve(
      makeCoin({
        flags: {
          backing: "rwa-backed",
          governance: "centralized",
          pegCurrency: "USD",
          yieldBearing: true,
          rwa: true,
          navToken: true,
        },
      }),
      false,
    );

    expect(status.kind).toBe("price-only");
    expect(status.available).toBe(true);
  });

  it("maps DEX coverage classes into user-facing labels", () => {
    expect(dexCoverageFeature.resolve("primary").label).toBe("Primary");
    expect(dexCoverageFeature.resolve("fallback").label).toBe("Fallback");
    expect(dexCoverageFeature.resolve("unobserved").available).toBe(false);
  });

  it("maps reserve sync coverage into live, curated-validated, proof, curated, or estimated states", () => {
    expect(
      reserveCoverageFeature.resolve(
        makeCoin({
          liveReservesConfig: {
            adapter: "infinifi",
            version: 1,
            semantics: "collateral-mix",
            inputs: {
              primary: { kind: "http-json", url: "https://example.com/reserves" },
            },
          },
        }),
      ).kind,
    ).toBe("live");

    expect(
      reserveCoverageFeature.resolve(
        makeCoin({
          liveReservesConfig: {
            adapter: "curated-validated",
            version: 1,
            semantics: "attestation-mix",
            inputs: {
              primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
            },
          },
        }),
      ).kind,
    ).toBe("curated-validated");

    expect(
      reserveCoverageFeature.resolve(
        makeCoin({
          liveReservesConfig: {
            adapter: "single-asset",
            version: 1,
            semantics: "single-asset",
            inputs: {
              primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
            },
            params: {
              label: "Issuer reserves",
              risk: "very-low",
            },
          },
        }),
      ).kind,
    ).toBe("proof");

    expect(
      reserveCoverageFeature.resolve(
        makeCoin({
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
      ).kind,
    ).toBe("curated");

    expect(reserveCoverageFeature.resolve(makeCoin()).kind).toBe("estimated");
  });

  it("marks reserve coverage unavailable when the coverage row has no reserve data", () => {
    const status = reserveCoverageFeature.resolve(
      makeCoin({
        reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      }),
      true,
      false,
    );

    expect(status.kind).toBe("data-unavailable");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Data n/a");
  });

  it("does not count configured live reserve adapters as fresh live coverage without current live data", () => {
    const liveConfiguredCoin = makeCoin({
      liveReservesConfig: {
        adapter: "infinifi",
        version: 1,
        semantics: "collateral-mix",
        inputs: {
          primary: { kind: "http-json", url: "https://example.com/reserves" },
        },
      },
    });

    expect(reserveCoverageFeature.resolve(liveConfiguredCoin, false).kind).toBe("live-configured");
    expect(reserveCoverageFeature.resolve(liveConfiguredCoin, false).available).toBe(false);
    expect(reserveCoverageFeature.resolve(liveConfiguredCoin, null).kind).toBe("checking");
  });

  it("maps redemption route families into user-facing labels", () => {
    expect(redemptionCoverageFeature.resolve(makeRedemptionEntry()).label).toBe("PSM");
    expect(redemptionCoverageFeature.resolve(makeRedemptionEntry({ routeFamily: "offchain-issuer" })).label).toBe(
      "Issuer",
    );
    expect(redemptionCoverageFeature.resolve(makeRedemptionEntry({ routeFamily: "queue-redeem" })).label).toBe("Queue");
    expect(redemptionCoverageFeature.resolve(null).available).toBe(false);
  });

  it("treats configured but unrated redemption rows as unavailable coverage", () => {
    const status = redemptionCoverageFeature.resolve(
      makeRedemptionEntry({
        score: null,
        resolutionState: "missing-capacity",
        modelConfidence: "low",
      }),
    );

    expect(status.kind).toBe("configured-unrated");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Config.");
  });

  it("treats low-confidence redemption rows as heuristic coverage, not strong availability", () => {
    const status = redemptionCoverageFeature.resolve(
      makeRedemptionEntry({
        modelConfidence: "low",
      }),
    );

    expect(status.kind).toBe("modeled-heuristic");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Heur.");
  });

  it("treats impaired redemption rows as unavailable coverage", () => {
    const status = redemptionCoverageFeature.resolve(
      makeRedemptionEntry({
        score: null,
        resolutionState: "impaired",
        routeStatus: "degraded",
        routeStatusSource: "market-implied",
        routeStatusReason: "Active severe depeg requires current live-open evidence.",
        modelConfidence: "low",
      }),
    );

    expect(status.kind).toBe("impaired");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Impaired");
    expect(status.detail).toContain("Active severe depeg");
  });

  it("treats resolved eventual-only redemption rows as unscored coverage", () => {
    const status = redemptionCoverageFeature.resolve(
      makeRedemptionEntry({
        score: 65,
        modelConfidence: "medium",
        capacitySemantics: "eventual-only",
      }),
    );

    expect(status.kind).toBe("resolved-unscored");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Resolved");
  });

  it("maps mint/burn coverage states into visible labels", () => {
    expect(flowCoverageFeature.resolve("full").label).toBe("Full");
    expect(flowCoverageFeature.resolve("partial-history").label).toBe("Partial");
    expect(flowCoverageFeature.resolve("bootstrapping").kind).toBe("bootstrapping");
    expect(flowCoverageFeature.resolve("bootstrapping").spokenLabel).toBe("Bootstrapping");
    expect(flowCoverageFeature.resolve("unknown").label).toBe("Unknown");
    expect(flowCoverageFeature.resolve(null).available).toBe(false);
  });

  it("emits live tracker, blacklistable, and resolved status kinds", () => {
    expect(blacklistCoverageFeature.resolve(makeCoin({ symbol: "tGBP" }), true).kind).toBe("live");
    expect(blacklistCoverageFeature.resolve(makeCoin({ symbol: "YES" }), true).kind).toBe("yes");
    expect(blacklistCoverageFeature.resolve(makeCoin({ symbol: "USDT" }), "possible").kind).toBe("possible");
    expect(blacklistCoverageFeature.resolve(makeCoin({ symbol: "DAI" }), "inherited").kind).toBe("upstream");
    expect(blacklistCoverageFeature.resolve(makeCoin({ symbol: "USDQ" }), false).kind).toBe("no");
    expect(blacklistCoverageFeature.resolve(makeCoin({ symbol: "TBD" }), null).kind).toBe("data-unavailable");
  });

  it("emits role-aware dependency coverage states", () => {
    expect(
      dependencyCoverageFeature.resolve({
        kind: "both",
        upstreamCount: 2,
        dependentCount: 1,
        rawDependencyCount: 2,
        mappedDependencyWeight: 0.9,
      }).kind,
    ).toBe("both");
    expect(
      dependencyCoverageFeature.resolve({
        kind: "dependent",
        upstreamCount: 1,
        dependentCount: 0,
        rawDependencyCount: 1,
        mappedDependencyWeight: 0.5,
      }).kind,
    ).toBe("dependent");
    expect(
      dependencyCoverageFeature.resolve({
        kind: "upstream",
        upstreamCount: 0,
        dependentCount: 2,
        rawDependencyCount: 0,
        mappedDependencyWeight: 0,
      }).kind,
    ).toBe("upstream");
    expect(
      dependencyCoverageFeature.resolve({
        kind: "resolved-none",
        upstreamCount: 0,
        dependentCount: 0,
        rawDependencyCount: 0,
        mappedDependencyWeight: 0,
      }).available,
    ).toBe(true);
    expect(
      dependencyCoverageFeature.resolve({
        kind: "unmapped-gap",
        upstreamCount: 0,
        dependentCount: 0,
        rawDependencyCount: 1,
        mappedDependencyWeight: 0,
      }).available,
    ).toBe(false);
  });

  it("maps mint-authority summaries into descriptive coverage states", () => {
    expect(mintAuthorityCoverageFeature.resolve(null).kind).toBe("unknown");
    expect(mintAuthorityCoverageFeature.resolve(null).available).toBe(false);
    expect(
      mintAuthorityCoverageFeature.resolve({
        mintPath: "immutable-user-collateralized",
        authorityPosture: "none-resolved",
        confidence: "verified",
      }).kind,
    ).toBe("no-privileged-mint");
    expect(
      mintAuthorityCoverageFeature.resolve({
        mintPath: "bridge-or-oft-synthetic",
        authorityPosture: "partially-bounded-admin",
        confidence: "manual-review",
      }).kind,
    ).toBe("bridge-mint");
    expect(
      mintAuthorityCoverageFeature.resolve({
        mintPath: "permissioned-minter",
        authorityPosture: "bounded-admin",
        confidence: "verified",
        controls: [
          {
            label: "Minter admin",
            authorityType: "safe",
            directMintAbility: "can-authorize",
          },
        ],
      }).kind,
    ).toBe("multisig-mint");
    expect(
      mintAuthorityCoverageFeature.resolve({
        mintPath: "issuer-direct-mint",
        authorityPosture: "bounded-admin",
        confidence: "verified",
      }).kind,
    ).toBe("issuer-or-backend-mint");
    expect(
      mintAuthorityCoverageFeature.resolve({
        mintPath: "permissioned-minter",
        authorityPosture: "unbounded-or-compromised",
        confidence: "manual-review",
        controls: [
          {
            label: "Direct minter",
            authorityType: "unknown",
            directMintAbility: "direct",
          },
        ],
      }).kind,
    ).toBe("issuer-or-backend-mint");
    expect(
      mintAuthorityCoverageFeature.resolve({
        mintPath: "wrapped-or-variant-inherited",
        authorityPosture: "bounded-admin",
        confidence: "probable",
      }).kind,
    ).toBe("inherited-authority");
  });

  it("does not use authority posture as a mint-authority coverage ranking", () => {
    const bounded = mintAuthorityCoverageFeature.resolve({
      mintPath: "permissioned-minter",
      authorityPosture: "bounded-admin",
      confidence: "verified",
      controls: [
        {
          label: "Minter admin",
          authorityType: "safe",
          directMintAbility: "can-authorize",
        },
      ],
    });
    const concentrated = mintAuthorityCoverageFeature.resolve({
      mintPath: "permissioned-minter",
      authorityPosture: "concentrated-admin",
      confidence: "verified",
      controls: [
        {
          label: "Minter admin",
          authorityType: "safe",
          directMintAbility: "can-authorize",
        },
      ],
    });

    expect(concentrated.kind).toBe(bounded.kind);
    expect(concentrated.sortRank).toBe(bounded.sortRank);
  });

  it("keeps dependency gaps and dependency data outages separate in summaries", () => {
    const rows = [
      makeCoverageRow(["gap", "GAP"], {
        dependencyCoverage: {
          kind: "unmapped-gap",
          upstreamCount: 0,
          dependentCount: 0,
          rawDependencyCount: 1,
          mappedDependencyWeight: 0,
        },
      }),
      makeCoverageRow(["unavailable", "DNA"], {
        dependencyCoverage: null,
        dataAvailability: { dependency: false },
      }),
    ];

    const summary = buildCoverageFeatureSummary(coverageFeature("dependency"), rows, 200);

    expect(summary.breakdown).toContainEqual({ key: "gaps", label: "gaps", count: 1 });
    expect(summary.breakdown).toContainEqual({ key: "data-unavailable", label: "data n/a", count: 1 });
  });

  it("defines coverage snapshot visuals for every dependency breakdown key", () => {
    for (const key of ["both", "dependent", "upstream", "resolved-none", "gaps", "data-unavailable"]) {
      expect(COVERAGE_BREAKDOWN_VISUAL_CLASSES.dependency?.[key]).toBeDefined();
    }
  });

  it("defines coverage snapshot visuals for every mint-authority breakdown key", () => {
    for (const key of [
      "no-privileged-mint",
      "governed-mint",
      "multisig-mint",
      "issuer-or-backend-mint",
      "bridge-mint",
      "inherited-authority",
      "unknown",
      "score-hardened",
      "score-governed",
      "score-managed",
      "score-concentrated",
      "score-exposed",
      "score-nr",
    ]) {
      expect(COVERAGE_BREAKDOWN_VISUAL_CLASSES.mintAuthority?.[key]).toBeDefined();
    }
  });

  it("defines coverage snapshot visuals for every redemption breakdown key", () => {
    for (const key of [
      "modeled-heuristic",
      "resolved-unscored",
      "configured-unrated",
      "impaired",
      "offchain-issuer",
      "psm-swap",
      "queue-redeem",
      "collateral-redeem",
      "stablecoin-redeem",
      "basket-redeem",
      "data-unavailable",
    ]) {
      expect(COVERAGE_BREAKDOWN_VISUAL_CLASSES.redemption?.[key]).toBeDefined();
    }
  });

  it("counts only available features when building rows", () => {
    const row = makeCoverageRow(["test-usd", "TUSDX"], {
      coin: makeCoin({
        reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      }),
      marketCapUsd: 1_000_000,
      redemptionEntry: makeRedemptionEntry(),
      flowCoverageStatus: "partial-history",
    });

    expect(row.coverageCount).toBe(6);
    expect(row.headlineCoverageCount).toBe(4);
    expect(row.advancedCoverageCount).toBe(5);
    expect(row.statuses.yield.available).toBe(false);
    expect(row.statuses.blacklist.available).toBe(false);
    expect(row.statuses.redemption.label).toBe("PSM");
    expect(row.statuses.mintAuthority.available).toBe(false);
  });

  it("builds per-feature summaries with breakdown text and market-cap share", () => {
    const rows = [
      makeCoverageRow(["one", "ONE"], {
        coin: makeCoin({
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
        marketCapUsd: 800,
        consensusSources: ["coingecko", "defillama-list", "pyth"],
        priceConfidence: "high",
        redemptionEntry: makeRedemptionEntry(),
        hasYieldCoverage: true,
        flowCoverageStatus: "full",
        hasDependencyCoverage: true,
      }),
      makeCoverageRow(["two", "TWO"], {
        coin: makeCoin({
          flags: {
            backing: "rwa-backed",
            governance: "centralized",
            pegCurrency: "USD",
            yieldBearing: false,
            rwa: true,
            navToken: true,
          },
        }),
        marketCapUsd: 200,
        hasPegCoverage: false,
        safetyScore: null,
        dexCoverageClass: "unobserved",
      }),
    ];

    const summary = buildCoverageFeatureSummary(coverageFeature("price"), rows, 1_000);

    // headlineFilter requires sourceCount >= 3; only the tracked three-source row passes.
    expect(summary.availableCount).toBe(1);
    expect(summary.totalCount).toBe(2);
    expect(summary.coveragePct).toBe(50);
    expect(summary.mcapSharePct).toBe(80);
    expect(summary.breakdown).toEqual([
      { key: "tracked", label: "tracked", count: 1 },
      { key: "price-only", label: "price-only", count: 1 },
      { key: "sources-5-plus", label: "5+ sources:", count: 0 },
      { key: "sources-3-4", label: "3-4:", count: 1 },
      { key: "sources-1-2", label: "1-2:", count: 0 },
    ]);
  });

  it("summarizes mint-authority coverage as reviewed authority breadth", () => {
    const rows = [
      makeCoverageRow(["reviewed", "REV"], {
        coin: makeCoin({
          mintAuthoritySummary: {
            mintPath: "issuer-direct-mint",
            authorityPosture: "concentrated-admin",
            confidence: "verified",
          },
        }),
        marketCapUsd: 800,
        safetyScore: null,
        dexCoverageClass: null,
      }),
      makeCoverageRow(["unknown", "UNK"], {
        marketCapUsd: 200,
        safetyScore: null,
        dexCoverageClass: null,
      }),
    ];

    const summary = buildCoverageFeatureSummary(coverageFeature("mintAuthority"), rows, 1_000);

    expect(summary.countLabel).toBe("Reviewed authority");
    expect(summary.availableCount).toBe(1);
    expect(summary.coveragePct).toBe(50);
    expect(summary.mcapSharePct).toBe(80);
    expect(summary.coverageLabel).toBe("50% with reviewed mint authority");
    expect(summary.breakdown).toContainEqual({
      key: "issuer-or-backend-mint",
      label: "issuer/backend",
      count: 1,
    });
    expect(summary.breakdown).toContainEqual({ key: "unknown", label: "unknown", count: 1 });
    expect(rows[0].statuses.mintAuthority).toMatchObject({ score: 39, scoreBand: "concentrated" });
    expect(summary.breakdown).toContainEqual({ key: "score-concentrated", label: "Concentrated", count: 1 });
    expect(summary.breakdown).toContainEqual({ key: "score-nr", label: "NR", count: 1 });
  });

  it("sets sourceCount and sourceNames on tracked price coverage when consensusSources provided", () => {
    const status = priceCoverageFeature.resolve(makeCoin(), true, ["coingecko", "defillama", "pyth"], "high");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(3);
    expect(status.sourceNames).toEqual(["coingecko", "defillama", "pyth"]);
    expect(status.priceConfidence).toBe("high");
  });

  it("sets sourceCount on tracked price coverage with empty sources", () => {
    const status = priceCoverageFeature.resolve(makeCoin(), true, [], "single-source");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(0);
    expect(status.sourceNames).toEqual([]);
    expect(status.priceConfidence).toBe("single-source");
  });

  it("does not set sourceCount when consensusSources omitted (backward compat)", () => {
    const status = priceCoverageFeature.resolve(makeCoin(), true);

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBeUndefined();
    expect(status.sourceNames).toBeUndefined();
    expect(status.priceConfidence).toBeUndefined();
  });

  it("includes source-depth breakdown when consensusSources are present", () => {
    const rows = [
      makeCoverageRow(["deep", "DEEP"], {
        marketCapUsd: 500,
        consensusSources: ["coingecko", "defillama", "pyth", "binance", "coinbase"],
        safetyScore: null,
        dexCoverageClass: null,
      }),
      makeCoverageRow(["shallow", "SHAL"], {
        marketCapUsd: 500,
        consensusSources: ["coingecko"],
        safetyScore: null,
        dexCoverageClass: null,
      }),
    ];

    const summary = buildCoverageFeatureSummary(coverageFeature("price"), rows, 1_000);

    expect(summary.breakdown).toContainEqual({ key: "tracked", label: "tracked", count: 2 });
    expect(summary.breakdown).toContainEqual({ key: "sources-5-plus", label: "5+ sources:", count: 1 });
    expect(summary.breakdown).toContainEqual({ key: "sources-1-2", label: "1-2:", count: 1 });
  });

  it("uses score-grade live reserves as the headline metric for reserve summaries", () => {
    const rows = [
      makeCoverageRow(["live", "LIVE"], {
        coin: makeCoin({
          liveReservesConfig: {
            adapter: "infinifi",
            version: 1,
            semantics: "collateral-mix",
            inputs: {
              primary: { kind: "http-json", url: "https://example.com/reserves" },
            },
          },
        }),
        marketCapUsd: 700,
      }),
      makeCoverageRow(["validated", "VAL"], {
        coin: makeCoin({
          liveReservesConfig: {
            adapter: "curated-validated",
            version: 1,
            semantics: "attestation-mix",
            inputs: {
              primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
            },
          },
        }),
      }),
      makeCoverageRow(["proof", "PROOF"], {
        coin: makeCoin({
          liveReservesConfig: {
            adapter: "single-asset",
            version: 1,
            semantics: "single-asset",
            inputs: {
              primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
            },
            params: {
              label: "Issuer reserves",
              risk: "very-low",
            },
          },
        }),
      }),
      makeCoverageRow(["curated", "CUR"], {
        coin: makeCoin({
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
        marketCapUsd: 300,
      }),
    ];

    const summary = buildCoverageFeatureSummary(coverageFeature("reserves"), rows, 1_000);

    expect(summary.countLabel).toBe("Score-grade live");
    expect(summary.availableCount).toBe(1);
    expect(summary.totalCount).toBe(4);
    expect(summary.coveragePct).toBe(25);
    expect(summary.mcapSharePct).toBe(70);
    expect(summary.shareLabel).toBe("Score-grade live reserve market-cap reach");
    expect(summary.coverageLabel).toBe("25% with score-grade live reserves");
    expect(summary.breakdown).toEqual([
      { key: "live", label: "score-grade", count: 1 },
      { key: "live-configured", label: "configured", count: 0 },
      { key: "checking", label: "checking", count: 0 },
      { key: "curated-validated", label: "curated-validated", count: 1 },
      { key: "proof", label: "proof", count: 1 },
      { key: "curated", label: "curated", count: 1 },
      { key: "estimated", label: "estimated", count: 0 },
    ]);
  });

  it("breaks down redemption coverage by route family", () => {
    const rows = [
      makeCoverageRow(["issuer", "ISS"], {
        marketCapUsd: 500,
        redemptionEntry: makeRedemptionEntry({ routeFamily: "offchain-issuer" }),
      }),
      makeCoverageRow(["psm", "PSM"], {
        marketCapUsd: 300,
        redemptionEntry: makeRedemptionEntry({ routeFamily: "psm-swap" }),
      }),
      makeCoverageRow(["heuristic", "HEUR"], {
        marketCapUsd: 150,
        redemptionEntry: makeRedemptionEntry({
          routeFamily: "stablecoin-redeem",
          modelConfidence: "low",
          capacityConfidence: "heuristic",
        }),
      }),
      makeCoverageRow(["eventual", "EVT"], {
        marketCapUsd: 75,
        redemptionEntry: makeRedemptionEntry({
          routeFamily: "offchain-issuer",
          capacitySemantics: "eventual-only",
        }),
      }),
      makeCoverageRow(["impaired", "IMP"], {
        marketCapUsd: 25,
        redemptionEntry: makeRedemptionEntry({
          score: null,
          resolutionState: "impaired",
          routeStatus: "degraded",
          modelConfidence: "low",
        }),
      }),
      makeCoverageRow(["none", "NON"], {
        marketCapUsd: 50,
      }),
    ];

    const summary = buildCoverageFeatureSummary(coverageFeature("redemption"), rows, 1_000);

    expect(summary.countLabel).toBe("Strong coverage");
    expect(summary.availableCount).toBe(2);
    expect(summary.totalCount).toBe(6);
    expect(summary.coveragePct).toBeCloseTo(33.333, 3);
    expect(summary.mcapSharePct).toBe(80);
    expect(summary.coverageLabel).toBe("33% with strong redemption coverage");
    expect(summary.shareLabel).toBe("Strong redemption market-cap reach");
    expect(summary.breakdown).toEqual([
      { key: "modeled-heuristic", label: "heuristic", count: 1 },
      { key: "resolved-unscored", label: "resolved", count: 1 },
      { key: "configured-unrated", label: "configured", count: 0 },
      { key: "impaired", label: "impaired", count: 1 },
      { key: "offchain-issuer", label: "issuer", count: 1 },
      { key: "psm-swap", label: "psm", count: 1 },
      { key: "queue-redeem", label: "queue", count: 0 },
      { key: "collateral-redeem", label: "collateral", count: 0 },
      { key: "stablecoin-redeem", label: "stable", count: 0 },
      { key: "basket-redeem", label: "basket", count: 0 },
      { key: "data-unavailable", label: "data n/a", count: 0 },
    ]);
  });

  it("summarizes freezable status across every coin and surfaces live tracker coverage", () => {
    const rows = [
      makeCoverageRow(["tracked", "USDC"], {
        marketCapUsd: 700,
        blacklistStatus: true,
      }),
      makeCoverageRow(["untracked", "YES"], {
        marketCapUsd: 200,
        blacklistStatus: true,
      }),
      makeCoverageRow(["possible", "USDT"], {
        marketCapUsd: 500,
        blacklistStatus: "possible",
      }),
      makeCoverageRow(["not-blacklistable", "NO"], {
        blacklistStatus: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(coverageFeature("blacklist"), rows, 1_500);

    expect(summary.countLabel).toBe("Statuses resolved");
    expect(summary.availableCount).toBe(4);
    expect(summary.totalCount).toBe(4);
    expect(summary.coveragePct).toBe(100);
    expect(summary.mcapSharePct).toBe(100);
    expect(summary.coverageLabel).toBe("100% with resolved freezable status");
    expect(summary.shareLabel).toBe("Resolved status market-cap reach");
    expect(summary.breakdown).toEqual([
      { key: "live", label: "live", count: 1 },
      { key: "yes", label: "yes", count: 1 },
      { key: "upstream", label: "upstream", count: 0 },
      { key: "possible", label: "possible", count: 1 },
      { key: "no", label: "no", count: 1 },
    ]);
  });
});

describe("coverage status-kind runtime exhaustiveness", () => {
  // Synthetic fixture matrix: each entry exercises a specific resolver branch.
  // Fixtures are explicit rather than mined from ACTIVE_STABLECOINS because some
  // branches (data-unavailable flags, "modeled" redemption fallback, reserves
  // "unavailable" template miss) are not reliably reached by current production
  // data and we want determinism over implicit coverage.

  const baseFlags = makeCoin().flags;
  const coin = (overrides: Partial<TestCoin> = {}) => makeCoin({ id: "x", name: "X", symbol: "X", ...overrides });
  const redemption = (overrides: Partial<RedemptionBackstopEntry> = {}) =>
    makeRedemptionEntry({ stablecoinId: "x", ...overrides });

  const liveCfg = {
    adapter: "infinifi" as const,
    version: 1 as const,
    semantics: "collateral-mix" as const,
    inputs: { primary: { kind: "http-json" as const, url: "https://example.com" } },
  };
  const curatedValidatedCfg = {
    adapter: "curated-validated" as const,
    version: 1 as const,
    semantics: "attestation-mix" as const,
    inputs: {
      primary: { kind: "onchain-evm" as const, chain: "ethereum", rpcMode: "public-rpc" as const },
    },
  };
  const proofCfg = {
    adapter: "single-asset" as const,
    version: 1 as const,
    semantics: "single-asset" as const,
    inputs: {
      primary: { kind: "onchain-evm" as const, chain: "ethereum", rpcMode: "public-rpc" as const },
    },
    params: { label: "Issuer reserves", risk: "very-low" as const },
  };

  const observed: Record<CoverageFeatureKey, Set<string>> = {
    price: new Set(),
    safety: new Set(),
    dex: new Set(),
    reserves: new Set(),
    redemption: new Set(),
    yield: new Set(),
    flows: new Set(),
    blacklist: new Set(),
    dependency: new Set(),
    mintAuthority: new Set(),
  };

  function record(key: CoverageFeatureKey, kind: string) {
    observed[key].add(kind);
  }

  // ── price ────────────────────────────────────────────────────────────────
  record("price", priceCoverageFeature.resolve(coin(), true).kind); // tracked
  record("price", priceCoverageFeature.resolve(coin(), false).kind); // missing
  record("price", priceCoverageFeature.resolve(coin({ flags: { ...baseFlags, navToken: true } }), false).kind); // price-only
  record("price", priceCoverageFeature.resolve(coin(), true, undefined, undefined, false).kind); // data-unavailable

  // ── safety ───────────────────────────────────────────────────────────────
  record("safety", safetyCoverageFeature.resolve(82).kind); // rated
  record("safety", safetyCoverageFeature.resolve(null).kind); // nr
  record("safety", safetyCoverageFeature.resolve(82, false).kind); // data-unavailable

  // ── dex ──────────────────────────────────────────────────────────────────
  record("dex", dexCoverageFeature.resolve("primary").kind);
  record("dex", dexCoverageFeature.resolve("mixed").kind);
  record("dex", dexCoverageFeature.resolve("fallback").kind);
  record("dex", dexCoverageFeature.resolve("legacy").kind);
  record("dex", dexCoverageFeature.resolve("unobserved").kind);
  record("dex", dexCoverageFeature.resolve(null).kind); // unknown
  record("dex", dexCoverageFeature.resolve("primary", false).kind); // data-unavailable

  // ── reserves ─────────────────────────────────────────────────────────────
  record("reserves", reserveCoverageFeature.resolve(coin({ liveReservesConfig: liveCfg }), true).kind); // live
  record("reserves", reserveCoverageFeature.resolve(coin({ liveReservesConfig: liveCfg }), false).kind); // live-configured
  record("reserves", reserveCoverageFeature.resolve(coin({ liveReservesConfig: liveCfg }), null).kind); // checking
  record("reserves", reserveCoverageFeature.resolve(coin({ liveReservesConfig: curatedValidatedCfg })).kind); // curated-validated
  record("reserves", reserveCoverageFeature.resolve(coin({ liveReservesConfig: proofCfg })).kind); // proof
  record(
    "reserves",
    reserveCoverageFeature.resolve(coin({ reserves: [{ name: "Cash", pct: 100, risk: "very-low" }] })).kind,
  ); // curated
  record("reserves", reserveCoverageFeature.resolve(coin()).kind); // estimated (template fallback)
  record(
    "reserves",
    reserveCoverageFeature.resolve(
      coin({
        flags: { ...baseFlags, backing: "rwa-backed", governance: "decentralized" },
      }),
    ).kind,
  ); // unavailable: no template match for rwa-decentralized
  record("reserves", reserveCoverageFeature.resolve(coin(), true, false).kind); // data-unavailable

  // ── redemption ───────────────────────────────────────────────────────────
  record("redemption", redemptionCoverageFeature.resolve(null).kind); // none
  record("redemption", redemptionCoverageFeature.resolve(undefined, false).kind); // data-unavailable
  record(
    "redemption",
    redemptionCoverageFeature.resolve(redemption({ resolutionState: "impaired", modelConfidence: "low" })).kind,
  ); // impaired
  record("redemption", redemptionCoverageFeature.resolve(redemption({ resolutionState: "missing-capacity" })).kind); // configured-unrated (non-resolved)
  record("redemption", redemptionCoverageFeature.resolve(redemption({ modelConfidence: "low" })).kind); // modeled-heuristic
  record("redemption", redemptionCoverageFeature.resolve(redemption({ capacitySemantics: "eventual-only" })).kind); // resolved-unscored
  for (const family of [
    "offchain-issuer",
    "psm-swap",
    "queue-redeem",
    "collateral-redeem",
    "stablecoin-redeem",
    "basket-redeem",
  ] as const) {
    record("redemption", redemptionCoverageFeature.resolve(redemption({ routeFamily: family })).kind);
  }
  // Trigger the "modeled" preset fallback by passing an unknown route family.
  record(
    "redemption",
    redemptionCoverageFeature.resolve(
      redemption({ routeFamily: "unknown-family" as unknown as RedemptionBackstopEntry["routeFamily"] }),
    ).kind,
  );

  // ── yield ────────────────────────────────────────────────────────────────
  record("yield", yieldCoverageFeature.resolve(true).kind); // ranked
  record("yield", yieldCoverageFeature.resolve(false).kind); // none
  record("yield", yieldCoverageFeature.resolve(true, false).kind); // data-unavailable

  // ── flows ────────────────────────────────────────────────────────────────
  for (const status of ["full", "partial-history", "lagging", "bootstrapping", "unknown", "disabled"] as const) {
    record("flows", flowCoverageFeature.resolve(status).kind);
  }
  record("flows", flowCoverageFeature.resolve(null).kind); // none
  record("flows", flowCoverageFeature.resolve("full", false).kind); // data-unavailable

  // ── blacklist ────────────────────────────────────────────────────────────
  record("blacklist", blacklistCoverageFeature.resolve(coin({ symbol: "USDC" }), true).kind); // live
  record("blacklist", blacklistCoverageFeature.resolve(coin({ symbol: "YES" }), true).kind); // yes
  record("blacklist", blacklistCoverageFeature.resolve(coin({ symbol: "DAI" }), "inherited").kind); // upstream
  record("blacklist", blacklistCoverageFeature.resolve(coin({ symbol: "USDT" }), "possible").kind);
  record("blacklist", blacklistCoverageFeature.resolve(coin({ symbol: "USDQ" }), false).kind); // no
  record("blacklist", blacklistCoverageFeature.resolve(coin({ symbol: "X" }), null).kind); // data-unavailable

  // ── dependency ───────────────────────────────────────────────────────────
  record(
    "dependency",
    dependencyCoverageFeature.resolve({
      kind: "both",
      upstreamCount: 1,
      dependentCount: 1,
      rawDependencyCount: 1,
      mappedDependencyWeight: 1,
    }).kind,
  );
  record("dependency", dependencyCoverageFeature.resolve(true).kind); // dependent via legacy boolean input
  record(
    "dependency",
    dependencyCoverageFeature.resolve({
      kind: "upstream",
      upstreamCount: 0,
      dependentCount: 1,
      rawDependencyCount: 0,
      mappedDependencyWeight: 0,
    }).kind,
  );
  record(
    "dependency",
    dependencyCoverageFeature.resolve({
      kind: "resolved-none",
      upstreamCount: 0,
      dependentCount: 0,
      rawDependencyCount: 0,
      mappedDependencyWeight: 0,
    }).kind,
  );
  record("dependency", dependencyCoverageFeature.resolve(false).kind); // unmapped-gap via legacy boolean input
  record("dependency", dependencyCoverageFeature.resolve(true, false).kind); // data-unavailable

  // ── mint authority ──────────────────────────────────────────────────────
  record("mintAuthority", mintAuthorityCoverageFeature.resolve(null).kind); // unknown
  record(
    "mintAuthority",
    mintAuthorityCoverageFeature.resolve({
      mintPath: "immutable-user-collateralized",
      authorityPosture: "none-resolved",
      confidence: "verified",
    }).kind,
  );
  record(
    "mintAuthority",
    mintAuthorityCoverageFeature.resolve({
      mintPath: "user-collateralized-governed",
      authorityPosture: "bounded-admin",
      confidence: "verified",
    }).kind,
  );
  record(
    "mintAuthority",
    mintAuthorityCoverageFeature.resolve({
      mintPath: "permissioned-minter",
      authorityPosture: "bounded-admin",
      confidence: "verified",
      controls: [
        {
          label: "Minter admin",
          authorityType: "safe",
          directMintAbility: "can-authorize",
        },
      ],
    }).kind,
  );
  record(
    "mintAuthority",
    mintAuthorityCoverageFeature.resolve({
      mintPath: "issuer-direct-mint",
      authorityPosture: "bounded-admin",
      confidence: "verified",
    }).kind,
  );
  record(
    "mintAuthority",
    mintAuthorityCoverageFeature.resolve({
      mintPath: "bridge-or-oft-synthetic",
      authorityPosture: "partially-bounded-admin",
      confidence: "manual-review",
    }).kind,
  );
  record(
    "mintAuthority",
    mintAuthorityCoverageFeature.resolve({
      mintPath: "wrapped-or-variant-inherited",
      authorityPosture: "bounded-admin",
      confidence: "probable",
    }).kind,
  );

  it.each(COVERAGE_FEATURES.map((f) => [f.key, f] as const))(
    "every observed kind for feature %s appears in its statusKinds array",
    (key, feature) => {
      const allowed = new Set(feature.statusKinds);
      const drift = [...observed[key]].filter((kind) => !allowed.has(kind));
      expect(drift, `feature ${key} produced kinds missing from statusKinds: ${drift.join(", ")}`).toEqual([]);
    },
  );

  it("exercises each documented status kind at least once across the resolver matrix", () => {
    // Inverse check: if a kind is declared in *_STATUS_KINDS but never observed,
    // either the fixture matrix has a gap or the declared kind is stale. Flag
    // both so drift in either direction is visible.
    const gaps: string[] = [];
    for (const feature of COVERAGE_FEATURES) {
      for (const kind of feature.statusKinds) {
        if (!observed[feature.key].has(kind)) {
          gaps.push(`${feature.key}/${kind}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });
});

describe("coverage legend invariant", () => {
  it("provides a legend entry (general or per-feature) for every producible status kind", async () => {
    const { COVERAGE_FEATURE_LEGEND_ITEMS, GENERAL_LEGEND_STATUS_KINDS } = await import("@/lib/coverage-features");

    const generalKinds = new Set(GENERAL_LEGEND_STATUS_KINDS);

    for (const feature of COVERAGE_FEATURES) {
      const legendKinds = new Set<string>();
      for (const item of COVERAGE_FEATURE_LEGEND_ITEMS[feature.key]) {
        for (const kind of item.kinds) {
          legendKinds.add(kind);
        }
      }
      const uncovered = feature.statusKinds.filter((kind) => !legendKinds.has(kind) && !generalKinds.has(kind));
      expect(uncovered, `feature ${feature.key} has uncovered kinds: ${uncovered.join(", ")}`).toEqual([]);
    }
  });
});
