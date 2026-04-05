import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { TelegramBotStats } from "@shared/types/status";

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
  all_types_chats: number | string | null;
  total_subscriptions: number | string | null;
  avg_subscriptions_per_subscribed_chat: number | string | null;
  last_subscriber_activity_at: number | string | null;
  custom_preference_chats: number | string | null;
  quiet_hours_enabled_chats: number | string | null;
}

interface TelegramBotPendingRow {
  pending_count: number | string | null;
}

interface TelegramBotTopStablecoinRow {
  stablecoin_id: string;
  subscribers: number | string | null;
}

const TELEGRAM_BOT_AGGREGATE_SQL = `SELECT
  COUNT(*) AS total_chats,
  SUM(
    CASE
      WHEN COALESCE(sub.active_sub_count, 0) > 0
        OR s.global_alert_dews = 1
        OR s.global_alert_depeg = 1
        OR s.global_alert_safety = 1
        OR s.alert_dews = 1
        OR s.alert_depeg = 1
        OR s.alert_safety = 1
      THEN 1 ELSE 0
    END
  ) AS alert_enabled_chats,
  SUM(
    CASE
      WHEN COALESCE(sub.active_sub_count, 0) > 0
        OR s.global_alert_dews = 1
        OR s.global_alert_depeg = 1
        OR s.global_alert_safety = 1
      THEN 1 ELSE 0
    END
  ) AS deliverable_chats,
  SUM(CASE WHEN COALESCE(sub.sub_count, 0) > 0 THEN 1 ELSE 0 END) AS subscribed_chats,
  SUM(
    CASE
      WHEN (s.alert_dews = 1 OR s.alert_depeg = 1 OR s.alert_safety = 1)
        AND s.global_alert_dews = 0
        AND s.global_alert_depeg = 0
        AND s.global_alert_safety = 0
        AND COALESCE(sub.sub_count, 0) = 0
      THEN 1 ELSE 0
    END
  ) AS empty_alert_chats,
  SUM(
    CASE
      WHEN COALESCE(sub.sub_count, 0) > 0 AND COALESCE(sub.active_sub_count, 0) = 0
      THEN 1 ELSE 0
    END
  ) AS muted_chats_with_subscriptions,
  SUM(CASE WHEN COALESCE(sub.dews_enabled, 0) = 1 OR s.global_alert_dews = 1 THEN 1 ELSE 0 END) AS dews_chats,
  SUM(CASE WHEN COALESCE(sub.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_chats,
  SUM(CASE WHEN COALESCE(sub.safety_enabled, 0) = 1 OR s.global_alert_safety = 1 THEN 1 ELSE 0 END) AS safety_chats,
  SUM(
    CASE
      WHEN (COALESCE(sub.dews_enabled, 0) = 1 OR s.global_alert_dews = 1)
        AND (COALESCE(sub.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1)
        AND (COALESCE(sub.safety_enabled, 0) = 1 OR s.global_alert_safety = 1)
      THEN 1 ELSE 0
    END
  ) AS all_types_chats,
  SUM(COALESCE(sub.sub_count, 0)) AS total_subscriptions,
  AVG(CASE WHEN COALESCE(sub.sub_count, 0) > 0 THEN sub.sub_count END) AS avg_subscriptions_per_subscribed_chat,
  MAX(s.last_active_at) AS last_subscriber_activity_at,
  SUM(CASE WHEN COALESCE(sub.custom_preferences, 0) = 1 THEN 1 ELSE 0 END) AS custom_preference_chats,
  SUM(CASE WHEN COALESCE(s.quiet_hours_enabled, 0) = 1 THEN 1 ELSE 0 END) AS quiet_hours_enabled_chats
FROM telegram_subscribers s
LEFT JOIN (
  SELECT chat_id,
         COUNT(*) AS sub_count,
         SUM(CASE WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 THEN 1 ELSE 0 END) AS active_sub_count,
         MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
         MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
         MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled,
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
) sub ON sub.chat_id = s.chat_id`;

const TELEGRAM_PENDING_DISAMBIGUATION_SQL =
  "SELECT COUNT(*) AS pending_count FROM telegram_pending_disambiguation WHERE expires_at > ?";
const TELEGRAM_PENDING_DELIVERIES_SQL =
  "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts";
const TELEGRAM_TOP_STABLECOINS_SQL = `SELECT stablecoin_id, COUNT(*) AS subscribers
  FROM telegram_subscriptions
 GROUP BY stablecoin_id
 ORDER BY subscribers DESC, stablecoin_id ASC
 LIMIT 5`;

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

async function loadTelegramTopStablecoins(db: D1Database): Promise<TelegramBotTopStablecoinRow[]> {
  const result = await db.prepare(TELEGRAM_TOP_STABLECOINS_SQL).all<TelegramBotTopStablecoinRow>();
  return result.results ?? [];
}

export function mapTelegramBotStats(input: {
  aggregate: TelegramBotAggregateRow | null;
  pendingDisambiguations: TelegramBotPendingRow | null;
  pendingDeliveries: TelegramBotPendingRow | null;
  topStablecoins: TelegramBotTopStablecoinRow[];
}): TelegramBotStats {
  const { aggregate, pendingDisambiguations, pendingDeliveries, topStablecoins } = input;

  return {
    totalChats: coerceCount(aggregate?.total_chats),
    alertEnabledChats: coerceCount(aggregate?.alert_enabled_chats),
    deliverableChats: coerceCount(aggregate?.deliverable_chats),
    subscribedChats: coerceCount(aggregate?.subscribed_chats),
    emptyAlertChats: coerceCount(aggregate?.empty_alert_chats),
    mutedChatsWithSubscriptions: coerceCount(aggregate?.muted_chats_with_subscriptions),
    totalSubscriptions: coerceCount(aggregate?.total_subscriptions),
    avgSubscriptionsPerSubscribedChat: roundMetric(aggregate?.avg_subscriptions_per_subscribed_chat, 1),
    pendingDisambiguations: coerceCount(pendingDisambiguations?.pending_count),
    pendingDeliveries: coerceCount(pendingDeliveries?.pending_count),
    lastSubscriberActivityAt: coerceNullableTimestamp(aggregate?.last_subscriber_activity_at),
    customPreferenceChats: coerceCount(aggregate?.custom_preference_chats),
    quietHoursEnabledChats: coerceCount(aggregate?.quiet_hours_enabled_chats),
    alertTypeChats: {
      dews: coerceCount(aggregate?.dews_chats),
      depeg: coerceCount(aggregate?.depeg_chats),
      safety: coerceCount(aggregate?.safety_chats),
      allTypes: coerceCount(aggregate?.all_types_chats),
    },
    topStablecoins: topStablecoins.map((row) => ({
      stablecoinId: row.stablecoin_id,
      symbol: TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
      subscribers: coerceCount(row.subscribers),
    })),
  };
}

export async function getTelegramBotStats(db: D1Database, now: number): Promise<TelegramBotStats> {
  const [aggregate, pendingDisambiguations, pendingDeliveries, topStablecoins] = await Promise.all([
    loadTelegramBotAggregate(db),
    loadTelegramPendingCount(db, TELEGRAM_PENDING_DISAMBIGUATION_SQL, now),
    loadTelegramPendingCount(db, TELEGRAM_PENDING_DELIVERIES_SQL),
    loadTelegramTopStablecoins(db),
  ]);

  return mapTelegramBotStats({
    aggregate,
    pendingDisambiguations,
    pendingDeliveries,
    topStablecoins,
  });
}
