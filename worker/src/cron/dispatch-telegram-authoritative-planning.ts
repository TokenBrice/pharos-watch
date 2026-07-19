import { buildInClause } from "../lib/db";
import {
  loadFanoutSubscriptionInputs,
  type FanoutLoaderFamily,
  type FanoutSubscriptionInputs,
} from "./dispatch-telegram-alerts-fanout";
import {
  buildTelegramAlertsByChat,
  buildTelegramFanoutPlan,
  type TelegramFanoutPlanEvents,
} from "./dispatch-telegram-fanout-plan";
import {
  loadGlobalSubscriberRows,
  loadPerCoinExplicitlyOffMap,
  loadPerCoinSnoozeMap,
  loadSubscriberRowsBatch,
} from "./dispatch-telegram-subscribers";
import { loadTelegramSourcePresetSubscribersForChats } from "./telegram-alert-source-events";
import type {
  TelegramPlanningDecision,
  TelegramPlanningSubscriber,
  TelegramTargetPlanCoordinatorCallbacks,
  TelegramTargetPlanningClaim,
} from "./telegram-alert-target-plans";

interface CurrentSubscriberGenerationRow {
  chat_id: string;
  preference_generation: number;
}

interface CandidateSubscriberRow extends CurrentSubscriberGenerationRow {
  last_active_at: number;
}

export interface TelegramAuthoritativePlanningTelemetry {
  candidateHorizonQueryMs: number;
  captureEligibilityMs: number;
  fanoutInputLoadMs: number;
  directSubscriberLoadMs: number;
  presetSubscriberLoadMs: number;
  globalSubscriberLoadMs: number;
  snoozeExplicitOffLoadMs: number;
  preferenceGenerationValidationMs: number;
  routingEvaluationMs: number;
  fanoutInputLoadCalls: number;
  fanoutInputCacheHits: number;
}

export interface TelegramAuthoritativePlanningCallbacks extends TelegramTargetPlanCoordinatorCallbacks {
  getTelemetry: () => TelegramAuthoritativePlanningTelemetry;
}

export interface TelegramAuthoritativePlanningContext {
  db: D1Database;
  sourceEventId: string;
  nowSec: number;
  events: TelegramFanoutPlanEvents;
  stablecoinIds: {
    dewsIds: string[];
    depegIds: string[];
    safetyIds: string[];
    launchIds: string[];
    reserveIds: string[];
  };
}

async function loadPageFanoutInputs(
  context: TelegramAuthoritativePlanningContext,
  subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[],
  telemetry: TelegramAuthoritativePlanningTelemetry,
): Promise<FanoutSubscriptionInputs> {
  const chatIds = subscribers.map((subscriber) => subscriber.chatId);
  const startedAtMs = Date.now();
  telemetry.fanoutInputLoadCalls += 1;
  const recordLoaderTiming = (family: FanoutLoaderFamily, durationMs: number) => {
    if (family === "direct") telemetry.directSubscriberLoadMs += durationMs;
    if (family === "preset") telemetry.presetSubscriberLoadMs += durationMs;
    if (family === "global") telemetry.globalSubscriberLoadMs += durationMs;
    if (family === "snooze-explicit-off") telemetry.snoozeExplicitOffLoadMs += durationMs;
  };
  const inputs = await loadFanoutSubscriptionInputs(
    context.db,
    context.stablecoinIds,
    {
      loadSubscriberRowsBatch,
      loadPresetSubscriberRowsBatch: async (_db, _stablecoinIds, type) =>
        loadTelegramSourcePresetSubscribersForChats(
          context.db,
          context.sourceEventId,
          type,
          chatIds,
          context.nowSec,
        ),
      loadGlobalSubscriberRows,
      loadPerCoinSnoozeMap,
      loadPerCoinExplicitlyOffMap,
    },
    context.nowSec,
    { chatIds, onLoaderTiming: recordLoaderTiming },
  );
  telemetry.fanoutInputLoadMs += Math.max(0, Date.now() - startedAtMs);
  const presetResults = [inputs.presetDewsResult, inputs.presetDepegResult, inputs.presetSafetyResult];
  if (presetResults.some((result) => result.kind !== "ok")) {
    throw new Error("Telegram source-scoped preset page could not be loaded completely");
  }
  return inputs;
}

async function buildPageEligibleChatIds(
  context: TelegramAuthoritativePlanningContext,
  subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[],
  inputs: FanoutSubscriptionInputs,
  telemetry: TelegramAuthoritativePlanningTelemetry,
): Promise<Set<string>> {
  if (subscribers.length === 0) return new Set();
  const startedAtMs = Date.now();
  const routing = buildTelegramAlertsByChat({
    events: context.events,
    inputs,
    burstMarkers: {},
    nowSec: context.nowSec,
    collapseBursts: false,
  });
  telemetry.routingEvaluationMs += Math.max(0, Date.now() - startedAtMs);
  return new Set(routing.alertsByChat.keys());
}

async function buildPageRoutedByChat(
  context: TelegramAuthoritativePlanningContext,
  subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[],
  inputs: FanoutSubscriptionInputs,
  telemetry: TelegramAuthoritativePlanningTelemetry,
): Promise<Map<string, ReturnType<typeof buildTelegramFanoutPlan>["subscriberQueue"][number]>> {
  const chatIds = subscribers.map((subscriber) => subscriber.chatId);
  if (chatIds.length === 0) return new Map();
  const startedAtMs = Date.now();
  const plan = buildTelegramFanoutPlan({
    sourceEventId: context.sourceEventId,
    events: context.events,
    inputs,
    overflowBacklog: [],
    burstMarkers: {},
    nowSec: context.nowSec,
    formatBudget: Math.max(1, chatIds.length * 64),
    collapseBursts: false,
  });
  telemetry.routingEvaluationMs += Math.max(0, Date.now() - startedAtMs);
  if (plan.overflowPlanned.length > 0 || plan.subscriberQueue.length !== plan.plannedQueue.length) {
    throw new Error("Telegram subscriber page exceeded the bounded rendering budget");
  }
  const routedByChat = new Map<string, (typeof plan.subscriberQueue)[number]>();
  for (const routed of plan.subscriberQueue) {
    if (routedByChat.has(routed.chatId)) {
      throw new Error("Telegram subscriber page produced multiple consolidated target plans for one chat");
    }
    routedByChat.set(routed.chatId, routed);
  }
  return routedByChat;
}

async function loadCurrentPreferenceGenerations(
  db: D1Database,
  subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[],
  telemetry: TelegramAuthoritativePlanningTelemetry,
): Promise<Map<string, number>> {
  if (subscribers.length === 0) return new Map();
  const startedAtMs = Date.now();
  const inClause = buildInClause(subscribers.map((subscriber) => subscriber.chatId));
  const rows = await db
    .prepare(
      `SELECT chat_id, preference_generation
         FROM telegram_subscribers
        WHERE chat_id IN (${inClause.sql})`,
    )
    .bind(...inClause.binds)
    .all<CurrentSubscriberGenerationRow>();
  telemetry.preferenceGenerationValidationMs += Math.max(0, Date.now() - startedAtMs);
  return new Map((rows.results ?? []).map((row) => [row.chat_id, Number(row.preference_generation)]));
}

async function loadCandidateSubscriberPage(
  context: TelegramAuthoritativePlanningContext,
  claim: TelegramTargetPlanningClaim,
  limit: number,
  telemetry: TelegramAuthoritativePlanningTelemetry,
): Promise<Array<Omit<TelegramPlanningSubscriber, "initiallyEligible">>> {
  if (claim.highWaterChatId == null) return [];
  const familySpecs = [
    { ids: context.stablecoinIds.dewsIds, direct: "alert_dews", global: "global_alert_dews", preset: "dews" },
    { ids: context.stablecoinIds.depegIds, direct: "alert_depeg", global: "global_alert_depeg", preset: "depeg" },
    { ids: context.stablecoinIds.safetyIds, direct: "alert_safety", global: "global_alert_safety", preset: "safety" },
    { ids: context.stablecoinIds.launchIds, direct: "alert_launch", global: "global_alert_launch", preset: null },
    { ids: context.stablecoinIds.reserveIds, direct: "alert_reserve", global: "global_alert_reserve", preset: null },
  ].filter((spec) => spec.ids.length > 0);
  if (familySpecs.length === 0) return [];

  const globalPredicate = familySpecs.map((spec) => `subscriber.${spec.global} = 1`).join(" OR ");
  const directPredicate = familySpecs
    .map((spec) => `(subscription.${spec.direct} = 1
      AND subscription.stablecoin_id IN (SELECT value FROM json_each(?)))`)
    .join(" OR ");
  const presetFamilies = familySpecs.flatMap((spec) => spec.preset ? [spec.preset] : []);
  const presetPredicate = presetFamilies.length > 0
    ? `OR EXISTS (
        SELECT 1
          FROM telegram_alert_source_resolution_targets target
          JOIN telegram_alert_source_resolution_pages page
            ON page.source_event_id = target.source_event_id
           AND page.page_key = target.page_key
         WHERE target.source_event_id = ?
           AND target.chat_id = subscriber.chat_id
           AND page.status = 'complete'
           AND page.alert_type IN (SELECT value FROM json_each(?))
      )`
    : "";
  const startedAtMs = Date.now();
  const result = await context.db
    .prepare(
      `SELECT subscriber.chat_id, subscriber.preference_generation, subscriber.last_active_at
         FROM telegram_subscribers subscriber
        WHERE subscriber.created_at <= ?
          AND subscriber.chat_id <= ?
          AND (? IS NULL OR subscriber.chat_id > ?)
          AND (subscriber.alert_snooze_until_ts IS NULL OR subscriber.alert_snooze_until_ts <= ?)
          AND (
            ${globalPredicate}
            OR EXISTS (
              SELECT 1
                FROM telegram_subscriptions subscription
               WHERE subscription.chat_id = subscriber.chat_id
                 AND (subscription.alert_snooze_until_ts IS NULL OR subscription.alert_snooze_until_ts <= ?)
                 AND (${directPredicate})
            )
            ${presetPredicate}
          )
        ORDER BY subscriber.chat_id
        LIMIT ?`,
    )
    .bind(
      claim.horizonAt,
      claim.highWaterChatId,
      claim.subscriberCursorChatId,
      claim.subscriberCursorChatId,
      context.nowSec,
      context.nowSec,
      ...familySpecs.map((spec) => JSON.stringify([...new Set(spec.ids)])),
      ...(presetFamilies.length > 0
        ? [context.sourceEventId, JSON.stringify(presetFamilies)]
        : []),
      limit,
    )
    .all<CandidateSubscriberRow>();
  telemetry.candidateHorizonQueryMs += Math.max(0, Date.now() - startedAtMs);
  return (result.results ?? []).map((row) => ({
    chatId: row.chat_id,
    preferenceGeneration: Math.max(0, Math.floor(Number(row.preference_generation))),
    lastActiveAt: Number(row.last_active_at),
  }));
}

export function createTelegramAuthoritativePlanningCallbacks(
  context: TelegramAuthoritativePlanningContext,
): TelegramAuthoritativePlanningCallbacks {
  const telemetry: TelegramAuthoritativePlanningTelemetry = {
    candidateHorizonQueryMs: 0,
    captureEligibilityMs: 0,
    fanoutInputLoadMs: 0,
    directSubscriberLoadMs: 0,
    presetSubscriberLoadMs: 0,
    globalSubscriberLoadMs: 0,
    snoozeExplicitOffLoadMs: 0,
    preferenceGenerationValidationMs: 0,
    routingEvaluationMs: 0,
    fanoutInputLoadCalls: 0,
    fanoutInputCacheHits: 0,
  };
  const pageInputCache = new Map<string, Promise<FanoutSubscriptionInputs>>();
  const pageKey = (subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[]) =>
    subscribers.map((subscriber) => subscriber.chatId).join("\0");
  const loadInputs = (
    subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[],
    allowCached: boolean,
  ): Promise<FanoutSubscriptionInputs> => {
    const key = pageKey(subscribers);
    const cached = pageInputCache.get(key);
    if (allowCached && cached) {
      telemetry.fanoutInputCacheHits += 1;
      return cached;
    }
    const loading = loadPageFanoutInputs(context, subscribers, telemetry).catch((error) => {
      if (pageInputCache.get(key) === loading) pageInputCache.delete(key);
      throw error;
    });
    pageInputCache.set(key, loading);
    return loading;
  };
  return {
    loadCaptureSubscribers: (claim, limit) =>
      loadCandidateSubscriberPage(context, claim, limit, telemetry),
    resolveInitialEligibility: async (subscribers) => {
      const startedAtMs = Date.now();
      const [inputs, currentGenerationByChat] = await Promise.all([
        loadInputs(subscribers, true),
        loadCurrentPreferenceGenerations(context.db, subscribers, telemetry),
      ]);
      const eligibleChatIds = await buildPageEligibleChatIds(context, subscribers, inputs, telemetry);
      telemetry.captureEligibilityMs += Math.max(0, Date.now() - startedAtMs);
      return new Map(subscribers.map((subscriber) => [subscriber.chatId, {
        eligible: eligibleChatIds.has(subscriber.chatId),
        observedPreferenceGeneration: currentGenerationByChat.get(subscriber.chatId)
          ?? subscriber.preferenceGeneration + 1,
      }]));
    },
    planSubscribers: async (subscribers, claim: TelegramTargetPlanningClaim) => {
      const currentGenerationByChat = await loadCurrentPreferenceGenerations(context.db, subscribers, telemetry);
      const generationsUnchanged = subscribers.every((subscriber) =>
        currentGenerationByChat.get(subscriber.chatId) === subscriber.preferenceGeneration);
      const inputs = await loadInputs(subscribers, generationsUnchanged);
      const routedByChat = await buildPageRoutedByChat(context, subscribers, inputs, telemetry);
      const decisions: TelegramPlanningDecision[] = subscribers.map((subscriber) => {
        const routed = routedByChat.get(subscriber.chatId);
        const currentPreferenceGeneration = currentGenerationByChat.get(subscriber.chatId)
          ?? subscriber.preferenceGeneration + 1;
        if (routed && (
          routed.sourceEventId !== claim.sourceEventId ||
          routed.preferenceGeneration !== currentPreferenceGeneration
        )) {
          throw new Error("Telegram current target route does not match current preference generation");
        }
        return {
          subscriber,
          currentPreferenceGeneration,
          currentEligible: routed != null,
          routed: routed ? [routed] : [],
        };
      });
      return decisions;
    },
    getTelemetry: () => ({ ...telemetry }),
  };
}
