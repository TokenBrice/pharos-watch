import { YieldRankingsResponseSchema, type AltYieldSource, type YieldBenchmarkMeta, type YieldSafetySnapshotMeta, type YieldSourceInputMeta } from "@shared/types";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { batchExecute } from "../../lib/db";
import { getCache, setCache } from "../../lib/db-cache";
import { validatePayloadWithSchema } from "../../lib/api-utils";
import { PYS_SCALING_FACTOR } from "../../lib/constants";
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";
import { STALE_THRESHOLD_MS, detectWarningSignals } from "../yield-helpers";
import { dedupeLatestBestRows, computeTvlWeightedMedianApy, rowToRanking } from "./rankings";
import { deleteOrphanYieldRows, deleteStaleYieldRows } from "./history";
import { buildHistoryKey, buildSelectionReason, type EvaluatedYieldSource } from "./evaluation";

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
    dlPoolsMeta: YieldSourceInputMeta;
    safetySnapshot: YieldSafetySnapshotMeta;
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
    alts.push({
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
    });
    altSourcesByCoin.set(source.id, alts);
  }

  const rankings = bestRows.map((source) => {
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const ranking = evaluatedSourceToRanking(source, provenance);
    ranking.altSources = altSourcesByCoin.get(source.id) ?? [];

    const sourceObservedAt =
      provenance != null && typeof provenance.sourceObservedAt === "number"
        ? provenance.sourceObservedAt
        : input.startSec;
    const updatedAtMs = sourceObservedAt * 1000;
    if (updatedAtMs > 0 && updatedAtMs < Date.now() - STALE_THRESHOLD_MS) {
      if (!ranking.warningSignals.includes("data-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
      }
    }

    return ranking;
  });

  return {
    rankings,
    riskFreeRate: input.riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: computeTvlWeightedMedianApy(
      bestRows.map((source) => ({
        apy_30d: source.apy30d,
        source_tvl_usd: source.sourceTvlUsd,
      })),
    ),
    updatedAt: input.startSec,
    provenance: {
      selectionMethod: "confidence-weighted" as const,
      benchmark: input.riskFreeRateMeta,
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
  const previousCache = await getCache(db, "yield-rankings");
  let previousRankings = 0;
  if (previousCache) {
    try {
      const parsed = JSON.parse(previousCache.value) as { rankings?: unknown[] };
      if (Array.isArray(parsed.rankings)) previousRankings = parsed.rankings.length;
    } catch {
      previousRankings = 0;
    }
  }
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
    riskFreeRateMeta: YieldBenchmarkMeta;
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

    const sourceObservedAt =
      source.sourceObservedAt
      ?? (source.dataSource === "defillama" || source.dataSource === "defillama-auto"
        ? (input.dlPoolsMeta.updatedAt ?? input.startSec)
        : source.dataSource === "rate-derived"
          ? (input.riskFreeRateMeta.fetchedAt ?? input.startSec)
          : input.startSec);
    const sourceAgeSeconds =
      source.dataSource === "defillama" || source.dataSource === "defillama-auto"
        ? (input.dlPoolsMeta.ageSeconds ?? Math.max(0, input.startSec - sourceObservedAt))
        : source.dataSource === "rate-derived"
          ? (input.riskFreeRateMeta.ageSeconds ?? Math.max(0, input.startSec - sourceObservedAt))
          : Math.max(0, input.startSec - sourceObservedAt);
    const comparisonAnchorObservedAt = source.comparisonAnchorObservedAt ?? null;
    const comparisonAnchorAgeSeconds =
      comparisonAnchorObservedAt != null ? Math.max(0, input.startSec - comparisonAnchorObservedAt) : null;

    const rejectedPeers = input.evaluatedSources.filter((candidate) => candidate.id === source.id && candidate.rejected).length;
    rankingProvenanceByKey.set(buildHistoryKey(source.id, source.sourceKey), {
      sourceKey: source.sourceKey,
      sourceObservedAt,
      sourceAgeSeconds,
      comparisonAnchorObservedAt,
      comparisonAnchorAgeSeconds,
      confidenceTier: source.confidenceTier,
      selectionMethod: "confidence-weighted",
      selectionReason: isBest
        ? buildSelectionReason(source, rejectedPeers)
        : "Alternative source retained for comparison",
      sourceSwitch:
        isBest === 1 &&
        source.previousBestSourceKey != null &&
        source.previousBestSourceKey !== "legacy-best" &&
        source.previousBestSourceKey !== source.sourceKey,
      previousBestSourceKey:
        source.previousBestSourceKey != null && source.previousBestSourceKey !== "legacy-best"
          ? source.previousBestSourceKey
          : null,
      usedLegacyHistory: source.usedLegacyHistory,
      usedDefaultSafety: source.usedDefaultSafety,
      benchmarkRecordDate: input.riskFreeRateMeta.recordDate,
      benchmarkIsFallback: input.riskFreeRateMeta.isFallback,
      benchmarkFallbackMode: input.riskFreeRateMeta.fallbackMode,
      anomalies: source.anomalies,
    });

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
  await db.prepare("DELETE FROM yield_history WHERE recorded_at < ?").bind(pruneCutoff).run();
}

export async function buildYieldRankingsPayload(
  db: D1Database,
  input: {
    startSec: number;
    rankingProvenanceByKey: Map<string, Record<string, unknown>>;
    riskFreeRate: number;
    riskFreeRateMeta: YieldBenchmarkMeta;
    dlPoolsMeta: YieldSourceInputMeta;
    safetySnapshot: YieldSafetySnapshotMeta;
  },
) {
  const rankingsData = await db
    .prepare(
      `SELECT stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
              yield_source, yield_type, data_source, source_tvl_usd, pharos_yield_score,
              safety_score, safety_grade, yield_to_risk, excess_yield, yield_stability,
              apy_variance_30d, apy_min_30d, apy_max_30d, warning_signals, updated_at
       FROM yield_data WHERE is_best = 1 ORDER BY pharos_yield_score DESC`,
    )
    .all();

  const altSourcesData = await db
    .prepare(
      "SELECT stablecoin_id, source_key, current_apy, apy_30d, yield_source, yield_type, source_tvl_usd, data_source FROM yield_data WHERE is_best = 0",
    )
    .all<{
      stablecoin_id: string;
      source_key: string;
      current_apy: number;
      apy_30d: number;
      yield_source: string;
      yield_type: string;
      source_tvl_usd: number | null;
      data_source: string;
    }>();

  const altSourcesByCoin = new Map<string, AltYieldSource[]>();
  for (const row of altSourcesData.results ?? []) {
    const alts = altSourcesByCoin.get(row.stablecoin_id) ?? [];
    alts.push({
      sourceKey: row.source_key,
      yieldSource: row.yield_source,
      yieldSourceUrl: resolveYieldSourceUrl({
        stablecoinId: row.stablecoin_id,
        sourceKey: row.source_key,
        yieldSource: row.yield_source,
      }),
      yieldType: row.yield_type as AltYieldSource["yieldType"],
      currentApy: row.current_apy,
      apy30d: row.apy_30d,
      sourceTvlUsd: row.source_tvl_usd,
      dataSource: row.data_source,
    });
    altSourcesByCoin.set(row.stablecoin_id, alts);
  }

  const now = Date.now();
  const tvlWeightedMedian = computeTvlWeightedMedianApy(
    (rankingsData.results ?? []) as Array<{ apy_30d: number; source_tvl_usd: number | null }>,
  );
  return {
    rankings: dedupeLatestBestRows(rankingsData.results ?? []).map((row) => {
      const key = buildHistoryKey(String(row.stablecoin_id), String(row.source_key));
      const ranking = {
        ...rowToRanking(row),
        altSources: altSourcesByCoin.get(String(row.stablecoin_id)) ?? [],
        provenance: input.rankingProvenanceByKey.get(key) ?? null,
      };

      const updatedAtMs = typeof row.updated_at === "number" ? row.updated_at * 1000 : 0;
      if (updatedAtMs > 0 && updatedAtMs < now - STALE_THRESHOLD_MS) {
        if (!ranking.warningSignals.includes("data-stale")) {
          ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
        }
      }
      return ranking;
    }),
    riskFreeRate: input.riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: tvlWeightedMedian,
    updatedAt: input.startSec,
    provenance: {
      selectionMethod: "confidence-weighted",
      benchmark: input.riskFreeRateMeta,
      dlPools: input.dlPoolsMeta,
      safetySnapshot: input.safetySnapshot,
    },
  };
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
