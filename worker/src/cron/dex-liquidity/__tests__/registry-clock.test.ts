import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { relativeBps } from "@shared/lib/depeg-signals";
import { mergeStagedPools, type StagedPoolRow } from "../staging-merge";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { computeStablecoinScores } from "../scoring";
import { persistDexLiquidityScoringStage, loadDexLiquidityScoringStage } from "../scoring-stage";
import type { DexLiquidityPoolState, DexLiquidityScoringSourceState } from "../scoring-stage-contract";
import { makeStagedPoolRow } from "./staging-merge.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import type { SourcePoolGraph } from "../types";
import { seedGeneration } from "../../measured-execution/__tests__/persistence.test-support";
import { makeV3Target } from "../../measured-execution/__tests__/measured-execution.test-support";
import { computeDexPrices } from "../dex-price-publisher";
import { readPublicPriceRows, seedPublishedDexGeneration } from "./scoring-test-support";
import { makePool, makePricePoolMap } from "./scoring-test-builders";
import { loadDexPrices } from "../../../lib/depeg-helpers";

const SOURCE_CLOCK = 1_791_403_833;
const READ_CLOCK = SOURCE_CLOCK + 100;
const OWN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const COUNTER = "0x0000000000000000000000000000000000000001";
const poolId = (n: number) => `base:0x${n.toString(16).padStart(40, "0")}`;
const registryRow = (n: number, overrides: Partial<StagedPoolRow> = {}) => makeStagedPoolRow({
  pool_id: poolId(n), stablecoin_id: "usdc-circle", source: "cg_onchain", chain: "base",
  protocol: "uniswap-v3", dex_id: "uniswap_v3_base", symbol: "USDC / JUNK",
  tvl_usd: 17_459_718.7567, volume_24h: 0, base_token: OWN, quote_token: COUNTER,
  refreshed_at: SOURCE_CLOCK + 87, discovered_at: SOURCE_CLOCK - 86400,
  ...overrides,
});
const openDatabases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

async function merge(rows: StagedPoolRow[]) {
  let wallClock = SOURCE_CLOCK;
  vi.spyOn(Date, "now").mockImplementation(() => wallClock * 1000);
  const db = makeNoopD1({ prepare: () => ({ bind: () => ({ all: async () => {
    // Discovery's replacement is visible only when the SELECT has completed.
    wallClock = READ_CLOCK;
    return { results: rows };
  } }) }) });
  const metrics = new Map<string, SourcePoolGraph>();
  const result = await mergeStagedPools(db, metrics, createKnownPoolIdentityIndex(), SOURCE_CLOCK,
    new Map([[`base:${OWN}`, "usdc-circle"]]));
  return { metrics, result };
}

function sourceState(): DexLiquidityScoringSourceState {
  return {
    validationReferences: { rates: {}, type: "fresh", updatedAt: SOURCE_CLOCK, updatedAtByPeg: {}, typeByPeg: {} },
    stablecoinPriceById: new Map(), stablecoinMcapById: new Map(), protocolTvlCaps: new Map(),
    priceObservations: new Map(), dlYieldsAvailable: true, dlProtocolsAvailable: true, primaryRawPoolCount: 0,
    failedSources: [], criticalSourceFailures: [], fallbackSignals: [],
    directApiSourceSummary: { circuitEvents: [], sourceWarnings: [], pagination: [] },
  };
}

function poolState(metrics: Map<string, SourcePoolGraph>, registryEvaluatedAtSec: number): DexLiquidityPoolState {
  return {
    registryEvaluatedAtSec, metrics, fallback: { weakCoverageCoinsBeforeFallback: 0 }, poolRejections: [],
    pancakeMeasuredExecutionTargets: new Map(), slipstreamMeasuredExecutionTargets: new Map(),
    stagedMergedCount: 0, stagedSkippedCount: 0, stagedSkippedByExactIdentityCount: 0,
    stagedSkippedByUniqueDerivedIdentityCount: 0, stagedSkippedByOptionalWildcardIdentityCount: 0,
    stagedSkippedByAuthoritativeProtocolCount: 0, stagedSkipDimensions: [],
    directApiIntegration: {
      directApiDedupSkippedByAddress: 0, directApiDedupSkippedByDerivedIdentity: 0,
      directApiDedupSkippedByOptionalWildcardIdentity: 0, directApiSkippedUntracked: 0,
      directApiSkippedInvalidUnits: 0, directApiSkippedBelowTvlThreshold: 0,
      directApiSkippedAboveTvlSanityCap: 0, acceptedByProtocolChain: {}, excludedByReason: {},
    },
  };
}

async function score(db: D1Database, metrics: Map<string, SourcePoolGraph>, registryEvaluatedAtSec: number) {
  return computeStablecoinScores(db, metrics, new Map(), undefined, SOURCE_CLOCK,
    new Map(), undefined, new Map(), "none", registryEvaluatedAtSec);
}

describe("registry read-consumption clock", () => {
  it.each([
    [0.4, 21_600, false], [0.1, 120, false], [0.4, 60, true], [0.4, 21_600, true],
  ] as const)("dates subset %s / %s / %s", async (oldPrice, age, aggregateOnly) => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const pools = [
      makePool({ poolId: "base:old", project: "orca", price: oldPrice, tvlUsd: aggregateOnly ? 5_000_000 : 50_000_000,
        priceObservedAt: READ_CLOCK - age }),
      makePool({ poolId: "base:fresh1", project: "curve", price: 1, priceObservedAt: READ_CLOCK - 60 }),
      makePool({ poolId: "base:fresh2", project: "curve", price: 1, priceObservedAt: READ_CLOCK - 30 }),
    ].slice(0, aggregateOnly ? 1 : 3);
    const diagnostics = await computeDexPrices({ db: h.db, retainedPoolsByStablecoin: new Map([["usdc-circle", pools]]),
      nowSec: READ_CLOCK, generationId: h.generationId, primaryPrices: new Map([["usdc-circle", 1]]) });
    const clock = READ_CLOCK - (aggregateOnly ? age : 60);
    const [row] = readPublicPriceRows(h.sqlite);
    expect(JSON.parse(row.price_sources_json!)).toEqual(aggregateOnly ? { aggregateObservedAt: clock, sources: [] } : [
      expect.objectContaining({ protocol: "curve", observedAt: clock, aggregateObservedAt: clock }),
    ]);
    expect(diagnostics.contributorAdmissionByStablecoin).toEqual([{
      stablecoinId: "usdc-circle", totalContributorCount: pools.length,
      inBudgetContributorCount: Number(age < DEX_FRESHNESS_SEC) + (aggregateOnly ? 0 : 2),
      fallbackReason: aggregateOnly && age >= DEX_FRESHNESS_SEC ? "no-in-budget-contributors" : null,
    }]);
    const loaded = await loadDexPrices(h.db, READ_CLOCK);
    expect(loaded.dexPriceRows.get("usdc-circle")?.aggregateObservedAt).toBe(clock);
    expect(row).toMatchObject({ dex_price_usd: aggregateOnly ? 0.4 : 1,
      source_pool_count: aggregateOnly ? 1 : 2, source_total_tvl: aggregateOnly ? 5_000_000 : 10_000_000 });
    if (aggregateOnly) {
      expect(loaded.dexPriceRows.get("usdc-circle")).toMatchObject({ dex_price_usd: 0.4, source_total_tvl: 5_000_000 });
      expect(loaded.dexPriceSources.has("usdc-circle")).toBe(false);
    }
  });

  it.each([60, DEX_FRESHNESS_SEC, 21_600, null, -1, NaN, Infinity])("ages ticker %s", async (age) => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    await computeDexPrices({ db: h.db, nowSec: READ_CLOCK, generationId: h.generationId,
      primaryPrices: new Map([["usdc-circle", 1]]), retainedPoolsByStablecoin: new Map([["usdc-circle", [
        makePool({ price: 1, priceObservedAt: READ_CLOCK - 30 }),
      ]]]), exactPriceEvidenceByStablecoin: new Map([["usdc-circle", [{
        price: 0.8, tvl: 0, observedVolumeUsd: 100_000_000, chain: "orderbook", protocol: "ticker",
        sourceFamily: "cg_tickers", observedAt: age == null ? null : READ_CLOCK - age,
      }]]]) });
    const [row] = readPublicPriceRows(h.sqlite);
    const current = age != null && age >= 0 && age < DEX_FRESHNESS_SEC;
    expect(row).toMatchObject({ dex_price_usd: current ? 0.8 : 1, source_pool_count: current ? 2 : 1,
      source_total_tvl: 5_000_000 });
    expect(JSON.parse(row.price_sources_json!)).toHaveLength(current ? 2 : 1);
  });

  it("preserves a six-hour quote through stage storage and republication", async () => {
    const quoteClock = READ_CLOCK - 6 * 3600;
    const { metrics, result } = await merge([
      registryRow(2, { source: "dl", tvl_usd: 200_000, volume_24h: 25_000,
        price_usd: null, refreshed_at: READ_CLOCK }),
      registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000, price_usd: 0.998,
        refreshed_at: quoteClock }),
    ]);
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const source = sourceState();
    source.priceObservations = result.priceObservations;
    await persistDexLiquidityScoringStage(h.db, {
      sourceSlotStartedAt: SOURCE_CLOCK, syncStartSec: SOURCE_CLOCK,
      sourceState: source, poolState: poolState(metrics, result.registryEvaluatedAtSec),
    });
    const loaded = await loadDexLiquidityScoringStage(h.db, { nowSec: READ_CLOCK, expectedSourceSlotStartedAt: SOURCE_CLOCK });
    expect(loaded.sourceState.priceObservations.get("usdc-circle")?.[0]?.observedAt).toBe(quoteClock);
    expect(loaded.poolState.metrics.get("usdc-circle")?.pools[0]?.priceObservedAt).toBe(quoteClock);
    const scored = await score(h.db, loaded.poolState.metrics, loaded.poolState.registryEvaluatedAtSec);
    await computeDexPrices({ db: h.db, retainedPoolsByStablecoin: scored.retainedPoolsByStablecoin,
      nowSec: READ_CLOCK, exactPriceEvidenceByStablecoin: loaded.sourceState.priceObservations,
      generationId: h.generationId, primaryPrices: new Map([["usdc-circle", 1]]) });
    const [row] = readPublicPriceRows(h.sqlite);
    expect(row.updated_at).toBe(READ_CLOCK);
    expect(JSON.parse(row.price_sources_json!)).toEqual([
      expect.objectContaining({ observedAt: quoteClock, aggregateObservedAt: quoteClock, price: 0.998 }),
    ]);
    const admitted = await loadDexPrices(h.db, READ_CLOCK);
    expect(admitted.dexPriceRows.get("usdc-circle")?.updated_at).toBe(READ_CLOCK);
    expect(admitted.dexPriceSources.has("usdc-circle")).toBe(false);
  });

  it("screens zero-trade outliers, preserving a healthy refresh", async () => {
    const { metrics, result } = await merge([
      registryRow(1),
      registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000 }),
    ]);
    expect(result.registryEvaluatedAtSec).toBe(READ_CLOCK);
    expect(result.mergedCount).toBe(2);
    expect(result.priceObservations.get("usdc-circle")?.map((obs) => obs.poolKey)).toEqual([poolId(2)]);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    const scored = await score(h.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.diagnostics.deadPoolExclusions).toMatchObject({
      reason: "dead-pool-zero-trade-untracked-counter", poolCount: 1, tvlUsd: 17_459_719,
    });
    expect(scored.retainedPoolsByStablecoin.get("usdc-circle")?.map((pool) => pool.poolId)).toEqual([poolId(2)]);
    expect(scored.scores.get("usdc-circle")).toMatchObject({ tvl: 100_000, vol24h: 25_000 });
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });

  it("rejects and counts rows beyond read-clock grace", async () => {
    const { metrics, result } = await merge([registryRow(1, { refreshed_at: READ_CLOCK + 61, volume_24h: 10_000 })]);
    expect(result.registryEvaluatedAtSec).toBe(READ_CLOCK);
    expect(result.registryRowsRead).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipDimensions).toEqual([expect.objectContaining({ reason: "future_observation", count: 1 })]);
    expect(result.mergedCount).toBe(0);
    expect(result.priceObservations.size).toBe(0);
    expect(result.registryFamilyBySource).toEqual({});
    expect(metrics.size).toBe(0);
  });

  it.each([
    { ageSec: 24 * 3600, priceCount: 1, admittedVolume: 25_000 },
    { ageSec: 24 * 3600 + 1, priceCount: 0, admittedVolume: 25_000 },
    { ageSec: 72 * 3600, priceCount: 0, admittedVolume: 25_000 },
    { ageSec: 72 * 3600 + 1, priceCount: 0, admittedVolume: null },
  ])("keeps the inclusive 24h/72h boundaries at registry age $ageSec", async ({ ageSec, priceCount, admittedVolume }) => {
    const { metrics, result } = await merge([registryRow(2, {
      tvl_usd: 100_000, volume_24h: 25_000, refreshed_at: READ_CLOCK - ageSec,
    })]);
    expect(result.priceObservations.get("usdc-circle")?.length ?? 0).toBe(priceCount);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    const scored = await score(h.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.scores.get("usdc-circle")?.vol24h).toBe(admittedVolume);
    expect(scored.globalAgg.totalVol24h).toBe(admittedVolume);
  });

  it.each([6 * 60, 36 * 60])("pins admission at publication delay %i", async (delay) => {
    const { metrics, result } = await merge([registryRow(2, {
      tvl_usd: 100_000, volume_24h: 25_000,
      refreshed_at: READ_CLOCK - DEX_VOLUME_OBSERVATION_MAX_AGE_SEC,
    })]);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    await persistDexLiquidityScoringStage(h.db, {
      sourceSlotStartedAt: SOURCE_CLOCK, syncStartSec: SOURCE_CLOCK,
      sourceState: sourceState(), poolState: poolState(metrics, result.registryEvaluatedAtSec),
    });
    vi.spyOn(Date, "now").mockReturnValue((SOURCE_CLOCK + delay) * 1000);
    const loaded = await loadDexLiquidityScoringStage(h.db, {
      nowSec: SOURCE_CLOCK + delay, expectedSourceSlotStartedAt: SOURCE_CLOCK,
    });
    expect(loaded.syncStartSec).toBe(SOURCE_CLOCK);
    expect(loaded.poolState.registryEvaluatedAtSec).toBe(READ_CLOCK);
    const scored = await score(h.db, loaded.poolState.metrics, loaded.poolState.registryEvaluatedAtSec);
    expect(scored.scores.get("usdc-circle")?.vol24h).toBe(25_000);
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });

  it("selects quotes at the source clock", async () => {
    const { metrics, result } = await merge([registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000 })]);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    const target = makeV3Target({ capturedAt: SOURCE_CLOCK - 100 });
    seedGeneration(h.sqlite, {
      generationId: "quote-before-source", targetGenerationId: "target-before-source",
      publishedAt: SOURCE_CLOCK - 10, state: "superseded",
      rows: [{ target, status: "failed", failureReason: "pool-revert" }],
    });
    seedGeneration(h.sqlite, {
      generationId: "quote-after-source", targetGenerationId: "target-after-source",
      publishedAt: SOURCE_CLOCK + 50, state: "published",
      rows: [{ target, status: "failed", failureReason: "pool-revert" }],
    });
    const scored = await score(h.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.diagnostics.measuredExecution.join.quoteGenerationId).toBe("quote-before-source");
    expect(scored.diagnostics.measuredExecution.join.targetGenerationId).toBe("target-before-source");
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });
});

describe("DEX price publication precision", () => {
  it("keeps low-unit medians and deviations consistent", async () => {
    const nowSec = 1_800_000_000;
    const primaryPrice = 0.0000615;
    const h = seedPublishedDexGeneration({ nowSec });
    openDatabases.push(h.sqlite);
    await computeDexPrices({ db: h.db, nowSec, generationId: h.generationId,
      primaryPrices: new Map([["idrx-idrx", primaryPrice]]),
      retainedPoolsByStablecoin: makePricePoolMap([0.000061, 0.0000615, 0.000062].map((price, index) => ({
        stablecoinId: "idrx-idrx", poolId: `polygon:idrx-usdc-${index}`, project: "curve", chain: "Polygon",
        tvlUsd: 100_000, price, source: "dl",
      }))),
    });
    const [row] = readPublicPriceRows(h.sqlite);
    expect(row, "an at-peg IDR row must publish").toBeDefined();
    expect(relativeBps(row!.dex_price_usd, primaryPrice)?.absRawBps ?? Infinity).toBeLessThanOrEqual(1);
    const storedDeviation = row!.deviation_from_primary_bps;
    expect(storedDeviation).not.toBeNull();
    const recomputedBps = relativeBps(row!.dex_price_usd, row!.primary_price_at_calc ?? primaryPrice)?.bps;
    expect(Math.abs((recomputedBps ?? Infinity) - storedDeviation!)).toBeLessThanOrEqual(1);
  });
});
