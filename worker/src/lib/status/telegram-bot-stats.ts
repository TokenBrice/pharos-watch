import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { TelegramBotStats } from "@shared/types/status";
import {
  loadTelegramTopFollowedCoins,
  refreshTelegramLifecycleSnapshotIfStale,
  type TelegramCurrentLifecycleSnapshot,
} from "../telegram-usage-analytics";

interface TelegramBotAggregateRow {
  total_chats: number | string | null;
  alert_enabled_chats: number | string | null;
  deliverable_chats: number | string | null;
  subscribed_chats: number | string | null;
  empty_alert_chats: number | string | null;
  muted_chats_with_subscriptions: number | string | null;
  dews_chats: number | string | null;
  depeg_chats: number | string | null;
  safety_chats: number | string | null;
  launch_chats: number | string | null;
  all_types_chats: number | string | null;
  total_subscriptions: number | string | null;
  avg_subscriptions_per_subscribed_chat: number | string | null;
  last_subscriber_activity_at: number | string | null;
  custom_preference_chats: number | string | null;
  quiet_hours_enabled_chats: number | string | null;
  active_preset_followers?: number | string | null;
}

interface TelegramBotPendingRow {
  pending_count: number | string | null;
}

interface TelegramBotPendingDeliveryTelemetryRow {
  pending_count: number | string | null;
  oldest_created_at: number | string | null;
  due_count: number | string | null;
  deferred_count: number | string | null;
  expired_count: number | string | null;
}

interface TelegramBotRetryErrorClassRow {
  error_class: string | null;
  pending_count: number | string | null;
}

interface TelegramBotTopStablecoinRow {
  stablecoin_id: string;
  subscribers: number | string | null;
  explicit_subscribers?: number | string | null;
  preset_implied_subscribers?: number | string | null;
}

const TELEGRAM_PENDING_ALERT_TTL_SEC = 3600;
const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";
const INACTIVE_CLEANUP_WINDOW_SEC = 7 * 24 * 60 * 60;
const INACTIVE_CLEANUP_JOB = "telegram-inactive-cleanup";

const TELEGRAM_BOT_AGGREGATE_SQL = `SELECT
  COUNT(*) AS total_chats,
  SUM(
    CASE
      WHEN COALESCE(sub.active_sub_count, 0) > 0
        OR s.global_alert_dews = 1
        OR s.global_alert_depeg = 1
        OR s.global_alert_safety = 1
        OR s.global_alert_launch = 1
        OR s.alert_dews = 1
        OR s.alert_depeg = 1
        OR s.alert_safety = 1
        OR s.alert_launch = 1
        OR COALESCE(preset.active_preset_count, 0) > 0
      THEN 1 ELSE 0
    END
  ) AS alert_enabled_chats,
  SUM(
    CASE
      WHEN COALESCE(sub.active_sub_count, 0) > 0
        OR s.global_alert_dews = 1
        OR s.global_alert_depeg = 1
        OR s.global_alert_safety = 1
        OR s.global_alert_launch = 1
        OR COALESCE(preset.active_preset_count, 0) > 0
      THEN 1 ELSE 0
    END
  ) AS deliverable_chats,
  SUM(
    CASE
      WHEN COALESCE(sub.sub_count, 0) > 0 OR COALESCE(preset.active_preset_count, 0) > 0
      THEN 1 ELSE 0
    END
  ) AS subscribed_chats,
  SUM(
    CASE
      WHEN (s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1 OR s.alert_launch = 1)
        AND s.global_alert_dews = 0
        AND s.global_alert_depeg = 0
        AND s.global_alert_safety = 0
        AND s.global_alert_launch = 0
        AND COALESCE(sub.sub_count, 0) = 0
        AND COALESCE(preset.active_preset_count, 0) = 0
      THEN 1 ELSE 0
    END
  ) AS empty_alert_chats,
  SUM(
    CASE
      WHEN (COALESCE(sub.sub_count, 0) > 0 OR COALESCE(preset.preset_count, 0) > 0)
        AND COALESCE(sub.active_sub_count, 0) = 0
        AND COALESCE(preset.active_preset_count, 0) = 0
      THEN 1 ELSE 0
    END
  ) AS muted_chats_with_subscriptions,
  SUM(CASE WHEN COALESCE(sub.dews_enabled, 0) = 1 OR COALESCE(preset.dews_enabled, 0) = 1 OR s.global_alert_dews = 1 THEN 1 ELSE 0 END) AS dews_chats,
  SUM(CASE WHEN COALESCE(sub.depeg_enabled, 0) = 1 OR COALESCE(preset.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_chats,
  SUM(CASE WHEN COALESCE(sub.safety_enabled, 0) = 1 OR COALESCE(preset.safety_enabled, 0) = 1 OR s.global_alert_safety = 1 THEN 1 ELSE 0 END) AS safety_chats,
  SUM(CASE WHEN COALESCE(sub.launch_enabled, 0) = 1 OR s.global_alert_launch = 1 THEN 1 ELSE 0 END) AS launch_chats,
  SUM(
    CASE
      WHEN (COALESCE(sub.dews_enabled, 0) = 1 OR COALESCE(preset.dews_enabled, 0) = 1 OR s.global_alert_dews = 1)
        AND (COALESCE(sub.depeg_enabled, 0) = 1 OR COALESCE(preset.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1)
        AND (COALESCE(sub.safety_enabled, 0) = 1 OR COALESCE(preset.safety_enabled, 0) = 1 OR s.global_alert_safety = 1)
        AND (COALESCE(sub.launch_enabled, 0) = 1 OR s.global_alert_launch = 1)
      THEN 1 ELSE 0
    END
  ) AS all_types_chats,
  SUM(COALESCE(sub.sub_count, 0)) AS total_subscriptions,
  AVG(CASE WHEN COALESCE(sub.sub_count, 0) > 0 THEN sub.sub_count END) AS avg_subscriptions_per_subscribed_chat,
  MAX(s.last_active_at) AS last_subscriber_activity_at,
  SUM(CASE WHEN COALESCE(sub.custom_preferences, 0) = 1 THEN 1 ELSE 0 END) AS custom_preference_chats,
  SUM(CASE WHEN COALESCE(s.quiet_hours_enabled, 0) = 1 THEN 1 ELSE 0 END) AS quiet_hours_enabled_chats,
  SUM(CASE WHEN COALESCE(preset.active_preset_count, 0) > 0 THEN 1 ELSE 0 END) AS active_preset_followers
FROM telegram_subscribers s
LEFT JOIN (
  SELECT chat_id,
         COUNT(*) AS sub_count,
         SUM(
           CASE
             WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 OR alert_launch = 1
             THEN 1 ELSE 0
           END
         ) AS active_sub_count,
         MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
         MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
         MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled,
         MAX(CASE WHEN alert_launch = 1 THEN 1 ELSE 0 END) AS launch_enabled,
         MAX(
           CASE
             WHEN alert_dews = 0
               OR alert_depeg = 0
               OR alert_safety = 0
               OR dews_min_band IS NOT NULL
               OR safety_mode IS NOT NULL
               OR depeg_worsening_bps_step IS NOT NULL
             THEN 1 ELSE 0
           END
         ) AS custom_preferences
    FROM telegram_subscriptions
   GROUP BY chat_id
) sub ON sub.chat_id = s.chat_id
LEFT JOIN (
  SELECT chat_id,
         COUNT(*) AS preset_count,
         SUM(
           CASE
             WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1
             THEN 1 ELSE 0
           END
         ) AS active_preset_count,
         MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
         MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
         MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled
    FROM telegram_preset_subscriptions
   GROUP BY chat_id
) preset ON preset.chat_id = s.chat_id`;

const TELEGRAM_PENDING_DISAMBIGUATION_SQL =
  "SELECT COUNT(*) AS pending_count FROM telegram_pending_disambiguation WHERE expires_at > ?";
const TELEGRAM_PENDING_DELIVERIES_SQL =
  "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts";
const TELEGRAM_PENDING_DELIVERY_TELEMETRY_SQL = `SELECT
  COUNT(*) AS pending_count,
  MIN(created_at) AS oldest_created_at,
  SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) AS expired_count,
  SUM(
    CASE
      WHEN created_at >= ? AND (not_before_at IS NULL OR not_before_at <= ?)
      THEN 1 ELSE 0
    END
  ) AS due_count,
  SUM(
    CASE
      WHEN created_at >= ? AND not_before_at > ?
      THEN 1 ELSE 0
    END
  ) AS deferred_count
 FROM telegram_pending_alerts`;
const TELEGRAM_RETRY_ERROR_CLASSES_SQL = `SELECT last_error_class AS error_class, COUNT(*) AS pending_count
  FROM telegram_pending_alerts
 WHERE last_error_class IS NOT NULL
   AND last_error_class <> ''
 GROUP BY last_error_class
 ORDER BY pending_count DESC, last_error_class ASC
 LIMIT 10`;
function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function coerceNullableTimestamp(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMetric(value: unknown, digits = 2): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

async function loadTelegramBotAggregate(db: D1Database): Promise<TelegramBotAggregateRow | null> {
  return db.prepare(TELEGRAM_BOT_AGGREGATE_SQL).first<TelegramBotAggregateRow>();
}

async function loadTelegramPendingCount(
  db: D1Database,
  sql: string,
  bindValue?: number,
): Promise<TelegramBotPendingRow | null> {
  const statement = bindValue == null ? db.prepare(sql) : db.prepare(sql).bind(bindValue);
  return statement.first<TelegramBotPendingRow>();
}

async function loadTelegramPendingDeliveryTelemetry(
  db: D1Database,
  now: number,
): Promise<TelegramBotPendingDeliveryTelemetryRow | null> {
  const cutoff = now - TELEGRAM_PENDING_ALERT_TTL_SEC;
  try {
    return await db
      .prepare(TELEGRAM_PENDING_DELIVERY_TELEMETRY_SQL)
      .bind(cutoff, cutoff, now, cutoff, now)
      .first<TelegramBotPendingDeliveryTelemetryRow>();
  } catch {
    return null;
  }
}

async function loadTelegramRetryErrorClasses(db: D1Database): Promise<TelegramBotRetryErrorClassRow[] | null> {
  try {
    const result = await db.prepare(TELEGRAM_RETRY_ERROR_CLASSES_SQL).all<TelegramBotRetryErrorClassRow>();
    return result.results ?? [];
  } catch {
    return null;
  }
}

async function loadTelegramTopStablecoins(db: D1Database): Promise<TelegramBotTopStablecoinRow[]> {
  const rows = await loadTelegramTopFollowedCoins(db, 5);
  return rows.map((row) => ({
    stablecoin_id: row.stablecoinId,
    subscribers: row.subscribers,
    explicit_subscribers: row.explicitSubscribers,
    preset_implied_subscribers: row.presetImpliedSubscribers,
  }));
}

async function loadInactiveSubscribersCleanedThisWeek(
  db: D1Database,
  now: number,
): Promise<number | null> {
  try {
    const cutoff = now - INACTIVE_CLEANUP_WINDOW_SEC;
    const row = await db
      .prepare(
        "SELECT item_count FROM cron_runs WHERE job = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1",
      )
      .bind(INACTIVE_CLEANUP_JOB, cutoff)
      .first<{ item_count: number | string | null }>();
    if (!row) return null;
    const parsed = Number(row.item_count ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  } catch {
    return null;
  }
}

async function loadPresetQueryFailureCount(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .bind(PRESET_QUERY_FAILURE_CACHE_KEY)
      .first<{ value: string }>();
    if (!row) return 0;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

export function mapTelegramBotStats(input: {
  now?: number;
  aggregate: TelegramBotAggregateRow | null;
  pendingDisambiguations: TelegramBotPendingRow | null;
  pendingDeliveries: TelegramBotPendingRow | null;
  pendingDeliveryTelemetry?: TelegramBotPendingDeliveryTelemetryRow | null;
  retryErrorClasses?: TelegramBotRetryErrorClassRow[] | null;
  topStablecoins: TelegramBotTopStablecoinRow[];
  presetQueryFailures?: number;
  inactiveSubscribersCleanedThisWeek?: number | null;
  lifecycleSnapshot?: TelegramCurrentLifecycleSnapshot | null;
}): TelegramBotStats {
  const {
    aggregate,
    pendingDisambiguations,
    pendingDeliveries,
    pendingDeliveryTelemetry,
    retryErrorClasses,
    topStablecoins,
    presetQueryFailures,
    inactiveSubscribersCleanedThisWeek,
    lifecycleSnapshot,
  } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);

  const pendingCount = coerceCount(pendingDeliveries?.pending_count ?? pendingDeliveryTelemetry?.pending_count);
  const oldestCreatedAt = coerceNullableTimestamp(pendingDeliveryTelemetry?.oldest_created_at);
  const retryErrorClassCounts = retryErrorClasses?.reduce<Record<string, number>>((acc, row) => {
    const errorClass = row.error_class?.trim();
    if (errorClass) {
      acc[errorClass] = coerceCount(row.pending_count);
    }
    return acc;
  }, {});

  const explicitCoinSubscriptions = coerceCount(aggregate?.total_subscriptions);
  const presetImpliedCoinSubscriptions = lifecycleSnapshot?.presetImpliedCoinFollows ?? 0;
  const activePresetFollowers =
    lifecycleSnapshot?.activePresetFollowers ?? coerceCount(aggregate?.active_preset_followers);

  const stats: TelegramBotStats = {
    totalChats: coerceCount(aggregate?.total_chats),
    alertEnabledChats: coerceCount(aggregate?.alert_enabled_chats),
    deliverableChats: coerceCount(aggregate?.deliverable_chats),
    subscribedChats: coerceCount(aggregate?.subscribed_chats),
    emptyAlertChats: coerceCount(aggregate?.empty_alert_chats),
    mutedChatsWithSubscriptions: coerceCount(aggregate?.muted_chats_with_subscriptions),
    totalSubscriptions: explicitCoinSubscriptions + presetImpliedCoinSubscriptions,
    explicitCoinSubscriptions,
    presetImpliedCoinSubscriptions,
    activePresetFollowers,
    avgSubscriptionsPerSubscribedChat: roundMetric(aggregate?.avg_subscriptions_per_subscribed_chat, 1),
    pendingDisambiguations: coerceCount(pendingDisambiguations?.pending_count),
    pendingDeliveries: pendingCount,
    lastSubscriberActivityAt: coerceNullableTimestamp(aggregate?.last_subscriber_activity_at),
    customPreferenceChats: coerceCount(aggregate?.custom_preference_chats),
    quietHoursEnabledChats: coerceCount(aggregate?.quiet_hours_enabled_chats),
    alertTypeChats: {
      dews: coerceCount(aggregate?.dews_chats),
      depeg: coerceCount(aggregate?.depeg_chats),
      safety: coerceCount(aggregate?.safety_chats),
      launch: coerceCount(aggregate?.launch_chats),
      allTypes: coerceCount(aggregate?.all_types_chats),
    },
    topStablecoins: topStablecoins.map((row) => ({
      stablecoinId: row.stablecoin_id,
      symbol: TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
      subscribers: coerceCount(row.subscribers),
      explicitSubscribers: coerceCount(row.explicit_subscribers ?? row.subscribers),
      presetImpliedSubscribers: coerceCount(row.preset_implied_subscribers),
    })),
  };

  if (lifecycleSnapshot) {
    stats.lifecycleSnapshot = {
      date: lifecycleSnapshot.day,
      snapshotAt: lifecycleSnapshot.snapshotAt,
      activeWatchers: lifecycleSnapshot.activeWatchers,
      newWatchers: lifecycleSnapshot.newWatchers,
      churnedWatchers: lifecycleSnapshot.churnedWatchers,
      reactivatedWatchers: lifecycleSnapshot.reactivatedWatchers,
      explicitCoinFollows: lifecycleSnapshot.explicitCoinFollows,
      presetImpliedCoinFollows: lifecycleSnapshot.presetImpliedCoinFollows,
      activePresetFollowers: lifecycleSnapshot.activePresetFollowers,
      alertTypeOptIns: lifecycleSnapshot.alertTypeOptIns,
      quietHoursEnabledChats: lifecycleSnapshot.quietHoursEnabledChats,
      pendingDeliveries: lifecycleSnapshot.pendingDeliveries,
    };
  }

  if (pendingDeliveryTelemetry) {
    stats.oldestPendingDeliveryAgeSec =
      pendingCount > 0 && oldestCreatedAt != null ? Math.max(0, now - oldestCreatedAt) : null;
    stats.pendingDeliveryBacklog = {
      due: coerceCount(pendingDeliveryTelemetry.due_count),
      deferred: coerceCount(pendingDeliveryTelemetry.deferred_count),
      expired: coerceCount(pendingDeliveryTelemetry.expired_count),
    };
  }

  if (retryErrorClassCounts) {
    stats.retryErrorClassCounts = retryErrorClassCounts;
  }

  if (presetQueryFailures != null && presetQueryFailures > 0) {
    stats.presetQueryFailures = coerceCount(presetQueryFailures);
  }

  if (inactiveSubscribersCleanedThisWeek !== undefined) {
    stats.inactiveSubscribersCleanedThisWeek = inactiveSubscribersCleanedThisWeek;
  }

  return stats;
}

export async function getTelegramBotStats(db: D1Database, now: number): Promise<TelegramBotStats> {
  const [
    aggregate,
    pendingDisambiguations,
    pendingDeliveries,
    pendingDeliveryTelemetry,
    retryErrorClasses,
    topStablecoins,
    presetQueryFailures,
    inactiveSubscribersCleanedThisWeek,
    lifecycleSnapshot,
  ] = await Promise.all([
    loadTelegramBotAggregate(db),
    loadTelegramPendingCount(db, TELEGRAM_PENDING_DISAMBIGUATION_SQL, now),
    loadTelegramPendingCount(db, TELEGRAM_PENDING_DELIVERIES_SQL),
    loadTelegramPendingDeliveryTelemetry(db, now),
    loadTelegramRetryErrorClasses(db),
    loadTelegramTopStablecoins(db),
    loadPresetQueryFailureCount(db),
    loadInactiveSubscribersCleanedThisWeek(db, now),
    refreshTelegramLifecycleSnapshotIfStale(db, now).catch(() => null),
  ]);

  return mapTelegramBotStats({
    now,
    aggregate,
    pendingDisambiguations,
    pendingDeliveries,
    pendingDeliveryTelemetry,
    retryErrorClasses,
    topStablecoins,
    presetQueryFailures,
    inactiveSubscribersCleanedThisWeek,
    lifecycleSnapshot,
  });
}
