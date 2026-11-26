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
import { computeDirectStateFingerprint, type StoredDirectFingerprintRow } from "./watchlist-state";
import {
  listTelegramPresets,
  resolveTelegramPresetTargets,
  type TelegramPresetDefinition,
  type TelegramPresetId,
} from "../common/presets";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
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
  /**
   * Optional request-scoped strict `stablecoins` publication promise so
   * mutations that already validated the cache (e.g. `follow-preset`,
   * `recommended-setup`) avoid reading and parsing it a second time.
   */
  stablecoinsCachePromise?: Promise<StablecoinsCacheLoadResult>;
}

type PreloadedStablecoinsCache =
  | { kind: "row"; row: { value: string; updatedAt: number } | null }
  | { kind: "skipped" }
  | { kind: "error" };

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
 * Preload the strict `stablecoins` cache row in parallel with the state batch
 * only when the private chat currently follows at least one preset. Keeps the
 * read isolated from `db.batch` so a cache failure degrades only `memberIds`.
 */
async function preloadStablecoinsCacheIfHasPresets(
  db: D1Database,
  chatId: string,
): Promise<PreloadedStablecoinsCache> {
  try {
    const row = await db
      .prepare(
        `SELECT c.value, c.updated_at
           FROM (SELECT 1 FROM telegram_preset_subscriptions WHERE chat_id = ? LIMIT 1) p
           LEFT JOIN cache c ON c.key = 'stablecoins'`,
      )
      .bind(chatId)
      .first<{ value?: string | null; updated_at?: number | null }>();
    if (row == null || !("value" in row) || !("updated_at" in row)) return { kind: "skipped" };
    if (typeof row.value === "string" && typeof row.updated_at === "number") {
      return { kind: "row", row: { value: row.value, updatedAt: row.updated_at } };
    }
    return { kind: "row", row: null };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Current preset members so the client can say "via USD Top 25" per coin.
 * Membership follows the live market-cap cache; a failed read yields null
 * (unknown), never an empty list that would read as "not covered".
 */
async function loadPresetMemberIds(
  db: D1Database,
  presetIds: readonly string[],
  options: {
    stablecoinsCachePromise?: Promise<StablecoinsCacheLoadResult>;
    preloadedCache?: PreloadedStablecoinsCache;
  } = {},
): Promise<ReadonlyMap<string, string[]> | null> {
  if (presetIds.length === 0) return new Map();
  if (options.preloadedCache?.kind === "error") return null;
  try {
    const preloadedCache = options.preloadedCache;
    const getStablecoinsCacheResult = options.stablecoinsCachePromise
      ? () => options.stablecoinsCachePromise!
      : preloadedCache?.kind === "row"
        ? () => loadStablecoinsCache(db, { mode: "strict", preloadedCache: preloadedCache.row })
        : undefined;
    const resolved = await resolveTelegramPresetTargets(
      db,
      presetIds as TelegramPresetId[],
      getStablecoinsCacheResult ? { getStablecoinsCacheResult } : {},
    );
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

  const [subscriber, subscriptions, presets, health, pending, preloadedStablecoins] = chatId
    ? await (async () => {
      const [stateResults, diagnostics, preloadedCache] = await Promise.all([
        db.batch([
          db.prepare(
            `SELECT global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_reserve, global_alert_freeze,
                    global_depeg_worsening_bps_step, quiet_hours_enabled, quiet_hours_start_utc,
                    quiet_hours_end_utc, timezone, alert_snooze_until_ts, preference_generation
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
        ]) as Promise<[
          D1Result<SubscriberRow>,
          D1Result<MiniAppSubscriptionRow>,
          D1Result<PresetSubscriptionRow>,
          D1Result<TelegramPendingAlertCountRow>,
        ]>,
        loadTelegramChatHealthDiagnostics(db, chatId),
        options.stablecoinsCachePromise
          ? Promise.resolve<PreloadedStablecoinsCache>({ kind: "skipped" })
          : preloadStablecoinsCacheIfHasPresets(db, chatId),
      ]);
      return [
        stateResults[0].results?.[0] ?? null,
        { results: stateResults[1].results ?? [] },
        { results: stateResults[2].results ?? [] },
        diagnostics,
        stateResults[3].results?.[0] ?? null,
        preloadedCache,
      ] as const;
    })()
    : [
      null,
      { results: [] as MiniAppSubscriptionRow[] },
      { results: [] as PresetSubscriptionRow[] },
      { available: false } as const,
      null,
      { kind: "skipped" } as PreloadedStablecoinsCache,
    ] as const;

  const presetMemberIds = await loadPresetMemberIds(
    db,
    (presets.results ?? []).map((row) => row.preset_id),
    {
      stablecoinsCachePromise: options.stablecoinsCachePromise,
      preloadedCache: preloadedStablecoins,
    },
  );

  const rawSubscriptions = subscriptions.results ?? [];
  const directStateProof = chatId
    ? (() => {
        const subscriberExists = subscriber != null;
        const rawGen = subscriber?.preference_generation;
        const parsedGen = rawGen == null ? 0 : Number(rawGen);
        const preferenceGeneration = Number.isSafeInteger(parsedGen) && parsedGen >= 0 ? parsedGen : 0;
        const storedRows: StoredDirectFingerprintRow[] = rawSubscriptions.map((row) => ({
          stablecoinId: row.stablecoin_id,
          alertDews: boolFlag(row.alert_dews),
          alertDepeg: boolFlag(row.alert_depeg),
          alertSafety: boolFlag(row.alert_safety),
          alertLaunch: boolFlag(row.alert_launch),
          alertReserve: boolFlag(row.alert_reserve),
          alertFreeze: boolFlag(row.alert_freeze),
          overrideDews: boolFlag(row.alert_dews_override),
          overrideDepeg: boolFlag(row.alert_depeg_override),
          overrideSafety: boolFlag(row.alert_safety_override),
          overrideLaunch: boolFlag(row.alert_launch_override),
          overrideReserve: boolFlag(row.alert_reserve_override),
          overrideFreeze: boolFlag(row.alert_freeze_override),
          dewsMinBand: row.dews_min_band != null && isDewsAlertBand(row.dews_min_band) ? row.dews_min_band : null,
          safetyMode: isTelegramSafetyMode(row.safety_mode) ? row.safety_mode : null,
          depegWorseningBpsStep: isDepegStepValue(row.depeg_worsening_bps_step) ? row.depeg_worsening_bps_step : null,
          snoozeUntilTs: row.alert_snooze_until_ts ?? null,
        }));
        return {
          preferenceGeneration,
          directFingerprint: computeDirectStateFingerprint({ subscriberExists, rows: storedRows }),
        };
      })()
    : null;

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
      // `nowSec - authDate > mutationMaxAgeSec` rejects starting at `authDate + mutationMaxAgeSec + 1`.
      mutationAuthExpiresAt: auth.canMutatePrivateChat ? auth.authDate + options.mutationMaxAgeSec + 1 : null,
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
    subscriptions: rawSubscriptions.filter(shouldProjectSubscription).map((row) => {
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
    directStateProof,
  };
}
