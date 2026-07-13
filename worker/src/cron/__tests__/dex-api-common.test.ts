import { describe, expect, it } from "vitest";
import {
  convertToGtNewPools as convertToGtNewPoolsImpl,
  extractPriceObservations as extractPriceObservationsImpl,
  DIRECT_API_POOL_MIN_TVL_USD,
  DIRECT_API_PRICE_MIN_TVL_USD,
  hydrateDirectApiPoolMetadata,
  normalizeDexApiPoolsForMerge,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { buildChainAddressToId, buildSymbolToChainScopedIds } from "./dex-liquidity-fixtures";

const MOCK_POOL: DexApiPool = {
  source: "fluid",
  chain: "ethereum",
  poolAddress: "0xpool1",
  poolType: "fluid-dex",
  tokens: [
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
  ],
  price: 0.9998,
  tvlUsd: 500_000,
  volume24hUsd: 100_000,
  feeRate: 0.0001,
  balances: [250_000, 250_000],
};

function buildContractMetaByChainAddress(
  entries: Array<[string, { stablecoinId: string; symbol: string; decimals: number | null; source: "contract" | "tradedContract" }]>,
  chains: string[],
): Map<string, { stablecoinId: string; symbol: string; decimals: number | null; source: "contract" | "tradedContract" }> {
  const result = new Map<string, { stablecoinId: string; symbol: string; decimals: number | null; source: "contract" | "tradedContract" }>();
  for (const chain of chains) {
    for (const [address, meta] of entries) {
      result.set(`${chain.toLowerCase()}:${address.toLowerCase()}`, meta);
    }
  }
  return result;
}

function convertToGtNewPools(
  pools: DexApiPool[],
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]> = new Map(),
  trackedStablecoinPrices?: Map<string, number>,
) {
  const chains = [...new Set(pools.map((pool) => pool.chain.toLowerCase()))];
  const effectiveTrackedPrices = trackedStablecoinPrices ?? new Map(
    [...new Set(addressToId.values())].map((stablecoinId) => [stablecoinId, 1]),
  );
  return convertToGtNewPoolsImpl(
    pools,
    buildChainAddressToId(addressToId, chains),
    buildSymbolToChainScopedIds(symbolToIds, chains),
    undefined,
    effectiveTrackedPrices,
  );
}

function extractPriceObservations(
  pools: DexApiPool[],
  addressToId: Map<string, string>,
  symbolToIds: Map<string, string[]> = new Map(),
  trackedStablecoinPrices?: Map<string, number>,
) {
  const chains = [...new Set(pools.map((pool) => pool.chain.toLowerCase()))];
  const effectiveTrackedPrices = trackedStablecoinPrices ?? new Map(
    [...new Set(addressToId.values())].map((stablecoinId) => [stablecoinId, 1]),
  );
  return extractPriceObservationsImpl(
    pools,
    buildChainAddressToId(addressToId, chains),
    buildSymbolToChainScopedIds(symbolToIds, chains),
    undefined,
    effectiveTrackedPrices,
  );
}

// ---------------------------------------------------------------------------
// convertToGtNewPools
// ---------------------------------------------------------------------------
describe("convertToGtNewPools", () => {
  it("matches pool token address to stablecoin ID", () => {
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const symbolToIds = new Map<string, string[]>();
    const result = convertToGtNewPools([MOCK_POOL], addressToId, symbolToIds);
    expect(result.get("usdc")).toHaveLength(1);
    expect(result.get("usdc")![0].sourceFamily).toBe("direct_api");
    expect(result.get("usdc")![0].poolType).toBe("fluid-dex");
  });

  it("falls back to symbol matching when the token address is missing", () => {
    const addressToId = new Map<string, string>();
    const symbolToIds = new Map([["USDC", ["usdc"]]]);
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "", symbol: "USDC", decimals: 6 },
        MOCK_POOL.tokens[1]!,
      ],
    };
    const result = convertToGtNewPools([pool], addressToId, symbolToIds);
    expect(result.get("usdc")).toHaveLength(1);
  });

  it("does not fall back to symbol matching when an unknown address is present", () => {
    const addressToId = new Map<string, string>();
    const symbolToIds = new Map([["USDC", ["usdc"]]]);
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xunknown-usdc", symbol: "USDC", decimals: 6 },
        MOCK_POOL.tokens[1]!,
      ],
    };
    const result = convertToGtNewPools([pool], addressToId, symbolToIds);
    expect(result.size).toBe(0);
  });

  it("skips pools below TVL threshold", () => {
    const pool = { ...MOCK_POOL, tvlUsd: 5_000 };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    expect(result.size).toBe(0);
  });

  it("skips tokens not matching any stablecoin", () => {
    const result = convertToGtNewPools([MOCK_POOL], new Map(), new Map());
    expect(result.size).toBe(0);
  });

  it("matches both tokens when both are tracked stablecoins", () => {
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = convertToGtNewPools([MOCK_POOL], addressToId, new Map());
    expect(result.get("usdc")).toHaveLength(1);
    expect(result.get("usdt")).toHaveLength(1);
  });

  it("sets correct GtNewPool fields", () => {
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([MOCK_POOL], addressToId, new Map());
    const gtPool = result.get("usdc")![0];
    expect(gtPool.address).toBe("0xpool1");
    expect(gtPool.chain).toBe("ethereum");
    expect(gtPool.dexId).toBe("fluid");
    expect(gtPool.name).toContain("fluid:");
    expect(gtPool.tvlUsd).toBe(500_000);
    expect(gtPool.volume24hUsd).toBe(100_000);
    expect(gtPool.maturityDays).toBe(30);
    expect(gtPool.symbol).toContain("USDC");
  });

  it("derives price for token[0] using pool.price directly", () => {
    // USDC is token[0], USDT is token[1] and is a USD reference symbol
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = convertToGtNewPools([MOCK_POOL], addressToId, new Map());
    expect(result.get("usdc")![0].price).toBeCloseTo(0.9998);
  });

  it("prefers tracked stablecoin live prices over unconditional $1 quote assumptions", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xusr", symbol: "USR", decimals: 18 },
        { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      ],
      price: 0.25,
    };
    const addressToId = new Map([
      ["0xusr", "usr-resolv"],
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc-circle"],
    ]);

    const result = convertToGtNewPools(
      [pool],
      addressToId,
      new Map(),
      new Map([
        ["usr-resolv", 0.2],
        ["usdc-circle", 1],
      ]),
    );

    expect(result.get("usr-resolv")![0].price).toBeCloseTo(0.25);
    expect(result.get("usdc-circle")![0].price).toBeCloseTo(0.8);
  });

  it("inverts price for token[1]", () => {
    // Only track USDT (token[1]); USDC (token[0]) is a USD reference symbol
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = convertToGtNewPools([MOCK_POOL], addressToId, new Map());
    expect(result.get("usdt")![0].price).toBeCloseTo(1 / 0.9998);
  });

  it("sets price to 0 when pool.price is null and no priceUsd", () => {
    const pool = { ...MOCK_POOL, price: null };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    expect(result.get("usdc")![0].price).toBe(0);
  });

  it("uses address prefix when symbol is empty", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "", decimals: 6 },
        { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
      ],
    };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    const gtPool = result.get("usdc")![0];
    // First token has empty symbol so falls back to address prefix
    expect(gtPool.symbol).toContain("0xA0b86991");
  });

  it("tolerates null direct-API token symbols without crashing", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: null as unknown as string, decimals: 6 },
        { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
      ],
    };
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);

    const result = convertToGtNewPools([pool], addressToId, new Map());
    const gtPool = result.get("usdc")![0];

    expect(gtPool.symbol).toContain("0xA0b86991");
    expect(gtPool.price).toBeGreaterThan(0);
  });

  it("hydrates missing tracked token symbols from contract metadata before formatting pair labels", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      balancesNormalized: true,
      tokens: [
        { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "", decimals: 0 },
        { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "", decimals: 0 },
      ],
    };
    const chains = ["ethereum"];
    const contractMetaByChainAddress = buildContractMetaByChainAddress([
      ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", { stablecoinId: "usdc", symbol: "USDC", decimals: 6, source: "contract" }],
      ["0xdAC17F958D2ee523a2206206994597C13D831ec7", { stablecoinId: "usdt", symbol: "USDT", decimals: 6, source: "contract" }],
    ], chains);
    hydrateDirectApiPoolMetadata([pool], contractMetaByChainAddress);

    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    const gtPool = result.get("usdc")![0];

    expect(pool.tokens[0]?.symbol).toBe("USDC");
    expect(pool.tokens[0]?.decimals).toBe(6);
    expect(gtPool.symbol).toBe("USDC / USDT");
  });

  it("applies correct quality multiplier for pool type", () => {
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([MOCK_POOL], addressToId, new Map());
    // fluid-dex quality multiplier is 0.85
    expect(result.get("usdc")![0].qualityMultiplier).toBe(0.85);
  });

  it("preserves measured balance and fee detail for direct API pools", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      source: "raydium",
      poolType: "raydium-clmm",
      feeRate: 0.0001,
      balances: [200_000, 300_000],
    };
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);

    const result = convertToGtNewPools([pool], addressToId, new Map());
    const gtPool = result.get("usdc")![0];

    expect(gtPool.feeTierBps).toBe(1);
    expect(gtPool.balanceRatio).toBeCloseTo(2 / 3, 2);
    expect(gtPool.balanceDetails).toEqual([
      { symbol: "USDC", balancePct: 40, isTracked: true },
      { symbol: "USDT", balancePct: 60, isTracked: true },
    ]);
  });

  it("normalizes Balancer weighted pools against target weights", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      source: "balancer",
      poolType: "balancer-weighted",
      tokens: [
        { address: "0xusdc", symbol: "USDC", decimals: 6, priceUsd: 1, weight: 0.8 },
        { address: "0xweth", symbol: "WETH", decimals: 18, priceUsd: 1, weight: 0.2 },
      ],
      balances: [800_000, 200_000],
      feeRate: 0.003,
      price: null,
    };
    const addressToId = new Map([["0xusdc", "usdc"]]);

    const result = convertToGtNewPools([pool], addressToId, new Map());
    const gtPool = result.get("usdc")![0];

    expect(gtPool.balanceRatio).toBeCloseTo(1);
    expect(gtPool.feeTierBps).toBe(30);
  });

  it("retains a complete Raydium constant-product execution model", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      source: "raydium",
      chain: "solana",
      poolType: "raydium-amm",
      balances: [2_000_000, 2_000_000],
      balancesNormalized: true,
      feeRate: 0.0025,
      tokens: [
        { address: "UsdcMint", symbol: "USDC", decimals: 6 },
        { address: "UsdtMint", symbol: "USDT", decimals: 6 },
      ],
    };
    const addressToId = new Map([
      ["UsdcMint", "usdc-circle"],
      ["UsdtMint", "usdt-tether"],
    ]);

    const result = convertToGtNewPools([pool], addressToId, new Map());

    expect(result.get("usdc-circle")![0].ammExecutionModel).toEqual({
      source: "raydium",
      invariant: "constant-product",
      trackedTokenIndex: 0,
      feeRate: 0.0025,
      tokens: [
        expect.objectContaining({
          address: "UsdcMint",
          balance: 2_000_000,
          referencePriceUsd: 1,
          referencePriceSource: "tracked-market",
          trackedAssetId: "usdc-circle",
        }),
        expect.objectContaining({
          address: "UsdtMint",
          balance: 2_000_000,
          referencePriceUsd: 1,
          referencePriceSource: "tracked-market",
          trackedAssetId: "usdt-tether",
        }),
      ],
    });
    expect(result.get("usdt-tether")![0].ammExecutionModel?.trackedTokenIndex).toBe(1);
  });

  it("retains complete Balancer weights and source token reference prices", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      source: "balancer",
      poolType: "balancer-weighted",
      balances: [8_000_000, 2_000],
      balancesNormalized: true,
      feeRate: 0.003,
      price: null,
      tokens: [
        { address: "0xusdc", symbol: "USDC", decimals: 6, priceUsd: 1, weight: 0.8 },
        { address: "0xweth", symbol: "WETH", decimals: 18, priceUsd: 1_000, weight: 0.2 },
      ],
    };

    const result = convertToGtNewPools([pool], new Map([["0xusdc", "usdc-circle"]]), new Map());
    const model = result.get("usdc-circle")![0].ammExecutionModel;

    expect(model).toMatchObject({
      source: "balancer",
      invariant: "weighted-constant-mean",
      feeRate: 0.003,
      tokens: [
        { weight: 0.8, referencePriceUsd: 1, referencePriceSource: "source-token-usd" },
        { weight: 0.2, referencePriceUsd: 1_000, referencePriceSource: "source-token-usd" },
      ],
    });
  });

  it("does not construct execution models for CLMMs or incomplete weighted pools", () => {
    const tracked = new Map([["0xusdc", "usdc-circle"]]);
    const clmm: DexApiPool = {
      ...MOCK_POOL,
      source: "raydium",
      poolType: "raydium-clmm",
      balancesNormalized: true,
      tokens: [
        { address: "0xusdc", symbol: "USDC", decimals: 6 },
        { address: "0xusdt", symbol: "USDT", decimals: 6 },
      ],
    };
    const incompleteWeighted: DexApiPool = {
      ...clmm,
      source: "balancer",
      poolType: "balancer-weighted",
      tokens: [
        { address: "0xusdc", symbol: "USDC", decimals: 6, priceUsd: 1, weight: 0.8 },
        { address: "0xweth", symbol: "WETH", decimals: 18, priceUsd: 1_000 },
      ],
    };

    expect(convertToGtNewPools([clmm], tracked, new Map()).get("usdc-circle")![0].ammExecutionModel).toBeUndefined();
    expect(
      convertToGtNewPools([incompleteWeighted], tracked, new Map()).get("usdc-circle")![0].ammExecutionModel,
    ).toBeUndefined();
  });

  it("normalizes per-token Fluid volumes into one-sided USD volume", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "", decimals: 6 },
        { address: "0xweth", symbol: "", decimals: 18 },
      ],
      price: 0.0005,
      tokenVolumes24h: [10_000, 5],
      volume24hUsd: 10_005,
    };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc-circle"]]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    expect(result.get("usdc-circle")![0].volume24hUsd).toBeCloseTo(10_000);
  });

  it("falls back to generic quality multiplier for unknown pool types", () => {
    const pool = { ...MOCK_POOL, poolType: "unknown-pool-type" };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    expect(result.get("usdc")![0].qualityMultiplier).toBe(0.3);
  });

  it("includes pool at exactly the TVL threshold", () => {
    const pool = { ...MOCK_POOL, tvlUsd: DIRECT_API_POOL_MIN_TVL_USD };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = convertToGtNewPools([pool], addressToId, new Map());
    expect(result.get("usdc")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extractPriceObservations
// ---------------------------------------------------------------------------
describe("extractPriceObservations", () => {
  it("extracts observations for matched tokens above TVL threshold", () => {
    // USDC is token[0], USDT (token[1]) is a USD reference via address lookup
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([MOCK_POOL], addressToId, new Map());
    expect(result.get("usdc")).toHaveLength(1);
    expect(result.get("usdc")![0].price).toBeCloseTo(0.9998);
    expect(result.get("usdc")![0].protocol).toBe("fluid");
  });

  it("inverts price when stablecoin is token[1]", () => {
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([MOCK_POOL], addressToId, new Map());
    // USDT is token[1], so its price = 1 / pool.price
    const usdtObs = result.get("usdt");
    expect(usdtObs).toHaveLength(1);
    expect(usdtObs![0].price).toBeCloseTo(1 / 0.9998);
  });

  it("uses per-token priceUsd when available (Balancer)", () => {
    const balancerPool: DexApiPool = {
      ...MOCK_POOL,
      source: "balancer",
      tokens: [
        { address: "0xgho", symbol: "GHO", decimals: 18, priceUsd: 0.9995 },
        { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, priceUsd: 1.0001 },
      ],
    };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([balancerPool], addressToId, new Map());
    expect(result.get("usdc")![0].price).toBeCloseTo(1.0001);
  });

  it("skips pools with null price and no per-token priceUsd", () => {
    const pool = { ...MOCK_POOL, price: null };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    expect(result.size).toBe(0);
  });

  it("skips pools below $50K TVL", () => {
    const pool = { ...MOCK_POOL, tvlUsd: 40_000 };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    expect(result.size).toBe(0);
  });

  it("includes pool at exactly $50K TVL", () => {
    const pool = { ...MOCK_POOL, tvlUsd: DIRECT_API_PRICE_MIN_TVL_USD };
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    expect(result.get("usdc")).toHaveLength(1);
  });

  it("sets correct observation fields", () => {
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([MOCK_POOL], addressToId, new Map());
    const obs = result.get("usdc")![0];
    expect(obs.tvl).toBe(500_000);
    expect(obs.chain).toBe("ethereum");
    expect(obs.protocol).toBe("fluid");
  });

  it("does not derive price when other token is not a USD reference", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
        { address: "0xweth", symbol: "WETH", decimals: 18 },
      ],
    };
    // USDC is tracked but WETH is not a USD reference and not in addressToId
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    // No price can be derived (WETH is not a USD reference)
    expect(result.size).toBe(0);
  });

  it("derives price when other token is a tracked stablecoin (not just a USD reference symbol)", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xgho", symbol: "GHO", decimals: 18 },
        { address: "0xlusd", symbol: "LUSD", decimals: 18 },
      ],
      price: 1.002,
    };
    // GHO tracked, LUSD tracked — LUSD is both in addressToId AND a USD reference symbol
    const addressToId = new Map([
      ["0xgho", "gho-aave"],
      ["0xlusd", "lusd-liquity"],
    ]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    // GHO (token[0]): other side (LUSD) is in addressToId → price = pool.price
    expect(result.get("gho-aave")![0].price).toBeCloseTo(1.002);
    // LUSD (token[1]): other side (GHO) is in addressToId → price = 1 / pool.price
    expect(result.get("lusd-liquity")![0].price).toBeCloseTo(1 / 1.002);
  });

  it("does not treat unknown addressed USD-reference symbols as automatic $1 quotes", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xusr", symbol: "USR", decimals: 18 },
        { address: "0xspoof-usdc", symbol: "USDC", decimals: 6 },
      ],
      price: 0.25,
    };
    const addressToId = new Map([["0xusr", "usr-resolv"]]);

    const result = extractPriceObservations(
      [pool],
      addressToId,
      new Map(),
      new Map([["usr-resolv", 0.2]]),
    );

    expect(result.size).toBe(0);
  });

  it("prefers per-token priceUsd over pool.price ratio", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      source: "balancer",
      price: 0.95, // this should be ignored when priceUsd is available
      tokens: [
        { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, priceUsd: 1.0003 },
        { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6, priceUsd: 0.9999 },
      ],
    };
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    expect(result.get("usdc")![0].price).toBeCloseTo(1.0003);
    expect(result.get("usdt")![0].price).toBeCloseTo(0.9999);
  });

  it("skips observations with zero or negative derived price", () => {
    const pool: DexApiPool = {
      ...MOCK_POOL,
      price: 0,
    };
    const addressToId = new Map([["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"]]);
    const result = extractPriceObservations([pool], addressToId, new Map());
    expect(result.size).toBe(0);
  });

  it("handles multiple pools for the same stablecoin", () => {
    const pool2: DexApiPool = {
      ...MOCK_POOL,
      poolAddress: "0xpool2",
      price: 1.0001,
      chain: "arbitrum",
    };
    const addressToId = new Map([
      ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "usdc"],
      ["0xdac17f958d2ee523a2206206994597c13d831ec7", "usdt"],
    ]);
    const result = extractPriceObservations([MOCK_POOL, pool2], addressToId, new Map());
    expect(result.get("usdc")).toHaveLength(2);
    expect(result.get("usdc")![0].chain).toBe("ethereum");
    expect(result.get("usdc")![1].chain).toBe("arbitrum");
  });

  it("does not emit price observations for symbol-only matches when an unknown address is present", () => {
    const symbolToIds = new Map([["USDC", ["usdc"]]]);
    const pool: DexApiPool = {
      ...MOCK_POOL,
      tokens: [
        { address: "0xunknown-usdc", symbol: "USDC", decimals: 6 },
        MOCK_POOL.tokens[1]!,
      ],
    };
    const result = extractPriceObservations([pool], new Map(), symbolToIds);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeDexApiPoolsForMerge
// ---------------------------------------------------------------------------
describe("normalizeDexApiPoolsForMerge", () => {
  it("drops pools with invalid USD TVL units", () => {
    const result = normalizeDexApiPoolsForMerge([
      { ...MOCK_POOL, tvlUsd: Number.POSITIVE_INFINITY },
      { ...MOCK_POOL, poolAddress: "0xpool-valid" },
    ]);

    expect(result.skippedInvalidUnitCount).toBe(1);
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual(["0xpool-valid"]);
  });

  it("normalizes optional numeric fields without dropping otherwise usable pools", () => {
    const result = normalizeDexApiPoolsForMerge([
      {
        ...MOCK_POOL,
        price: -1,
        volume24hUsd: -10,
        feeRate: Number.NaN,
        balances: [250_000, -1],
        tokenVolumes24h: [1_000, Number.NaN],
        tokens: [
          { ...MOCK_POOL.tokens[0]!, priceUsd: -1, weight: Number.NaN },
          { ...MOCK_POOL.tokens[1]!, priceUsd: 1, weight: 0.5 },
        ],
      },
    ]);

    expect(result.skippedInvalidUnitCount).toBe(0);
    expect(result.pools[0]).toMatchObject({
      price: null,
      volume24hUsd: 0,
      feeRate: null,
      balances: null,
      tokenVolumes24h: null,
    });
    expect(result.pools[0]!.tokens[0]).toMatchObject({
      priceUsd: null,
      weight: null,
    });
    expect(result.pools[0]!.tokens[1]).toMatchObject({
      priceUsd: 1,
      weight: 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
// TVL threshold constants
// ---------------------------------------------------------------------------
describe("TVL threshold constants", () => {
  it("pool inclusion threshold is $10K", () => {
    expect(DIRECT_API_POOL_MIN_TVL_USD).toBe(10_000);
  });

  it("price observation threshold is $50K", () => {
    expect(DIRECT_API_PRICE_MIN_TVL_USD).toBe(50_000);
  });
});
