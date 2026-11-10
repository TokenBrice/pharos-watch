import { describe, expect, it } from "vitest";
import {
  buildWeightedYieldPoolGroupSource,
  enforceExternalOpportunityTvlEligibility,
  getLendingOpportunityAbsoluteTvlFloor,
  getRequiredLendingOpportunityTvlUsd,
  scanForNewVariants,
} from "../yield-sync/resolve";
import { resolveYieldRewardShare } from "../yield-sync/evaluation";
import type { DlPool, ResolvedYield, ResolvedYieldEntry } from "../yield-sync/types";
import type { WeightedYieldPoolGroupConfig } from "../../lib/yield-config/yield-config-weighted-pools";
import type { YieldType } from "@shared/types/core";
import { derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";
import { makeDlYieldPool } from "./yield-resolve.test-support";

describe("lending opportunity TVL floors", () => {
  it("uses chain-specific floors and keeps unknown chains on the default floor", () => {
    expect(getLendingOpportunityAbsoluteTvlFloor("Monad")).toBe(25_000);
    expect(getLendingOpportunityAbsoluteTvlFloor("Stellar")).toBe(25_000);
    expect(getLendingOpportunityAbsoluteTvlFloor("unknown-chain")).toBe(100_000);
  });

  it("keeps the stablecoin-supply-relative gate above the chain floor", () => {
    expect(
      getRequiredLendingOpportunityTvlUsd({
        stablecoinId: "usdc-circle",
        poolChain: "Monad",
        stablecoinSupplyById: new Map([["usdc-circle", 500_000_000]]),
        stablecoinSupplyMapState: "ok",
      }),
    ).toBe(500_000);
  });

  it("applies the supply-share floor to GOLD/SILVER pegs (no metal bypass)", () => {
    expect(
      getRequiredLendingOpportunityTvlUsd({
        stablecoinId: "paxg-paxos",
        poolChain: "ethereum",
        stablecoinSupplyById: new Map([["paxg-paxos", 1_960_000_000]]),
        stablecoinSupplyMapState: "ok",
      }),
    ).toBe(1_960_000);
  });

  it("uses the absolute floor when a coin is absent from an otherwise valid supply map", () => {
    expect(
      getRequiredLendingOpportunityTvlUsd({
        stablecoinId: "usdc-circle",
        poolChain: "ethereum",
        stablecoinSupplyById: new Map(),
        stablecoinSupplyMapState: "ok",
      }),
    ).toBe(100_000);
  });

  it.each(["missing", "malformed"] as const)("fails closed when the bulk supply map is %s", (state) => {
    expect(
      getRequiredLendingOpportunityTvlUsd({
        stablecoinId: "usdc-circle",
        poolChain: "ethereum",
        stablecoinSupplyById: new Map(),
        stablecoinSupplyMapState: state,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("enforceExternalOpportunityTvlEligibility", () => {
  function makeYield(overrides: Partial<ResolvedYield> & { yieldType: YieldType; sourceKey: string }): ResolvedYield {
    return {
      currentApy: 4,
      apyBase: 4,
      apyReward: null,
      sourcePool: "pool-1",
      sourceTvlUsd: 1_000_000,
      dataSource: "protocol-api",
      exchangeRate: null,
      chain: "ethereum",
      ...overrides,
    };
  }

  function makeEntry(
    id: string,
    symbol: string,
    yieldOverrides: Partial<ResolvedYield> & { yieldType: YieldType; sourceKey: string },
  ): ResolvedYieldEntry {
    return { id, symbol, yield: makeYield(yieldOverrides) };
  }

  it("drops a GOLD-pegged large-cap external venue below the supply-share floor (paxg-like)", () => {
    const resolved: ResolvedYieldEntry[] = [
      makeEntry("paxg-paxos", "PAXG", {
        yieldType: "lending-opportunity",
        sourceKey: "protocol-api:ember:ethereum:paxg",
        sourceTvlUsd: 366_835,
      }),
    ];

    const drops = enforceExternalOpportunityTvlEligibility(
      resolved,
      new Map([["paxg-paxos", 1_960_000_000]]),
    );

    expect(drops).toEqual({ "tvl-null": 0, "tvl-thin": 1, "supply-unavailable": 0 });
    expect(resolved).toHaveLength(0);
  });

  it("keeps a small-cap external venue above the absolute floor (DUSD-like)", () => {
    const resolved: ResolvedYieldEntry[] = [
      makeEntry("dusd-example", "DUSD", {
        yieldType: "lending-opportunity",
        sourceKey: "defillama-auto:dusd:ethereum",
        sourceTvlUsd: 240_000,
      }),
    ];

    const drops = enforceExternalOpportunityTvlEligibility(
      resolved,
      new Map([["dusd-example", 900_000]]),
    );

    expect(drops).toEqual({ "tvl-null": 0, "tvl-thin": 0, "supply-unavailable": 0 });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.yield?.sourceKey).toBe("defillama-auto:dusd:ethereum");
  });

  it("drops null-TVL lending-opportunity while leaving null-TVL nav-appreciation intact", () => {
    const resolved: ResolvedYieldEntry[] = [
      makeEntry("usde-ethena", "USDe", {
        yieldType: "lending-opportunity",
        sourceKey: "protocol-api:maple:usde",
        sourceTvlUsd: null,
      }),
      makeEntry("sdai-maker", "sDAI", {
        yieldType: "nav-appreciation",
        sourceKey: "protocol-api:sdai-native",
        sourceTvlUsd: null,
        dataSource: "onchain",
      }),
    ];

    const drops = enforceExternalOpportunityTvlEligibility(
      resolved,
      new Map([
        ["usde-ethena", 5_000_000_000],
        ["sdai-maker", 3_000_000_000],
      ]),
    );

    expect(drops).toEqual({ "tvl-null": 1, "tvl-thin": 0, "supply-unavailable": 0 });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      id: "sdai-maker",
      yield: { yieldType: "nav-appreciation", sourceTvlUsd: null },
    });
  });

  it("drops structured-tranche candidates below the supply-share floor", () => {
    const resolved: ResolvedYieldEntry[] = [
      makeEntry("usdc-circle", "USDC", {
        yieldType: "structured-tranche",
        sourceKey: "protocol-api:royco:usdc-senior",
        sourceTvlUsd: 500_000,
      }),
    ];

    // 500M supply → 500K share floor; 500K is not strictly below, use thinner TVL
    resolved[0]!.yield!.sourceTvlUsd = 499_999;

    const drops = enforceExternalOpportunityTvlEligibility(
      resolved,
      new Map([["usdc-circle", 500_000_000]]),
    );

    expect(drops).toEqual({ "tvl-null": 0, "tvl-thin": 1, "supply-unavailable": 0 });
    expect(resolved).toHaveLength(0);
  });

  it("removes a coin when its only candidate is dropped and keeps alternate candidates", () => {
    const resolved: ResolvedYieldEntry[] = [
      makeEntry("thin-only", "THIN", {
        yieldType: "fixed-yield",
        sourceKey: "protocol-api:pendle:thin",
        sourceTvlUsd: 10_000,
      }),
      makeEntry("has-alts", "ALTS", {
        yieldType: "lending-opportunity",
        sourceKey: "protocol-api:aave:thin",
        sourceTvlUsd: 50_000,
      }),
      makeEntry("has-alts", "ALTS", {
        yieldType: "lending-opportunity",
        sourceKey: "protocol-api:aave:deep",
        sourceTvlUsd: 5_000_000,
      }),
      makeEntry("has-alts", "ALTS", {
        yieldType: "governance-set",
        sourceKey: "protocol-api:native",
        sourceTvlUsd: null,
        dataSource: "onchain",
      }),
    ];

    const drops = enforceExternalOpportunityTvlEligibility(
      resolved,
      new Map([
        ["thin-only", 2_000_000_000],
        ["has-alts", 2_000_000_000],
      ]),
    );

    expect(drops).toEqual({ "tvl-null": 0, "tvl-thin": 2, "supply-unavailable": 0 });
    expect(resolved.map((entry) => entry.yield?.sourceKey)).toEqual([
      "protocol-api:aave:deep",
      "protocol-api:native",
    ]);
    expect(resolved.some((entry) => entry.id === "thin-only")).toBe(false);
  });

  it("drops external venues when supply is unavailable (never absolute-floor alone)", () => {
    const resolved: ResolvedYieldEntry[] = [
      makeEntry("unknown-supply", "UNK", {
        yieldType: "lending-opportunity",
        sourceKey: "protocol-api:aave:ok",
        sourceTvlUsd: 150_000,
      }),
      makeEntry("zero-supply", "ZERO", {
        yieldType: "fixed-yield",
        sourceKey: "protocol-api:pendle:zero",
        sourceTvlUsd: 5_000_000,
      }),
      makeEntry("native-ok", "NAV", {
        yieldType: "nav-appreciation",
        sourceKey: "protocol-api:native",
        sourceTvlUsd: null,
        dataSource: "onchain",
      }),
    ];

    const drops = enforceExternalOpportunityTvlEligibility(
      resolved,
      new Map([["zero-supply", 0]]),
    );

    expect(drops).toEqual({ "tvl-null": 0, "tvl-thin": 0, "supply-unavailable": 2 });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.yield?.sourceKey).toBe("protocol-api:native");
  });
});

describe("scanForNewVariants", () => {
  const knownVariants = new Set(["SUSDE", "SDAI", "SUSDS"]);

  it("requires minimum TVL to avoid noise", () => {
    const pools: DlPool[] = [{
      pool: "tiny", chain: "Ethereum", project: "unknown",
      symbol: "sUSDC", tvlUsd: 1_000, apy: 10, apyBase: 10,
      apyReward: null, apyMean30d: 10, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["USDC"]);
    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    expect(results).toEqual([]);
  });

  it("discovers suffix variants at the TVL boundary and deduplicates mixed case", () => {
    // C20 — the duplicate that survives is the deepest pool, not DeFiLlama's first row.
    const results = scanForNewVariants([
      makeDlYieldPool({ pool: "smaller", symbol: "USDCEarn", tvlUsd: 500_000 }),
      makeDlYieldPool({ pool: "larger", symbol: "usdceARN", tvlUsd: 900_000 }),
    ], new Set(["USDC"]), knownVariants);
    expect(results).toEqual([{
      baseSymbol: "USDC", variantSymbol: "usdceARN", poolId: "larger",
      chain: "Ethereum", project: "maker", tvlUsd: 900_000, apy: 5,
    }]);
  });
});

function makeWeightedPool(overrides: Partial<DlPool> & Pick<DlPool, "pool" | "tvlUsd" | "apy">): DlPool {
  return makeDlYieldPool({
    project: "dtrinity-dusd",
    symbol: "SDUSD",
    apyBase: overrides.apy,
    apyMean30d: overrides.apy,
    ...overrides,
  });
}

function makeWeightedConfig(overrides: Partial<WeightedYieldPoolGroupConfig> = {}): WeightedYieldPoolGroupConfig {
  return {
    sourceKey: "defillama-weighted:test",
    yieldSource: "Test weighted source",
    yieldType: "lending-vault",
    poolIds: ["ethereum-pool", "fraxtal-pool"],
    expectedProject: "dtrinity-dusd",
    expectedSymbol: "SDUSD",
    expectedChainsByPoolId: {
      "ethereum-pool": "ethereum",
      "fraxtal-pool": "fraxtal",
      valid: "ethereum",
      "zero-tvl": "ethereum",
      multi: "ethereum",
      "only-one": "ethereum",
      spoofed: "ethereum",
    },
    ...overrides,
  };
}

describe("buildWeightedYieldPoolGroupSource", () => {
  it("builds a TVL-weighted APY row from exact DeFiLlama pool members", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeWeightedConfig(),
      [
        makeWeightedPool({ pool: "ethereum-pool", tvlUsd: 282_700, apy: 1.66 }),
        makeWeightedPool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 135_700, apy: 14.49 }),
      ],
    );

    expect(source).toMatchObject({
      sourceKey: "defillama-weighted:test",
      sourcePool: null,
      sourceTvlUsd: 418_400,
      dataSource: "defillama",
      yieldSource: "Test weighted source",
      yieldType: "lending-vault",
      project: "dtrinity-dusd",
      chain: "Ethereum, Fraxtal",
    });
    expect(source?.currentApy).toBeCloseTo(5.821164, 6);
    expect(source?.apyBase).toBeCloseTo(5.821164, 6);
    expect(source?.apyReward).toBe(0);
  });

  it.each([
    [1_000_000, 1_000_000, 0],
    [1_000_000, 3_000_000, -2.5],
  ])("includes losing constituents in the full weighted denominator (%s / %s)", (positiveTvl, negativeTvl, expectedApy) => {
    const source = buildWeightedYieldPoolGroupSource(makeWeightedConfig(), [
      makeWeightedPool({ pool: "ethereum-pool", tvlUsd: positiveTvl, apy: 5 }),
      makeWeightedPool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: negativeTvl, apy: -5 }),
    ]);
    expect(source).toMatchObject({
      currentApy: expectedApy,
      apyBase: expectedApy,
      sourceTvlUsd: positiveTvl + negativeTvl,
    });
  });

  it("drops missing, zero-TVL, and non-single-exposure member pools", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeWeightedConfig({
        poolIds: ["valid", "zero-tvl", "multi", "missing"],
      }),
      [
        makeWeightedPool({ pool: "valid", tvlUsd: 100, apy: 5 }),
        makeWeightedPool({ pool: "zero-tvl", tvlUsd: 0, apy: 50 }),
        makeWeightedPool({ pool: "multi", tvlUsd: 100, apy: 50, exposure: "multi" }),
      ],
    );

    expect(source?.sourceTvlUsd).toBe(100);
    expect(source?.currentApy).toBe(5);
  });

  it("returns null when the configured minimum member count is not met", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeWeightedConfig({
        poolIds: ["only-one", "missing"],
        minPools: 2,
      }),
      [makeWeightedPool({ pool: "only-one", tvlUsd: 100, apy: 5 })],
    );

    expect(source).toBeNull();
  });

  it.each([
    { chain: "AttackerChain" },
    { project: "attacker-project" },
    { symbol: "FAKE" },
    { stablecoin: false },
  ])("rejects an independently spoofed identity: %j", (identity) => {
    const config = makeWeightedConfig({ poolIds: ["spoofed"] });
    const accepted = makeWeightedPool({ pool: "spoofed", tvlUsd: 1_000_000, apy: 5 });
    expect(buildWeightedYieldPoolGroupSource(config, [accepted])?.currentApy).toBe(5);
    expect(buildWeightedYieldPoolGroupSource(config, [{ ...accepted, ...identity }])).toBeNull();
  });

  it("withholds unresolved components without changing total APY or TVL", () => {
    const source = buildWeightedYieldPoolGroupSource(makeWeightedConfig(), [
      makeWeightedPool({ pool: "ethereum-pool", tvlUsd: 100, apy: 4, apyBase: null, apyReward: 2 }),
      makeWeightedPool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 300, apy: 8, apyBase: 6, apyReward: null }),
    ]);
    expect(source).toMatchObject({ currentApy: 7, apyBase: null, apyReward: null, sourceTvlUsd: 400 });
  });

  it("preserves all-null base and includes zero reward in its denominator", () => {
    const source = buildWeightedYieldPoolGroupSource(makeWeightedConfig(), [
      makeWeightedPool({ pool: "ethereum-pool", tvlUsd: 100, apy: 4, apyBase: null, apyReward: 0 }),
      makeWeightedPool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 300, apy: 8, apyBase: null, apyReward: 4 }),
    ]);
    expect(source).toMatchObject({ currentApy: 7, apyBase: null, apyReward: 3 });
  });

  it("weights proven zero rewards over the same unequal TVL universe as total yield", () => {
    const source = buildWeightedYieldPoolGroupSource(makeWeightedConfig(), [
      makeWeightedPool({ pool: "ethereum-pool", tvlUsd: 412_000, apy: 3.2, apyBase: 3.2, apyReward: null }),
      makeWeightedPool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 48_000, apy: 13, apyBase: 3, apyReward: 10 }),
    ])!;
    expect(source.currentApy).toBeCloseTo((412 * 3.2 + 48 * 13) / 460);
    expect(source.apyBase).toBeCloseTo((412 * 3.2 + 48 * 3) / 460);
    expect(source.apyReward).toBeCloseTo(480 / 460);
    const rewardShare = resolveYieldRewardShare(source);
    expect(rewardShare).toBeCloseTo(480 / (412 * 3.2 + 48 * 13));
    expect(derivePysSourceRiskPenalty({ rewardShare })).toBe(derivePysSourceRiskPenalty({ rewardShare: 0 }));
    expect(derivePysSourceRiskPenalty({ rewardShare: 1 })).toBeGreaterThan(derivePysSourceRiskPenalty({ rewardShare }));
  });

  it.each([
    { apyBase: null, apyReward: 1, expectedBase: null, expectedReward: 1 },
    { apyBase: 3, apyReward: null, expectedBase: 3, expectedReward: null },
    { apyBase: 4, apyReward: null, expectedBase: 3.25, expectedReward: 0.75 },
  ])("retains only independently complete components: %j", ({ apyBase, apyReward, expectedBase, expectedReward }) => {
    const source = buildWeightedYieldPoolGroupSource(makeWeightedConfig(), [
      makeWeightedPool({ pool: "ethereum-pool", tvlUsd: 100, apy: 4, apyBase, apyReward }),
      makeWeightedPool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 300, apy: 4, apyBase: 3, apyReward: 1 }),
    ]);
    expect(source).toMatchObject({ currentApy: 4, apyBase: expectedBase, apyReward: expectedReward, sourceTvlUsd: 400 });
  });

  it("rejects weighted outputs that overflow finite numeric bounds", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeWeightedConfig({ poolIds: ["ethereum-pool"] }),
      [makeWeightedPool({ pool: "ethereum-pool", tvlUsd: 2, apy: Number.MAX_VALUE })],
    );

    expect(source).toBeNull();
  });
});
