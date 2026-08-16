import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { resolvePsiInclusiveStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { percentileNearestRank } from "@shared/lib/stats";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
} from "../lib/api-utils";
import { BACKTEST_ANCHORS, BACKTEST_NEGATIVE_CONTROLS } from "../lib/backtest-anchors";
import { BACKTEST_LOOKBACK_DAYS } from "../lib/constants";
import { computeDEWS } from "../lib/dews";
import type { DEWSInput } from "../lib/dews";
import { assembleDewsScoringInput } from "../lib/dews/input-assembly";
import { buildDewsScoringResult } from "../lib/dews/scoring";
import type {
  MalformedPersistedInput,
  PersistedJsonDecodeReason,
  SourceFailure,
} from "../lib/dews/contracts";
import { runAdminRoute } from "../lib/route-wrappers";
import { computeAndStoreDEWS } from "../lib/dews/service";
import { parseOptionalDayWindow } from "./backfill-depegs-window";

interface DepegEventRow {
  stablecoin_id: string;
  started_at: number;
  ended_at: number | null;
  peak_deviation_bps: number | null;
}

interface EventResult {
  stablecoinId: string;
  startedAt: number;
  peakBps: number | null;
  preDepegScores: { daysBeforeDepeg: number; score: number; band: string }[];
  predicted: boolean;
  leadTimeDays: number | null;
}

type DewsRepairMode = "refresh-current" | "prune-history";

interface DewsRefreshPreview {
  computedAt: number;
  snapshotDay: number;
  targetCoinCount: number;
  targetStablecoinIds: string[];
  insufficientDataCount: number;
  validationFailures: number;
  sourceCoverage: Record<string, number>;
  sourceFailures: SourceFailure[];
  malformedPersistedInputs: MalformedPersistedInput[];
}

interface HistoryRowSample {
  stablecoinId: string;
  snapshotDate: number;
}

const DEWS_TRUST_REPAIR_WINDOW_START_DAY = 1_773_014_400; // 2026-03-09T00:00:00Z (live $1M DEX trust floor launch)
const HISTORY_SAMPLE_LIMIT = 50;

function getTodayMidnightUtcSec(nowSec = Math.floor(Date.now() / 1000)): number {
  return bucketUnixSecondsToUtcDay(nowSec);
}

function parseRepairMode(raw: string | null): DewsRepairMode | null {
  if (raw === "refresh-current" || raw === "prune-history") {
    return raw;
  }
  return null;
}

async function buildRefreshPreview(db: D1Database): Promise<DewsRefreshPreview | Response> {
  const nowSec = Math.floor(Date.now() / 1000);
  const sourceFailures: SourceFailure[] = [];
  const malformedPersistedInputs: MalformedPersistedInput[] = [];
  let validationFailures = 0;

  const registerSourceFailure = (
    source: string,
    error: unknown,
    options?: { bootstrapAllowed?: boolean },
  ): void => {
    sourceFailures.push({
      source,
      reason: String(error),
      bootstrapAllowed: options?.bootstrapAllowed ?? false,
    });
  };

  const registerMalformedPersistedInput = (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }): void => {
    validationFailures++;
    malformedPersistedInputs.push({
      source: options.source,
      context: options.context,
      stablecoinId: options.stablecoinId,
      updatedAt: options.updatedAt ?? null,
      degradesRun: options.degradesRun,
    });
  };

  const assembled = await assembleDewsScoringInput({
    db,
    nowSec,
    registerSourceFailure,
    registerMalformedPersistedInput,
  });
  if (assembled.kind !== "ok") {
    return errorResponse(503, `DEWS refresh preview unavailable: stablecoins cache ${assembled.reason}`);
  }
  const {
    assetById,
    pegRates,
    pegRateSources,
    pegRateContributorCounts,
    sourceState,
  } = assembled;
  const { results, insufficientDataCount } = buildDewsScoringResult({
    assetById,
    pegRates,
    pegRateSources,
    pegRateContributorCounts,
    sourceState,
    registerMalformedPersistedInput,
  });

  return {
    computedAt: nowSec,
    snapshotDay: getTodayMidnightUtcSec(nowSec),
    targetCoinCount: results.length,
    targetStablecoinIds: results.map((row) => row.stablecoinId),
    insufficientDataCount,
    validationFailures,
    sourceCoverage: {
      stablecoins: assembled.eligibleAssets.length,
      ...sourceState.sourceCoverage,
    },
    sourceFailures,
    malformedPersistedInputs,
  };
}

function buildHistoryScopeSql(
  stablecoinId: string | null,
): { whereSql: string; bindsPrefix: unknown[] } {
  if (stablecoinId) {
    return {
      whereSql: "WHERE snapshot_date >= ? AND snapshot_date <= ? AND stablecoin_id = ?",
      bindsPrefix: [stablecoinId],
    };
  }
  return {
    whereSql: "WHERE snapshot_date >= ? AND snapshot_date <= ?",
    bindsPrefix: [],
  };
}

async function queryHistoryCandidates(
  db: D1Database,
  stablecoinId: string | null,
  startDay: number,
  endDay: number,
): Promise<{ totalMatchingRows: number; candidateRowsSample: HistoryRowSample[] }> {
  const scoped = buildHistoryScopeSql(stablecoinId);
  const countSql = `SELECT COUNT(*) as cnt FROM stress_signal_history ${scoped.whereSql}`;
  const sampleSql = `
    SELECT stablecoin_id, snapshot_date
    FROM stress_signal_history
    ${scoped.whereSql}
    ORDER BY snapshot_date ASC, stablecoin_id ASC
    LIMIT ${HISTORY_SAMPLE_LIMIT}
  `;
  const binds = stablecoinId == null ? [startDay, endDay] : [startDay, endDay, ...scoped.bindsPrefix];
  const countRow = await db.prepare(countSql).bind(...binds).first<{ cnt: number }>();
  const sampleRows = await db
    .prepare(sampleSql)
    .bind(...binds)
    .all<{ stablecoin_id: string; snapshot_date: number }>();

  return {
    totalMatchingRows: countRow?.cnt ?? 0,
    candidateRowsSample: (sampleRows.results ?? []).map((row) => ({
      stablecoinId: row.stablecoin_id,
      snapshotDate: row.snapshot_date,
    })),
  };
}

async function queryHistoryBoundary(
  db: D1Database,
  stablecoinId: string | null,
  afterDay: number,
): Promise<{
  oldestRemainingDay: number | null;
  nextRetainedDayAfterWindow: number | null;
}> {
  const globalMinSql = stablecoinId
    ? "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE stablecoin_id = ?"
    : "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history";
  const nextDaySql = stablecoinId
    ? "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date > ?"
    : "SELECT MIN(snapshot_date) as min_day FROM stress_signal_history WHERE snapshot_date > ?";

  const oldestRemaining = stablecoinId
    ? await db.prepare(globalMinSql).bind(stablecoinId).first<{ min_day: number | null }>()
    : await db.prepare(globalMinSql).first<{ min_day: number | null }>();
  const nextRetained = stablecoinId
    ? await db.prepare(nextDaySql).bind(stablecoinId, afterDay).first<{ min_day: number | null }>()
    : await db.prepare(nextDaySql).bind(afterDay).first<{ min_day: number | null }>();

  return {
    oldestRemainingDay: oldestRemaining?.min_day ?? null,
    nextRetainedDayAfterWindow: nextRetained?.min_day ?? null,
  };
}

async function handlePruneHistoryRepair(
  db: D1Database,
  url: URL,
  dryRun: boolean,
): Promise<Response> {
  const stablecoinParam = url.searchParams.get("stablecoin");
  const resolvedStablecoin = stablecoinParam
    ? resolvePsiInclusiveStablecoinId(stablecoinParam)
    : null;
  if (stablecoinParam && !resolvedStablecoin) {
    return errorResponse(404, "Unknown stablecoin");
  }
  const stablecoinId = resolvedStablecoin?.canonicalId ?? null;

  const todayMidnight = getTodayMidnightUtcSec();
  const window = parseOptionalDayWindow(url, {
    defaultStartDay: DEWS_TRUST_REPAIR_WINDOW_START_DAY,
    defaultEndDay: todayMidnight,
    invalidStartDayMessage: "Invalid startDay. Use Unix seconds/milliseconds or YYYY-MM-DD.",
    invalidEndDayMessage: "Invalid endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.",
  });
  if (window instanceof Response) return window;
  const { startDay, endDay, usedDefaultWindow } = window;
  if (startDay == null || endDay == null) return errorResponse(400, "Invalid startDay/endDay: startDay must be <= endDay.");

  const candidates = await queryHistoryCandidates(db, stablecoinId, startDay, endDay);
  const boundaryBefore = await queryHistoryBoundary(db, stablecoinId, endDay);

  const responseBody: Record<string, unknown> = {
    repair: "prune-history",
    dryRun,
    stablecoinId,
    startDay,
    endDay,
    usedDefaultWindow,
    totalMatchingRows: candidates.totalMatchingRows,
    candidateRowsSample: candidates.candidateRowsSample,
    oldestRemainingDay: boundaryBefore.oldestRemainingDay,
    nextRetainedDayAfterWindow: boundaryBefore.nextRetainedDayAfterWindow,
    reason:
      "Historical DEWS rows do not retain the DEX trust metadata needed to deterministically replay the live $1M divergence gate, so the known-bad window must be pruned instead of recomputed.",
  };

  if (dryRun || candidates.totalMatchingRows === 0) {
    return jsonResponse(responseBody);
  }

  const deleteSql = stablecoinId
    ? "DELETE FROM stress_signal_history WHERE snapshot_date >= ? AND snapshot_date <= ? AND stablecoin_id = ?"
    : "DELETE FROM stress_signal_history WHERE snapshot_date >= ? AND snapshot_date <= ?";
  const deleteBinds = stablecoinId == null ? [startDay, endDay] : [startDay, endDay, stablecoinId];
  const deleteResult = await db.prepare(deleteSql).bind(...deleteBinds).run();
  const boundaryAfter = await queryHistoryBoundary(db, stablecoinId, endDay);

  return jsonResponse({
    ...responseBody,
    dryRun: false,
    prunedRows: deleteResult.meta?.changes ?? 0,
    oldestRemainingDay: boundaryAfter.oldestRemainingDay,
    nextRetainedDayAfterWindow: boundaryAfter.nextRetainedDayAfterWindow,
  });
}

async function handleRefreshCurrentRepair(
  db: D1Database,
  dryRun: boolean,
): Promise<Response> {
  const preview = await buildRefreshPreview(db);
  if (preview instanceof Response) {
    return preview;
  }

  if (dryRun) {
    return jsonResponse({
      repair: "refresh-current",
      dryRun: true,
      preview,
    });
  }

  const execution = await computeAndStoreDEWS(db);
  let executionMetadata: Record<string, unknown> | null = null;
  try {
    executionMetadata = execution.metadata ? JSON.parse(execution.metadata) as Record<string, unknown> : null;
  } catch {
    executionMetadata = null;
  }

  return jsonResponse({
    repair: "refresh-current",
    dryRun: false,
    preview,
    execution: {
      itemCount: execution.itemCount,
      status: execution.status ?? "ok",
      metadata: executionMetadata,
    },
  });
}

async function handleHistoricalBacktest(db: D1Database): Promise<Response> {
  const events = await db
    .prepare(
      "SELECT stablecoin_id, started_at, ended_at, peak_deviation_bps FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at ASC",
    )
    .all<DepegEventRow>();

  if (!events.results.length) {
    return errorResponse(404, "No completed depeg events found");
  }

  const supplyRows = await db
    .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date ASC")
    .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();

  const supplyIndex = new Map<string, Map<number, number>>();
  for (const row of supplyRows.results) {
    if (!supplyIndex.has(row.stablecoin_id)) supplyIndex.set(row.stablecoin_id, new Map());
    supplyIndex.get(row.stablecoin_id)!.set(row.snapshot_date, row.circulating_usd);
  }

  const liqRows = await db
    .prepare(
      "SELECT stablecoin_id, snapshot_date, liquidity_score, total_tvl_usd FROM dex_liquidity_history ORDER BY snapshot_date ASC",
    )
    .all<{
      stablecoin_id: string;
      snapshot_date: number;
      liquidity_score: number | null;
      total_tvl_usd: number | null;
    }>();

  const liqIndex = new Map<string, { snapshotDate: number; score: number | null; tvl: number | null }[]>();
  for (const row of liqRows.results) {
    if (!liqIndex.has(row.stablecoin_id)) liqIndex.set(row.stablecoin_id, []);
    liqIndex.get(row.stablecoin_id)!.push({
      snapshotDate: row.snapshot_date,
      score: row.liquidity_score,
      tvl: row.total_tvl_usd,
    });
  }

  const results: EventResult[] = [];
  let tpCount = 0;
  let totalLeadTimeDays = 0;
  let leadTimeCount = 0;

  for (const event of events.results) {
    const coinSupply = supplyIndex.get(event.stablecoin_id);
    const coinLiq = liqIndex.get(event.stablecoin_id) ?? [];
    const preDepegScores: EventResult["preDepegScores"] = [];
    let predicted = false;
    let leadTimeDays: number | null = null;

    for (let d = 7; d >= 0; d--) {
      const targetDay = event.started_at - d * DAY_SECONDS;
      const dayMidnight = bucketUnixSecondsToUtcDay(targetDay);

      const current = coinSupply?.get(dayMidnight) ?? 0;
      const prevDay = coinSupply?.get(dayMidnight - DAY_SECONDS) ?? current;
      const prevWeek = coinSupply?.get(dayMidnight - 7 * DAY_SECONDS) ?? current;

      if (current <= 0) continue;

      const liqNow = coinLiq.find((liq) => Math.abs(liq.snapshotDate - dayMidnight) < 2 * DAY_SECONDS);
      const liq7d = coinLiq.find(
        (liq) => Math.abs(liq.snapshotDate - (dayMidnight - 7 * DAY_SECONDS)) < 2 * DAY_SECONDS,
      );

      const input: DEWSInput = {
        stablecoinId: event.stablecoin_id,
        mcapUsd: current,
        pegType: "peggedUSD",
        circulatingCurrent: current,
        circulatingPrevDay: prevDay,
        circulatingPrevWeek: prevWeek,
        weightedBalanceRatio: null,
        avgPoolStress: null,
        topPools: null,
        liquidityScore: liqNow?.score ?? null,
        liquidityScore7dAgo: liq7d?.score ?? null,
        tvlCurrent: liqNow?.tvl ?? null,
        tvl7dAgo: liq7d?.tvl ?? null,
        priceConfidence: null,
        prevPriceConfidence: null,
        price: null,
        pegRef: 1.0,
        dexPriceUsd: null,
        blacklistEvents24h: 0,
        blacklistEvents7d: 0,
        hasBlacklistTracking: false,
        burnVolume24hUsd: null,
        mintVolume24hUsd: null,
        burnBaseline30dUsd: null,
        flowDataAgeDays: 0,
        yieldWarnings: [],
        psiScore: null,
      };

      const result = computeDEWS(input);
      if (!result) {
        continue;
      }
      preDepegScores.push({
        daysBeforeDepeg: d,
        score: result.score,
        band: result.band,
      });

      if (
        d > 0 &&
        !predicted &&
        (result.band === "ALERT" || result.band === "WARNING" || result.band === "DANGER")
      ) {
        predicted = true;
        leadTimeDays = d;
      }
    }

    if (predicted) {
      tpCount++;
      if (leadTimeDays !== null) {
        totalLeadTimeDays += leadTimeDays;
        leadTimeCount++;
      }
    }

    results.push({
      stablecoinId: event.stablecoin_id,
      startedAt: event.started_at,
      peakBps: event.peak_deviation_bps,
      preDepegScores,
      predicted,
      leadTimeDays,
    });
  }

  const totalEvents = results.length;
  const tpRate = totalEvents > 0 ? Math.round((tpCount / totalEvents) * 100) : 0;
  const avgLeadTime = leadTimeCount > 0 ? Math.round((totalLeadTimeDays / leadTimeCount) * 10) / 10 : null;

  return jsonResponse({
    summary: {
      totalEvents,
      truePositives: tpCount,
      tpRate: `${tpRate}%`,
      avgLeadTimeDays: avgLeadTime,
      note: "Backtest uses supply_history + dex_liquidity_history only. Pool balance, price confidence, blacklist, and flow signals are unavailable for historical data.",
    },
    events: results,
  });
}

interface BacktestMetricsPerAnchor {
  stablecoinId: string;
  onsetAt: number;
  detected: boolean;
  leadTimeDays: number | null;
  firstAlertBand: string | null;
  alertDays: number;
  bandTransitions: number;
  pegType: string | null;
}

async function handleBacktestMetrics(db: D1Database): Promise<Response> {
  const perAnchor = await Promise.all(
    BACKTEST_ANCHORS.map(async (anchor): Promise<BacktestMetricsPerAnchor> => {
      const windowStart = anchor.onsetAt - BACKTEST_LOOKBACK_DAYS * DAY_SECONDS;
      const rows = await db
        .prepare(
          "SELECT snapshot_date, band FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date >= ? AND snapshot_date <= ? AND band IN ('ALERT', 'WARNING', 'DANGER') ORDER BY snapshot_date ASC",
        )
        .bind(anchor.stablecoinId, windowStart, anchor.onsetAt)
        .all<{ snapshot_date: number; band: string }>();

      const alertRows = rows.results ?? [];
      const row = alertRows[0] ?? null;
      const detected = row != null;
      let bandTransitions = 0;
      for (let i = 1; i < alertRows.length; i++) {
        if (alertRows[i]?.band !== alertRows[i - 1]?.band) bandTransitions++;
      }
      return {
        stablecoinId: anchor.stablecoinId,
        onsetAt: anchor.onsetAt,
        detected,
        leadTimeDays: detected ? (anchor.onsetAt - row.snapshot_date) / DAY_SECONDS : null,
        firstAlertBand: row?.band ?? null,
        alertDays: alertRows.length,
        bandTransitions,
        pegType: PSI_ELIGIBLE_META_BY_ID.get(anchor.stablecoinId)
          ? `pegged${PSI_ELIGIBLE_META_BY_ID.get(anchor.stablecoinId)!.flags.pegCurrency}`
          : null,
      };
    }),
  );

  const negativeControls = await Promise.all(
    BACKTEST_NEGATIVE_CONTROLS.map(async (control) => {
      const rows = await db
        .prepare(
          "SELECT snapshot_date, band FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date >= ? AND snapshot_date <= ? AND band IN ('ALERT', 'WARNING', 'DANGER') ORDER BY snapshot_date ASC",
        )
        .bind(control.stablecoinId, control.windowStart, control.windowEnd)
        .all<{ snapshot_date: number; band: string }>();
      const alertRows = rows.results ?? [];
      return {
        stablecoinId: control.stablecoinId,
        windowStart: control.windowStart,
        windowEnd: control.windowEnd,
        falsePositiveDays: alertRows.length,
        firstAlertBand: alertRows[0]?.band ?? null,
      };
    }),
  );

  const detected = perAnchor.filter((entry) => entry.detected);
  const falsePositiveDays = negativeControls.reduce((sum, entry) => sum + entry.falsePositiveDays, 0);
  const leadTimes = detected.map((entry) => entry.leadTimeDays!);
  const byPegType: Record<string, { anchors: number; detected: number; recall: number }> = {};
  for (const entry of perAnchor) {
    const key = entry.pegType ?? "unknown";
    const bucket = byPegType[key] ?? { anchors: 0, detected: 0, recall: 0 };
    bucket.anchors++;
    if (entry.detected) bucket.detected++;
    bucket.recall = bucket.anchors === 0 ? 0 : bucket.detected / bucket.anchors;
    byPegType[key] = bucket;
  }
  const truePositives = detected.length;
  const falseNegativeIncidents = perAnchor.length - truePositives;
  const precisionDenominator = truePositives + falsePositiveDays;

  return jsonResponse({
    detectionRate: BACKTEST_ANCHORS.length === 0 ? 0 : truePositives / BACKTEST_ANCHORS.length,
    precision: precisionDenominator === 0 ? null : truePositives / precisionDenominator,
    recall: BACKTEST_ANCHORS.length === 0 ? 0 : truePositives / BACKTEST_ANCHORS.length,
    falsePositiveDays,
    falseNegativeIncidents,
    leadTimeDaysP50: percentileNearestRank(leadTimes, 50),
    leadTimeDaysP90: percentileNearestRank(leadTimes, 90),
    alertChurn: {
      averageAlertDaysPerAnchor:
        perAnchor.length === 0 ? 0 : perAnchor.reduce((sum, entry) => sum + entry.alertDays, 0) / perAnchor.length,
      bandTransitions: perAnchor.reduce((sum, entry) => sum + entry.bandTransitions, 0),
    },
    cohortMetrics: {
      byPegType,
      negativeControlCount: BACKTEST_NEGATIVE_CONTROLS.length,
    },
    negativeControls,
    granularity: "daily",
    dataSource: "stress_signal_history",
    diagnosticMode: "legacy-reconstruction remains available at GET /api/backfill-dews without mode=backtest-metrics",
    perAnchor,
  });
}

export interface BackfillDewsRouteContext {
  db: D1Database;
  url: URL;
  trustedAdmin?: boolean;
  request?: Request;
}

export function handleBackfillDEWS({
  db,
  url,
  trustedAdmin,
  request,
}: BackfillDewsRouteContext): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "backfill-dews",
      request,
      trustedAdmin,
    },
    async () => {
      const method = request?.method ?? "GET";
      const dryRun = url.searchParams.get("dry-run") === "true";
      const mode = url.searchParams.get("mode");
      const repairModeRaw = url.searchParams.get("repair");
      const repairMode = parseRepairMode(repairModeRaw);

      if (repairModeRaw && repairMode == null) {
        return errorResponse(400, `Unsupported repair mode: ${repairModeRaw}`);
      }

      if (method === "GET") {
        if (mode === "backtest-metrics") {
          return handleBacktestMetrics(db);
        }
        if (repairMode) {
          if (!dryRun) {
            return methodNotAllowedResponse(
              "Method not allowed. GET supports repair previews only with dry-run=true; use POST for DEWS repair mutations.",
              ["POST"],
            );
          }
          return repairMode === "refresh-current"
            ? handleRefreshCurrentRepair(db, true)
            : handlePruneHistoryRepair(db, url, true);
        }
        return handleHistoricalBacktest(db);
      }

      if (!repairMode) {
        return errorResponse(400, "POST /api/backfill-dews requires repair=refresh-current or repair=prune-history.");
      }

      return repairMode === "refresh-current"
        ? handleRefreshCurrentRepair(db, dryRun)
        : handlePruneHistoryRepair(db, url, dryRun);
    },
  );
}
