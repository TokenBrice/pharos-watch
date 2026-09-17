import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { parseJsonObject } from "../lib/json-parse";
import { logTelegramEvent } from "../lib/telegram/log";

/** The tape projector runs every 30 minutes; two missed slots fail closed. */
const TAPE_FRESHNESS_SEC = 60 * 60;
const TAPE_PAGE_LIMIT = 500;
const FREEZE_ROW_HOLD_KEY = "alert:freeze-tape-row-hold";
const FREEZE_ROW_HOLD_RETRY_LIMIT = 3;

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
interface FreezeRowHoldState {
  rowId: number;
  attempts: number;
}


type FreezeRowDropReason = "bad-json" | "unknown-coin" | "ambiguous-symbol";

type FreezeRowParseResult =
  | { alert: FreezeAlert }
  | { reason: FreezeRowDropReason };

type SymbolResolution =
  | { stablecoinId: string }
  | { reason: Exclude<FreezeRowDropReason, "bad-json"> };
function parseFreezeRowHoldState(value: string): FreezeRowHoldState | null {
  const parsed = parseJsonObject(value, "telegram freeze row hold state");
  if (
    !parsed ||
    !Number.isSafeInteger(parsed.rowId) ||
    Number(parsed.rowId) < 1 ||
    !Number.isSafeInteger(parsed.attempts) ||
    Number(parsed.attempts) < 1
  ) return null;
  return { rowId: Number(parsed.rowId), attempts: Number(parsed.attempts) };
}


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

function logDroppedFreezeRow(reason: FreezeRowDropReason): void {
  logTelegramEvent({
    level: "warn",
    message: "held unparseable freeze Tape row for retry",
    action: "freeze-row-held",
    module: "telegram-alert-freeze",
    reason,
    rowCount: 1,
  });
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
  deadLetteredUnparsed?: number;
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
  let unparseable: { id: number; reason: FreezeRowDropReason } | null = null;
  for (const row of results) {
    const parsed = parseFreezeRow(row);
    if ("alert" in parsed) {
      alerts.push(parsed.alert);
      continue;
    }
    const rowId = Number(row.id);
    if (Number.isSafeInteger(rowId) && rowId > 0) {
      unparseable = { id: rowId, reason: parsed.reason };
      break;
    }
  }
  if (unparseable == null) {
    const nextCursor = results.length > 0 ? Number(results[results.length - 1]!.id) : cursor;
    return { state: "ok", alerts, cursor: nextCursor };
  }

  logDroppedFreezeRow(unparseable.reason);
  const cachedHold = await getCache(db, FREEZE_ROW_HOLD_KEY);
  const previousHold = cachedHold ? parseFreezeRowHoldState(cachedHold.value) : null;
  const attempts = previousHold?.rowId === unparseable.id ? previousHold.attempts + 1 : 1;
  if (attempts < FREEZE_ROW_HOLD_RETRY_LIMIT) {
    await setCache(db, FREEZE_ROW_HOLD_KEY, JSON.stringify({ rowId: unparseable.id, attempts }));
    return {
      state: "ok",
      alerts,
      cursor: unparseable.id - 1,
      droppedUnparsed: 1,
    };
  }

  await deleteCache(db, FREEZE_ROW_HOLD_KEY);
  logTelegramEvent({
    level: "error",
    message: "dead-lettered unparseable freeze Tape row after retry limit",
    action: "freeze-row-dead-lettered",
    module: "telegram-alert-freeze",
    errorClass: "bad_request",
    failureKind: "poison-row",
    reason: unparseable.reason,
    attempts,
    rowCount: 1,
  });
  return {
    state: "ok",
    alerts,
    cursor: unparseable.id,
    droppedUnparsed: 1,
    deadLetteredUnparsed: 1,
  };
}

