import { buildInClause } from "../lib/db";
import { loadFanoutSubscriptionInputs } from "./dispatch-telegram-alerts-fanout";
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
): Promise<Awaited<ReturnType<typeof loadFanoutSubscriptionInputs>>> {
  const chatIds = subscribers.map((subscriber) => subscriber.chatId);
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
    { chatIds },
  );
  const presetResults = [inputs.presetDewsResult, inputs.presetDepegResult, inputs.presetSafetyResult];
  if (presetResults.some((result) => result.kind !== "ok")) {
    throw new Error("Telegram source-scoped preset page could not be loaded completely");
  }
  return inputs;
}

async function buildPageEligibleChatIds(
  context: TelegramAuthoritativePlanningContext,
  subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[],
): Promise<Set<string>> {
  if (subscribers.length === 0) return new Set();
  const inputs = await loadPageFanoutInputs(context, subscribers);
  const routing = buildTelegramAlertsByChat({
    events: context.events,
    inputs,
    burstMarkers: {},
    nowSec: context.nowSec,
    collapseBursts: false,
  });
  return new Set(routing.alertsByChat.keys());
}

async function buildPageRoutedByChat(
  context: TelegramAuthoritativePlanningContext,
  subscribers: readonly Pick<TelegramPlanningSubscriber, "chatId">[],
): Promise<Map<string, ReturnType<typeof buildTelegramFanoutPlan>["subscriberQueue"][number]>> {
  const chatIds = subscribers.map((subscriber) => subscriber.chatId);
  if (chatIds.length === 0) return new Map();
  const inputs = await loadPageFanoutInputs(context, subscribers);
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
): Promise<Map<string, number>> {
  if (subscribers.length === 0) return new Map();
  const inClause = buildInClause(subscribers.map((subscriber) => subscriber.chatId));
  const rows = await db
    .prepare(
      `SELECT chat_id, preference_generation
         FROM telegram_subscribers
        WHERE chat_id IN (${inClause.sql})`,
    )
    .bind(...inClause.binds)
    .all<CurrentSubscriberGenerationRow>();
  return new Map((rows.results ?? []).map((row) => [row.chat_id, Number(row.preference_generation)]));
}

export function createTelegramAuthoritativePlanningCallbacks(
  context: TelegramAuthoritativePlanningContext,
): TelegramTargetPlanCoordinatorCallbacks {
  return {
    resolveInitialEligibility: async (subscribers) => {
      const [eligibleChatIds, currentGenerationByChat] = await Promise.all([
        buildPageEligibleChatIds(context, subscribers),
        loadCurrentPreferenceGenerations(context.db, subscribers),
      ]);
      return new Map(subscribers.map((subscriber) => [subscriber.chatId, {
        eligible: eligibleChatIds.has(subscriber.chatId),
        observedPreferenceGeneration: currentGenerationByChat.get(subscriber.chatId)
          ?? subscriber.preferenceGeneration + 1,
      }]));
    },
    planSubscribers: async (subscribers, claim: TelegramTargetPlanningClaim) => {
      const [routedByChat, currentGenerationByChat] = await Promise.all([
        buildPageRoutedByChat(context, subscribers),
        loadCurrentPreferenceGenerations(context.db, subscribers),
      ]);
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
  };
}
