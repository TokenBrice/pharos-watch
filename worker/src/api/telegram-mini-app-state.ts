import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
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
  alert_dews_override: number | null;
  alert_depeg_override: number | null;
  alert_safety_override: number | null;
  alert_launch_override: number | null;
  alert_reserve_override: number | null;
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
}): { dews: boolean; depeg: boolean; safety: boolean; launch: boolean; reserve: boolean } {
  return {
    dews: boolFlag(row.alert_dews),
    depeg: boolFlag(row.alert_depeg),
    safety: boolFlag(row.alert_safety),
    launch: boolFlag(row.alert_launch),
    reserve: boolFlag(row.alert_reserve),
  };
}

function shouldProjectSubscription(row: SubscriptionRow): boolean {
  const alerts = alertTypes(row);
  return alerts.dews ||
    alerts.depeg ||
    alerts.safety ||
    alerts.launch ||
    alerts.reserve ||
    boolFlag(row.alert_dews_override) ||
    boolFlag(row.alert_depeg_override) ||
    boolFlag(row.alert_safety_override) ||
    boolFlag(row.alert_launch_override) ||
    boolFlag(row.alert_reserve_override) ||
    row.alert_snooze_until_ts != null;
}

function alertOverrideTypes(row: SubscriptionRow): Record<"dews" | "depeg" | "safety" | "launch" | "reserve", boolean> {
  return {
    dews: boolFlag(row.alert_dews_override),
    depeg: boolFlag(row.alert_depeg_override),
    safety: boolFlag(row.alert_safety_override),
    launch: boolFlag(row.alert_launch_override),
    reserve: boolFlag(row.alert_reserve_override),
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

const SEARCHABLE_COINS: ReadonlyArray<{ stablecoinId: string; symbol: string; name: string; peg: string; status: string }> = Object.freeze(
  TRACKED_STABLECOINS
    .filter((coin) => (coin.status ?? "active") !== "frozen")
    .map((coin) => Object.freeze({
      stablecoinId: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      peg: coin.flags.pegCurrency,
      status: coin.status ?? "active",
    })),
);

const RECOMMENDED_PRESETS: ReadonlyArray<Pick<TelegramPresetDefinition, "id" | "label" | "description">> = Object.freeze(
  listTelegramPresets().map((preset) => Object.freeze({
    id: preset.id,
    label: preset.label,
    description: preset.description,
  })),
);

export async function loadTelegramMiniAppState(
  db: D1Database,
  auth: TelegramMiniAppAuthContext,
  options: LoadTelegramMiniAppStateOptions,
): Promise<Record<string, unknown>> {
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
            `SELECT global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve,
                    global_depeg_worsening_bps_step, quiet_hours_enabled, quiet_hours_start_utc,
                    quiet_hours_end_utc, timezone, alert_snooze_until_ts
               FROM telegram_subscribers
              WHERE chat_id = ?`,
          ).bind(chatId),
          db.prepare(
            `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
                    alert_dews_override, alert_depeg_override, alert_safety_override,
                    alert_launch_override, alert_reserve_override,
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
        ]) as Promise<[
          D1Result<SubscriberRow>,
          D1Result<SubscriptionRow>,
          D1Result<PresetSubscriptionRow>,
          D1Result<PendingAlertCountRow>,
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
      { results: [] as SubscriptionRow[] },
      { results: [] as PresetSubscriptionRow[] },
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
        depegStepBps: normalizeDepegStep(subscriber?.global_depeg_worsening_bps_step),
      },
      quietHours: {
        enabled: boolFlag(subscriber?.quiet_hours_enabled),
        startHourUtc: subscriber?.quiet_hours_start_utc ?? null,
        endHourUtc: subscriber?.quiet_hours_end_utc ?? null,
        timezone: subscriber?.timezone ?? "UTC",
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
    catalog: {
      recommendedPresets: RECOMMENDED_PRESETS,
      searchableCoins: SEARCHABLE_COINS,
    },
    health: {
      lastSuccessfulDeliveryAt: health?.lastSuccessfulDeliveryAt ?? null,
      lastSuccessfulReplyAt: health?.lastSuccessfulReplyAt ?? null,
      recentFailureClass: health?.recentFailureClass ?? null,
      queuedAlerts: Number(pending?.queued_alerts ?? 0),
    },
  };
}
