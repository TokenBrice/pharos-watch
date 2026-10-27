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
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
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

function yieldMethodologyVersionAt(rawInputs: string | null | undefined, timestamp: number): string {
  if (rawInputs) {
    try {
      const inputs: unknown = JSON.parse(rawInputs);
      if (inputs && typeof inputs === "object" && "methodologyVersion" in inputs
        && typeof inputs.methodologyVersion === "string" && inputs.methodologyVersion.length > 0) {
        return inputs.methodologyVersion;
      }
    } catch {
      // Older history may not retain readable publication inputs.
    }
  }
  return getMethodologyVersionAt("yield", timestamp);
}

type WarningEvidence =
  | { status: "valid-empty" | "valid-signals"; signals: string[] }
  | { status: "unavailable"; reason: "malformed-json" | "non-array" | "invalid-member" };

type WarningBaseline =
  | { status: "no-history" }
  | { status: "usable"; signals: string[] }
  | { status: "unavailable" };

function decodeWarningEvidence(raw: string | null | undefined): WarningEvidence {
  // The producer persists SQL NULL when its observed signal list is empty.
  if (raw === null) return { status: "valid-empty", signals: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    return { status: "unavailable", reason: "malformed-json" };
  }
  if (!Array.isArray(parsed)) return { status: "unavailable", reason: "non-array" };
  const members: unknown[] = parsed;
  const signals: string[] = [];
  for (const value of members) {
    if (typeof value !== "string" || value.length === 0) return { status: "unavailable", reason: "invalid-member" };
    signals.push(value);
  }
  return { status: signals.length === 0 ? "valid-empty" : "valid-signals", signals };
}

interface WarningDegradation {
  record(row: YieldHistoryRow, reason: Extract<WarningEvidence, { status: "unavailable" }>["reason"]): void;
  report(): void;
}

function warningDegradation(): WarningDegradation {
  const counts: Partial<Record<Extract<WarningEvidence, { status: "unavailable" }>["reason"], number>> = {};
  const samples: Array<{ coinId: string; recordedAt: number; reason: string }> = [];
  return {
    record(row: YieldHistoryRow, reason: Extract<WarningEvidence, { status: "unavailable" }>["reason"]) {
      counts[reason] = (counts[reason] ?? 0) + 1;
      if (samples.length < 10) samples.push({ coinId: row.stablecoin_id, recordedAt: row.recorded_at, reason });
    },
    report() {
      if (samples.length > 0) {
        console.warn("[tape:yield.warning_emitted]", {
          reason: "warning-evidence-unavailable", counts, samples,
        });
      }
    },
  };
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
  pys_inputs_at_publish?: string | null;
}

async function fetchYieldHistorySince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<YieldHistoryRow[]> {
  return fetchRowsWithTieExpansion<YieldHistoryRow>(db, {
    selectSql: "SELECT stablecoin_id, source_key, recorded_at, warning_signals, pys_inputs_at_publish",
    fromSql: "yield_history",
    timePredicatePrefix: "is_best = 1 AND ",
    timeColumn: "recorded_at",
    orderBySql: "recorded_at ASC, stablecoin_id ASC, source_key ASC",
    since,
    until,
    limit,
    getTime: (row) => row.recorded_at,
  });
}

/**
 * Fetch the most recent usable best-source warning_signals at-or-before `since` for
 * each coin appearing in the batch, used to seed the per-coin diff for the
 * first sample of each coin in this run. Two rows can share a `recorded_at`
 * (one publication per source key), so the pick is tie-broken on `source_key`
 * (C21) rather than left to result order.
 */
async function fetchPriorWarningSignals(
  db: D1Database,
  coinIds: string[],
  since: number,
  degradation: WarningDegradation,
): Promise<Map<string, WarningBaseline>> {
  const map = new Map<string, WarningBaseline>();
  if (coinIds.length === 0 || since <= 0) return map;
  for (const chunk of chunkArray([...new Set(coinIds)])) {
    const inClause = buildInClause(chunk);
    const rows = await db
      .prepare(
        `SELECT h.stablecoin_id, h.source_key, h.recorded_at, h.warning_signals
           FROM (SELECT DISTINCT stablecoin_id FROM yield_history WHERE stablecoin_id IN (${inClause.sql})) c
           JOIN yield_history h ON h.rowid = (
             SELECT h.rowid FROM yield_history h
              WHERE h.stablecoin_id = c.stablecoin_id
                AND h.is_best = 1 AND h.recorded_at <= ?
              ORDER BY h.recorded_at DESC, h.source_key DESC LIMIT 1)`,
      )
      .bind(...inClause.binds, since)
      .all<YieldHistoryRow>();
    for (const row of rows.results ?? []) {
      map.set(row.stablecoin_id, { status: "unavailable" });
      let candidate: YieldHistoryRow | null = row;
      while (candidate) {
        const evidence = decodeWarningEvidence(candidate.warning_signals);
        if (evidence.status !== "unavailable") {
          map.set(row.stablecoin_id, { status: "usable", signals: evidence.signals });
          break;
        }
        degradation.record(candidate, evidence.reason);
        // Seek backwards only for corrupt observations, including same-time ties.
        // The same decoder owns seeding and walking; no SQL JSON approximation.
        candidate = await db.prepare(
          `SELECT stablecoin_id, source_key, recorded_at, warning_signals
             FROM yield_history
            WHERE stablecoin_id = ? AND is_best = 1
              AND (recorded_at, source_key) < (?, ?)
            ORDER BY recorded_at DESC, source_key DESC LIMIT 1`,
        ).bind(row.stablecoin_id, candidate.recorded_at, candidate.source_key).first<YieldHistoryRow>();
      }
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
      ? a.recorded_at - b.recorded_at || (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0)
      : a.stablecoin_id.localeCompare(b.stablecoin_id)
  ));
  const distinctCoinIds = Array.from(new Set(rows.map((r) => r.stablecoin_id)));
  const degradation = warningDegradation();
  const priorByCoin = await fetchPriorWarningSignals(db, distinctCoinIds, since, degradation);

  const events: TapeEventInsert[] = [];
  let maxCursor = since;

  // Walk per-coin and emit when net-new signals appear vs. the running snapshot.
  let currentCoin: string | null = null;
  let predecessor: WarningBaseline = { status: "no-history" };
  for (const row of rows) {
    if (row.stablecoin_id !== currentCoin) {
      currentCoin = row.stablecoin_id;
      predecessor = priorByCoin.get(currentCoin) ?? { status: "no-history" };
    }
    if (row.recorded_at > maxCursor) maxCursor = row.recorded_at;

    const evidence = decodeWarningEvidence(row.warning_signals);
    if (evidence.status === "unavailable") {
      degradation.record(row, evidence.reason);
      if (predecessor.status === "no-history") predecessor = { status: "unavailable" };
      continue;
    }
    const currentSignals = evidence.signals;
    if (predecessor.status === "unavailable") {
      // An observed warning after an unknown prefix establishes state, not motion.
      predecessor = { status: "usable", signals: currentSignals };
      continue;
    }
    const prevSignals = predecessor.status === "usable" ? predecessor.signals : [];
    if (currentSignals.length === 0) {
      predecessor = { status: "usable", signals: currentSignals };
      continue;
    }

    const prevSet = new Set(prevSignals);
    const newSignals = currentSignals.filter((signal) => !prevSet.has(signal));
    if (newSignals.length === 0) {
      predecessor = { status: "usable", signals: currentSignals };
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
      methodologyVersion: yieldMethodologyVersionAt(row.pys_inputs_at_publish, row.recorded_at),
    });

    predecessor = { status: "usable", signals: currentSignals };
  }

  degradation.report();
  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey, options });
}

// --- yield.pys_dropped ------------------------------------------------------

interface YieldDecisionRow {
  stablecoin_id: string;
  selected_source_key: string;
  selected_score: number | null;
  created_at: number;
  pys_inputs_at_publish?: string | null;
}

async function fetchYieldDecisionsSince(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
): Promise<YieldDecisionRow[]> {
  return fetchRowsWithTieExpansion<YieldDecisionRow>(db, {
    selectSql: `SELECT d.stablecoin_id, d.selected_source_key, d.selected_score, d.created_at,
      (SELECT h.pys_inputs_at_publish FROM yield_history h
        WHERE h.publication_generation_id = d.generation_id
          AND h.stablecoin_id = d.stablecoin_id AND h.source_key = d.selected_source_key
        ORDER BY h.recorded_at DESC LIMIT 1) AS pys_inputs_at_publish`,
    fromSql: "yield_source_decisions d",
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
        `SELECT c.stablecoin_id,
                (SELECT d.selected_score
                   FROM yield_source_decisions d
                  WHERE d.stablecoin_id = c.stablecoin_id
                    AND d.created_at <= ?
                    AND d.selected_score IS NOT NULL
                  ORDER BY d.created_at DESC, d.generation_id DESC
                  LIMIT 1) AS selected_score
           FROM (SELECT DISTINCT stablecoin_id FROM yield_source_decisions WHERE stablecoin_id IN (${inClause.sql})) c`,
      )
      .bind(since, ...inClause.binds)
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
        // E28: the headline arithmetic has to close. Rounding the endpoints and
        // the raw delta independently printed "82 → 74 (-7)"; the displayed drop
        // is the difference between the displayed endpoints. The raw delta still
        // drives the threshold, the severity band and the payload.
        const displayedDelta = prevRounded - newRounded;

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
          summary: `Published yield score dropped by ${displayedDelta} on selected source.`,
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
          methodologyVersion: yieldMethodologyVersionAt(row.pys_inputs_at_publish, row.created_at),
        });
      }
    }

    prevScore = newScore;
  }

  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey, options });
}
