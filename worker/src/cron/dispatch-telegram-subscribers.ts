import type { TelegramAlertType } from "@shared/types/status";
import { buildInClause, chunkArray } from "../lib/db";
import { logTelegramEvent } from "../lib/telegram-log";
import {
  listTelegramPresets,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
  type TelegramPresetResolveOptions,
} from "../lib/telegram-presets";
import type { SubscriberRow } from "./dispatch-telegram-routing";
import type { PresetSubscriberLoadResult } from "./dispatch-telegram-alerts-fanout";
import { toErrorMessage } from "../lib/error-utils";

const ALERT_COLUMN_BY_TYPE = {
  dews: "alert_dews",
  depeg: "alert_depeg",
  safety: "alert_safety",
  launch: "alert_launch",
} as const;

const GLOBAL_ALERT_COLUMN_BY_TYPE = {
  dews: "global_alert_dews",
  depeg: "global_alert_depeg",
  safety: "global_alert_safety",
  launch: "global_alert_launch",
} as const;
const VALID_ALERT_COLUMNS = new Set(Object.values(ALERT_COLUMN_BY_TYPE));
const VALID_GLOBAL_ALERT_COLUMNS = new Set(Object.values(GLOBAL_ALERT_COLUMN_BY_TYPE));

type LoadedSubscriberRow = Omit<SubscriberRow, "isGlobal"> & { stablecoin_id: string };

export async function loadSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: TelegramAlertType,
  nowSec: number,
): Promise<Map<string, SubscriberRow[]>> {
  if (stablecoinIds.length === 0) return new Map();
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid alert subscription column for ${type}`);
  }
  const map = new Map<string, SubscriberRow[]>();
  const seen = new Set<string>();
  for (const idChunk of chunkArray(Array.from(new Set(stablecoinIds)))) {
    const inClause = buildInClause(idChunk);
    const result = await db
      .prepare(
        // SAFETY: alertColumn comes from ALERT_COLUMN_BY_TYPE and is validated
        // against the hardcoded allowlist above before interpolation.
        `SELECT sub.stablecoin_id,
                sub.chat_id,
                u.last_active_at,
                sub.dews_min_band,
                sub.safety_mode,
                sub.depeg_worsening_bps_step,
                u.quiet_hours_enabled,
                u.quiet_hours_start_utc,
                u.quiet_hours_end_utc,
                u.timezone
           FROM telegram_subscriptions sub
           JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
          WHERE sub.stablecoin_id IN (${inClause.sql})
            AND sub.${alertColumn} = 1
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
            AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      )
      .bind(...inClause.binds, nowSec, nowSec)
      .all<LoadedSubscriberRow>();

    for (const row of result.results ?? []) {
      const rowKey = `${row.stablecoin_id}:${row.chat_id}`;
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);
      const existing = map.get(row.stablecoin_id) ?? [];
      existing.push({
        chat_id: row.chat_id,
        last_active_at: row.last_active_at,
        dews_min_band: row.dews_min_band ?? null,
        safety_mode: row.safety_mode ?? null,
        depeg_worsening_bps_step: row.depeg_worsening_bps_step ?? null,
        quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
        quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
        quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
        timezone: row.timezone ?? null,
        isGlobal: false,
      });
      map.set(row.stablecoin_id, existing);
    }
  }
  return map;
}

export async function loadGlobalSubscriberRows(
  db: D1Database,
  type: TelegramAlertType,
  nowSec: number,
): Promise<SubscriberRow[]> {
  const alertColumn = GLOBAL_ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_GLOBAL_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid global alert subscription column for ${type}`);
  }
  const result = await db
    .prepare(
      // SAFETY: alertColumn comes from GLOBAL_ALERT_COLUMN_BY_TYPE and is
      // validated against the hardcoded allowlist above before interpolation.
      `SELECT chat_id,
              last_active_at,
              quiet_hours_enabled,
              quiet_hours_start_utc,
              quiet_hours_end_utc,
              timezone,
              global_depeg_worsening_bps_step
         FROM telegram_subscribers
        WHERE ${alertColumn} = 1
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
    )
    .bind(nowSec)
    .all<SubscriberRow>();

  return (result.results ?? []).map((row) => ({
    chat_id: row.chat_id,
    last_active_at: row.last_active_at,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: row.global_depeg_worsening_bps_step ?? null,
    quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
    quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
    quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
    timezone: row.timezone ?? null,
    isGlobal: true,
  }));
}

/**
 * Load active per-coin snoozes for the supplied stablecoins. Returns
 * `Map<stablecoinId, Set<chatId>>` so the routing pass can suppress global
 * subscriptions for any coin a chat has already snoozed locally (P1-U10).
 * Specific subscription rows are already filtered out by the per-type
 * subscriber-row query.
 */
export async function loadPerCoinSnoozeMap(
  db: D1Database,
  stablecoinIds: readonly string[],
  nowSec: number,
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const unique = Array.from(new Set(stablecoinIds));
  if (unique.length === 0) return map;
  for (const idChunk of chunkArray(unique)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      .prepare(
        `SELECT stablecoin_id, chat_id
           FROM telegram_subscriptions
          WHERE stablecoin_id IN (${inClause.sql})
            AND alert_snooze_until_ts IS NOT NULL
            AND alert_snooze_until_ts > ?`,
      )
      .bind(...inClause.binds, nowSec)
      .all<{ stablecoin_id: string; chat_id: string }>();
    for (const row of result.results ?? []) {
      const existing = map.get(row.stablecoin_id) ?? new Set<string>();
      existing.add(row.chat_id);
      map.set(row.stablecoin_id, existing);
    }
  }
  return map;
}

/**
 * Load per-coin rows where a chat has explicitly disabled this alert type.
 * The routing pass applies this map after direct/preset rows are merged, so a
 * local off row suppresses both preset and global fan-out for the same
 * (stablecoin, chat, alert type) tuple.
 */
export async function loadPerCoinExplicitlyOffMap(
  db: D1Database,
  stablecoinIds: readonly string[],
  type: TelegramAlertType,
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const unique = Array.from(new Set(stablecoinIds));
  if (unique.length === 0) return map;
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid alert subscription column for ${type}`);
  }
  for (const idChunk of chunkArray(unique)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      .prepare(
        // SAFETY: alertColumn comes from ALERT_COLUMN_BY_TYPE and is validated
        // against the hardcoded allowlist above before interpolation.
        `SELECT stablecoin_id, chat_id
           FROM telegram_subscriptions
          WHERE stablecoin_id IN (${inClause.sql})
            AND ${alertColumn} = 0`,
      )
      .bind(...inClause.binds)
      .all<{ stablecoin_id: string; chat_id: string }>();
    for (const row of result.results ?? []) {
      const existing = map.get(row.stablecoin_id) ?? new Set<string>();
      existing.add(row.chat_id);
      map.set(row.stablecoin_id, existing);
    }
  }
  return map;
}

export function mergeSubscriberMaps(
  base: Map<string, SubscriberRow[]>,
  additional: Map<string, SubscriberRow[]>,
): Map<string, SubscriberRow[]> {
  for (const [stablecoinId, rows] of additional) {
    const existing = base.get(stablecoinId) ?? [];
    const seenChats = new Set(existing.map((row) => row.chat_id));
    for (const row of rows) {
      if (seenChats.has(row.chat_id)) continue;
      seenChats.add(row.chat_id);
      existing.push(row);
    }
    base.set(stablecoinId, existing);
  }
  return base;
}

export async function loadPresetSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: Exclude<TelegramAlertType, "launch">,
  nowSec: number,
  options: TelegramPresetResolveOptions = {},
): Promise<PresetSubscriberLoadResult> {
  if (stablecoinIds.length === 0) return { kind: "ok", rows: new Map() };
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid preset alert subscription column for ${type}`);
  }
  const wantedIds = new Set(stablecoinIds);
  const allPresetIds = listTelegramPresets().map((definition) => definition.id);
  const allPresetInClause = buildInClause(allPresetIds);
  let hasCandidateRows = false;
  try {
    const candidate = await db
      .prepare(
        // SAFETY: alertColumn comes from ALERT_COLUMN_BY_TYPE and is validated
        // against the hardcoded allowlist above before interpolation.
        `SELECT 1 AS has_row
           FROM telegram_preset_subscriptions p
          JOIN telegram_subscribers u ON u.chat_id = p.chat_id
          WHERE p.${alertColumn} = 1
            AND p.preset_id IN (${allPresetInClause.sql})
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          LIMIT 1`,
      )
      .bind(...allPresetInClause.binds, nowSec)
      .first<{ has_row: number }>();
    hasCandidateRows = candidate != null;
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset query failed",
      action: "preset-query",
      module: "dispatch-telegram-subscribers",
      failureKind: "query-failed",
      alertType: type,
      requestedStablecoinCount: stablecoinIds.length,
      err: toErrorMessage(err),
    });
    return { kind: "query-failed", error: err };
  }
  if (!hasCandidateRows) return { kind: "ok", rows: new Map() };

  const resolved = await resolveTelegramPresetTargets(db, allPresetIds, options);
  if (resolved.kind !== "ok") {
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset resolution failed",
      action: "preset-resolution",
      module: "dispatch-telegram-subscribers",
      failureKind: "resolution-failed",
      alertType: type,
      reason: resolved.reason,
      presetIds: allPresetIds,
      presetCount: allPresetIds.length,
      subscriberRowCount: 1,
      requestedStablecoinCount: stablecoinIds.length,
    });
    return { kind: "resolution-failed" };
  }
  const matchingPresets = resolved.presets.filter((preset) =>
    preset.stablecoinIds.some((stablecoinId) => wantedIds.has(stablecoinId)),
  );
  if (matchingPresets.length === 0) return { kind: "ok", rows: new Map() };
  const matchingPresetIds = matchingPresets.map((preset) => preset.definition.id);
  const presetInClause = buildInClause(matchingPresetIds);
  let result: {
    results?: Array<{
      chat_id: string;
      preset_id: TelegramPresetId;
      last_active_at: number;
      depeg_worsening_bps_step: number | null;
      quiet_hours_enabled: number | null;
      quiet_hours_start_utc: number | null;
      quiet_hours_end_utc: number | null;
      timezone: string | null;
    }>;
  };
  try {
    result = await db
      .prepare(
        // SAFETY: alertColumn comes from ALERT_COLUMN_BY_TYPE and is validated
        // against the hardcoded allowlist above before interpolation.
        `SELECT p.chat_id,
                p.preset_id,
                u.last_active_at,
                p.depeg_worsening_bps_step,
                u.quiet_hours_enabled,
                u.quiet_hours_start_utc,
                u.quiet_hours_end_utc,
                u.timezone
           FROM telegram_preset_subscriptions p
          JOIN telegram_subscribers u ON u.chat_id = p.chat_id
          WHERE p.${alertColumn} = 1
            AND p.preset_id IN (${presetInClause.sql})
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)`,
      )
      .bind(...presetInClause.binds, nowSec)
      .all<{
        chat_id: string;
        preset_id: TelegramPresetId;
        last_active_at: number;
        depeg_worsening_bps_step: number | null;
        quiet_hours_enabled: number | null;
        quiet_hours_start_utc: number | null;
        quiet_hours_end_utc: number | null;
        timezone: string | null;
      }>();
  } catch (err) {
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset query failed",
      action: "preset-query",
      module: "dispatch-telegram-subscribers",
      failureKind: "query-failed",
      alertType: type,
      requestedStablecoinCount: stablecoinIds.length,
      err: toErrorMessage(err),
    });
    return { kind: "query-failed", error: err };
  }

  const rows = result.results ?? [];
  if (rows.length === 0) return { kind: "ok", rows: new Map() };

  const idsByPreset = new Map(resolved.presets.map((preset) => [preset.definition.id, new Set(preset.stablecoinIds)]));
  const map = new Map<string, SubscriberRow[]>();
  for (const row of rows) {
    const presetIdsForRow = idsByPreset.get(row.preset_id);
    if (!presetIdsForRow) continue;
    for (const stablecoinId of presetIdsForRow) {
      if (!wantedIds.has(stablecoinId)) continue;
      const existing = map.get(stablecoinId) ?? [];
      existing.push({
        chat_id: row.chat_id,
        last_active_at: row.last_active_at,
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: row.depeg_worsening_bps_step ?? null,
        quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
        quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
        quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
        timezone: row.timezone ?? null,
        isGlobal: false,
      });
      map.set(stablecoinId, existing);
    }
  }
  return { kind: "ok", rows: map };
}

export type TelegramBroadcastScope = "all" | "deliverable-watchers" | "global-subscribers";

export async function loadBroadcastTargetChatIds(
  db: D1Database,
  scope: TelegramBroadcastScope,
): Promise<string[]> {
  const globalPredicate = Object.values(GLOBAL_ALERT_COLUMN_BY_TYPE)
    .map((column) => `s.${column} = 1`)
    .join(" OR ");
  const globalSubscriberPredicate = Object.values(GLOBAL_ALERT_COLUMN_BY_TYPE)
    .map((column) => `${column} = 1`)
    .join(" OR ");

  const sql = scope === "global-subscribers"
    ? `SELECT chat_id FROM telegram_subscribers
        WHERE ${globalSubscriberPredicate}
        ORDER BY chat_id`
    : scope === "deliverable-watchers"
      ? `SELECT s.chat_id
           FROM telegram_subscribers s
          WHERE ${globalPredicate}
             OR EXISTS (
               SELECT 1 FROM telegram_subscriptions ts
                WHERE ts.chat_id = s.chat_id
                  AND (ts.alert_dews = 1 OR ts.alert_depeg = 1 OR ts.alert_safety = 1 OR ts.alert_launch = 1)
             )
             OR EXISTS (
               SELECT 1 FROM telegram_preset_subscriptions ps
                WHERE ps.chat_id = s.chat_id
                  AND (ps.alert_dews = 1 OR ps.alert_depeg = 1 OR ps.alert_safety = 1)
             )
          ORDER BY s.chat_id`
      : `SELECT chat_id FROM telegram_subscribers ORDER BY chat_id`;
  const rows = await db.prepare(sql).all<{ chat_id: string }>();
  return (rows.results ?? []).map((row) => row.chat_id);
}
