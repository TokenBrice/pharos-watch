import { admittedDepegOnset, type DepegTransitionEvidence } from "../lib/tape-projectors/depeg";
import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { BRZ_UNVERIFIED_PEAK_EVENT_IDS } from "@shared/data/depegs/backfill-replay-suppressions";
import { isDewsAlertBand, isThreatBand } from "@shared/lib/classification";
import { isDdrIneligibleAuditVerdict } from "@shared/lib/depeg-audit";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { resolvePsiInclusiveStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { percentileNearestRank } from "@shared/lib/stats";
import { hasComparableSupplyPerimeter, hasNativeSupplyEvidence, isMissingNativeSupplyColumn, readNativeSupplyCheckpoint, type NativeSupplyHistoryRow } from "../lib/dews/native-quantity";
import { parseDexVolumeAvailabilityRecord } from "@shared/lib/dex-volume-availability";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { errorResponse, jsonResponse, methodNotAllowedResponse } from "../lib/api-response";
import { BACKTEST_ANCHORS, BACKTEST_NEGATIVE_CONTROLS } from "../lib/backtest-anchors";
import { BACKTEST_LOOKBACK_DAYS } from "../lib/backtest-anchors";
import { computeHistoricalDEWS } from "../lib/dews";
import type { HistoricalDEWSInput } from "../lib/dews";
import { assembleDewsScoringInput } from "../lib/dews/input-assembly";
import { buildDewsScoringResult } from "../lib/dews/scoring";
import type {
  MalformedPersistedInput,
  PersistedJsonDecodeReason,
  SourceFailure,
} from "../lib/dews/contracts";
import { malformedInputDegradesRun } from "../lib/dews/malformed-input";
import { computeAndStoreDEWS } from "../lib/dews/service";
import { getDexLiquidityTrendTolerances, getDexTvlObservedAt, selectLiquidityObservation, selectObservedTrendBaseline } from "../lib/dex-liquidity-response";
import type { DexHistoryRow } from "../lib/dex-liquidity-response";
import { parseOptionalDayWindow } from "../lib/backfill-day-window";
import { EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL } from "../lib/depeg-event-projection";

interface DepegEventRow extends DepegTransitionEvidence {
  peak_deviation_bps: number | null;
  provenance_audit_verdict?: string | null;
  incident_key: string | null;
  is_effective: number;
  reviewed_dispute?: number;
}

interface EventResult {
  stablecoinId: string;
  startedAt: number;
  peakBps: number | null;
  preDepegScores: { daysBeforeDepeg: number; score: number; band: string }[];
  predicted: boolean | null;
  evaluation: {
    availability: "available" | "partial" | "unavailable";
    reasons: string[];
    evaluatedPreDepegDays: number;
    expectedPreDepegDays: number;
  };
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
  ): void => {
    sourceFailures.push({
      source,
      reason: String(error),
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
      reason: options.reason,
      degradesRun: malformedInputDegradesRun(options.degradesRun, options.stablecoinId),
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
    nowSec,
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

function isIneligibleBacktestEvent(event: DepegEventRow): boolean {
  return event.reviewed_dispute === 1 || isDdrIneligibleAuditVerdict(event.provenance_audit_verdict)
    || (event.disposition === "repaired" && event.admitted_coverage_json === "[]");
}

function historicalBacktestResponse(
  results: EventResult[],
  excludedTargets: { auditIneligible: number; onsetUnavailable: number },
): Response {
  const evaluableEvents = results.filter((result) => result.predicted !== null).length;
  const detections = results.filter((result) => result.predicted === true);
  const leadTimes = detections.flatMap(({ leadTimeDays }) => leadTimeDays == null ? [] : [leadTimeDays]);
  const avgLeadTimeDays = leadTimes.length === 0 ? null
    : Math.round(leadTimes.reduce((sum, days) => sum + days, 0) / leadTimes.length * 10) / 10;
  return jsonResponse({
    summary: {
      totalEvents: results.length,
      evaluableEvents,
      excludedEvents: results.length - evaluableEvents,
      excludedTargets,
      partialEvents: results.filter((result) => result.evaluation.availability === "partial").length,
      truePositives: detections.length,
      tpRate: evaluableEvents === 0 ? null : `${Math.round(detections.length / evaluableEvents * 100)}%`,
      avgLeadTimeDays,
      note: "Backtest uses supply_history + dex_liquidity_history only. Pool balance, price confidence, blacklist, and flow signals are unavailable for historical data.",
    },
    events: results,
  });
}

async function handleHistoricalBacktest(db: D1Database): Promise<Response> {
  const selectEvents = (withPeerReceipt: boolean) => db
    .prepare(
      `SELECT events.id, events.stablecoin_id, events.started_at, events.ended_at, events.peak_deviation_bps,
              events.start_price, events.peg_reference, events.direction,
              ${withPeerReceipt ? "events.peer_basis_json," : ""}
              events.peg_type, events.provenance_audit_verdict,
              events.admitted_coverage_json, events.disposition, events.confirmation_sources, events.pending_reason,
              events.price_coverage_json, events.last_trusted_price_at, events.price_coverage_gap_started_at, canonical.incident_key,
              ${reviewedDepegDisputeSql("events")} AS reviewed_dispute,
              ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL} AS is_effective
         FROM depeg_events_with_provenance events
         LEFT JOIN depeg_resolver_incident_event_links link ON link.event_id = events.id
         LEFT JOIN depeg_resolver_incidents owner ON owner.incident_key = link.incident_key
         LEFT JOIN depeg_resolver_incidents canonical
           ON canonical.incident_key = COALESCE(owner.superseded_by_incident_key, owner.incident_key)
          AND canonical.incident_state = 'active'
        WHERE ended_at IS NOT NULL OR canonical.incident_key IS NOT NULL
        ORDER BY events.started_at ASC, events.id ASC`,
    )
    .all<DepegEventRow>();

  const events = await selectEvents(true).catch((error: unknown) => {
    if (error instanceof Error && /no such column: events\.peer_basis_json\b/i.test(error.message)) return selectEvents(false);
    throw error;
  });

  const completed = events.results.filter((event) => event.ended_at != null && event.is_effective !== 0);
  if (completed.length === 0) {
    return errorResponse(404, "No completed depeg events found");
  }

  const firstAdmittedByIncident = new Map<string, number>();
  const ineligibleIncidents = new Set<string>();
  for (const event of events.results) {
    if (event.incident_key == null) continue;
    if (isIneligibleBacktestEvent(event)) {
      ineligibleIncidents.add(event.incident_key);
      continue;
    }
    const onset = admittedDepegOnset(event);
    const firstOnset = firstAdmittedByIncident.get(event.incident_key);
    if (onset != null && (firstOnset == null || onset < firstOnset)) {
      firstAdmittedByIncident.set(event.incident_key, onset);
    }
  }

  const excludedTargets = { auditIneligible: 0, onsetUnavailable: 0 };
  const targets = completed.flatMap((event) => {
    if (isIneligibleBacktestEvent(event)
      || (event.incident_key != null && ineligibleIncidents.has(event.incident_key))) {
      excludedTargets.auditIneligible++;
      return [];
    }
    const onset = event.incident_key == null
      ? admittedDepegOnset(event) : firstAdmittedByIncident.get(event.incident_key);
    if (onset == null || onset > event.ended_at!) {
      excludedTargets.onsetUnavailable++;
      return [];
    }
    const peakUnverified = event.stablecoin_id === "brz-transfero"
      && (BRZ_UNVERIFIED_PEAK_EVENT_IDS as readonly number[]).includes(event.id);
    return [{ stablecoin_id: event.stablecoin_id, started_at: onset,
      peak_deviation_bps: peakUnverified ? null : event.peak_deviation_bps }];
  }).sort((left, right) => left.started_at - right.started_at);

  const firstTarget = targets[0];
  const lastTarget = targets[targets.length - 1];
  if (!firstTarget || !lastTarget) return historicalBacktestResponse([], excludedTargets);

  const historyStartDay = bucketUnixSecondsToUtcDay(firstTarget.started_at) - 14 * DAY_SECONDS;
  const historyEndDay = bucketUnixSecondsToUtcDay(lastTarget.started_at) + 2 * DAY_SECONDS;
  const liquidityTolerance = getDexLiquidityTrendTolerances().week;
  const liquidityHistoryStart = historyStartDay - liquidityTolerance - DAY_SECONDS;
  type SupplyRow = NativeSupplyHistoryRow & { circulating_usd: number };
  const readSupply = (native: boolean) => db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, circulating_usd${native ? ", circulating_native, supply_provenance" : ""}
       FROM supply_history
       WHERE snapshot_date BETWEEN ? AND ?
       ORDER BY snapshot_date ASC`,
    )
    .bind(historyStartDay, historyEndDay)
    .all<SupplyRow>();
  const supplyRows = await readSupply(true).catch((error: unknown) => {
    if (!isMissingNativeSupplyColumn(error)) throw error;
    return readSupply(false);
  });

  const supplyIndex = new Map<string, Map<number, SupplyRow>>();
  for (const row of supplyRows.results) {
    const history = supplyIndex.get(row.stablecoin_id) ?? new Map<number, SupplyRow>();
    history.set(row.snapshot_date, row);
    supplyIndex.set(row.stablecoin_id, history);
  }

  const liqRows = await db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, liquidity_score, total_tvl_usd, volume_availability_json, coverage_class, coverage_confidence, methodology_version
       FROM dex_liquidity_history
       WHERE snapshot_date BETWEEN ? AND ?
       ORDER BY snapshot_date ASC`,
    )
    .bind(liquidityHistoryStart, historyEndDay)
    .all<{
      stablecoin_id: string;
      snapshot_date: number;
      liquidity_score: number | null;
      total_tvl_usd: number | null;
      volume_availability_json?: string | null;
      coverage_confidence: number | null;
      coverage_class: string | null;
      methodology_version: string | null;
    }>();

  const liqIndex = new Map<string, (DexHistoryRow & { liquidity_score: number | null; observedTvl: number | null })[]>();
  for (const row of liqRows.results) {
    if (!liqIndex.has(row.stablecoin_id)) liqIndex.set(row.stablecoin_id, []);
    liqIndex.get(row.stablecoin_id)!.push({
      ...row,
      total_tvl_usd: row.total_tvl_usd ?? 0,
      observedTvl: row.total_tvl_usd,
    });
  }

  const results: EventResult[] = [];

  for (const event of targets) {
    const coinSupply = supplyIndex.get(event.stablecoin_id);
    const coinLiq = liqIndex.get(event.stablecoin_id) ?? [];
    const preDepegScores: EventResult["preDepegScores"] = [];
    let predicted = false;
    let leadTimeDays: number | null = null;
    let evaluatedPreDepegDays = 0;
    const evaluationReasons = new Set<string>();

    for (let d = 7; d >= 0; d--) {
      const targetDay = event.started_at - d * DAY_SECONDS;
      const dayMidnight = bucketUnixSecondsToUtcDay(targetDay);

      const currentRow = coinSupply?.get(dayMidnight);
      const mcapUsd = currentRow?.circulating_usd;
      const dayRow = coinSupply?.get(dayMidnight - DAY_SECONDS);
      const weekRow = coinSupply?.get(dayMidnight - 7 * DAY_SECONDS);
      const useNativeSupply = currentRow && hasNativeSupplyEvidence(currentRow);
      const current = useNativeSupply ? readNativeSupplyCheckpoint(currentRow, targetDay)?.quantity ?? null : mcapUsd ?? null;
      const anchor = (row: SupplyRow | undefined, days: number, native = useNativeSupply) => {
        if (!row || current == null || !hasComparableSupplyPerimeter(event.stablecoin_id, dayMidnight, row.snapshot_date)) return null;
        if (native) return readNativeSupplyCheckpoint(row, targetDay - days * DAY_SECONDS)?.quantity ?? null;
        return Number.isFinite(row.circulating_usd) && row.circulating_usd >= 0 ? row.circulating_usd : null;
      };
      const prevDay = anchor(dayRow, 1);
      const prevWeek = anchor(weekRow, 7);
      const legacySupplyUsd = useNativeSupply ? {
        day: hasNativeSupplyEvidence(dayRow) ? null : anchor(dayRow, 1, false),
        week: hasNativeSupplyEvidence(weekRow) ? null : anchor(weekRow, 7, false),
      } : undefined;
      const dayAvailable = prevDay != null || legacySupplyUsd?.day != null;
      const weekAvailable = prevWeek != null || legacySupplyUsd?.week != null;

      if (mcapUsd == null || !Number.isFinite(mcapUsd) || mcapUsd < 0) {
        if (d > 0) evaluationReasons.add("current-supply-unavailable");
        continue;
      }
      if (d > 0 && (!dayAvailable || !weekAvailable)) evaluationReasons.add("supply-anchor-unavailable");

      const liqNow = selectLiquidityObservation(coinLiq, dayMidnight, liquidityTolerance);
      const liq7dScore = selectLiquidityObservation(coinLiq, dayMidnight - 7 * DAY_SECONDS, liquidityTolerance);
      const capture = liqNow ? getDexTvlObservedAt(
        parseDexVolumeAvailabilityRecord(liqNow.volume_availability_json), targetDay,
      ) : null;
      const liq7d = liqNow
        ? selectObservedTrendBaseline(coinLiq, capture, 7 * DAY_SECONDS, liquidityTolerance, liqNow.methodology_version)
        : null;

      const input: HistoricalDEWSInput = {
        stablecoinId: event.stablecoin_id,
        mcapUsd,
        circulatingCurrent: current,
        circulatingPrevDay: prevDay,
        circulatingPrevWeek: prevWeek,
        legacySupplyUsd,
        circulatingPrevDayAvailable: dayAvailable,
        circulatingPrevWeekAvailable: weekAvailable,
        liquidityScore: liqNow?.liquidity_score ?? null,
        liquidityScore7dAgo: liq7dScore?.liquidity_score ?? null,
        tvlCurrent: capture == null ? null : liqNow?.observedTvl ?? null,
        tvl7dAgo: liq7d?.total_tvl_usd ?? null,
      };

      const result = computeHistoricalDEWS(input);
      if (!result) {
        if (d > 0) evaluationReasons.add("insufficient-signal-evidence");
        continue;
      }
      if (d > 0) evaluatedPreDepegDays++;
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

    results.push({
      stablecoinId: event.stablecoin_id,
      startedAt: event.started_at,
      peakBps: event.peak_deviation_bps,
      preDepegScores,
      predicted: evaluatedPreDepegDays > 0 ? predicted : null,
      evaluation: {
        availability: evaluatedPreDepegDays === 0 ? "unavailable"
          : evaluatedPreDepegDays < 7 || evaluationReasons.size > 0 ? "partial" : "available",
        reasons: [...evaluationReasons],
        evaluatedPreDepegDays,
        expectedPreDepegDays: 7,
      },
      leadTimeDays,
    });
  }

  return historicalBacktestResponse(results, excludedTargets);
}

interface BacktestMetricsPerAnchor {
  stablecoinId: string;
  onsetAt: number;
  detected: boolean | null;
  leadTimeDays: number | null;
  firstAlertBand: string | null;
  alertDays: number;
  bandTransitions: number;
  pegType: string | null;
  evaluation: BacktestWindowEvaluation;
}

interface BacktestWindowEvaluation {
  availability: "available" | "partial" | "unavailable";
  reasons: string[];
  observedDays: number;
  expectedDays: number;
}

async function readBacktestWindow(db: D1Database, stablecoinId: string, windowStart: number, windowEnd: number) {
  const rows = await db
    .prepare(
      "SELECT snapshot_date, score, band FROM stress_signal_history WHERE stablecoin_id = ? AND snapshot_date >= ? AND snapshot_date <= ? ORDER BY snapshot_date ASC",
    )
    .bind(stablecoinId, windowStart, windowEnd)
    .all<{ snapshot_date: number; score: number; band: string }>();
  // Daily history is sealed at UTC midnight; only midnights inside the exact
  // inclusive window are required (an intraday onset does not add a prior day).
  const firstDay = Math.ceil(windowStart / DAY_SECONDS) * DAY_SECONDS;
  const lastDay = bucketUnixSecondsToUtcDay(windowEnd);
  const expectedDays = Math.max(0, (lastDay - firstDay) / DAY_SECONDS + 1);
  const observations = rows.results.filter((row) =>
    row.snapshot_date % DAY_SECONDS === 0 &&
    Number.isFinite(row.score) && row.score >= 0 && row.score <= 100 &&
    isThreatBand(row.band),
  );
  const observedDays = observations.length; // Primary key guarantees one row per coin/day.
  const complete = expectedDays > 0 && observedDays === expectedDays;
  const evaluation: BacktestWindowEvaluation = {
    availability: complete ? "available" : observedDays > 0 ? "partial" : "unavailable",
    reasons: complete ? [] : [rows.results.length === 0 ? "history-unavailable" : "incomplete-daily-history"],
    observedDays,
    expectedDays,
  };
  return { alertRows: observations.filter((row) => isDewsAlertBand(row.band)), evaluation };
}

async function handleBacktestMetrics(db: D1Database): Promise<Response> {
  const perAnchor = await Promise.all(
    BACKTEST_ANCHORS.map(async (anchor): Promise<BacktestMetricsPerAnchor> => {
      const windowStart = anchor.onsetAt - BACKTEST_LOOKBACK_DAYS * DAY_SECONDS;
      const { alertRows, evaluation } = await readBacktestWindow(db, anchor.stablecoinId, windowStart, anchor.onsetAt);
      const row = alertRows[0] ?? null;
      const detected = evaluation.availability === "available" ? row != null : null;
      let bandTransitions = 0;
      for (let i = 1; i < alertRows.length; i++) {
        if (alertRows[i]?.band !== alertRows[i - 1]?.band) bandTransitions++;
      }
      return {
        stablecoinId: anchor.stablecoinId,
        onsetAt: anchor.onsetAt,
        detected,
        leadTimeDays: detected === true && row ? (anchor.onsetAt - row.snapshot_date) / DAY_SECONDS : null,
        firstAlertBand: row?.band ?? null,
        alertDays: alertRows.length,
        bandTransitions,
        evaluation,
        pegType: PSI_ELIGIBLE_META_BY_ID.get(anchor.stablecoinId)
          ? `pegged${PSI_ELIGIBLE_META_BY_ID.get(anchor.stablecoinId)!.flags.pegCurrency}`
          : null,
      };
    }),
  );

  const negativeControls = await Promise.all(
    BACKTEST_NEGATIVE_CONTROLS.map(async (control) => {
      const { alertRows, evaluation } = await readBacktestWindow(db, control.stablecoinId, control.windowStart, control.windowEnd);
      return {
        stablecoinId: control.stablecoinId,
        windowStart: control.windowStart,
        windowEnd: control.windowEnd,
        falsePositiveDays: evaluation.availability === "available" ? alertRows.length : null,
        firstAlertBand: alertRows[0]?.band ?? null,
        evaluation,
      };
    }),
  );

  const evaluable = perAnchor.filter((entry) => entry.detected !== null);
  const detected = evaluable.filter((entry) => entry.detected);
  const evaluableControls = negativeControls.filter((entry) => entry.falsePositiveDays !== null);
  const observedNegativeControlDays = evaluableControls.reduce((sum, entry) => sum + entry.evaluation.observedDays, 0);
  const falsePositiveDays = observedNegativeControlDays === 0
    ? null
    : evaluableControls.reduce((sum, entry) => sum + entry.falsePositiveDays!, 0);
  const leadTimes = detected.map((entry) => entry.leadTimeDays!);
  const byPegType: Record<string, { anchors: number; evaluableAnchors: number; detected: number; recall: number | null }> = {};
  for (const entry of perAnchor) {
    const key = entry.pegType ?? "unknown";
    const bucket = byPegType[key] ?? { anchors: 0, evaluableAnchors: 0, detected: 0, recall: null };
    bucket.anchors++;
    if (entry.detected !== null) bucket.evaluableAnchors++;
    if (entry.detected) bucket.detected++;
    bucket.recall = bucket.evaluableAnchors === 0 ? null : bucket.detected / bucket.evaluableAnchors;
    byPegType[key] = bucket;
  }
  const truePositives = detected.length;
  const falseNegativeIncidents = evaluable.length - truePositives;
  const precisionDenominator = falsePositiveDays === null ? null : truePositives + falsePositiveDays;
  const recall = evaluable.length === 0 ? null : truePositives / evaluable.length;

  return jsonResponse({
    detectionRate: recall,
    precision: precisionDenominator === null || precisionDenominator === 0 ? null : truePositives / precisionDenominator,
    precisionUnavailableReason: observedNegativeControlDays === 0
      ? "no-observed-negative-control-exposure"
      : precisionDenominator === 0 ? "no-positive-outcomes" : null,
    recall,
    evaluableAnchors: evaluable.length,
    excludedAnchors: perAnchor.length - evaluable.length,
    partialAnchors: perAnchor.filter((entry) => entry.evaluation.availability === "partial").length,
    falsePositiveDays,
    falseNegativeIncidents,
    leadTimeDaysP50: percentileNearestRank(leadTimes, 50),
    leadTimeDaysP90: percentileNearestRank(leadTimes, 90),
    alertChurn: {
      averageAlertDaysPerAnchor:
        evaluable.length === 0 ? null : evaluable.reduce((sum, entry) => sum + entry.alertDays, 0) / evaluable.length,
      bandTransitions: evaluable.length === 0 ? null : evaluable.reduce((sum, entry) => sum + entry.bandTransitions, 0),
    },
    cohortMetrics: {
      byPegType,
      negativeControlCount: BACKTEST_NEGATIVE_CONTROLS.length,
      evaluableNegativeControlCount: evaluableControls.length,
      observedNegativeControlDays,
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

export async function handleBackfillDEWS({
  db,
  url,
  request,
}: BackfillDewsRouteContext): Promise<Response> {
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
}
