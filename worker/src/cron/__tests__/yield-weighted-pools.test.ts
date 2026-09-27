import { describe, expect, it } from "vitest";
import { buildWeightedYieldPoolGroupSource } from "../yield-sync/weighted-pools";
import type { DlPool } from "../yield-sync/types";
import type { WeightedYieldPoolGroupConfig } from "../../lib/yield-config/yield-config-weighted-pools";
import { makeDlYieldPool } from "./yield-resolve.test-support";
import { resolveYieldRewardShare } from "../yield-sync/source-risk";
import { derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";

function makePool(overrides: Partial<DlPool> & Pick<DlPool, "pool" | "tvlUsd" | "apy">): DlPool {
  return makeDlYieldPool({
    project: "dtrinity-dusd",
    symbol: "SDUSD",
    apyBase: overrides.apy,
    apyMean30d: overrides.apy,
    ...overrides,
  });
}

function makeConfig(overrides: Partial<WeightedYieldPoolGroupConfig> = {}): WeightedYieldPoolGroupConfig {
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
      makeConfig(),
      [
        makePool({ pool: "ethereum-pool", tvlUsd: 282_700, apy: 1.66 }),
        makePool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 135_700, apy: 14.49 }),
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

  it("drops missing, zero-TVL, and non-single-exposure member pools", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeConfig({
        poolIds: ["valid", "zero-tvl", "multi", "missing"],
      }),
      [
        makePool({ pool: "valid", tvlUsd: 100, apy: 5 }),
        makePool({ pool: "zero-tvl", tvlUsd: 0, apy: 50 }),
        makePool({ pool: "multi", tvlUsd: 100, apy: 50, exposure: "multi" }),
      ],
    );

    expect(source?.sourceTvlUsd).toBe(100);
    expect(source?.currentApy).toBe(5);
  });

  it("returns null when the configured minimum member count is not met", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeConfig({
        poolIds: ["only-one", "missing"],
        minPools: 2,
      }),
      [makePool({ pool: "only-one", tvlUsd: 100, apy: 5 })],
    );

    expect(source).toBeNull();
  });

  it.each([
    { chain: "AttackerChain" },
    { project: "attacker-project" },
    { symbol: "FAKE" },
    { stablecoin: false },
  ])("rejects an independently spoofed identity: %j", (identity) => {
    const config = makeConfig({ poolIds: ["spoofed"] });
    const accepted = makePool({ pool: "spoofed", tvlUsd: 1_000_000, apy: 5 });
    expect(buildWeightedYieldPoolGroupSource(config, [accepted])?.currentApy).toBe(5);
    expect(buildWeightedYieldPoolGroupSource(config, [{ ...accepted, ...identity }])).toBeNull();
  });

  it("withholds unresolved components without changing total APY or TVL", () => {
    const source = buildWeightedYieldPoolGroupSource(makeConfig(), [
      makePool({ pool: "ethereum-pool", tvlUsd: 100, apy: 4, apyBase: null, apyReward: 2 }),
      makePool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 300, apy: 8, apyBase: 6, apyReward: null }),
    ]);
    expect(source).toMatchObject({ currentApy: 7, apyBase: null, apyReward: null, sourceTvlUsd: 400 });
  });

  it("preserves all-null base and includes zero reward in its denominator", () => {
    const source = buildWeightedYieldPoolGroupSource(makeConfig(), [
      makePool({ pool: "ethereum-pool", tvlUsd: 100, apy: 4, apyBase: null, apyReward: 0 }),
      makePool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 300, apy: 8, apyBase: null, apyReward: 4 }),
    ]);
    expect(source).toMatchObject({ currentApy: 7, apyBase: null, apyReward: 3 });
  });

  it("weights proven zero rewards over the same unequal TVL universe as total yield", () => {
    const source = buildWeightedYieldPoolGroupSource(makeConfig(), [
      makePool({ pool: "ethereum-pool", tvlUsd: 412_000, apy: 3.2, apyBase: 3.2, apyReward: null }),
      makePool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 48_000, apy: 13, apyBase: 3, apyReward: 10 }),
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
    const source = buildWeightedYieldPoolGroupSource(makeConfig(), [
      makePool({ pool: "ethereum-pool", tvlUsd: 100, apy: 4, apyBase, apyReward }),
      makePool({ pool: "fraxtal-pool", chain: "Fraxtal", tvlUsd: 300, apy: 4, apyBase: 3, apyReward: 1 }),
    ]);
    expect(source).toMatchObject({ currentApy: 4, apyBase: expectedBase, apyReward: expectedReward, sourceTvlUsd: 400 });
  });

  it("rejects weighted outputs that overflow finite numeric bounds", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeConfig({ poolIds: ["ethereum-pool"] }),
      [makePool({ pool: "ethereum-pool", tvlUsd: 2, apy: Number.MAX_VALUE })],
    );

    expect(source).toBeNull();
  });
});
