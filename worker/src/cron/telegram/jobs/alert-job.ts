import type { TelegramAlertType } from "@shared/types/status";
import { TELEGRAM_ALERT_POLICY, TELEGRAM_ALERT_TTL_SEC } from "@shared/lib/telegram-delivery-policy";
import { chunkArray } from "../../../lib/db";
import { sha256Hex } from "../../../lib/hash";
import type { ConsolidatedAlerts } from "../../../telegram/common/alerts-formatting";
import type { TelegramDeliveryInput, TelegramJobSpec } from "../../../telegram/delivery/jobs";
import {
  loadFanoutSubscriptionInputs,
  type AlertStablecoinIds,
  type PresetSubscriberLoadResult,
} from "../dispatch/dispatch-telegram-alerts-fanout";
import { buildTelegramAlertsByChat } from "../dispatch/dispatch-telegram-fanout-plan";
import { hasEscalation } from "../dispatch/dispatch-telegram-predicates";
import {
  expandSubscriberChunks,
  formatPlannedSubscribers,
  planSubscriberQueue,
} from "../dispatch/dispatch-telegram-routing";
import {
  loadGlobalSubscriberRows,
  loadPerCoinExplicitlyOffMap,
  loadPerCoinSnoozeMap,
  loadSubscriberRowsBatch,
} from "../dispatch/dispatch-telegram-subscribers";
import {
  loadActivePresetFollowers,
  projectPresetFollowers,
  resolvePresetMemberships,
  type PresetAlertType,
  type PresetFollower,
} from "../dispatch/telegram-preset-subscriber-store";
import type { TelegramDispatchEvents, TelegramFanoutPlanEvents } from "../sources/dispatch-telegram-events";
import { toTelegramFanoutPlanEvents } from "../sources/dispatch-telegram-events";
import type { TelegramJobKindHandler, TelegramJobPageContext } from "./registry";

export interface TelegramAlertJobPayload {
  events: TelegramFanoutPlanEvents;
  stablecoinIds: AlertStablecoinIds;
  detectedAt: number;
}

const ROLLUP_ONLY_GLOBAL_FAMILIES: ReadonlySet<string> = new Set(TELEGRAM_ALERT_POLICY.rollupOnlyGlobalFamilies);

/** Preset chat filters are bound alongside preset ids; stay under D1's 100 binds. */
const PRESET_CHAT_CHUNK = 80;

function eventAlertTypes(events: TelegramDispatchEvents): TelegramAlertType[] {
  const types: TelegramAlertType[] = [];
  if (events.dewsIds.length > 0) types.push("dews");
  if (events.depegIds.length > 0) types.push("depeg");
  if (events.safetyIds.length > 0) types.push("safety");
  if (events.reserveIds.length > 0) types.push("reserve");
  return types;
}

/**
 * Deterministic alert job for one detection. The id binds the events and the
 * baseline they were diffed against, so a crash between detection and commit
 * re-derives the same job (INSERT OR IGNORE) instead of a duplicate.
 */
export async function buildTelegramAlertJobSpec(args: {
  events: TelegramDispatchEvents;
  baselineDigestInput: string;
  detectedAt: number;
}): Promise<TelegramJobSpec<TelegramAlertJobPayload>> {
  if (args.events.safetyIds.length > 0 && args.events.safetyScoreIdentity == null) {
    throw new Error("Telegram safety alert job requires an exact Safety Score identity");
  }
  const payload: TelegramAlertJobPayload = {
    events: toTelegramFanoutPlanEvents(args.events),
    stablecoinIds: {
      dewsIds: args.events.dewsIds,
      depegIds: args.events.depegIds,
      safetyIds: args.events.safetyIds,
      reserveIds: args.events.reserveIds,
    },
    detectedAt: args.detectedAt,
  };
  const digest = await sha256Hex(JSON.stringify({ payload, baseline: args.baselineDigestInput }));
  const ttls = eventAlertTypes(args.events).map((type) => TELEGRAM_ALERT_TTL_SEC[type]);
  return {
    jobId: `alert:${digest.slice(0, 32)}`,
    kind: "alert",
    payload,
    createdAt: args.detectedAt,
    expiresAt: args.detectedAt + Math.min(...ttls, TELEGRAM_ALERT_TTL_SEC.dews),
  };
}

/** Fail-closed preset loader: any membership or follower failure throws upstream. */
async function loadPresetSubscribersForChats(
  db: D1Database,
  stablecoinIds: string[],
  type: PresetAlertType,
  nowSec: number,
  chatIds: readonly string[],
): Promise<PresetSubscriberLoadResult> {
  const memberships = await resolvePresetMemberships(db, { alertType: type, wantedStablecoinIds: stablecoinIds, nowSec });
  if (memberships.kind === "query-failed") return { kind: "query-failed", error: memberships.error };
  if (memberships.kind === "resolution-failed") {
    return { kind: "query-failed", error: new Error(`preset resolution failed: ${memberships.reason}`) };
  }
  if (memberships.memberships.length === 0) return { kind: "ok", rows: new Map() };
  const presetIds = [...new Set(memberships.memberships.map((membership) => membership.preset_id))];
  const followers: PresetFollower[] = [];
  for (const chunk of chunkArray(chatIds, PRESET_CHAT_CHUNK)) {
    const page = await loadActivePresetFollowers(db, { alertType: type, presetIds, nowSec, chatIds: chunk });
    if (page.kind !== "ok") return { kind: "query-failed", error: page.error };
    followers.push(...page.followers);
  }
  return { kind: "ok", rows: projectPresetFollowers(memberships.memberships, followers) };
}

function collectCoinIds(alerts: ConsolidatedAlerts): string[] {
  const ids = new Set<string>();
  for (const list of [
    alerts.dews,
    alerts.depegTriggered,
    alerts.depegResolved,
    alerts.depegWorsening,
    alerts.safety,
    alerts.reserve,
    alerts.freeze ?? [],
  ] as ReadonlyArray<ReadonlyArray<{ stablecoinId: string }>>) {
    for (const item of list) ids.add(item.stablecoinId);
  }
  return [...ids];
}

/**
 * One page of chats (by chat id) routed through the existing subscriber,
 * preset and global SQL and the existing formatter. A preset failure throws so
 * the job stays planning instead of treating the failure as an empty audience.
 */
async function buildAlertJobPage(
  ctx: TelegramJobPageContext<TelegramAlertJobPayload>,
): Promise<{ deliveries: TelegramDeliveryInput[]; nextCursor: string | null }> {
  const { db, payload, nowSec } = ctx;
  const page = await db.prepare(
    `SELECT chat_id FROM telegram_subscribers
      WHERE chat_id > ?
      ORDER BY chat_id ASC
      LIMIT ?`,
  ).bind(ctx.cursor ?? "", ctx.limit).all<{ chat_id: string }>();
  const chatIds = (page.results ?? []).map((row) => row.chat_id);
  if (chatIds.length === 0) return { deliveries: [], nextCursor: null };

  const inputs = await loadFanoutSubscriptionInputs(
    db,
    payload.stablecoinIds,
    {
      loadSubscriberRowsBatch,
      loadPresetSubscribers: (_db, stablecoinIds, type, presetNowSec, options) =>
        loadPresetSubscribersForChats(db, stablecoinIds, type, presetNowSec, options?.chatIds ?? chatIds),
      // Global safety/DEWS opt-ins are roll-up only; the daily roll-up covers them.
      loadGlobalSubscriberRows: async (globalDb, type, globalNowSec, options) =>
        ROLLUP_ONLY_GLOBAL_FAMILIES.has(type) ? [] : loadGlobalSubscriberRows(globalDb, type, globalNowSec, options),
      loadPerCoinSnoozeMap,
      loadPerCoinExplicitlyOffMap,
    },
    nowSec,
    { chatIds },
  );
  for (const preset of Object.values(inputs.preset)) {
    if (preset.kind !== "ok") {
      throw new Error("Telegram alert fan-out preset resolution failed (fail closed)");
    }
  }

  const { alertsByChat } = buildTelegramAlertsByChat({ events: payload.events, inputs });
  const planned = planSubscriberQueue(alertsByChat, undefined, payload.events.safetyScoreIdentity);
  // Quiet hours are applied at send time; only non-escalations are silent here.
  const routed = formatPlannedSubscribers(planned, (entry) => !hasEscalation(entry.alerts));
  const routedByChat = new Map(routed.map((sub) => [sub.chatId, sub]));
  const deliveries: TelegramDeliveryInput[] = expandSubscriberChunks(routed).map((message) => {
    const sub = routedByChat.get(message.chatId)!;
    const families = sub.alertTypes ?? [sub.alertType];
    return {
      chatId: message.chatId,
      seq: message.chunkIndex ?? 0,
      body: message.html,
      dedupeBody: sub.canonicalHtml,
      disableNotification: message.disableNotification,
      ...(message.replyMarkup != null ? { replyMarkup: message.replyMarkup } : {}),
      ...(message.linkPreviewOptions ? { linkPreviewOptions: message.linkPreviewOptions } : {}),
      disableWebPagePreview: true,
      audience: "alert" as const,
      coinIds: collectCoinIds(sub.alerts),
      families,
    };
  });
  const last = chatIds[chatIds.length - 1]!;
  return { deliveries, nextCursor: chatIds.length < ctx.limit ? null : last };
}

export const alertJobHandler: TelegramJobKindHandler<TelegramAlertJobPayload> = {
  kind: "alert",
  buildPage: buildAlertJobPage,
};
