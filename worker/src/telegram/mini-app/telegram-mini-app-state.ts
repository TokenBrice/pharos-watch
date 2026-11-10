import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  TELEGRAM_ALERT_PERSISTENCE,
  type TelegramSubscriberGlobalColumn,
  type TelegramSubscriptionAlertColumn,
  type TelegramSubscriptionOverrideColumn,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES, TELEGRAM_LIVE_ALERT_TYPES, type TelegramAlertType } from "@shared/types/status";
import { isDepegStepValue, isTelegramSafetyMode } from "@shared/types/status/telegram";
import { isDewsAlertBand } from "@shared/lib/classification/risk";
import type { TelegramMiniAppMutableState } from "@shared/lib/telegram-mini-app-contract";
import {
  listTelegramPresets,
  resolveTelegramPresetTargets,
  type TelegramPresetDefinition,
  type TelegramPresetId,
} from "../common/presets";
import { loadTelegramChatHealthDiagnostics } from "../store/usage-analytics";
import type { TelegramMiniAppAuthContext } from "./mini-app-auth";
import {
  prepareTelegramPendingAlertCount,
  type TelegramPendingAlertCountRow,
} from "../store/chat-state";
import type {
  PresetSubscriptionRow,
  SubscriberRow,
  SubscriptionRow,
} from "../webhook/telegram-webhook-shared";

interface LoadTelegramMiniAppStateOptions {
  nowSec: number;
  mutationMaxAgeSec: number;
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
  return TELEGRAM_LIVE_ALERT_TYPES.some((alertType) => alerts[alertType] || overrides[alertType])
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

/**
 * Current preset members so the client can say "via USD Top 25" per coin.
 * Membership follows the live market-cap cache; a failed read yields null
 * (unknown), never an empty list that would read as "not covered".
 */
async function loadPresetMemberIds(
  db: D1Database,
  presetIds: readonly string[],
): Promise<ReadonlyMap<string, string[]> | null> {
  if (presetIds.length === 0) return new Map();
  try {
    const resolved = await resolveTelegramPresetTargets(db, presetIds as TelegramPresetId[]);
    if (resolved.kind !== "ok") return null;
    return new Map(resolved.presets.map((preset) => [preset.definition.id, preset.stablecoinIds]));
  } catch {
    return null;
  }
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

  const [subscriber, subscriptions, presets, health, pending] = chatId
    ? await (async () => {
      const [stateResults, diagnostics] = await Promise.all([
        db.batch([
          db.prepare(
            `SELECT global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_reserve, global_alert_freeze,
                    global_depeg_worsening_bps_step, quiet_hours_enabled, quiet_hours_start_utc,
                    quiet_hours_end_utc, timezone, alert_snooze_until_ts
               FROM telegram_subscribers
              WHERE chat_id = ?`,
          ).bind(chatId),
          db.prepare(
            `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_reserve, alert_freeze,
                    alert_dews_override, alert_depeg_override, alert_safety_override,
                    alert_reserve_override, alert_freeze_override,
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
        ]) as Promise<[
          D1Result<SubscriberRow>,
          D1Result<MiniAppSubscriptionRow>,
          D1Result<PresetSubscriptionRow>,
          D1Result<TelegramPendingAlertCountRow>,
        ]>,
        loadTelegramChatHealthDiagnostics(db, chatId),
      ]);
      return [
        stateResults[0].results?.[0] ?? null,
        { results: stateResults[1].results ?? [] },
        { results: stateResults[2].results ?? [] },
        diagnostics,
        stateResults[3].results?.[0] ?? null,
      ] as const;
    })()
    : [
      null,
      { results: [] as MiniAppSubscriptionRow[] },
      { results: [] as PresetSubscriptionRow[] },
      { available: false } as const,
      null,
    ] as const;

  const presetMemberIds = await loadPresetMemberIds(db, (presets.results ?? []).map((row) => row.preset_id));

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
        depegStepBps: isDepegStepValue(subscriber?.global_depeg_worsening_bps_step) ? subscriber.global_depeg_worsening_bps_step : null,
      },
      quietHours: {
        enabled: boolFlag(subscriber?.quiet_hours_enabled),
        startHourUtc: subscriber?.quiet_hours_start_utc ?? null,
        endHourUtc: subscriber?.quiet_hours_end_utc ?? null,
        timezone: subscriber?.timezone ?? null,
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
        dewsMinBand: row.dews_min_band != null && isDewsAlertBand(row.dews_min_band) ? row.dews_min_band : null,
        safetyMode: isTelegramSafetyMode(row.safety_mode) ? row.safety_mode : null,
        depegStepBps: isDepegStepValue(row.depeg_worsening_bps_step) ? row.depeg_worsening_bps_step : null,
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
        depegStepBps: isDepegStepValue(row.depeg_worsening_bps_step) ? row.depeg_worsening_bps_step : null,
        memberIds: presetMemberIds?.get(row.preset_id) ?? null,
      };
    }),
    health: {
      diagnosticsAvailable: health.available,
      lastSuccessfulDeliveryAt: health.available ? health.diagnostics?.lastSuccessfulDeliveryAt ?? null : null,
      lastSuccessfulReplyAt: health.available ? health.diagnostics?.lastSuccessfulReplyAt ?? null : null,
      recentFailureClass: health.available ? health.diagnostics?.recentFailureClass ?? null : null,
      queuedAlerts: Number(pending?.queued_alerts ?? 0),
    },
  };
}
