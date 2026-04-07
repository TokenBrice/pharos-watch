import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

const BACKFILL_REPLAY_CONTEXT_DAYS = 7;
const MAX_BACKFILL_REPLAY_CONTEXT_DAYS = 90;

export { BACKFILL_REPLAY_CONTEXT_DAYS, MAX_BACKFILL_REPLAY_CONTEXT_DAYS };

export interface BackfillReplayWindow {
  contextDays: number;
  startDay: number | null;
  endDay: number | null;
  compareStartSec: number | null;
  compareEndSec: number | null;
  replayStartSec: number | null;
  replayEndSec: number | null;
}

export function parseDayParam(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    const seconds = parsed > 1e12 ? Math.floor(parsed / 1000) : parsed;
    return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
  }

  const parsedMs = Date.parse(raw);
  if (Number.isNaN(parsedMs)) return null;
  return Math.floor(parsedMs / 1000 / DAY_SECONDS) * DAY_SECONDS;
}

export function parseContextDaysParam(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_BACKFILL_REPLAY_CONTEXT_DAYS) return null;
  return parsed;
}

export function buildReplayWindow(
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
  if (!replayWindow) return true;
  const rowEnd = row.ended_at ?? row.started_at;
  if (replayWindow.compareStartSec != null && rowEnd < replayWindow.compareStartSec) return false;
  if (replayWindow.compareEndSec != null && row.started_at > replayWindow.compareEndSec) return false;
  return true;
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
