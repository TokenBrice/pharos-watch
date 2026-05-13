import type { TelegramAlertTypeChats, TelegramWatcherHistoryPoint } from "@shared/types/status";
import {
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "./telegram-presets";

export type TelegramUsageEventType =
  | "start"
  | "deep_link"
  | "setup_choice"
  | "setup_complete"
  | "subscribe"
  | "unsubscribe"
  | "preset_follow"
  | "preset_unfollow"
  | "global_alert_change"
  | "quiet_hours_change"
  | "snooze_change"
  | "timezone_change"
  | "group_admin_denial"
  | "unknown_command"
  | "command"
  | "reply_failure";

export type TelegramLifecycleHistorySource = "snapshot" | "live-fallback";

export interface TelegramUsageEventInput {
  nowSec?: number;
  eventType: TelegramUsageEventType;
  sourceCategory?: string | null;
  actionDetail?: string | null;
  outcome?: string | null;
  latencyMs?: number | null;
  latencyBucket?: string | null;
  failureClass?: string | null;
}

export interface TelegramCurrentLifecycleSnapshot {
  day: string;
  snapshotAt: number;
  activeWatchers: number;
  newWatchers: number;
  churnedWatchers: number;
  reactivatedWatchers: number;
  explicitCoinFollows: number;
  presetImpliedCoinFollows: number;
  activePresetFollowers: number;
  alertTypeOptIns: TelegramAlertTypeChats;
  quietHoursEnabledChats: number;
  pendingDeliveries: number;
}

export interface TelegramTopFollowedCoin {
  stablecoinId: string;
  explicitSubscribers: number;
  presetImpliedSubscribers: number;
  subscribers: number;
}

export interface TelegramLifecycleHistory {
  source: TelegramLifecycleHistorySource;
  points: TelegramWatcherHistoryPoint[];
}

interface CurrentAggregateRow {
  active_watchers: number | string | null;
  new_watchers: number | string | null;
  explicit_coin_follows: number | string | null;
  active_preset_followers: number | string | null;
  active_dews_opt_ins: number | string | null;
  active_depeg_opt_ins: number | string | null;
  active_safety_opt_ins: number | string | null;
  active_launch_opt_ins: number | string | null;
  active_all_types_opt_ins: number | string | null;
  quiet_hours_enabled_chats: number | string | null;
}

interface PresetFollowerRow {
  preset_id: string;
  followers: number | string | null;
}

interface ExplicitTopCoinRow {
  stablecoin_id: string;
  subscribers: number | string | null;
}

interface LifecycleSnapshotRow {
  day: string | null;
  snapshot_at: number | string | null;
  active_watchers: number | string | null;
  new_watchers: number | string | null;
  churned_watchers: number | string | null;
  reactivated_watchers: number | string | null;
}

interface PendingCountRow {
  pending_count: number | string | null;
}

interface DeliveryDiagnosticsRow {
  last_successful_delivery_at: number | string | null;
  last_successful_reply_at: number | string | null;
  recent_failure_class: string | null;
}

export interface TelegramChatHealthDiagnostics {
  lastSuccessfulDeliveryAt: number | null;
  lastSuccessfulReplyAt: number | null;
  recentFailureClass: string | null;
}

const SNAPSHOT_REFRESH_INTERVAL_SEC = 15 * 60;
const DELIVERY_DIAGNOSTIC_BATCH_SIZE = 100;
const ACTIVE_SUBSCRIPTION_FLAGS = `alert_dews = 1
  OR alert_depeg = 1
  OR alert_safety = 1
  OR alert_launch = 1`;
const ACTIVE_PRESET_FLAGS = `alert_dews = 1
  OR alert_depeg = 1
  OR alert_safety = 1`;

const ACTIVE_EXPLICIT_SUBS_BY_CHAT_SQL = `SELECT chat_id,
        SUM(CASE WHEN ${ACTIVE_SUBSCRIPTION_FLAGS} THEN 1 ELSE 0 END) AS active_sub_count,
        MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
        MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
        MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled,
        MAX(CASE WHEN alert_launch = 1 THEN 1 ELSE 0 END) AS launch_enabled
   FROM telegram_subscriptions
  GROUP BY chat_id`;

const ACTIVE_PRESETS_BY_CHAT_SQL = `SELECT chat_id,
        COUNT(*) AS active_preset_count,
        MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
        MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
        MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled
   FROM telegram_preset_subscriptions
  WHERE ${ACTIVE_PRESET_FLAGS}
  GROUP BY chat_id`;

const ACTIVE_WATCHER_CONDITION = `s.global_alert_dews = 1
  OR s.global_alert_depeg = 1
  OR s.global_alert_safety = 1
  OR s.global_alert_launch = 1
  OR COALESCE(sub.active_sub_count, 0) > 0
  OR COALESCE(preset.active_preset_count, 0) > 0`;

function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function coerceNullableTimestamp(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayFromUnixSeconds(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

function dayStartSeconds(day: string): number {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function clampDimension(value: string | null | undefined, fallback: string, maxLength = 64): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  const safe = normalized.replace(/[^a-z0-9_./:-]/g, "_");
  return safe.slice(0, maxLength) || fallback;
}

export function bucketTelegramCommandLatency(latencyMs: number | null | undefined): string {
  if (latencyMs == null || !Number.isFinite(latencyMs) || latencyMs < 0) return "unknown";
  if (latencyMs < 250) return "lt_250ms";
  if (latencyMs < 1_000) return "250ms_1s";
  if (latencyMs < 3_000) return "1s_3s";
  if (latencyMs < 10_000) return "3s_10s";
  return "gte_10s";
}

export function classifyTelegramStartSource(args: string): string {
  const token = args.trim().split(/\s+/)[0] ?? "";
  if (!token) return "none";
  const lower = token.toLowerCase();
  if (lower === "setup") return "setup";
  if (lower.startsWith("sub_")) return "subscribe";
  if (lower.startsWith("status_")) return "status";
  if (lower.startsWith("why_")) return "why";
  if (lower.startsWith("coverage_")) return "coverage";
  return "unknown";
}

export async function recordTelegramUsageEvent(
  db: D1Database,
  input: TelegramUsageEventInput,
): Promise<void> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const day = dayFromUnixSeconds(nowSec);
  const latencyBucket =
    input.latencyBucket ?? bucketTelegramCommandLatency(input.latencyMs);
  try {
    await db
      .prepare(
        `INSERT INTO telegram_usage_daily (
           day,
           event_type,
           source_category,
           action_detail,
           outcome,
           latency_bucket,
           failure_class,
           count,
           first_seen_at,
           last_seen_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(
           day,
           event_type,
           source_category,
           action_detail,
           outcome,
           latency_bucket,
           failure_class
         ) DO UPDATE SET
           count = telegram_usage_daily.count + 1,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        day,
        input.eventType,
        clampDimension(input.sourceCategory, "unknown"),
        clampDimension(input.actionDetail, ""),
        clampDimension(input.outcome, "unknown"),
        clampDimension(latencyBucket, "unknown"),
        clampDimension(input.failureClass, ""),
        nowSec,
        nowSec,
      )
      .run();
  } catch {
    // Usage telemetry must never block a user-facing bot command.
  }
}

async function loadActivePresetFollowerRows(db: D1Database): Promise<PresetFollowerRow[]> {
  try {
    const result = await db
      .prepare(
        `SELECT preset_id, COUNT(DISTINCT chat_id) AS followers
           FROM telegram_preset_subscriptions
          WHERE ${ACTIVE_PRESET_FLAGS}
          GROUP BY preset_id`,
      )
      .all<PresetFollowerRow>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

async function calculatePresetImpliedCoinFollows(
  db: D1Database,
  rows?: PresetFollowerRow[],
): Promise<{ total: number; byCoin: Map<string, number> }> {
  const presetRows = rows ?? await loadActivePresetFollowerRows(db);
  const presetIds = presetRows
    .map((row) => row.preset_id)
    .filter((id): id is TelegramPresetId => Boolean(id));
  if (presetIds.length === 0) {
    return { total: 0, byCoin: new Map() };
  }

  const resolved = await resolveTelegramPresetTargets(db, presetIds);
  if (resolved.kind !== "ok") {
    return { total: 0, byCoin: new Map() };
  }

  const followersByPreset = new Map(
    presetRows.map((row) => [row.preset_id, coerceCount(row.followers)] as const),
  );
  const byCoin = new Map<string, number>();
  let total = 0;
  for (const preset of resolved.presets) {
    const followers = followersByPreset.get(preset.definition.id) ?? 0;
    if (followers <= 0) continue;
    total += followers * preset.stablecoinIds.length;
    for (const stablecoinId of preset.stablecoinIds) {
      byCoin.set(stablecoinId, (byCoin.get(stablecoinId) ?? 0) + followers);
    }
  }
  return { total, byCoin };
}

async function loadPendingDeliveryCount(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts")
      .first<PendingCountRow>();
    return coerceCount(row?.pending_count);
  } catch {
    return 0;
  }
}

async function loadPreviousLifecycleSnapshot(
  db: D1Database,
  day: string,
): Promise<LifecycleSnapshotRow | null> {
  try {
    return await db
      .prepare(
        `SELECT day, snapshot_at, active_watchers, new_watchers, churned_watchers, reactivated_watchers
           FROM telegram_watcher_lifecycle_daily
          WHERE day < ?
          ORDER BY day DESC
          LIMIT 1`,
      )
      .bind(day)
      .first<LifecycleSnapshotRow>();
  } catch {
    return null;
  }
}

export async function computeTelegramCurrentLifecycleSnapshot(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<TelegramCurrentLifecycleSnapshot> {
  const day = dayFromUnixSeconds(nowSec);
  const start = dayStartSeconds(day);
  const end = start + 24 * 60 * 60;
  const [aggregate, presetRows, pendingDeliveries, previousSnapshot] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${ACTIVE_WATCHER_CONDITION} THEN 1 ELSE 0 END) AS active_watchers,
           SUM(
             CASE
               WHEN (${ACTIVE_WATCHER_CONDITION}) AND s.created_at >= ? AND s.created_at < ?
               THEN 1 ELSE 0
             END
           ) AS new_watchers,
           SUM(COALESCE(sub.active_sub_count, 0)) AS explicit_coin_follows,
           SUM(CASE WHEN COALESCE(preset.active_preset_count, 0) > 0 THEN 1 ELSE 0 END) AS active_preset_followers,
           SUM(
             CASE
               WHEN COALESCE(sub.dews_enabled, 0) = 1
                 OR COALESCE(preset.dews_enabled, 0) = 1
                 OR s.global_alert_dews = 1
               THEN 1 ELSE 0
             END
           ) AS active_dews_opt_ins,
           SUM(
             CASE
               WHEN COALESCE(sub.depeg_enabled, 0) = 1
                 OR COALESCE(preset.depeg_enabled, 0) = 1
                 OR s.global_alert_depeg = 1
               THEN 1 ELSE 0
             END
           ) AS active_depeg_opt_ins,
           SUM(
             CASE
               WHEN COALESCE(sub.safety_enabled, 0) = 1
                 OR COALESCE(preset.safety_enabled, 0) = 1
                 OR s.global_alert_safety = 1
               THEN 1 ELSE 0
             END
           ) AS active_safety_opt_ins,
           SUM(
             CASE
               WHEN COALESCE(sub.launch_enabled, 0) = 1
                 OR s.global_alert_launch = 1
               THEN 1 ELSE 0
             END
           ) AS active_launch_opt_ins,
           SUM(
             CASE
               WHEN (
                   COALESCE(sub.dews_enabled, 0) = 1
                   OR COALESCE(preset.dews_enabled, 0) = 1
                   OR s.global_alert_dews = 1
                 )
                 AND (
                   COALESCE(sub.depeg_enabled, 0) = 1
                   OR COALESCE(preset.depeg_enabled, 0) = 1
                   OR s.global_alert_depeg = 1
                 )
                 AND (
                   COALESCE(sub.safety_enabled, 0) = 1
                   OR COALESCE(preset.safety_enabled, 0) = 1
                   OR s.global_alert_safety = 1
                 )
                 AND (
                   COALESCE(sub.launch_enabled, 0) = 1
                   OR s.global_alert_launch = 1
                 )
               THEN 1 ELSE 0
             END
           ) AS active_all_types_opt_ins,
           SUM(CASE WHEN COALESCE(s.quiet_hours_enabled, 0) = 1 THEN 1 ELSE 0 END) AS quiet_hours_enabled_chats
         FROM telegram_subscribers s
         LEFT JOIN (${ACTIVE_EXPLICIT_SUBS_BY_CHAT_SQL}) sub ON sub.chat_id = s.chat_id
         LEFT JOIN (${ACTIVE_PRESETS_BY_CHAT_SQL}) preset ON preset.chat_id = s.chat_id`,
      )
      .bind(start, end)
      .first<CurrentAggregateRow>(),
    loadActivePresetFollowerRows(db),
    loadPendingDeliveryCount(db),
    loadPreviousLifecycleSnapshot(db, day),
  ]);

  const presetImplied = await calculatePresetImpliedCoinFollows(db, presetRows);
  const activeWatchers = coerceCount(aggregate?.active_watchers);
  const newWatchers = coerceCount(aggregate?.new_watchers);
  const previousActiveWatchers = coerceCount(previousSnapshot?.active_watchers);
  // With daily aggregate snapshots, churn/reactivation are inferred from the
  // net active-count movement plus new-watchers. This avoids storing extra
  // per-user lifecycle state while making historical public points stable.
  const churnedWatchers = previousSnapshot
    ? Math.max(0, previousActiveWatchers + newWatchers - activeWatchers)
    : 0;
  const reactivatedWatchers = previousSnapshot
    ? Math.max(0, activeWatchers - previousActiveWatchers - newWatchers)
    : 0;

  return {
    day,
    snapshotAt: nowSec,
    activeWatchers,
    newWatchers,
    churnedWatchers,
    reactivatedWatchers,
    explicitCoinFollows: coerceCount(aggregate?.explicit_coin_follows),
    presetImpliedCoinFollows: presetImplied.total,
    activePresetFollowers: coerceCount(aggregate?.active_preset_followers),
    alertTypeOptIns: {
      dews: coerceCount(aggregate?.active_dews_opt_ins),
      depeg: coerceCount(aggregate?.active_depeg_opt_ins),
      safety: coerceCount(aggregate?.active_safety_opt_ins),
      launch: coerceCount(aggregate?.active_launch_opt_ins),
      allTypes: coerceCount(aggregate?.active_all_types_opt_ins),
    },
    quietHoursEnabledChats: coerceCount(aggregate?.quiet_hours_enabled_chats),
    pendingDeliveries,
  };
}

async function loadCurrentSnapshotAge(db: D1Database, day: string): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT snapshot_at FROM telegram_watcher_lifecycle_daily WHERE day = ?")
      .bind(day)
      .first<{ snapshot_at: number | string | null }>();
    return coerceNullableTimestamp(row?.snapshot_at);
  } catch {
    return null;
  }
}

async function upsertTelegramLifecycleSnapshot(
  db: D1Database,
  snapshot: TelegramCurrentLifecycleSnapshot,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO telegram_watcher_lifecycle_daily (
           day,
           snapshot_at,
           active_watchers,
           new_watchers,
           churned_watchers,
           reactivated_watchers,
           explicit_coin_follows,
           preset_implied_coin_follows,
           active_preset_followers,
           active_dews_opt_ins,
           active_depeg_opt_ins,
           active_safety_opt_ins,
           active_launch_opt_ins,
           quiet_hours_enabled_chats,
           pending_deliveries
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           snapshot_at = excluded.snapshot_at,
           active_watchers = excluded.active_watchers,
           new_watchers = excluded.new_watchers,
           churned_watchers = excluded.churned_watchers,
           reactivated_watchers = excluded.reactivated_watchers,
           explicit_coin_follows = excluded.explicit_coin_follows,
           preset_implied_coin_follows = excluded.preset_implied_coin_follows,
           active_preset_followers = excluded.active_preset_followers,
           active_dews_opt_ins = excluded.active_dews_opt_ins,
           active_depeg_opt_ins = excluded.active_depeg_opt_ins,
           active_safety_opt_ins = excluded.active_safety_opt_ins,
           active_launch_opt_ins = excluded.active_launch_opt_ins,
           quiet_hours_enabled_chats = excluded.quiet_hours_enabled_chats,
           pending_deliveries = excluded.pending_deliveries`,
      )
      .bind(
        snapshot.day,
        snapshot.snapshotAt,
        snapshot.activeWatchers,
        snapshot.newWatchers,
        snapshot.churnedWatchers,
        snapshot.reactivatedWatchers,
        snapshot.explicitCoinFollows,
        snapshot.presetImpliedCoinFollows,
        snapshot.activePresetFollowers,
        snapshot.alertTypeOptIns.dews,
        snapshot.alertTypeOptIns.depeg,
        snapshot.alertTypeOptIns.safety,
        snapshot.alertTypeOptIns.launch,
        snapshot.quietHoursEnabledChats,
        snapshot.pendingDeliveries,
      )
      .run();
  } catch {
    // Snapshot writes are best-effort; callers can still return live aggregates.
  }
}

export async function refreshTelegramLifecycleSnapshotIfStale(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
  precomputed?: TelegramCurrentLifecycleSnapshot,
): Promise<TelegramCurrentLifecycleSnapshot> {
  const snapshot = precomputed ?? await computeTelegramCurrentLifecycleSnapshot(db, nowSec);
  const existingSnapshotAt = await loadCurrentSnapshotAge(db, snapshot.day);
  if (existingSnapshotAt == null || nowSec - existingSnapshotAt >= SNAPSHOT_REFRESH_INTERVAL_SEC) {
    await upsertTelegramLifecycleSnapshot(db, snapshot);
  }
  return snapshot;
}

export async function loadTelegramLifecycleHistory(
  db: D1Database,
): Promise<TelegramLifecycleHistory> {
  try {
    const result = await db
      .prepare(
        `SELECT day, snapshot_at, active_watchers, new_watchers, churned_watchers, reactivated_watchers
           FROM telegram_watcher_lifecycle_daily
          ORDER BY day ASC`,
      )
      .all<LifecycleSnapshotRow>();
    const points = (result.results ?? [])
      .map((row) => {
        const day = row.day ?? "";
        const timestamp = dayStartSeconds(day) * 1000;
        return {
          date: day,
          timestamp,
          newWatchers: coerceCount(row.new_watchers),
          activeWatchers: coerceCount(row.active_watchers),
          churnedWatchers: coerceCount(row.churned_watchers),
          reactivatedWatchers: coerceCount(row.reactivated_watchers),
        };
      })
      .filter((point) => point.date && Number.isFinite(point.timestamp) && point.timestamp > 0);
    if (points.length > 0) {
      return { source: "snapshot", points };
    }
  } catch {
    // Fall through to live fallback in the caller.
  }
  return { source: "live-fallback", points: [] };
}

export async function loadTelegramTopFollowedCoins(
  db: D1Database,
  limit = 5,
): Promise<TelegramTopFollowedCoin[]> {
  const [explicitResult, presetRows] = await Promise.all([
    db
      .prepare(
        `SELECT stablecoin_id, COUNT(DISTINCT chat_id) AS subscribers
           FROM telegram_subscriptions
          WHERE ${ACTIVE_SUBSCRIPTION_FLAGS}
          GROUP BY stablecoin_id`,
      )
      .all<ExplicitTopCoinRow>()
      .catch(() => ({ results: [] as ExplicitTopCoinRow[] })),
    loadActivePresetFollowerRows(db),
  ]);
  const presetImplied = await calculatePresetImpliedCoinFollows(db, presetRows);
  const byCoin = new Map<string, TelegramTopFollowedCoin>();

  for (const row of explicitResult.results ?? []) {
    const explicitSubscribers = coerceCount(row.subscribers);
    byCoin.set(row.stablecoin_id, {
      stablecoinId: row.stablecoin_id,
      explicitSubscribers,
      presetImpliedSubscribers: 0,
      subscribers: explicitSubscribers,
    });
  }

  for (const [stablecoinId, presetImpliedSubscribers] of presetImplied.byCoin) {
    const existing = byCoin.get(stablecoinId);
    if (existing) {
      existing.presetImpliedSubscribers = presetImpliedSubscribers;
      existing.subscribers = existing.explicitSubscribers + presetImpliedSubscribers;
    } else {
      byCoin.set(stablecoinId, {
        stablecoinId,
        explicitSubscribers: 0,
        presetImpliedSubscribers,
        subscribers: presetImpliedSubscribers,
      });
    }
  }

  return [...byCoin.values()]
    .sort((a, b) => b.subscribers - a.subscribers || a.stablecoinId.localeCompare(b.stablecoinId))
    .slice(0, limit);
}

export async function recordTelegramReplyOutcome(
  db: D1Database,
  input: {
    chatId: string;
    ok: boolean;
    errorClass?: string | null;
    nowSec?: number;
  },
): Promise<void> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  try {
    await db
      .prepare(
        `INSERT INTO telegram_chat_delivery_diagnostics (
           chat_id,
           last_successful_delivery_at,
           last_successful_reply_at,
           last_delivery_attempt_at,
           recent_failure_class,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           last_successful_delivery_at = COALESCE(
             excluded.last_successful_delivery_at,
             telegram_chat_delivery_diagnostics.last_successful_delivery_at
           ),
           last_successful_reply_at = COALESCE(
             excluded.last_successful_reply_at,
             telegram_chat_delivery_diagnostics.last_successful_reply_at
           ),
           last_delivery_attempt_at = excluded.last_delivery_attempt_at,
           recent_failure_class = excluded.recent_failure_class,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.chatId,
        input.ok ? nowSec : null,
        input.ok ? nowSec : null,
        nowSec,
        input.ok ? null : input.errorClass ?? "unknown",
        nowSec,
      )
      .run();
  } catch {
    // Diagnostics must not block command replies.
  }
}

export async function recordTelegramDeliveryOutcomes(
  db: D1Database,
  inputs: Array<{
    chatId: string;
    ok: boolean;
    errorClass?: string | null;
    nowSec?: number;
  }>,
): Promise<void> {
  if (inputs.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    for (let offset = 0; offset < inputs.length; offset += DELIVERY_DIAGNOSTIC_BATCH_SIZE) {
      const chunk = inputs.slice(offset, offset + DELIVERY_DIAGNOSTIC_BATCH_SIZE);
      await db.batch(chunk.map((input) => {
        const at = input.nowSec ?? nowSec;
        return db
          .prepare(
            `INSERT INTO telegram_chat_delivery_diagnostics (
               chat_id,
               last_successful_delivery_at,
               last_successful_reply_at,
               last_delivery_attempt_at,
               recent_failure_class,
               updated_at
             )
             VALUES (?, ?, NULL, ?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET
               last_successful_delivery_at = COALESCE(
                 excluded.last_successful_delivery_at,
                 telegram_chat_delivery_diagnostics.last_successful_delivery_at
               ),
               last_delivery_attempt_at = excluded.last_delivery_attempt_at,
               recent_failure_class = excluded.recent_failure_class,
               updated_at = excluded.updated_at`,
          )
          .bind(
            input.chatId,
            input.ok ? at : null,
            at,
            input.ok ? null : input.errorClass ?? "unknown",
            at,
          );
      }));
    }
  } catch {
    // Diagnostics must not block alert delivery.
  }
}

export async function loadTelegramChatHealthDiagnostics(
  db: D1Database,
  chatId: string,
): Promise<TelegramChatHealthDiagnostics | null> {
  try {
    const row = await db
      .prepare(
        `SELECT last_successful_delivery_at, last_successful_reply_at, recent_failure_class
           FROM telegram_chat_delivery_diagnostics
          WHERE chat_id = ?`,
      )
      .bind(chatId)
      .first<DeliveryDiagnosticsRow>();
    if (!row) return null;
    return {
      lastSuccessfulDeliveryAt: coerceNullableTimestamp(row.last_successful_delivery_at),
      lastSuccessfulReplyAt: coerceNullableTimestamp(row.last_successful_reply_at),
      recentFailureClass: row.recent_failure_class ?? null,
    };
  } catch {
    return null;
  }
}
