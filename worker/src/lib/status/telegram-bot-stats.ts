import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  buildActivePresetAggregateSql,
  buildActiveSubscriptionAggregateSql,
} from "@shared/lib/telegram-alert-families";
import type {
  TelegramBotStats,
  TelegramDeliverySliRollup,
  TelegramDeliverySliStatus,
} from "@shared/types/status";
import { formatIsoDate } from "@shared/lib/format";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  coerceCount,
  coerceNullableTimestamp,
  loadTelegramTopFollowedCoins,
  refreshTelegramLifecycleSnapshotIfStale,
  type TelegramCurrentLifecycleSnapshot,
} from "../../telegram/store/usage-analytics";
import { loadTelegramDeliverySliRollup } from "../../telegram/delivery/delivery-sli";
import { getCache } from "../db-cache";
import {
  loadTelegramPendingCapacity,
  toPendingDeliveryBacklog,
  type TelegramPendingCapacitySnapshot,
} from "../../telegram/outbox/pending-capacity";

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
  freeze_chats?: number | string | null;
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

interface OptionalTelegramTelemetry<T> {
  value: T | null;
  error?: string;
}

const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";
const INACTIVE_CLEANUP_WINDOW_SEC = 7 * 24 * 60 * 60;
const INACTIVE_CLEANUP_JOB = "telegram-inactive-cleanup";

/**
 * Status-only rollup on the direct watchlist: a row counts as customized when it
 * turns a preset family off or tunes one of the per-coin tuning columns.
 */
const TELEGRAM_CUSTOM_PREFERENCES_COLUMN = `MAX(
          CASE
            WHEN alert_dews = 0
              OR alert_depeg = 0
              OR alert_safety = 0
              OR dews_min_band IS NOT NULL
              OR safety_mode IS NOT NULL
              OR depeg_worsening_bps_step IS NOT NULL
            THEN 1 ELSE 0
          END
        ) AS custom_preferences`;

// The per-chat rollups below compose the canonical family projections from
// `shared/lib/telegram-alert-families`; only the status-only totals
// (`sub_count`/`preset_count`) and the customization rollup are local.
const TELEGRAM_SUBSCRIPTION_ROLLUP_SQL = buildActiveSubscriptionAggregateSql({
  additionalColumns: ["COUNT(*) AS sub_count", TELEGRAM_CUSTOM_PREFERENCES_COLUMN],
  includeFamilyFlags: true,
});

const TELEGRAM_PRESET_ROLLUP_SQL = buildActivePresetAggregateSql({
  additionalColumns: ["COUNT(*) AS preset_count"],
  includeFamilyFlags: true,
});

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
        OR s.global_alert_freeze = 1
        OR s.alert_dews = 1
        OR s.alert_depeg = 1
        OR s.alert_safety = 1
        OR s.alert_launch = 1
        OR s.alert_reserve = 1
        OR s.alert_freeze = 1
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
        OR s.global_alert_freeze = 1
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
      WHEN (s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1 OR s.alert_launch = 1 OR s.alert_reserve = 1 OR s.alert_freeze = 1)
        AND s.global_alert_dews = 0
        AND s.global_alert_depeg = 0
        AND s.global_alert_safety = 0
        AND s.global_alert_launch = 0
        AND s.global_alert_reserve = 0
        AND s.global_alert_freeze = 0
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
  SUM(CASE WHEN COALESCE(sub.freeze_enabled, 0) = 1 OR s.global_alert_freeze = 1 THEN 1 ELSE 0 END) AS freeze_chats,
  SUM(
    CASE
      WHEN (COALESCE(sub.dews_enabled, 0) = 1 OR COALESCE(preset.dews_enabled, 0) = 1 OR s.global_alert_dews = 1)
        AND (COALESCE(sub.depeg_enabled, 0) = 1 OR COALESCE(preset.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1)
        AND (COALESCE(sub.safety_enabled, 0) = 1 OR COALESCE(preset.safety_enabled, 0) = 1 OR s.global_alert_safety = 1)
        AND (COALESCE(sub.launch_enabled, 0) = 1 OR s.global_alert_launch = 1)
        AND (COALESCE(sub.reserve_enabled, 0) = 1 OR s.global_alert_reserve = 1)
        AND (COALESCE(sub.freeze_enabled, 0) = 1 OR s.global_alert_freeze = 1)
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
${TELEGRAM_SUBSCRIPTION_ROLLUP_SQL}
) sub ON sub.chat_id = s.chat_id
LEFT JOIN (
${TELEGRAM_PRESET_ROLLUP_SQL}
) preset ON preset.chat_id = s.chat_id`;

const TELEGRAM_PENDING_DELIVERIES_SQL =
  "SELECT COUNT(*) AS pending_count FROM telegram_deliveries WHERE state IN ('pending', 'retry')";
const TELEGRAM_RETRY_ERROR_CLASSES_SQL = `SELECT error_class, COUNT(*) AS pending_count
  FROM telegram_deliveries
 WHERE state = 'retry'
   AND error_class IS NOT NULL
   AND error_class <> ''
 GROUP BY error_class
 ORDER BY pending_count DESC, error_class ASC
 LIMIT 10`;
function roundMetric(value: unknown, digits = 2): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
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
): Promise<TelegramBotPendingRow | null> {
  return db.prepare(sql).first<TelegramBotPendingRow>();
}

async function loadTelegramRetryErrorClasses(db: D1Database): Promise<TelegramBotRetryErrorClassRow[] | null> {
  const result = await db.prepare(TELEGRAM_RETRY_ERROR_CLASSES_SQL).all<TelegramBotRetryErrorClassRow>();
  return result.results ?? [];
}


export function utcDayFromUnixSeconds(nowSec: number): string {
  return formatIsoDate(nowSec);
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
      "SELECT COUNT(*) AS runs, COALESCE(SUM(item_count), 0) AS total FROM cron_runs WHERE job = ? AND status = 'ok' AND started_at >= ?",
    )
    .bind(INACTIVE_CLEANUP_JOB, cutoff)
    .first<{ runs: number | string | null; total: number | string | null }>();
  if (!row) return null;
  const runs = Number(row.runs ?? 0);
  // An aggregate always returns one row: "no successful run in the window" is
  // run evidence, not a zero sum.
  if (!Number.isFinite(runs) || runs <= 0) return null;
  const parsed = Number(row.total ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

async function loadPresetQueryFailureCount(db: D1Database): Promise<number> {
  const row = await getCache(db, PRESET_QUERY_FAILURE_CACHE_KEY);
  if (!row) return 0;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function mapTelegramBotStats(input: {
  now?: number;
  aggregate: TelegramBotAggregateRow | null;
  pendingDeliveries: TelegramBotPendingRow | null;
  pendingCapacity?: TelegramPendingCapacitySnapshot | null;
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
    pendingDeliveries,
    pendingCapacity,
    retryErrorClasses,
    topStablecoins,
    presetQueryFailures,
    inactiveSubscribersCleanedThisWeek,
    lifecycleSnapshot,
  } = input;
  const unavailableFields = [...(input.unavailableFields ?? [])];
  const telemetryErrors = input.telemetryErrors ?? {};

  const pendingCount = pendingCapacity
    ? pendingCapacity.active
    : coerceCount(pendingDeliveries?.pending_count);
  const retryErrorClassCounts = retryErrorClasses?.reduce<Record<string, number>>((acc, row) => {
    const errorClass = row.error_class?.trim();
    if (errorClass) {
      acc[errorClass] = coerceCount(row.pending_count);
    }
    return acc;
  }, {});

  const explicitCoinSubscriptions = coerceCount(aggregate?.total_subscriptions);
  const presetImpliedCoinSubscriptions = lifecycleSnapshot?.presetImpliedCoinFollows ?? null;
  const activePresetFollowers =
    lifecycleSnapshot?.activePresetFollowers ?? coerceCount(aggregate?.active_preset_followers);

  const stats: TelegramBotStats = {
    totalChats: coerceCount(aggregate?.total_chats),
    alertEnabledChats: coerceCount(aggregate?.alert_enabled_chats),
    deliverableChats: coerceCount(aggregate?.deliverable_chats),
    subscribedChats: coerceCount(aggregate?.subscribed_chats),
    emptyAlertChats: coerceCount(aggregate?.empty_alert_chats),
    mutedChatsWithSubscriptions: coerceCount(aggregate?.muted_chats_with_subscriptions),
    totalSubscriptions: presetImpliedCoinSubscriptions == null
      ? null
      : explicitCoinSubscriptions + presetImpliedCoinSubscriptions,
    explicitCoinSubscriptions,
    presetImpliedCoinSubscriptions,
    activePresetFollowers,
    avgSubscriptionsPerSubscribedChat: roundMetric(aggregate?.avg_subscriptions_per_subscribed_chat, 1),
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
      freeze: coerceCount(aggregate?.freeze_chats),
      allTypes: coerceCount(aggregate?.all_types_chats),
    },
    topStablecoins: topStablecoins.map((row) => ({
      stablecoinId: row.stablecoin_id,
      symbol: WORKER_TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
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

  if (pendingCapacity) {
    stats.oldestPendingDeliveryAgeSec = pendingCapacity.oldestPendingAgeSec;
    stats.oldestDuePendingAgeSec = pendingCapacity.oldestDuePendingAgeSec;
    stats.estimatedDrainTimeSec = pendingCapacity.estimatedDrainTimeSec;
    stats.pendingDeliveryBacklog = toPendingDeliveryBacklog(pendingCapacity);
  }
  if (retryErrorClassCounts) {
    stats.retryErrorClassCounts = retryErrorClassCounts;
  }


  if (presetQueryFailures != null && presetQueryFailures > 0) {
    stats.presetQueryFailures = coerceCount(presetQueryFailures);
  }

  if (inactiveSubscribersCleanedThisWeek !== undefined) {
    stats.inactiveSubscribersCleanedThisWeek = inactiveSubscribersCleanedThisWeek;
    // No successful cleanup run in the window is Unknown, not a zero count.
    if (inactiveSubscribersCleanedThisWeek === null
      && !unavailableFields.includes("inactiveSubscribersCleanedThisWeek")) {
      unavailableFields.push("inactiveSubscribersCleanedThisWeek");
    }
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
    pendingDeliveries,
    pendingCapacityResult,
    retryErrorClassesResult,
    topStablecoins,
    presetQueryFailuresResult,
    inactiveCleanupResult,
    lifecycleSnapshotResult,
    deliverySliResult,
  ] = await Promise.all([
    loadTelegramBotAggregate(db),
    loadTelegramPendingCount(db, TELEGRAM_PENDING_DELIVERIES_SQL),
    loadOptionalTelegramTelemetry(loadTelegramPendingCapacity(db, now)),
    loadOptionalTelegramTelemetry(loadTelegramRetryErrorClasses(db)),
    loadTelegramTopStablecoins(db),
    loadOptionalTelegramTelemetry(loadPresetQueryFailureCount(db)),
    loadOptionalTelegramTelemetry(loadInactiveSubscribersCleanedThisWeek(db, now)),
    loadOptionalTelegramTelemetry(refreshTelegramLifecycleSnapshotIfStale(db, now)),
    loadOptionalTelegramTelemetry(loadTelegramDeliverySliRollup(db, { nowSec: now })),
  ]);
  const optionalResults = {
    pendingDeliveryBacklog: pendingCapacityResult,
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
    pendingDeliveries,
    pendingCapacity: pendingCapacityResult.value,
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
