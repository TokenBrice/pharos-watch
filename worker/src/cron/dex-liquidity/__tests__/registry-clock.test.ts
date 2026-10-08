import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { mergeStagedPools, type StagedPoolRow } from "../staging-merge";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { computeStablecoinScores } from "../scoring";
import { persistDexLiquidityScoringStage, loadDexLiquidityScoringStage } from "../scoring-stage";
import type { DexLiquidityPoolState, DexLiquidityScoringSourceState } from "../scoring-stage-contract";
import { makeStagedPoolRow } from "./staging-merge.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import type { LiquidityMetrics } from "../types";
import { seedGeneration } from "../../measured-execution/__tests__/persistence.test-support";
import { makeV3Target } from "../../measured-execution/__tests__/measured-execution.test-support";

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
  const metrics = new Map<string, LiquidityMetrics>();
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

function poolState(metrics: Map<string, LiquidityMetrics>, registryEvaluatedAtSec: number): DexLiquidityPoolState {
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

async function score(db: D1Database, metrics: Map<string, LiquidityMetrics>, registryEvaluatedAtSec: number) {
  return computeStablecoinScores(db, metrics, new Map(), undefined, SOURCE_CLOCK,
    new Map(), undefined, new Map(), "none", registryEvaluatedAtSec);
}

describe("registry read-consumption clock", () => {
  it("screens the post-stage-start zero-trade outlier in the same generation without losing a healthy refresh", async () => {
    const { metrics, result } = await merge([
      registryRow(1),
      registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000 }),
    ]);
    expect(result.registryEvaluatedAtSec).toBe(READ_CLOCK);
    expect(result.mergedCount).toBe(2);
    expect(result.priceObservations.get("usdc-circle")?.map((obs) => obs.poolKey)).toEqual([poolId(2)]);
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const scored = await score(harness.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.diagnostics.deadPoolExclusions).toMatchObject({
      reason: "dead-pool-zero-trade-untracked-counter", poolCount: 1, tvlUsd: 17_459_719,
    });
    expect(scored.retainedPoolsByStablecoin.get("usdc-circle")?.map((pool) => pool.poolId)).toEqual([poolId(2)]);
    expect(scored.scores.get("usdc-circle")).toMatchObject({ tvl: 100_000, vol24h: 25_000 });
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });

  it("rejects a row beyond the read clock plus the diagnostic grace whole and counts the reason", async () => {
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
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const scored = await score(harness.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.scores.get("usdc-circle")?.vol24h).toBe(admittedVolume);
    expect(scored.globalAgg.totalVol24h).toBe(admittedVolume);
  });

  it.each([6 * 60, 36 * 60])("preserves the serialized admission basis when publication consumes it %i seconds after source start", async (delay) => {
    const { metrics, result } = await merge([registryRow(2, {
      tvl_usd: 100_000, volume_24h: 25_000,
      refreshed_at: READ_CLOCK - DEX_VOLUME_OBSERVATION_MAX_AGE_SEC,
    })]);
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    await persistDexLiquidityScoringStage(harness.db, {
      sourceSlotStartedAt: SOURCE_CLOCK, syncStartSec: SOURCE_CLOCK,
      sourceState: sourceState(), poolState: poolState(metrics, result.registryEvaluatedAtSec),
    });
    vi.spyOn(Date, "now").mockReturnValue((SOURCE_CLOCK + delay) * 1000);
    const loaded = await loadDexLiquidityScoringStage(harness.db, {
      nowSec: SOURCE_CLOCK + delay, expectedSourceSlotStartedAt: SOURCE_CLOCK,
    });
    expect(loaded.syncStartSec).toBe(SOURCE_CLOCK);
    expect(loaded.poolState.registryEvaluatedAtSec).toBe(READ_CLOCK);
    const scored = await score(harness.db, loaded.poolState.metrics, loaded.poolState.registryEvaluatedAtSec);
    expect(scored.scores.get("usdc-circle")?.vol24h).toBe(25_000);
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });

  it("selects the quote cohort at the source clock even when the registry clock covers a newer publication", async () => {
    const { metrics, result } = await merge([registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000 })]);
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const target = makeV3Target({ capturedAt: SOURCE_CLOCK - 100 });
    seedGeneration(harness.sqlite, {
      generationId: "quote-before-source", targetGenerationId: "target-before-source",
      publishedAt: SOURCE_CLOCK - 10, state: "superseded",
      rows: [{ target, status: "failed", failureReason: "pool-revert" }],
    });
    seedGeneration(harness.sqlite, {
      generationId: "quote-after-source", targetGenerationId: "target-after-source",
      publishedAt: SOURCE_CLOCK + 50, state: "published",
      rows: [{ target, status: "failed", failureReason: "pool-revert" }],
    });
    const scored = await score(harness.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.diagnostics.measuredExecution.join.quoteGenerationId).toBe("quote-before-source");
    expect(scored.diagnostics.measuredExecution.join.targetGenerationId).toBe("target-before-source");
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });
});
