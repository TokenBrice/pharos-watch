import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { relativeBps } from "@shared/lib/depeg-signals";
import { mergeStagedPools, type StagedPoolRow } from "../staging-merge";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { computeStablecoinScores } from "../scoring";
import { persistDexLiquidityScoringStage, loadDexLiquidityScoringStage } from "../scoring-stage";
import type { DexLiquidityPoolState, DexLiquidityScoringSourceState } from "../scoring-stage-contract";
import { makeStagedPoolRow } from "./staging-merge.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { CURVE_NAV_SPOT_QUOTE_POLICY, CURVE_NAV_SPOT_QUOTE_POLICY_ID, type SourcePoolGraph } from "../types";
import { seedGeneration } from "../../measured-execution/__tests__/persistence.test-support";
import { makeV3Target } from "../../measured-execution/__tests__/measured-execution.test-support";
import { computeDexPrices } from "../dex-price-publisher";
import { readPublicPriceRows, seedPublishedDexGeneration } from "./scoring-test-support";
import { makePool, makePricePoolMap } from "./scoring-test-builders";
import { loadDexPrices } from "../../../lib/depeg-helpers";
import { handleDexLiquidity } from "../../../api/dex-liquidity";
import { summarizeRetainedPoolVolume } from "../scoring-helpers";
import {
  makeClockedCurveNavPool,
  makeVerifiedMeasuredNonCurvePool,
} from "./fixtures/curve-stableswap-ng-fixtures";

const SOURCE_CLOCK = 1_791_403_833;
const READ_CLOCK = SOURCE_CLOCK + 100;
const OWN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const COUNTER = "0x0000000000000000000000000000000000000001";
const poolId = (n: number) => `base:0x${n.toString(16).padStart(40, "0")}`;
const registryRow = (n: number, overrides: Partial<StagedPoolRow> = {}) => makeStagedPoolRow({
  pool_id: poolId(n),
  stablecoin_id: "usdc-circle",
  source: "cg_onchain",
  chain: "base",
  protocol: "uniswap-v3",
  dex_id: "uniswap_v3_base",
  symbol: "USDC / JUNK",
  tvl_usd: 17_459_718.7567,
  volume_24h: 0,
  base_token: OWN,
  quote_token: COUNTER,
  refreshed_at: SOURCE_CLOCK + 87,
  discovered_at: SOURCE_CLOCK - 86400,
  ...overrides,
});

const openDatabases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of openDatabases.splice(0)) {
    sqlite.close();
  }
});

async function merge(rows: StagedPoolRow[]) {
  let wallClock = SOURCE_CLOCK;
  vi.spyOn(Date, "now").mockImplementation(() => wallClock * 1000);
  const db = makeNoopD1({
    prepare: () => ({
      bind: () => ({
        all: async () => {
          wallClock = READ_CLOCK;
          return { results: rows };
        },
      }),
    }),
  });
  const metrics = new Map<string, SourcePoolGraph>();
  const result = await mergeStagedPools(
    db,
    metrics,
    createKnownPoolIdentityIndex(),
    SOURCE_CLOCK,
    new Map([[`base:${OWN}`, "usdc-circle"]]),
  );
  return { metrics, result };
}

function sourceState(): DexLiquidityScoringSourceState {
  return {
    validationReferences: { rates: {}, type: "fresh", updatedAt: SOURCE_CLOCK, updatedAtByPeg: {}, typeByPeg: {} },
    stablecoinPriceById: new Map(),
    stablecoinMcapById: new Map(),
    protocolTvlCaps: new Map(),
    priceObservations: new Map(),
    dlYieldsAvailable: true,
    dlProtocolsAvailable: true,
    primaryRawPoolCount: 0,
    failedSources: [],
    criticalSourceFailures: [],
    fallbackSignals: [],
    directApiSourceSummary: { circuitEvents: [], sourceWarnings: [], pagination: [] },
  };
}

function poolState(metrics: Map<string, SourcePoolGraph>, registryEvaluatedAtSec: number): DexLiquidityPoolState {
  return {
    registryEvaluatedAtSec,
    metrics,
    fallback: { weakCoverageCoinsBeforeFallback: 0 },
    poolRejections: [],
    pancakeMeasuredExecutionTargets: new Map(),
    slipstreamMeasuredExecutionTargets: new Map(),
    stagedMergedCount: 0,
    stagedSkippedCount: 0,
    stagedSkippedByExactIdentityCount: 0,
    stagedSkippedByUniqueDerivedIdentityCount: 0,
    stagedSkippedByOptionalWildcardIdentityCount: 0,
    stagedSkippedByAuthoritativeProtocolCount: 0,
    stagedSkipDimensions: [],
    directApiIntegration: {
      directApiDedupSkippedByAddress: 0,
      directApiDedupSkippedByDerivedIdentity: 0,
      directApiDedupSkippedByOptionalWildcardIdentity: 0,
      directApiSkippedUntracked: 0,
      directApiSkippedInvalidUnits: 0,
      directApiSkippedBelowTvlThreshold: 0,
      directApiSkippedAboveTvlSanityCap: 0,
      acceptedByProtocolChain: {},
      excludedByReason: {},
    },
  };
}

function score(db: D1Database, metrics: Map<string, SourcePoolGraph>, registryEvaluatedAtSec: number) {
  return computeStablecoinScores(
    db, metrics, new Map(), undefined, SOURCE_CLOCK, new Map(), undefined, new Map(), "none", registryEvaluatedAtSec,
  );
}

describe("registry read-consumption clock", () => {
  it("expires the API price at the original 24h bound, not the publication bound", async () => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const pool = makePool({ poolId: "base:old", project: "orca", price: 1, tvlUsd: 5e6, priceObservedAt: READ_CLOCK - 86_100 });
    await computeDexPrices({
      db: h.db,
      retainedPoolsByStablecoin: new Map([["usdc-circle", [pool]]]),
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["usdc-circle", 1]]),
    });
    const date = vi.spyOn(Date, "now").mockReturnValue((READ_CLOCK + 300) * 1000);
    const read = async () =>
      (await (await handleDexLiquidity(h.db, "usdc-circle")).json() as { coins: Record<string, { dexPriceUsd: number | null }> }).coins["usdc-circle"];
    expect(await read()).toMatchObject({ dexPriceUsd: 1, dexPriceAgeSeconds: 86_400, dexPriceUnavailableReason: null });
    date.mockReturnValue((READ_CLOCK + 301) * 1000);
    expect(await read()).toMatchObject({ dexPriceUsd: null, dexPriceAgeSeconds: 86_401, dexPriceUnavailableReason: "stale-price" });
  });

  it("anchors the API trend to the served observation across UTC noon and ignores an unclocked bucket", async () => {
    const day = Math.floor(READ_CLOCK / 86_400) * 86_400;
    const clock = day + 600;
    const h = seedPublishedDexGeneration({ nowSec: day + 500 });
    openDatabases.push(h.sqlite);
    const record = (at: number) =>
      JSON.stringify(summarizeRetainedPoolVolume([], { asOfSec: at, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC }).volumeAvailability);
    h.sqlite.prepare("UPDATE dex_liquidity SET total_tvl_usd = 80, coverage_class = 'primary', coverage_confidence = 1, volume_availability_json = ? WHERE stablecoin_id = 'usdc-circle'").run(record(clock));
    const insert = h.sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, snapshot_date, total_tvl_usd, coverage_class, coverage_confidence, volume_availability_json) VALUES ('usdc-circle', ?, ?, 'primary', 1, ?)");
    insert.run(day - 86_400, 100, record(clock - 86_400));
    insert.run(day, 80, null);
    const date = vi.spyOn(Date, "now");
    for (const offset of [43_140, 43_260]) {
      date.mockReturnValue((day + offset) * 1000);
      expect(await (await handleDexLiquidity(h.db, "usdc-circle")).json()).toMatchObject({
        coins: { "usdc-circle": { tvlChange24h: -20, tvlChange7d: null } },
      });
    }
  });

  it.each([
    [0.4, 21_600, false],
    [0.1, 120, false],
    [0.4, 60, true],
    [0.4, 21_600, true],
  ] as const)("dates subset %s / %s / %s", async (oldPrice, age, aggregateOnly) => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const pools = [
      makePool({ poolId: "base:old", project: "orca", price: oldPrice, tvlUsd: aggregateOnly ? 5e6 : 5e7, priceObservedAt: READ_CLOCK - age }),
      makePool({ poolId: "base:fresh1", project: "curve", price: 1, priceObservedAt: READ_CLOCK - 60 }),
      makePool({ poolId: "base:fresh2", project: "curve", price: 1, priceObservedAt: READ_CLOCK - 30 }),
    ].slice(0, aggregateOnly ? 1 : 3);
    const diagnostics = await computeDexPrices({
      db: h.db,
      retainedPoolsByStablecoin: new Map([["usdc-circle", pools]]),
      nowSec: SOURCE_CLOCK,
      admissionNowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["usdc-circle", 1]]),
    });
    const clock = READ_CLOCK - (aggregateOnly ? age : 60);
    const [row] = readPublicPriceRows(h.sqlite);
    expect(JSON.parse(row.price_sources_json!)).toMatchObject({
      aggregateObservedAt: clock,
      aggregateContributors: [],
      sources: aggregateOnly ? [] : [{ protocol: "curve", observedAt: clock, aggregateObservedAt: clock }],
    });
    expect(diagnostics.contributorAdmissionByStablecoin).toEqual([{
      stablecoinId: "usdc-circle",
      totalContributorCount: pools.length,
      inBudgetContributorCount: Number(age < DEX_FRESHNESS_SEC) + (aggregateOnly ? 0 : 2),
      fallbackReason: aggregateOnly && age >= DEX_FRESHNESS_SEC ? "no-in-budget-contributors" : null,
    }]);
    const loaded = await loadDexPrices(h.db, READ_CLOCK);
    expect(loaded.dexPriceRows.get("usdc-circle")?.aggregateObservedAt).toBe(clock);
    expect(row).toMatchObject({
      dex_price_usd: aggregateOnly ? 0.4 : 1,
      source_pool_count: aggregateOnly ? 1 : 2,
      source_total_tvl: aggregateOnly ? 5e6 : 1e7,
    });
    if (aggregateOnly) {
      expect(loaded.dexPriceRows.get("usdc-circle")).toMatchObject({ dex_price_usd: 0.4, source_total_tvl: 5e6 });
      expect(loaded.dexPriceSources.has("usdc-circle")).toBe(false);
    }
  });

  it.each([60, DEX_FRESHNESS_SEC, 21_600, null, -1, NaN, Infinity])("ages ticker %s", async (age) => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["usdc-circle", 1]]),
      retainedPoolsByStablecoin: new Map([["usdc-circle", [makePool({ price: 1, priceObservedAt: READ_CLOCK - 30 })]]]),
      exactPriceEvidenceByStablecoin: new Map([["usdc-circle", [{
        price: 0.8,
        tvl: 0,
        observedVolumeUsd: 1e8,
        chain: "orderbook",
        protocol: "ticker",
        sourceFamily: "cg_tickers",
        observedAt: age == null ? null : READ_CLOCK - age,
      }]]]),
    });
    const [row] = readPublicPriceRows(h.sqlite);
    const current = age != null && age >= 0 && age < DEX_FRESHNESS_SEC;
    expect(row).toMatchObject({
      dex_price_usd: current ? 0.8 : 1,
      source_pool_count: current ? 2 : 1,
      source_total_tvl: 5_000_000,
    });
    expect(JSON.parse(row.price_sources_json!).sources).toHaveLength(current ? 2 : 1);
  });

  it("preserves a six-hour quote through stage storage and republication", async () => {
    const quoteClock = READ_CLOCK - 6 * 3600;
    const { metrics, result } = await merge([
      registryRow(2, { source: "dl", tvl_usd: 200_000, volume_24h: 25_000, price_usd: null, refreshed_at: READ_CLOCK }),
      registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000, price_usd: 0.998, refreshed_at: quoteClock }),
    ]);
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const source = sourceState();
    source.priceObservations = result.priceObservations;
    await persistDexLiquidityScoringStage(h.db, {
      sourceSlotStartedAt: SOURCE_CLOCK,
      syncStartSec: SOURCE_CLOCK,
      sourceState: source,
      poolState: poolState(metrics, result.registryEvaluatedAtSec),
    });
    const loaded = await loadDexLiquidityScoringStage(h.db, { nowSec: READ_CLOCK, expectedSourceSlotStartedAt: SOURCE_CLOCK });
    expect(loaded.sourceState.priceObservations.get("usdc-circle")?.[0]?.observedAt).toBe(quoteClock);
    expect(loaded.poolState.metrics.get("usdc-circle")?.pools[0]?.priceObservedAt).toBe(quoteClock);
    const scored = await score(h.db, loaded.poolState.metrics, loaded.poolState.registryEvaluatedAtSec);
    await computeDexPrices({
      db: h.db,
      retainedPoolsByStablecoin: scored.retainedPoolsByStablecoin,
      nowSec: READ_CLOCK,
      exactPriceEvidenceByStablecoin: loaded.sourceState.priceObservations,
      generationId: h.generationId,
      primaryPrices: new Map([["usdc-circle", 1]]),
    });
    const [row] = readPublicPriceRows(h.sqlite);
    expect(row.updated_at).toBe(READ_CLOCK);
    expect(JSON.parse(row.price_sources_json!).sources).toEqual([
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
    expect(result.priceObservations.get("usdc-circle")?.map((o) => o.poolKey)).toEqual([poolId(2)]);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    const scored = await score(h.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.diagnostics.deadPoolExclusions).toMatchObject({
      reason: "dead-pool-zero-trade-untracked-counter",
      poolCount: 1,
      tvlUsd: 17_459_719,
    });
    expect(scored.retainedPoolsByStablecoin.get("usdc-circle")?.map((p) => p.poolId)).toEqual([poolId(2)]);
    expect(scored.scores.get("usdc-circle")).toMatchObject({ tvl: 100_000, vol24h: 25_000 });
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });

  it("rejects and counts rows beyond read-clock grace", async () => {
    const { metrics, result } = await merge([registryRow(1, { refreshed_at: READ_CLOCK + 61, volume_24h: 10_000 })]);
    expect(result).toMatchObject({
      registryEvaluatedAtSec: READ_CLOCK,
      registryRowsRead: 1,
      skippedCount: 1,
      mergedCount: 0,
      registryFamilyBySource: {},
    });
    expect(result.skipDimensions).toEqual([expect.objectContaining({ reason: "future_observation", count: 1 })]);
    expect(result.priceObservations.size).toBe(0);
    expect(metrics.size).toBe(0);
  });

  it.each([
    { ageSec: 24 * 3600, priceCount: 1, admittedVolume: 25_000 },
    { ageSec: 24 * 3600 + 1, priceCount: 0, admittedVolume: 25_000 },
    { ageSec: 72 * 3600, priceCount: 0, admittedVolume: 25_000 },
    { ageSec: 72 * 3600 + 1, priceCount: 0, admittedVolume: null },
  ])("keeps the inclusive 24h/72h boundaries at registry age $ageSec", async ({ ageSec, priceCount, admittedVolume }) => {
    const { metrics, result } = await merge([
      registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000, refreshed_at: READ_CLOCK - ageSec }),
    ]);
    expect(result.priceObservations.get("usdc-circle")?.length ?? 0).toBe(priceCount);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    const scored = await score(h.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.scores.get("usdc-circle")?.vol24h).toBe(admittedVolume);
    expect(scored.globalAgg.totalVol24h).toBe(admittedVolume);
  });

  it.each([6 * 60, 36 * 60])("pins admission at publication delay %i", async (delay) => {
    const { metrics, result } = await merge([
      registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000, refreshed_at: READ_CLOCK - DEX_VOLUME_OBSERVATION_MAX_AGE_SEC }),
    ]);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    await persistDexLiquidityScoringStage(h.db, {
      sourceSlotStartedAt: SOURCE_CLOCK,
      syncStartSec: SOURCE_CLOCK,
      sourceState: sourceState(),
      poolState: poolState(metrics, result.registryEvaluatedAtSec),
    });
    vi.spyOn(Date, "now").mockReturnValue((SOURCE_CLOCK + delay) * 1000);
    const loaded = await loadDexLiquidityScoringStage(h.db, {
      nowSec: SOURCE_CLOCK + delay,
      expectedSourceSlotStartedAt: SOURCE_CLOCK,
    });
    expect(loaded.syncStartSec).toBe(SOURCE_CLOCK);
    expect(loaded.poolState.registryEvaluatedAtSec).toBe(READ_CLOCK);
    const scored = await score(h.db, loaded.poolState.metrics, loaded.poolState.registryEvaluatedAtSec);
    expect(scored.scores.get("usdc-circle")?.vol24h).toBe(25_000);
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });

  it.each([
    { receipt: "at-budget" as const, reject: false },
    { receipt: "expired" as const, reject: true },
    { receipt: "omitted" as const, reject: false },
    { receipt: "empty" as const, reject: true },
    { receipt: "other-asset" as const, reject: true },
  ])("rechecks staged EURC valuation at the scoring clock ($receipt)", async ({ receipt, reject }) => {
    const crossesClose = receipt !== "at-budget" && receipt !== "expired";
    const observedAtSec = Date.parse(crossesClose ? "2026-11-13T21:30:30Z" : "2026-11-13T22:01:00Z") / 1000;
    const sourceAt = observedAtSec + DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 60;
    const nowSec = observedAtSec + DEPEG_PRIMARY_PRICE_MAX_AGE_SEC + Number(receipt === "expired");
    vi.spyOn(Date, "now").mockReturnValue(sourceAt * 1000);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    const base = makeV3Target();
    const mark = { stablecoinId: "eurc-circle", priceUsd: 1.13, observedAtSec, observedAtMode: "upstream" as const, source: "kraken+coinbase" };
    const target = makeV3Target({
      capturedAt: sourceAt,
      tokenOut: { ...base.tokenOut, symbol: "EURC", trackedAssetId: mark.stablecoinId, referencePriceUsd: mark.priceUsd, marketMark: mark },
    });
    const metrics = new Map([["usdc-circle", {
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      pools: [makePool({ poolId: target.poolId, chain: target.chain, project: target.protocol, tvlUsd: target.retainedTvlUsd, extra: { measuredExecutionTarget: target } })],
    }]]);
    const stage = poolState(metrics, sourceAt);
    if (receipt !== "omitted") {
      const id = receipt === "other-asset" ? "zchf-frankencoin" : "eurc-circle";
      stage.closureValuationMarketMarks = receipt === "empty" ? [] : [[id, mark]];
    }
    await persistDexLiquidityScoringStage(h.db, {
      sourceSlotStartedAt: sourceAt,
      syncStartSec: sourceAt,
      sourceState: sourceState(),
      poolState: stage,
    });
    const loaded = await loadDexLiquidityScoringStage(h.db, { nowSec, expectedSourceSlotStartedAt: sourceAt });
    const marks = loaded.poolState.closureValuationMarketMarks;
    expect(marks).toEqual(stage.closureValuationMarketMarks);
    const scored = await computeStablecoinScores(
      h.db, loaded.poolState.metrics, new Map(), undefined, nowSec, new Map(), undefined, new Map(),
      "active", sourceAt, new Set(), marks && new Map(marks),
    );
    if (reject) {
      expect(scored.measuredTargetInventory.active).toEqual([]);
      expect(scored.scores.get("usdc-circle")).toMatchObject({
        exitRouteObservationCoverage: { unsupportedReasons: { "reference-market-closed-valuation-unavailable": 1 } },
      });
    } else {
      expect(scored.measuredTargetInventory.active).toEqual([expect.objectContaining({ targetId: target.targetId })]);
    }
  });

  it("selects quotes at the source clock", async () => {
    const { metrics, result } = await merge([registryRow(2, { tvl_usd: 100_000, volume_24h: 25_000 })]);
    const h = createLatestSchemaSqlite();
    openDatabases.push(h.sqlite);
    const target = makeV3Target({ capturedAt: SOURCE_CLOCK - 100 });
    seedGeneration(h.sqlite, {
      generationId: "quote-before-source",
      targetGenerationId: "target-before-source",
      publishedAt: SOURCE_CLOCK - 10,
      state: "superseded",
      rows: [{ target, status: "failed", failureReason: "pool-revert" }],
    });
    seedGeneration(h.sqlite, {
      generationId: "quote-after-source",
      targetGenerationId: "target-after-source",
      publishedAt: SOURCE_CLOCK + 50,
      state: "published",
      rows: [{ target, status: "failed", failureReason: "pool-revert" }],
    });
    const scored = await score(h.db, metrics, result.registryEvaluatedAtSec);
    expect(scored.diagnostics.measuredExecution.join).toMatchObject({
      quoteGenerationId: "quote-before-source",
      targetGenerationId: "target-before-source",
    });
    expect(scored.globalAgg.totalVol24h).toBe(25_000);
  });
});

describe("DEX price publication precision and clocked Curve NAV isolation", () => {
  it("keeps low-unit medians and deviations consistent", async () => {
    const nowSec = 1_800_000_000;
    const primaryPrice = 0.0000615;
    const h = seedPublishedDexGeneration({ nowSec });
    openDatabases.push(h.sqlite);
    await computeDexPrices({
      db: h.db,
      nowSec,
      generationId: h.generationId,
      primaryPrices: new Map([["idrx-idrx", primaryPrice]]),
      retainedPoolsByStablecoin: makePricePoolMap([0.000061, 0.0000615, 0.000062].map((price, index) => ({
        stablecoinId: "idrx-idrx",
        poolId: `polygon:idrx-usdc-${index}`,
        project: "curve",
        chain: "Polygon",
        tvlUsd: 100_000,
        price,
        source: "dl",
      }))),
    });
    const [row] = readPublicPriceRows(h.sqlite);
    expect(row).toBeDefined();
    expect(relativeBps(row!.dex_price_usd, primaryPrice)?.absRawBps ?? Infinity).toBeLessThanOrEqual(1);
    expect(row!.deviation_from_primary_bps).not.toBeNull();
    expect(Math.abs((relativeBps(row!.dex_price_usd, row!.primary_price_at_calc ?? primaryPrice)?.bps ?? Infinity) - row!.deviation_from_primary_bps!))
      .toBeLessThanOrEqual(1);
  });

  it("enforces R8 split: full isolation on admission/integrity rejection, per-pool quarantine on eligibility/staleness rejection", async () => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const addr = "ethereum:0x2c7c98a3b1582d83c43987202aeff638312478ae";
    const staleCurveAddr = "ethereum:0xf292eb6c5dcb693eaaf392d0562a01c3710e5978";
    const ratioAt = READ_CLOCK - 120;
    const markAt = READ_CLOCK - 300;
    const clockedNav = makeClockedCurveNavPool(READ_CLOCK, {
      poolId: addr,
      tvlUsd: 2_500_000,
      price: 0.42,
      generationId: h.generationId,
      quoteOverrides: { poolRatioObservedAt: ratioAt, quoteMarkObservedAt: markAt },
    });
    const verifiedCorr = makeVerifiedMeasuredNonCurvePool(READ_CLOCK, { price: 0.43, tvlUsd: 600_000 });
    const staleNav = makeClockedCurveNavPool(READ_CLOCK, {
      poolId: staleCurveAddr,
      tvlUsd: 3_000_000,
      price: 1.22,
      generationId: h.generationId,
      priceCounterparty: {
        stablecoinId: "frxusd-frax",
        priceUsd: 1,
        observedAtSec: READ_CLOCK - 900,
        observedAtMode: "upstream",
        source: "coingecko",
      },
      quoteOverrides: {
        poolRatioObservedAt: READ_CLOCK - 900,
        quoteMarkObservedAt: READ_CLOCK - 900,
        captureEvaluatedAtSec: READ_CLOCK - 100,
      },
    });
    const staleCurveDlCopy = makePool({
      poolId: staleCurveAddr,
      project: "curve",
      chain: "ethereum",
      tvlUsd: 3_000_000,
      price: 1.21,
      priceObservedAt: READ_CLOCK - 10,
      source: "dl",
    });
    const healthyUniV3 = makePool({
      poolId: "ethereum:0x0000000000000000000000000000000000000003",
      project: "uniswap-v3",
      tvlUsd: 500_000,
      price: 1.23,
      priceObservedAt: READ_CLOCK - 10,
      source: "dl",
    });
    const futureNav = makeClockedCurveNavPool(READ_CLOCK, {
      poolId: "ethereum:0x0000000000000000000000000000000000000099",
      tvlUsd: 3_000_000,
      price: 1.05,
      generationId: h.generationId,
      quoteOverrides: {
        poolRatioObservedAt: READ_CLOCK + 10,
        quoteMarkObservedAt: READ_CLOCK - 30,
        captureEvaluatedAtSec: READ_CLOCK + 10,
      },
    });

    const diagnostics = await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([
        ["stusds-sky", 1.0934],
        ["sfrxusd-frax", 1.22],
        ["susde-ethena", 1.15],
        ["usdc-circle", 1],
      ]),
      retainedPoolsByStablecoin: new Map([
        ["stusds-sky", [
          clockedNav,
          verifiedCorr,
          makePool({ poolId: "ethereum:0x0000000000000000000000000000000000000002", project: "curve", tvlUsd: 1e6, price: 1.09, priceObservedAt: null, source: "dl" }),
          healthyUniV3,
          makePool({ poolId: "ethereum:0x0000000000000000000000000000000000000004", project: "uniswap-v4", tvlUsd: 5e5, price: 0.12, priceObservedAt: READ_CLOCK - 10, source: "cg_onchain" }),
        ]],
        // Eligibility/staleness rejection quarantines staleNav + its DL copy while leaving unrelated healthyUniV3 intact.
        ["sfrxusd-frax", [staleNav, staleCurveDlCopy, healthyUniV3]],
        // Integrity rejection isolates fail-closed and withholds local-clock healthyUniV3.
        ["susde-ethena", [futureNav, healthyUniV3]],
        ["usdc-circle", [makePool({ poolId: "base:0x0000000000000000000000000000000000000005", project: "curve", tvlUsd: 5e6, price: 1, priceObservedAt: READ_CLOCK - 30 })]],
      ]),
      // Zero-evidence coin with an upstream Curve NAV rejection records R4 diagnostics without inflating withheldByStablecoin.
      curveNavRejectionsByStablecoin: new Map([
        ["susds-sky", [{ poolKey: "ethereum:0x00000000000000000000000000000000000000aa", reason: "insufficient-support" }]],
      ]),
    });

    const rows = new Map(readPublicPriceRows(h.sqlite).map((r) => [r.stablecoin_id, r]));
    expect(rows.get("usdc-circle")?.dex_price_usd).toBe(1);
    expect(rows.get("sfrxusd-frax")).toMatchObject({
      dex_price_usd: 1.23,
      source_pool_count: 1,
      source_total_tvl: 500_000,
    });
    expect(rows.has("susde-ethena")).toBe(false);
    expect(rows.has("susds-sky")).toBe(false);
    expect(diagnostics.curveNavRejectedByStablecoin).toEqual(expect.arrayContaining([
      expect.objectContaining({ stablecoinId: "sfrxusd-frax", rejections: [{ poolKey: staleCurveAddr, reason: "capture-stale" }] }),
      expect.objectContaining({ stablecoinId: "susde-ethena", rejections: [{ poolKey: futureNav.poolId, reason: "future-timestamp" }] }),
      expect.objectContaining({ stablecoinId: "susds-sky", rejections: [{ poolKey: "ethereum:0x00000000000000000000000000000000000000aa", reason: "insufficient-support" }] }),
    ]));
    expect(diagnostics.withheldByStablecoin).toEqual([
      expect.objectContaining({ stablecoinId: "susde-ethena", reason: "future-timestamp" }),
    ]);

    expect(rows.get("stusds-sky")).toMatchObject({
      dex_price_usd: 0.42,
      source_pool_count: 2,
      source_total_tvl: 3_100_000,
    });
    expect(JSON.parse(rows.get("stusds-sky")!.price_sources_json!)).toMatchObject({
      aggregateObservedAt: null,
      displayAggregateObservedAt: markAt,
      quotePolicy: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
      quoteMaxAgeSec: DEX_FRESHNESS_SEC,
      quotePublishedAtSec: READ_CLOCK,
      quoteCaptures: [expect.objectContaining({ poolId: addr, poolRatioObservedAt: ratioAt, quoteMarkObservedAt: markAt })],
    });
    const date = vi.spyOn(Date, "now").mockReturnValue((markAt + DEX_FRESHNESS_SEC - 1) * 1000);
    const read = async () =>
      (await (await handleDexLiquidity(h.db, "stusds-sky")).json() as { coins: Record<string, Record<string, unknown>> }).coins["stusds-sky"];
    expect(await read()).toMatchObject({ dexPriceUsd: 0.42, dexPriceAgeSeconds: DEX_FRESHNESS_SEC - 1, dexPriceUnavailableReason: null });
    date.mockReturnValue((markAt + DEX_FRESHNESS_SEC) * 1000);
    expect(await read()).toMatchObject({ dexPriceUsd: null, dexPriceAgeSeconds: DEX_FRESHNESS_SEC, dexPriceUnavailableReason: "stale-price" });
  });

  it.each([
    [CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec, true],
    [CURVE_NAV_SPOT_QUOTE_POLICY.captureMaxAgeSec + 1, false],
  ] as const)("enforces 600s/601s capture-to-scoring boundary even with frozen captureEvaluatedAtSec (%i)", async (ageSec, admitted) => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const ratioAt = READ_CLOCK - ageSec;
    const pool = makeClockedCurveNavPool(READ_CLOCK, {
      generationId: h.generationId,
      price: 1.07,
      quoteOverrides: { poolRatioObservedAt: ratioAt, quoteMarkObservedAt: READ_CLOCK - 60, captureEvaluatedAtSec: ratioAt },
    });
    const diag = await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [pool]]]),
    });
    expect(readPublicPriceRows(h.sqlite).some((r) => r.stablecoin_id === "stusds-sky")).toBe(admitted);
    if (!admitted) {
      expect(diag.curveNavRejectedByStablecoin?.[0]?.rejections[0]?.reason).toBe("capture-stale");
    }
  });

  it("preserves clocked Curve NAV across duplicate collapse and quarantines conflicting price or counter-mark provenance", async () => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const addr = "ethereum:0x2c7c98a3b1582d83c43987202aeff638312478ae";
    const clocked = makeClockedCurveNavPool(READ_CLOCK, { poolId: addr, tvlUsd: 2_500_000, price: 1.07, generationId: h.generationId });
    const dupNonClocked = makePool({ poolId: addr, project: "curve", chain: "ethereum", tvlUsd: 9e6, price: 0.99, priceObservedAt: READ_CLOCK - 10, source: "dl" });
    await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [clocked, dupNonClocked]]]),
    });
    const [row] = readPublicPriceRows(h.sqlite);
    expect(row).toMatchObject({ dex_price_usd: 1.07, source_total_tvl: 2_500_000 });
    expect(JSON.parse(row!.price_sources_json!)).toMatchObject({ quotePolicy: CURVE_NAV_SPOT_QUOTE_POLICY_ID });

    const priceConflict = makeClockedCurveNavPool(READ_CLOCK, { poolId: addr, tvlUsd: 2_500_000, price: 1.02, generationId: h.generationId });
    await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [clocked, priceConflict]]]),
    });
    expect(readPublicPriceRows(h.sqlite)).toEqual([]);

    const markConflict = makeClockedCurveNavPool(READ_CLOCK, {
      poolId: addr,
      tvlUsd: 2_500_000,
      price: 1.07,
      generationId: h.generationId,
      priceCounterparty: {
        stablecoinId: "usds-sky",
        priceUsd: 1,
        observedAtSec: READ_CLOCK - 300,
        observedAtMode: "upstream",
        source: "binance",
      },
    });
    const diag = await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [clocked, markConflict]]]),
    });
    expect(readPublicPriceRows(h.sqlite)).toEqual([]);
    expect(diag.curveNavRejectedByStablecoin?.[0]?.rejections[0]?.reason).toBe("conflict");
  });

  it("defensively quarantines malformed staged/persisted Curve NAV quotes without aborting sibling assets", async () => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const malformed = makeClockedCurveNavPool(READ_CLOCK, {
      generationId: h.generationId,
      price: 1.07,
      quoteOverrides: { blockHash: undefined as unknown as string },
    });
    const sibling = makePool({ poolId: "base:0x0000000000000000000000000000000000000005", project: "curve", tvlUsd: 5e6, price: 1, priceObservedAt: READ_CLOCK - 30 });
    await persistDexLiquidityScoringStage(h.db, {
      sourceSlotStartedAt: SOURCE_CLOCK,
      syncStartSec: SOURCE_CLOCK,
      sourceState: sourceState(),
      poolState: poolState(new Map([
        ["stusds-sky", { stablecoinId: "stusds-sky", symbol: "stUSDS", pools: [malformed] }],
        ["usdc-circle", { stablecoinId: "usdc-circle", symbol: "USDC", pools: [sibling] }],
      ]), READ_CLOCK),
    });
    const loaded = await loadDexLiquidityScoringStage(h.db, { nowSec: READ_CLOCK, expectedSourceSlotStartedAt: SOURCE_CLOCK });
    expect(loaded.poolState.metrics.get("stusds-sky")?.pools[0]?.curveNavSpotQuote).toBeUndefined();
    expect(loaded.poolState.metrics.get("usdc-circle")?.pools).toHaveLength(1);

    const diag = await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09], ["usdc-circle", 1]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [malformed]], ["usdc-circle", [sibling]]]),
    });
    const rows = new Map(readPublicPriceRows(h.sqlite).map((r) => [r.stablecoin_id, r]));
    expect(rows.has("stusds-sky")).toBe(false);
    expect(rows.get("usdc-circle")?.dex_price_usd).toBe(1);
    expect(diag.curveNavRejectedByStablecoin?.[0]?.rejections[0]?.reason).toBe("invalid-policy");
  });

  it("re-verifies corroborators after plausibility filtering and retains corroboratorPoolIds in quoteCaptures", async () => {
    const h = seedPublishedDexGeneration({ nowSec: READ_CLOCK });
    openDatabases.push(h.sqlite);
    const corrPool = makeVerifiedMeasuredNonCurvePool(READ_CLOCK, { price: 1.07, tvlUsd: 300_000 });
    const corrCurve = makeClockedCurveNavPool(READ_CLOCK, {
      tvlUsd: 300_000,
      price: 1.07,
      generationId: h.generationId,
      quoteOverrides: { admissionMode: "corroborated", corroboratorPoolIds: [corrPool.poolId] },
    });
    const missingDiag = await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [corrCurve]]]),
    });
    expect(readPublicPriceRows(h.sqlite)).toEqual([]);
    expect(missingDiag.curveNavRejectedByStablecoin?.[0]?.rejections[0]?.reason).toBe("corroborator-missing");

    // Corroborator dropped by plausibility filter invalidates the corroborated Curve quote.
    const implausibleCorr = makeVerifiedMeasuredNonCurvePool(READ_CLOCK, { price: 999_999, tvlUsd: 300_000 });
    const postPlausibilityDiag = await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [corrCurve, implausibleCorr]]]),
    });
    expect(readPublicPriceRows(h.sqlite)).toEqual([]);
    expect(postPlausibilityDiag.curveNavRejectedByStablecoin?.[0]?.rejections[0]?.reason).toBe("corroborator-missing");

    // Valid corroborated publish retains corroboratorPoolIds in quoteCaptures.
    await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [corrCurve, corrPool]]]),
    });
    const [published] = readPublicPriceRows(h.sqlite);
    expect(JSON.parse(published!.price_sources_json!)).toMatchObject({
      quoteCaptures: [expect.objectContaining({ corroboratorPoolIds: [corrPool.poolId] })],
    });

    // Implausible Curve quote dropped leaves only verified non-Curve venue without quotePolicy/quoteCaptures.
    const implausibleCurve = makeClockedCurveNavPool(READ_CLOCK, { tvlUsd: 2_500_000, price: 999_999, generationId: h.generationId });
    await computeDexPrices({
      db: h.db,
      nowSec: READ_CLOCK,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      retainedPoolsByStablecoin: new Map([["stusds-sky", [implausibleCurve, corrPool]]]),
    });
    const [row] = readPublicPriceRows(h.sqlite);
    expect(row).toMatchObject({ stablecoin_id: "stusds-sky", dex_price_usd: 1.07, source_pool_count: 1, source_total_tvl: 300_000 });
    const payload = JSON.parse(row!.price_sources_json!);
    expect(payload.quotePolicy).toBeUndefined();
    expect(payload.quoteCaptures).toBeUndefined();
  });
});
