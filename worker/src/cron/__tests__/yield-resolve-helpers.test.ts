import { describe, expect, it } from "vitest";
import {
  CHAIN_LENDING_TVL_FLOOR_USD,
  enforceExternalOpportunityTvlEligibility,
  getLendingOpportunityAbsoluteTvlFloor,
  getRequiredLendingOpportunityTvlUsd,
} from "../yield-sync/resolve-helpers";
import type { ResolvedYield, ResolvedYieldEntry } from "../yield-sync/types";
import type { YieldType } from "@shared/types/core";

describe("lending opportunity TVL floors", () => {
  it("defines the exact small/pre-mainnet chain floor table", () => {
    expect(CHAIN_LENDING_TVL_FLOOR_USD).toEqual({
      aptos: 25_000,
      berachain: 25_000,
      cardano: 25_000,
      ink: 25_000,
      monad: 25_000,
      plasma: 25_000,
      solana: 25_000,
      stacks: 25_000,
      stellar: 25_000,
      sui: 25_000,
    });
  });

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
      }),
    ).toBe(500_000);
  });

  it("applies the supply-share floor to GOLD/SILVER pegs (no metal bypass)", () => {
    expect(
      getRequiredLendingOpportunityTvlUsd({
        stablecoinId: "paxg-paxos",
        poolChain: "ethereum",
        stablecoinSupplyById: new Map([["paxg-paxos", 1_960_000_000]]),
      }),
    ).toBe(1_960_000);
  });

  it("fails open to the absolute floor when supply is missing", () => {
    expect(
      getRequiredLendingOpportunityTvlUsd({
        stablecoinId: "usdc-circle",
        poolChain: "ethereum",
        stablecoinSupplyById: new Map(),
      }),
    ).toBe(100_000);
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
