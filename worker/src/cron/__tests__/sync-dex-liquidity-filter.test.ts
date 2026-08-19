import { describe, expect, it } from "vitest";
import type { DexApiPool } from "../../lib/dex-api-common";
import type { LlamaPool } from "../dex-liquidity/types";
import { filterPrimaryPoolsPreferDirectApi } from "../dex-liquidity/orchestrator";

describe("filterPrimaryPoolsPreferDirectApi", () => {
  it("does not let an absurd direct-API pool suppress a healthy primary pool", () => {
    const pools: LlamaPool[] = [
      {
        pool: "0xpool",
        chain: "Fantom",
        project: "balancer-stable",
        symbol: "USDC-USDT",
        tvlUsd: 2_500_000,
        volumeUsd1d: 250_000,
        volumeUsd7d: 1_500_000,
        stablecoin: true,
        underlyingTokens: ["0xusdc", "0xusdt"],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 2,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "Fantom",
        poolAddress: "0xpool",
        poolType: "balancer-stable",
        tokens: [
          { address: "0xusdc", symbol: "USDC", decimals: 6 },
          { address: "0xusdt", symbol: "USDT", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 337_000_000_000,
        volume24hUsd: 100_000,
        feeRate: 0.0001,
        balances: [1_000_000, 1_000_000],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(1);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(0);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates an Orca DL pool via optional wildcard identity when only fee metadata is missing", () => {
    const pools: LlamaPool[] = [
      {
        pool: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
        chain: "Solana",
        project: "orca-dex",
        symbol: "SOL-USDC",
        tvlUsd: 29_000_000,
        volumeUsd1d: 2_500_000,
        volumeUsd7d: 17_000_000,
        stablecoin: false,
        underlyingTokens: [
          "So11111111111111111111111111111111111111112",
          "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1",
        ],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 20,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "orca",
        chain: "solana",
        poolAddress: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
        poolType: "orca-whirlpool",
        tokens: [
          { address: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", symbol: "USDC", decimals: 6 },
          { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
        ],
        price: 150,
        tvlUsd: 29_000_000,
        volume24hUsd: 2_500_000,
        feeRate: 0.0001,
        balances: [100_000, 200_000],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates a Balancer V3 DL stable pool via na-variant derived identity when DL omits the stable subtype", () => {
    const pools: LlamaPool[] = [
      {
        pool: "0511276f-4d37-4919-95ab-6cdf418ddd08",
        chain: "Plasma",
        project: "balancer-v3",
        symbol: "USDAI-WAPLAUSDT0",
        tvlUsd: 547_701,
        volumeUsd1d: null,
        volumeUsd7d: null,
        stablecoin: true,
        underlyingTokens: ["0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", "0xe0126f0c4451b2b917064a93040fd4770d6774b5"],
        apyBase: null,
        apyReward: null,
        apy: 1.39196,
        sigma: 0,
        exposure: "multi",
        count: 180,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "Plasma",
        poolAddress: "0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54",
        poolType: "balancer-stable",
        tokens: [
          { address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", symbol: "USDai", decimals: 18 },
          { address: "0xe0126f0c4451b2b917064a93040fd4770d6774b5", symbol: "waPlaUSDT0", decimals: 18 },
        ],
        price: 0.999939,
        tvlUsd: 547_664.8,
        volume24hUsd: 5_900.52,
        feeRate: 0.0001,
        balances: [240_716.79906230856, 301_609.539917],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByExactIdentity).toBe(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("deduplicates a DL raydium-amm stable pair against the direct Raydium pool via the tracked-pair stability hint", () => {
    // Live duplicate observed in production: DL marks USDS-USDC stable
    // (pool.stablecoin) while the direct Raydium pool type carries no
    // stability, so without the tracked-pair hint the stability buckets
    // diverge and both rows survive, double-counting ~$9.1M TVL.
    const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const pools: LlamaPool[] = [
      {
        pool: "5b6c56a9-3b81-48ee-bee7-3f0dcd862e4d",
        chain: "Solana",
        project: "raydium-amm",
        symbol: "USDS-USDC",
        tvlUsd: 9_101_152,
        volumeUsd1d: 1_034_471,
        volumeUsd7d: null,
        stablecoin: true,
        underlyingTokens: [USDS_MINT, USDC_MINT],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 20,
      },
    ];
    const directPool = (poolAddress: string, tvlUsd: number): DexApiPool => ({
      source: "raydium",
      chain: "solana",
      poolAddress,
      poolType: "raydium-amm",
      tokens: [
        { address: USDS_MINT, symbol: "USDS", decimals: 6 },
        { address: USDC_MINT, symbol: "USDC", decimals: 6 },
      ],
      price: 1,
      tvlUsd,
      volume24hUsd: tvlUsd / 9,
      feeRate: 0.0025,
      balances: [tvlUsd / 2, tvlUsd / 2],
    });
    const chainAddressToId = new Map([
      [`solana:${USDS_MINT}`, "usds-sky"],
      [`solana:${USDC_MINT}`, "usdc-circle"],
    ]);
    const singleTwin = [directPool("AS5MV3ib4bfudpsb65yfmyQwrB9nRbY4rEqMSpjwbAcT", 9_101_153)];

    const withHint = filterPrimaryPoolsPreferDirectApi(pools, singleTwin, chainAddressToId);
    expect(withHint.filteredPools).toHaveLength(0);
    expect(withHint.skippedByUniqueDerivedIdentity).toBe(1);

    // Two direct pools with the same identity keep the DL row by the deliberate
    // pool-level ambiguity guard (the DL row could be a third uncovered pool);
    // the wildcard fallback is ambiguous for the same reason.
    const ambiguousTwins = [...singleTwin, directPool("7kJb5ZQF2jWc5m9R8t2xVb4nD6yPeHhTQ3sLuNvAaBbC", 56_127)];
    const ambiguous = filterPrimaryPoolsPreferDirectApi(pools, ambiguousTwins, chainAddressToId);
    expect(ambiguous.filteredPools).toHaveLength(1);
  });

  it("deduplicates a DL Concentrated raydium-amm pool against the identical direct Raydium CLMM pool", () => {
    // Live duplicate observed in production (USDS-USDC, 2026-08-19): DL lists
    // every Raydium pool under the raydium-amm slug with the CLMM signal only
    // in poolMeta, so classifyPoolType resolved the DL row to the "generic"
    // pool-shape family while the direct CLMM row resolved to "concentrated" —
    // the derived identities never matched and the same physical pool was
    // admitted twice into total_tvl_usd.
    const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const pools: LlamaPool[] = [
      {
        pool: "5b6c56a9-3b81-48ee-bee7-3f0dcd862e4d",
        chain: "Solana",
        project: "raydium-amm",
        symbol: "USDS-USDC",
        poolMeta: "Concentrated - 0.01%",
        tvlUsd: 3_234_788,
        volumeUsd1d: 1_034_471,
        volumeUsd7d: null,
        stablecoin: true,
        underlyingTokens: [USDS_MINT, USDC_MINT],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 20,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "raydium",
        chain: "solana",
        poolAddress: "AS5MV3ib4bfudpsb65yfmyQwrB9nRbY4rEqMSpjwbAcT",
        poolType: "raydium-clmm",
        tokens: [
          { address: USDS_MINT, symbol: "USDS", decimals: 6 },
          { address: USDC_MINT, symbol: "USDC", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 3_234_790,
        volume24hUsd: 1_034_500,
        feeRate: 0.0001,
        balances: [1_617_000, 1_617_500],
      },
    ];
    const chainAddressToId = new Map([
      [`solana:${USDS_MINT}`, "usds-sky"],
      [`solana:${USDC_MINT}`, "usdc-circle"],
    ]);

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools, chainAddressToId);

    expect(result.filteredPools).toHaveLength(0);
    expect(result.skippedByUniqueDerivedIdentity).toBe(1);
  });

  it("does not use optional wildcard dedup when multiple direct API Orca pools share the same pair", () => {
    const pools: LlamaPool[] = [
      {
        pool: "4f44c5d5-b1c2-4b1c-a111-123456789abc",
        chain: "Solana",
        project: "orca-dex",
        symbol: "SOL-USDC",
        tvlUsd: 29_000_000,
        volumeUsd1d: 2_500_000,
        volumeUsd7d: 17_000_000,
        stablecoin: false,
        underlyingTokens: [
          "So11111111111111111111111111111111111111112",
          "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1",
        ],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "multi",
        count: 20,
      },
    ];
    const directApiPools: DexApiPool[] = [
      {
        source: "orca",
        chain: "solana",
        poolAddress: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
        poolType: "orca-whirlpool",
        tokens: [
          { address: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", symbol: "USDC", decimals: 6 },
          { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
        ],
        price: 150,
        tvlUsd: 29_000_000,
        volume24hUsd: 2_500_000,
        feeRate: 0.0001,
        balances: [100_000, 200_000],
      },
      {
        source: "orca",
        chain: "solana",
        poolAddress: "8k6N7m5b4V3c2X1z9Y8w7u6T5r4e3W2q1P9o8i7u6Y5",
        poolType: "orca-whirlpool",
        tokens: [
          { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
          { address: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1", symbol: "USDC", decimals: 6 },
        ],
        price: 150,
        tvlUsd: 500_000,
        volume24hUsd: 50_000,
        feeRate: 0.0005,
        balances: [10_000, 20_000],
      },
    ];

    const result = filterPrimaryPoolsPreferDirectApi(pools, directApiPools);

    expect(result.filteredPools).toHaveLength(1);
    expect(result.skippedByOptionalWildcardIdentity).toBe(0);
  });
});
