import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry, StablecoinMeta } from "@shared/types";
import type { CoverageFeatureKey } from "@/lib/coverage-types";
import {
  buildCoverageFeatureSummary,
  buildCoverageRow,
  COVERAGE_FEATURES,
  resolveBlacklistCoverage,
  resolveDependencyCoverage,
  resolveDexCoverage,
  resolveFlowCoverage,
  resolvePriceCoverage,
  resolveRedemptionCoverage,
  resolveReserveCoverage,
  resolveSafetyCoverage,
  resolveYieldCoverage,
} from "@/lib/coverage";

function makeCoin(overrides?: Partial<StablecoinMeta>): StablecoinMeta {
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
    effectiveExitScore: 65,
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

describe("coverage helpers", () => {
  it("marks NAV tokens as price-only instead of depeg-tracked", () => {
    const status = resolvePriceCoverage(
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
    expect(resolveDexCoverage("primary").label).toBe("Primary");
    expect(resolveDexCoverage("fallback").label).toBe("Fallback");
    expect(resolveDexCoverage("unobserved").available).toBe(false);
  });

  it("maps reserve sync coverage into live, curated-validated, proof, curated, or estimated states", () => {
    expect(
      resolveReserveCoverage(
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
      resolveReserveCoverage(
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
      resolveReserveCoverage(
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
      resolveReserveCoverage(
        makeCoin({
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
      ).kind,
    ).toBe("curated");

    expect(resolveReserveCoverage(makeCoin()).kind).toBe("estimated");
  });

  it("marks reserve coverage unavailable when the coverage row has no reserve data", () => {
    const status = resolveReserveCoverage(
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

    expect(resolveReserveCoverage(liveConfiguredCoin, false).kind).toBe("live-configured");
    expect(resolveReserveCoverage(liveConfiguredCoin, false).available).toBe(false);
    expect(resolveReserveCoverage(liveConfiguredCoin, null).kind).toBe("checking");
  });

  it("maps redemption route families into user-facing labels", () => {
    expect(resolveRedemptionCoverage(makeRedemptionEntry()).label).toBe("PSM");
    expect(resolveRedemptionCoverage(makeRedemptionEntry({ routeFamily: "offchain-issuer" })).label).toBe("Issuer");
    expect(resolveRedemptionCoverage(makeRedemptionEntry({ routeFamily: "queue-redeem" })).label).toBe("Queue");
    expect(resolveRedemptionCoverage(null).available).toBe(false);
  });

  it("treats configured but unrated redemption rows as unavailable coverage", () => {
    const status = resolveRedemptionCoverage(
      makeRedemptionEntry({
        score: null,
        effectiveExitScore: null,
        resolutionState: "missing-capacity",
        modelConfidence: "low",
      }),
    );

    expect(status.kind).toBe("configured-unrated");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Config.");
  });

  it("treats low-confidence redemption rows as heuristic coverage, not strong availability", () => {
    const status = resolveRedemptionCoverage(
      makeRedemptionEntry({
        modelConfidence: "low",
      }),
    );

    expect(status.kind).toBe("modeled-heuristic");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Heur.");
  });

  it("treats impaired redemption rows as unavailable coverage", () => {
    const status = resolveRedemptionCoverage(
      makeRedemptionEntry({
        score: null,
        effectiveExitScore: null,
        resolutionState: "impaired",
        routeStatus: "degraded",
        routeStatusSource: "market-implied",
        routeStatusReason: "Active severe depeg requires current live-open evidence.",
        modelConfidence: "low",
      }),
    );

    expect(status.kind).toBe("configured-unrated");
    expect(status.available).toBe(false);
    expect(status.label).toBe("Impaired");
    expect(status.detail).toContain("Active severe depeg");
  });

  it("maps mint/burn coverage states into visible labels", () => {
    expect(resolveFlowCoverage("full").label).toBe("Full");
    expect(resolveFlowCoverage("partial-history").label).toBe("Partial");
    expect(resolveFlowCoverage("bootstrapping").kind).toBe("bootstrapping");
    expect(resolveFlowCoverage("bootstrapping").spokenLabel).toBe("Bootstrapping");
    expect(resolveFlowCoverage(null).available).toBe(false);
  });

  it("emits live tracker, blacklistable, and resolved status kinds", () => {
    expect(resolveBlacklistCoverage(makeCoin({ symbol: "tGBP" }), true).kind).toBe("live");
    expect(resolveBlacklistCoverage(makeCoin({ symbol: "YES" }), true).kind).toBe("yes");
    expect(resolveBlacklistCoverage(makeCoin({ symbol: "USDT" }), "possible").kind).toBe("possible");
    expect(resolveBlacklistCoverage(makeCoin({ symbol: "DAI" }), "inherited").kind).toBe("upstream");
    expect(resolveBlacklistCoverage(makeCoin({ symbol: "USDS" }), "dilutable").kind).toBe("dilutable");
    expect(resolveBlacklistCoverage(makeCoin({ symbol: "USDQ" }), false).kind).toBe("no");
    expect(resolveBlacklistCoverage(makeCoin({ symbol: "TBD" }), null).kind).toBe("data-unavailable");
  });

  it("counts only available features when building rows", () => {
    const row = buildCoverageRow({
      coin: makeCoin({
        reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
      }),
      marketCapUsd: 1_000_000,
      hasPegCoverage: true,
      safetyScore: 82,
      dexCoverageClass: "primary",
      redemptionEntry: makeRedemptionEntry(),
      hasYieldCoverage: false,
      flowCoverageStatus: "partial-history",
      hasDependencyCoverage: false,
    });

    expect(row.coverageCount).toBe(6);
    expect(row.headlineCoverageCount).toBe(4);
    expect(row.advancedCoverageCount).toBe(5);
    expect(row.statuses.yield.available).toBe(false);
    expect(row.statuses.blacklist.available).toBe(false);
    expect(row.statuses.redemption.label).toBe("PSM");
  });

  it("builds per-feature summaries with breakdown text and market-cap share", () => {
    const rows = [
      buildCoverageRow({
        coin: makeCoin({
          id: "one",
          symbol: "ONE",
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
        marketCapUsd: 800,
        hasPegCoverage: true,
        consensusSources: ["coingecko", "defillama-list", "pyth"],
        priceConfidence: "high",
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: makeRedemptionEntry(),
        hasYieldCoverage: true,
        flowCoverageStatus: "full",
        hasDependencyCoverage: true,
      }),
      buildCoverageRow({
        coin: makeCoin({
          id: "two",
          symbol: "TWO",
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
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(
      COVERAGE_FEATURES.find((feature) => feature.key === "price")!,
      rows,
      1_000,
    );

    // headlineFilter requires sourceCount >= 3; only "one" (tracked, 3 sources) passes
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

  it("sets sourceCount and sourceNames on tracked price coverage when consensusSources provided", () => {
    const status = resolvePriceCoverage(makeCoin(), true, ["coingecko", "defillama", "pyth"], "high");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(3);
    expect(status.sourceNames).toEqual(["coingecko", "defillama", "pyth"]);
    expect(status.priceConfidence).toBe("high");
  });

  it("sets sourceCount on tracked price coverage with empty sources", () => {
    const status = resolvePriceCoverage(makeCoin(), true, [], "single-source");

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBe(0);
    expect(status.sourceNames).toEqual([]);
    expect(status.priceConfidence).toBe("single-source");
  });

  it("does not set sourceCount when consensusSources omitted (backward compat)", () => {
    const status = resolvePriceCoverage(makeCoin(), true);

    expect(status.kind).toBe("tracked");
    expect(status.sourceCount).toBeUndefined();
    expect(status.sourceNames).toBeUndefined();
    expect(status.priceConfidence).toBeUndefined();
  });

  it("includes source-depth breakdown when consensusSources are present", () => {
    const rows = [
      buildCoverageRow({
        coin: makeCoin({ id: "deep", symbol: "DEEP" }),
        marketCapUsd: 500,
        hasPegCoverage: true,
        consensusSources: ["coingecko", "defillama", "pyth", "binance", "coinbase"],
        safetyScore: null,
        dexCoverageClass: null,
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "shallow", symbol: "SHAL" }),
        marketCapUsd: 500,
        hasPegCoverage: true,
        consensusSources: ["coingecko"],
        safetyScore: null,
        dexCoverageClass: null,
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(COVERAGE_FEATURES.find((f) => f.key === "price")!, rows, 1_000);

    expect(summary.breakdown).toContainEqual({ key: "tracked", label: "tracked", count: 2 });
    expect(summary.breakdown).toContainEqual({ key: "sources-5-plus", label: "5+ sources:", count: 1 });
    expect(summary.breakdown).toContainEqual({ key: "sources-1-2", label: "1-2:", count: 1 });
  });

  it("uses score-grade live reserves as the headline metric for reserve summaries", () => {
    const rows = [
      buildCoverageRow({
        coin: makeCoin({
          id: "live",
          symbol: "LIVE",
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
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({
          id: "validated",
          symbol: "VAL",
          liveReservesConfig: {
            adapter: "curated-validated",
            version: 1,
            semantics: "attestation-mix",
            inputs: {
              primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
            },
          },
        }),
        marketCapUsd: 100,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({
          id: "proof",
          symbol: "PROOF",
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
        marketCapUsd: 100,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({
          id: "curated",
          symbol: "CUR",
          reserves: [{ name: "Cash", pct: 100, risk: "very-low" }],
        }),
        marketCapUsd: 300,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(
      COVERAGE_FEATURES.find((feature) => feature.key === "reserves")!,
      rows,
      1_000,
    );

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
      buildCoverageRow({
        coin: makeCoin({ id: "issuer", symbol: "ISS" }),
        marketCapUsd: 500,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: makeRedemptionEntry({ routeFamily: "offchain-issuer" }),
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "psm", symbol: "PSM" }),
        marketCapUsd: 300,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: makeRedemptionEntry({ routeFamily: "psm-swap" }),
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "heuristic", symbol: "HEUR" }),
        marketCapUsd: 150,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: makeRedemptionEntry({
          routeFamily: "stablecoin-redeem",
          modelConfidence: "low",
          capacityConfidence: "heuristic",
        }),
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "none", symbol: "NON" }),
        marketCapUsd: 50,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(
      COVERAGE_FEATURES.find((feature) => feature.key === "redemption")!,
      rows,
      1_000,
    );

    expect(summary.countLabel).toBe("Strong coverage");
    expect(summary.availableCount).toBe(2);
    expect(summary.totalCount).toBe(4);
    expect(summary.coveragePct).toBe(50);
    expect(summary.mcapSharePct).toBe(80);
    expect(summary.coverageLabel).toBe("50% with strong redemption coverage");
    expect(summary.shareLabel).toBe("Strong redemption market-cap reach");
    expect(summary.breakdown).toEqual([
      { key: "modeled-heuristic", label: "heuristic", count: 1 },
      { key: "configured-unrated", label: "configured", count: 0 },
      { key: "offchain-issuer", label: "issuer", count: 1 },
      { key: "psm-swap", label: "psm", count: 1 },
      { key: "queue-redeem", label: "queue", count: 0 },
      { key: "collateral-redeem", label: "collateral", count: 0 },
      { key: "stablecoin-redeem", label: "stable", count: 0 },
      { key: "basket-redeem", label: "basket", count: 0 },
      { key: "data-unavailable", label: "data n/a", count: 0 },
    ]);
  });

  it("summarizes blacklist status across every coin and surfaces live tracker coverage", () => {
    const rows = [
      buildCoverageRow({
        coin: makeCoin({ id: "tracked", symbol: "USDC" }),
        marketCapUsd: 700,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
        blacklistStatus: true,
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "untracked", symbol: "YES" }),
        marketCapUsd: 200,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
        blacklistStatus: true,
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "possible", symbol: "USDT" }),
        marketCapUsd: 500,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
        blacklistStatus: "possible",
      }),
      buildCoverageRow({
        coin: makeCoin({ id: "not-blacklistable", symbol: "NO" }),
        marketCapUsd: 100,
        hasPegCoverage: true,
        safetyScore: 82,
        dexCoverageClass: "primary",
        redemptionEntry: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
        hasDependencyCoverage: false,
        blacklistStatus: false,
      }),
    ];

    const summary = buildCoverageFeatureSummary(
      COVERAGE_FEATURES.find((feature) => feature.key === "blacklist")!,
      rows,
      1_500,
    );

    expect(summary.countLabel).toBe("Statuses resolved");
    expect(summary.availableCount).toBe(4);
    expect(summary.totalCount).toBe(4);
    expect(summary.coveragePct).toBe(100);
    expect(summary.mcapSharePct).toBe(100);
    expect(summary.coverageLabel).toBe("100% with resolved blacklist status");
    expect(summary.shareLabel).toBe("Resolved status market-cap reach");
    expect(summary.breakdown).toEqual([
      { key: "live", label: "live", count: 1 },
      { key: "yes", label: "yes", count: 1 },
      { key: "dilutable", label: "dilutable", count: 0 },
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

  const baseFlags = {
    backing: "rwa-backed" as const,
    governance: "centralized" as const,
    pegCurrency: "USD" as const,
    yieldBearing: false,
    rwa: true,
    navToken: false,
  };

  function coin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
    return { id: "x", name: "X", symbol: "X", flags: baseFlags, ...overrides };
  }

  function redemption(
    overrides: Partial<RedemptionBackstopEntry> = {},
  ): RedemptionBackstopEntry {
    return {
      stablecoinId: "x",
      score: 72,
      effectiveExitScore: 65,
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
  };

  function record(key: CoverageFeatureKey, kind: string) {
    observed[key].add(kind);
  }

  // ── price ────────────────────────────────────────────────────────────────
  record("price", resolvePriceCoverage(coin(), true).kind); // tracked
  record("price", resolvePriceCoverage(coin(), false).kind); // missing
  record(
    "price",
    resolvePriceCoverage(coin({ flags: { ...baseFlags, navToken: true } }), false).kind,
  ); // price-only
  record("price", resolvePriceCoverage(coin(), true, undefined, undefined, false).kind); // data-unavailable

  // ── safety ───────────────────────────────────────────────────────────────
  record("safety", resolveSafetyCoverage(82).kind); // rated
  record("safety", resolveSafetyCoverage(null).kind); // nr
  record("safety", resolveSafetyCoverage(82, false).kind); // data-unavailable

  // ── dex ──────────────────────────────────────────────────────────────────
  record("dex", resolveDexCoverage("primary").kind);
  record("dex", resolveDexCoverage("mixed").kind);
  record("dex", resolveDexCoverage("fallback").kind);
  record("dex", resolveDexCoverage("legacy").kind);
  record("dex", resolveDexCoverage("unobserved").kind);
  record("dex", resolveDexCoverage(null).kind); // unknown
  record("dex", resolveDexCoverage("primary", false).kind); // data-unavailable

  // ── reserves ─────────────────────────────────────────────────────────────
  record("reserves", resolveReserveCoverage(coin({ liveReservesConfig: liveCfg }), true).kind); // live
  record(
    "reserves",
    resolveReserveCoverage(coin({ liveReservesConfig: liveCfg }), false).kind,
  ); // live-configured
  record(
    "reserves",
    resolveReserveCoverage(coin({ liveReservesConfig: liveCfg }), null).kind,
  ); // checking
  record(
    "reserves",
    resolveReserveCoverage(coin({ liveReservesConfig: curatedValidatedCfg })).kind,
  ); // curated-validated
  record("reserves", resolveReserveCoverage(coin({ liveReservesConfig: proofCfg })).kind); // proof
  record(
    "reserves",
    resolveReserveCoverage(coin({ reserves: [{ name: "Cash", pct: 100, risk: "very-low" }] })).kind,
  ); // curated
  record("reserves", resolveReserveCoverage(coin()).kind); // estimated (template fallback)
  record(
    "reserves",
    resolveReserveCoverage(
      coin({
        flags: { ...baseFlags, backing: "rwa-backed", governance: "decentralized" },
      }),
    ).kind,
  ); // unavailable: no template match for rwa-decentralized
  record("reserves", resolveReserveCoverage(coin(), true, false).kind); // data-unavailable

  // ── redemption ───────────────────────────────────────────────────────────
  record("redemption", resolveRedemptionCoverage(null).kind); // none
  record("redemption", resolveRedemptionCoverage(undefined, false).kind); // data-unavailable
  record(
    "redemption",
    resolveRedemptionCoverage(
      redemption({ resolutionState: "impaired", modelConfidence: "low" }),
    ).kind,
  ); // configured-unrated (impaired)
  record(
    "redemption",
    resolveRedemptionCoverage(redemption({ resolutionState: "missing-capacity" })).kind,
  ); // configured-unrated (non-resolved)
  record(
    "redemption",
    resolveRedemptionCoverage(redemption({ modelConfidence: "low" })).kind,
  ); // modeled-heuristic
  for (const family of [
    "offchain-issuer",
    "psm-swap",
    "queue-redeem",
    "collateral-redeem",
    "stablecoin-redeem",
    "basket-redeem",
  ] as const) {
    record("redemption", resolveRedemptionCoverage(redemption({ routeFamily: family })).kind);
  }
  // Trigger the "modeled" preset fallback by passing an unknown route family.
  record(
    "redemption",
    resolveRedemptionCoverage(
      redemption({ routeFamily: "unknown-family" as unknown as RedemptionBackstopEntry["routeFamily"] }),
    ).kind,
  );

  // ── yield ────────────────────────────────────────────────────────────────
  record("yield", resolveYieldCoverage(true).kind); // ranked
  record("yield", resolveYieldCoverage(false).kind); // none
  record("yield", resolveYieldCoverage(true, false).kind); // data-unavailable

  // ── flows ────────────────────────────────────────────────────────────────
  for (const status of [
    "full",
    "partial-history",
    "lagging",
    "bootstrapping",
    "disabled",
  ] as const) {
    record("flows", resolveFlowCoverage(status).kind);
  }
  record("flows", resolveFlowCoverage(null).kind); // none
  record("flows", resolveFlowCoverage("full", false).kind); // data-unavailable

  // ── blacklist ────────────────────────────────────────────────────────────
  record("blacklist", resolveBlacklistCoverage(coin({ symbol: "USDC" }), true).kind); // live
  record("blacklist", resolveBlacklistCoverage(coin({ symbol: "YES" }), true).kind); // yes
  record("blacklist", resolveBlacklistCoverage(coin({ symbol: "USDS" }), "dilutable").kind);
  record("blacklist", resolveBlacklistCoverage(coin({ symbol: "DAI" }), "inherited").kind); // upstream
  record("blacklist", resolveBlacklistCoverage(coin({ symbol: "USDT" }), "possible").kind);
  record("blacklist", resolveBlacklistCoverage(coin({ symbol: "USDQ" }), false).kind); // no
  record("blacklist", resolveBlacklistCoverage(coin({ symbol: "X" }), null).kind); // data-unavailable

  // ── dependency ───────────────────────────────────────────────────────────
  record("dependency", resolveDependencyCoverage(true).kind); // node
  record("dependency", resolveDependencyCoverage(false).kind); // none
  record("dependency", resolveDependencyCoverage(true, false).kind); // data-unavailable

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
    const {
      COVERAGE_FEATURE_LEGEND_ITEMS,
      GENERAL_LEGEND_STATUS_KINDS,
    } = await import("@/lib/coverage-features");

    const generalKinds = new Set(GENERAL_LEGEND_STATUS_KINDS);

    for (const feature of COVERAGE_FEATURES) {
      const legendKinds = new Set<string>();
      for (const item of COVERAGE_FEATURE_LEGEND_ITEMS[feature.key]) {
        for (const kind of item.kinds) {
          legendKinds.add(kind);
        }
      }
      const uncovered = feature.statusKinds.filter(
        (kind) => !legendKinds.has(kind) && !generalKinds.has(kind),
      );
      expect(uncovered, `feature ${feature.key} has uncovered kinds: ${uncovered.join(", ")}`).toEqual([]);
    }
  });
});
