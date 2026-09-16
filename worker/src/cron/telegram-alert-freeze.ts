import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { parseJsonObject } from "../lib/json-parse";
import { logTelegramEvent } from "../lib/telegram/log";

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

type FreezeRowDropReason = "bad-json" | "unknown-coin" | "ambiguous-symbol";

type FreezeRowParseResult =
  | { alert: FreezeAlert }
  | { reason: FreezeRowDropReason };

type SymbolResolution =
  | { stablecoinId: string }
  | { reason: Exclude<FreezeRowDropReason, "bad-json"> };

function stablecoinIdForSymbol(symbol: string): SymbolResolution {
  const matches = [...WORKER_TRACKED_META_BY_ID.entries()].filter(([, coin]) => coin.symbol === symbol);
  if (matches.length === 1) return { stablecoinId: matches[0]![0] };
  return { reason: matches.length === 0 ? "unknown-coin" : "ambiguous-symbol" };
}

function parseFreezeRow(row: FreezeTapeRow): FreezeRowParseResult {
  const payload = parseJsonObject(row.payload_json, "telegram freeze Tape payload");
  if (
    !payload ||
    typeof payload.stablecoin !== "string" ||
    typeof payload.chainName !== "string" ||
    typeof payload.sourceEventId !== "string"
  ) return { reason: "bad-json" };

  let stablecoinId: string;
  if (typeof payload.stablecoinId === "string" && WORKER_TRACKED_META_BY_ID.has(payload.stablecoinId)) {
    stablecoinId = payload.stablecoinId;
  } else {
    const symbolResolution = stablecoinIdForSymbol(payload.stablecoin);
    if ("reason" in symbolResolution) return symbolResolution;
    stablecoinId = symbolResolution.stablecoinId;
  }

  const eventType = row.type === "freeze.blocked"
    ? "blacklist"
    : row.type === "freeze.unblocked"
      ? "unblacklist"
      : "destroy";
  return {
    alert: {
      stablecoinId,
      symbol: payload.stablecoin,
      eventType,
      chainName: payload.chainName,
      amountUsdAtEvent: typeof payload.amountUsdAtEvent === "number" && Number.isFinite(payload.amountUsdAtEvent)
        ? payload.amountUsdAtEvent
        : null,
      tapeEventId: row.event_id,
      sourceEventId: payload.sourceEventId,
    },
  };
}

function logDroppedFreezeRows(droppedByReason: ReadonlyMap<FreezeRowDropReason, number>): void {
  for (const reason of ["bad-json", "unknown-coin", "ambiguous-symbol"] as const) {
    const rowCount = droppedByReason.get(reason) ?? 0;
    if (rowCount === 0) continue;
    logTelegramEvent({
      level: "warn",
      message: "dropped unparseable freeze Tape rows",
      action: "freeze-row-dropped",
      module: "telegram-alert-freeze",
      reason,
      rowCount,
    });
  }
}

function countDroppedFreezeRow(
  droppedByReason: Map<FreezeRowDropReason, number>,
  reason: FreezeRowDropReason,
): void {
  droppedByReason.set(reason, (droppedByReason.get(reason) ?? 0) + 1);
}

export async function loadFreshFreezeAlerts(
  db: D1Database,
  cursor: number | null,
  nowSec: number,
): Promise<{
  state: "ok" | "stale" | "unseeded";
  alerts: FreezeAlert[];
  cursor: number | null;
  droppedUnparsed?: number;
}> {
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
  const alerts: FreezeAlert[] = [];
  const droppedByReason = new Map<FreezeRowDropReason, number>();
  let firstUnparseableId: number | null = null;
  for (const row of results) {
    const parsed = parseFreezeRow(row);
    if ("alert" in parsed) {
      alerts.push(parsed.alert);
      continue;
    }
    countDroppedFreezeRow(droppedByReason, parsed.reason);
    if (firstUnparseableId == null && Number.isFinite(Number(row.id))) {
      firstUnparseableId = Number(row.id);
    }
  }
  const droppedUnparsed = [...droppedByReason.values()].reduce((total, count) => total + count, 0);
  if (droppedUnparsed > 0) logDroppedFreezeRows(droppedByReason);
  const nextCursor = firstUnparseableId
    ?? (results.length > 0 ? Number(results[results.length - 1]!.id) : cursor);
  return droppedUnparsed > 0
    ? { state: "ok", alerts, cursor: nextCursor, droppedUnparsed }
    : { state: "ok", alerts, cursor: nextCursor };
}

