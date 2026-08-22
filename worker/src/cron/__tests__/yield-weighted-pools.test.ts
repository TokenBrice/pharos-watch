import { describe, expect, it } from "vitest";
import { buildWeightedYieldPoolGroupSource } from "../yield-sync/weighted-pools";
import type { DlPool } from "../yield-sync/types";
import type { WeightedYieldPoolGroupConfig } from "../../lib/yield-config/yield-config-weighted-pools";

function makePool(overrides: Partial<DlPool> & Pick<DlPool, "pool" | "tvlUsd" | "apy">): DlPool {
  return {
    ...overrides,
    pool: overrides.pool,
    chain: overrides.chain ?? "Ethereum",
    project: overrides.project ?? "dtrinity-dusd",
    symbol: overrides.symbol ?? "SDUSD",
    tvlUsd: overrides.tvlUsd,
    apy: overrides.apy,
    apyBase: overrides.apyBase ?? overrides.apy,
    apyReward: overrides.apyReward ?? null,
    apyMean30d: overrides.apyMean30d ?? overrides.apy,
    stablecoin: overrides.stablecoin ?? true,
    exposure: overrides.exposure ?? "single",
    underlyingTokens: overrides.underlyingTokens ?? [],
  };
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
    expect(source?.apyReward).toBeNull();
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

  it("rejects spoofed weighted members whose identity metadata does not match the curated pool", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeConfig({ poolIds: ["spoofed"] }),
      [
        makePool({
          pool: "spoofed",
          tvlUsd: 1_000_000,
          apy: 987.65,
          chain: "AttackerChain",
          project: "attacker-project",
          symbol: "FAKE",
          stablecoin: false,
        }),
      ],
    );

    expect(source).toBeNull();
  });

  it("rejects weighted outputs that overflow finite numeric bounds", () => {
    const source = buildWeightedYieldPoolGroupSource(
      makeConfig({ poolIds: ["ethereum-pool"] }),
      [makePool({ pool: "ethereum-pool", tvlUsd: 2, apy: Number.MAX_VALUE })],
    );

    expect(source).toBeNull();
  });
});
