import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  TelegramBotStats,
  TelegramDeliverySliRollup,
  TelegramDeliverySliStatus,
} from "@shared/types/status";
import { formatIsoDate } from "@shared/lib/format";
import { toErrorMessage } from "../error-utils";
import {
  coerceCount,
  coerceNullableTimestamp,
  loadTelegramTopFollowedCoins,
  refreshTelegramLifecycleSnapshotIfStale,
  type TelegramCurrentLifecycleSnapshot,
} from "../telegram-usage-analytics";
import {
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
  PENDING_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "../telegram-constants";
import { EXECUTION_UNKNOWN_SAMPLE_LIMIT } from "../../cron/telegram-pending";
import { loadTelegramDeliverySliRollup } from "../telegram-delivery-sli";

const TELEGRAM_DELIVERY_ACCEPTANCE_DEFINITION = "telegram_bot_api_accepted_not_user_receipt" as const;

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
  reserve_chats: number | string | null;
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
  planned_count?: number | string | null;
  started_count?: number | string | null;
  execution_unknown_count?: number | string | null;
  oldest_planned_at?: number | string | null;
  oldest_ambiguous_at?: number | string | null;
  sample_count?: number | string | null;
}

interface TelegramBotPendingDeliveryTelemetryRow {
  pending_count: number | string | null;
  oldest_created_at: number | string | null;
  oldest_due_created_at: number | string | null;
  due_count: number | string | null;
  deferred_count: number | string | null;
  expired_count: number | string | null;
  near_ttl_count: number | string | null;
  pending_sending_count?: number | string | null;
  pending_execution_unknown_count?: number | string | null;
  fresh_sending_count?: number | string | null;
  fresh_execution_unknown_count?: number | string | null;
  oldest_pending_execution_unknown_at?: number | string | null;
  oldest_fresh_execution_unknown_at?: number | string | null;
  execution_unknown_sample_count?: number | string | null;
  execution_unknown_count?: number | string | null;
  completed_cleanup_count?: number | string | null;
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

export interface TelegramMiniAppDailyAggregateRow {
  mini_app_sessions: number | string | null;
  mini_app_mutations: number | string | null;
  mini_app_denied: number | string | null;
  mini_app_replay_claimed: number | string | null;
}

export interface TelegramMiniAppDailyAggregate {
  sessions: number;
  mutations: number;
  denied: number;
  replayClaimed: number;
}

interface OptionalTelegramTelemetry<T> {
  value: T | null;
  error?: string;
}

const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";
const INACTIVE_CLEANUP_WINDOW_SEC = 7 * 24 * 60 * 60;
const INACTIVE_CLEANUP_JOB = "telegram-inactive-cleanup";
const WEBHOOK_EFFECT_SAMPLE_LIMIT = 5_001;

const TELEGRAM_BOT_AGGREGATE_SQL = `SELECT
  COUNT(*) AS total_chats,
  SUM(
    CASE
      WHEN COALESCE(sub.active_sub_count, 0) > 0
        OR s.global_alert_dews = 1
        OR s.global_alert_depeg = 1
        OR s.global_alert_safety = 1
        OR s.global_alert_launch = 1
        OR s.global_alert_reserve = 1
        OR s.alert_dews = 1
        OR s.alert_depeg = 1
        OR s.alert_safety = 1
        OR s.alert_launch = 1
        OR s.alert_reserve = 1
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
        OR s.global_alert_reserve = 1
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
      WHEN (s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1 OR s.alert_launch = 1 OR s.alert_reserve = 1)
        AND s.global_alert_dews = 0
        AND s.global_alert_depeg = 0
        AND s.global_alert_safety = 0
        AND s.global_alert_launch = 0
        AND s.global_alert_reserve = 0
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
  SUM(CASE WHEN COALESCE(sub.reserve_enabled, 0) = 1 OR s.global_alert_reserve = 1 THEN 1 ELSE 0 END) AS reserve_chats,
  SUM(
    CASE
      WHEN (COALESCE(sub.dews_enabled, 0) = 1 OR COALESCE(preset.dews_enabled, 0) = 1 OR s.global_alert_dews = 1)
        AND (COALESCE(sub.depeg_enabled, 0) = 1 OR COALESCE(preset.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1)
        AND (COALESCE(sub.safety_enabled, 0) = 1 OR COALESCE(preset.safety_enabled, 0) = 1 OR s.global_alert_safety = 1)
        AND (COALESCE(sub.launch_enabled, 0) = 1 OR s.global_alert_launch = 1)
        AND (COALESCE(sub.reserve_enabled, 0) = 1 OR s.global_alert_reserve = 1)
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
             WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 OR alert_launch = 1 OR alert_reserve = 1
             THEN 1 ELSE 0
           END
         ) AS active_sub_count,
         MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
         MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
         MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled,
         MAX(CASE WHEN alert_launch = 1 THEN 1 ELSE 0 END) AS launch_enabled,
         MAX(CASE WHEN alert_reserve = 1 THEN 1 ELSE 0 END) AS reserve_enabled,
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
  "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts WHERE delivery_state = 'pending'";
export const TELEGRAM_PENDING_DELIVERY_TELEMETRY_SQL = `SELECT
  SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS pending_count,
  MIN(
    CASE
      WHEN delivery_state = 'pending'
       AND COALESCE(expires_at, created_at + ?) > ?
      THEN created_at
    END
  ) AS oldest_created_at,
  MIN(
    CASE
      WHEN delivery_state = 'pending'
       AND COALESCE(expires_at, created_at + ?) > ?
       AND (not_before_at IS NULL OR not_before_at <= ?)
      THEN created_at
    END
  ) AS oldest_due_created_at,
  SUM(
    CASE
      WHEN delivery_state = 'pending'
       AND COALESCE(expires_at, created_at + ?) <= ?
      THEN 1 ELSE 0
    END
  ) AS expired_count,
  SUM(
    CASE
      WHEN delivery_state = 'pending'
       AND COALESCE(expires_at, created_at + ?) > ?
       AND (not_before_at IS NULL OR not_before_at <= ?)
      THEN 1 ELSE 0
    END
  ) AS due_count,
  SUM(
    CASE
      WHEN delivery_state = 'pending'
       AND COALESCE(expires_at, created_at + ?) > ?
       AND not_before_at > ?
      THEN 1 ELSE 0
    END
  ) AS deferred_count,
  SUM(
    CASE
      WHEN delivery_state = 'pending'
       AND COALESCE(expires_at, created_at + ?) > ?
       AND COALESCE(expires_at, created_at + ?) <= ?
      THEN 1 ELSE 0
    END
  ) AS near_ttl_count
  ,SUM(CASE
         WHEN delivery_state = 'sending'
          AND COALESCE(delivery_started_at, created_at) > ?
         THEN 1 ELSE 0
       END) AS pending_sending_count
  ,SUM(CASE
         WHEN delivery_state = 'sending'
          AND COALESCE(delivery_started_at, created_at) <= ?
         THEN 1 ELSE 0
       END) AS pending_execution_unknown_count
  ,(SELECT SUM(CASE
                 WHEN effect_state = 'sending' AND effect_at > ?
                 THEN 1 ELSE 0
               END)
      FROM (
        SELECT effect_state, COALESCE(effect_started_at, effect_completed_at, created_at) AS effect_at
          FROM telegram_alert_job_targets
         WHERE effect_state IN ('sending', 'execution_unknown')
         ORDER BY COALESCE(effect_started_at, effect_completed_at, created_at) ASC
         LIMIT ?
      )) AS fresh_sending_count
  ,(SELECT SUM(CASE
                 WHEN effect_state = 'execution_unknown'
                   OR (effect_state = 'sending' AND effect_at <= ?)
                 THEN 1 ELSE 0
               END)
      FROM (
        SELECT effect_state, COALESCE(effect_started_at, effect_completed_at, created_at) AS effect_at
          FROM telegram_alert_job_targets
         WHERE effect_state IN ('sending', 'execution_unknown')
         ORDER BY COALESCE(effect_started_at, effect_completed_at, created_at) ASC
         LIMIT ?
      )) AS fresh_execution_unknown_count
  ,MIN(CASE
         WHEN delivery_state = 'sending'
          AND COALESCE(delivery_started_at, created_at) <= ?
         THEN COALESCE(delivery_started_at, created_at)
       END) AS oldest_pending_execution_unknown_at
  ,(SELECT MIN(CASE
                 WHEN effect_state = 'execution_unknown'
                   OR (effect_state = 'sending' AND effect_at <= ?)
                 THEN effect_at
               END)
      FROM (
        SELECT effect_state, COALESCE(effect_started_at, effect_completed_at, created_at) AS effect_at
          FROM telegram_alert_job_targets
         WHERE effect_state IN ('sending', 'execution_unknown')
         ORDER BY COALESCE(effect_started_at, effect_completed_at, created_at) ASC
         LIMIT ?
      )) AS oldest_fresh_execution_unknown_at
  ,(SELECT COUNT(*)
      FROM (
        SELECT 1
          FROM telegram_alert_job_targets
         WHERE effect_state IN ('sending', 'execution_unknown')
         LIMIT ?
      )) AS execution_unknown_sample_count
  ,SUM(CASE WHEN delivery_state = 'sent' THEN 1 ELSE 0 END) AS completed_cleanup_count
 FROM telegram_pending_alerts`;
const TELEGRAM_WEBHOOK_EFFECT_UNKNOWN_SQL = `SELECT
  SUM(CASE WHEN effect_state IN ('started', 'execution_unknown') THEN 1 ELSE 0 END) AS pending_count,
  SUM(CASE WHEN effect_state = 'planned' THEN 1 ELSE 0 END) AS planned_count,
  SUM(CASE WHEN effect_state = 'started' THEN 1 ELSE 0 END) AS started_count,
  SUM(CASE WHEN effect_state = 'execution_unknown' THEN 1 ELSE 0 END) AS execution_unknown_count,
  MIN(CASE WHEN effect_state = 'planned' THEN received_at END) AS oldest_planned_at,
  MIN(CASE WHEN effect_state IN ('started', 'execution_unknown')
           THEN COALESCE(effect_started_at, received_at) END) AS oldest_ambiguous_at,
  COUNT(*) AS sample_count
 FROM (
   SELECT effect_state, effect_started_at, received_at
     FROM telegram_processed_updates
    WHERE effect_state IN ('planned', 'started', 'execution_unknown')
      AND status <> 'processed'
    ORDER BY received_at ASC, update_id ASC
    LIMIT ${WEBHOOK_EFFECT_SAMPLE_LIMIT}
 )`;
const TELEGRAM_RETRY_ERROR_CLASSES_SQL = `SELECT last_error_class AS error_class, COUNT(*) AS pending_count
  FROM telegram_pending_alerts
 WHERE delivery_state = 'pending'
   AND last_error_class IS NOT NULL
   AND last_error_class <> ''
 GROUP BY last_error_class
 ORDER BY pending_count DESC, last_error_class ASC
 LIMIT 10`;
// Mini App events recorded by `telegram-mini-app.ts`:
// - successful mutations are tagged with the per-operation `mini_app_*` event
//   type returned by `mutationEventType`, plus the generic `mini_app_mutation`
//   fallback for unmapped operations;
// - denied mutations always use `mini_app_mutation_denied`;
// - the replay aggregate is reserved for a future producer and intentionally
//   omitted from the public pulse UI until such a producer exists.
const TELEGRAM_MINI_APP_SUCCESS_EVENT_TYPES = [
  "mini_app_mutation",
  "mini_app_recommended_setup",
  "mini_app_coin_add",
  "mini_app_coin_remove",
  "mini_app_quiet_hours",
  "mini_app_snooze",
  "mini_app_coin_snooze",
  "mini_app_forget",
] as const;
// These generic event types are also emitted by non-Mini-App bot flows, so
// only count rows whose Mini App recorder populated a Mini App source category.
const TELEGRAM_MINI_APP_SHARED_SUCCESS_EVENT_TYPES = ["timezone_change", "unsubscribe"] as const;
const TELEGRAM_MINI_APP_SOURCE_CATEGORIES = ["startapp", "menu_or_main_app"] as const;
const TELEGRAM_MINI_APP_SUCCESS_EVENT_PLACEHOLDERS = TELEGRAM_MINI_APP_SUCCESS_EVENT_TYPES.map(() => "?").join(", ");
const TELEGRAM_MINI_APP_SHARED_SUCCESS_EVENT_PLACEHOLDERS = TELEGRAM_MINI_APP_SHARED_SUCCESS_EVENT_TYPES.map(
  () => "?",
).join(", ");
const TELEGRAM_MINI_APP_SOURCE_CATEGORY_PLACEHOLDERS = TELEGRAM_MINI_APP_SOURCE_CATEGORIES.map(() => "?").join(", ");
const TELEGRAM_MINI_APP_DAILY_AGGREGATE_SQL = `SELECT
  SUM(CASE WHEN event_type = 'mini_app_session_valid' AND outcome = 'success' THEN count ELSE 0 END) AS mini_app_sessions,
  SUM(
    CASE
      WHEN (
        event_type IN (${TELEGRAM_MINI_APP_SUCCESS_EVENT_PLACEHOLDERS})
        OR (
          event_type IN (${TELEGRAM_MINI_APP_SHARED_SUCCESS_EVENT_PLACEHOLDERS})
          AND source_category IN (${TELEGRAM_MINI_APP_SOURCE_CATEGORY_PLACEHOLDERS})
        )
      )
      AND outcome = 'success' THEN count ELSE 0
    END
  ) AS mini_app_mutations,
  SUM(CASE WHEN event_type = 'mini_app_mutation_denied' THEN count ELSE 0 END) AS mini_app_denied,
  SUM(CASE WHEN event_type = 'mini_app_mutation_denied' AND failure_class = 'replayed-auth' THEN count ELSE 0 END) AS mini_app_replay_claimed
FROM telegram_usage_daily
WHERE day = ?`;
function roundMetric(value: unknown, digits = 2): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function estimateDrainTimeSec(messageCount: number): number {
  if (!Number.isFinite(messageCount) || messageCount <= 0) return 0;
  const budget = Math.max(1, TELEGRAM_PENDING_DRAIN_BUDGET);
  return Math.ceil(messageCount / budget) * TELEGRAM_DISPATCH_INTERVAL_SEC;
}

function formatTelemetryError(error: unknown): string {
  return toErrorMessage(error);
}

async function loadOptionalTelegramTelemetry<T>(loader: Promise<T | null>): Promise<OptionalTelegramTelemetry<T>> {
  try {
    return { value: await loader };
  } catch (error) {
    return { value: null, error: formatTelemetryError(error) };
  }
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
  return db
    .prepare(TELEGRAM_PENDING_DELIVERY_TELEMETRY_SQL)
    .bind(
      PENDING_TTL_SEC,
      now,
      PENDING_TTL_SEC,
      now,
      now,
      PENDING_TTL_SEC,
      now,
      PENDING_TTL_SEC,
      now,
      now,
      PENDING_TTL_SEC,
      now,
      now,
      PENDING_TTL_SEC,
      now,
      PENDING_TTL_SEC,
      now + PENDING_NEAR_TTL_WINDOW_SEC,
      now - PENDING_OLD_AGE_ALERT_SEC,
      now - PENDING_OLD_AGE_ALERT_SEC,
      now - PENDING_OLD_AGE_ALERT_SEC,
      EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      now - PENDING_OLD_AGE_ALERT_SEC,
      EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      now - PENDING_OLD_AGE_ALERT_SEC,
      now - PENDING_OLD_AGE_ALERT_SEC,
      EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      EXECUTION_UNKNOWN_SAMPLE_LIMIT,
    )
    .first<TelegramBotPendingDeliveryTelemetryRow>();
}

async function loadTelegramRetryErrorClasses(db: D1Database): Promise<TelegramBotRetryErrorClassRow[] | null> {
  const result = await db.prepare(TELEGRAM_RETRY_ERROR_CLASSES_SQL).all<TelegramBotRetryErrorClassRow>();
  return result.results ?? [];
}

export function utcDayFromUnixSeconds(nowSec: number): string {
  return formatIsoDate(nowSec);
}

export async function loadTelegramMiniAppDailyAggregate(
  db: D1Database,
  day: string,
): Promise<TelegramMiniAppDailyAggregate> {
  const row = await db
    .prepare(TELEGRAM_MINI_APP_DAILY_AGGREGATE_SQL)
    .bind(
      ...TELEGRAM_MINI_APP_SUCCESS_EVENT_TYPES,
      ...TELEGRAM_MINI_APP_SHARED_SUCCESS_EVENT_TYPES,
      ...TELEGRAM_MINI_APP_SOURCE_CATEGORIES,
      day,
    )
    .first<TelegramMiniAppDailyAggregateRow>();
  return {
    sessions: coerceCount(row?.mini_app_sessions),
    mutations: coerceCount(row?.mini_app_mutations),
    denied: coerceCount(row?.mini_app_denied),
    replayClaimed: coerceCount(row?.mini_app_replay_claimed),
  };
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

async function loadInactiveSubscribersCleanedThisWeek(db: D1Database, now: number): Promise<number | null> {
  const cutoff = now - INACTIVE_CLEANUP_WINDOW_SEC;
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(item_count), 0) AS total FROM cron_runs WHERE job = ? AND status = 'ok' AND started_at >= ?",
    )
    .bind(INACTIVE_CLEANUP_JOB, cutoff)
    .first<{ total: number | string | null }>();
  if (!row) return null;
  const parsed = Number(row.total ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

async function loadPresetQueryFailureCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM cache WHERE key = ?")
    .bind(PRESET_QUERY_FAILURE_CACHE_KEY)
    .first<{ value: string }>();
  if (!row) return 0;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function mapTelegramBotStats(input: {
  now?: number;
  aggregate: TelegramBotAggregateRow | null;
  pendingDisambiguations: TelegramBotPendingRow | null;
  pendingDeliveries: TelegramBotPendingRow | null;
  pendingDeliveryTelemetry?: TelegramBotPendingDeliveryTelemetryRow | null;
  webhookEffectUnknown?: TelegramBotPendingRow | null;
  retryErrorClasses?: TelegramBotRetryErrorClassRow[] | null;
  topStablecoins: TelegramBotTopStablecoinRow[];
  presetQueryFailures?: number;
  inactiveSubscribersCleanedThisWeek?: number | null;
  lifecycleSnapshot?: TelegramCurrentLifecycleSnapshot | null;
  unavailableFields?: string[];
  telemetryErrors?: Record<string, string>;
  deliverySli: TelegramDeliverySliStatus;
}): TelegramBotStats {
  const {
    aggregate,
    pendingDisambiguations,
    pendingDeliveries,
    pendingDeliveryTelemetry,
    webhookEffectUnknown,
    retryErrorClasses,
    topStablecoins,
    presetQueryFailures,
    inactiveSubscribersCleanedThisWeek,
    lifecycleSnapshot,
  } = input;
  const unavailableFields = input.unavailableFields ?? [];
  const telemetryErrors = input.telemetryErrors ?? {};
  const now = input.now ?? Math.floor(Date.now() / 1000);

  const pendingCount = pendingDeliveryTelemetry
    ? coerceCount(pendingDeliveryTelemetry.due_count) + coerceCount(pendingDeliveryTelemetry.deferred_count)
    : coerceCount(pendingDeliveries?.pending_count);
  const oldestCreatedAt = coerceNullableTimestamp(pendingDeliveryTelemetry?.oldest_created_at);
  const oldestDueCreatedAt = coerceNullableTimestamp(pendingDeliveryTelemetry?.oldest_due_created_at);
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
      reserve: coerceCount(aggregate?.reserve_chats),
      allTypes: coerceCount(aggregate?.all_types_chats),
    },
    topStablecoins: topStablecoins.map((row) => ({
      stablecoinId: row.stablecoin_id,
      symbol: TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
      subscribers: coerceCount(row.subscribers),
      explicitSubscribers: coerceCount(row.explicit_subscribers ?? row.subscribers),
      presetImpliedSubscribers: coerceCount(row.preset_implied_subscribers),
    })),
    deliverySli: input.deliverySli,
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
    const pendingExecutionUnknown = coerceCount(pendingDeliveryTelemetry.pending_execution_unknown_count);
    const freshExecutionUnknown = coerceCount(pendingDeliveryTelemetry.fresh_execution_unknown_count);
    const sending = coerceCount(pendingDeliveryTelemetry.pending_sending_count)
      + coerceCount(pendingDeliveryTelemetry.fresh_sending_count);
    const executionUnknown = pendingExecutionUnknown + freshExecutionUnknown;
    const oldestPendingExecutionUnknownAt = coerceNullableTimestamp(
      pendingDeliveryTelemetry.oldest_pending_execution_unknown_at,
    );
    const oldestFreshExecutionUnknownAt = coerceNullableTimestamp(
      pendingDeliveryTelemetry.oldest_fresh_execution_unknown_at,
    );
    const oldestExecutionUnknownAt = [oldestPendingExecutionUnknownAt, oldestFreshExecutionUnknownAt]
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;
    const sentCleanup = coerceCount(pendingDeliveryTelemetry.completed_cleanup_count);
    stats.oldestPendingDeliveryAgeSec =
      pendingCount > 0 && oldestCreatedAt != null ? Math.max(0, now - oldestCreatedAt) : null;
    stats.oldestDuePendingAgeSec = oldestDueCreatedAt != null ? Math.max(0, now - oldestDueCreatedAt) : null;
    stats.estimatedDrainTimeSec = estimateDrainTimeSec(
      coerceCount(pendingDeliveryTelemetry.due_count) + coerceCount(pendingDeliveryTelemetry.deferred_count),
    );
    stats.pendingDeliveryBacklog = {
      claimable: coerceCount(pendingDeliveryTelemetry.due_count),
      due: coerceCount(pendingDeliveryTelemetry.due_count),
      deferred: coerceCount(pendingDeliveryTelemetry.deferred_count),
      expired: coerceCount(pendingDeliveryTelemetry.expired_count),
      nearTtl: coerceCount(pendingDeliveryTelemetry.near_ttl_count),
      sending,
      executionUnknown,
      pendingExecutionUnknown,
      freshExecutionUnknown,
      oldestExecutionUnknownAgeSec: oldestExecutionUnknownAt == null
        ? null
        : Math.max(0, now - oldestExecutionUnknownAt),
      executionUnknownSampleLimit: EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      executionUnknownLowerBound:
        coerceCount(pendingDeliveryTelemetry.execution_unknown_sample_count) >= EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      sentCleanup,
      completedPendingCleanup: sentCleanup,
    };
  }
  if (webhookEffectUnknown) {
    stats.webhookEffectUnknown = coerceCount(webhookEffectUnknown.pending_count);
    if (
      webhookEffectUnknown.planned_count !== undefined
      || webhookEffectUnknown.started_count !== undefined
      || webhookEffectUnknown.execution_unknown_count !== undefined
    ) {
      const oldestPlannedAt = coerceNullableTimestamp(webhookEffectUnknown.oldest_planned_at);
      const oldestAmbiguousAt = coerceNullableTimestamp(webhookEffectUnknown.oldest_ambiguous_at);
      stats.webhookEffectLifecycle = {
        planned: coerceCount(webhookEffectUnknown.planned_count),
        started: coerceCount(webhookEffectUnknown.started_count),
        executionUnknown: coerceCount(webhookEffectUnknown.execution_unknown_count),
        oldestPlannedAgeSec: oldestPlannedAt == null ? null : Math.max(0, now - oldestPlannedAt),
        oldestAmbiguousAgeSec: oldestAmbiguousAt == null ? null : Math.max(0, now - oldestAmbiguousAt),
        sampleLimit: WEBHOOK_EFFECT_SAMPLE_LIMIT,
        lowerBound: coerceCount(webhookEffectUnknown.sample_count) >= WEBHOOK_EFFECT_SAMPLE_LIMIT,
      };
    }
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

  stats.quality =
    unavailableFields.length > 0
      ? {
          status: "partial",
          unavailableFields,
          ...(Object.keys(telemetryErrors).length > 0 ? { errors: telemetryErrors } : {}),
        }
      : { status: "complete", unavailableFields: [] };

  return stats;
}

export function buildTelegramDeliverySliStatus(
  result: OptionalTelegramTelemetry<TelegramDeliverySliRollup>,
): TelegramDeliverySliStatus {
  if (result.error || !result.value) {
    return {
      availability: "unavailable",
      quality: "unavailable",
      freshness: "unknown",
      acceptanceDefinition: TELEGRAM_DELIVERY_ACCEPTANCE_DEFINITION,
      rollup: null,
      error: {
        code: "telegram_delivery_sli_query_failed",
        message: "Telegram delivery SLI telemetry unavailable.",
      },
    };
  }

  const rollup = result.value;
  const qualityValues = [
    rollup.detectionToPlan.quality,
    rollup.planToTelegramAcceptance.quality,
    rollup.telegramAcceptanceBeforeTtl.quality,
  ];
  const quality = qualityValues.includes("partial")
    ? "partial"
    : qualityValues.includes("empty")
      ? "empty"
      : "complete";
  return {
    availability: "available",
    quality,
    freshness: rollup.evidence.freshness,
    acceptanceDefinition: TELEGRAM_DELIVERY_ACCEPTANCE_DEFINITION,
    rollup,
  };
}

export async function getTelegramBotStats(db: D1Database, now: number): Promise<TelegramBotStats> {
  const [
    aggregate,
    pendingDisambiguations,
    pendingDeliveries,
    pendingDeliveryTelemetryResult,
    webhookEffectUnknownResult,
    retryErrorClassesResult,
    topStablecoins,
    presetQueryFailuresResult,
    inactiveCleanupResult,
    lifecycleSnapshotResult,
    deliverySliResult,
  ] = await Promise.all([
    loadTelegramBotAggregate(db),
    loadTelegramPendingCount(db, TELEGRAM_PENDING_DISAMBIGUATION_SQL, now),
    loadTelegramPendingCount(db, TELEGRAM_PENDING_DELIVERIES_SQL),
    loadOptionalTelegramTelemetry(loadTelegramPendingDeliveryTelemetry(db, now)),
    loadOptionalTelegramTelemetry(loadTelegramPendingCount(db, TELEGRAM_WEBHOOK_EFFECT_UNKNOWN_SQL)),
    loadOptionalTelegramTelemetry(loadTelegramRetryErrorClasses(db)),
    loadTelegramTopStablecoins(db),
    loadOptionalTelegramTelemetry(loadPresetQueryFailureCount(db)),
    loadOptionalTelegramTelemetry(loadInactiveSubscribersCleanedThisWeek(db, now)),
    loadOptionalTelegramTelemetry(refreshTelegramLifecycleSnapshotIfStale(db, now)),
    loadOptionalTelegramTelemetry(loadTelegramDeliverySliRollup(db, { nowSec: now })),
  ]);
  const optionalResults = {
    pendingDeliveryBacklog: pendingDeliveryTelemetryResult,
    webhookEffectUnknown: webhookEffectUnknownResult,
    retryErrorClassCounts: retryErrorClassesResult,
    presetQueryFailures: presetQueryFailuresResult,
    inactiveSubscribersCleanedThisWeek: inactiveCleanupResult,
    lifecycleSnapshot: lifecycleSnapshotResult,
  };
  const unavailableFields = Object.entries(optionalResults)
    .filter(([, result]) => Boolean(result.error))
    .map(([field]) => field);
  const telemetryErrors = Object.fromEntries(
    Object.entries(optionalResults)
      .filter(([, result]) => Boolean(result.error))
      .map(([field, result]) => [field, result.error as string]),
  );

  return mapTelegramBotStats({
    now,
    aggregate,
    pendingDisambiguations,
    pendingDeliveries,
    pendingDeliveryTelemetry: pendingDeliveryTelemetryResult.value,
    webhookEffectUnknown: webhookEffectUnknownResult.value,
    retryErrorClasses: retryErrorClassesResult.value,
    topStablecoins,
    presetQueryFailures: presetQueryFailuresResult.value ?? undefined,
    inactiveSubscribersCleanedThisWeek: inactiveCleanupResult.value,
    lifecycleSnapshot: lifecycleSnapshotResult.value,
    deliverySli: buildTelegramDeliverySliStatus(deliverySliResult),
    unavailableFields,
    telemetryErrors,
  });
}
