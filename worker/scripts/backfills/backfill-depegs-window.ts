import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { buildReplayWindow, MAX_BACKFILL_REPLAY_CONTEXT_DAYS, type BackfillReplayWindow } from "../../src/lib/backfill-day-window";

export interface DdrSealedBackfillConflict {
  eventId: number;
  incidentKey: string;
  publicPredictionId: number;
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
  const eventEnd = event.endedAt ?? event.startedAt;
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
  if (episode.direction !== liveRow.direction) return false;
  const episodeEnd = episode.endedAt ?? episode.startedAt;
  const liveEnd = liveRow.ended_at ?? liveRow.started_at;
  return episode.startedAt <= liveEnd && liveRow.started_at <= episodeEnd;
}

const SEALED_EVENT_DELETE_GUARD = ` AND id NOT IN (
  SELECT l.event_id
  FROM depeg_resolver_incident_event_links l
  JOIN depeg_resolver_public_predictions p ON p.incident_key = l.incident_key
)`;

export function buildBackfillDeleteStmt(
  db: D1Database,
  stablecoinId: string,
  replayWindow: BackfillReplayWindow | null,
): D1PreparedStatement {
  let sql = "DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill'";
  const binds: unknown[] = [stablecoinId];
  if (replayWindow?.compareStartSec != null) {
    sql += " AND COALESCE(ended_at, started_at) >= ?";
    binds.push(replayWindow.compareStartSec);
  }
  if (replayWindow?.compareEndSec != null) {
    sql += " AND started_at <= ?";
    binds.push(replayWindow.compareEndSec);
  }
  sql += SEALED_EVENT_DELETE_GUARD;
  return db.prepare(sql).bind(...binds);
}

export async function loadSealedBackfillReplayConflicts(
  db: D1Database,
  stablecoinId: string,
  replayWindow: BackfillReplayWindow | null,
): Promise<DdrSealedBackfillConflict[]> {
  let sql = `
    SELECT e.id AS event_id,
           l.incident_key AS incident_key,
           p.id AS public_prediction_id
    FROM depeg_events e
    JOIN depeg_resolver_incident_event_links l ON l.event_id = e.id
    JOIN depeg_resolver_public_predictions p ON p.incident_key = l.incident_key
    WHERE e.stablecoin_id = ?
      AND e.source = 'backfill'`;
  const binds: unknown[] = [stablecoinId];

  if (replayWindow?.compareStartSec != null) {
    sql += " AND COALESCE(e.ended_at, e.started_at) >= ?";
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
    public_prediction_id: number;
  }>();

  return (rows.results ?? []).map((row) => ({
    eventId: row.event_id,
    incidentKey: row.incident_key,
    publicPredictionId: row.public_prediction_id,
  }));
}
