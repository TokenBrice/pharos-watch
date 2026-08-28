import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { errorResponse } from "../lib/api-response";
import { parseDayStartParam } from "../lib/api-params";
import { DAY_SECONDS } from "@shared/lib/time-constants";

const BACKFILL_REPLAY_CONTEXT_DAYS = 7;
const MAX_BACKFILL_REPLAY_CONTEXT_DAYS = 90;

export interface BackfillReplayWindow {
  contextDays: number;
  startDay: number | null;
  endDay: number | null;
  compareStartSec: number | null;
  compareEndSec: number | null;
  replayStartSec: number | null;
  replayEndSec: number | null;
}

export interface DdrSealedBackfillConflict {
  eventId: number;
  incidentKey: string;
  publicPredictionId: number;
}

function parseContextDaysParam(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_BACKFILL_REPLAY_CONTEXT_DAYS) return null;
  return parsed;
}

export interface OptionalDayWindow {
  startDay: number | null;
  endDay: number | null;
  hasExplicitWindow: boolean;
  usedDefaultWindow: boolean;
  contextDays: number | null;
  replayWindow: BackfillReplayWindow | null;
}

export interface OptionalDayWindowOptions {
  defaultStartDay?: number | null;
  defaultEndDay?: number | null;
  minStartDay?: number | null;
  maxEndDay?: number | null;
  rejectInvertedRange?: boolean;
  includeContextDays?: boolean;
  defaultContextDays?: number;
  includeReplayWindow?: boolean;
  invalidDayMessage?: string;
  invalidStartDayMessage?: string;
  invalidEndDayMessage?: string;
  invalidRangeMessage?: string;
}

export function parseOptionalDayWindow(
  url: URL,
  options: OptionalDayWindowOptions = {},
): OptionalDayWindow | Response {
  const startDayRaw = url.searchParams.get("startDay");
  const endDayRaw = url.searchParams.get("endDay");
  const parsedStartDay = parseDayStartParam(startDayRaw);
  const parsedEndDay = parseDayStartParam(endDayRaw);
  const invalidDayMessage =
    options.invalidDayMessage ??
    "Invalid startDay/endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.";

  if (startDayRaw && parsedStartDay == null) {
    return errorResponse(400, options.invalidStartDayMessage ?? invalidDayMessage);
  }
  if (endDayRaw && parsedEndDay == null) {
    return errorResponse(400, options.invalidEndDayMessage ?? invalidDayMessage);
  }

  let contextDays: number | null = null;
  if (options.includeContextDays) {
    const contextRaw = url.searchParams.get("contextDays");
    const parsedContextDays = parseContextDaysParam(contextRaw);
    if (contextRaw && parsedContextDays == null) {
      return errorResponse(
        400,
        `Invalid contextDays. Use an integer between 0 and ${MAX_BACKFILL_REPLAY_CONTEXT_DAYS}.`,
      );
    }
    contextDays = parsedContextDays ?? options.defaultContextDays ?? BACKFILL_REPLAY_CONTEXT_DAYS;
  }

  const hasExplicitWindow = url.searchParams.has("startDay") || url.searchParams.has("endDay");
  const usedDefaultWindow = parsedStartDay == null && parsedEndDay == null;
  let startDay = parsedStartDay ?? options.defaultStartDay ?? null;
  let endDay = parsedEndDay ?? options.defaultEndDay ?? null;

  if (startDay != null && options.minStartDay != null) {
    startDay = Math.max(options.minStartDay, startDay);
  }
  if (endDay != null && options.maxEndDay != null) {
    endDay = Math.min(options.maxEndDay, endDay);
  }

  if (
    (options.rejectInvertedRange ?? true) &&
    startDay != null &&
    endDay != null &&
    startDay > endDay
  ) {
    return errorResponse(
      400,
      options.invalidRangeMessage ?? "Invalid startDay/endDay: startDay must be <= endDay.",
    );
  }

  const replayWindow = options.includeReplayWindow && hasExplicitWindow
    ? buildReplayWindow(startDay, endDay, contextDays ?? options.defaultContextDays ?? BACKFILL_REPLAY_CONTEXT_DAYS)
    : null;

  return {
    startDay,
    endDay,
    hasExplicitWindow,
    usedDefaultWindow,
    contextDays,
    replayWindow,
  };
}

function buildReplayWindow(
  startDay: number | null,
  endDay: number | null,
  contextDays = BACKFILL_REPLAY_CONTEXT_DAYS,
): BackfillReplayWindow {
  const compareStartSec = startDay;
  const compareEndSec = endDay != null ? endDay + DAY_SECONDS - 1 : null;
  return {
    contextDays,
    startDay,
    endDay,
    compareStartSec,
    compareEndSec,
    replayStartSec:
      compareStartSec != null
        ? Math.max(0, compareStartSec - contextDays * DAY_SECONDS)
        : null,
    replayEndSec:
      compareEndSec != null
        ? compareEndSec + contextDays * DAY_SECONDS
        : null,
  };
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

export function buildBackfillDeleteStmt(
  db: D1Database,
  stablecoinId: string,
  replayWindow: BackfillReplayWindow | null,
): D1PreparedStatement {
  if (!replayWindow) {
    return db
      .prepare("DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill'")
      .bind(stablecoinId);
  }

  let sql = "DELETE FROM depeg_events WHERE stablecoin_id = ? AND source = 'backfill'";
  const binds: unknown[] = [stablecoinId];
  if (replayWindow.compareStartSec != null) {
    sql += " AND COALESCE(ended_at, started_at) >= ?";
    binds.push(replayWindow.compareStartSec);
  }
  if (replayWindow.compareEndSec != null) {
    sql += " AND started_at <= ?";
    binds.push(replayWindow.compareEndSec);
  }
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
