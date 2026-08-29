import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../../lib/constants";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import type { DexPriceObs, PoolEntry } from "../types";

export const DEFAULT_DEX_SCORING_NOW_SEC = 1_700_000_000;

export type PoolOverrides = Partial<PoolEntry> & Pick<PoolEntry, "poolId" | "project" | "chain" | "tvlUsd">;

export interface PoolMapEntry {
  stablecoinId: string;
  pools: readonly PoolOverrides[];
}

export type PricePoolSpec = PoolOverrides & { stablecoinId: string };

export interface ObservationMapEntry {
  stablecoinId: string;
  observations: readonly (Partial<DexPriceObs> & Pick<DexPriceObs, "price" | "tvl" | "chain" | "protocol">)[];
}

export function makePool(overrides: Partial<PoolEntry> = {}): PoolEntry {
  return {
    poolId: "ethereum:0xabc",
    project: "balancer-v3",
    chain: "Ethereum",
    tvlUsd: 5_000_000,
    symbol: "USDC/USDT",
    volumeUsd1d: 1_000_000,
    volumeUsd7d: 7_000_000,
    poolType: "balancer-stable",
    source: "dl",
    ...overrides,
  } as PoolEntry;
}

export function makeObs(overrides: Partial<DexPriceObs> = {}): DexPriceObs {
  return {
    price: 1.0,
    tvl: 1_000_000,
    chain: "ethereum",
    protocol: "uniswap-v3",
    ...overrides,
  };
}

export function makePoolMap(entries: readonly PoolMapEntry[]): Map<string, PoolEntry[]> {
  return new Map(entries.map(({ stablecoinId, pools }) => [stablecoinId, pools.map((pool) => makePool(pool))]));
}

export function makePricePoolMap(entries: readonly PricePoolSpec[]): Map<string, PoolEntry[]> {
  const grouped = new Map<string, PoolEntry[]>();
  for (const { stablecoinId, ...pool } of entries) {
    grouped.set(stablecoinId, [...(grouped.get(stablecoinId) ?? []), makePool(pool)]);
  }
  return grouped;
}

export function makeObservationMap(entries: readonly ObservationMapEntry[]): Map<string, DexPriceObs[]> {
  return new Map(entries.map(({ stablecoinId, observations }) => [stablecoinId, observations.map((observation) => makeObs(observation))]));
}

export function makeUsdPricePools(count: number): Map<string, PoolEntry[]> {
  const usdCoins = ACTIVE_STABLECOINS.filter((coin) => coin.flags.pegCurrency === "USD").slice(0, count);
  if (usdCoins.length !== count) throw new Error(`Expected ${count} active USD stablecoins for the fixture`);
  return makePricePoolMap(usdCoins.map((coin, index) => ({
    stablecoinId: coin.id,
    poolId: `ethereum:atomicity-${index}`,
    project: "curve",
    chain: "Ethereum",
    tvlUsd: 100_000,
    symbol: `${coin.symbol}/USDC`,
    volumeUsd1d: 0,
    volumeUsd7d: null,
    poolType: "stable",
    source: "dl",
    price: 1,
  })));
}

export interface SeedGenerationOptions {
  nowSec?: number;
  generationId?: string;
}

export interface PublishedDexGenerationFixture {
  sqlite: import("node:sqlite").DatabaseSync;
  db: D1Database;
  generationId: string;
}

export function seedPublishedDexGeneration(
  options: SeedGenerationOptions = {},
): PublishedDexGenerationFixture {
  const nowSec = options.nowSec ?? DEFAULT_DEX_SCORING_NOW_SEC;
  const generationId = options.generationId ?? `dex-liquidity-${nowSec}`;
  const expectedRowCount = ACTIVE_STABLECOINS.length + 1;
  const fixture = createLatestSchemaSqlite();
  fixture.sqlite
    .prepare(
      `INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at)
       VALUES (?, ?, 'published', ?, ?, ?, ?, ?)`,
    )
    .run(
      generationId,
      nowSec,
      expectedRowCount,
      expectedRowCount,
      expectedRowCount,
      nowSec,
      nowSec,
    );

  const insertStaged = fixture.sqlite.prepare(
    `INSERT INTO dex_liquidity_run_rows
      (generation_id, stablecoin_id, symbol, depth_stability, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertPublic = fixture.sqlite.prepare(
    `INSERT INTO dex_liquidity
      (stablecoin_id, symbol, depth_stability, updated_at, publication_generation_id, publication_state)
     VALUES (?, ?, ?, ?, ?, 'published')`,
  );
  fixture.sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (const coin of ACTIVE_STABLECOINS) {
      insertStaged.run(generationId, coin.id, coin.symbol, 0.25, nowSec);
      insertPublic.run(coin.id, coin.symbol, 0.25, nowSec, generationId);
    }
    insertStaged.run(generationId, "__global__", "__global__", null, nowSec);
    insertPublic.run("__global__", "__global__", null, nowSec, generationId);
    fixture.sqlite.exec("COMMIT");
  } catch (error) {
    fixture.sqlite.exec("ROLLBACK");
    throw error;
  }

  fixture.sqlite
    .prepare(
      `INSERT INTO dex_prices
        (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl, updated_at)
       VALUES ('legacy-a', 'OLDA', 0.91, 1, 100000, ?),
              ('legacy-b', 'OLDB', 1.09, 1, 100000, ?)`,
    )
    .run(nowSec - 1, nowSec - 1);
  return { ...fixture, generationId };
}

export interface PublicPriceRow {
  stablecoin_id: string;
  symbol: string;
  dex_price_usd: number;
  source_pool_count: number;
  source_total_tvl: number;
  deviation_from_primary_bps: number | null;
  primary_price_at_calc: number | null;
  price_sources_json: string | null;
  updated_at: number;
}

export type PublicPriceRowOverrides = Partial<PublicPriceRow> & Pick<
  PublicPriceRow,
  "stablecoin_id" | "symbol" | "dex_price_usd" | "source_pool_count" | "source_total_tvl" | "updated_at"
>;

export function makeExpectedPublicPriceRow(overrides: PublicPriceRowOverrides): PublicPriceRow {
  return {
    deviation_from_primary_bps: null,
    primary_price_at_calc: null,
    price_sources_json: null,
    ...overrides,
  };
}

export interface PublicPriceSeed {
  stablecoinId: string;
  symbol: string;
  price: number;
  updatedAt?: number;
}

export interface PricePublicationStep {
  nowSec?: number;
  retainedPools?: readonly PricePoolSpec[];
  exactPriceEvidence?: readonly ObservationMapEntry[];
  primaryPrices?: readonly (readonly [string, number])[];
  expectedRows: PublicPriceRow[];
  expectedDiagnostics?: unknown;
}

export interface PriceScenario {
  label: string;
  nowSec: number;
  cacheValue?: string;
  existingPrices?: readonly PublicPriceSeed[];
  steps: readonly PricePublicationStep[];
  expectedGeneration?: {
    state: string;
    expected_row_count: number;
    current_row_count: number;
  };
}

const DEPEG_USDT_POOLS: readonly PricePoolSpec[] = [
  { stablecoinId: "usdt-tether", poolId: "ethereum:curve-1", project: "curve", chain: "Ethereum", tvlUsd: 100_000, price: 0.3, source: "dl" },
  { stablecoinId: "usdt-tether", poolId: "base:uniswap-1", project: "uniswap-v3", chain: "Base", tvlUsd: 100_000, price: 0.31, source: "direct_api" },
  { stablecoinId: "usdt-tether", poolId: "solana:raydium-1", project: "raydium", chain: "Solana", tvlUsd: 1_000_000, price: 1, source: "gecko_terminal" },
];

export const DEX_PRICE_SCENARIOS: readonly PriceScenario[] = [
  {
    label: "atomically publishes an empty or weighted-median DEX price generation",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 1,
    steps: [
      { nowSec: DEFAULT_DEX_SCORING_NOW_SEC, expectedRows: [] },
      {
        retainedPools: [
          { stablecoinId: "usdt-tether", poolId: "ethereum:curve-1", project: "curve", chain: "Ethereum", tvlUsd: 400_000, price: 0.98, source: "dl" },
          { stablecoinId: "usdt-tether", poolId: "ethereum:curve-2", project: "curve", chain: "Ethereum", tvlUsd: 350_000, price: 1, source: "dl" },
          { stablecoinId: "usdt-tether", poolId: "base:uni-1", project: "uniswap-v3", chain: "Base", tvlUsd: 250_000, price: 1.02, source: "direct_api" },
          { stablecoinId: "usdc-circle", poolId: "base:alien-1", project: "alien-base", chain: "Base", tvlUsd: 100_000, price: 1.2 },
        ],
        primaryPrices: [["usdt-tether", 1.01]],
        expectedRows: [makeExpectedPublicPriceRow({
          stablecoin_id: "usdt-tether",
          symbol: "USDT",
          dex_price_usd: 1,
          source_pool_count: 3,
          source_total_tvl: 1_000_000,
          deviation_from_primary_bps: -99,
          primary_price_at_calc: 1.01,
          price_sources_json: JSON.stringify([
            { protocol: "curve", chain: "Ethereum", price: 0.98, tvl: 750_000, sourceFamily: "dl" },
            { protocol: "uniswap-v3", chain: "Base", price: 1.02, tvl: 250_000, sourceFamily: "direct_api" },
          ]),
          updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 1,
        })],
      },
    ],
    expectedGeneration: {
      state: "published",
      expected_row_count: ACTIVE_STABLECOINS.length + 1,
      current_row_count: ACTIVE_STABLECOINS.length + 1,
    },
  },
  {
    label: "clears stale dex price rows when the latest sync has no observations",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 4,
    existingPrices: [
      { stablecoinId: "usdt-tether", symbol: "USDT", price: 0.91 },
      { stablecoinId: "usdc-circle", symbol: "USDC", price: 1.09 },
    ],
    steps: [{ expectedRows: [] }],
  },
  {
    label: "rejects a peg-impossible KRW price before replacing dex_prices",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 1,
    existingPrices: [{ stablecoinId: "krwq-iq", symbol: "KRWQ", price: 0.0007 }],
    steps: [{
      retainedPools: [{
        stablecoinId: "krwq-iq",
        poolId: "bsc:pancakeswap-krwq-usdt",
        project: "pancakeswap",
        chain: "BSC",
        tvlUsd: 82_806,
        price: 1349.284,
        source: "direct_api",
      }],
      expectedRows: [],
      expectedDiagnostics: {
        rejectedObservationCount: 1,
        rejectedByStablecoin: [{
          stablecoinId: "krwq-iq",
          reason: "peg-impossible",
          observations: [{
            chain: "BSC",
            protocol: "pancakeswap",
            poolKey: "bsc:pancakeswap-krwq-usdt",
            price: 1349.284,
            tvl: 82_806,
            sourceFamily: "direct_api",
          }],
          truncated: 0,
        }],
        truncatedStablecoins: 0,
        retention: {
          cutoff: DEFAULT_DEX_SCORING_NOW_SEC + 1 - 3 * 60 * 60,
          deletedRows: 0,
          oldestRemainingAt: null,
          durationMs: null,
          error: null,
        },
      },
    }],
  },
  {
    label: "persists a correctly oriented KRW price inside the KRW peg band",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 2,
    steps: [{
      retainedPools: [{
        stablecoinId: "krwq-iq",
        poolId: "bsc:pancakeswap-krwq-usdt",
        project: "pancakeswap",
        chain: "BSC",
        tvlUsd: 82_806,
        price: 0.00074113379,
        source: "direct_api",
      }],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "krwq-iq",
        symbol: "KRWQ",
        dex_price_usd: 0.000741,
        source_pool_count: 1,
        source_total_tvl: 82_806,
        price_sources_json: JSON.stringify([{
          protocol: "pancakeswap",
          chain: "BSC",
          price: 0.00074113379,
          tvl: 82_806,
          sourceFamily: "direct_api",
        }]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 2,
      })],
    }],
  },
  {
    label: "does not publish retained priced pools below the DEX price observation floor",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 1,
    steps: [{
      retainedPools: [{
        stablecoinId: "usdt-tether",
        poolId: "ethereum:curve-1",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: DEX_PRICE_OBSERVATION_MIN_TVL_USD - 1,
        price: 0.9999,
        source: "dl",
      }],
      expectedRows: [],
    }],
  },
  {
    label: "weights DEX price medians by source family rather than claimed protocol",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 1,
    steps: [{
      retainedPools: [
        { stablecoinId: "usdt-tether", poolId: "ethereum:curve-1", project: "curve", chain: "Ethereum", tvlUsd: 100_000, price: 1, source: "dl" },
        { stablecoinId: "usdt-tether", poolId: "solana:raydium-fallback-1", project: "raydium", chain: "Solana", tvlUsd: 180_000, price: 1.18, source: "dexscreener" },
      ],
      primaryPrices: [["usdt-tether", 1]],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        dex_price_usd: 1,
        source_pool_count: 2,
        source_total_tvl: 280_000,
        deviation_from_primary_bps: 0,
        primary_price_at_calc: 1,
        price_sources_json: JSON.stringify([
          { protocol: "raydium", chain: "Solana", price: 1.18, tvl: 180_000, sourceFamily: "dexscreener" },
          { protocol: "curve", chain: "Ethereum", price: 1, tvl: 100_000, sourceFamily: "dl" },
        ]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 1,
      })],
    }],
  },
  {
    label: "does not restore an untrusted primary price omitted from the preloaded map",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 1,
    steps: [{
      retainedPools: DEPEG_USDT_POOLS,
      primaryPrices: [["usdc-circle", 1]],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        dex_price_usd: 1,
        source_pool_count: 3,
        source_total_tvl: 1_200_000,
        price_sources_json: JSON.stringify([
          { protocol: "raydium", chain: "Solana", price: 1, tvl: 1_000_000, sourceFamily: "gecko_terminal" },
          { protocol: "curve", chain: "Ethereum", price: 0.3, tvl: 100_000, sourceFamily: "dl" },
          { protocol: "uniswap-v3", chain: "Base", price: 0.31, tvl: 100_000, sourceFamily: "direct_api" },
        ]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 1,
      })],
    }],
  },
  {
    label: "filters high-TVL contaminated DEX prices when most observations agree with the primary price",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 1,
    steps: [{
      retainedPools: DEPEG_USDT_POOLS,
      primaryPrices: [["usdt-tether", 0.3]],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        dex_price_usd: 0.3,
        source_pool_count: 3,
        source_total_tvl: 1_200_000,
        deviation_from_primary_bps: 0,
        primary_price_at_calc: 0.3,
        price_sources_json: JSON.stringify([
          { protocol: "curve", chain: "Ethereum", price: 0.3, tvl: 100_000, sourceFamily: "dl" },
          { protocol: "uniswap-v3", chain: "Base", price: 0.31, tvl: 100_000, sourceFamily: "direct_api" },
        ]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 1,
      })],
    }],
  },
  {
    label: "ignores malformed cache JSON when computing DEX prices",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 2,
    cacheValue: "{bad-json",
    steps: [{
      retainedPools: [{
        stablecoinId: "usdt-tether",
        poolId: "ethereum:curve-1",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: DEX_PRICE_OBSERVATION_MIN_TVL_USD,
        price: 0.99,
        source: "dl",
      }],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        dex_price_usd: 0.99,
        source_pool_count: 1,
        source_total_tvl: DEX_PRICE_OBSERVATION_MIN_TVL_USD,
        price_sources_json: JSON.stringify([{
          protocol: "curve",
          chain: "Ethereum",
          price: 0.99,
          tvl: DEX_PRICE_OBSERVATION_MIN_TVL_USD,
          sourceFamily: "dl",
        }]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 2,
      })],
    }],
  },
  {
    label: "retires dex price rows that are missing from the latest observation set",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 3,
    existingPrices: [
      { stablecoinId: "usdt-tether", symbol: "USDT", price: 0.91 },
      { stablecoinId: "usdc-circle", symbol: "USDC", price: 1.09 },
    ],
    steps: [{
      retainedPools: [{
        stablecoinId: "usdt-tether",
        poolId: "ethereum:curve-1",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        price: 0.9999,
        source: "dl",
      }],
      primaryPrices: [["usdt-tether", 1]],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        dex_price_usd: 0.9999,
        source_pool_count: 1,
        source_total_tvl: 100_000,
        deviation_from_primary_bps: -1,
        primary_price_at_calc: 1,
        price_sources_json: JSON.stringify([{
          protocol: "curve",
          chain: "Ethereum",
          price: 0.9999,
          tvl: 100_000,
          sourceFamily: "dl",
        }]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 3,
      })],
    }],
  },
  {
    label: "publishes dex prices from retained priced pools instead of pre-retention discovery observations",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 5,
    steps: [{
      retainedPools: [
        { stablecoinId: "usr-resolv", poolId: "ethereum:curve-1", project: "curve", chain: "Ethereum", tvlUsd: 64_711, price: 0.1152, source: "dl" },
        { stablecoinId: "usr-resolv", poolId: "ethereum:uniswap-1", project: "uniswap", chain: "Ethereum", tvlUsd: 627_528, price: 0.115, source: "gecko_terminal" },
      ],
      primaryPrices: [["usr-resolv", 0.1129]],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "usr-resolv",
        symbol: "USR",
        dex_price_usd: 0.115,
        source_pool_count: 2,
        source_total_tvl: 692_239,
        deviation_from_primary_bps: 186,
        primary_price_at_calc: 0.1129,
        price_sources_json: JSON.stringify([
          { protocol: "uniswap", chain: "Ethereum", price: 0.115, tvl: 627_528, sourceFamily: "gecko_terminal" },
          { protocol: "curve", chain: "Ethereum", price: 0.1152, tvl: 64_711, sourceFamily: "dl" },
        ]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 5,
      })],
    }],
  },
  {
    label: "ignores blocked dead DEX protocols when publishing dex prices",
    nowSec: DEFAULT_DEX_SCORING_NOW_SEC + 6,
    steps: [{
      retainedPools: [
        { stablecoinId: "usr-resolv", poolId: "ethereum:bunni-1", project: "bunni-ethereum", chain: "Ethereum", tvlUsd: 1_451_774, price: 0.9993, source: "gecko_terminal" },
        { stablecoinId: "usr-resolv", poolId: "ethereum:curve-1", project: "curve", chain: "Ethereum", tvlUsd: 64_711, price: 0.1152, source: "dl" },
      ],
      primaryPrices: [["usr-resolv", 0.1129]],
      expectedRows: [makeExpectedPublicPriceRow({
        stablecoin_id: "usr-resolv",
        symbol: "USR",
        dex_price_usd: 0.1152,
        source_pool_count: 1,
        source_total_tvl: 64_711,
        deviation_from_primary_bps: 204,
        primary_price_at_calc: 0.1129,
        price_sources_json: JSON.stringify([{
          protocol: "curve",
          chain: "Ethereum",
          price: 0.1152,
          tvl: 64_711,
          sourceFamily: "dl",
        }]),
        updated_at: DEFAULT_DEX_SCORING_NOW_SEC + 6,
      })],
    }],
  },
];

export function readPublicPrices(sqlite: import("node:sqlite").DatabaseSync): unknown[] {
  return readPublicPriceRows(sqlite).map(({ stablecoin_id, symbol, dex_price_usd, updated_at }) => ({
    stablecoin_id,
    symbol,
    dex_price_usd,
    updated_at,
  }));
}

export function readPublicPriceRows(sqlite: import("node:sqlite").DatabaseSync): PublicPriceRow[] {
  return sqlite
    .prepare(
      `SELECT stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
              deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at
       FROM dex_prices
       ORDER BY stablecoin_id`,
    )
    .all() as PublicPriceRow[];
}

export function insertPublicPrice(
  sqlite: import("node:sqlite").DatabaseSync,
  stablecoinId: string,
  symbol: string,
  price: number,
  updatedAt: number,
): void {
  sqlite
    .prepare(
      `INSERT INTO dex_prices
        (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl, updated_at)
       VALUES (?, ?, ?, 1, 100000, ?)`,
    )
    .run(stablecoinId, symbol, price, updatedAt);
}
