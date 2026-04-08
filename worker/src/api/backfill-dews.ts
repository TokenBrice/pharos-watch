import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates } from "@shared/lib/peg-rates";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  errorResponse,
  jsonResponse,
  resolveOrReject,
} from "../lib/api-utils";
import { getCache } from "../lib/db-cache";
import { computeDEWS } from "../lib/dews";
import type { DEWSInput } from "../lib/dews";
import { runAdminRoute } from "../lib/route-wrappers";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { computeAndStoreDEWS } from "../cron/compute-dews";
import { buildDewsScoringResult } from "../cron/dews/scoring";
import type {
  MalformedPersistedInput,
  PersistedJsonDecodeReason,
  SourceFailure,
} from "../cron/dews/contracts";
import { loadDewsSourceState } from "../cron/dews/source-state";
import { parseDayParam } from "./backfill-depegs-window";

interface DepegEvent {
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

const DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY = "dews:bootstrap-complete";
const DEWS_TRUST_REPAIR_WINDOW_START_DAY = 1_773_014_400; // 2026-03-09T00:00:00Z (live $1M DEX trust floor launch)
const HISTORY_SAMPLE_LIMIT = 50;

function getTodayMidnightUtcSec(nowSec = Math.floor(Date.now() / 1000)): number {
  return Math.floor(nowSec / DAY_SECONDS) * DAY_SECONDS;
}

function parseRepairMode(raw: string | null): DewsRepairMode | null {
  if (raw === "refresh-current" || raw === "prune-history") {
    return raw;
  }
  return null;
}

async function buildRefreshPreview(db: D1Database): Promise<DewsRefreshPreview | Response> {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
  if (stablecoinsCache.kind !== "ok") {
    return errorResponse(503, `DEWS refresh preview unavailable: stablecoins cache ${stablecoinsCache.reason}`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const bootstrapPending = (await getCache(db, DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY)) == null;
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

  const assetById = new Map(stablecoinsCache.payload.peggedAssets.map((asset) => [asset.id, asset]));
  const { rates: pegRates } = derivePegRates(
    stablecoinsCache.payload.peggedAssets,
    PSI_ELIGIBLE_META_BY_ID,
    stablecoinsCache.payload.fxFallbackRates,
  );
  const sourceState = await loadDewsSourceState({
    db,
    nowSec,
    bootstrapPending,
    registerSourceFailure,
    registerMalformedPersistedInput,
  });
  const { results, insufficientDataCount } = buildDewsScoringResult({
    assetById,
    pegRates,
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
    sourceCoverage: sourceState.sourceCoverage,
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
    ? resolveOrReject(stablecoinParam)
    : null;
  if (resolvedStablecoin instanceof Response) {
    return resolvedStablecoin;
  }
  const stablecoinId = resolvedStablecoin?.canonicalId ?? null;

  const startDayRaw = url.searchParams.get("startDay");
  const endDayRaw = url.searchParams.get("endDay");
  const parsedStartDay = parseDayParam(startDayRaw);
  const parsedEndDay = parseDayParam(endDayRaw);
  if (startDayRaw && parsedStartDay == null) {
    return errorResponse(400, "Invalid startDay. Use Unix seconds/milliseconds or YYYY-MM-DD.");
  }
  if (endDayRaw && parsedEndDay == null) {
    return errorResponse(400, "Invalid endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.");
  }

  const todayMidnight = getTodayMidnightUtcSec();
  const startDay = parsedStartDay ?? DEWS_TRUST_REPAIR_WINDOW_START_DAY;
  const endDay = parsedEndDay ?? todayMidnight;
  if (startDay > endDay) {
    return errorResponse(400, "Invalid startDay/endDay: startDay must be <= endDay.");
  }

  const candidates = await queryHistoryCandidates(db, stablecoinId, startDay, endDay);
  const boundaryBefore = await queryHistoryBoundary(db, stablecoinId, endDay);

  const responseBody: Record<string, unknown> = {
    repair: "prune-history",
    dryRun,
    stablecoinId,
    startDay,
    endDay,
    usedDefaultWindow: parsedStartDay == null && parsedEndDay == null,
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
    .all<DepegEvent>();

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
      const dayMidnight = Math.floor(targetDay / DAY_SECONDS) * DAY_SECONDS;

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

export function handleBackfillDEWS(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "backfill-dews",
      request,
      trustedAdmin,
    },
    async () => {
      const method = request?.method ?? "GET";
      const dryRun = url.searchParams.get("dry-run") === "true";
      const repairModeRaw = url.searchParams.get("repair");
      const repairMode = parseRepairMode(repairModeRaw);

      if (repairModeRaw && repairMode == null) {
        return errorResponse(400, `Unsupported repair mode: ${repairModeRaw}`);
      }

      if (method === "GET") {
        if (repairMode) {
          if (!dryRun) {
            return new Response(
              JSON.stringify({
                error: "Method not allowed. GET supports repair previews only with dry-run=true; use POST for DEWS repair mutations.",
              }),
              { status: 405, headers: { "Content-Type": "application/json", Allow: "POST" } },
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
