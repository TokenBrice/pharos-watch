// worker/src/cron/sync-yield-data.ts
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { YieldRankingsResponseSchema, type AltYieldSource } from "@shared/types";
import { setCache, batchExecute, buildInClause } from "../lib/db";
import type { CronResult } from "../lib/db";
import {
  PYS_SCALING_FACTOR,
  DEFAULT_SAFETY_SCORE,
} from "../lib/constants";
import { validatePayloadWithSchema } from "../lib/api-utils";
import { computeSafetyScoresSnapshot } from "../lib/safety-scores";
import {
  STALE_THRESHOLD_MS,
  computePYS,
  computeYieldStability,
  computeApyVarianceScore,
  detectWarningSignals,
} from "./yield-helpers";
import { LENDING_PROTOCOL_LABELS } from "./yield-config";
import {
  fetchOnChainRates,
  loadDlStablecoinPools,
  loadRiskFreeRateSnapshot,
} from "./yield-sync/sources";
import { resolveYieldSources } from "./yield-sync/resolve";
import {
  computeTvlWeightedMedianApy,
  dedupeLatestBestRows,
  rowToRanking,
} from "./yield-sync/rankings";

const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.5;
const THIRTY_DAYS_SECONDS = 30 * 86400;
const LOW_SOURCE_TVL_USD = 250_000;

const TRACKED_META_BY_ID = new Map(
  TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);

type ConfidenceTier = "deterministic" | "curated" | "discovered" | "fallback";

interface YieldHistorySnapshotRow {
  stablecoin_id: string;
  source_key: string | null;
  recorded_at: number;
  is_best: number | null;
  apy: number;
  source_tvl_usd: number | null;
  data_source: string;
  yield_source: string | null;
  yield_type: string | null;
}

interface EvaluatedYieldSource {
  id: string;
  symbol: string;
  sourceKey: string;
  yieldSource: string;
  yieldType: string;
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  dataSource: string;
  exchangeRate: number | null;
  apy7d: number;
  apy30d: number;
  apyVarianceScore: number;
  stdDev30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
  yieldStability: number | null;
  safetyScore: number;
  safetyGrade: string;
  yieldToRisk: number | null;
  excessYield: number;
  pharosYieldScore: number;
  prevExchangeRate: number | null;
  prevTvlUsd: number | null;
  anomalies: string[];
  warnings: string[];
  confidenceTier: ConfidenceTier;
  rejected: boolean;
  usedLegacyHistory: boolean;
  usedDefaultSafety: boolean;
  previousBestSourceKey: string | null;
}

function buildHistoryKey(stablecoinId: string, sourceKey: string): string {
  return `${stablecoinId}::${sourceKey}`;
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function getConfidenceTier(dataSource: string): ConfidenceTier {
  switch (dataSource) {
    case "onchain":
    case "rate-derived":
      return "deterministic";
    case "defillama":
      return "curated";
    case "defillama-auto":
      return "discovered";
    case "price-derived":
    default:
      return "fallback";
  }
}

function getConfidencePriority(tier: ConfidenceTier): number {
  switch (tier) {
    case "deterministic":
      return 4;
    case "curated":
      return 3;
    case "discovered":
      return 2;
    case "fallback":
    default:
      return 1;
  }
}

function relativeDivergence(a: number, b: number): number {
  const maxValue = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / maxValue;
}

function resolveYieldSourceLabel(params: {
  id: string;
  dataSource: string;
  project?: string;
  explicitSource?: string;
}): string {
  const meta = TRACKED_META_BY_ID.get(params.id);
  const yieldConfig = meta?.yieldConfig;
  return (
    params.explicitSource ??
    yieldConfig?.yieldSource ??
    (params.dataSource === "defillama-auto" && params.project
      ? (LENDING_PROTOCOL_LABELS[params.project] ??
        params.project.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
      : "Unknown")
  );
}

function resolveYieldTypeLabel(params: {
  id: string;
  dataSource: string;
  explicitType?: string;
}): string {
  const meta = TRACKED_META_BY_ID.get(params.id);
  const yieldConfig = meta?.yieldConfig;
  return (
    params.explicitType ??
    yieldConfig?.yieldType ??
    (params.dataSource === "defillama-auto" ? "lending-opportunity" : "nav-appreciation")
  );
}

function pickHistoryRowsForSource(
  stablecoinId: string,
  sourceKey: string,
  dataSource: string,
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>,
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  resolvedCountByCoin: Map<string, number>,
): { rows: YieldHistorySnapshotRow[]; usedLegacyHistory: boolean } {
  const directRows = sourceHistory.get(buildHistoryKey(stablecoinId, sourceKey)) ?? [];
  if (directRows.length > 0) {
    return { rows: directRows, usedLegacyHistory: false };
  }

  const legacyRows = legacyHistoryById.get(stablecoinId) ?? [];
  const legacyDataSources = new Set(
    legacyRows
      .map((row) => row.data_source)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const legacyMatchesCurrentSourceFamily =
    legacyDataSources.size === 1 &&
    legacyDataSources.has(dataSource);

  if (
    legacyRows.length > 0 &&
    (resolvedCountByCoin.get(stablecoinId) ?? 0) <= 1 &&
    legacyMatchesCurrentSourceFamily
  ) {
    return { rows: legacyRows, usedLegacyHistory: true };
  }

  return { rows: [], usedLegacyHistory: false };
}

function compareCandidates(a: EvaluatedYieldSource, b: EvaluatedYieldSource): number {
  if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;

  const aHasPositiveApy = a.currentApy > 0;
  const bHasPositiveApy = b.currentApy > 0;
  if (aHasPositiveApy !== bHasPositiveApy) return aHasPositiveApy ? -1 : 1;

  const confidenceDiff = getConfidencePriority(b.confidenceTier) - getConfidencePriority(a.confidenceTier);
  if (confidenceDiff !== 0) return confidenceDiff;

  if (a.currentApy !== b.currentApy) return b.currentApy - a.currentApy;

  return (b.sourceTvlUsd ?? 0) - (a.sourceTvlUsd ?? 0);
}

function buildSelectionReason(source: EvaluatedYieldSource, rejectedPeers: number): string {
  if (source.rejected) {
    return "Selected as the least-bad remaining source after arbitration penalties";
  }

  const confidenceLabel =
    source.confidenceTier === "deterministic"
      ? "deterministic"
      : source.confidenceTier === "curated"
        ? "curated canonical"
        : source.confidenceTier === "discovered"
          ? "discovered opportunity"
          : "fallback-derived";

  if (source.usedLegacyHistory) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration using legacy history carry-forward`;
  }

  if (rejectedPeers > 0) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration after rejecting ${rejectedPeers} conflicting candidate${rejectedPeers > 1 ? "s" : ""}`;
  }

  return `${confidenceLabel} source selected by confidence-weighted arbitration`;
}

// -- Main sync function ------------------------------------------------------

export async function syncYieldData(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const sevenDaysAgoSec = startSec - 7 * 86400;
  const yieldCoins = YIELD_BEARING_STABLECOINS;

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  const { pools: dlPools, meta: dlPoolsMeta } = await loadDlStablecoinPools(db, signal);
  const onChainRates = await fetchOnChainRates(signal);
  const riskFreeRateMeta = await loadRiskFreeRateSnapshot(db);
  const riskFreeRate = riskFreeRateMeta.rate;

  const safetySnapshot = await computeSafetyScoresSnapshot(db, {
    includeNavTokens: true,
    outputMode: "map",
  });
  const safetyScores = safetySnapshot.scores;
  const safetyCoverageRatio = safetySnapshot.coverageRatio;
  const safetySnapshotDegraded =
    safetySnapshot.kind !== "ok" || safetyCoverageRatio < MIN_SAFETY_SCORE_COVERAGE_RATIO;

  if (safetySnapshotDegraded) {
    console.warn(
      `[sync-yield-data] Safety snapshot coverage degraded: ${safetySnapshot.coveredCount}/${safetySnapshot.trackedCount} ` +
      `(${(safetyCoverageRatio * 100).toFixed(1)}%)${safetySnapshot.reason ? ` reason=${safetySnapshot.reason}` : ""}`,
    );
  }

  const scoresObj: Record<string, { score: number; grade: string }> = {};
  for (const [id, val] of safetyScores) {
    scoresObj[id] = val;
  }
  if (!safetySnapshotDegraded) {
    await setCache(
      db,
      "report_card_cache",
      JSON.stringify({
        scores: scoresObj,
        updatedAt: startSec,
      }),
    );
  } else {
    console.warn("[sync-yield-data] Skipped report_card_cache write due to degraded safety snapshot");
  }

  const { resolved, tier1PrevRates } = await resolveYieldSources({
    db,
    startSec,
    sevenDaysAgoSec,
    dlPools,
    onChainRates,
    safetyScores,
    riskFreeRate,
    signal,
  });

  const resolvedWithYield = resolved.filter((entry) => entry.yield != null);
  const resolvedIds = [...new Set(resolvedWithYield.map((entry) => entry.id))];
  const resolvedCountByCoin = new Map<string, number>();
  for (const entry of resolvedWithYield) {
    resolvedCountByCoin.set(entry.id, (resolvedCountByCoin.get(entry.id) ?? 0) + 1);
  }

  const sourceHistory = new Map<string, YieldHistorySnapshotRow[]>();
  const legacyHistoryById = new Map<string, YieldHistorySnapshotRow[]>();
  const prevTvlBySource = new Map<string, number | null>();
  const legacyPrevTvlById = new Map<string, number | null>();
  const prevBestSourceKeyByCoin = new Map<string, string>();

  if (resolvedIds.length > 0) {
    const resolvedIdInClause = buildInClause(resolvedIds);
    const [historyRows, prevTvlRows, prevBestRows] = await Promise.all([
      db
        .prepare(
          `SELECT stablecoin_id, source_key, recorded_at, is_best, apy, source_tvl_usd, data_source, yield_source, yield_type
           FROM yield_history
           WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at >= ?
           ORDER BY stablecoin_id ASC, recorded_at ASC`,
        )
        .bind(...resolvedIdInClause.binds, startSec - THIRTY_DAYS_SECONDS)
        .all<YieldHistorySnapshotRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, source_key, source_tvl_usd, recorded_at
           FROM yield_history
           WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at <= ? AND source_tvl_usd IS NOT NULL
           ORDER BY stablecoin_id ASC, source_key ASC, recorded_at DESC`,
        )
        .bind(...resolvedIdInClause.binds, sevenDaysAgoSec)
        .all<YieldHistorySnapshotRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, source_key, recorded_at, is_best, apy, source_tvl_usd, data_source, yield_source, yield_type
           FROM yield_history
           WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND is_best = 1 AND recorded_at < ?
           ORDER BY stablecoin_id ASC, recorded_at DESC`,
        )
        .bind(...resolvedIdInClause.binds, startSec)
        .all<YieldHistorySnapshotRow>(),
    ]);

    for (const row of historyRows.results ?? []) {
      const sourceKey = row.source_key ?? "legacy-best";
      if (sourceKey === "legacy-best") {
        const list = legacyHistoryById.get(row.stablecoin_id) ?? [];
        list.push({ ...row, source_key: sourceKey });
        legacyHistoryById.set(row.stablecoin_id, list);
      } else {
        const key = buildHistoryKey(row.stablecoin_id, sourceKey);
        const list = sourceHistory.get(key) ?? [];
        list.push({ ...row, source_key: sourceKey });
        sourceHistory.set(key, list);
      }
    }

    for (const row of prevTvlRows.results ?? []) {
      const sourceKey = row.source_key ?? "legacy-best";
      if (sourceKey === "legacy-best") {
        if (!legacyPrevTvlById.has(row.stablecoin_id)) {
          legacyPrevTvlById.set(row.stablecoin_id, row.source_tvl_usd ?? null);
        }
      } else {
        const key = buildHistoryKey(row.stablecoin_id, sourceKey);
        if (!prevTvlBySource.has(key)) {
          prevTvlBySource.set(key, row.source_tvl_usd ?? null);
        }
      }
    }

    for (const row of prevBestRows.results ?? []) {
      if (!prevBestSourceKeyByCoin.has(row.stablecoin_id)) {
        prevBestSourceKeyByCoin.set(row.stablecoin_id, row.source_key ?? "legacy-best");
      }
    }
  }

  const resolvedByCoin = new Map<string, typeof resolvedWithYield>();
  for (const entry of resolvedWithYield) {
    const list = resolvedByCoin.get(entry.id) ?? [];
    list.push(entry);
    resolvedByCoin.set(entry.id, list);
  }

  const bestSourceKeyByCoin = new Map<string, string>();
  const evaluatedSources: EvaluatedYieldSource[] = [];
  const defaultSafetyIds = new Set<string>();
  let rowsRejected = 0;
  let divergenceFlags = 0;
  let sourceSwitches = 0;

  for (const [stablecoinId, entries] of resolvedByCoin) {
    const provisional = entries.map((entry) => {
      const y = entry.yield!;
      const sourceKey = y.sourceKey;
      const yieldSource = resolveYieldSourceLabel({
        id: stablecoinId,
        dataSource: y.dataSource,
        project: y.project,
        explicitSource: y.yieldSource,
      });
      const yieldType = resolveYieldTypeLabel({
        id: stablecoinId,
        dataSource: y.dataSource,
        explicitType: y.yieldType,
      });
      const historySelection = pickHistoryRowsForSource(
        stablecoinId,
        sourceKey,
        y.dataSource,
        sourceHistory,
        legacyHistoryById,
        resolvedCountByCoin,
      );
      const historyRows = historySelection.rows;
      const samples = historyRows.map((row) => row.apy);
      samples.push(y.currentApy);

      const apy7dSamples = historyRows
        .filter((row) => row.recorded_at >= sevenDaysAgoSec)
        .map((row) => row.apy);
      apy7dSamples.push(y.currentApy);

      const apy7d = apy7dSamples.reduce((sum, value) => sum + value, 0) / apy7dSamples.length;
      const apy30d = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      const apyVarianceScore = computeApyVarianceScore(samples);
      const yieldStability = computeYieldStability(samples);
      const stdDev30d =
        samples.length >= 2
          ? Math.sqrt(samples.reduce((sum, value) => sum + (value - apy30d) ** 2, 0) / samples.length)
          : null;
      const apyMin30d = samples.length > 0 ? samples.reduce((min, value) => Math.min(min, value), Infinity) : null;
      const apyMax30d = samples.length > 0 ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : null;

      const safety = safetyScores.get(stablecoinId);
      const usedDefaultSafety = safety == null;
      if (usedDefaultSafety) defaultSafetyIds.add(stablecoinId);
      const safetyScore = safety?.score ?? DEFAULT_SAFETY_SCORE;
      const safetyGrade = safety?.grade ?? "NR";

      const pharosYieldScore = computePYS({
        apy30d,
        safetyScore,
        apyVarianceScore,
        scalingFactor: PYS_SCALING_FACTOR,
      });
      const yieldToRisk = 101 - safetyScore > 0 ? apy30d / (101 - safetyScore) : null;
      const excessYield = apy30d - riskFreeRate;
      const prevExchangeRate = tier1PrevRates.get(stablecoinId) ?? null;
      const prevTvlUsd = historySelection.usedLegacyHistory
        ? (legacyPrevTvlById.get(stablecoinId) ?? null)
        : (prevTvlBySource.get(buildHistoryKey(stablecoinId, sourceKey)) ?? null);

      const anomalies: string[] = [];
      if (historySelection.usedLegacyHistory) anomalies.push("legacy-history-fallback");
      if (y.sourceTvlUsd != null && y.sourceTvlUsd < LOW_SOURCE_TVL_USD) anomalies.push("low-source-tvl");
      if (historyRows.length > 0 && apy30d > 0 && y.currentApy / apy30d > 2) anomalies.push("source-yield-spike");
      if (historyRows.length > 0 && apy30d > 0.5 && y.currentApy === 0) anomalies.push("source-zero-vs-history");

      return {
        id: stablecoinId,
        symbol: entry.symbol,
        sourceKey,
        yieldSource,
        yieldType,
        currentApy: y.currentApy,
        apyBase: y.apyBase,
        apyReward: y.apyReward,
        sourcePool: y.sourcePool,
        sourceTvlUsd: y.sourceTvlUsd,
        dataSource: y.dataSource,
        exchangeRate: y.exchangeRate,
        apy7d,
        apy30d,
        apyVarianceScore,
        stdDev30d,
        apyMin30d,
        apyMax30d,
        yieldStability,
        safetyScore,
        safetyGrade,
        yieldToRisk,
        excessYield,
        pharosYieldScore: Number.isFinite(pharosYieldScore) ? pharosYieldScore : 0,
        prevExchangeRate,
        prevTvlUsd,
        anomalies,
        warnings: [],
        confidenceTier: getConfidenceTier(y.dataSource),
        rejected: false as boolean,
        usedLegacyHistory: historySelection.usedLegacyHistory,
        usedDefaultSafety,
        previousBestSourceKey: prevBestSourceKeyByCoin.get(stablecoinId) ?? null,
      } satisfies EvaluatedYieldSource;
    });

    const canonicalReference = [...provisional]
      .filter((candidate) => candidate.confidenceTier !== "discovered")
      .sort(compareCandidates)[0];

    const candidates = provisional.map((candidate) => {
      const anomalies = [...candidate.anomalies];
      let rejected = candidate.rejected;

      if (
        canonicalReference &&
        canonicalReference.sourceKey !== candidate.sourceKey &&
        getConfidencePriority(candidate.confidenceTier) < getConfidencePriority(canonicalReference.confidenceTier)
      ) {
        const divergence = relativeDivergence(candidate.currentApy, canonicalReference.currentApy);
        if (canonicalReference.currentApy > 0 && candidate.currentApy > 0 && divergence > 0.5) {
          anomalies.push("diverges-from-canonical");
          divergenceFlags++;
          if (candidate.dataSource === "defillama-auto" || candidate.dataSource === "price-derived") {
            rejected = true;
          }
        }
      }

      if (anomalies.includes("source-zero-vs-history")) {
        rejected = true;
      }

      return {
        ...candidate,
        anomalies,
        rejected,
      };
    });

    const sortedCandidates = [...candidates].sort(compareCandidates);
    const rejectedPeerCount = sortedCandidates.filter((candidate) => candidate.rejected).length;
    const winner = sortedCandidates.find((candidate) => !candidate.rejected) ?? sortedCandidates[0];
    if (!winner) continue;

    bestSourceKeyByCoin.set(stablecoinId, winner.sourceKey);
    if (
      winner.previousBestSourceKey != null &&
      winner.previousBestSourceKey !== "legacy-best" &&
      winner.previousBestSourceKey !== winner.sourceKey
    ) {
      sourceSwitches++;
    }

    rowsRejected += rejectedPeerCount;
    evaluatedSources.push(
      ...candidates.map((candidate) => ({
        ...candidate,
        warnings: candidate.warnings,
        rejected: candidate.rejected,
        anomalies: candidate.anomalies,
        previousBestSourceKey: candidate.previousBestSourceKey,
        usedLegacyHistory: candidate.usedLegacyHistory,
        usedDefaultSafety: candidate.usedDefaultSafety,
        pharosYieldScore: candidate.pharosYieldScore,
      })),
    );
  }

  const bestRows = evaluatedSources.filter((source) => bestSourceKeyByCoin.get(source.id) === source.sourceKey);
  const medianApy = computeMedian(bestRows.map((row) => row.currentApy));

  for (const source of evaluatedSources) {
    source.warnings = detectWarningSignals({
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      apyReward: source.apyReward,
      medianApy,
      sourceTvlUsd: source.sourceTvlUsd,
      prevTvlUsd: source.prevTvlUsd,
    });
  }

  const yieldDataStmts: D1PreparedStatement[] = [];
  const historyStmts: D1PreparedStatement[] = [];
  const rankingProvenanceByKey = new Map<string, Record<string, unknown>>();
  let updatedCount = 0;

  for (const source of evaluatedSources) {
    const isBest = bestSourceKeyByCoin.get(source.id) === source.sourceKey ? 1 : 0;
    const warningSignalsJson = source.warnings.length > 0 ? JSON.stringify(source.warnings) : null;
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
          startSec,
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
          startSec,
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

    const sourceAgeSeconds =
      source.dataSource === "defillama" || source.dataSource === "defillama-auto"
        ? (dlPoolsMeta.ageSeconds ?? 0)
        : source.dataSource === "rate-derived"
          ? (riskFreeRateMeta.ageSeconds ?? 0)
          : 0;
    const sourceObservedAt =
      source.dataSource === "defillama" || source.dataSource === "defillama-auto"
        ? (dlPoolsMeta.updatedAt ?? startSec)
        : source.dataSource === "rate-derived"
          ? (riskFreeRateMeta.fetchedAt ?? startSec)
          : startSec;

    const rejectedPeers = evaluatedSources.filter((candidate) => candidate.id === source.id && candidate.rejected).length;
    rankingProvenanceByKey.set(buildHistoryKey(source.id, source.sourceKey), {
      sourceKey: source.sourceKey,
      sourceObservedAt,
      sourceAgeSeconds,
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
      benchmarkRecordDate: riskFreeRateMeta.recordDate,
      benchmarkIsFallback: riskFreeRateMeta.isFallback,
      benchmarkFallbackMode: riskFreeRateMeta.fallbackMode,
      anomalies: source.anomalies,
    });

    updatedCount++;
  }

  {
    const nativeApyByCoin = new Map<string, number>();
    const lendingApyByCoin = new Map<string, number>();
    for (const source of evaluatedSources) {
      if (source.dataSource === "defillama-auto") {
        lendingApyByCoin.set(source.id, source.currentApy);
      } else {
        nativeApyByCoin.set(source.id, source.currentApy);
      }
    }
    for (const [coinId, nativeApy] of nativeApyByCoin) {
      const lendingApy = lendingApyByCoin.get(coinId);
      if (lendingApy != null && nativeApy > 0 && lendingApy > 0) {
        const divergence = relativeDivergence(nativeApy, lendingApy);
        if (divergence > 0.5) {
          console.warn(
            `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`,
          );
        }
      }
    }
  }

  const writeStmts = [...yieldDataStmts, ...historyStmts];
  if (writeStmts.length > 0) await batchExecute(db, writeStmts);

  if (resolvedIds.length > 0) {
    const staleRowInClause = buildInClause(resolvedIds);
    await db
      .prepare(
        `DELETE FROM yield_data
         WHERE stablecoin_id IN (${staleRowInClause.sql}) AND updated_at < ?`,
      )
      .bind(...staleRowInClause.binds, startSec)
      .run();
  }

  const pruneCutoff = startSec - 365 * 86400;
  await db.prepare("DELETE FROM yield_history WHERE recorded_at < ?").bind(pruneCutoff).run();

  const rankingsData = await db
    .prepare("SELECT * FROM yield_data WHERE is_best = 1 ORDER BY pharos_yield_score DESC")
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
  const rankingsPayload = {
    rankings: dedupeLatestBestRows(rankingsData.results ?? []).map((row) => {
      const key = buildHistoryKey(String(row.stablecoin_id), String(row.source_key));
      const ranking = {
        ...rowToRanking(row),
        altSources: altSourcesByCoin.get(String(row.stablecoin_id)) ?? [],
        provenance: rankingProvenanceByKey.get(key) ?? null,
      };

      const updatedAtMs = typeof row.updated_at === "number" ? row.updated_at * 1000 : 0;
      if (updatedAtMs > 0 && updatedAtMs < now - STALE_THRESHOLD_MS) {
        if (!ranking.warningSignals.includes("data-stale")) {
          ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
        }
      }
      return ranking;
    }),
    riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: tvlWeightedMedian,
    updatedAt: startSec,
    provenance: {
      selectionMethod: "confidence-weighted",
      benchmark: riskFreeRateMeta,
      dlPools: dlPoolsMeta,
      safetySnapshot: {
        kind: safetySnapshot.kind,
        coverageRatio: Number(safetyCoverageRatio.toFixed(4)),
        coveredCount: safetySnapshot.coveredCount,
        trackedCount: safetySnapshot.trackedCount,
        reason: safetySnapshot.reason ?? null,
      },
    },
  };

  const validation = validatePayloadWithSchema(
    YieldRankingsResponseSchema,
    rankingsPayload,
    "sync-yield-data:yield-rankings",
  );

  const degradationReasons: string[] = [];
  if (safetySnapshotDegraded) {
    degradationReasons.push("safety-snapshot-coverage");
    if (safetySnapshot.reason) {
      degradationReasons.push(`safety-snapshot:${safetySnapshot.reason}`);
    }
  }
  if (riskFreeRateMeta.fallbackMode) {
    degradationReasons.push(`risk-free-rate:${riskFreeRateMeta.fallbackMode}`);
  }
  if (dlPoolsMeta.mode === "unavailable" || dlPoolsMeta.fallbackMode === "cache-parse-failed") {
    degradationReasons.push(`dl-pools:${dlPoolsMeta.fallbackMode ?? dlPoolsMeta.mode}`);
  }

  let validationFailures = 0;
  if (validation.ok) {
    await setCache(db, "yield-rankings", JSON.stringify(validation.data));
  } else {
    validationFailures++;
    degradationReasons.push("schema-validation-failed");
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to schema validation failure");
  }

  console.log(`[sync-yield-data] Updated ${updatedCount} source rows (${yieldCoins.length} yield-bearing + auto-discovered)`);
  const status = degradationReasons.length > 0 ? "degraded" : "ok";
  return {
    itemCount: updatedCount,
    ...(status === "degraded" ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      rowsRead: yieldCoins.length,
      rowsWritten: updatedCount,
      rowsDropped: rowsRejected,
      rowsRejected,
      divergenceFlags,
      sourceSwitches,
      defaultSafetyCoinCount: defaultSafetyIds.size,
      sourceCoverage: {
        safetyScoresComputed: safetySnapshot.coveredCount,
        safetyScoresExpected: safetySnapshot.trackedCount,
        safetyCoverageRatio: Number(safetyCoverageRatio.toFixed(4)),
        dlPoolCount: dlPoolsMeta.poolCount,
      },
      fallbackMode: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
      validationFailures,
      riskFreeRate,
      cacheWriteSkipped: !validation.ok,
    }),
  };
}
