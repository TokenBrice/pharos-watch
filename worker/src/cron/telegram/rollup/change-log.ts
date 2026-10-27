import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { executeAtomicBatch, prepareMultiRowInsertStatements } from "../../../lib/db";
import { parseJsonObject } from "../../../lib/json-parse";
import type { FreezeAlert } from "../../../telegram/common/alerts-formatting";

/**
 * Durable store for alert changes that are not sent live: safety grade moves,
 * DEWS de-escalations (and escalations, for digest-only global opt-ins),
 * freezes under the live threshold, reserve drift, and per-chat cap overflow.
 * The hourly freeze batch and the daily roll-up read it; rows expire after
 * `TELEGRAM_ALERT_POLICY.rollup.changeLogRetentionSec`.
 */

export interface SafetyChangePayload {
  symbol: string;
  from: string;
  to: string;
  fromScore: number | null;
  toScore: number | null;
}

export interface DewsChangePayload {
  symbol: string;
  from: string;
  to: string;
  score: number;
}

export interface FreezeChangePayload {
  symbol: string;
  eventType: "blacklist" | "unblacklist" | "destroy";
  chainName: string;
  amountUsdAtEvent: number | null;
  tapeEventId: string;
}

export interface ReserveChangePayload {
  symbol: string;
  name: string;
}

/** A live message held back by the per-chat cap. */
export interface OverflowChangePayload {
  families: string[];
  coinIds: string[];
}

export type TelegramChangeLogEntry =
  | { kind: "safety"; stablecoinId: string; sourceKey: string; observedAt: number; payload: SafetyChangePayload }
  | { kind: "dews"; stablecoinId: string; sourceKey: string; observedAt: number; payload: DewsChangePayload }
  | { kind: "freeze"; stablecoinId: string; sourceKey: string; observedAt: number; payload: FreezeChangePayload }
  | { kind: "reserve"; stablecoinId: string; sourceKey: string; observedAt: number; payload: ReserveChangePayload }
  | { kind: "overflow"; chatId: string; sourceKey: string; observedAt: number; payload: OverflowChangePayload };

export type TelegramChangeKind = TelegramChangeLogEntry["kind"];

export type StoredTelegramChange = TelegramChangeLogEntry & { id: number };

interface ChangeLogRow {
  id: number;
  kind: string;
  stablecoin_id: string | null;
  chat_id: string | null;
  source_key: string;
  payload_json: string;
  observed_at: number;
}

/** INSERT OR IGNORE on `source_key`, so a replayed detection is harmless. */
export function buildTelegramChangeLogStatements(
  db: D1Database,
  entries: readonly TelegramChangeLogEntry[],
): D1PreparedStatement[] {
  return prepareMultiRowInsertStatements(
    db,
    "INSERT OR IGNORE INTO telegram_change_log (kind, stablecoin_id, chat_id, source_key, payload_json, observed_at)",
    entries.map((entry) => [
      entry.kind,
      entry.kind === "overflow" ? null : entry.stablecoinId,
      entry.kind === "overflow" ? entry.chatId : null,
      entry.sourceKey,
      JSON.stringify(entry.payload),
      entry.observedAt,
    ]),
  );
}

/** Below-threshold freezes for the hourly batch and roll-up, keyed by Tape event so a replay is a no-op. */
export function freezeAlertsToChangeLogEntries(
  alerts: readonly FreezeAlert[],
  nowSec: number = Math.floor(Date.now() / 1000),
): TelegramChangeLogEntry[] {
  return alerts.map((alert) => ({
    kind: "freeze",
    stablecoinId: alert.stablecoinId,
    sourceKey: `freeze:${alert.tapeEventId}`,
    observedAt: nowSec,
    payload: {
      symbol: alert.symbol,
      eventType: alert.eventType,
      chainName: alert.chainName,
      amountUsdAtEvent: alert.amountUsdAtEvent,
      tapeEventId: alert.tapeEventId,
    },
  }));
}

export async function recordTelegramChangeLog(
  db: D1Database,
  entries: readonly TelegramChangeLogEntry[],
): Promise<void> {
  const statements = buildTelegramChangeLogStatements(db, entries);
  if (statements.length > 0) await executeAtomicBatch(db, statements);
}

function parseChangeLogRow(row: ChangeLogRow): StoredTelegramChange | null {
  const payload = parseJsonObject(row.payload_json, "telegram change log payload");
  if (!payload) return null;
  const base = { id: Number(row.id), sourceKey: row.source_key, observedAt: Number(row.observed_at) };
  if (row.kind === "overflow") {
    if (row.chat_id == null) return null;
    return { ...base, kind: "overflow", chatId: row.chat_id, payload: payload as unknown as OverflowChangePayload };
  }
  if (row.stablecoin_id == null) return null;
  switch (row.kind) {
    case "safety":
      return { ...base, kind: "safety", stablecoinId: row.stablecoin_id, payload: payload as unknown as SafetyChangePayload };
    case "dews":
      return { ...base, kind: "dews", stablecoinId: row.stablecoin_id, payload: payload as unknown as DewsChangePayload };
    case "freeze":
      return { ...base, kind: "freeze", stablecoinId: row.stablecoin_id, payload: payload as unknown as FreezeChangePayload };
    case "reserve":
      return { ...base, kind: "reserve", stablecoinId: row.stablecoin_id, payload: payload as unknown as ReserveChangePayload };
    default:
      return null;
  }
}

/** Coin-scoped changes observed in `(sinceSec, untilSec]`, oldest first. */
export async function loadCoinChanges(
  db: D1Database,
  kinds: readonly Exclude<TelegramChangeKind, "overflow">[],
  sinceSec: number,
  untilSec: number,
): Promise<StoredTelegramChange[]> {
  if (kinds.length === 0) return [];
  const rows = await db.prepare(
    `SELECT id, kind, stablecoin_id, chat_id, source_key, payload_json, observed_at
       FROM telegram_change_log
      WHERE observed_at > ? AND observed_at <= ?
        AND chat_id IS NULL
        AND kind IN (${kinds.map(() => "?").join(", ")})
      ORDER BY observed_at ASC, id ASC`,
  ).bind(sinceSec, untilSec, ...kinds).all<ChangeLogRow>();
  return (rows.results ?? []).flatMap((row) => parseChangeLogRow(row) ?? []);
}

/** Freeze changes after a change-log id (through `throughId` when given), for the hourly batch cursor. */
export async function loadFreezeChangesAfter(
  db: D1Database,
  afterId: number,
  throughId?: number,
): Promise<StoredTelegramChange[]> {
  const rows = await db.prepare(
    `SELECT id, kind, stablecoin_id, chat_id, source_key, payload_json, observed_at
       FROM telegram_change_log
      WHERE id > ? AND (? IS NULL OR id <= ?) AND kind = 'freeze'
      ORDER BY id ASC`,
  ).bind(afterId, throughId ?? null, throughId ?? null).all<ChangeLogRow>();
  return (rows.results ?? []).flatMap((row) => parseChangeLogRow(row) ?? []);
}

/** Cap-overflow counts per chat in `(sinceSec, untilSec]`. */
export async function loadOverflowCounts(
  db: D1Database,
  chatIds: readonly string[],
  sinceByChat: ReadonlyMap<string, number>,
  untilSec: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (chatIds.length === 0) return counts;
  const minSince = Math.min(...chatIds.map((chatId) => sinceByChat.get(chatId) ?? untilSec));
  const rows = await db.prepare(
    `SELECT chat_id, observed_at FROM telegram_change_log
      WHERE chat_id IS NOT NULL AND observed_at > ? AND observed_at <= ?`,
  ).bind(minSince, untilSec).all<{ chat_id: string; observed_at: number }>();
  for (const row of rows.results ?? []) {
    const since = sinceByChat.get(row.chat_id);
    if (since == null || Number(row.observed_at) <= since) continue;
    counts.set(row.chat_id, (counts.get(row.chat_id) ?? 0) + 1);
  }
  return counts;
}

export function prepareChangeLogPrune(db: D1Database, nowSec: number): D1PreparedStatement {
  return db.prepare("DELETE FROM telegram_change_log WHERE observed_at < ?")
    .bind(nowSec - TELEGRAM_ALERT_POLICY.rollup.changeLogRetentionSec);
}
