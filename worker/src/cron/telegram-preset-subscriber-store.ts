import type { TelegramAlertType } from "@shared/types/status";
import { buildInClause } from "../lib/db";
import {
  listTelegramPresets,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
  type TelegramPresetResolveOptions,
} from "../lib/telegram/presets";
import type { SubscriberRow } from "./dispatch-telegram-routing";

export type PresetAlertType = Extract<TelegramAlertType, "dews" | "depeg" | "safety">;

export const PRESET_ALERT_TYPES: readonly PresetAlertType[] = ["dews", "depeg", "safety"];

export const PRESET_ALERT_COLUMN: Record<PresetAlertType, string> = {
  dews: "alert_dews",
  depeg: "alert_depeg",
  safety: "alert_safety",
};

export interface PresetMembership {
  preset_id: TelegramPresetId;
  stablecoin_id: string;
}

export type PresetMembershipResult =
  | { kind: "ok"; hasCandidates: boolean; memberships: PresetMembership[] }
  | { kind: "query-failed"; error: unknown }
  | { kind: "resolution-failed"; reason: string };

export interface PresetFollower {
  preset_id: TelegramPresetId;
  chat_id: string;
  stablecoin_id?: string;
  last_active_at: number;
  depeg_worsening_bps_step: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
  preference_generation?: number | null;
}

export interface PresetFollowerCursor {
  chatId: string;
  presetId: TelegramPresetId;
}

export type PresetFollowerPage =
  | {
      kind: "ok";
      followers: PresetFollower[];
      hasMore: boolean;
      nextCursor: PresetFollowerCursor | null;
    }
  | { kind: "query-failed"; error: unknown };

export async function resolvePresetMemberships(
  db: D1Database,
  args: {
    alertType: PresetAlertType;
    wantedStablecoinIds: readonly string[];
    nowSec: number;
    options?: TelegramPresetResolveOptions;
  },
): Promise<PresetMembershipResult> {
  const alertColumn = PRESET_ALERT_COLUMN[args.alertType];
  const presetIds = listTelegramPresets().map((preset) => preset.id);
  const presetClause = buildInClause(presetIds);
  let hasCandidates = false;
  try {
    const candidate = await db
      .prepare(
        `SELECT 1 AS has_row
           FROM telegram_preset_subscriptions p
           JOIN telegram_subscribers u ON u.chat_id = p.chat_id
          WHERE p.${alertColumn} = 1
            AND p.preset_id IN (${presetClause.sql})
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          LIMIT 1`,
      )
      .bind(...presetClause.binds, args.nowSec)
      .first<{ has_row: number }>();
    hasCandidates = candidate != null;
  } catch (error) {
    return { kind: "query-failed", error };
  }

  if (!hasCandidates) return { kind: "ok", hasCandidates: false, memberships: [] };

  const resolved = await resolveTelegramPresetTargets(db, presetIds, args.options);
  if (resolved.kind !== "ok") {
    return { kind: "resolution-failed", reason: resolved.reason };
  }

  const wanted = new Set(args.wantedStablecoinIds);
  return {
    kind: "ok",
    hasCandidates: true,
    memberships: resolved.presets.flatMap((preset) =>
      preset.stablecoinIds
        .filter((stablecoinId) => wanted.has(stablecoinId))
        .map((stablecoinId) => ({
          preset_id: preset.definition.id,
          stablecoin_id: stablecoinId,
        })),
    ),
  };
}

export async function loadActivePresetFollowers(
  db: D1Database,
  args: {
    alertType: PresetAlertType;
    presetIds: readonly TelegramPresetId[];
    nowSec: number;
    cursor?: PresetFollowerCursor | null;
    chatIds?: readonly string[];
    limit?: number;
  },
): Promise<PresetFollowerPage> {
  if (args.presetIds.length === 0) {
    return { kind: "ok", followers: [], hasMore: false, nextCursor: null };
  }
  const chatIds = args.chatIds == null ? null : [...new Set(args.chatIds)];
  if (chatIds?.length === 0) {
    return { kind: "ok", followers: [], hasMore: false, nextCursor: null };
  }

  const alertColumn = PRESET_ALERT_COLUMN[args.alertType];
  const presetClause = buildInClause(args.presetIds);
  const chatClause = chatIds == null ? null : buildInClause(chatIds);
  const cursorPredicate = args.cursor == null
    ? ""
    : `AND (
         preset.chat_id > ?
         OR (preset.chat_id = ? AND preset.preset_id > ?)
       )`;
  const cursorBinds = args.cursor == null
    ? []
    : [args.cursor.chatId, args.cursor.chatId, args.cursor.presetId];
  const bounded = args.limit != null || args.cursor != null || chatClause != null;
  const sql = bounded
    ? `SELECT preset.chat_id,
                preset.preset_id,
                subscriber.last_active_at,
                preset.depeg_worsening_bps_step,
                subscriber.quiet_hours_enabled,
                subscriber.quiet_hours_start_utc,
                subscriber.quiet_hours_end_utc,
                subscriber.timezone
           FROM telegram_preset_subscriptions preset
           JOIN telegram_subscribers subscriber ON subscriber.chat_id = preset.chat_id
          WHERE preset.${alertColumn} = 1
            AND preset.preset_id IN (${presetClause.sql})
            ${chatClause ? `AND preset.chat_id IN (${chatClause.sql})` : ""}
            AND (subscriber.alert_snooze_until_ts IS NULL OR subscriber.alert_snooze_until_ts <= ?)
            ${cursorPredicate}
          ORDER BY preset.chat_id ASC, preset.preset_id ASC
          ${args.limit == null ? "" : "LIMIT ?"}`
    : `SELECT p.chat_id,
                p.preset_id,
                u.last_active_at,
                p.depeg_worsening_bps_step,
                u.quiet_hours_enabled,
                u.quiet_hours_start_utc,
                u.quiet_hours_end_utc,
                u.timezone,
                u.preference_generation
           FROM telegram_preset_subscriptions p
          JOIN telegram_subscribers u ON u.chat_id = p.chat_id
          WHERE p.${alertColumn} = 1
            AND p.preset_id IN (${presetClause.sql})
            AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)`;
  const binds = [
    ...presetClause.binds,
    ...(chatClause?.binds ?? []),
    args.nowSec,
    ...cursorBinds,
    ...(args.limit == null ? [] : [args.limit + 1]),
  ];

  let rows: PresetFollower[];
  try {
    const result = await db.prepare(sql).bind(...binds).all<PresetFollower>();
    rows = result.results ?? [];
  } catch (error) {
    return { kind: "query-failed", error };
  }

  if (args.limit == null) {
    return { kind: "ok", followers: rows, hasMore: false, nextCursor: null };
  }
  const pageRows = rows.slice(0, args.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    kind: "ok",
    followers: pageRows,
    hasMore: rows.length > args.limit,
    nextCursor: last
      ? { chatId: last.chat_id, presetId: last.preset_id }
      : null,
  };
}

export function projectPresetFollowers(
  memberships: readonly PresetMembership[],
  followers: readonly PresetFollower[],
): Map<string, SubscriberRow[]> {
  const stablecoinIdsByPreset = new Map<TelegramPresetId, string[]>();
  for (const membership of memberships) {
    const stablecoinIds = stablecoinIdsByPreset.get(membership.preset_id) ?? [];
    stablecoinIds.push(membership.stablecoin_id);
    stablecoinIdsByPreset.set(membership.preset_id, stablecoinIds);
  }

  const map = new Map<string, SubscriberRow[]>();
  for (const follower of followers) {
    const stablecoinIds = follower.stablecoin_id == null
      ? stablecoinIdsByPreset.get(follower.preset_id) ?? []
      : [follower.stablecoin_id];
    for (const stablecoinId of stablecoinIds) {
      const rows = map.get(stablecoinId) ?? [];
      rows.push({
        chat_id: follower.chat_id,
        last_active_at: Number(follower.last_active_at),
        dews_min_band: null,
        safety_mode: null,
        depeg_worsening_bps_step: follower.depeg_worsening_bps_step ?? null,
        quiet_hours_enabled: follower.quiet_hours_enabled ?? 0,
        quiet_hours_start_utc: follower.quiet_hours_start_utc ?? null,
        quiet_hours_end_utc: follower.quiet_hours_end_utc ?? null,
        timezone: follower.timezone ?? null,
        preference_generation: follower.preference_generation ?? 0,
        isGlobal: false,
        hasLocalOverride: false,
      });
      map.set(stablecoinId, rows);
    }
  }
  return map;
}
