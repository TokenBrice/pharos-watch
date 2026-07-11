import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { TelegramMiniAppMutableState } from "@shared/lib/telegram-mini-app-contract";
import { listTelegramPresets, type TelegramPresetDefinition } from "../lib/telegram-presets";
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
  global_alert_reserve: number | null;
  global_alert_freeze: number | null;
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
  alert_reserve: number | null;
  alert_freeze: number | null;
  alert_dews_override: number | null;
  alert_depeg_override: number | null;
  alert_safety_override: number | null;
  alert_launch_override: number | null;
  alert_reserve_override: number | null;
  alert_freeze_override: number | null;
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

interface PendingAlertCountRow {
  queued_alerts: number | string | null;
}

interface RecapStateRow {
  enabled: number | null;
  delivery_hour_local: number | null;
  next_due_at: number | null;
  last_window_end_at: number | null;
  last_delivered_local_date: string | null;
  last_outcome: string | null;
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

function normalizeDewsBand(value: string | null | undefined): "ALERT" | "WARNING" | "DANGER" | null {
  return value === "ALERT" || value === "WARNING" || value === "DANGER" ? value : null;
}

function normalizeDepegStep(value: number | null | undefined): 100 | 250 | 500 | null {
  return value === 100 || value === 250 || value === 500 ? value : null;
}

function normalizeSafetyMode(value: string | null | undefined): "all" | "downgrade-only" | "upgrade-only" | null {
  return value === "all" || value === "downgrade-only" || value === "upgrade-only" ? value : null;
}

function alertTypes(row: {
  alert_dews: number | null;
  alert_depeg: number | null;
  alert_safety: number | null;
  alert_launch?: number | null;
  alert_reserve?: number | null;
  alert_freeze?: number | null;
}): { dews: boolean; depeg: boolean; safety: boolean; launch: boolean; reserve: boolean; freeze: boolean } {
  return {
    dews: boolFlag(row.alert_dews),
    depeg: boolFlag(row.alert_depeg),
    safety: boolFlag(row.alert_safety),
    launch: boolFlag(row.alert_launch),
    reserve: boolFlag(row.alert_reserve),
    freeze: boolFlag(row.alert_freeze),
  };
}

function shouldProjectSubscription(row: SubscriptionRow): boolean {
  const alerts = alertTypes(row);
  return alerts.dews ||
    alerts.depeg ||
    alerts.safety ||
    alerts.launch ||
    alerts.reserve ||
    alerts.freeze ||
    boolFlag(row.alert_dews_override) ||
    boolFlag(row.alert_depeg_override) ||
    boolFlag(row.alert_safety_override) ||
    boolFlag(row.alert_launch_override) ||
    boolFlag(row.alert_reserve_override) ||
    boolFlag(row.alert_freeze_override) ||
    row.alert_snooze_until_ts != null;
}

function alertOverrideTypes(row: SubscriptionRow): Record<"dews" | "depeg" | "safety" | "launch" | "reserve" | "freeze", boolean> {
  return {
    dews: boolFlag(row.alert_dews_override),
    depeg: boolFlag(row.alert_depeg_override),
    safety: boolFlag(row.alert_safety_override),
    launch: boolFlag(row.alert_launch_override),
    reserve: boolFlag(row.alert_reserve_override),
    freeze: boolFlag(row.alert_freeze_override),
  };
}

function presetLabel(row: PresetSubscriptionRow): Pick<TelegramPresetDefinition, "id" | "label" | "description"> {
  const definition = listTelegramPresets().find((preset) => preset.id === row.preset_id);
  return {
    id: row.preset_id as TelegramPresetDefinition["id"],
    label: definition?.label ?? row.preset_id,
    description: definition?.description ?? "Telegram preset watchlist.",
  };
}

export async function loadTelegramMiniAppState(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  options: LoadTelegramMiniAppStateOptions,
): Promise<TelegramMiniAppMutableState> {
  const chatId = auth.canMutatePrivateChat ? auth.userId : null;
  const mutationAuthExpired = options.nowSec - auth.authDate > options.mutationMaxAgeSec;
  const canMutate = Boolean(chatId && !mutationAuthExpired);
  const mutationBlockReason = auth.canMutatePrivateChat
    ? mutationAuthExpired ? "stale-auth" : null
    : "not-private";

  const [subscriber, subscriptions, presets, health, pending, recap] = chatId
    ? await (async () => {
      const [stateResults, diagnostics] = await Promise.all([
        db.batch([
          db.prepare(
            `SELECT global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve, global_alert_freeze,
                    global_depeg_worsening_bps_step, quiet_hours_enabled, quiet_hours_start_utc,
                    quiet_hours_end_utc, timezone, alert_snooze_until_ts
               FROM telegram_subscribers
              WHERE chat_id = ?`,
          ).bind(chatId),
          db.prepare(
            `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze,
                    alert_dews_override, alert_depeg_override, alert_safety_override,
                    alert_launch_override, alert_reserve_override, alert_freeze_override,
                    dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
               FROM telegram_subscriptions
              WHERE chat_id = ?
              ORDER BY stablecoin_id`,
          ).bind(chatId),
          db.prepare(
            `SELECT preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
               FROM telegram_preset_subscriptions
              WHERE chat_id = ?
              ORDER BY preset_id`,
          ).bind(chatId),
          db.prepare("SELECT COUNT(*) AS queued_alerts FROM telegram_pending_alerts WHERE chat_id = ?")
            .bind(chatId),
          db.prepare(
            `SELECT p.enabled, p.delivery_hour_local, p.next_due_at,
                    p.last_window_end_at, p.last_delivered_local_date,
                    (SELECT target.status
                       FROM telegram_recap_targets target
                      WHERE target.chat_id = p.chat_id
                      ORDER BY target.created_at DESC, target.recap_key DESC
                      LIMIT 1) AS last_outcome
               FROM telegram_recap_preferences p
              WHERE p.chat_id = ? AND p.chat_kind = 'private'`,
          ).bind(chatId),
        ]) as Promise<[
          D1Result<SubscriberRow>,
          D1Result<SubscriptionRow>,
          D1Result<PresetSubscriptionRow>,
          D1Result<PendingAlertCountRow>,
          D1Result<RecapStateRow>,
        ]>,
        loadTelegramChatHealthDiagnostics(db, chatId),
      ]);
      return [
        stateResults[0].results?.[0] ?? null,
        { results: stateResults[1].results ?? [] },
        { results: stateResults[2].results ?? [] },
        diagnostics,
        stateResults[3].results?.[0] ?? null,
        stateResults[4].results?.[0] ?? null,
      ] as const;
    })()
    : [
      null,
      { results: [] as SubscriptionRow[] },
      { results: [] as PresetSubscriptionRow[] },
      null,
      null,
      null,
    ] as const;

  return {
    viewer: {
      userId: auth.userId,
      username: auth.username,
      firstName: auth.firstName,
      chatId,
      chatType: auth.chatType,
      startParam: auth.startParam,
      canMutate,
      mutationBlockReason,
    },
    subscriber: {
      exists: subscriber != null,
      globalAlerts: {
        dews: boolFlag(subscriber?.global_alert_dews),
        depeg: boolFlag(subscriber?.global_alert_depeg),
        safety: boolFlag(subscriber?.global_alert_safety),
        launch: boolFlag(subscriber?.global_alert_launch),
        reserve: boolFlag(subscriber?.global_alert_reserve),
        freeze: boolFlag(subscriber?.global_alert_freeze),
        depegStepBps: normalizeDepegStep(subscriber?.global_depeg_worsening_bps_step),
      },
      quietHours: {
        enabled: boolFlag(subscriber?.quiet_hours_enabled),
        startHourUtc: subscriber?.quiet_hours_start_utc ?? null,
        endHourUtc: subscriber?.quiet_hours_end_utc ?? null,
        timezone: subscriber?.timezone ?? null,
      },
      recap: {
        enabled: boolFlag(recap?.enabled),
        deliveryHourLocal: recap?.delivery_hour_local ?? 9,
        timezoneConfirmed: subscriber?.timezone != null,
        nextDueAt: recap?.next_due_at ?? null,
        lastWindowEndAt: recap?.last_window_end_at ?? null,
        lastDeliveredLocalDate: recap?.last_delivered_local_date ?? null,
        lastOutcome: recap?.last_outcome ?? null,
      },
      snoozeUntilTs: subscriber?.alert_snooze_until_ts ?? null,
    },
    subscriptions: (subscriptions.results ?? []).filter(shouldProjectSubscription).map((row) => {
      const meta = coinMeta(row.stablecoin_id);
      return {
        stablecoinId: row.stablecoin_id,
        symbol: meta.symbol,
        name: meta.name,
        alertTypes: alertTypes(row),
        alertOverrides: alertOverrideTypes(row),
        dewsMinBand: normalizeDewsBand(row.dews_min_band),
        safetyMode: normalizeSafetyMode(row.safety_mode),
        depegStepBps: normalizeDepegStep(row.depeg_worsening_bps_step),
        snoozeUntilTs: row.alert_snooze_until_ts,
      };
    }),
    presets: (presets.results ?? []).map((row) => {
      const label = presetLabel(row);
      return {
        id: label.id,
        label: label.label,
        description: label.description,
        alertTypes: {
          dews: boolFlag(row.alert_dews),
          depeg: boolFlag(row.alert_depeg),
          safety: boolFlag(row.alert_safety),
        },
        depegStepBps: normalizeDepegStep(row.depeg_worsening_bps_step),
      };
    }),
    health: {
      lastSuccessfulDeliveryAt: health?.lastSuccessfulDeliveryAt ?? null,
      lastSuccessfulReplyAt: health?.lastSuccessfulReplyAt ?? null,
      recentFailureClass: health?.recentFailureClass ?? null,
      queuedAlerts: Number(pending?.queued_alerts ?? 0),
    },
  };
}
