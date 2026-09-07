import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { parseJsonObject } from "../lib/json-parse";

/** The tape projector runs every 30 minutes; two missed slots fail closed. */
const TAPE_FRESHNESS_SEC = 60 * 60;
const TAPE_PAGE_LIMIT = 500;

export interface FreezeAlert {
  stablecoinId: string;
  symbol: string;
  eventType: "blacklist" | "unblacklist" | "destroy";
  chainName: string;
  amountUsdAtEvent: number | null;
  /** Immutable tape identity, which embeds the blacklist_events source identity. */
  tapeEventId: string;
  /** Immutable blacklist_events.id retained by the tape projection. */
  sourceEventId: string;
}

interface FreezeTapeRow {
  id: number;
  event_id: string;
  type: "freeze.blocked" | "freeze.unblocked" | "freeze.destroyed";
  payload_json: string;
}

interface ProjectTapeRunRow { started_at: number; }

function stablecoinIdForSymbol(symbol: string): string | null {
  const matches = [...WORKER_TRACKED_META_BY_ID.entries()].filter(([, coin]) => coin.symbol === symbol);
  return matches.length === 1 ? matches[0]![0] : null;
}

function parseFreezeRow(row: FreezeTapeRow): FreezeAlert | null {
  const payload = parseJsonObject(row.payload_json, "telegram freeze Tape payload");
  if (
    !payload ||
    typeof payload.stablecoin !== "string" ||
    typeof payload.chainName !== "string" ||
    typeof payload.sourceEventId !== "string"
  ) return null;
  const stablecoinId = typeof payload.stablecoinId === "string" && WORKER_TRACKED_META_BY_ID.has(payload.stablecoinId)
    ? payload.stablecoinId
    : stablecoinIdForSymbol(payload.stablecoin);
  if (!stablecoinId) return null;
  const eventType = row.type === "freeze.blocked"
    ? "blacklist"
    : row.type === "freeze.unblocked"
      ? "unblacklist"
      : "destroy";
  return {
    stablecoinId,
    symbol: payload.stablecoin,
    eventType,
    chainName: payload.chainName,
    amountUsdAtEvent: typeof payload.amountUsdAtEvent === "number" && Number.isFinite(payload.amountUsdAtEvent)
      ? payload.amountUsdAtEvent
      : null,
    tapeEventId: row.event_id,
    sourceEventId: payload.sourceEventId,
  };
}

export async function loadFreshFreezeAlerts(
  db: D1Database,
  cursor: number | null,
  nowSec: number,
): Promise<{ state: "ok" | "stale" | "unseeded"; alerts: FreezeAlert[]; cursor: number | null }> {
  const latestRun = await db.prepare(
    "SELECT started_at FROM cron_runs WHERE job = 'project-tape' AND status = 'ok' ORDER BY started_at DESC, id DESC LIMIT 1",
  ).first<ProjectTapeRunRow>();
  if (!latestRun || nowSec - Number(latestRun.started_at) > TAPE_FRESHNESS_SEC) {
    return { state: "stale", alerts: [], cursor };
  }
  if (cursor == null) {
    const latest = await db.prepare(
      `SELECT MAX(id) AS id FROM tape_events
        WHERE type IN ('freeze.blocked', 'freeze.unblocked', 'freeze.destroyed')`,
    ).first<{ id: number | null }>();
    return { state: "unseeded", alerts: [], cursor: latest?.id == null ? null : Number(latest.id) };
  }
  const rows = await db.prepare(
    `SELECT id, event_id, type, payload_json
       FROM tape_events
      WHERE id > ?
        AND type IN ('freeze.blocked', 'freeze.unblocked', 'freeze.destroyed')
      ORDER BY id ASC
      LIMIT ?`,
  ).bind(cursor ?? 0, TAPE_PAGE_LIMIT).all<FreezeTapeRow>();
  const results = rows.results ?? [];
  const nextCursor = results.length > 0 ? Number(results[results.length - 1]!.id) : cursor;
  return { state: "ok", alerts: results.flatMap((row) => {
    const alert = parseFreezeRow(row);
    return alert ? [alert] : [];
  }), cursor: nextCursor };
}
