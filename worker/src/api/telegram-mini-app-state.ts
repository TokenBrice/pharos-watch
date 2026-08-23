import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  TELEGRAM_ALERT_PERSISTENCE,
  type TelegramSubscriberGlobalColumn,
  type TelegramSubscriptionAlertColumn,
  type TelegramSubscriptionOverrideColumn,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES, type TelegramAlertType } from "@shared/types/status";
import type { TelegramMiniAppMutableState } from "@shared/lib/telegram-mini-app-contract";
import { TELEGRAM_RECAP_DEFAULT_DELIVERY_HOUR_LOCAL } from "@shared/lib/telegram-recap-policy";
import {
  TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  isTelegramRecapAvailableToChat,
  type TelegramRecapRolloutPolicy,
} from "@shared/lib/telegram-recap-rollout";
import { listTelegramPresets, type TelegramPresetDefinition } from "../lib/telegram-presets";
import { loadTelegramChatHealthDiagnostics } from "../lib/telegram-usage-analytics";
import type { TelegramMiniAppAuthContext } from "../lib/telegram-mini-app-auth";
import {
  prepareTelegramPendingAlertCount,
  prepareTelegramRecapState,
  type TelegramPendingAlertCountRow,
  type TelegramRecapStateRow,
} from "./telegram-store/chat-state";
import type {
  PresetSubscriptionRow,
  SubscriberRow,
  SubscriptionRow,
} from "./telegram-webhook-shared";

interface LoadTelegramMiniAppStateOptions {
  nowSec: number;
  mutationMaxAgeSec: number;
  recapRollout?: TelegramRecapRolloutPolicy;
}

type MiniAppSubscriptionRow = SubscriptionRow & {
  alert_snooze_until_ts: number | null;
};

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

type AlertTypeFlags = Record<TelegramAlertType, boolean>;

/** Projects a family-keyed boolean map through the registry's column names. */
function alertFlagsFrom<TColumn extends string>(
  row: Partial<Record<TColumn, number | null>>,
  column: (alertType: TelegramAlertType) => TColumn,
): AlertTypeFlags {
  return Object.fromEntries(
    TELEGRAM_ALERT_TYPES.map((alertType) => [alertType, boolFlag(row[column(alertType)])]),
  ) as AlertTypeFlags;
}

function alertTypes(row: Partial<Record<TelegramSubscriptionAlertColumn, number | null>>): AlertTypeFlags {
  return alertFlagsFrom(row, (alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn);
}

function alertOverrideTypes(
  row: Partial<Record<TelegramSubscriptionOverrideColumn, number | null>>,
): AlertTypeFlags {
  return alertFlagsFrom(row, (alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].overrideColumn);
}

function shouldProjectSubscription(row: MiniAppSubscriptionRow): boolean {
  const alerts = alertTypes(row);
  const overrides = alertOverrideTypes(row);
  return TELEGRAM_ALERT_TYPES.some((alertType) => alerts[alertType] || overrides[alertType])
    || row.alert_snooze_until_ts != null;
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
  const recapAvailable = chatId != null && isTelegramRecapAvailableToChat(
    options.recapRollout ?? TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
    chatId,
  );

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
          prepareTelegramPendingAlertCount(db, chatId, "queued_alerts"),
          prepareTelegramRecapState(db, chatId),
        ]) as Promise<[
          D1Result<SubscriberRow>,
          D1Result<MiniAppSubscriptionRow>,
          D1Result<PresetSubscriptionRow>,
          D1Result<TelegramPendingAlertCountRow>,
          D1Result<TelegramRecapStateRow>,
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
      { results: [] as MiniAppSubscriptionRow[] },
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
        ...alertFlagsFrom<TelegramSubscriberGlobalColumn>(
          subscriber ?? {},
          (alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].globalColumn,
        ),
        depegStepBps: normalizeDepegStep(subscriber?.global_depeg_worsening_bps_step),
      },
      quietHours: {
        enabled: boolFlag(subscriber?.quiet_hours_enabled),
        startHourUtc: subscriber?.quiet_hours_start_utc ?? null,
        endHourUtc: subscriber?.quiet_hours_end_utc ?? null,
        timezone: subscriber?.timezone ?? null,
      },
      recap: {
        available: recapAvailable,
        enabled: boolFlag(recap?.enabled),
        deliveryHourLocal: recap?.delivery_hour_local ?? TELEGRAM_RECAP_DEFAULT_DELIVERY_HOUR_LOCAL,
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
