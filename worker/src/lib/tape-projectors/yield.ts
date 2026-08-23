/**
 * yield.* projectors.
 *
 *   - yield.warning_emitted : a coin's best-source warning_signals transitions
 *                             from empty/null → non-empty, OR new signal(s)
 *                             appear that were not in the prior best-source
 *                             snapshot for the same coin. Source: yield_history
 *                             rows with is_best = 1.
 *   - yield.pys_dropped     : a coin's published yield score on its selected
 *                             best source falls by >= PYS_DROP_THRESHOLD points
 *                             versus the previous publication generation.
 *                             Source: yield_source_decisions.
 *
 * Both are snapshot tables — yield_history and yield_source_decisions write one
 * row per coin per generation regardless of motion — so meaningful transitions
 * are computed in JS by joining each batch row to the immediately prior row
 * for the same coin (mirrors the dews projector pattern).
 *
 * Idempotency: sourceRowId encodes the source-row timestamp + event class,
 * which is unique per generation/coin, so re-runs are absorbed by the
 * tape_events (source_table, source_row_id, transition) unique index.
 */
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/yield-methodology";
import type { TapeEventSeverity } from "@shared/types/tape-event";

import { buildTapeEventId, deriveIssuerId } from "../tape-event-helpers";
import { buildInClause, chunkArray } from "../db";
import type { TapeEventInsert } from "../tape-event-types";
import {
  finalizeProjectorBatch,
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

// Signals that materially impair confidence in the published yield. Anything
// else (yield-spike, yield-divergence, reward-heavy) is a notice-level signal.
const SEVERE_WARNING_SIGNALS = new Set<string>([
  "negative-trend",
  "tvl-outflow",
  "zero-yield",
  "data-stale",
  "stale-source",
]);

/**
 * PYS is on a 0-100 scale. A 10-point drop is large enough to register as
 * material motion (typically a sub-tier change in the underlying inputs) while
 * still emitting at most a handful of events per coin per week given the
 * publication cadence.
 */
const PYS_DROP_THRESHOLD = 10;

function coinSourceUrl(coinId: string): string {
  return `/stablecoin/${encodeURIComponent(coinId)}/yield/`;
}

function symbolFor(coinId: string): string {
  return TRACKED_META_BY_ID.get(coinId)?.symbol ?? coinId;
}

function parseSignals(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function severityForWarningSignals(signals: string[]): TapeEventSeverity {
  return signals.some((signal) => SEVERE_WARNING_SIGNALS.has(signal)) ? "warning" : "notice";
}

function severityForPysDrop(delta: number): TapeEventSeverity {
  // delta is positive (prev - new).
  if (delta >= 40) return "severe";
  if (delta >= 20) return "warning";
  return "notice";
}

// --- yield.warning_emitted --------------------------------------------------

interface YieldHistoryRow {
  stablecoin_id: string;
  source_key: string;
  recorded_at: number;
  warning_signals: string | null;
}

async function fetchYieldHistorySince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<YieldHistoryRow[]> {
  return fetchRowsWithTieExpansion<YieldHistoryRow>(db, {
    selectSql: "SELECT stablecoin_id, source_key, recorded_at, warning_signals",
    fromSql: "yield_history",
    timePredicatePrefix: "is_best = 1 AND ",
    timeColumn: "recorded_at",
    orderBySql: "recorded_at ASC, stablecoin_id ASC",
    since,
    until,
    limit,
    getTime: (row) => row.recorded_at,
  });
}

/**
 * Fetch the most recent best-source warning_signals at-or-before `since` for
 * each coin appearing in the batch, used to seed the per-coin diff for the
 * first sample of each coin in this run.
 */
async function fetchPriorWarningSignals(
  db: D1Database,
  coinIds: string[],
  since: number,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (coinIds.length === 0 || since <= 0) return map;
  for (const chunk of chunkArray([...new Set(coinIds)])) {
    const inClause = buildInClause(chunk);
    const rows = await db
      .prepare(
        `SELECT yh.stablecoin_id, yh.warning_signals
           FROM yield_history yh
           INNER JOIN (
             SELECT stablecoin_id, MAX(recorded_at) as max_at
             FROM yield_history
             WHERE stablecoin_id IN (${inClause.sql})
               AND is_best = 1
               AND recorded_at <= ?
             GROUP BY stablecoin_id
           ) latest
             ON yh.stablecoin_id = latest.stablecoin_id
            AND yh.recorded_at = latest.max_at
          WHERE yh.is_best = 1`,
      )
      .bind(...inClause.binds, since)
      .all<{ stablecoin_id: string; warning_signals: string | null }>();
    for (const row of rows.results ?? []) {
      map.set(row.stablecoin_id, parseSignals(row.warning_signals));
    }
  }
  return map;
}

export async function projectYieldWarningEmitted(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const cursorKey = "yield.warning_emitted";
  const { since, until, limit } = await resolveProjectorOptions(db, cursorKey, options);

  const rows = await fetchYieldHistorySince(db, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };

  rows.sort((a, b) => (
    a.stablecoin_id === b.stablecoin_id
      ? a.recorded_at - b.recorded_at
      : a.stablecoin_id.localeCompare(b.stablecoin_id)
  ));
  const distinctCoinIds = Array.from(new Set(rows.map((r) => r.stablecoin_id)));
  const priorByCoin = await fetchPriorWarningSignals(db, distinctCoinIds, since);

  const events: TapeEventInsert[] = [];
  let maxCursor = since;

  // Walk per-coin and emit when net-new signals appear vs. the running snapshot.
  let currentCoin: string | null = null;
  let prevSignals: string[] = [];
  for (const row of rows) {
    if (row.stablecoin_id !== currentCoin) {
      currentCoin = row.stablecoin_id;
      prevSignals = priorByCoin.get(currentCoin) ?? [];
    }
    if (row.recorded_at > maxCursor) maxCursor = row.recorded_at;

    const currentSignals = parseSignals(row.warning_signals);
    if (currentSignals.length === 0) {
      prevSignals = currentSignals;
      continue;
    }

    const prevSet = new Set(prevSignals);
    const newSignals = currentSignals.filter((signal) => !prevSet.has(signal));
    if (newSignals.length === 0) {
      prevSignals = currentSignals;
      continue;
    }

    const symbol = symbolFor(row.stablecoin_id);
    const tsMs = row.recorded_at * 1000;
    const transition = "opened";
    const type = "yield.warning_emitted";
    const sourceRowId = `${row.stablecoin_id}:${row.recorded_at}:warning`;
    const severity = severityForWarningSignals(newSignals);
    const signalLabel = newSignals.join(", ");

    events.push({
      eventId: buildTapeEventId({
        tsMs,
        type,
        sourceTable: "yield_history",
        sourceRowId,
        transition,
      }),
      type,
      severity,
      ts: tsMs,
      endsAt: null,
      coinId: row.stablecoin_id,
      issuerId: deriveIssuerId(row.stablecoin_id),
      pegCurrency: null,
      chain: null,
      title: `${symbol} yield warning: ${signalLabel}`,
      summary: prevSignals.length === 0
        ? `New yield warning signal${newSignals.length > 1 ? "s" : ""} (${signalLabel}) detected on selected source.`
        : `Additional yield warning signal${newSignals.length > 1 ? "s" : ""} (${signalLabel}) added to selected source.`,
      payload: {
        signals: currentSignals,
        prevSignals,
        newSignals,
        sourceKey: row.source_key,
      },
      sourceTable: "yield_history",
      sourceRowId,
      transition,
      sourceUrl: coinSourceUrl(row.stablecoin_id),
      methodologyVersion: YIELD_METHODOLOGY_VERSION,
    });

    prevSignals = currentSignals;
  }

  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey, options });
}

// --- yield.pys_dropped ------------------------------------------------------

interface YieldDecisionRow {
  stablecoin_id: string;
  selected_source_key: string;
  selected_score: number | null;
  created_at: number;
}

async function fetchYieldDecisionsSince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<YieldDecisionRow[]> {
  return fetchRowsWithTieExpansion<YieldDecisionRow>(db, {
    selectSql: "SELECT stablecoin_id, selected_source_key, selected_score, created_at",
    fromSql: "yield_source_decisions",
    timeColumn: "created_at",
    orderBySql: "created_at ASC, stablecoin_id ASC",
    since,
    until,
    limit,
    getTime: (row) => row.created_at,
  });
}

async function fetchPriorPysScores(
  db: D1Database,
  coinIds: string[],
  since: number,
): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (coinIds.length === 0 || since <= 0) return map;
  for (const chunk of chunkArray([...new Set(coinIds)])) {
    const inClause = buildInClause(chunk);
    const rows = await db
      .prepare(
        `SELECT ysd.stablecoin_id, ysd.selected_score
           FROM yield_source_decisions ysd
           INNER JOIN (
             SELECT stablecoin_id, MAX(created_at) as max_at
             FROM yield_source_decisions
             WHERE stablecoin_id IN (${inClause.sql})
               AND created_at <= ?
             GROUP BY stablecoin_id
           ) latest
             ON ysd.stablecoin_id = latest.stablecoin_id
            AND ysd.created_at = latest.max_at`,
      )
      .bind(...inClause.binds, since)
      .all<{ stablecoin_id: string; selected_score: number | null }>();
    for (const row of rows.results ?? []) {
      const score = row.selected_score;
      map.set(row.stablecoin_id, score != null && Number.isFinite(score) ? score : null);
    }
  }
  return map;
}

export async function projectYieldPysDropped(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const cursorKey = "yield.pys_dropped";
  const { since, until, limit } = await resolveProjectorOptions(db, cursorKey, options);

  const rows = await fetchYieldDecisionsSince(db, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };

  rows.sort((a, b) => (
    a.stablecoin_id === b.stablecoin_id
      ? a.created_at - b.created_at
      : a.stablecoin_id.localeCompare(b.stablecoin_id)
  ));
  const distinctCoinIds = Array.from(new Set(rows.map((r) => r.stablecoin_id)));
  const priorByCoin = await fetchPriorPysScores(db, distinctCoinIds, since);

  const events: TapeEventInsert[] = [];
  let maxCursor = since;

  let currentCoin: string | null = null;
  let prevScore: number | null = null;
  for (const row of rows) {
    if (row.stablecoin_id !== currentCoin) {
      currentCoin = row.stablecoin_id;
      prevScore = priorByCoin.get(currentCoin) ?? null;
    }
    if (row.created_at > maxCursor) maxCursor = row.created_at;

    const newScore = row.selected_score;
    if (newScore == null || !Number.isFinite(newScore)) {
      // Carry prevScore unchanged — a null score does not reset the baseline.
      continue;
    }

    if (prevScore != null) {
      const delta = prevScore - newScore;
      if (delta >= PYS_DROP_THRESHOLD) {
        const symbol = symbolFor(row.stablecoin_id);
        const tsMs = row.created_at * 1000;
        const transition = "updated";
        const type = "yield.pys_dropped";
        const sourceRowId = `${row.stablecoin_id}:${row.created_at}:pys`;
        const severity = severityForPysDrop(delta);
        const prevRounded = Math.round(prevScore);
        const newRounded = Math.round(newScore);

        events.push({
          eventId: buildTapeEventId({
            tsMs,
            type,
            sourceTable: "yield_source_decisions",
            sourceRowId,
            transition,
          }),
          type,
          severity,
          ts: tsMs,
          endsAt: null,
          coinId: row.stablecoin_id,
          issuerId: deriveIssuerId(row.stablecoin_id),
          pegCurrency: null,
          chain: null,
          title: `${symbol} yield score ${prevRounded} → ${newRounded}`,
          summary: `Published yield score dropped by ${Math.round(delta)} on selected source.`,
          payload: {
            prevScore,
            newScore,
            delta,
            sourceKey: row.selected_source_key,
          },
          sourceTable: "yield_source_decisions",
          sourceRowId,
          transition,
          sourceUrl: coinSourceUrl(row.stablecoin_id),
          methodologyVersion: YIELD_METHODOLOGY_VERSION,
        });
      }
    }

    prevScore = newScore;
  }

  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey, options });
}
