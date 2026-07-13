import { afterEach, describe, expect, it, vi } from "vitest";
import { STAGED_POOL_MAX_TVL_USD, stagedPoolConfidence, stagedPoolMaturityDays } from "../../dex-discovery/types";
import { mergeStagedPools } from "../staging-merge";
import type { AuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases";
import {
  buildPoolIdentity,
  createKnownPoolIdentityIndex,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "../pool-identity";

function createMockDb(results: unknown[] | (() => Promise<{ results: unknown[] }>)): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: typeof results === "function" ? results : async () => ({ results }),
      }),
    }),
  } as unknown as D1Database;
}

function makeKnownPoolIndex(entries: string[] = []): KnownPoolIdentityIndex {
  const known = createKnownPoolIdentityIndex();
  for (const entry of entries) {
    if (entry.startsWith("derived:")) {
      const [, chain, protocol, baseToken, quoteToken, poolType, feeTierBps, isStable] = entry.split(":");
      registerKnownPoolIdentity(
        known,
        buildPoolIdentity({
          chain,
          protocol,
          tokenAddresses: [baseToken ?? "", quoteToken ?? ""],
          poolType: poolType === "na" ? null : poolType,
          feeTierBps: feeTierBps === "na" ? null : Number(feeTierBps),
          isStable: isStable === "na" ? null : isStable === "stable",
        }),
      );
      continue;
    }

    const [chain, poolAddressOrId] = entry.split(":");
    registerKnownPoolIdentity(
      known,
      buildPoolIdentity({
        chain,
        protocol: "test",
        poolAddressOrId,
        tokenAddresses: [],
      }),
    );
  }
  return known;
}

function makeAuthoritativeConfirmationIndex(
  entries: Array<{
    protocol: string;
    chains: string[];
    exactPoolKeys?: string[];
  }>,
): AuthoritativeStagedPoolConfirmationIndex {
  const enforcedChainsByProtocol = new Map<string, Set<string>>();
  const confirmedExactKeysByProtocol = new Map<string, Set<string>>();

  for (const entry of entries) {
    enforcedChainsByProtocol.set(entry.protocol, new Set(entry.chains));
    confirmedExactKeysByProtocol.set(entry.protocol, new Set(entry.exactPoolKeys ?? []));
  }

  return {
    enforcedChainsByProtocol,
    confirmedExactKeysByProtocol,
  };
}

describe("stagedPoolConfidence", () => {
  it("returns 1.0 for freshly refreshed pool", () => {
    expect(stagedPoolConfidence(0)).toBe(1);
  });

  it("returns 0.75 for 12-hour-old pool", () => {
    expect(stagedPoolConfidence(12)).toBe(0.75);
  });

  it("returns 0.5 for 24-hour-old pool", () => {
    expect(stagedPoolConfidence(24)).toBe(0.5);
  });

  it("returns 0 for pool older than 24h", () => {
    expect(stagedPoolConfidence(25)).toBe(0);
  });

  it("returns 0 just past the 24h horizon (60s read-window grace makes the skip guard reachable)", () => {
    // The DB read window extends to nowSec - DAY_SECONDS - 60, so a row aged
    // just over 24h can be fetched; it must score 0 so the stale_confidence_zero
    // skip guard in mergeStagedPools actually fires.
    expect(stagedPoolConfidence(24 + 30 / 3600)).toBe(0);
  });

  it("clamps negative age to 0 (clock skew protection)", () => {
    expect(stagedPoolConfidence(-5)).toBe(1);
  });
});

describe("stagedPoolMaturityDays", () => {
  it("computes days since discovery", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now - 86400 * 10, now)).toBe(10);
  });

  it("caps at 30 days", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now - 86400 * 60, now)).toBe(30);
  });

  it("returns 0 for future discovery (clock skew)", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now + 1000, now)).toBe(0);
  });
});

describe("mergeStagedPools", () => {
  const exactPoolAddress = "0x0000000000000000000000000000000000000abc";
  const secondExactPoolAddress = "0x0000000000000000000000000000000000000def";
  const newPoolAddress = "0x0000000000000000000000000000000000000fed";
  const baseToken = "0x00000000000000000000000000000000000000b1";
  const quoteToken = "0x00000000000000000000000000000000000000c2";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains case-distinct Solana staged pools as separate identities", async () => {
    const now = 1_710_000_000;
    const upperPool = "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc";
    const lowerPool = "9j7m8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc";
    const makeRow = (poolId: string) => ({
      pool_id: `solana:${poolId}`,
      stablecoin_id: "usdc-circle",
      source: "gecko_terminal",
      chain: "solana",
      protocol: "raydium",
      dex_id: "raydium",
      symbol: "USDC/USDT",
      tvl_usd: 100_000,
      volume_24h: 50_000,
      quality_multiplier: 0.8,
      pool_type: "raydium-amm",
      fee_tier: 25,
      balance_ratio: 1,
      is_stable: 1,
      base_token: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1",
      quote_token: "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus",
      quote_symbol: "USDT",
      price_usd: 1,
      locked_liq_pct: null,
      raw_json: null,
      discovered_at: now - 86_400,
      refreshed_at: now,
    });
    const metrics = new Map();

    const result = await mergeStagedPools(
      createMockDb([makeRow(upperPool), makeRow(lowerPool)]),
      metrics as never,
      makeKnownPoolIndex(),
      now,
    );

    expect(result.mergedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(metrics.get("usdc-circle")?.topPools.map((pool: { poolId: string }) => pool.poolId)).toEqual([
      `solana:${upperPool}`,
      `solana:${lowerPool}`,
    ]);
  });

  it("supersedes an older legacy-lowercase Solana row with its corrected identity", async () => {
    const now = 1_710_000_000;
    const correctedPool = "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc";
    const correctedBase = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
    const correctedQuote = "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus";
    const makeRow = (poolId: string, base: string, quote: string, refreshedAt: number) => ({
      pool_id: `solana:${poolId}`,
      stablecoin_id: "usdc-circle",
      source: "gecko_terminal",
      chain: "solana",
      protocol: "raydium",
      dex_id: "raydium",
      symbol: "USDC/USDT",
      tvl_usd: 100_000,
      volume_24h: 50_000,
      quality_multiplier: 0.8,
      pool_type: "raydium-amm",
      fee_tier: 25,
      balance_ratio: 1,
      is_stable: 1,
      base_token: base,
      quote_token: quote,
      quote_symbol: "USDT",
      price_usd: 1,
      locked_liq_pct: null,
      raw_json: null,
      discovered_at: now - 86_400,
      refreshed_at: refreshedAt,
    });
    const metrics = new Map();
    const result = await mergeStagedPools(
      createMockDb([
        makeRow(correctedPool.toLowerCase(), correctedBase.toLowerCase(), correctedQuote.toLowerCase(), now - 60),
        makeRow(correctedPool, correctedBase, correctedQuote, now),
      ]),
      metrics as never,
      makeKnownPoolIndex(),
      now,
    );

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipDimensions).toContainEqual(
      expect.objectContaining({ reason: "legacy_lowercase_identity_superseded", count: 1 }),
    );
    expect(metrics.get("usdc-circle")?.topPools.map((pool: { poolId: string }) => pool.poolId)).toEqual([
      `solana:${correctedPool}`,
    ]);
  });

  it("returns zero counts with empty staging table", async () => {
    const mockDb = createMockDb([]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.skipDimensions).toEqual([]);
  });

  it("does not modify metrics when staging table is empty", async () => {
    const mockDb = createMockDb([]);
    const metrics = new Map<string, { totalTvlUsd: number; poolCount: number }>();
    metrics.set("test-coin", {
      totalTvlUsd: 1000000,
      poolCount: 5,
    });
    const originalTvl = metrics.get("test-coin")?.totalTvlUsd;

    const result = await mergeStagedPools(mockDb, metrics as never, makeKnownPoolIndex(), 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(metrics.get("test-coin")?.totalTvlUsd).toBe(originalTvl);
  });

  it("skips pools that exist in knownPoolAddrs", async () => {
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${exactPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "gecko_terminal",
        chain: "ethereum",
        protocol: "pancakeswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 100000,
        volume_24h: 50000,
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: 1709900000,
        refreshed_at: 1710000000,
      },
    ]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex([`ethereum:${exactPoolAddress}`]);
    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.skippedByExactIdentityCount).toBe(1);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.mergedCount).toBe(0);
    expect(result.skipDimensions).toEqual([
      {
        reason: "duplicate_exact_identity",
        protocol: "pancakeswap-v3",
        chain: "ethereum",
        count: 1,
        conflict: "exact",
      },
    ]);
  });

  it("skips staged pools with impossible TVL values", async () => {
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${newPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "uniswap-v3",
        symbol: "USDT/WETH",
        tvl_usd: STAGED_POOL_MAX_TVL_USD + 1,
        volume_24h: 0,
        quality_multiplier: 0.85,
        pool_type: "cg-cl-30bp",
        fee_tier: 30,
        balance_ratio: null,
        is_stable: null,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "WETH",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: 1709900000,
        refreshed_at: 1710000000,
      },
    ]);
    const metrics = new Map();
    const result = await mergeStagedPools(mockDb, metrics, makeKnownPoolIndex(), 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(result.skipDimensions).toEqual([
      {
        reason: "invalid_tvl",
        protocol: "uniswap-v3",
        chain: "ethereum",
        count: 1,
        threshold: STAGED_POOL_MAX_TVL_USD,
      },
    ]);
  });

  it("skips staged pools with implausible tracked token prices", async () => {
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${newPoolAddress}`,
        stablecoin_id: "xaut-tether",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "carbon-defi-ethereum",
        dex_id: "carbon-defi-ethereum",
        symbol: "XAUt / sUSDS",
        tvl_usd: 2_020_820_673,
        volume_24h: 1_035_914_339,
        quality_multiplier: 0.8,
        pool_type: "cg-amm",
        fee_tier: null,
        balance_ratio: null,
        is_stable: null,
        base_token: "0x68749665ff8d2d112fa859aa293f07a622782f38",
        quote_token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
        quote_symbol: null,
        price_usd: 76259889535.2567,
        locked_liq_pct: null,
        discovered_at: 1709900000,
        refreshed_at: 1710000000,
      },
    ]);
    const metrics = new Map();
    const result = await mergeStagedPools(mockDb, metrics, makeKnownPoolIndex(), 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(result.priceObservations.size).toBe(0);
    expect(result.skipDimensions).toEqual([
      {
        reason: "invalid_price",
        protocol: "carbon-defi-ethereum",
        chain: "ethereum",
        count: 1,
      },
    ]);
  });

  it("skips staged pools whose token-pair fingerprint is already known", async () => {
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${newPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "gecko_terminal",
        chain: "ethereum",
        protocol: "pancakeswap",
        dex_id: "pancakeswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 100000,
        volume_24h: 50000,
        quality_multiplier: 0.5,
        pool_type: "gt-concentrated",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: 1709900000,
        refreshed_at: 1710000000,
      },
    ]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex([
      `derived:ethereum:pancakeswap-v3:${baseToken}:${quoteToken}:gt-concentrated:na:stable`,
    ]);

    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(result.skipDimensions).toEqual([
      {
        reason: "duplicate_unique_derived_identity",
        protocol: "pancakeswap",
        chain: "ethereum",
        count: 1,
        conflict: "derived_unique",
      },
    ]);
  });

  it("does not let stale zero-confidence rows make fresh duplicate fingerprints ambiguous", async () => {
    const now = 1710000000;
    const stalePoolAddress = "0x0000000000000000000000000000000000000999";
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${newPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "gecko_terminal",
        chain: "ethereum",
        protocol: "pancakeswap",
        dex_id: "pancakeswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 100000,
        volume_24h: 50000,
        quality_multiplier: 0.5,
        pool_type: "gt-concentrated",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: now - 100000,
        refreshed_at: now,
      },
      {
        pool_id: `ethereum:${stalePoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "gecko_terminal",
        chain: "ethereum",
        protocol: "pancakeswap",
        dex_id: "pancakeswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 100000,
        volume_24h: 50000,
        quality_multiplier: 0.5,
        pool_type: "gt-concentrated",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: now - 100000,
        refreshed_at: now - 86400 - 30,
      },
    ]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex([
      `derived:ethereum:pancakeswap-v3:${baseToken}:${quoteToken}:gt-concentrated:na:stable`,
    ]);

    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, now);

    expect(result.skippedCount).toBe(2);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(metrics.size).toBe(0);
    expect(result.skipDimensions).toEqual([
      {
        reason: "duplicate_unique_derived_identity",
        protocol: "pancakeswap",
        chain: "ethereum",
        count: 1,
        conflict: "derived_unique",
      },
      {
        reason: "stale_confidence_zero",
        protocol: "pancakeswap",
        chain: "ethereum",
        count: 1,
        threshold: 24,
      },
    ]);
  });

  it("skips one staged exact-pool-id pool that uniquely matches an identity-poor DL row", async () => {
    const now = 1710000000;
    const uniswapV4PoolAddress = "0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893";
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${uniswapV4PoolAddress}`,
        stablecoin_id: "bold-liquity",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "uniswap-v4",
        dex_id: "uniswap-v4-ethereum",
        symbol: "BOLD / USDC 0.05%",
        tvl_usd: 2_700_000,
        volume_24h: 260_000,
        quality_multiplier: 0.3,
        pool_type: "cg-concentrated",
        fee_tier: null,
        balance_ratio: 1,
        is_stable: null,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1.001,
        locked_liq_pct: null,
        discovered_at: now - 3600,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();
    const knownPoolIndex = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      knownPoolIndex,
      buildPoolIdentity({
        chain: "Ethereum",
        protocol: "uniswap-v4",
        poolAddressOrId: "d0c42a48-871a-4e83-9ef2-b3f60b3e0e90",
        tokenAddresses: [baseToken, quoteToken],
        poolType: "generic",
        isStable: true,
      }),
    );

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.skippedCount).toBe(1);
    expect(result.skippedByOptionalWildcardIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.get("bold-liquity")).toHaveLength(1);
    expect(result.skipDimensions).toEqual([
      {
        reason: "duplicate_optional_wildcard_identity",
        protocol: "uniswap-v4",
        chain: "ethereum",
        count: 1,
        conflict: "derived_optional_wildcard",
      },
    ]);
  });

  it("keeps staged exact-pool-id same-pair pools when the incoming wildcard bucket is ambiguous", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([
      {
        pool_id: "ethereum:0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893",
        stablecoin_id: "bold-liquity",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "uniswap-v4",
        dex_id: "uniswap-v4-ethereum",
        symbol: "BOLD / USDC 0.05%",
        tvl_usd: 2_700_000,
        volume_24h: 260_000,
        quality_multiplier: 0.3,
        pool_type: "cg-concentrated",
        fee_tier: null,
        balance_ratio: 1,
        is_stable: null,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1.001,
        locked_liq_pct: null,
        discovered_at: now - 3600,
        refreshed_at: now,
      },
      {
        pool_id: "ethereum:0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5",
        stablecoin_id: "bold-liquity",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "uniswap-v4",
        dex_id: "uniswap-v4-ethereum",
        symbol: "BOLD / USDC 0.01%",
        tvl_usd: 400_000,
        volume_24h: 20_000,
        quality_multiplier: 0.3,
        pool_type: "cg-concentrated",
        fee_tier: null,
        balance_ratio: 1,
        is_stable: null,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1.0005,
        locked_liq_pct: null,
        discovered_at: now - 3600,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();
    const knownPoolIndex = createKnownPoolIdentityIndex();
    registerKnownPoolIdentity(
      knownPoolIndex,
      buildPoolIdentity({
        chain: "Ethereum",
        protocol: "uniswap-v4",
        poolAddressOrId: "d0c42a48-871a-4e83-9ef2-b3f60b3e0e90",
        tokenAddresses: [baseToken, quoteToken],
        poolType: "generic",
        isStable: true,
      }),
    );

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.skippedByOptionalWildcardIdentityCount).toBe(0);
    expect(result.mergedCount).toBe(2);
    expect(metrics.get("bold-liquity")?.topPools).toHaveLength(2);
  });

  it("gracefully handles missing staging table", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockDb = createMockDb(async () => {
      throw new Error("no such table: dex_pool_staging");
    });
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.skipDimensions).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("merges GT-style staged pools with confidence decay and GT dex quality", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([
      {
        pool_id: "bsc:0xpool1",
        stablecoin_id: "usdt-tether",
        source: "gecko_terminal",
        chain: "bsc",
        protocol: "pancakeswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 100000,
        volume_24h: 50000,
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: "0xbase",
        quote_token: "0xquote",
        quote_symbol: "USDC",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: now - 86400 * 10,
        refreshed_at: now - 3600 * 12,
      },
    ]);
    const metrics = new Map();

    const result = await mergeStagedPools(mockDb, metrics as never, makeKnownPoolIndex(), now);
    const metric = metrics.get("usdt-tether");

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(1);
    expect(metric).toBeDefined();
    expect(metric.totalTvlUsd).toBe(75000);
    expect(metric.totalVolume24hUsd).toBe(37500);
    expect(metric.poolCount).toBe(1);
    expect(metric.qualityAdjustedTvl).toBe(37500);
    expect(metric.protocolTvl.pancakeswap).toBe(75000);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]?.source).toBe("gecko_terminal");
    expect(metric.topPools[0]?.poolId).toBe("bsc:0xpool1");
  });

  it("credits the same exact staged pool to each tracked stablecoin row", async () => {
    const now = 1710000000;
    const sharedPoolAddress = "0x0000000000000000000000000000000000000123";
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${sharedPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "gecko_terminal",
        chain: "ethereum",
        protocol: "uniswap-v3",
        dex_id: "uniswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 180000,
        volume_24h: 90000,
        quality_multiplier: 0.85,
        pool_type: "gt-concentrated",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: now - 86400 * 2,
        refreshed_at: now,
      },
      {
        pool_id: `ethereum:${sharedPoolAddress}`,
        stablecoin_id: "usdc-circle",
        source: "gecko_terminal",
        chain: "ethereum",
        protocol: "uniswap-v3",
        dex_id: "uniswap-v3",
        symbol: "USDC/USDT",
        tvl_usd: 180000,
        volume_24h: 90000,
        quality_multiplier: 0.85,
        pool_type: "gt-concentrated",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDT",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: now - 86400 * 2,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex();

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.mergedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(metrics.get("usdt-tether")?.topPools).toHaveLength(1);
    expect(metrics.get("usdc-circle")?.topPools).toHaveLength(1);
    expect(metrics.get("usdt-tether")?.topPools[0]?.poolId).toBe(`ethereum:${sharedPoolAddress}`);
    expect(metrics.get("usdc-circle")?.topPools[0]?.poolId).toBe(`ethereum:${sharedPoolAddress}`);
    expect(knownPoolIndex.exactKeys.has(`ethereum:${sharedPoolAddress}`)).toBe(true);
  });

  it("skips staged pools that claim an authoritative protocol without authoritative exact-id confirmation", async () => {
    const now = 1710000000;
    const unconfirmedBalancerPool = "0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea";
    const mockDb = createMockDb([
      {
        pool_id: `plasma:${unconfirmedBalancerPool}`,
        stablecoin_id: "usdai-usd-ai",
        source: "gecko_terminal",
        chain: "plasma",
        protocol: "balancer",
        dex_id: "balancer-v3-plasma",
        symbol: "USDai/USDT0",
        tvl_usd: 2250000,
        volume_24h: 0,
        quality_multiplier: 0.85,
        pool_type: "stable",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
        quote_token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
        quote_symbol: "USDT0",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: now - 86400,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();

    const result = await mergeStagedPools(
      mockDb,
      metrics as never,
      makeKnownPoolIndex(),
      now,
      undefined,
      makeAuthoritativeConfirmationIndex([{ protocol: "balancer", chains: ["plasma"] }]),
    );

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(1);
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.get("usdai-usd-ai")).toBeUndefined();
    expect(result.skipDimensions).toEqual([
      {
        reason: "authoritative_confirmation_missing",
        protocol: "balancer",
        chain: "plasma",
        count: 1,
      },
    ]);
  });

  it("fails open for staged pools when authoritative confirmation is unavailable", async () => {
    const now = 1710000000;
    const confirmedBalancerPool = "0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54";
    const mockDb = createMockDb([
      {
        pool_id: `plasma:${confirmedBalancerPool}`,
        stablecoin_id: "usdai-usd-ai",
        source: "gecko_terminal",
        chain: "plasma",
        protocol: "balancer",
        dex_id: "balancer-v3-plasma",
        symbol: "USDai/USDT0",
        tvl_usd: 547760,
        volume_24h: 20190,
        quality_multiplier: 0.85,
        pool_type: "stable",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef",
        quote_token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
        quote_symbol: "USDT0",
        price_usd: 1,
        locked_liq_pct: null,
        discovered_at: now - 86400,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();

    const result = await mergeStagedPools(mockDb, metrics as never, makeKnownPoolIndex(), now);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(0);
    expect(metrics.get("usdai-usd-ai")?.protocolTvl.balancer).toBe(547760);
  });

  it("merges CG staged pools and preserves balance ratio and locked liquidity", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([
      {
        pool_id: "ethereum:0xcgpool",
        stablecoin_id: "usdt-tether",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "pancakeswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 100000,
        volume_24h: 50000,
        fee_tier: 5,
        balance_ratio: 0.8,
        is_stable: 1,
        base_token: "0xbase",
        quote_token: "0xquote",
        quote_symbol: "USDC",
        price_usd: 1,
        locked_liq_pct: 90,
        discovered_at: now - 86400 * 10,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();

    const result = await mergeStagedPools(mockDb, metrics as never, makeKnownPoolIndex(), now);
    const metric = metrics.get("usdt-tether");

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(1);
    expect(metric).toBeDefined();
    expect(metric.totalTvlUsd).toBe(100000);
    expect(metric.totalVolume24hUsd).toBe(50000);
    expect(metric.totalTvlForBalance).toBe(100000);
    expect(metric.balanceRatioWeightedSum).toBe(80000);
    expect(metric.totalTvlForLocked).toBe(100000);
    expect(metric.lockedLiqWeightedSum).toBe(90000);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]?.source).toBe("cg_onchain");
    expect(metric.topPools[0]?.extra?.balanceRatio).toBe(0.8);
    expect(metric.topPools[0]?.extra?.feeTier).toBe(5);
  });

  it("extracts price observations from pools skipped by address dedup", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${secondExactPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "uniswap-v3",
        dex_id: "uniswap_v3",
        symbol: "USDT/USDC",
        tvl_usd: 100000,
        volume_24h: 50000,
        fee_tier: 5,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 0.9998,
        locked_liq_pct: null,
        discovered_at: now - 86400 * 10,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();
    // Pool address is already known (from DL yields) — will be deduped for metrics
    const knownPoolIndex = makeKnownPoolIndex([`ethereum:${secondExactPoolAddress}`]);

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    // Metrics dedup still works — pool was NOT merged into metrics
    expect(result.skippedCount).toBe(1);
    expect(result.skippedByExactIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(metrics.size).toBe(0);

    // But price observation WAS extracted
    const obs = result.priceObservations.get("usdt-tether");
    expect(obs).toHaveLength(1);
    expect(obs![0].price).toBe(0.9998);
    expect(obs![0].tvl).toBe(100000);
    expect(obs![0].chain).toBe("ethereum");
  });

  it("extracts price observations from pools skipped by fingerprint dedup", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${newPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "gecko_terminal",
        chain: "ethereum",
        protocol: "pancakeswap",
        dex_id: "pancakeswap-v3",
        symbol: "USDT/USDC",
        tvl_usd: 80000,
        volume_24h: 40000,
        quality_multiplier: 0.5,
        pool_type: "gt-concentrated",
        fee_tier: null,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1.0001,
        locked_liq_pct: null,
        raw_json: JSON.stringify({
          orderbookTvlBasis: "coingecko-depth-2pct-capped-by-volume",
          orderbookDepthUsd: 500000,
          orderbookDepthUpUsd: 700000,
        }),
        discovered_at: now - 86400 * 5,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();
    // Fingerprint is known (from DL yields) — will be deduped for metrics
    const knownPoolIndex = makeKnownPoolIndex([
      `derived:ethereum:pancakeswap-v3:${baseToken}:${quoteToken}:gt-concentrated:na:stable`,
    ]);

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    // Metrics dedup still works
    expect(result.skippedCount).toBe(1);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(metrics.size).toBe(0);

    // Price observation WAS extracted
    const obs = result.priceObservations.get("usdt-tether");
    expect(obs).toHaveLength(1);
    expect(obs![0].price).toBe(1.0001);
    expect(obs![0].tvl).toBe(80000);
  });

  it("does NOT extract price observation from deduped pool with sub-threshold TVL", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([
      {
        pool_id: `ethereum:${secondExactPoolAddress}`,
        stablecoin_id: "usdt-tether",
        source: "cg_onchain",
        chain: "ethereum",
        protocol: "uniswap-v3",
        dex_id: "uniswap_v3",
        symbol: "USDT/USDC",
        tvl_usd: 30000,
        volume_24h: 5000,
        fee_tier: 5,
        balance_ratio: null,
        is_stable: 1,
        base_token: baseToken,
        quote_token: quoteToken,
        quote_symbol: "USDC",
        price_usd: 1.0,
        locked_liq_pct: null,
        discovered_at: now - 86400 * 10,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex([`ethereum:${secondExactPoolAddress}`]);

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.skippedCount).toBe(1);
    // TVL $30K × confidence 1.0 = $30K < $50K threshold — no price observation
    expect(result.priceObservations.get("usdt-tether")).toBeUndefined();
  });

  it("orderbook pools skip fingerprint dedup (null tokens)", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([
      {
        pool_id: "orderbook:binance:usdt-tether",
        stablecoin_id: "usdt-tether",
        source: "cg_tickers",
        chain: "orderbook",
        protocol: "binance",
        symbol: "USDT/USD",
        tvl_usd: 500000,
        volume_24h: 1000000,
        fee_tier: null,
        balance_ratio: null,
        is_stable: 0,
        base_token: null,
        quote_token: null,
        quote_symbol: "USD",
        price_usd: 1.0001,
        locked_liq_pct: null,
        raw_json: JSON.stringify({
          orderbookTvlBasis: "coingecko-depth-2pct-capped-by-volume",
          orderbookDepthUsd: 500000,
          orderbookDepthUpUsd: 700000,
        }),
        discovered_at: now - 86400 * 5,
        refreshed_at: now,
      },
    ]);
    const metrics = new Map();
    // Fingerprint for this pool would be null (no tokens), so it should NOT be
    // skipped by fingerprint dedup — only exact poolId match matters
    const knownPoolIndex = makeKnownPoolIndex();

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(metrics.get("usdt-tether")?.topPools[0]?.extra).toMatchObject({
      orderbookTvlBasis: "coingecko-depth-2pct-capped-by-volume",
      orderbookDepthUsd: 500000,
      orderbookDepthUpUsd: 700000,
      measurement: {
        synthetic: true,
        tvlMeasured: true,
      },
    });
  });

  it("does not exact-dedupe legacy exchange-only orderbook rows across stablecoins", async () => {
    const now = 1710000000;
    const makeOrderbookRow = (stablecoinId: string, symbol: string) => ({
      pool_id: "orderbook:binance",
      stablecoin_id: stablecoinId,
      source: "cg_tickers",
      chain: "orderbook",
      protocol: "binance",
      symbol,
      tvl_usd: 500000,
      volume_24h: 1000000,
      fee_tier: null,
      balance_ratio: null,
      is_stable: 0,
      base_token: null,
      quote_token: null,
      quote_symbol: "USD",
      price_usd: 1.0001,
      locked_liq_pct: null,
      raw_json: JSON.stringify({
        orderbookTvlBasis: "coingecko-depth-2pct-capped-by-volume",
        orderbookDepthUsd: 500000,
        orderbookDepthUpUsd: 700000,
      }),
      discovered_at: now - 86400 * 5,
      refreshed_at: now,
    });
    const mockDb = createMockDb([
      makeOrderbookRow("usdt-tether", "USDT/USD"),
      makeOrderbookRow("usdc-circle", "USDC/USD"),
    ]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex();

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.mergedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(metrics.get("usdt-tether")?.topPools).toHaveLength(1);
    expect(metrics.get("usdc-circle")?.topPools).toHaveLength(1);
  });
});
