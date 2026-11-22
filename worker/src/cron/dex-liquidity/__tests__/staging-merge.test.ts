import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEZOS_POOL_IDENTITY_REVIEW_VERSION,
  SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION,
  STAGED_POOL_CONFIDENCE_HORIZON_HOURS,
  STAGED_POOL_MAX_TVL_USD,
  stagedPoolConfidence,
  stagedPoolMaturityDays,
} from "../../dex-discovery/types";
import { STAGED_POOL_PRICE_MAX_AGE_HOURS } from "../../../lib/dex-cron-constants";
import { mergeStagedPools, type StagedPoolRow } from "../staging-merge";
import { applyPoolVolumeEligibility, filterRetainedPools } from "../scoring-helpers";
import { initLiquidityFallbackCounters, initSourcePoolGraph } from "../pool-helpers";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import type { GtNewPool, PoolEntry, SourcePoolGraph } from "../types";
import { makeGtPool, makePool, scorePoolGraph } from "./scoring-test-builders";
import { mergeGtPools } from "../fetch-crawlers";
import type { AuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";
import {
  buildPoolIdentity,
  createKnownPoolIdentityIndex,
  registerKnownPoolExactStablecoin,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "../pool-identity";
import { makeStagedPoolRow } from "./staging-merge.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import * as cronLogger from "../../../lib/cron-logger";

const NOW = 1_710_000_000;
const EXACT_ADDR = "0x0000000000000000000000000000000000000abc";
const SECOND_ADDR = "0x0000000000000000000000000000000000000def";
const NEW_ADDR = "0x0000000000000000000000000000000000000fed";
const BASE_TOKEN = "0x00000000000000000000000000000000000000b1";
const QUOTE_TOKEN = "0x00000000000000000000000000000000000000c2";
const ORDERBOOK_RAW = JSON.stringify({
  orderbookTvlBasis: "coingecko-depth-2pct-capped-by-volume",
  orderbookDepthUsd: 500_000,
  orderbookDepthUpUsd: 700_000,
});

const confidenceCases = [
  { ageHours: 0, expected: 1 },
  { ageHours: 24, expected: 1 },
  { ageHours: 180, expected: 0.5 },
  { ageHours: 336, expected: 0 },
  { ageHours: 400, expected: 0 },
  { ageHours: -5, expected: 1 },
] as const;

const maturityCases = [
  { discoveredOffset: 86400 * 10, expected: 10 },
  { discoveredOffset: 86400 * 60, expected: 30 },
  { discoveredOffset: -1000, expected: 0 },
] as const;

function createMockDb(results: unknown[] | (() => Promise<{ results: unknown[] }>)): D1Database {
  return makeNoopD1({
    prepare: () => ({
      bind: () => ({
        all: typeof results === "function" ? results : async () => ({ results }),
      }),
    }),
  });
}

function makeKnownPoolIndex(entries: string[] = [], exactStablecoinId?: string): KnownPoolIdentityIndex {
  const known = createKnownPoolIdentityIndex();
  for (const entry of entries) {
    if (entry.startsWith("derived:")) {
      const [, chain, protocol, baseToken, quoteToken, poolType, feeTierBps, isStable] = entry.split(":");
      registerKnownPoolIdentity(known, buildPoolIdentity({
        chain, protocol, tokenAddresses: [baseToken ?? "", quoteToken ?? ""],
        poolType: poolType === "na" ? null : poolType,
        feeTierBps: feeTierBps === "na" ? null : Number(feeTierBps),
        isStable: isStable === "na" ? null : isStable === "stable",
      }));
      continue;
    }
    const [chain, poolAddressOrId] = entry.split(":");
    const identity = buildPoolIdentity({ chain, protocol: "test", poolAddressOrId, tokenAddresses: [] });
    registerKnownPoolIdentity(known, identity);
    if (exactStablecoinId) registerKnownPoolExactStablecoin(known, identity, exactStablecoinId);
  }
  return known;
}

function makeAuthIndex(
  entries: Array<{ protocol: string; chains: string[]; exactPoolKeys?: string[] }>,
): AuthoritativeStagedPoolConfirmationIndex {
  return {
    enforcedChainsByProtocol: new Map(entries.map((e) => [e.protocol, new Set(e.chains)])),
    confirmedExactKeysByProtocol: new Map(entries.map((e) => [e.protocol, new Set(e.exactPoolKeys ?? [])])),
  };
}

function makeUv4Known(): KnownPoolIdentityIndex {
  const known = createKnownPoolIdentityIndex();
  registerKnownPoolIdentity(known, buildPoolIdentity({
    chain: "Ethereum", protocol: "uniswap-v4",
    poolAddressOrId: "d0c42a48-871a-4e83-9ef2-b3f60b3e0e90",
    tokenAddresses: [BASE_TOKEN, QUOTE_TOKEN], poolType: "generic", isStable: true,
  }));
  return known;
}

function makeOrderbookRow(overrides: Partial<StagedPoolRow> = {}): StagedPoolRow {
  return makeStagedPoolRow({
    pool_id: "orderbook:binance:usdt-tether", source: "cg_tickers", chain: "orderbook",
    protocol: "binance", dex_id: "binance", symbol: "USDT/USD", tvl_usd: 500_000,
    volume_24h: 1_000_000, fee_tier: null, is_stable: 0, base_token: null, quote_token: null,
    quote_symbol: "USD", price_usd: 1.0001, raw_json: ORDERBOOK_RAW, discovered_at: NOW - 86_400 * 5,
    ...overrides,
  });
}

async function runMerge(
  rows: unknown[] | (() => Promise<{ results: unknown[] }>),
  opts: {
    metrics?: Map<string, SourcePoolGraph>;
    known?: KnownPoolIdentityIndex;
    now?: number;
    tracked?: Map<string, string>;
    auth?: AuthoritativeStagedPoolConfirmationIndex;
    counters?: ReturnType<typeof initLiquidityFallbackCounters>;
  } = {},
) {
  const metrics = opts.metrics ?? new Map<string, SourcePoolGraph>();
  const known = opts.known ?? makeKnownPoolIndex();
  const result = await mergeStagedPools(
    createMockDb(rows), metrics, known, opts.now ?? NOW,
    opts.tracked ?? new Map(), undefined, opts.auth, opts.counters,
  );
  return { result, metrics, known };
}

function makePoolEntry(poolId: string): PoolEntry {
  return {
    poolId, project: "uniswap-v3", chain: "Ethereum", tvlUsd: 100_000,
    symbol: "USDC / USDT", volumeUsd1d: 10_000, poolType: "uniswap-v3-5bp", source: "direct_api",
  };
}

describe("stagedPoolConfidence", () => {
  it.each(confidenceCases)("scores age $ageHours hours as $expected", ({ ageHours, expected }) => {
    expect(stagedPoolConfidence(ageHours)).toBe(expected);
  });
});

describe("stagedPoolMaturityDays", () => {
  it.each(maturityCases)("bounds discovery offset $discoveredOffset to $expected days", ({ discoveredOffset, expected }) => {
    expect(stagedPoolMaturityDays(NOW - discoveredOffset, NOW)).toBe(expected);
  });
});

describe("mergeStagedPools", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([null, 0])("preserves paired CG/GT projections and merge events for volume %s", async (volume) => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const log = vi.spyOn(cronLogger, "logCronEvent").mockImplementation(async (_db, event) => ({
      ...event, event: "cron_event", severity: event.severity ?? "info", recordedAt: now,
    }));
    const outputs = [];
    for (const source of ["cg_onchain", "gecko_terminal"] as const) {
      const { result, metrics } = await runMerge([
        makeStagedPoolRow({ source, price_usd: null, volume_24h: volume, balance_ratio: 0, fee_tier: 5.5, refreshed_at: now }),
        makeStagedPoolRow({ source: "dexscreener", price_usd: 0.998, tvl_usd: 80_000, volume_24h: null, refreshed_at: now - 3600 }),
      ], { now });
      const pool = metrics.get("usdt-tether")!.pools[0];
      expect(pool).toMatchObject({
        source, price: 0.998, priceObservedAt: now - 3600,
        priceSource: "dexscreener", priceEvidenceTvlUsd: 80_000,
        volumeReading: { volume24hUsd: volume, observedAtSec: volume == null ? null : now },
        extra: {
          balanceRatio: 0,
          measurement: {
            tvlMeasured: true, volumeMeasured: volume != null, balanceMeasured: true,
            maturityMeasured: false, priceMeasured: true, synthetic: false, decayed: false,
          },
        },
      });
      expect(pool.extra?.feeTier).toBe(source === "cg_onchain" ? 6 : undefined);
      expect(result.priceObservations.get("usdt-tether")).toEqual([
        expect.objectContaining({ price: 0.998, observedAt: now - 3600, sourceFamily: "dexscreener" }),
      ]);
      outputs.push({ ...pool, source: undefined, extra: { ...pool.extra, feeTier: undefined } });
    }
    expect(outputs[0]).toEqual(outputs[1]);
    expect(log.mock.calls.map(([, event]) => event)).toEqual([
      {
        job: "sync-dex-liquidity", eventType: "cg-pools-merged", severity: "info",
        message: "Merged CoinGecko pools into liquidity metrics.",
        metadata: { merged: 1, stablecoins: 1, withBalance: 1 },
      },
      {
        job: "sync-dex-liquidity", eventType: "gt-pools-merged", severity: "info",
        message: "Merged GeckoTerminal-compatible pools into liquidity metrics.",
        metadata: { merged: 1, stablecoins: 1 },
      },
    ]);
  });

  it.each(["cg_onchain", "gecko_terminal"] as const)(
    "keeps a September %s zero unavailable at current publication",
    async (source) => {
      const now = 1_800_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now * 1000);
      const { metrics } = await runMerge([
        makeStagedPoolRow({ source: "dl", volume_24h: null, refreshed_at: now }),
        makeStagedPoolRow({ source, volume_24h: 0, refreshed_at: 1_790_580_553 }),
      ], { now });
      const pools = metrics.get("usdt-tether")!.pools;
      applyPoolVolumeEligibility(pools, { asOfSec: now, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC });
      expect(pools[0]).toMatchObject({
        volumeUsd1d: null, volumeObservation: { status: "stale", observedAtSec: 1_790_580_553 },
        extra: { measurement: { volumeMeasured: false } },
      });
    },
  );

  it("carries cross-source price provenance through the merged pool", async () => {
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ source: "dl", tvl_usd: 200_000, price_usd: null }),
      makeStagedPoolRow({ source: "cg_onchain", price_usd: 0.998, refreshed_at: NOW - 6 * 3600 }),
    ]);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(metrics.get("usdt-tether")?.pools[0]).toMatchObject({
      source: "dl", tvlUsd: 200_000, price: 0.998, priceSource: "cg_onchain",
      priceObservedAt: NOW - 6 * 3600, priceEvidenceTvlUsd: 100_000,
    });
    expect(result.priceObservations.get("usdt-tether")?.[0]).toMatchObject({
      sourceFamily: "cg_onchain", observedAt: NOW - 6 * 3600,
    });
  });

  it("drops an implausible cross-source price without discarding the trusted value row", async () => {
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ stablecoin_id: "usdc-circle", source: "dl", tvl_usd: 200_000, price_usd: null }),
      makeStagedPoolRow({ stablecoin_id: "usdc-circle", source: "cg_onchain", price_usd: 0.005 }),
    ]);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.skipDimensions).toEqual([]);
    const pool = metrics.get("usdc-circle")?.pools[0];
    expect(pool).toMatchObject({ source: "dl", tvlUsd: 200_000 });
    expect(pool?.price).toBeUndefined();
    expect(pool?.extra?.measurement?.priceMeasured).toBe(false);
  });

  it("retains case-distinct Solana staged pools as separate identities", async () => {
    const upperPool = "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc";
    const lowerPool = "9j7m8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc";
    const makeRow = (poolId: string) => makeStagedPoolRow({
      pool_id: `solana:${poolId}`, stablecoin_id: "usdc-circle", chain: "solana",
      protocol: "raydium", dex_id: "raydium", balance_ratio: 1, quote_symbol: "USDT",
      base_token: "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1",
      quote_token: "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus",
    });
    const { result, metrics } = await runMerge([makeRow(upperPool), makeRow(lowerPool)]);

    expect(result.mergedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(metrics.get("usdc-circle")?.pools.map((p) => p.poolId)).toEqual([
      `solana:${upperPool}`, `solana:${lowerPool}`,
    ]);
  });

  it("supersedes an older legacy-lowercase Solana row with its corrected identity", async () => {
    const correctedPool = "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc";
    const correctedBase = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
    const correctedQuote = "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus";
    const makeRow = (poolId: string, base: string, quote: string, refreshedAt: number, source: StagedPoolRow["source"] = "gecko_terminal") =>
      makeStagedPoolRow({
        pool_id: `solana:${poolId}`, stablecoin_id: "usdc-circle", source, chain: "solana",
        protocol: "raydium", dex_id: "raydium", balance_ratio: 1,
        base_token: base, quote_token: quote, quote_symbol: "USDT", refreshed_at: refreshedAt,
      });
    const { result, metrics } = await runMerge([
      makeRow(correctedPool.toLowerCase(), correctedBase.toLowerCase(), correctedQuote.toLowerCase(), NOW - 60),
      makeRow(correctedPool, correctedBase, correctedQuote, NOW),
      makeRow(correctedPool, correctedBase, correctedQuote, NOW, "dl"),
    ]);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipDimensions).toContainEqual(
      expect.objectContaining({ reason: "legacy_lowercase_identity_superseded", count: 1 }),
    );
    expect(metrics.get("usdc-circle")?.pools.map((p) => p.poolId)).toEqual([`solana:${correctedPool}`]);
  });

  it("does not modify metrics when staging table is empty", async () => {
    const graph = initSourcePoolGraph("test-coin", "TEST");
    const originalPools = graph.pools;
    const { result, metrics } = await runMerge([], { metrics: new Map([[graph.stablecoinId, graph]]) });

    expect(result).toMatchObject({
      mergedCount: 0, skippedCount: 0, skippedByExactIdentityCount: 0, skippedByUniqueDerivedIdentityCount: 0,
    });
    expect(metrics.get("test-coin")?.pools).toBe(originalPools);
  });

  it("streams a production-sized fixture in row order and releases each consumed D1 row", async () => {
    const rowCount = 4_357;
    const poolAddress = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
    const rows = Array.from({ length: rowCount }, (_, i) => makeStagedPoolRow({
      pool_id: `ethereum:${poolAddress(i)}`, tvl_usd: 100_000 + i, fee_tier: null, price_usd: null,
    }));
    let nextReleasedIndex = 0;
    let releasedInOrder = true;
    const trackedRows = new Proxy<Array<(typeof rows)[number] | undefined>>(rows, {
      set(target, prop, value, receiver) {
        if (value === undefined && typeof prop === "string" && /^\d+$/.test(prop)) {
          releasedInOrder &&= Number(prop) === nextReleasedIndex;
          nextReleasedIndex++;
        }
        return Reflect.set(target, prop, value, receiver);
      },
    });
    const { result, metrics, known } = await runMerge(trackedRows);
    const topPools = metrics.get("usdt-tether")!.pools;

    expect(result.mergedCount).toBe(rowCount);
    expect(result.skippedCount).toBe(0);
    expect(topPools).toHaveLength(rowCount);
    expect(topPools.every((p, i) => p.poolId === `ethereum:${poolAddress(i)}`)).toBe(true);
    expect(known.exactKeys.size).toBe(rowCount);
    expect(nextReleasedIndex).toBe(rowCount);
    expect(releasedInOrder).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("skips pools that exist in knownPoolAddrs", async () => {
    const { result } = await runMerge([makeStagedPoolRow({ protocol: "pancakeswap-v3" })], {
      known: makeKnownPoolIndex([`ethereum:${EXACT_ADDR}`], "usdt-tether"),
    });

    expect(result).toMatchObject({
      skippedCount: 1, skippedByExactIdentityCount: 1, skippedByUniqueDerivedIdentityCount: 0, mergedCount: 0,
    });
    expect(result.skipDimensions).toEqual([
      { reason: "duplicate_exact_identity", protocol: "pancakeswap-v3", chain: "ethereum", count: 1, conflict: "exact" },
    ]);
  });

  it("skips staged pools with impossible TVL values", async () => {
    const { result } = await runMerge([makeStagedPoolRow({
      pool_id: `ethereum:${NEW_ADDR}`, source: "cg_onchain", symbol: "USDT/WETH",
      tvl_usd: STAGED_POOL_MAX_TVL_USD + 1, pool_type: "cg-cl-30bp", fee_tier: 30, is_stable: null, quote_symbol: "WETH",
    })]);

    expect(result.skippedCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(result.skipDimensions).toEqual([
      { reason: "invalid_tvl", protocol: "uniswap-v3", chain: "ethereum", count: 1, threshold: STAGED_POOL_MAX_TVL_USD },
    ]);
  });

  it("skips staged pools with implausible tracked token prices", async () => {
    const { result } = await runMerge([makeStagedPoolRow({
      pool_id: `ethereum:${NEW_ADDR}`, stablecoin_id: "xaut-tether", source: "cg_onchain",
      protocol: "carbon-defi-ethereum", dex_id: "carbon-defi-ethereum", symbol: "XAUt / sUSDS",
      tvl_usd: 2_020_820_673, volume_24h: 1_035_914_339, quality_multiplier: 0.8, pool_type: "cg-amm",
      is_stable: null, base_token: "0x68749665ff8d2d112fa859aa293f07a622782f38",
      quote_token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", quote_symbol: null, price_usd: 76259889535.2567,
    })]);

    expect(result.skippedCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(result.priceObservations.size).toBe(0);
    expect(result.skipDimensions).toEqual([
      { reason: "invalid_price", protocol: "carbon-defi-ethereum", chain: "ethereum", count: 1 },
    ]);
  });

  it("does not let stale zero-confidence rows make fresh duplicate fingerprints ambiguous", async () => {
    const staleAddr = "0x0000000000000000000000000000000000000999";
    const base = { protocol: "pancakeswap", dex_id: "pancakeswap-v3", quality_multiplier: 0.5, fee_tier: null, discovered_at: NOW - 100_000 };
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ ...base, pool_id: `ethereum:${NEW_ADDR}` }),
      makeStagedPoolRow({ ...base, pool_id: `ethereum:${staleAddr}`, refreshed_at: NOW - STAGED_POOL_CONFIDENCE_HORIZON_HOURS * 3600 - 30 }),
    ], { known: makeKnownPoolIndex([`derived:ethereum:pancakeswap-v3:${BASE_TOKEN}:${QUOTE_TOKEN}:gt-concentrated:na:stable`]) });

    expect(result).toMatchObject({ skippedCount: 2, skippedByUniqueDerivedIdentityCount: 1, mergedCount: 0 });
    expect(metrics.size).toBe(0);
    expect(result.skipDimensions).toEqual(expect.arrayContaining([
      { reason: "duplicate_unique_derived_identity", protocol: "pancakeswap", chain: "ethereum", count: 1, conflict: "derived_unique" },
      { reason: "stale_confidence_zero", protocol: "pancakeswap", chain: "ethereum", count: 1, threshold: STAGED_POOL_CONFIDENCE_HORIZON_HOURS },
    ]));
  });

  it("counts a multi-source view once when matching an identity-poor DL row", async () => {
    const poolId = "ethereum:0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893";
    const uv4 = { pool_id: poolId, stablecoin_id: "bold-liquity", protocol: "uniswap-v4", dex_id: "uniswap-v4-ethereum", fee_tier: null, is_stable: null };
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({
        ...uv4, source: "cg_onchain", symbol: "BOLD / USDC 0.05%", tvl_usd: 2_700_000, volume_24h: 260_000,
        quality_multiplier: 0.3, pool_type: "cg-concentrated", balance_ratio: 1, price_usd: 1.001, discovered_at: NOW - 3600,
      }),
      makeStagedPoolRow({ ...uv4, source: "gecko_terminal" }),
    ], { known: makeUv4Known() });

    expect(result).toMatchObject({ skippedCount: 1, skippedByOptionalWildcardIdentityCount: 1, mergedCount: 0 });
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.get("bold-liquity")).toHaveLength(1);
    expect(result.skipDimensions).toEqual([
      { reason: "duplicate_optional_wildcard_identity", protocol: "uniswap-v4", chain: "ethereum", count: 1, conflict: "derived_optional_wildcard" },
    ]);
  });

  it("keeps staged exact-pool-id same-pair pools when the incoming wildcard bucket is ambiguous", async () => {
    const uv4Base = {
      stablecoin_id: "bold-liquity", source: "cg_onchain" as const, protocol: "uniswap-v4",
      dex_id: "uniswap-v4-ethereum", quality_multiplier: 0.3, pool_type: "cg-concentrated",
      fee_tier: null, balance_ratio: 1, is_stable: null, discovered_at: NOW - 3600,
    };
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ ...uv4Base, pool_id: "ethereum:0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893", symbol: "BOLD / USDC 0.05%", tvl_usd: 2_700_000, volume_24h: 260_000, price_usd: 1.001 }),
      makeStagedPoolRow({ ...uv4Base, pool_id: "ethereum:0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5", symbol: "BOLD / USDC 0.01%", tvl_usd: 400_000, volume_24h: 20_000, price_usd: 1.0005 }),
    ], { known: makeUv4Known() });

    expect(result.skippedByOptionalWildcardIdentityCount).toBe(0);
    expect(result.mergedCount).toBe(2);
    expect(metrics.get("bold-liquity")?.pools).toHaveLength(2);
  });

  it("surfaces a missing mandatory staging table", async () => {
    await expect(runMerge(async () => {
      throw new Error("no such table: dex_pool_registry");
    })).rejects.toThrow("no such table: dex_pool_registry");
  });

  it("merges GT-style staged pools with confidence decay and GT dex quality", async () => {
    const decay = stagedPoolConfidence(150);
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: "bsc:0xpool1", chain: "bsc", protocol: "pancakeswap-v3",
      dex_id: undefined as unknown as string, quality_multiplier: null, pool_type: undefined as unknown as string,
      fee_tier: null, base_token: "0xbase", quote_token: "0xquote",
      discovered_at: NOW - 86400 * 10, refreshed_at: NOW - 3600 * 150,
    })]);
    const metric = scorePoolGraph(metrics.get("usdt-tether")!);

    expect(result).toMatchObject({ mergedCount: 1, skippedCount: 0, skippedByExactIdentityCount: 0, skippedByUniqueDerivedIdentityCount: 0 });
    expect(result.priceObservations.get("usdt-tether")).toBeUndefined();
    expect(metric.totalTvlUsd).toBeCloseTo(100_000 * decay, 6);
    expect(metric.topPools[0]?.volumeReading).toMatchObject({ volume24hUsd: 50_000, observedAtSec: NOW - 3600 * 150 });
    expect(metric.poolCount).toBe(1);
    expect(metric.qualityAdjustedTvl).toBe(Math.round(100_000 * decay * 0.5));
    expect(metric.protocolTvl.pancakeswap).toBeCloseTo(100_000 * decay, 6);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]).toMatchObject({ source: "gecko_terminal", poolId: "bsc:0xpool1" });
  });

  it("keeps decayed TVL but withholds price evidence past the price window", async () => {
    const mergeAtAge = async (ageHours: number) => {
      const { result, metrics } = await runMerge([makeStagedPoolRow({ refreshed_at: NOW - ageHours * 3600 })]);
      return { result, metric: scorePoolGraph(metrics.get("usdt-tether")!) };
    };

    const fresh = await mergeAtAge(STAGED_POOL_PRICE_MAX_AGE_HOURS - 1);
    expect(fresh.metric.totalTvlUsd).toBe(100_000);
    expect(fresh.metric.topPools[0]?.extra?.measurement).toMatchObject({ priceMeasured: true });
    expect(fresh.result.priceObservations.get("usdt-tether")).toHaveLength(1);

    const aged = await mergeAtAge(STAGED_POOL_PRICE_MAX_AGE_HOURS + 1);
    expect(aged.metric.totalTvlUsd).toBeLessThan(100_000);
    expect(aged.metric.totalTvlUsd).toBeCloseTo(100_000 * stagedPoolConfidence(STAGED_POOL_PRICE_MAX_AGE_HOURS + 1), 6);
    expect(aged.metric.topPools[0]?.price ?? 0).toBe(0);
    expect(aged.metric.topPools[0]?.extra?.measurement).toMatchObject({ priceMeasured: false, decayed: true });
    expect(aged.result.priceObservations.get("usdt-tether")).toBeUndefined();
  });

  it("retires rows past the confidence horizon and keeps rows inside it", async () => {
    const insideAddr = "0x0000000000000000000000000000000000000aaa";
    const pastAddr = "0x0000000000000000000000000000000000000bbb";
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ pool_id: `ethereum:${insideAddr}`, refreshed_at: NOW - 300 * 3600 }),
      makeStagedPoolRow({ pool_id: `ethereum:${pastAddr}`, refreshed_at: NOW - 337 * 3600 }),
    ]);
    const metric = scorePoolGraph(metrics.get("usdt-tether")!);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipDimensions).toEqual([
      { reason: "stale_confidence_zero", protocol: "uniswap-v3", chain: "ethereum", count: 1, threshold: STAGED_POOL_CONFIDENCE_HORIZON_HOURS },
    ]);
    expect(metric.poolCount).toBe(1);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]?.poolId).toBe(`ethereum:${insideAddr}`);
    expect(metric.totalTvlUsd).toBeCloseTo(100_000 * stagedPoolConfidence(300), 6);
    expect(result.priceObservations.get("usdt-tether")).toBeUndefined();
  });

  it("retains Horizon as the source family for a priced Stellar pool", async () => {
    const poolId = "328306d8d623aa358415f29fca051afbbe8f0c591c28bbcb78e80907deffb2a7";
    const eurcIssuer = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
    const usdcIssuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: `stellar:${poolId}`, stablecoin_id: "eurc-circle", source: "horizon", chain: "stellar",
      protocol: "stellar-sdex", dex_id: "stellar-sdex", symbol: "EURC / USDC", tvl_usd: 220, volume_24h: null,
      quality_multiplier: null, pool_type: "stellar-constant-product", fee_tier: 30, is_stable: null,
      base_token: `EURC-${eurcIssuer}`,
      quote_token: `USDC-${usdcIssuer}`,
      price_usd: 1.1, raw_json: JSON.stringify({ valuation: { kind: "market", observedAtSec: NOW - 90 } }), discovered_at: NOW,
    })]);

    expect(result.mergedCount).toBe(1);
    expect(metrics.get("eurc-circle")?.pools).toHaveLength(1);
    expect(metrics.get("eurc-circle")?.pools[0]).toMatchObject({
      poolId: `stellar:${poolId}`, source: "horizon", tvlUsd: 220, priceObservedAt: NOW - 90,
    });
  });

  it.each([
    { source: "aquarius", chain: "stellar" },
    { source: "tezos", chain: "tezos" },
    { source: "icon-balanced", chain: "icon" },
    { source: "kava-swap", chain: "kava" },
  ] as const)("preserves $source as its explicit source family", async ({ source, chain }) => {
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: `${chain}:${source}-pool`, source, chain, protocol: source, dex_id: source, symbol: `${source}/USD`,
      raw_json: source === "tezos" ? JSON.stringify({ identityReviewVersion: TEZOS_POOL_IDENTITY_REVIEW_VERSION }) : null,
      price_usd: null,
    })]);

    expect(result.mergedCount).toBe(1);
    expect(metrics.get("usdt-tether")?.pools[0]).toMatchObject({ source });
  });

  it.each([null, "{}", "{", JSON.stringify({ reserves: [{ identityReviewVersion: TEZOS_POOL_IDENTITY_REVIEW_VERSION }] })])(
    "rejects legacy or unreviewed Tezos staging: %s",
    async (raw_json) => {
      const { result, metrics } = await runMerge([makeStagedPoolRow({ source: "tezos", chain: "tezos", raw_json })]);
      expect(result.mergedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(metrics.size).toBe(0);
    },
  );

  it.each([
    { scope: "tezos:", poolType: "tezos-stable-swap", protocol: "tezos-amm" },
    { scope: "", poolType: "tezos-constant-product", protocol: "vortex" },
  ])("keeps reviewed Youves TVL without a ratio price for legacy $poolType rows", async ({ scope, poolType, protocol }) => {
    const address = "KT1JeWiS8j1kic4PHx7aTnEr9p4xVtJNzk5b";
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: `${scope}${address}`, stablecoin_id: "uusd-youves", source: "tezos", chain: "tezos",
      protocol, dex_id: protocol, pool_type: poolType, symbol: "uUSD/wUSDC",
      base_token: "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW", quote_token: "KT18fp5rcTW7mbWDmzFwjLDUhs5MeJmagDSZ",
      price_usd: 0.99, raw_json: JSON.stringify({ identityReviewVersion: TEZOS_POOL_IDENTITY_REVIEW_VERSION }),
    })]);
    const retained = metrics.get("uusd-youves")?.pools[0];
    expect(result.mergedCount).toBe(1);
    expect(retained).toMatchObject({
      poolId: `tezos:${address}`, tvlUsd: 100_000,
      extra: { measurement: { tvlMeasured: true, priceMeasured: false } },
    });
    expect(retained?.price).toBeUndefined();
    expect(retained?.priceObservedAt).toBeUndefined();
    expect(result.priceObservations.has("uusd-youves")).toBe(false);
  });

  it.each([
    null, "{}", "{",
    JSON.stringify({ nested: { identityReviewVersion: SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION } }),
    JSON.stringify({ identityReviewVersion: SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION }),
  ])("only replays factory-reviewed Slipstream writeback: %s", async (raw_json) => {
    const { result } = await runMerge([makeStagedPoolRow({
      source: "direct_api", protocol: "aerodrome", pool_type: "aerodrome-slipstream-1bp", raw_json,
    })]);
    expect(result.mergedCount).toBe(raw_json === JSON.stringify({ identityReviewVersion: SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION }) ? 1 : 0);
  });

  it("retains exact pool attribution for cross-asset fixtures", async () => {
    const evmAddr = "0x0000000000000000000000000000000000000456";
    const solAddr = "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc";
    const fixtures = [
      { stablecoinId: "aznd-mu-digital", chain: "ethereum", poolAddress: evmAddr },
      { stablecoinId: "isc-international-stable-currency", chain: "solana", poolAddress: solAddr },
    ] as const;
    const rows = fixtures.map((f) => {
      const sol = f.chain === "solana";
      return makeStagedPoolRow({
        pool_id: `${f.chain}:${f.poolAddress}`, stablecoin_id: f.stablecoinId, chain: f.chain,
        protocol: sol ? "orca" : "uniswap-v3", dex_id: sol ? "orca" : "uniswap-v3",
        symbol: sol ? "FIXTURE/USDC" : "FIXTURE/USDT", tvl_usd: 180_000, volume_24h: 90_000,
        pool_type: sol ? "orca-whirlpool" : "gt-concentrated", fee_tier: sol ? 1 : 5,
        base_token: sol ? "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1" : BASE_TOKEN,
        quote_token: sol ? "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus" : QUOTE_TOKEN,
        quote_symbol: sol ? "USDC" : "USDT", price_usd: null,
      });
    });
    const seedMetrics = new Map([
      ["fixture-evm-owner", { pools: [{ poolId: `ethereum:${evmAddr}`, chain: "Ethereum", project: "uniswap-v3" }] }],
      ["fixture-solana-owner", { pools: [{ poolId: `solana:${solAddr}`, chain: "Solana", project: "orca" }] }],
    ]) as unknown as Map<string, SourcePoolGraph>;

    const { result, metrics, known } = await runMerge(rows, {
      metrics: seedMetrics,
      known: makeKnownPoolIndex([`ethereum:${evmAddr}`, `solana:${solAddr}`]),
    });

    expect(result.mergedCount).toBe(fixtures.length);
    expect(result.skippedByExactIdentityCount).toBe(0);
    for (const f of fixtures) expect(metrics.get(f.stablecoinId)?.pools).toHaveLength(1);
    expect(known.exactStablecoinIdsByKey.get(`ethereum:${evmAddr}`)).toEqual(new Set(["fixture-evm-owner", "aznd-mu-digital"]));
    expect(known.exactStablecoinIdsByKey.get(`solana:${solAddr}`)).toEqual(new Set(["fixture-solana-owner", "isc-international-stable-currency"]));
  });

  it("credits the same exact staged pool to each tracked stablecoin row", async () => {
    const sharedAddr = "0x0000000000000000000000000000000000000123";
    const shared = { pool_id: `ethereum:${sharedAddr}`, tvl_usd: 180_000, volume_24h: 90_000, fee_tier: null, discovered_at: NOW - 86400 * 2 };
    const { result, metrics, known } = await runMerge([
      makeStagedPoolRow(shared),
      makeStagedPoolRow({ ...shared, stablecoin_id: "usdc-circle", symbol: "USDC/USDT", quote_symbol: "USDT" }),
    ]);

    expect(result).toMatchObject({ mergedCount: 2, skippedCount: 0, skippedByExactIdentityCount: 0 });
    expect(metrics.get("usdt-tether")?.pools).toHaveLength(1);
    expect(metrics.get("usdc-circle")?.pools).toHaveLength(1);
    expect(metrics.get("usdt-tether")?.pools[0]?.poolId).toBe(`ethereum:${sharedAddr}`);
    expect(metrics.get("usdc-circle")?.pools[0]?.poolId).toBe(`ethereum:${sharedAddr}`);
    expect(known.exactKeys.has(`ethereum:${sharedAddr}`)).toBe(true);
  });

  it("skips staged pools that claim an authoritative protocol without authoritative exact-id confirmation", async () => {
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({
        pool_id: "plasma:0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea", stablecoin_id: "usdai-usd-ai",
        chain: "plasma", protocol: "balancer", dex_id: "balancer-v3-plasma", symbol: "USDai/USDT0",
        tvl_usd: 2_250_000, volume_24h: 0, pool_type: "stable", fee_tier: null, quote_symbol: "USDT0",
        base_token: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", quote_token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
      }),
      makeStagedPoolRow({
        pool_id: "sonic:0x615a8330c9bd50d8ee73a8a9588915b135aba93c", stablecoin_id: "scusd-rings",
        source: "cg_onchain", chain: "sonic", protocol: "beets-v3-sonic", dex_id: "beets-v3-sonic", tvl_usd: 15_980.44, volume_24h: 0,
      }),
    ], { auth: makeAuthIndex([{ protocol: "balancer", chains: ["plasma", "sonic"] }]) });

    expect(result).toMatchObject({ mergedCount: 0, skippedCount: 2, skippedByAuthoritativeProtocolCount: 2 });
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.get("usdai-usd-ai")).toBeUndefined();
    expect(result.skipDimensions).toEqual([
      { reason: "authoritative_confirmation_missing", protocol: "beets-v3-sonic", chain: "sonic", count: 1 },
      { reason: "authoritative_confirmation_missing", protocol: "balancer", chain: "plasma", count: 1 },
    ]);
  });

  it("does not apply Slipstream confirmation to classic Aerodrome staged pools", async () => {
    const poolAddress = "0xffdf1e3160b60c2e499fa25e51b5c192b9b15e3b";
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: `base:${poolAddress}`, stablecoin_id: "bd-basedollar", source: "cg_onchain", chain: "base",
      protocol: "aerodrome", dex_id: "aerodrome-base", symbol: "BD/USDC", tvl_usd: 83_019.74, volume_24h: 27_452.2,
      quality_multiplier: 0.3, pool_type: "cg-amm", fee_tier: null, is_stable: null, price_usd: 1.0047, discovered_at: NOW - 60,
      base_token: "0x252d36f435582ecb01686448d21e8c9ea0b2ca65", quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    })], { auth: makeAuthIndex([{ protocol: "aerodrome", chains: ["base"] }]) });

    expect(result.mergedCount).toBe(1);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(0);
    expect(metrics.get("bd-basedollar")?.pools[0]).toMatchObject({ poolId: `base:${poolAddress}`, project: "aerodrome" });
  });

  it("still requires exact confirmation for staged Aerodrome Slipstream pools", async () => {
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: "base:0x1111111111111111111111111111111111111111", stablecoin_id: "bd-basedollar", source: "cg_onchain",
      chain: "base", protocol: "aerodrome", dex_id: "aerodrome-slipstream", symbol: "BD/USDC", volume_24h: 30_000,
      quality_multiplier: 0.7, pool_type: "cg-cl-1bp", fee_tier: 1, is_stable: null, price_usd: 1.0047, discovered_at: NOW - 60,
      base_token: "0x252d36f435582ecb01686448d21e8c9ea0b2ca65", quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    })], { auth: makeAuthIndex([{ protocol: "aerodrome", chains: ["base"] }]) });

    expect(result.mergedCount).toBe(0);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(1);
    expect(metrics.size).toBe(0);
    expect(result.skipDimensions).toContainEqual({
      reason: "authoritative_confirmation_missing", protocol: "aerodrome", chain: "base", count: 1,
    });
  });

  it("fails open for staged pools when authoritative confirmation is unavailable", async () => {
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: "plasma:0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54", stablecoin_id: "usdai-usd-ai",
      chain: "plasma", protocol: "balancer", dex_id: "balancer-v3-plasma", symbol: "USDai/USDT0",
      tvl_usd: 547_760, volume_24h: 20_190, pool_type: "stable", fee_tier: null, quote_symbol: "USDT0",
      base_token: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", quote_token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
    })]);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(0);
    expect(scorePoolGraph(metrics.get("usdai-usd-ai")!).protocolTvl.balancer).toBe(547_760);
  });

  it("retains staged pools that sit below the direct-API census TVL floor", async () => {
    const orcaPool = "EJ3FwL8D2PkAaHmj1vawbR7fiUhXomt7vJhAaTBW4dnH";
    const raydiumPool = "6GGYCNjZ5jqNFRfjJqCRdYiiTZY47LfweYAA4RRsYb4A";
    const solCg = { source: "cg_onchain" as const, chain: "solana", quality_multiplier: 0.3, pool_type: "cg-amm", fee_tier: null, is_stable: null };
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({
        ...solCg, pool_id: `solana:${orcaPool}`, stablecoin_id: "qcad-stablecorp", protocol: "orca", dex_id: "orca",
        symbol: "USDC / QCAD", tvl_usd: 1_736.8361, volume_24h: 12, quote_symbol: "QCAD", price_usd: 0.72,
        base_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", quote_token: "EeBX9JLdvsp4HnBbMgC1HnAjBkBQxgxtWxspcCLtT6ci",
      }),
      makeStagedPoolRow({
        ...solCg, pool_id: `solana:${raydiumPool}`, stablecoin_id: "susd-solayer", protocol: "raydium", dex_id: "raydium-clmm",
        symbol: "sUSD / USDC", tvl_usd: 7_834.2681, volume_24h: 340, price_usd: 1.0002,
        base_token: "susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X", quote_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
    ], { auth: makeAuthIndex([{ protocol: "orca", chains: ["solana"] }, { protocol: "raydium", chains: ["solana"] }]) });

    expect(result.skippedByAuthoritativeProtocolCount).toBe(0);
    expect(result.mergedCount).toBe(2);
    expect(metrics.get("qcad-stablecorp")?.pools[0]?.poolId).toBe(`solana:${orcaPool}`);
    expect(metrics.get("susd-solayer")?.pools[0]?.poolId).toBe(`solana:${raydiumPool}`);
  });

  it("still requires confirmation for staged pools at or above the census TVL floor", async () => {
    const { result } = await runMerge([makeStagedPoolRow({
      pool_id: "solana:2D9mokxthTheNAU6hCWGRXdNmhNQoypHs1JcRCbwkgLL", stablecoin_id: "qcad-stablecorp",
      source: "cg_onchain", chain: "solana", protocol: "orca", dex_id: "orca", symbol: "USDC / QCAD",
      tvl_usd: 10_000, volume_24h: 900, quality_multiplier: 0.3, pool_type: "cg-amm", fee_tier: null, is_stable: null,
      base_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", quote_token: "EeBX9JLdvsp4HnBbMgC1HnAjBkBQxgxtWxspcCLtT6ci",
      quote_symbol: "QCAD", price_usd: 0.72,
    })], { auth: makeAuthIndex([{ protocol: "orca", chains: ["solana"] }]) });

    expect(result.mergedCount).toBe(0);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(1);
  });

  it("does not apply Pancake V3 authority to an exact Pancake V2 pool", async () => {
    const poolAddress = "0x108752b2a22c731ede3edac2205c63ae553e221a";
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: `bsc:${poolAddress}`, stablecoin_id: "u-united-stables", source: "dexscreener", chain: "bsc",
      protocol: "pancakeswap", dex_id: "pancakeswap", symbol: "U/WBNB", tvl_usd: 150_000, volume_24h: 25_000,
      quality_multiplier: 0.5, pool_type: "ds-amm", fee_tier: null, is_stable: null, quote_symbol: "WBNB",
      base_token: "0xce24439f2d9c6a2289f741120fe202248b666666", quote_token: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    })], { auth: makeAuthIndex([{ protocol: "pancakeswap", chains: ["bsc"] }]) });

    expect(result.mergedCount).toBe(1);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(0);
    expect(metrics.get("u-united-stables")?.pools[0]?.extra?.evmV2ExecutionCandidate).toMatchObject({
      source: "pancakeswap-v2", poolAddress,
    });
  });

  it("merges CG staged pools and preserves balance ratio and locked liquidity", async () => {
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: "ethereum:0xcgpool", source: "cg_onchain", protocol: "pancakeswap-v3",
      dex_id: undefined as unknown as string, quality_multiplier: null, pool_type: undefined as unknown as string,
      balance_ratio: 0.8, base_token: "0xbase", quote_token: "0xquote", locked_liq_pct: 90, discovered_at: NOW - 86400 * 10,
    })]);
    const metric = scorePoolGraph(metrics.get("usdt-tether")!);

    expect(result).toMatchObject({ mergedCount: 1, skippedCount: 0, skippedByExactIdentityCount: 0, skippedByUniqueDerivedIdentityCount: 0 });
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(1);
    expect(metric).toMatchObject({
      totalTvlUsd: 100_000, totalTvlForBalance: 100_000, balanceRatioWeightedSum: 80_000,
      totalTvlForLocked: 100_000, lockedLiqWeightedSum: 90_000,
    });
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]).toMatchObject({
      source: "cg_onchain", volumeReading: { volume24hUsd: 50_000, observedAtSec: NOW },
      extra: { balanceRatio: 0.8, feeTier: 5 },
    });
  });

  it("extracts price observations from pools skipped by address dedup", async () => {
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: `ethereum:${SECOND_ADDR}`, source: "cg_onchain", dex_id: "uniswap_v3",
      price_usd: 0.9998, discovered_at: NOW - 86400 * 10,
    })], { known: makeKnownPoolIndex([`ethereum:${SECOND_ADDR}`], "usdt-tether") });

    expect(result).toMatchObject({ skippedCount: 1, skippedByExactIdentityCount: 1, mergedCount: 0 });
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toEqual([
      expect.objectContaining({ price: 0.9998, tvl: 100_000, chain: "ethereum" }),
    ]);
  });

  it("extracts price observations from pools skipped by fingerprint dedup", async () => {
    const { result, metrics } = await runMerge([makeStagedPoolRow({
      pool_id: `ethereum:${NEW_ADDR}`, protocol: "pancakeswap", dex_id: "pancakeswap-v3",
      tvl_usd: 80_000, volume_24h: 40_000, quality_multiplier: 0.5, fee_tier: null,
      price_usd: 1.0001, raw_json: ORDERBOOK_RAW, discovered_at: NOW - 86400 * 5,
    })], { known: makeKnownPoolIndex([`derived:ethereum:pancakeswap-v3:${BASE_TOKEN}:${QUOTE_TOKEN}:gt-concentrated:na:stable`]) });

    expect(result).toMatchObject({ skippedCount: 1, skippedByUniqueDerivedIdentityCount: 1, mergedCount: 0 });
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toEqual([
      expect.objectContaining({ price: 1.0001, tvl: 80_000 }),
    ]);
  });

  it("does NOT extract price observation from deduped pool with sub-threshold TVL", async () => {
    const { result } = await runMerge([makeStagedPoolRow({
      pool_id: `ethereum:${SECOND_ADDR}`, source: "cg_onchain", dex_id: "uniswap_v3",
      tvl_usd: 30_000, volume_24h: 5_000, discovered_at: NOW - 86400 * 10,
    })], { known: makeKnownPoolIndex([`ethereum:${SECOND_ADDR}`], "usdt-tether") });

    expect(result.skippedCount).toBe(1);
    expect(result.priceObservations.get("usdt-tether")).toBeUndefined();
  });

  it.each([null, 500_000])("keeps ticker prices but no liquidity for stored TVL %s", async (tvl_usd) => {
    const { result, metrics } = await runMerge([makeOrderbookRow({ tvl_usd })]);

    expect(result.mergedCount).toBe(0);
    expect(metrics.has("usdt-tether")).toBe(false);
    expect(result.registryFamilyBySource).toEqual({});
    expect(result.priceObservations.get("usdt-tether")).toEqual([
      expect.objectContaining({ price: 1.0001, tvl: 0, observedVolumeUsd: 1_000_000, sourceFamily: "cg_tickers" }),
    ]);
  });

  it("keeps legacy ticker price identity separate across stablecoins without scoring pools", async () => {
    const { result, metrics } = await runMerge([
      makeOrderbookRow({ pool_id: "orderbook:binance", stablecoin_id: "usdt-tether", symbol: "USDT/USD" }),
      makeOrderbookRow({ pool_id: "orderbook:binance", stablecoin_id: "usdc-circle", symbol: "USDC/USD" }),
    ]);

    expect(result).toMatchObject({ mergedCount: 0, skippedCount: 0, skippedByExactIdentityCount: 0 });
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.get("usdt-tether")?.[0].poolKey).toBe("orderbook:binance:usdt-tether");
    expect(result.priceObservations.get("usdc-circle")?.[0].poolKey).toBe("orderbook:binance:usdc-circle");
  });

  it("removes only ticker liquidity from a mixed coin", async () => {
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ source: "cg_onchain", tvl_usd: 100_000, price_usd: 1 }),
      makeOrderbookRow({ tvl_usd: 30_000_000, volume_24h: 10_000_000, price_usd: 1 }),
    ]);
    const metric = scorePoolGraph(metrics.get("usdt-tether")!);
    expect(result.mergedCount).toBe(1);
    expect(metric.totalTvlUsd).toBe(100_000);
    expect(metrics.get("usdt-tether")?.pools).toHaveLength(1);
    expect(metrics.get("usdt-tether")?.pools[0].source).toBe("cg_onchain");
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(2);
  });

  it.each([
    { age: 24 * 3600 + 1, volume: 100_000 },
    { age: -1, volume: 100_000 },
    { age: 0, volume: null },
    { age: 0, volume: 999 },
  ])("does not admit unusable ticker price evidence %j", async ({ age, volume }) => {
    const { result, metrics } = await runMerge([makeOrderbookRow({
      tvl_usd: 30_000_000, volume_24h: volume, price_usd: 1, refreshed_at: NOW - age,
    })]);
    expect(metrics.size).toBe(0);
    expect(result.priceObservations.size).toBe(0);
  });

  it("resolves two sources to one pool while keeping value family and price provenance independent", async () => {
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ source: "dl", tvl_usd: 200_000, price_usd: null, base_token: null, quote_token: null }),
      makeStagedPoolRow({ source: "cg_onchain", tvl_usd: 100_000, price_usd: 0.999 }),
    ]);
    expect(result).toMatchObject({
      mergedCount: 1, skippedCount: 0, registryRowsRead: 2, registryMultiSourcePools: 1, registryFamilyBySource: { dl: 1 },
    });
    expect(metrics.get("usdt-tether")?.pools[0]).toMatchObject({ source: "dl", tvlUsd: 200_000 });
    expect(result.priceObservations.get("usdt-tether")?.[0]).toMatchObject({ sourceFamily: "cg_onchain", price: 0.999 });
  });

  it("applies an authoritative census veto to the whole multi-source view", async () => {
    const { result, metrics } = await runMerge([
      makeStagedPoolRow({ source: "dl", protocol: "pancakeswap", dex_id: "pancakeswap-v3" }),
      makeStagedPoolRow({ source: "cg_onchain", protocol: "pancakeswap", dex_id: "pancakeswap-v3" }),
    ], { auth: makeAuthIndex([{ protocol: "pancakeswap", chains: ["ethereum"], exactPoolKeys: [] }]) });
    expect(result.mergedCount).toBe(0);
    expect(result.skippedByAuthoritativeProtocolCount).toBe(1);
    expect(result.priceObservations.size).toBe(0);
    expect(metrics.size).toBe(0);
  });
});

describe("mergeStagedPools dead-pool floor (v6.92)", () => {
  const DEAD_NOW = 1_800_000_000;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(DEAD_NOW * 1000);
  });
  afterEach(() => vi.restoreAllMocks());
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
  const JUNK = "0x4c3f33fd2f6cf46dd53940eba9b7d0b16cef4e7b";
  const makeTracked = (extra: Array<[string, string]> = []) => new Map<string, string>([
    [`base:${USDC}`, "usdc-circle"], [`base:${USDT}`, "usdt-tether"], ...extra,
  ]);
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const cgZeroRow = (n: number, overrides: Partial<StagedPoolRow> = {}) => makeStagedPoolRow({
    pool_id: `base:${address(n)}`, stablecoin_id: "usdc-circle", source: "cg_onchain", chain: "base",
    protocol: "uniswap-v3", dex_id: "uniswap_v3_base", symbol: "JUNK / USDC",
    tvl_usd: 5_000_000, volume_24h: 0, base_token: JUNK, quote_token: USDC, refreshed_at: DEAD_NOW - 3600,
    ...overrides,
  });
  const scoreRetained = (metric: SourcePoolGraph) => {
    applyPoolVolumeEligibility(metric.pools, { asOfSec: DEAD_NOW, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC });
    return filterRetainedPools(metric.pools).map((pool) => pool.poolId);
  };

  it("signs only trade-verified zeros against untracked counter-tokens and withholds their prices", async () => {
    const counters = initLiquidityFallbackCounters();
    const { result, metrics } = await runMerge([
      cgZeroRow(1),
      cgZeroRow(2, { base_token: USDT, symbol: "USDT / USDC" }),
      cgZeroRow(3, { source: "gecko_terminal" }),
      cgZeroRow(4, { refreshed_at: DEAD_NOW - 6 * 3600 - 60 }),
      cgZeroRow(5, { volume_24h: 12 }),
      cgZeroRow(6, { tvl_usd: 999_999 }),
      cgZeroRow(7, { base_token: null }),
    ], { now: DEAD_NOW, tracked: makeTracked(), counters });

    const metric = metrics.get("usdc-circle")!;
    const signed = metric.pools.filter((p) => p.volumeReading?.deadPoolSignature).map((p) => p.poolId);
    expect(signed.sort()).toEqual([1, 4, 6].map((n) => `base:${address(n)}`));
    expect(result.priceObservations.get("usdc-circle")?.map((o) => o.poolKey).sort()).toEqual(
      [2, 3, 5, 6, 7].map((n) => `base:${address(n)}`),
    );
    expect(counters.stagedDeadPoolPriceObservationExcluded).toBe(2);
    expect(scoreRetained(metric).sort()).toEqual([2, 3, 5, 6, 7].map((n) => `base:${address(n)}`));
  });

  it("signs no zero on a chain where CoinGecko reports no positive in-window volume", async () => {
    const hydrationRow = (n: number, overrides: Partial<StagedPoolRow> = {}) =>
      cgZeroRow(n, { pool_id: `hydration:${address(n)}`, chain: "hydration", protocol: "hydration-dex", dex_id: "hydration-dex", ...overrides });
    const { result, metrics } = await runMerge([
      cgZeroRow(11),
      cgZeroRow(12, { volume_24h: 12 }),
      hydrationRow(13),
      hydrationRow(14, { tvl_usd: 2_000_000 }),
      cgZeroRow(15, { chain: "moonriver", pool_id: `moonriver:${address(15)}`, volume_24h: 900, refreshed_at: DEAD_NOW - DEX_VOLUME_OBSERVATION_MAX_AGE_SEC - 1 }),
      cgZeroRow(16, { chain: "moonriver", pool_id: `moonriver:${address(16)}` }),
    ], { now: DEAD_NOW, tracked: makeTracked([[`hydration:${USDC}`, "usdc-circle"], [`moonriver:${USDC}`, "usdc-circle"]]) });

    const signed = metrics.get("usdc-circle")!.pools.filter((p) => p.volumeReading?.deadPoolSignature).map((p) => p.poolId);
    expect(signed).toEqual([`base:${address(11)}`]);
    expect(result.deadPoolUnindexedChainSkips).toEqual({
      hydration: { poolCount: 2, tvlUsd: 7_000_000 },
      moonriver: { poolCount: 1, tvlUsd: 5_000_000 },
    });
  });

  it("hands a live pool without volume the trade-verified zero of the registry view it dedup-skips", async () => {
    const slipstream = `base:${address(8)}`;
    const quiet = `base:${address(9)}`;
    const metric = initSourcePoolGraph("usdc-circle", "USDC");
    const livePool = makePool({
      poolId: slipstream, project: "aerodrome", chain: "base", tvlUsd: 23_667_525,
      volumeUsd1d: null, volumeUsd7d: null,
      volumeReading: { volume24hUsd: null, volume7dUsd: null, observedAtSec: null },
      poolType: "aerodrome-slipstream-100bp", source: "direct_api", price: 1,
    });
    const measuredPool = makePool({
      poolId: quiet, project: "aerodrome", chain: "base", tvlUsd: 2_000_000, volumeUsd1d: 40_000,
      volumeReading: { volume24hUsd: 40_000, volume7dUsd: null, observedAtSec: DEAD_NOW }, source: "direct_api",
    });
    metric.pools.push(livePool, measuredPool);
    const counters = initLiquidityFallbackCounters();
    const slipstreamRow = {
      stablecoin_id: "usdc-circle", source: "direct_api" as const, chain: "base", protocol: "aerodrome",
      dex_id: "aerodrome", pool_type: "aerodrome-slipstream-100bp", volume_24h: null, base_token: null,
      quote_token: null, refreshed_at: DEAD_NOW - 600,
      raw_json: JSON.stringify({ identityReviewVersion: SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION }),
    };

    const { result } = await runMerge([
      makeStagedPoolRow({ ...slipstreamRow, pool_id: slipstream, tvl_usd: 23_667_525 }),
      cgZeroRow(8, { dex_id: "aerodrome-slipstream", protocol: "aerodrome", tvl_usd: 22_551_139, refreshed_at: DEAD_NOW - 4 * 3600 }),
      makeStagedPoolRow({ ...slipstreamRow, pool_id: quiet, tvl_usd: 2_000_000 }),
      cgZeroRow(9, { dex_id: "aerodrome-slipstream", protocol: "aerodrome", tvl_usd: 2_000_000, volume_24h: 30_000 }),
    ], { metrics: new Map([["usdc-circle", metric]]), known: createKnownPoolIdentityIndex(), now: DEAD_NOW, tracked: makeTracked(), counters });

    expect(result.skippedByExactIdentityCount).toBe(2);
    expect(counters.stagedLiveVolumeBackfill).toBe(1);
    expect(livePool.volumeReading).toEqual({
      volume24hUsd: 0, volume7dUsd: null, observedAtSec: DEAD_NOW - 4 * 3600, deadPoolSignature: true,
    });
    expect(measuredPool.volumeReading).toEqual({ volume24hUsd: 40_000, volume7dUsd: null, observedAtSec: DEAD_NOW });
    expect(result.priceObservations.get("usdc-circle")?.map((o) => o.poolKey)).toEqual([quiet]);
    expect(scoreRetained(metric)).toEqual([quiet]);
  });
});

describe("secondary DEX pool merges", () => {
  it("retains duplicate execution evidence through the indexed merge path", async () => {
    const metrics = new Map<string, SourcePoolGraph>();
    const basePool = makeGtPool(`0x${"1".repeat(40)}`);
    const executionModel: NonNullable<GtNewPool["ammExecutionModel"]> = {
      source: "raydium", invariant: "constant-product", trackedTokenIndex: 0, feeRate: 0.0025,
      tokens: [
        { address: "UsdcMint", symbol: "USDC", decimals: 6, balance: 100_000, referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: "usdc-circle" },
        { address: "UsdtMint", symbol: "USDT", decimals: 6, balance: 100_000, referencePriceUsd: 1, referencePriceSource: "tracked-market", trackedAssetId: "usdt-tether" },
      ],
    };

    await mergeGtPools(metrics, new Map([["usdc-circle", [basePool]]]));
    await mergeGtPools(metrics, new Map([["usdc-circle", [{ ...basePool, ammExecutionModel: executionModel }]]]));

    const result = metrics.get("usdc-circle");
    expect(result?.pools).toHaveLength(1);
    expect(result?.pools[0]?.extra?.ammExecutionModel).toEqual(executionModel);
  });

  it("indexes existing pool identities once for a large per-coin batch", async () => {
    const existingCount = 128;
    const metrics = initSourcePoolGraph("usdc-circle", "USDC");
    let poolIdReads = 0;

    for (let i = 0; i < existingCount; i++) {
      const entry = makePoolEntry("");
      Object.defineProperty(entry, "poolId", {
        enumerable: true,
        get: () => {
          poolIdReads++;
          return `ethereum:0x${i.toString(16).padStart(40, "0")}`;
        },
      });
      metrics.pools.push(entry);
    }

    const incoming = Array.from({ length: existingCount }, (_, i) =>
      makeGtPool(`0x${(i + existingCount).toString(16).padStart(40, "0")}`),
    );
    await mergeGtPools(new Map([["usdc-circle", metrics]]), new Map([["usdc-circle", incoming]]));

    expect(poolIdReads).toBe(existingCount);
    expect(metrics.pools).toHaveLength(existingCount * 2);
  });
});
