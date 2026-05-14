import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { listTelegramPresets } from "../lib/telegram-presets";
import { loadTelegramChatHealthDiagnostics } from "../lib/telegram-usage-analytics";
import type { TelegramMiniAppAuthContext } from "../lib/telegram-mini-app-auth";

interface LoadTelegramMiniAppStateOptions {
  nowSec: number;
  mutationMaxAgeSec: number;
}

interface SubscriberRow {
  global_alert_dews: number | null;
  global_alert_depeg: number | null;
  global_alert_safety: number | null;
  global_alert_launch: number | null;
  global_depeg_worsening_bps_step: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
  alert_snooze_until_ts: number | null;
}

interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number | null;
  alert_depeg: number | null;
  alert_safety: number | null;
  alert_launch: number | null;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  alert_snooze_until_ts: number | null;
}

interface PresetSubscriptionRow {
  preset_id: string;
  alert_dews: number | null;
  alert_depeg: number | null;
  alert_safety: number | null;
  depeg_worsening_bps_step: number | null;
}

function boolFlag(value: number | null | undefined): boolean {
  return value === 1;
}

function coinMeta(stablecoinId: string): { symbol: string; name: string } {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  return {
    symbol: meta?.symbol ?? stablecoinId,
    name: meta?.name ?? stablecoinId,
  };
}

export async function loadTelegramMiniAppState(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  options: LoadTelegramMiniAppStateOptions,
): Promise<Record<string, unknown>> {
  const chatId = auth.userId;
  const [subscriber, subscriptions, presets, health, pending] = await Promise.all([
    db.prepare(
      `SELECT global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
              global_depeg_worsening_bps_step, quiet_hours_enabled, quiet_hours_start_utc,
              quiet_hours_end_utc, timezone, alert_snooze_until_ts
         FROM telegram_subscribers
        WHERE chat_id = ?`,
    ).bind(chatId).first<SubscriberRow>(),
    db.prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch,
              dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
         FROM telegram_subscriptions
        WHERE chat_id = ?
        ORDER BY stablecoin_id`,
    ).bind(chatId).all<SubscriptionRow>(),
    db.prepare(
      `SELECT preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
         FROM telegram_preset_subscriptions
        WHERE chat_id = ?
        ORDER BY preset_id`,
    ).bind(chatId).all<PresetSubscriptionRow>(),
    loadTelegramChatHealthDiagnostics(db, chatId),
    db.prepare("SELECT COUNT(*) AS queued_alerts FROM telegram_pending_alerts WHERE chat_id = ?")
      .bind(chatId)
      .first<{ queued_alerts: number | string | null }>(),
  ]);

  return {
    viewer: {
      userId: auth.userId,
      username: auth.username,
      firstName: auth.firstName,
      chatType: auth.chatType,
      startParam: auth.startParam,
      canMutate: auth.canMutatePrivateChat,
      mutationBlockReason: auth.canMutatePrivateChat ? null : "not-private",
      mutationAuthExpiresAt: auth.authDate + options.mutationMaxAgeSec,
    },
    subscriber: {
      globalAlerts: {
        dews: boolFlag(subscriber?.global_alert_dews),
        depeg: boolFlag(subscriber?.global_alert_depeg),
        safety: boolFlag(subscriber?.global_alert_safety),
        launch: boolFlag(subscriber?.global_alert_launch),
      },
      depegStepBps: subscriber?.global_depeg_worsening_bps_step ?? null,
      quietHours: {
        enabled: boolFlag(subscriber?.quiet_hours_enabled),
        startHourUtc: subscriber?.quiet_hours_start_utc ?? null,
        endHourUtc: subscriber?.quiet_hours_end_utc ?? null,
        timezone: subscriber?.timezone ?? "UTC",
      },
      snoozeUntil: subscriber?.alert_snooze_until_ts ?? null,
    },
    subscriptions: (subscriptions.results ?? []).map((row) => {
      const meta = coinMeta(row.stablecoin_id);
      return {
        stablecoinId: row.stablecoin_id,
        symbol: meta.symbol,
        name: meta.name,
        alerts: {
          dews: boolFlag(row.alert_dews),
          depeg: boolFlag(row.alert_depeg),
          safety: boolFlag(row.alert_safety),
          launch: boolFlag(row.alert_launch),
        },
        dewsMinBand: row.dews_min_band,
        safetyMode: row.safety_mode,
        depegStepBps: row.depeg_worsening_bps_step,
        snoozeUntil: row.alert_snooze_until_ts,
      };
    }),
    presets: (presets.results ?? []).map((row) => ({
      presetId: row.preset_id,
      alerts: {
        dews: boolFlag(row.alert_dews),
        depeg: boolFlag(row.alert_depeg),
        safety: boolFlag(row.alert_safety),
      },
      depegStepBps: row.depeg_worsening_bps_step,
    })),
    catalog: {
      presets: listTelegramPresets(),
    },
    health: {
      lastSuccessfulDeliveryAt: health?.lastSuccessfulDeliveryAt ?? null,
      lastSuccessfulReplyAt: health?.lastSuccessfulReplyAt ?? null,
      recentFailureClass: health?.recentFailureClass ?? null,
      queuedAlerts: Number(pending?.queued_alerts ?? 0),
      asOf: options.nowSec,
    },
  };
}
