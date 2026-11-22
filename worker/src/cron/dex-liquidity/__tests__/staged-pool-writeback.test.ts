import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { cleanupStaging, upsertStagedPools } from "../../dex-discovery/persistence";
import { SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION, stagedPoolConfidence, type StagedPool } from "../../dex-discovery/types";
import { computeLiquidityScore, initSourcePoolGraph } from "../pool-helpers";
import { buildPoolFingerprint } from "../pool-normalization";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { mergeStagedPools, type StagedPoolRow } from "../staging-merge";
import { buildStagedPoolWriteback } from "../staged-pool-writeback";
import {
  accumulateGlobalAggregate, netGlobalCurveBaseLpOverlap, summarizeRetainedPoolVolume, type GlobalPoolAggregateEntry,
} from "../scoring-helpers";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import type { LiquidityMetrics, SourcePoolGraph, PoolEntry } from "../types";
import { makeStagedPoolRow } from "./staging-merge.test-support";
import { scorePoolGraph } from "./scoring-test-builders";
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
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

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

function makeMetrics(stablecoinId: string, pools: PoolEntry[]): SourcePoolGraph {
  const metric = initSourcePoolGraph(stablecoinId, "USDC");
  metric.pools.push(...pools);
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

  it("marks only fresh live Slipstream observations as factory-reviewed", () => {
    const fresh = makePoolEntry({ source: "direct_api", project: "aerodrome", poolType: "aerodrome-slipstream-1bp" });
    const metrics = new Map([["usdc-circle", makeMetrics("usdc-circle", [fresh])]]);
    expect(JSON.parse(buildStagedPoolWriteback(metrics, NOW).pools[0]!.rawJson!)).toEqual({ identityReviewVersion: SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION });
    fresh.extra = { measurement: { decayed: true } };
    expect(buildStagedPoolWriteback(metrics, NOW).pools).toEqual([]);
  });

  it("carries measured extras and a price only when the entry measured one", () => {
    const measured = makePoolEntry({
      price: 0.9998,
      priceObservedAt: NOW - 60,
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

  it.each([
    { observedAt: NOW - 60, eligible: true, legacy: false },
    { observedAt: NOW - 24 * 3600, eligible: false, legacy: false },
    { observedAt: null, eligible: false, legacy: false },
    { observedAt: null, eligible: false, legacy: true },
  ])("keeps Curve TVL on replay without manufacturing a constituent clock ($observedAt, legacy=$legacy)", async ({
    observedAt, eligible, legacy,
  }) => {
    const replayAt = NOW + 5 * 3600;
    vi.spyOn(Date, "now").mockReturnValue(replayAt * 1000);
    const { db } = fixtures.open();
    const livePool = makePoolEntry({ price: 0.9998, priceObservedAt: observedAt, extra: { measurement: { priceMeasured: true } } });
    const writeback = buildStagedPoolWriteback(
      new Map([["usdc-circle", makeMetrics("usdc-circle", [livePool])]]),
      NOW,
    );
    expect(writeback.pools[0]!.priceUsd).toBe(observedAt == null ? null : livePool.price);
    await upsertStagedPools(db, writeback.pools.map((row) => legacy ? { ...row, priceUsd: 10_000 } : row));
    expect((await cleanupStaging(db, replayAt)).error).toBeNull();
    const outageMetrics = new Map<string, SourcePoolGraph>();
    const merged = await mergeStagedPools(db, outageMetrics, createKnownPoolIdentityIndex(), replayAt, new Map());
    expect(merged.mergedCount).toBe(1);
    const pool = outageMetrics.get("usdc-circle")?.pools[0];
    expect(pool).toMatchObject({ poolId: livePool.poolId, source: "dl", tvlUsd: livePool.tvlUsd });
    expect(pool?.price).toBe(eligible ? livePool.price : undefined);
    expect(merged.priceObservations.get("usdc-circle")?.[0]?.observedAt ?? null).toBe(eligible ? observedAt : null);
  });

  it.each([
    { windowEnd: NOW, legacy: false, useAlternate: false },
    { windowEnd: null, legacy: true, useAlternate: false },
    { windowEnd: NOW - 25 * 3600, legacy: false, useAlternate: true },
  ])("backfills a failed Pancake V3 hourly query only from a verified window ($windowEnd, legacy=$legacy)", async ({
    windowEnd, legacy, useAlternate,
  }) => {
    const refreshedAt = NOW + 600;
    const replayAt = refreshedAt + 5 * 3600;
    const { db } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(replayAt * 1000);
    const observed = makePoolEntry({
      project: "pancakeswap", poolType: "pancakeswap-v3-5bp", source: "direct_api",
      volumeReading: { volume24hUsd: 250_000, volume7dUsd: null, observedAtSec: windowEnd },
    });
    const writeback = buildStagedPoolWriteback(new Map([["usdc-circle", makeMetrics("usdc-circle", [observed])]]), refreshedAt);
    const [row] = writeback.pools;
    expect(row!.volume24h).toBe(windowEnd == null ? null : 250_000);
    const alternateAt = replayAt - 20 * 3600;
    await upsertStagedPools(db, [
      legacy ? { ...row!, volume24h: 250_000 } : row!,
      ...(useAlternate ? [{ ...row!, source: "cg_onchain" as const, volume24h: 90_000, refreshedAt: alternateAt, rawJson: null }] : []),
    ]);
    expect((await cleanupStaging(db, replayAt)).error).toBeNull();
    const unread = { ...observed, volumeUsd1d: null, volumeReading: { volume24hUsd: null, volume7dUsd: null, observedAtSec: null } };
    const metrics = new Map([["usdc-circle", makeMetrics("usdc-circle", [unread])]]);
    const replay = await mergeStagedPools(db, metrics, createKnownPoolIdentityIndex(), replayAt, new Map());
    expect(replay.skippedByExactIdentityCount).toBe(1);
    expect(metrics.get("usdc-circle")?.pools).toEqual([unread]);
    expect(unread.tvlUsd).toBe(observed.tvlUsd);
    expect(unread.volumeReading).toEqual({
      volume24hUsd: useAlternate ? 90_000 : legacy ? null : 250_000,
      volume7dUsd: null, observedAtSec: useAlternate ? alternateAt : windowEnd,
    });
  });

  it("preserves SundaeSwap volume window clock past raw-payload cleanup and rejects legacy rows without it", async () => {
    const windowEnd = Math.floor(NOW / 3600) * 3600;
    const refreshedAt = windowEnd + 600;
    const replayAt = refreshedAt + 5 * 3600;
    const { sqlite, db } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(replayAt * 1000);
    await upsertStagedPools(db, [
      {
        poolId: "cardano:062ed6", stablecoinId: "usdrf-realfi", source: "sundaeswap", chain: "cardano",
        protocol: "sundaeswap", dexId: "sundaeswap", symbol: "USDCx / USDrf", tvlUsd: 800_000, volume24h: 6_557.4,
        qualityMultiplier: null, poolType: "sundaeswap-constant-sum", feeTier: 5, balanceRatio: null,
        isStable: true, baseToken: "usdcx", quoteToken: "usdrf", quoteSymbol: "USDrf", priceUsd: null,
        lockedLiqPct: null, rawJson: JSON.stringify({ sundaeswapVolumeWindowEndSec: windowEnd, extra: "prune" }),
        discoveredAt: refreshedAt, refreshedAt,
      },
      {
        poolId: "cardano:legacy01", stablecoinId: "usdrf-realfi", source: "sundaeswap", chain: "cardano",
        protocol: "sundaeswap", dexId: "sundaeswap", symbol: "USDCx / USDrf", tvlUsd: 100_000, volume24h: 1_234,
        qualityMultiplier: null, poolType: "sundaeswap-stableswap", feeTier: 5, balanceRatio: null,
        isStable: true, baseToken: "usdcx", quoteToken: "usdrf", quoteSymbol: "USDrf", priceUsd: null,
        lockedLiqPct: null, rawJson: JSON.stringify({ id: "legacy01" }),
        discoveredAt: refreshedAt, refreshedAt,
      },
    ]);
    expect(await cleanupStaging(db, replayAt)).toMatchObject({ rawJsonClearedRows: 2, error: null });
    expect(sqlite.prepare("SELECT pool_id, raw_json FROM dex_pool_registry ORDER BY pool_id").all()).toEqual([
      { pool_id: "cardano:062ed6", raw_json: JSON.stringify({ sundaeswapVolumeWindowEndSec: windowEnd }) },
      { pool_id: "cardano:legacy01", raw_json: null },
    ]);
    const metrics = new Map<string, SourcePoolGraph>();
    await mergeStagedPools(db, metrics, createKnownPoolIdentityIndex(), replayAt, new Map());
    const byId = new Map((metrics.get("usdrf-realfi")?.pools ?? []).map((p) => [p.poolId, p]));
    expect(byId.get("cardano:062ed6")?.volumeReading).toEqual({ volume24hUsd: 6_557.4, volume7dUsd: null, observedAtSec: windowEnd });
    expect(byId.get("cardano:legacy01")?.volumeReading).toEqual({ volume24hUsd: null, volume7dUsd: null, observedAtSec: null });
  });

  it("nets decayed registry metapool LP claims against a live Curve base pool", async () => {
    const basePoolKey = "ethereum:0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
    const meta = makePoolEntry({
      poolId: "ethereum:0xed279fdd11ca84beef15af5d39bb4d4bee23f0ca",
      symbol: "LUSD/3CRV", tvlUsd: 12_900_000, curveBasePoolOverlap: { basePoolKey, lpLegTvlUsd: 8_600_000 },
    });
    const replayAt = NOW + 48 * 3600;
    const { db } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(replayAt * 1000);
    const stored = buildStagedPoolWriteback(new Map([["lusd-liquity", makeMetrics("lusd-liquity", [meta])]]), NOW).pools[0]!;
    const rawEvidence = JSON.parse(stored.rawJson!);
    await upsertStagedPools(db, [{ ...stored, rawJson: JSON.stringify({ ...rawEvidence, feedPayload: [1, 2, 3] }) }]);
    expect(await cleanupStaging(db, replayAt)).toMatchObject({ rawJsonClearedRows: 1, error: null });

    const base = makePoolEntry({ poolId: basePoolKey, tvlUsd: 20_000_000 });
    const metrics = new Map([["usdc-circle", makeMetrics("usdc-circle", [base])]]);
    const replay = await mergeStagedPools(db, metrics, createKnownPoolIdentityIndex(), replayAt, new Map());
    expect(replay.mergedCount).toBe(1);
    const retained = metrics.get("lusd-liquity")!.pools[0]!;
    const confidence = stagedPoolConfidence(48);
    const protocols: Record<string, number> = {};
    const chains: Record<string, number> = {};
    const seen = new Map<string, GlobalPoolAggregateEntry>();
    const gross = accumulateGlobalAggregate([retained, base], protocols, chains, new Set(), seen);
    const deducted = netGlobalCurveBaseLpOverlap(seen, protocols, chains);
    expect(deducted).toBeCloseTo(8_600_000 * confidence, 6);
    expect(protocols.curve).toBeCloseTo(gross.totalTvl - deducted, 6);
    expect(chains.ethereum).toBeCloseTo(base.tvlUsd + 4_300_000 * confidence, 6);
    expect(retained.tvlUsd).toBeCloseTo(meta.tvlUsd * confidence, 6);
  });

  it("keeps direct inventory without redating a live or legacy direct price", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const livePool = makePoolEntry({ source: "direct_api", price: 1, priceObservedAt: NOW - 60,
      extra: { measurement: { tvlMeasured: true, priceMeasured: true } },
    });
    const metrics = new Map([["usdc-circle", makeMetrics("usdc-circle", [livePool])]]);
    const [row] = buildStagedPoolWriteback(metrics, NOW).pools;
    expect(row).toMatchObject({ priceUsd: null, tvlUsd: livePool.tvlUsd });
    const outageMetrics = new Map<string, SourcePoolGraph>();
    const legacyRow = { ...toStagedPoolRow(row!), price_usd: 1 };
    const result = await mergeStagedPools(createMockDb([legacyRow]), outageMetrics, createKnownPoolIdentityIndex(), NOW, new Map());
    expect(outageMetrics.get("usdc-circle")?.pools[0]?.tvlUsd).toBe(livePool.tvlUsd);
    expect(outageMetrics.get("usdc-circle")?.pools[0]?.price).toBeUndefined();
    expect(result.priceObservations.has("usdc-circle")).toBe(false);
  });

  it.each(["dl", "direct_api"] as const)(
    "preserves measured balance, locks, and canonical pair quality when remembering %s pools",
    async (source) => {
      vi.spyOn(Date, "now").mockReturnValue((NOW + 3_600) * 1000);
      const results: LiquidityMetrics[] = [];
      for (const symbol of ["USDC / USDT", "USDC-USDT", "3pool"]) {
        const writeback = buildStagedPoolWriteback(
          new Map([["usdc-circle", makeMetrics("usdc-circle", [makePoolEntry({
            source,
            symbol,
            poolType: "curve-stableswap",
            extra: { balanceRatio: 0.2, lockedLiquidityPct: 80 },
          })])]]),
          NOW,
        );
        const metrics = new Map<string, SourcePoolGraph>();
        const merged = await mergeStagedPools(
          createMockDb(writeback.pools.map(toStagedPoolRow)),
          metrics, createKnownPoolIdentityIndex(), NOW + 3_600, new Map(),
        );
        expect(merged.mergedCount).toBe(1);
        const metric = scorePoolGraph(metrics.get("usdc-circle")!);
        expect(writeback.pools[0]!.qualityMultiplier).toBe(0.85);
        expect(metric.topPools[0]).toMatchObject({
          source, symbol,
          extra: {
            balanceRatio: 0.2, lockedLiquidityPct: 80, pairQuality: 1,
            qualityAdjustedTvl: 76_026,
            effectiveTvl: 76_026,
            measurement: { balanceMeasured: true, decayed: false },
          },
        });
        metric.volumeAvailability = summarizeRetainedPoolVolume(
          metric.topPools.map((pool) => ({ reading: pool.volumeReading, tvlUsd: pool.tvlUsd })),
          { asOfSec: NOW + 3_600, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC },
        ).volumeAvailability;
        expect(metric.qualityAdjustedTvl).toBe(76_026);
        expect(metric.effectiveTvl).toBe(76_026);
        expect(metric.totalTvlForBalance).toBe(1_000_000);
        expect(metric.lockedLiqWeightedSum / metric.totalTvlForLocked).toBe(0.8);
        results.push(metric);
      }
      const baseline = results[0]!;
      expect(computeLiquidityScore(baseline, 50, 1_000_000_000).score).not.toBeNull();
      for (const metric of results.slice(1)) {
        expect(metric.stressWeightedSum).toBe(baseline.stressWeightedSum);
        expect(computeLiquidityScore(metric, 50, 1_000_000_000)).toEqual(
          computeLiquidityScore(baseline, 50, 1_000_000_000),
        );
      }
    },
  );

  it("never writes back a row the merge itself backfilled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
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
    new Map(),
    );

    const backfilled = metrics
      .get("usdc-circle")
      ?.pools.find((pool) => pool.poolId === BACKFILLED_POOL);
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
