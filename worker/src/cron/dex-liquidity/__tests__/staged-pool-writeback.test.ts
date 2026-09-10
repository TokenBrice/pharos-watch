import { describe, expect, it } from "vitest";
import type { StagedPool } from "../../dex-discovery/types";
import { initMetrics } from "../pool-helpers";
import { buildPoolFingerprint } from "../pool-normalization";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { mergeStagedPools, type StagedPoolRow } from "../staging-merge";
import { buildStagedPoolWriteback, filterDiscoveryOwned } from "../staged-pool-writeback";
import type { LiquidityMetrics, PoolEntry } from "../types";
import { makeStagedPoolRow } from "./staging-merge.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const NOW = 1_710_000_000;
const CURVE_POOL = "0x00000000000000000000000000000000000000a1";
const OTHER_POOL = "0x00000000000000000000000000000000000000a2";
const CG_ONCHAIN_POOL = "0x00000000000000000000000000000000000000a3";
const GECKO_POOL = "0x00000000000000000000000000000000000000a4";
const DIRECT_API_POOL = "0x00000000000000000000000000000000000000a5";
const BACKFILLED_POOL = "base:0x00000000000000000000000000000000000000b2";
const USDC_TOKEN = "0x00000000000000000000000000000000000000b1";
const USDT_TOKEN = "0x00000000000000000000000000000000000000c2";

function makePoolEntry(overrides: Partial<PoolEntry> = {}): PoolEntry {
  return {
    poolId: `ethereum:${CURVE_POOL}`,
    project: "curve",
    chain: "Ethereum",
    tvlUsd: 1_000_000,
    symbol: "USDC / USDT",
    volumeUsd1d: 250_000,
    poolType: "curve-stableswap-high-a",
    source: "dl",
    extra: {},
    ...overrides,
  };
}

function makeMetrics(stablecoinId: string, pools: PoolEntry[]): LiquidityMetrics {
  const metric = initMetrics(stablecoinId, "USDC");
  metric.topPools.push(...pools);
  return metric;
}

function createMockDb(results: unknown[]): D1Database {
  return makeNoopD1({
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results }),
      }),
    }),
  });
}

/** Project a write-back row onto the persisted column shape the merge reads. */
function toStagedPoolRow(pool: StagedPool): StagedPoolRow {
  return makeStagedPoolRow({
    pool_id: pool.poolId,
    stablecoin_id: pool.stablecoinId,
    source: pool.source,
    chain: pool.chain,
    protocol: pool.protocol,
    dex_id: pool.dexId,
    symbol: pool.symbol,
    tvl_usd: pool.tvlUsd,
    volume_24h: pool.volume24h,
    quality_multiplier: pool.qualityMultiplier,
    pool_type: pool.poolType,
    fee_tier: pool.feeTier,
    balance_ratio: pool.balanceRatio,
    is_stable: pool.isStable ? 1 : 0,
    base_token: pool.baseToken,
    quote_token: pool.quoteToken,
    quote_symbol: pool.quoteSymbol,
    price_usd: pool.priceUsd,
    locked_liq_pct: pool.lockedLiqPct,
    raw_json: pool.rawJson,
    discovered_at: pool.discoveredAt,
    refreshed_at: pool.refreshedAt,
  });
}

describe("buildStagedPoolWriteback", () => {
  it("maps a live-lane observation onto the persisted staging row", () => {
    const metrics = new Map([["usdc-circle", makeMetrics("usdc-circle", [makePoolEntry()])]]);

    const result = buildStagedPoolWriteback(metrics, NOW);

    expect(result.skippedUntrustedIds).toBe(0);
    expect(result.pools).toEqual([
      {
        poolId: `ethereum:${CURVE_POOL}`,
        stablecoinId: "usdc-circle",
        source: "dl",
        chain: "ethereum",
        protocol: "curve",
        dexId: "curve",
        symbol: "USDC / USDT",
        tvlUsd: 1_000_000,
        volume24h: 250_000,
        qualityMultiplier: 1,
        poolType: "curve-stableswap-high-a",
        feeTier: null,
        balanceRatio: null,
        isStable: true,
        baseToken: null,
        quoteToken: null,
        quoteSymbol: null,
        priceUsd: null,
        lockedLiqPct: null,
        rawJson: null,
        discoveredAt: NOW,
        refreshedAt: NOW,
      },
    ]);
  });

  it("carries measured extras and a price only when the entry measured one", () => {
    const measured = makePoolEntry({
      price: 0.9998,
      extra: {
        feeTier: 5,
        balanceRatio: 0.98,
        lockedLiquidityPct: 12,
        measurement: { priceMeasured: true },
      },
    });
    const unmeasuredPrice = makePoolEntry({
      poolId: `ethereum:${OTHER_POOL}`,
      price: 0.9998,
      extra: { measurement: { priceMeasured: false } },
    });
    const flagless = makePoolEntry({
      poolId: `ethereum:${DIRECT_API_POOL}`,
      source: "direct_api",
      project: "uniswap-v3",
      poolType: "uniswap-v3-5bp",
      price: 0.9998,
    });

    const result = buildStagedPoolWriteback(
      new Map([["usdc-circle", makeMetrics("usdc-circle", [measured, unmeasuredPrice, flagless])]]),
      NOW,
    );

    expect(result.pools.map((pool) => [pool.poolId, pool.priceUsd])).toEqual([
      [`ethereum:${CURVE_POOL}`, 0.9998],
      [`ethereum:${OTHER_POOL}`, null],
      [`ethereum:${DIRECT_API_POOL}`, null],
    ]);
    expect(result.pools[0]).toMatchObject({
      feeTier: 5,
      balanceRatio: 0.98,
      lockedLiqPct: 12,
    });
    // The direct-API lane round-trips as its own family, not as a discovery one.
    expect(result.pools[2]).toMatchObject({ source: "direct_api", isStable: false });
  });

  it("skips derived-only ids and counts them as untrusted", () => {
    const derivedId = buildPoolFingerprint("ethereum", "curve", [USDC_TOKEN, USDT_TOKEN]);
    const metrics = new Map([
      [
        "usdc-circle",
        makeMetrics("usdc-circle", [makePoolEntry({ poolId: derivedId! }), makePoolEntry()]),
      ],
    ]);

    const result = buildStagedPoolWriteback(metrics, NOW);

    expect(result.pools.map((pool) => pool.poolId)).toEqual([`ethereum:${CURVE_POOL}`]);
    expect(result.skippedUntrustedIds).toBe(1);
  });

  it("excludes decayed entries and rows discovery already owns", () => {
    const pools = [
      makePoolEntry({ poolId: `ethereum:${OTHER_POOL}`, extra: { measurement: { decayed: true } } }),
      makePoolEntry({ poolId: `ethereum:${CG_ONCHAIN_POOL}`, source: "cg_onchain" }),
      makePoolEntry({ poolId: `ethereum:${GECKO_POOL}`, source: "gecko_terminal" }),
    ];

    const result = buildStagedPoolWriteback(
      new Map([["usdc-circle", makeMetrics("usdc-circle", pools)]]),
      NOW,
    );

    expect(result.pools).toEqual([]);
    expect(result.skippedUntrustedIds).toBe(0);
  });

  it("dedupes by pool id and stablecoin", () => {
    const observed = makePoolEntry();
    const metrics = new Map([
      ["usdc-circle", makeMetrics("usdc-circle", [observed, { ...observed }])],
      ["usdt-tether", makeMetrics("usdt-tether", [observed])],
    ]);

    const result = buildStagedPoolWriteback(metrics, NOW);

    expect(result.pools.map((pool) => [pool.stablecoinId, pool.poolId])).toEqual([
      ["usdc-circle", `ethereum:${CURVE_POOL}`],
      ["usdt-tether", `ethereum:${CURVE_POOL}`],
    ]);
  });

  it("round-trips a written-back row into the next run's metrics", async () => {
    const writeback = buildStagedPoolWriteback(
      new Map([["usdc-circle", makeMetrics("usdc-circle", [makePoolEntry({ price: 0.9998, extra: { measurement: { priceMeasured: true } } })])]]),
      NOW,
    );

    // Provider outage for the pool's lane: nothing is observed this run, so the
    // written-back row is the only thing that can keep the pool alive.
    const outageMetrics = new Map<string, LiquidityMetrics>();
    const merged = await mergeStagedPools(
      createMockDb(writeback.pools.map(toStagedPoolRow)),
      outageMetrics,
      createKnownPoolIdentityIndex(),
      NOW + 3_600,
    );

    expect(merged.mergedCount).toBe(1);
    expect(outageMetrics.get("usdc-circle")?.topPools[0]).toMatchObject({
      poolId: `ethereum:${CURVE_POOL}`,
      source: "dl",
      tvlUsd: 1_000_000,
      price: 0.9998,
      extra: { measurement: { decayed: false } },
    });
  });

  it("never writes back a row the merge itself backfilled", async () => {
    const metrics = new Map([["usdc-circle", makeMetrics("usdc-circle", [makePoolEntry()])]]);

    // Production order: snapshot before the merge, upsert after it.
    const writebackBeforeMerge = buildStagedPoolWriteback(metrics, NOW);

    const merged = await mergeStagedPools(
      createMockDb([
        makeStagedPoolRow({
          pool_id: BACKFILLED_POOL,
          stablecoin_id: "usdc-circle",
          source: "cg_onchain",
          chain: "base",
          protocol: "uniswap-v3",
          dex_id: "uniswap-v3",
          price_usd: null,
          refreshed_at: NOW - 48 * 3_600,
          discovered_at: NOW - 96 * 3_600,
        }),
      ]),
      metrics,
      createKnownPoolIdentityIndex(),
      NOW,
    );

    const backfilled = metrics
      .get("usdc-circle")
      ?.topPools.find((pool) => pool.poolId === BACKFILLED_POOL);
    expect(merged.mergedCount).toBe(1);
    expect(backfilled?.extra?.measurement?.decayed).toBe(true);

    expect(writebackBeforeMerge.pools.map((pool) => pool.poolId)).toEqual([`ethereum:${CURVE_POOL}`]);
    // Building after the merge must exclude the backfill too, or an aged row
    // would take a fresh refreshed_at every hour and never decay.
    expect(
      buildStagedPoolWriteback(metrics, NOW).pools.map((pool) => pool.poolId),
    ).toEqual([`ethereum:${CURVE_POOL}`]);
  });
});

describe("filterDiscoveryOwned", () => {
  it("drops the live-lane copy of a pool discovery owns and keeps the rest", async () => {
    const metrics = new Map([
      [
        "usdc-circle",
        makeMetrics("usdc-circle", [
          // Same pool, both lanes: DL carries no price, so writing its copy back
          // would relabel the discovery row and null the price it sourced.
          makePoolEntry(),
          makePoolEntry({ poolId: `ethereum:${OTHER_POOL}` }),
        ]),
      ],
    ]);

    // Production order: snapshot before the merge, filter after it.
    const snapshot = buildStagedPoolWriteback(metrics, NOW);
    const merged = await mergeStagedPools(
      createMockDb([
        makeStagedPoolRow({
          pool_id: `ethereum:${CURVE_POOL}`,
          stablecoin_id: "usdc-circle",
          source: "cg_onchain",
          chain: "ethereum",
          protocol: "curve",
          dex_id: "curve",
          price_usd: 0.9998,
          refreshed_at: NOW,
        }),
      ]),
      metrics,
      createKnownPoolIdentityIndex(),
      NOW,
    );

    const filtered = filterDiscoveryOwned(snapshot, merged.discoveryOwnedKeys);

    expect(merged.discoveryOwnedKeys).toContain(`usdc-circle\u0000ethereum:${CURVE_POOL}`);
    expect(filtered.pools.map((pool) => pool.poolId)).toEqual([`ethereum:${OTHER_POOL}`]);
    expect(filtered.skippedDiscoveryOwned).toBe(1);
    expect(filtered.skippedUntrustedIds).toBe(0);
  });
});
