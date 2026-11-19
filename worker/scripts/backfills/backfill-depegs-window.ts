import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { BRZ_UNVERIFIED_PEAK_EVENT_IDS } from "@shared/data/depegs/backfill-replay-suppressions";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { buildReplayWindow, MAX_BACKFILL_REPLAY_CONTEXT_DAYS, type BackfillReplayWindow } from "../../src/lib/backfill-day-window";

export interface DdrBackfillReplayConflict {
  eventId: number;
  incidentKey: string;
  /** Null for an unsealed incident member. */
  publicPredictionId: number | null;
}


export async function loadIncompleteBackfillReplayWindow(
  db: D1Database,
  stablecoinId: string,
): Promise<BackfillReplayWindow | null> {
  const row = await db
    .prepare(
      `SELECT status, start_day, end_day, context_days
       FROM depeg_backfill_runs
       WHERE stablecoin_id = ?
       ORDER BY started_at DESC, rowid DESC
       LIMIT 1`,
    )
    .bind(stablecoinId)
    .first<{
      status: string;
      start_day: number | null;
      end_day: number | null;
      context_days: number | null;
    }>();
  if (
    row?.status !== "incomplete" ||
    (row.start_day == null && row.end_day == null) ||
    row.context_days == null ||
    !Number.isInteger(row.context_days) ||
    row.context_days < 0 ||
    row.context_days > MAX_BACKFILL_REPLAY_CONTEXT_DAYS ||
    (row.start_day != null && !Number.isInteger(row.start_day)) ||
    (row.end_day != null && !Number.isInteger(row.end_day)) ||
    (row.start_day != null && row.end_day != null && row.start_day > row.end_day)
  ) {
    return null;
  }
  return buildReplayWindow(row.start_day, row.end_day, row.context_days);
}

export function timestampInReplayWindow(timestamp: number, replayWindow: BackfillReplayWindow | null): boolean {
  if (replayWindow?.replayStartSec != null && timestamp < replayWindow.replayStartSec) return false;
  if (replayWindow?.replayEndSec != null && timestamp > replayWindow.replayEndSec) return false;
  return true;
}

export function eventOverlapsReplayWindow(
  event: { startedAt: number; endedAt: number | null },
  replayWindow: BackfillReplayWindow | null,
): boolean {
  if (!replayWindow) return true;
  const eventEnd = event.endedAt ?? Infinity;
  if (replayWindow.compareStartSec != null && eventEnd < replayWindow.compareStartSec) return false;
  if (replayWindow.compareEndSec != null && event.startedAt > replayWindow.compareEndSec) return false;
  return true;
}

export function existingRowOverlapsReplayWindow(
  row: { started_at: number; ended_at: number | null },
  replayWindow: BackfillReplayWindow | null,
): boolean {
  return eventOverlapsReplayWindow({ startedAt: row.started_at, endedAt: row.ended_at }, replayWindow);
}

/**
 * Live-overlap dedupe: a recomputed backfill episode is the same market
 * episode as an existing `source='live'` row when both cover the same coin and
 * direction and their inclusive intervals share at least one second
 * (`episodeStart <= liveEnd && liveStart <= episodeEnd`). The two detectors
 * read the same price series at different granularities (live polls at minutes,
 * backfill consumes hourly samples), so overlapping windows of the same side
 * are one episode counted twice; the replay's delete already removes the stale
 * backfill twin, and this predicate keeps it from being re-inserted.
 */
export function backfillEpisodeCoveredByLiveEvent(
  episode: { startedAt: number; endedAt: number | null; direction: string },
  liveRow: { started_at: number; ended_at: number | null; direction: string },
): boolean {
  if (episode.startedAt === liveRow.started_at) return true;
  if (episode.direction !== liveRow.direction) return false;
  const episodeEnd = episode.endedAt ?? Infinity;
  const liveEnd = liveRow.ended_at ?? Infinity;
  return episode.startedAt <= liveEnd && liveRow.started_at <= episodeEnd;
}

// Incident event links are append-only: a deleted member event, sealed or not,
// leaves a dangling incident reference.
export const REPLAY_PROTECTED_SQL = `(depeg_events.disposition IS NOT NULL OR
  (depeg_events.stablecoin_id = 'brz-transfero' AND depeg_events.id IN (${BRZ_UNVERIFIED_PEAK_EVENT_IDS.join(", ")}))
  OR ${reviewedDepegDisputeSql("depeg_events")})`;

export const REPLAY_ROW_PREIMAGE_SQL = `json_array(depeg_events.id, depeg_events.stablecoin_id, depeg_events.symbol,
  depeg_events.peg_type, depeg_events.direction, depeg_events.source, depeg_events.started_at, depeg_events.ended_at,
  depeg_events.start_price, depeg_events.peak_price, depeg_events.peak_deviation_bps, depeg_events.recovery_price,
  depeg_events.peg_reference, depeg_events.close_reason, depeg_events.recovery_first_seen_at, depeg_events.recovery_last_seen_at,
  depeg_events.confirmation_sources, depeg_events.pending_reason, depeg_events.price_coverage_json,
  depeg_events.last_trusted_price_at, depeg_events.price_coverage_gap_started_at, depeg_events.peak_peg_reference,
  depeg_events.peak_quote_domain, depeg_events.recovery_peg_reference, depeg_events.admitted_coverage_json,
  depeg_events.disposition, (SELECT json_array(p.audit_verdict, p.public_json, p.quote_mode, p.updated_at)
    FROM depeg_event_provenance p WHERE p.event_id = depeg_events.id))`;

export function buildReplayPreimageGuard(
  db: D1Database,
  stablecoinId: string,
  preimages: readonly { id: number; preimage: string }[],
  replacements: readonly { startedAt: number; endedAt: number | null; direction: string }[],
): D1PreparedStatement {
  return db.prepare(`INSERT INTO depeg_events (stablecoin_id) SELECT NULL WHERE
    EXISTS (SELECT 1 FROM json_each(?) expected
      LEFT JOIN depeg_events ON depeg_events.id = json_extract(expected.value, '$.id')
      WHERE depeg_events.id IS NULL OR depeg_events.stablecoin_id != ?
        OR ${REPLAY_ROW_PREIMAGE_SQL} IS NOT json_extract(expected.value, '$.preimage')
        OR ${REPLAY_PROTECTED_SQL})
    OR EXISTS (SELECT 1 FROM json_each(?) replacement
      JOIN depeg_events ON depeg_events.stablecoin_id = ?
       AND NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE expected.value = depeg_events.id)
       AND (depeg_events.started_at = json_extract(replacement.value, '$.startedAt')
        OR (depeg_events.direction = json_extract(replacement.value, '$.direction')
          AND (json_extract(replacement.value, '$.endedAt') IS NULL
            OR depeg_events.started_at <= json_extract(replacement.value, '$.endedAt'))
          AND (depeg_events.ended_at IS NULL OR depeg_events.ended_at >= json_extract(replacement.value, '$.startedAt')))))`)
    .bind(JSON.stringify(preimages), stablecoinId,
      JSON.stringify(replacements.map(({ startedAt, endedAt, direction }) => ({ startedAt, endedAt, direction }))),
      stablecoinId, JSON.stringify(preimages.map(({ id }) => id)));
}
const INCIDENT_MEMBER_DELETE_GUARD = ` AND id NOT IN (
  SELECT l.event_id
  FROM depeg_resolver_incident_event_links l
)`;

export function buildBackfillDeleteStmt(
  db: D1Database,
  stablecoinId: string,
  replayWindow: BackfillReplayWindow | null,
  replaceEventIds?: readonly number[],
): D1PreparedStatement {
  let sql = "DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill' AND disposition IS NULL";
  const binds: unknown[] = [stablecoinId];
  if (replayWindow?.compareStartSec != null) {
    sql += " AND (ended_at IS NULL OR ended_at >= ?)";
    binds.push(replayWindow.compareStartSec);
  }
  if (replayWindow?.compareEndSec != null) {
    sql += " AND started_at <= ?";
    binds.push(replayWindow.compareEndSec);
  }
  if (replaceEventIds != null) {
    sql += " AND id IN (SELECT value FROM json_each(?))";
    binds.push(JSON.stringify(replaceEventIds));
  }
  sql += ` AND NOT ${REPLAY_PROTECTED_SQL}` + INCIDENT_MEMBER_DELETE_GUARD;
  return db.prepare(sql).bind(...binds);
}

export async function loadDdrBackfillReplayConflicts(
  db: D1Database,
  stablecoinId: string,
  replayWindow: BackfillReplayWindow | null,
): Promise<DdrBackfillReplayConflict[]> {
  let sql = `
    SELECT e.id AS event_id,
           l.incident_key AS incident_key,
           p.id AS public_prediction_id
    FROM depeg_events e
    JOIN depeg_resolver_incident_event_links l ON l.event_id = e.id
    LEFT JOIN depeg_resolver_public_predictions p ON p.incident_key = l.incident_key
    WHERE e.stablecoin_id = ?
      AND e.source = 'backfill' AND e.disposition IS NULL`;
  const binds: unknown[] = [stablecoinId];

  if (replayWindow?.compareStartSec != null) {
    sql += " AND (e.ended_at IS NULL OR e.ended_at >= ?)";
    binds.push(replayWindow.compareStartSec);
  }
  if (replayWindow?.compareEndSec != null) {
    sql += " AND e.started_at <= ?";
    binds.push(replayWindow.compareEndSec);
  }

  sql += " ORDER BY e.started_at LIMIT 25";

  const rows = await db.prepare(sql).bind(...binds).all<{
    event_id: number;
    incident_key: string;
    public_prediction_id: number | null;
  }>();

  return (rows.results ?? []).map((row) => ({
    eventId: row.event_id,
    incidentKey: row.incident_key,
    publicPredictionId: row.public_prediction_id ?? null,
  }));
}
