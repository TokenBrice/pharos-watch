import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurvePoolEntry, LlamaPool } from "../dex-liquidity/types";
import { processPoolMetrics } from "../dex-liquidity/process-pools";

function makePool(overrides: Partial<LlamaPool>): LlamaPool {
  return {
    pool: "0xpool",
    chain: "Ethereum",
    project: "curve",
    symbol: "USDT-USDC",
    tvlUsd: 100_000,
    volumeUsd1d: 10_000,
    volumeUsd7d: 70_000,
    stablecoin: true,
    underlyingTokens: null,
    apyBase: null,
    apyReward: null,
    apy: 0,
    sigma: 0,
    exposure: "multi",
    count: 0,
    ...overrides,
  };
}

function makeCurveEntry(overrides: Partial<CurvePoolEntry>): CurvePoolEntry {
  return {
    A: 100,
    balanceRatio: 0.8,
    tvl: 1_000_000,
    registryId: "stableswap",
    isMetaPool: false,
    metapoolAdjustedTvl: 900_000,
    creationTs: 0,
    balanceDetails: [],
    tokenPrices: {},
    ...overrides,
  };
}

function buildChainAddressToId(
  addressToId: Map<string, string>,
  chains: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const chain of chains) {
    for (const [address, stablecoinId] of addressToId) {
      result.set(`${chain.toLowerCase()}:${address.toLowerCase()}`, stablecoinId);
    }
  }
  return result;
}

function buildSymbolToChainScopedIds(
  symbolToIds: Map<string, string[]>,
  chains: string[],
): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();
  for (const [symbol, ids] of symbolToIds) {
    const scoped = new Map<string, string[]>();
    for (const chain of chains) {
      scoped.set(chain.toLowerCase(), [...ids]);
    }
    result.set(symbol.trim().toUpperCase(), scoped);
  }
  return result;
}

describe("processPoolMetrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches pools without mutating canonical addresses, protects symbol collisions, and enriches pool extras", () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([
      ["USDT", ["usdt-tether"]],
      ["USDC", ["usdc-circle"]],
      ["USDE", ["usde-ethena"]],
      ["DAI", ["dai-makerdao"]],
      ["CUSD", ["cusd-cap", "cusd-celo"]],
    ]);
    const addressToId = new Map<string, string>([["0xusdt", "usdt-tether"]]);
    const chains = ["ethereum", "base"];
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, chains);
    const chainAddressToId = buildChainAddressToId(addressToId, chains);
    const dexProjects = new Set(["curve", "uniswap-v3", "aerodrome", "sushiswap"]);

    const curvePoolMap = new Map<string, CurvePoolEntry>([
      [
        "ethereum:0xcurve1",
        makeCurveEntry({
          A: 700,
          balanceRatio: 0.8,
          registryId: "main-stableswap",
          metapoolAdjustedTvl: 900_000,
          creationTs: Math.floor(nowMs / 1000) - 200 * 86_400,
          balanceDetails: [
            { symbol: "USDT", balancePct: 0.52, isTracked: true },
            { symbol: "USDC", balancePct: 0.48, isTracked: true },
          ],
        }),
      ],
      [
        "ethereum:USDC-USDT",
        makeCurveEntry({
          A: 80,
          balanceRatio: 0.5,
          registryId: "tricrypto-factory",
          isMetaPool: true,
          metapoolAdjustedTvl: 300_000,
          creationTs: Math.floor(nowMs / 1000) - 100 * 86_400,
          balanceDetails: [
            { symbol: "USDT", balancePct: 0.5, isTracked: true },
            { symbol: "USDC", balancePct: 0.5, isTracked: true },
          ],
        }),
      ],
    ]);
    const uniV3PoolFees = new Map<string, number>([["ethereum:0xuni1", 100]]);
    const uniV3SymbolFees = new Map<string, number>([["ethereum:USDC:USDE", 3000]]);
    const aerodromeIsStable = new Map<string, boolean>([["base:0xaero", true]]);

    const metrics = processPoolMetrics(
      [
        makePool({ pool: "0xdust", tvlUsd: 5_000 }),
        makePool({ pool: "0xabsurd", tvlUsd: 2e12 }),
        makePool({ pool: "0xblocked", project: "retro", tvlUsd: 50_000 }),
        makePool({ pool: "0xnotdex", project: "not-in-whitelist", tvlUsd: 50_000 }),
        makePool({ pool: "0xlending", exposure: "single", tvlUsd: 50_000 }),
        makePool({
          pool: "0xcurve1",
          project: "curve",
          symbol: "USDT-USDC",
          tvlUsd: 1_000_000,
          volumeUsd1d: 200_000,
          volumeUsd7d: 1_400_000,
          underlyingTokens: ["0xusdt", "0xusdc-new"],
          apyBase: 4,
          apy: 10,
          count: 30,
        }),
        makePool({
          pool: "0xcurve2",
          project: "curve",
          symbol: "USDT-USDC",
          tvlUsd: 750_000,
          volumeUsd1d: 60_000,
          volumeUsd7d: 420_000,
        }),
        makePool({
          pool: "0xuni1",
          project: "uniswap-v3",
          symbol: "USDT-DAI",
          tvlUsd: 500_000,
          volumeUsd1d: 100_000,
          volumeUsd7d: 700_000,
          apyBase: 0.02,
          apy: 0.005,
          count: 45,
        }),
        makePool({
          pool: "0xuni2",
          project: "uniswap-v3",
          symbol: "USDC-USDE",
          tvlUsd: 400_000,
          volumeUsd1d: 80_000,
          volumeUsd7d: 560_000,
          apyBase: 0,
          apy: 0,
          count: 20,
        }),
        makePool({
          pool: "0xaero",
          chain: "Base",
          project: "aerodrome",
          symbol: "USDC-USDT",
          tvlUsd: 300_000,
          volumeUsd1d: 90_000,
          volumeUsd7d: 630_000,
          count: 12,
        }),
        makePool({
          pool: "0xcollision",
          project: "sushiswap",
          symbol: "CUSD-USDT",
          tvlUsd: 200_000,
          volumeUsd1d: 50_000,
          volumeUsd7d: 350_000,
          count: 10,
        }),
      ],
      dexProjects,
      symbolToIds,
      symbolToChainScopedIds,
      addressToId,
      chainAddressToId,
      curvePoolMap,
      uniV3PoolFees,
      uniV3SymbolFees,
      aerodromeIsStable,
    );

    expect(chainAddressToId.get("ethereum:0xusdc-new")).toBeUndefined();
    expect(metrics.has("cusd-cap")).toBe(false);
    expect(metrics.has("cusd-celo")).toBe(false);

    const usdt = metrics.get("usdt-tether");
    expect(usdt).toBeDefined();
    expect(usdt?.totalTvlUsd).toBe(2_750_000);
    expect(usdt?.poolCount).toBe(5);
    expect(usdt?.protocolTvl).toEqual({
      curve: 1_750_000,
      "uniswap-v3": 500_000,
      aerodrome: 300_000,
      sushiswap: 200_000,
    });
    expect(usdt?.chainTvl).toEqual({
      Ethereum: 2_450_000,
      Base: 300_000,
    });
    expect(usdt?.totalTvlForBalance).toBe(1_750_000);
    expect(usdt?.organicTvlWeightedSum).toBe(900_000);
    expect(usdt?.totalTvlForOrganic).toBe(1_500_000);
    expect(usdt?.oldestPoolDays).toBe(200);

    const curveAddressPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:0xcurve1");
    expect(curveAddressPool).toMatchObject({
      poolType: "curve-stableswap-high-a",
      extra: {
        amplificationCoefficient: 700,
        balanceRatio: 0.8,
        registryId: "main-stableswap",
        isMetaPool: false,
        organicFraction: 0.4,
        pairQuality: 1,
        maturityDays: 200,
      },
    });
    expect(curveAddressPool?.extra?.effectiveTvl).toBe(643988);

    const curveFallbackPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:0xcurve2");
    expect(curveFallbackPool).toMatchObject({
      poolType: "curve-cryptoswap",
      extra: {
        amplificationCoefficient: 80,
        isMetaPool: true,
        registryId: "tricrypto-factory",
        maturityDays: 100,
      },
    });
    expect(curveFallbackPool?.extra?.effectiveTvl).toBe(132583);

    const uniAddressPool = usdt?.topPools.find((pool) => pool.poolId === "ethereum:0xuni1");
    expect(uniAddressPool).toMatchObject({
      poolType: "uniswap-v3-1bp",
      extra: {
        feeTier: 1,
        organicFraction: 1,
        maturityDays: 45,
      },
    });

    const usdc = metrics.get("usdc-circle");
    expect(usdc?.poolCount).toBe(3);
    expect(usdc?.totalTvlUsd).toBe(1_450_000);

    const uniSymbolPool = usdc?.topPools.find((pool) => pool.poolId === "ethereum:0xuni2");
    expect(uniSymbolPool).toMatchObject({
      poolType: "uniswap-v3-30bp",
      extra: {
        feeTier: 30,
        organicFraction: 0,
        maturityDays: 20,
      },
    });

    const aerodromePool = usdc?.topPools.find((pool) => pool.poolId === "base:0xaero");
    expect(aerodromePool?.poolType).toBe("aerodrome-stable");

    const usde = metrics.get("usde-ethena");
    expect(usde?.poolCount).toBe(1);
    expect(usde?.topPools[0]?.poolType).toBe("uniswap-v3-30bp");
  });

  it("does not learn wrapper addresses from positional DeFiLlama symbols", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const symbolToIds = new Map<string, string[]>([
      ["USR", ["usr-resolv"]],
    ]);
    const symbolToChainScopedIds = buildSymbolToChainScopedIds(symbolToIds, ["base"]);
    const chainAddressToId = new Map<string, string>([
      ["base:0xusr", "usr-resolv"],
    ]);

    const metrics = processPoolMetrics(
      [
        makePool({
          chain: "Base",
          project: "curve",
          symbol: "AAVEGHO-USR",
          underlyingTokens: ["0xusr", "0xwabasgho"],
          tvlUsd: 200_000,
          volumeUsd1d: 50_000,
          volumeUsd7d: 350_000,
        }),
      ],
      new Set(["curve"]),
      symbolToIds,
      symbolToChainScopedIds,
      new Map(),
      chainAddressToId,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(chainAddressToId.get("base:0xwabasgho")).toBeUndefined();
    expect(metrics.get("usr-resolv")?.poolCount).toBe(1);
    expect(metrics.get("usr-resolv")?.totalTvlUsd).toBe(200_000);
  });

  it("disables the DEX whitelist filter when the project index is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "0xfree",
          project: "unknown-dex",
          symbol: "USDT-USDC",
          tvlUsd: 75_000,
          volumeUsd1d: 9_000,
        }),
      ],
      new Set(),
      new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]),
      buildSymbolToChainScopedIds(new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]), ["ethereum"]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "[dex-liquidity] DEX project index is empty — project whitelist filter disabled for this run",
    );
    expect(metrics.get("usdt-tether")?.poolCount).toBe(1);
    expect(metrics.get("usdc-circle")?.poolCount).toBe(1);
  });

  it("skips blocked dead DEX variants including bunni", () => {
    const metrics = processPoolMetrics(
      [
        makePool({
          pool: "0xbunni-root",
          project: "bunni",
          symbol: "USDT-USDC",
          underlyingTokens: ["0xusdt", "0xusdc"],
        }),
        makePool({
          pool: "0xbunni-eth",
          project: "bunni-ethereum",
          symbol: "USDT-USDC",
          underlyingTokens: ["0xusdt", "0xusdc"],
        }),
      ],
      new Set(["bunni", "bunni-ethereum"]),
      new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]),
      buildSymbolToChainScopedIds(new Map([
        ["USDT", ["usdt-tether"]],
        ["USDC", ["usdc-circle"]],
      ]), ["ethereum"]),
      new Map(),
      new Map([
        ["ethereum:0xusdt", "usdt-tether"],
        ["ethereum:0xusdc", "usdc-circle"],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(metrics.size).toBe(0);
  });

  it("ignores organicFraction when apyBase is NaN", () => {
    const pool = makePool({ apyBase: NaN, apy: 5, symbol: "USDT-USDC" });
    const metrics = processPoolMetrics(
      [pool],
      new Set(["curve"]),
      new Map([["USDT", ["usdt-tether"]], ["USDC", ["usdc-circle"]]]),
      buildSymbolToChainScopedIds(new Map([["USDT", ["usdt-tether"]], ["USDC", ["usdc-circle"]]]), ["ethereum"]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    const m = metrics.get("usdt-tether");
    expect(m).toBeDefined();
    // NaN apyBase should not mark organic fraction as measured
    expect(m!.totalTvlForOrganic).toBe(0);
  });

  it("uses apyBase fallback when apy is Infinity (avoids NaN from division)", () => {
    const pool = makePool({ apyBase: 3, apy: Infinity, symbol: "USDT-USDC" });
    const metrics = processPoolMetrics(
      [pool],
      new Set(["curve"]),
      new Map([["USDT", ["usdt-tether"]], ["USDC", ["usdc-circle"]]]),
      buildSymbolToChainScopedIds(new Map([["USDT", ["usdt-tether"]], ["USDC", ["usdc-circle"]]]), ["ethereum"]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
    const m = metrics.get("usdt-tether");
    expect(m).toBeDefined();
    // apyBase is finite and positive → else-if branch sets organicFraction=1.0
    expect(m!.totalTvlForOrganic).toBe(100_000);
  });

  it("normalizes top-pool project labels for DeFiLlama Orca rows", () => {
    const metrics = processPoolMetrics(
      [
        makePool({
          chain: "Solana",
          project: "orca-dex",
          symbol: "USDC-USDT",
          underlyingTokens: ["EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus"],
          tvlUsd: 500_000,
          volumeUsd1d: 100_000,
          volumeUsd7d: 700_000,
        }),
      ],
      new Set(["orca-dex"]),
      new Map([
        ["USDC", ["usdc-circle"]],
        ["USDT", ["usdt-tether"]],
      ]),
      buildSymbolToChainScopedIds(new Map([
        ["USDC", ["usdc-circle"]],
        ["USDT", ["usdt-tether"]],
      ]), ["solana"]),
      new Map(),
      new Map([
        ["solana:epjfwdd5aufqssqem2qa5n8y7w5a4d8nqv1f6p5a6x1", "usdc-circle"],
        ["solana:es9vmfrzacermjfrf4h2fy6q2jve4yjzs83p2wm8wus", "usdt-tether"],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(metrics.get("usdc-circle")?.topPools[0]?.project).toBe("orca");
    expect(metrics.get("usdt-tether")?.topPools[0]?.project).toBe("orca");
  });
});
