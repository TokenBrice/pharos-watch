import { jsonResponse } from "../lib/api-utils";
import { logAdminAction } from "../lib/admin-action-audit";
import { PENDING_OLD_AGE_ALERT_SEC, PENDING_TTL_SEC } from "../lib/telegram-constants";
import { parseJson } from "../lib/json-parse";
import { runAdminRoute } from "../lib/route-wrappers";

interface SubscriberRow {
  chat_id: string;
  username: string | null;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  alert_reserve: number;
  global_alert_dews: number;
  global_alert_depeg: number;
  global_alert_safety: number;
  global_alert_launch: number;
  global_alert_reserve: number;
  global_depeg_worsening_bps_step: number | null;
  quiet_hours_enabled: number;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
  alert_snooze_until_ts: number | null;
  consecutive_block_count: number;
  consecutive_block_first_at: number | null;
  preference_generation: number;
  created_at: number;
  last_active_at: number;
  first_follow_at: number | null;
  first_setup_completed_at: number | null;
}

interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  alert_reserve: number;
  alert_dews_override: number;
  alert_depeg_override: number;
  alert_safety_override: number;
  alert_launch_override: number;
  alert_reserve_override: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  alert_snooze_until_ts: number | null;
}

interface PendingLifecycleRow {
  total_rows: number | null;
  claimable: number | null;
  deferred: number | null;
  sending: number | null;
  execution_unknown: number | null;
  sent_cleanup: number | null;
  expired: number | null;
  oldest_claimable_at: number | null;
  newest_created_at: number | null;
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function redactedJsonArray(value: string): { count: number; valid: boolean } {
  const parsed = parseJson(value);
  return parsed.ok && Array.isArray(parsed.value)
    ? { count: parsed.value.length, valid: true }
    : { count: 0, valid: false };
}

export function handleAdminTelegramChat(
  db: D1Database,
  chatId: string,
  trustedAdmin: boolean,
  request: Request,
): Promise<Response> {
  return runAdminRoute(
    { endpoint: "route-admin-telegram-chat", request, trustedAdmin },
    async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const subscriber = await db.prepare(
        `SELECT chat_id, username, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
                global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
                global_alert_reserve, global_depeg_worsening_bps_step,
                quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc, timezone,
                alert_snooze_until_ts, consecutive_block_count, consecutive_block_first_at,
                preference_generation, created_at, last_active_at, first_follow_at,
                first_setup_completed_at
           FROM telegram_subscribers
          WHERE chat_id = ?`,
      ).bind(chatId).first<SubscriberRow>();

      const subscriptions = (await db.prepare(
        `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
                alert_dews_override, alert_depeg_override, alert_safety_override,
                alert_launch_override, alert_reserve_override, dews_min_band, safety_mode,
                depeg_worsening_bps_step, alert_snooze_until_ts
           FROM telegram_subscriptions
          WHERE chat_id = ?
          ORDER BY stablecoin_id`,
      ).bind(chatId).all<SubscriptionRow>()).results ?? [];

      const presets = (await db.prepare(
        `SELECT preset_id, alert_dews, alert_depeg, alert_safety,
                depeg_worsening_bps_step, created_at, updated_at
           FROM telegram_preset_subscriptions
          WHERE chat_id = ?
          ORDER BY preset_id`,
      ).bind(chatId).all<{
        preset_id: string;
        alert_dews: number;
        alert_depeg: number;
        alert_safety: number;
        depeg_worsening_bps_step: number | null;
        created_at: number;
        updated_at: number;
      }>()).results ?? [];

      const pendingDisambiguation = await db.prepare(
        `SELECT alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers,
                expires_at, action_type, action_payload, initiator_user_id
           FROM telegram_pending_disambiguation
          WHERE chat_id = ?`,
      ).bind(chatId).first<{
        alert_types: string;
        resolved_ids: string;
        ambiguous_ticker: string;
        candidates: string;
        remaining_tickers: string;
        expires_at: number;
        action_type: string;
        action_payload: string;
        initiator_user_id: string | null;
      }>();

      const pendingLifecycle = await db.prepare(
        `SELECT COUNT(*) AS total_rows,
                SUM(CASE WHEN delivery_state = 'pending'
                              AND COALESCE(expires_at, created_at + ?) > ?
                              AND (not_before_at IS NULL OR not_before_at <= ?)
                         THEN 1 ELSE 0 END) AS claimable,
                SUM(CASE WHEN delivery_state = 'pending'
                              AND COALESCE(expires_at, created_at + ?) > ?
                              AND not_before_at > ?
                         THEN 1 ELSE 0 END) AS deferred,
                SUM(CASE WHEN delivery_state = 'sending'
                              AND COALESCE(delivery_started_at, created_at) > ?
                         THEN 1 ELSE 0 END) AS sending,
                SUM(CASE WHEN delivery_state = 'execution_unknown'
                              OR (delivery_state = 'sending'
                                  AND COALESCE(delivery_started_at, created_at) <= ?)
                         THEN 1 ELSE 0 END) AS execution_unknown,
                SUM(CASE WHEN delivery_state = 'sent' THEN 1 ELSE 0 END) AS sent_cleanup,
                SUM(CASE WHEN delivery_state = 'pending'
                              AND COALESCE(expires_at, created_at + ?) <= ?
                         THEN 1 ELSE 0 END) AS expired,
                MIN(CASE WHEN delivery_state = 'pending'
                              AND COALESCE(expires_at, created_at + ?) > ?
                              AND (not_before_at IS NULL OR not_before_at <= ?)
                         THEN created_at END) AS oldest_claimable_at,
                MAX(created_at) AS newest_created_at
           FROM telegram_pending_alerts
          WHERE chat_id = ?`,
      ).bind(
        PENDING_TTL_SEC, nowSec, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        PENDING_TTL_SEC, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        chatId,
      ).first<PendingLifecycleRow>();

      const recentPending = (await db.prepare(
        `SELECT id, source_type, alert_type, priority, chunk_index, attempts,
                created_at, updated_at, not_before_at, expires_at, last_error_class,
                delivery_state, delivery_generation, delivery_started_at,
                delivery_completed_at, delivery_claim_expires_at, source_event_id,
                preference_generation, length(message_html) AS message_length,
                markup_policy_json IS NOT NULL AS has_markup_policy
           FROM telegram_pending_alerts
          WHERE chat_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
      ).bind(chatId).all<Record<string, unknown>>()).results ?? [];

      const deadLetterSummary = await db.prepare(
        `SELECT COUNT(*) AS count, MIN(expired_at) AS oldest_expired_at,
                MAX(expired_at) AS newest_expired_at
           FROM telegram_alert_dead_letters
          WHERE chat_id = ?`,
      ).bind(chatId).first<{ count: number | null; oldest_expired_at: number | null; newest_expired_at: number | null }>();
      const recentDeadLetters = (await db.prepare(
        `SELECT id, pending_id, source_type, alert_type, priority, created_at,
                expired_at, attempts, last_error_class, reason, chunk_index,
                source_event_id, preference_generation, delivery_state,
                delivery_generation, delivery_started_at, delivery_completed_at,
                delivery_claim_expires_at, length(message_html) AS message_length,
                markup_policy_json IS NOT NULL AS has_markup_policy
           FROM telegram_alert_dead_letters
          WHERE chat_id = ?
          ORDER BY expired_at DESC, id DESC
          LIMIT 20`,
      ).bind(chatId).all<Record<string, unknown>>()).results ?? [];

      const deliveryDiagnostics = await db.prepare(
        `SELECT last_successful_delivery_at, last_successful_reply_at,
                last_delivery_attempt_at, recent_failure_class, updated_at
           FROM telegram_chat_delivery_diagnostics
          WHERE chat_id = ?`,
      ).bind(chatId).first<Record<string, unknown>>();

      const targetHistory = (await db.prepare(
        `SELECT t.job_id, t.target_key, t.chunk_index, t.alert_type,
                t.status AS target_status, t.effect_state,
                t.effect_generation, t.created_at, t.sent_at, t.enqueued_at,
                t.failed_at, t.error_class, t.cancelled_at, t.cancellation_reason,
                t.source_event_id, t.plan_generation, t.plan_key, t.plan_ordinal,
                t.target_ordinal, t.preference_generation, t.target_expires_at,
                t.final_delivery_state, t.final_delivery_at, t.final_delivery_error,
                length(t.message_html) AS message_length,
                t.markup_policy_json IS NOT NULL AS has_markup_policy,
                j.status AS job_status, j.created_at AS job_created_at,
                j.expires_at AS job_expires_at, j.planned_count, j.accepted_count,
                j.enqueued_count, j.failed_count, j.cancelled_count,
                j.expired_count, j.execution_unknown_count
           FROM telegram_alert_job_targets t
           LEFT JOIN telegram_alert_jobs j ON j.job_id = t.job_id
          WHERE t.chat_id = ?
          ORDER BY t.created_at DESC, t.job_id DESC, t.target_key DESC
          LIMIT 50`,
      ).bind(chatId).all<Record<string, unknown>>()).results ?? [];

      const hasRetainedState = subscriber != null || subscriptions.length > 0 || presets.length > 0
        || pendingDisambiguation != null || count(pendingLifecycle?.total_rows) > 0
        || count(deadLetterSummary?.count) > 0 || deliveryDiagnostics != null || targetHistory.length > 0;
      if (!hasRetainedState) {
        await logAdminAction(db, {
          action: "inspect-telegram-chat",
          target: chatId,
          result: "error",
          httpStatus: 404,
          details: { found: false },
        }, request);
        return jsonResponse({ error: "Not found", chatId }, { status: 404, noStore: true });
      }

      const body = {
        contractVersion: 2,
        generatedAt: nowSec,
        chatId,
        subscriber: subscriber ? {
          usernamePresent: subscriber.username != null,
          createdAt: subscriber.created_at,
          lastActiveAt: subscriber.last_active_at,
          firstFollowAt: subscriber.first_follow_at,
          firstSetupCompletedAt: subscriber.first_setup_completed_at,
          preferenceGeneration: subscriber.preference_generation,
          globalAlerts: {
            dews: subscriber.global_alert_dews === 1,
            depeg: subscriber.global_alert_depeg === 1,
            safety: subscriber.global_alert_safety === 1,
            launch: subscriber.global_alert_launch === 1,
            reserve: subscriber.global_alert_reserve === 1,
            depegWorseningBpsStep: subscriber.global_depeg_worsening_bps_step,
          },
          directAlertDefaults: {
            dews: subscriber.alert_dews === 1,
            depeg: subscriber.alert_depeg === 1,
            safety: subscriber.alert_safety === 1,
            launch: subscriber.alert_launch === 1,
            reserve: subscriber.alert_reserve === 1,
          },
          deliveryControls: {
            timezone: subscriber.timezone,
            quietHours: {
              enabled: subscriber.quiet_hours_enabled === 1,
              startHourUtc: subscriber.quiet_hours_start_utc,
              endHourUtc: subscriber.quiet_hours_end_utc,
            },
            snooze: {
              active: (subscriber.alert_snooze_until_ts ?? 0) > nowSec,
              untilTs: subscriber.alert_snooze_until_ts,
            },
            blockStrikes: {
              count: subscriber.consecutive_block_count,
              firstAt: subscriber.consecutive_block_first_at,
            },
          },
        } : null,
        subscriptions: subscriptions.map((row) => ({
          stablecoinId: row.stablecoin_id,
          alerts: {
            dews: row.alert_dews === 1,
            depeg: row.alert_depeg === 1,
            safety: row.alert_safety === 1,
            launch: row.alert_launch === 1,
            reserve: row.alert_reserve === 1,
          },
          explicitOverrides: {
            dews: row.alert_dews_override === 1,
            depeg: row.alert_depeg_override === 1,
            safety: row.alert_safety_override === 1,
            launch: row.alert_launch_override === 1,
            reserve: row.alert_reserve_override === 1,
          },
          dewsMinBand: row.dews_min_band,
          safetyMode: row.safety_mode,
          depegWorseningBpsStep: row.depeg_worsening_bps_step,
          snooze: {
            active: (row.alert_snooze_until_ts ?? 0) > nowSec,
            untilTs: row.alert_snooze_until_ts,
          },
        })),
        presets: presets.map((row) => ({
          presetId: row.preset_id,
          alerts: {
            dews: row.alert_dews === 1,
            depeg: row.alert_depeg === 1,
            safety: row.alert_safety === 1,
          },
          depegWorseningBpsStep: row.depeg_worsening_bps_step,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        pendingDisambiguation: pendingDisambiguation ? {
          alertTypes: redactedJsonArray(pendingDisambiguation.alert_types),
          resolvedIds: redactedJsonArray(pendingDisambiguation.resolved_ids),
          ambiguousTickerPresent: pendingDisambiguation.ambiguous_ticker.length > 0,
          candidates: redactedJsonArray(pendingDisambiguation.candidates),
          remainingTickers: redactedJsonArray(pendingDisambiguation.remaining_tickers),
          expiresAt: pendingDisambiguation.expires_at,
          actionType: pendingDisambiguation.action_type,
          actionPayloadBytes: pendingDisambiguation.action_payload.length,
          initiatorPresent: pendingDisambiguation.initiator_user_id != null,
        } : null,
        pendingAlerts: {
          lifecycle: {
            totalRows: count(pendingLifecycle?.total_rows),
            claimable: count(pendingLifecycle?.claimable),
            deferred: count(pendingLifecycle?.deferred),
            sending: count(pendingLifecycle?.sending),
            executionUnknown: count(pendingLifecycle?.execution_unknown),
            sentCleanup: count(pendingLifecycle?.sent_cleanup),
            expired: count(pendingLifecycle?.expired),
            oldestClaimableAt: pendingLifecycle?.oldest_claimable_at ?? null,
            newestCreatedAt: pendingLifecycle?.newest_created_at ?? null,
          },
          recent: recentPending,
        },
        deadLetters: {
          count: count(deadLetterSummary?.count),
          oldestExpiredAt: deadLetterSummary?.oldest_expired_at ?? null,
          newestExpiredAt: deadLetterSummary?.newest_expired_at ?? null,
          recent: recentDeadLetters,
        },
        deliveryDiagnostics,
        targetHistory,
        redaction: {
          username: "presence-only",
          messageHtml: "length-only",
          disambiguationPayloads: "shape-only",
          dedupeAndOwnerKeys: "omitted",
        },
      };

      await logAdminAction(db, {
        action: "inspect-telegram-chat",
        target: chatId,
        result: "ok",
        httpStatus: 200,
        details: {
          found: true,
          registered: subscriber != null,
          subscriptionCount: subscriptions.length,
          presetCount: presets.length,
          pendingAlertCount: count(pendingLifecycle?.total_rows),
          deadLetterCount: count(deadLetterSummary?.count),
          targetHistoryCount: targetHistory.length,
        },
      }, request);
      return jsonResponse(body, { noStore: true });
    },
  );
}
