import type { TelegramAlertType } from "@shared/types/status";
import { buildInClause, chunkArray, D1_MAX_BOUND_PARAMETERS } from "../lib/db";
import { logTelegramEvent } from "../lib/telegram/log";
import { GLOBAL_ALERT_COLUMN_BY_TYPE } from "../lib/telegram/broadcast-targets";
import { listTelegramPresets, type TelegramPresetResolveOptions } from "../lib/telegram/presets";
import type { SubscriberRow } from "./dispatch-telegram-routing";
import {
  TELEGRAM_FANOUT_FAMILIES,
  type LegacyFanoutAlertType,
  type PresetSubscriberLoadResult,
} from "./dispatch-telegram-alerts-fanout";
import {
  loadActivePresetFollowers,
  projectPresetFollowers,
  resolvePresetMemberships,
  type PresetAlertType,
} from "./telegram-preset-subscriber-store";

function fanoutColumns(key: "directColumn" | "globalColumn" | "overrideColumn") {
  return Object.fromEntries(TELEGRAM_FANOUT_FAMILIES.map((spec) => [spec.family, spec[key]])) as
    Record<LegacyFanoutAlertType, string>;
}

const ALERT_COLUMN_BY_TYPE = { ...fanoutColumns("directColumn"), freeze: "alert_freeze" };
const GLOBAL_COLUMN_BY_TYPE = {
  ...fanoutColumns("globalColumn"),
  freeze: GLOBAL_ALERT_COLUMN_BY_TYPE.freeze,
};
const ALERT_OVERRIDE_COLUMN_BY_TYPE = {
  ...fanoutColumns("overrideColumn"),
  freeze: "alert_freeze_override",
};

const VALID_ALERT_COLUMNS = new Set(Object.values(ALERT_COLUMN_BY_TYPE));
const VALID_GLOBAL_ALERT_COLUMNS = new Set(Object.values(GLOBAL_COLUMN_BY_TYPE));
const VALID_ALERT_OVERRIDE_COLUMNS = new Set(Object.values(ALERT_OVERRIDE_COLUMN_BY_TYPE));

type LoadedSubscriberRow = Omit<SubscriberRow, "isGlobal" | "hasLocalOverride"> & {
  stablecoin_id: string;
};

export interface TelegramSubscriberLoadOptions {
  chatIds?: readonly string[];
}

function normalizedChatIds(options: TelegramSubscriberLoadOptions): string[] | null {
  return options.chatIds ? [...new Set(options.chatIds)] : null;
}

export async function loadSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: TelegramAlertType,
  nowSec: number,
  options: TelegramSubscriberLoadOptions = {},
): Promise<Map<string, SubscriberRow[]>> {
  if (stablecoinIds.length === 0) return new Map();
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  if (!VALID_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid alert subscription column for ${type}`);
  }
  const map = new Map<string, SubscriberRow[]>();
  const seen = new Set<string>();
  const chatIds = normalizedChatIds(options);
  if (chatIds?.length === 0) return map;
  const chatChunks = chatIds ? chunkArray(chatIds, 45) : [[]];
  for (const chatChunk of chatChunks) {
    const stablecoinChunkSize = D1_MAX_BOUND_PARAMETERS - 2 - chatChunk.length;
    for (const idChunk of chunkArray(Array.from(new Set(stablecoinIds)), stablecoinChunkSize)) {
      const inClause = buildInClause(idChunk);
      const chatClause = chatChunk.length > 0 ? buildInClause(chatChunk) : null;
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
                u.timezone,
                u.preference_generation
           FROM telegram_subscriptions sub
          JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
          WHERE sub.stablecoin_id IN (${inClause.sql})
            ${chatClause ? `AND sub.chat_id IN (${chatClause.sql})` : ""}
            AND sub.${alertColumn} = 1
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
            AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      )
      .bind(...inClause.binds, ...(chatClause?.binds ?? []), nowSec, nowSec)
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
          preference_generation: row.preference_generation ?? 0,
          isGlobal: false,
          hasLocalOverride: true,
        });
        map.set(row.stablecoin_id, existing);
      }
    }
  }
  return map;
}

export async function loadGlobalSubscriberRows(
  db: D1Database,
  type: TelegramAlertType,
  nowSec: number,
  options: TelegramSubscriberLoadOptions = {},
): Promise<SubscriberRow[]> {
  const alertColumn = GLOBAL_COLUMN_BY_TYPE[type];
  if (!VALID_GLOBAL_ALERT_COLUMNS.has(alertColumn)) {
    throw new Error(`Invalid global alert subscription column for ${type}`);
  }
  const chatIds = normalizedChatIds(options);
  if (chatIds?.length === 0) return [];
  const loaded: SubscriberRow[] = [];
  for (const chatChunk of chatIds ? chunkArray(chatIds, D1_MAX_BOUND_PARAMETERS - 1) : [[]]) {
    const chatClause = chatChunk.length > 0 ? buildInClause(chatChunk) : null;
    const result = await db.prepare(
      // SAFETY: alertColumn comes from GLOBAL_ALERT_COLUMN_BY_TYPE and is
      // validated against the hardcoded allowlist above before interpolation.
      `SELECT chat_id,
              last_active_at,
              quiet_hours_enabled,
              quiet_hours_start_utc,
              quiet_hours_end_utc,
              timezone,
              preference_generation,
              global_depeg_worsening_bps_step
         FROM telegram_subscribers
        WHERE ${alertColumn} = 1
          ${chatClause ? `AND chat_id IN (${chatClause.sql})` : ""}
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
    )
      .bind(...(chatClause?.binds ?? []), nowSec)
      .all<SubscriberRow>();
    loaded.push(...(result.results ?? []));
  }

  return loaded.map((row) => ({
    chat_id: row.chat_id,
    last_active_at: row.last_active_at,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: row.global_depeg_worsening_bps_step ?? null,
    quiet_hours_enabled: row.quiet_hours_enabled ?? 0,
    quiet_hours_start_utc: row.quiet_hours_start_utc ?? null,
    quiet_hours_end_utc: row.quiet_hours_end_utc ?? null,
    timezone: row.timezone ?? null,
    preference_generation: row.preference_generation ?? 0,
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
  options: TelegramSubscriberLoadOptions = {},
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const unique = Array.from(new Set(stablecoinIds));
  if (unique.length === 0) return map;
  const chatIds = normalizedChatIds(options);
  if (chatIds?.length === 0) return map;
  for (const chatChunk of chatIds ? chunkArray(chatIds, 45) : [[]]) {
    for (const idChunk of chunkArray(unique, D1_MAX_BOUND_PARAMETERS - 1 - chatChunk.length)) {
      const inClause = buildInClause(idChunk);
      const chatClause = chatChunk.length > 0 ? buildInClause(chatChunk) : null;
      const result = await db
      .prepare(
        `SELECT stablecoin_id, chat_id
          FROM telegram_subscriptions
          WHERE stablecoin_id IN (${inClause.sql})
            ${chatClause ? `AND chat_id IN (${chatClause.sql})` : ""}
            AND alert_snooze_until_ts IS NOT NULL
            AND alert_snooze_until_ts > ?`,
      )
      .bind(...inClause.binds, ...(chatClause?.binds ?? []), nowSec)
      .all<{ stablecoin_id: string; chat_id: string }>();
      for (const row of result.results ?? []) {
        const existing = map.get(row.stablecoin_id) ?? new Set<string>();
        existing.add(row.chat_id);
        map.set(row.stablecoin_id, existing);
      }
    }
  }
  return map;
}

/**
 * Load per-coin rows where a chat has explicitly disabled this alert type.
 * Alert flags are binary, so default zeroes from partial subscribe writes are
 * not enough to prove intent; only settings-style writes mark the matching
 * override column. The routing pass applies this map after direct/preset rows
 * are merged, so a local off row suppresses both preset and global fan-out for
 * the same (stablecoin, chat, alert type) tuple.
 */
export async function loadPerCoinExplicitlyOffMap(
  db: D1Database,
  stablecoinIds: readonly string[],
  type: TelegramAlertType,
  options: TelegramSubscriberLoadOptions = {},
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const unique = Array.from(new Set(stablecoinIds));
  if (unique.length === 0) return map;
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  const overrideColumn = ALERT_OVERRIDE_COLUMN_BY_TYPE[type];
  if (!VALID_ALERT_COLUMNS.has(alertColumn) || !VALID_ALERT_OVERRIDE_COLUMNS.has(overrideColumn)) {
    throw new Error(`Invalid alert subscription column for ${type}`);
  }
  const chatIds = normalizedChatIds(options);
  if (chatIds?.length === 0) return map;
  for (const chatChunk of chatIds ? chunkArray(chatIds, 45) : [[]]) {
    for (const idChunk of chunkArray(unique, D1_MAX_BOUND_PARAMETERS - chatChunk.length)) {
      const inClause = buildInClause(idChunk);
      const chatClause = chatChunk.length > 0 ? buildInClause(chatChunk) : null;
      const result = await db
      .prepare(
        // SAFETY: alertColumn/overrideColumn come from hardcoded maps and are
        // validated against hardcoded allowlists above before interpolation.
        `SELECT stablecoin_id, chat_id
          FROM telegram_subscriptions
          WHERE stablecoin_id IN (${inClause.sql})
            ${chatClause ? `AND chat_id IN (${chatClause.sql})` : ""}
            AND ${alertColumn} = 0
            AND ${overrideColumn} = 1`,
      )
      .bind(...inClause.binds, ...(chatClause?.binds ?? []))
      .all<{ stablecoin_id: string; chat_id: string }>();
      for (const row of result.results ?? []) {
        const existing = map.get(row.stablecoin_id) ?? new Set<string>();
        existing.add(row.chat_id);
        map.set(row.stablecoin_id, existing);
      }
    }
  }
  return map;
}

function mergeDepegWorseningStep(
  existing: number | null,
  additional: number | null,
): number | null {
  if (existing == null) return additional;
  if (additional == null) return existing;
  return Math.min(existing, additional);
}

function mergeSubscriberRows(existing: SubscriberRow, additional: SubscriberRow): SubscriberRow {
  if (existing.hasLocalOverride) return existing;
  if (additional.hasLocalOverride) return additional;
  return {
    ...existing,
    depeg_worsening_bps_step: mergeDepegWorseningStep(
      existing.depeg_worsening_bps_step,
      additional.depeg_worsening_bps_step,
    ),
  };
}

export function mergeSubscriberMaps(
  base: Map<string, SubscriberRow[]>,
  additional: Map<string, SubscriberRow[]>,
): Map<string, SubscriberRow[]> {
  for (const [stablecoinId, rows] of additional) {
    const existing = base.get(stablecoinId) ?? [];
    const indexByChat = new Map(existing.map((row, index) => [row.chat_id, index] as const));
    for (const row of rows) {
      const existingIndex = indexByChat.get(row.chat_id);
      if (existingIndex == null) {
        indexByChat.set(row.chat_id, existing.length);
        existing.push(row);
        continue;
      }
      existing[existingIndex] = mergeSubscriberRows(existing[existingIndex], row);
    }
    base.set(stablecoinId, existing);
  }
  return base;
}

export async function loadPresetSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: PresetAlertType,
  nowSec: number,
  options: TelegramPresetResolveOptions = {},
): Promise<PresetSubscriberLoadResult> {
  if (stablecoinIds.length === 0) return { kind: "ok", rows: new Map() };
  const memberships = await resolvePresetMemberships(db, {
    alertType: type,
    wantedStablecoinIds: stablecoinIds,
    nowSec,
    options,
  });
  if (memberships.kind === "query-failed") {
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset query failed",
      action: "preset-query",
      module: "dispatch-telegram-subscribers",
      failureKind: "query-failed",
      alertType: type,
      requestedStablecoinCount: stablecoinIds.length,
    });
    return { kind: "query-failed", error: memberships.error };
  }
  if (memberships.kind === "resolution-failed") {
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset resolution failed",
      action: "preset-resolution",
      module: "dispatch-telegram-subscribers",
      failureKind: "resolution-failed",
      alertType: type,
      reason: memberships.reason,
      presetCount: listTelegramPresets().length,
      subscriberRowCount: 1,
      requestedStablecoinCount: stablecoinIds.length,
    });
    return { kind: "resolution-failed" };
  }
  if (!memberships.hasCandidates || memberships.memberships.length === 0) {
    return { kind: "ok", rows: new Map() };
  }
  const presetIds = [...new Set(memberships.memberships.map((membership) => membership.preset_id))];
  const followers = await loadActivePresetFollowers(db, {
    alertType: type,
    presetIds,
    nowSec,
  });
  if (followers.kind === "query-failed") {
    logTelegramEvent({
      level: "warn",
      message: "dynamic preset query failed",
      action: "preset-query",
      module: "dispatch-telegram-subscribers",
      failureKind: "query-failed",
      alertType: type,
      requestedStablecoinCount: stablecoinIds.length,
    });
    return { kind: "query-failed", error: followers.error };
  }
  return { kind: "ok", rows: projectPresetFollowers(memberships.memberships, followers.followers) };
}
