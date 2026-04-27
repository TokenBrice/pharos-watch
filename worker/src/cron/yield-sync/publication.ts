import { YieldRankingsResponseSchema, type AltYieldSource, type YieldBenchmarkMeta, type YieldBenchmarkRegistry, type YieldSafetySnapshotMeta, type YieldSourceInputMeta } from "@shared/types/yield";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS, FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { batchExecute } from "../../lib/db";
import { getCache, setCache } from "../../lib/db-cache";
import { readCachedJson, validatePayloadWithSchema } from "../../lib/api-utils";
import { PYS_SCALING_FACTOR } from "../../lib/constants";
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";
import { detectWarningSignals, getRankingStaleThresholdMs } from "../yield-helpers";
import { deleteOrphanYieldRows, deleteStaleYieldRows } from "./history";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { buildYieldSourceProvenance } from "./provenance";

function countYieldRankings(
  rankingsPayload: { rankings?: Array<{ id?: string }> },
  options?: { allowedIds?: Set<string> },
): { count: number; malformed: boolean } {
  if (!Array.isArray(rankingsPayload.rankings)) {
    return { count: 0, malformed: true };
  }

  const rankings = options?.allowedIds
    ? rankingsPayload.rankings.filter((ranking) => typeof ranking.id === "string" && options.allowedIds?.has(ranking.id))
    : rankingsPayload.rankings.filter((ranking) => typeof ranking.id === "string");
  return { count: rankings.length, malformed: false };
}

export async function readPreviousYieldRankingsCount(
  db: D1Database,
  options?: { allowedIds?: Set<string> },
): Promise<{ count: number; malformed: boolean }> {
  const previousCache = await getCache(db, "yield-rankings");
  const previousRankings = readCachedJson<{ rankings?: Array<{ id?: string }> }>(
    "yield-sync",
    "yield-rankings",
    previousCache,
  );
  if (previousRankings.status === "missing") {
    return { count: 0, malformed: false };
  }
  if (previousRankings.status === "malformed") {
    return { count: 0, malformed: true };
  }
  return countYieldRankings(previousRankings.data, options);
}

function evaluatedSourceToRanking(
  source: EvaluatedYieldSource,
  provenance: Record<string, unknown> | null,
) {
  const meta = TRACKED_META_BY_ID.get(source.id);
  return {
    id: source.id,
    symbol: source.symbol,
    name: meta?.name ?? source.symbol,
    currentApy: source.currentApy,
    apy7d: source.apy7d,
    apy30d: source.apy30d,
    apyBase: source.apyBase,
    apyReward: source.apyReward,
    yieldSource: source.yieldSource,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId: source.id,
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    }),
    yieldType: source.yieldType,
    dataSource: source.dataSource,
    sourceTvlUsd: source.sourceTvlUsd,
    pharosYieldScore: source.pharosYieldScore,
    safetyScore: source.safetyScore,
    safetyGrade: source.safetyGrade,
    yieldToRisk: source.yieldToRisk,
    excessYield: source.excessYield,
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    benchmarkRate: source.benchmarkRate,
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    yieldStability: source.yieldStability,
    apyVariance30d: source.stdDev30d,
    apyMin30d: source.apyMin30d,
    apyMax30d: source.apyMax30d,
    warningSignals: [...source.warnings],
    altSources: [] as AltYieldSource[],
    provenance,
  };
}

export function buildYieldRankingsPayloadFromEvaluatedSources(
  input: {
    evaluatedSources: EvaluatedYieldSource[];
    bestSourceKeyByCoin: Map<string, string>;
    rankingProvenanceByKey: Map<string, Record<string, unknown>>;
    riskFreeRate: number;
    riskFreeRateMeta: YieldBenchmarkMeta;
    riskFreeRateRegistry?: YieldBenchmarkRegistry;
    dlPoolsMeta: YieldSourceInputMeta;
    safetySnapshot: YieldSafetySnapshotMeta;
    medianApy: number;
    startSec: number;
  },
) {
  const bestRows = input.evaluatedSources
    .filter((source) => input.bestSourceKeyByCoin.get(source.id) === source.sourceKey)
    .sort((a, b) => b.pharosYieldScore - a.pharosYieldScore);

  const altSourcesByCoin = new Map<string, AltYieldSource[]>();
  for (const source of input.evaluatedSources) {
    if (input.bestSourceKeyByCoin.get(source.id) === source.sourceKey) continue;

    const alts = altSourcesByCoin.get(source.id) ?? [];
    // Deduplicate by yieldSource name — keep the entry with higher APY
    const existingIdx = alts.findIndex((a) => a.yieldSource === source.yieldSource);
    const alt: AltYieldSource = {
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
      yieldSourceUrl: resolveYieldSourceUrl({
        stablecoinId: source.id,
        sourceKey: source.sourceKey,
        yieldSource: source.yieldSource,
      }),
      yieldType: source.yieldType as AltYieldSource["yieldType"],
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      sourceTvlUsd: source.sourceTvlUsd,
      dataSource: source.dataSource,
    };
    if (existingIdx >= 0) {
      if ((source.currentApy ?? 0) > (alts[existingIdx].currentApy ?? 0)) {
        alts[existingIdx] = alt;
      }
    } else {
      alts.push(alt);
    }
    altSourcesByCoin.set(source.id, alts);
  }

  const rankings = bestRows.map((source) => {
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const ranking = evaluatedSourceToRanking(source, provenance);
    // Exclude alts whose display name matches the best source (duplicate label)
    ranking.altSources = (altSourcesByCoin.get(source.id) ?? [])
      .filter((alt) => alt.yieldSource !== source.yieldSource);

    const sourceObservedAt =
      provenance != null && typeof provenance.sourceObservedAt === "number"
        ? provenance.sourceObservedAt
        : input.startSec;
    const updatedAtMs = sourceObservedAt * 1000;
    const staleThresholdMs = getRankingStaleThresholdMs(source.dataSource, source.sourceKey);
    if (updatedAtMs > 0 && updatedAtMs < Date.now() - staleThresholdMs) {
      if (!ranking.warningSignals.includes("data-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
      }
    }

    return ranking;
  });

  return {
    rankings,
    riskFreeRate: input.riskFreeRate,
    benchmarks: input.riskFreeRateRegistry,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: input.medianApy,
    updatedAt: input.startSec,
    provenance: {
      selectionMethod: "confidence-weighted" as const,
      benchmark: input.riskFreeRateMeta,
      benchmarks: input.riskFreeRateRegistry,
      dlPools: input.dlPoolsMeta,
      safetySnapshot: input.safetySnapshot,
    },
  };
}

export async function validateYieldRankingsPayloadForPublish(
  db: D1Database,
  rankingsPayload: unknown,
): Promise<{ ok: boolean; validationFailures: number; reason?: string }> {
  const validation = validatePayloadWithSchema(
    YieldRankingsResponseSchema,
    rankingsPayload,
    "sync-yield-data:yield-rankings",
  );

  if (!validation.ok) {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to schema validation failure");
    return { ok: false, validationFailures: 1, reason: "schema-validation-failed" };
  }

  const currentRankings = validation.data.rankings.length;
  const previousRankingsState = await readPreviousYieldRankingsCount(db);
  if (previousRankingsState.malformed) {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to malformed previous cache");
    return {
      ok: false,
      validationFailures: 1,
      reason: "previous-rankings-cache-invalid",
    };
  }
  const previousRankings = previousRankingsState.count;
  const severeShrink =
    previousRankings >= 5 &&
    currentRankings < Math.ceil(previousRankings * 0.4);
  if (previousRankings > 0 && (currentRankings === 0 || severeShrink)) {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to publish guard");
    return {
      ok: false,
      validationFailures: 1,
      reason: currentRankings === 0 ? "empty-rankings-payload" : "rankings-payload-shrunk",
    };
  }

  return { ok: true, validationFailures: 0 };
}

export async function persistEvaluatedYieldSources(
  db: D1Database,
  input: {
    evaluatedSources: EvaluatedYieldSource[];
    bestSourceKeyByCoin: Map<string, string>;
    startSec: number;
    medianApy: number;
    dlPoolsMeta: YieldSourceInputMeta;
  },
): Promise<{
  updatedCount: number;
  rankingProvenanceByKey: Map<string, Record<string, unknown>>;
}> {
  const yieldDataStmts: D1PreparedStatement[] = [];
  const historyStmts: D1PreparedStatement[] = [];
  const rankingProvenanceByKey = new Map<string, Record<string, unknown>>();
  let updatedCount = 0;

  for (const source of input.evaluatedSources) {
    const isBest = input.bestSourceKeyByCoin.get(source.id) === source.sourceKey ? 1 : 0;
    const warningSignals = detectWarningSignals({
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      apyReward: source.apyReward,
      medianApy: input.medianApy,
      sourceTvlUsd: source.sourceTvlUsd,
      prevTvlUsd: source.prevTvlUsd,
    });
    source.warnings = warningSignals;
    const warningSignalsJson = warningSignals.length > 0 ? JSON.stringify(warningSignals) : null;
    const safeVariance30d = source.stdDev30d != null && Number.isFinite(source.stdDev30d) ? source.stdDev30d : null;
    const safeStability =
      source.yieldStability != null && Number.isFinite(source.yieldStability) ? source.yieldStability : null;

    yieldDataStmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO yield_data (
            stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
            yield_source, yield_type, source_pool, source_tvl_usd, data_source,
            safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
            apy_variance_30d, apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev, warning_signals, is_best, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          source.id,
          source.sourceKey,
          source.symbol,
          source.currentApy,
          source.apyBase,
          source.apyReward,
          source.apy7d,
          source.apy30d,
          source.yieldSource,
          source.yieldType,
          source.sourcePool,
          source.sourceTvlUsd,
          source.dataSource,
          source.safetyScore,
          source.safetyGrade,
          source.pharosYieldScore,
          source.yieldToRisk,
          source.excessYield,
          safeStability,
          safeVariance30d,
          source.apyMin30d,
          source.apyMax30d,
          source.exchangeRate,
          source.prevExchangeRate,
          warningSignalsJson,
          isBest,
          input.startSec,
        ),
    );

    historyStmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO yield_history (
            stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
            data_source, warning_signals, yield_source, yield_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          source.id,
          source.sourceKey,
          input.startSec,
          isBest,
          source.currentApy,
          source.apyBase,
          source.apyReward,
          source.exchangeRate,
          source.sourceTvlUsd,
          source.dataSource,
          warningSignalsJson,
          source.yieldSource,
          source.yieldType,
        ),
    );

    rankingProvenanceByKey.set(
      buildHistoryKey(source.id, source.sourceKey),
      buildYieldSourceProvenance({
        source,
        isBest: isBest === 1,
        evaluatedSources: input.evaluatedSources,
        startSec: input.startSec,
        dlPoolsMeta: input.dlPoolsMeta,
      }),
    );

    updatedCount++;
  }

  const writeStmts = [...yieldDataStmts, ...historyStmts];
  if (writeStmts.length > 0) {
    await batchExecute(db, writeStmts);
  }

  return { updatedCount, rankingProvenanceByKey };
}

export async function pruneYieldTables(
  db: D1Database,
  startSec: number,
  options?: {
    allowDestructiveCleanup?: boolean;
  },
): Promise<void> {
  const managedYieldIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  if ((options?.allowDestructiveCleanup ?? true) && managedYieldIds.length > 0) {
    await deleteStaleYieldRows(db, managedYieldIds, startSec);
    await deleteOrphanYieldRows(db, managedYieldIds);
  }

  const pruneCutoff = startSec - 365 * DAY_SECONDS;
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  await db
    .prepare(`DELETE FROM yield_history WHERE recorded_at < ? ${frozenClause}`)
    .bind(pruneCutoff, ...frozenIdsList)
    .run();
}

export async function writeYieldRankingsCache(
  db: D1Database,
  rankingsPayload: unknown,
): Promise<{ ok: boolean; validationFailures: number; reason?: string }> {
  const publishability = await validateYieldRankingsPayloadForPublish(db, rankingsPayload);
  if (!publishability.ok) {
    return publishability;
  }

  await setCache(db, "yield-rankings", JSON.stringify(rankingsPayload));
  return publishability;
}
