import { logWorkerEventArgs } from "../../lib/structured-log";
import { PENDING_DELIVERY_STATES } from "../common/constants";
import type { TelegramAlertTypeChats, TelegramWatcherHistoryPoint } from "@shared/types/status";
import { TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS } from "@shared/lib/status-thresholds";
import { formatIsoDate } from "@shared/lib/format";
import {
  ACTIVE_PRESET_FLAGS_SQL,
  ACTIVE_SUBSCRIPTION_FLAGS_SQL,
  ACTIVE_WATCHER_SQL_CONDITION,
  TELEGRAM_LIFECYCLE_OPT_IN_PROJECTIONS_SQL,
  buildActivePresetAggregateSql,
  buildActiveSubscriptionAggregateSql,
} from "@shared/lib/telegram-alert-families";
import {
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../common/presets";
export {
  UNKNOWN_COMMAND_ACTION_DETAIL,
  bucketTelegramCommandLatency,
  classifyTelegramStartSource,
  recordTelegramDeliveryOutcomes,
  recordTelegramReplyOutcome,
  recordTelegramUsageEvent,
  recordTelegramUsageEvents,
  type TelegramUsageEventInput,
  type TelegramUsageEventType,
} from "./usage-analytics-writes";

export type TelegramLifecycleHistorySource = "snapshot";

export interface TelegramCurrentLifecycleSnapshot {
  day: string;
  snapshotAt: number;
  activeWatchers: number;
  newWatchers: number | null;
  churnedWatchers: number | null;
  reactivatedWatchers: number | null;
  explicitCoinFollows: number;
  presetImpliedCoinFollows: number | null;
  activePresetFollowers: number;
  alertTypeOptIns: TelegramAlertTypeChats;
  quietHoursEnabledChats: number;
  pendingDeliveries: number;
  unavailableFields?: string[];
}

export interface TelegramCurrentLifecycleSnapshotOptions {
  pendingDeliveryCount?: number;
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
  explicit_coin_follows: number | string | null;
  active_preset_followers: number | string | null;
  active_dews_opt_ins: number | string | null;
  active_depeg_opt_ins: number | string | null;
  active_safety_opt_ins: number | string | null;
  active_launch_opt_ins: number | string | null;
  active_reserve_opt_ins: number | string | null;
  active_freeze_opt_ins: number | string | null;
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

interface LifecycleEventCountRow {
  subscribe_events: number | string | null;
  unsubscribe_events: number | string | null;
  reactivate_events: number | string | null;
}

type AnalyticsResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "unavailable" };

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

const SNAPSHOT_REFRESH_INTERVAL_SEC = TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS;
const LIFECYCLE_HISTORY_DAYS = 90;
const PENDING_DELIVERY_STATE_PLACEHOLDERS = PENDING_DELIVERY_STATES.map(() => "?").join(", ");

// Both per-chat rollups come from the canonical family manifest (TGB-028), so the
// pulse aggregate cannot drift from the status/bot aggregates or the plan checks.
const ACTIVE_EXPLICIT_SUBS_BY_CHAT_SQL = buildActiveSubscriptionAggregateSql({
  includeFamilyFlags: true,
});

const ACTIVE_PRESETS_BY_CHAT_SQL = buildActivePresetAggregateSql({
  activeRowsOnly: true,
  includeFamilyFlags: true,
});

export function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function coerceNullableTimestamp(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayFromUnixSeconds(nowSec: number): string {
  return formatIsoDate(nowSec);
}

function dayStartSeconds(day: string): number {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}


async function loadActivePresetFollowerRows(db: D1Database): Promise<AnalyticsResult<PresetFollowerRow[]>> {
  try {
    const result = await db
      .prepare(
        `SELECT preset_id, COUNT(DISTINCT chat_id) AS followers
           FROM telegram_preset_subscriptions
          WHERE ${ACTIVE_PRESET_FLAGS_SQL}
          GROUP BY preset_id`,
      )
      .all<PresetFollowerRow>();
    return { kind: "ok", value: result.results ?? [] };
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[telegram-analytics] loadActivePresetFollowerRows failed:", err);
    return { kind: "unavailable" };
  }
}

async function calculatePresetImpliedCoinFollows(
  db: D1Database,
  rows?: AnalyticsResult<PresetFollowerRow[]>,
): Promise<AnalyticsResult<{ total: number; byCoin: Map<string, number> }>> {
  const presetRows = rows ?? await loadActivePresetFollowerRows(db);
  if (presetRows.kind === "unavailable") return presetRows;
  const presetIds = presetRows.value
    .map((row) => row.preset_id)
    .filter((id): id is TelegramPresetId => Boolean(id));
  if (presetIds.length === 0) {
    return { kind: "ok", value: { total: 0, byCoin: new Map() } };
  }

  const resolved = await resolveTelegramPresetTargets(db, presetIds);
  if (resolved.kind !== "ok") {
    return { kind: "unavailable" };
  }

  const followersByPreset = new Map(
    presetRows.value.map((row) => [row.preset_id, coerceCount(row.followers)] as const),
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
  return { kind: "ok", value: { total, byCoin } };
}

async function loadPendingDeliveryCount(
  db: D1Database,
): Promise<{ count: number; unavailableFields: string[] }> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS pending_count
           FROM telegram_pending_alerts
          WHERE delivery_state IN (${PENDING_DELIVERY_STATE_PLACEHOLDERS})`,
      )
      .bind(...PENDING_DELIVERY_STATES)
      .first<PendingCountRow>();
    return { count: coerceCount(row?.pending_count), unavailableFields: [] };
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[telegram-analytics] loadPendingDeliveryCount failed:", err);
    return { count: 0, unavailableFields: ["pendingDeliveries"] };
  }
}

async function loadLifecycleEventCounts(
  db: D1Database,
  day: string,
): Promise<AnalyticsResult<LifecycleEventCountRow>> {
  try {
    const row = await db
      .prepare(
        `SELECT subscribe_events, unsubscribe_events, reactivate_events
           FROM telegram_watcher_lifecycle_events_daily
          WHERE day = ?`,
      )
      .bind(day)
      .first<LifecycleEventCountRow>();
    return {
      kind: "ok",
      value: row ?? { subscribe_events: 0, unsubscribe_events: 0, reactivate_events: 0 },
    };
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[telegram-analytics] loadLifecycleEventCounts failed:", err);
    return { kind: "unavailable" };
  }
}

export async function computeTelegramCurrentLifecycleSnapshot(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
  options: TelegramCurrentLifecycleSnapshotOptions = {},
): Promise<TelegramCurrentLifecycleSnapshot> {
  const day = dayFromUnixSeconds(nowSec);
  const [aggregate, presetRows, pendingDeliveries, lifecycleEvents] = await Promise.all([
    db
      .prepare(
        // SAFETY: Interpolated lifecycle projections and rollups use only canonical family identifiers.
        `SELECT
           SUM(CASE WHEN ${ACTIVE_WATCHER_SQL_CONDITION} THEN 1 ELSE 0 END) AS active_watchers,
           SUM(COALESCE(sub.active_sub_count, 0)) AS explicit_coin_follows,
           SUM(CASE WHEN COALESCE(preset.active_preset_count, 0) > 0 THEN 1 ELSE 0 END) AS active_preset_followers,
           ${TELEGRAM_LIFECYCLE_OPT_IN_PROJECTIONS_SQL},
           SUM(CASE WHEN COALESCE(s.quiet_hours_enabled, 0) = 1 THEN 1 ELSE 0 END) AS quiet_hours_enabled_chats
         FROM telegram_subscribers s
         LEFT JOIN (${ACTIVE_EXPLICIT_SUBS_BY_CHAT_SQL}) sub ON sub.chat_id = s.chat_id
         LEFT JOIN (${ACTIVE_PRESETS_BY_CHAT_SQL}) preset ON preset.chat_id = s.chat_id`,
      )
      .first<CurrentAggregateRow>(),
    loadActivePresetFollowerRows(db),
    options.pendingDeliveryCount == null
      ? loadPendingDeliveryCount(db)
      : Promise.resolve({ count: options.pendingDeliveryCount, unavailableFields: [] }),
    loadLifecycleEventCounts(db, day),
  ]);

  const presetImplied = await calculatePresetImpliedCoinFollows(db, presetRows);
  const unavailableFields = [...pendingDeliveries.unavailableFields];
  if (presetImplied.kind === "unavailable") {
    unavailableFields.push("presetImpliedCoinSubscriptions", "topCoins");
  }
  if (lifecycleEvents.kind === "unavailable") {
    unavailableFields.push("newWatchers", "churnedWatchers", "reactivatedWatchers");
  }
  const lifecycleCounts = lifecycleEvents.kind === "ok" ? lifecycleEvents.value : null;

  return {
    day,
    snapshotAt: nowSec,
    activeWatchers: coerceCount(aggregate?.active_watchers),
    newWatchers: lifecycleCounts == null ? null : coerceCount(lifecycleCounts.subscribe_events),
    churnedWatchers: lifecycleCounts == null ? null : coerceCount(lifecycleCounts.unsubscribe_events),
    reactivatedWatchers: lifecycleCounts == null ? null : coerceCount(lifecycleCounts.reactivate_events),
    explicitCoinFollows: coerceCount(aggregate?.explicit_coin_follows),
    presetImpliedCoinFollows: presetImplied.kind === "ok" ? presetImplied.value.total : null,
    activePresetFollowers: coerceCount(aggregate?.active_preset_followers),
    alertTypeOptIns: {
      dews: coerceCount(aggregate?.active_dews_opt_ins),
      depeg: coerceCount(aggregate?.active_depeg_opt_ins),
      safety: coerceCount(aggregate?.active_safety_opt_ins),
      launch: coerceCount(aggregate?.active_launch_opt_ins),
      reserve: coerceCount(aggregate?.active_reserve_opt_ins),
      freeze: coerceCount(aggregate?.active_freeze_opt_ins),
      allTypes: coerceCount(aggregate?.active_all_types_opt_ins),
    },
    quietHoursEnabledChats: coerceCount(aggregate?.quiet_hours_enabled_chats),
    pendingDeliveries: pendingDeliveries.count,
    unavailableFields,
  };
}

async function loadCurrentSnapshotAge(db: D1Database, day: string): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT snapshot_at FROM telegram_watcher_lifecycle_daily WHERE day = ?")
      .bind(day)
      .first<{ snapshot_at: number | string | null }>();
    return coerceNullableTimestamp(row?.snapshot_at);
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[telegram-analytics] loadCurrentSnapshotAge failed:", err);
    return null;
  }
}

async function upsertTelegramLifecycleSnapshot(
  db: D1Database,
  snapshot: TelegramCurrentLifecycleSnapshot,
): Promise<void> {
  if (
    snapshot.newWatchers == null
    || snapshot.churnedWatchers == null
    || snapshot.reactivatedWatchers == null
    || snapshot.presetImpliedCoinFollows == null
    || snapshot.unavailableFields?.includes("pendingDeliveries")
  ) {
    // The daily table has no availability marker: never persist a failed pending read as zero.
    return;
  }
  // NOTE: reserve and freeze opt-ins are computed live (above) but intentionally not persisted here.
  // The telegram_watcher_lifecycle_daily table has no active_reserve_opt_ins or
  // active_freeze_opt_ins columns (migration 0123). Persisting either family would require a
  // coordinated D1 migration; live counts still surface via the live aggregate query.
  const columns = [
    ["day", snapshot.day],
    ["snapshot_at", snapshot.snapshotAt],
    ["active_watchers", snapshot.activeWatchers],
    ["new_watchers", snapshot.newWatchers],
    ["churned_watchers", snapshot.churnedWatchers],
    ["reactivated_watchers", snapshot.reactivatedWatchers],
    ["explicit_coin_follows", snapshot.explicitCoinFollows],
    ["preset_implied_coin_follows", snapshot.presetImpliedCoinFollows],
    ["active_preset_followers", snapshot.activePresetFollowers],
    ["active_dews_opt_ins", snapshot.alertTypeOptIns.dews],
    ["active_depeg_opt_ins", snapshot.alertTypeOptIns.depeg],
    ["active_safety_opt_ins", snapshot.alertTypeOptIns.safety],
    ["active_launch_opt_ins", snapshot.alertTypeOptIns.launch],
    ["quiet_hours_enabled_chats", snapshot.quietHoursEnabledChats],
    ["pending_deliveries", snapshot.pendingDeliveries],
  ] as const;
  try {
    await db
      .prepare(
        // SAFETY: Identifiers come from the fixed local supported-column list; snapshot values are bound.
        `INSERT INTO telegram_watcher_lifecycle_daily (${columns.map(([column]) => column).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT(day) DO UPDATE SET ${columns.slice(1)
           .map(([column]) => `${column} = excluded.${column}`).join(",\n           ")}`,
      )
      .bind(...columns.map(([, value]) => value))
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
  nowSec = Math.floor(Date.now() / 1000),
): Promise<TelegramLifecycleHistory> {
  const currentDay = dayFromUnixSeconds(nowSec);
  const firstDay = dayFromUnixSeconds(nowSec - LIFECYCLE_HISTORY_DAYS * 24 * 60 * 60);
  const result = await db
    .prepare(
      `SELECT day, snapshot_at, active_watchers, new_watchers, churned_watchers, reactivated_watchers
         FROM (
           SELECT day, snapshot_at, active_watchers, new_watchers, churned_watchers, reactivated_watchers
             FROM telegram_watcher_lifecycle_daily
            WHERE day >= ? AND day < ?
            ORDER BY day DESC
            LIMIT ?
         )
        ORDER BY day ASC`,
    )
    .bind(firstDay, currentDay, LIFECYCLE_HISTORY_DAYS)
    .all<LifecycleSnapshotRow>();
  const points = (result.results ?? [])
    .map((row) => {
      const day = row.day ?? "";
      const timestamp = dayStartSeconds(day) * 1000;
      return {
        date: day,
        timestamp,
        snapshotAt: coerceNullableTimestamp(row.snapshot_at),
        newWatchers: coerceCount(row.new_watchers),
        activeWatchers: coerceCount(row.active_watchers),
        churnedWatchers: coerceCount(row.churned_watchers),
        reactivatedWatchers: coerceCount(row.reactivated_watchers),
      };
    })
    .filter(
      (point) =>
        point.date
        && point.date < currentDay
        && Number.isFinite(point.timestamp)
        && point.timestamp > 0,
    );
  return { source: "snapshot", points };
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
          WHERE ${ACTIVE_SUBSCRIPTION_FLAGS_SQL}
          GROUP BY stablecoin_id`,
      )
      .all<ExplicitTopCoinRow>(),
    loadActivePresetFollowerRows(db),
  ]);
  const presetImplied = await calculatePresetImpliedCoinFollows(db, presetRows);
  if (presetImplied.kind === "unavailable") {
    throw new Error("Telegram preset follow telemetry unavailable");
  }
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

  for (const [stablecoinId, presetImpliedSubscribers] of presetImplied.value.byCoin) {
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
