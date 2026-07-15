/**
 * Shared coin-resolution / bulk-confirm machinery used by /subscribe,
 * /unsubscribe, /set, and the disambiguation reply path. Moved out of
 * telegram-webhook.ts during the P1-M1 dispatch split — behavior is unchanged.
 */
import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { recordTelegramFirstFollow } from "../../lib/telegram-adoption-analytics";
import {
  type ResolvedCoin,
  type TickerResolutionScope,
} from "../../lib/telegram-alerts";
import {
  TELEGRAM_PRESET_LABEL_BY_ID,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../../lib/telegram-presets";
import { TELEGRAM_SUBSCRIBABLE_STABLECOINS } from "../../lib/telegram-subscription-eligibility";
import {
  buildPresetSubscriptionSummaryMessage,
  buildPresetUnsubscribeSummaryMessage,
  buildPresetUnavailableMessage,
  buildSubscriptionSummaryMessage,
  buildUnsubscribeSuccessMessage,
} from "../telegram-webhook-messages";
import { runCoinResolutionFlow, type CoinResolutionCompletion } from "../telegram-webhook-resolution";
import {
  applySettingToSubscriptions,
  applySubscribeIntent,
  applyUnsubscribeIntent,
  loadSubscriptionsByIds,
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  persistPendingDisambiguation,
  persistPendingConfirmBulk,
} from "../telegram-webhook-store";
import {
  type ConfirmBulkPayload,
  type ParsedSetCommand,
  type SubscribeActionPayload,
  type UnsubscribeActionPayload,
} from "../telegram-webhook-shared";
import { dedupeCoins } from "../telegram-webhook-parsing";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import {
  BULK_CONFIRM_COIN_THRESHOLD,
  BULK_CONFIRM_PREVIEW_LIMIT,
} from "../../lib/telegram-constants";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import type { TelegramWebhookOperationIntent } from "../telegram-webhook-store";
import { DISAMBIGUATION_TTL_SEC } from "../telegram-webhook-shared";

export interface TelegramActionContext {
  db: D1Database;
  chatId: string;
  username: string | null;
  initiatorUserId: string | null;
  beforeIrreversibleEffect?: (kind: string) => Promise<void>;
  planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: () => D1PreparedStatement;
  prepareMutationOperationStatements?: () => D1PreparedStatement[];
  preparePendingMutationAppliedStatement?: (input: {
    chatId: string;
    actionType: string;
    actionPayload: string;
    expiresAt: number;
  }) => D1PreparedStatement;
  confirmAtomicMutationApplied?: () => void;
  markMutationApplied?: () => Promise<void>;
  storedIntent?: TelegramWebhookOperationIntent | null;
  wasMutationApplied?: boolean;
  operationNowSec?: number;
}

async function prepareActionMutation(
  context: TelegramActionContext,
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ operationStatements?: D1PreparedStatement[] }> {
  await context.planIntent?.(createTelegramWebhookIntent(kind, payload, "required"));
  return context.prepareMutationOperationStatements
    ? { operationStatements: context.prepareMutationOperationStatements() }
    : context.prepareMutationAppliedStatement
      ? { operationStatements: [context.prepareMutationAppliedStatement()] }
    : {};
}

function confirmActionMutation(context: TelegramActionContext, options: { operationStatements?: D1PreparedStatement[] }): void {
  if (options.operationStatements) context.confirmAtomicMutationApplied?.();
}

export type ActionPayloadMap = {
  subscribe: SubscribeActionPayload;
  unsubscribe: UnsubscribeActionPayload;
  set: ParsedSetCommand;
};

const SUBSCRIBABLE_COIN_COUNT = TELEGRAM_SUBSCRIBABLE_STABLECOINS.length;

export function subscribableCoinCount(): number {
  return SUBSCRIBABLE_COIN_COUNT;
}

export const BULK_CONFIRM_REPLY_MARKUP = {
  inline_keyboard: [[
    { text: "Confirm", callback_data: "confirm:bulk" },
    { text: "Cancel", callback_data: "cancel:bulk" },
  ]],
} as const;

function formatBulkAlertTypeList(alertTypes: readonly string[]): string {
  if (alertTypes.length === 0) return "all";
  return alertTypes.join(", ");
}

function formatBulkCoinPreview(symbols: readonly string[]): string {
  if (symbols.length === 0) return "";
  const head = symbols.slice(0, BULK_CONFIRM_PREVIEW_LIMIT);
  const more = symbols.length - head.length;
  const suffix = more > 0 ? `, ...and ${more} more` : "";
  return `${head.join(", ")}${suffix}`;
}

export function buildBulkConfirmMessage(
  action: "subscribe" | "unsubscribe",
  count: number,
  alertTypes: readonly string[],
  coinSymbols: readonly string[],
): string {
  const verb = action === "subscribe" ? "subscribe" : "unsubscribe";
  const typesLine =
    action === "subscribe"
      ? `alert types ${escapeHtml(formatBulkAlertTypeList(alertTypes))}`
      : "all alert types";
  const preview = formatBulkCoinPreview(coinSymbols);
  const previewLine = preview ? `\n${escapeHtml(preview)}` : "";
  return `This will ${verb} ${count} coins for ${typesLine}. Confirm?${previewLine}`;
}

export function dedupePresetIds(presetIds: readonly string[]): TelegramPresetId[] {
  return Array.from(
    new Set(
      presetIds.filter((presetId): presetId is TelegramPresetId =>
        TELEGRAM_PRESET_LABEL_BY_ID.has(presetId as TelegramPresetId),
      ),
    ),
  );
}

async function resolvePresetCoins(
  db: D1Database,
  presetIds: readonly TelegramPresetId[],
): Promise<ResolvedCoin[] | null> {
  if (presetIds.length === 0) return [];

  const resolvedPresets = await resolveTelegramPresetTargets(db, presetIds);
  if (resolvedPresets.kind !== "ok") {
    return null;
  }
  return dedupeCoins(resolvedPresets.presets.flatMap((preset) => preset.coins));
}

type CompletionActionType = keyof ActionPayloadMap;

type CompletionHandlerMap = {
  [K in CompletionActionType]: (
    context: TelegramActionContext,
    coins: ResolvedCoin[],
    payload: ActionPayloadMap[K],
    options: {
      clearPending: boolean;
      presetCoins: ResolvedCoin[];
      presetResolutionAvailable: boolean;
    },
  ) => Promise<string>;
};

const completionHandlers: CompletionHandlerMap = {
  subscribe: async (context, coins, payload, options) => {
    const alertTypes = new Set(payload.alertTypes);
    const presetIds = dedupePresetIds(payload.presetIds ?? []);
    const operation = await prepareActionMutation(context, "command:subscribe", {
      coinIds: coins.map((coin) => coin.id),
      presetIds,
      alertTypes: [...alertTypes].sort(),
      depegWorseningBpsStep: payload.depegWorseningBpsStep ?? null,
      initiatorUserId: context.initiatorUserId,
      clearPending: options.clearPending,
    });
    if (!context.wasMutationApplied) {
      await applySubscribeIntent(context.db, {
        chatId: context.chatId,
        username: context.username,
        alertTypes,
        directStablecoinIds: coins.map((coin) => coin.id),
        presetIds,
        clearPending: options.clearPending,
        depegWorseningBpsStep: payload.depegWorseningBpsStep,
        ...operation,
      });
      confirmActionMutation(context, operation);
    }
    await recordTelegramFirstFollow(context.db, {
      campaign: "organic",
      placement: "unknown",
      chatId: context.chatId,
      feature: presetIds.length > 0 ? "preset" : "direct",
      nowSec: context.operationNowSec ?? Math.floor(Date.now() / 1_000),
    });
    if (presetIds.length > 0) {
      await recordTelegramUsageEvent(context.db, {
        eventType: "preset_follow",
        actionDetail: "preset",
        outcome: "success",
      });
    }
    await recordTelegramUsageEvent(context.db, {
      eventType: "subscribe",
      actionDetail: presetIds.length > 0 ? "preset" : "coin",
      outcome: "success",
    });
    const subscriptions = await loadSubscriptionsByIds(
      context.db,
      context.chatId,
      coins.map((coin) => coin.id),
    );
    if (presetIds.length > 0) {
      return buildPresetSubscriptionSummaryMessage(subscriptions, {
        presetIds,
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
        presetCoinCount: options.presetCoins.length,
      });
    }
    return buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions);
  },
  unsubscribe: async (context, coins, payload, options) => {
    const presetIds = dedupePresetIds(payload.presetIds ?? []);
    const operation = await prepareActionMutation(context, "command:unsubscribe", {
      coinIds: coins.map((coin) => coin.id),
      presetIds,
      initiatorUserId: context.initiatorUserId,
      clearPending: options.clearPending,
    });
    if (!context.wasMutationApplied) {
      await applyUnsubscribeIntent(context.db, {
        chatId: context.chatId,
        directStablecoinIds: coins.map((coin) => coin.id),
        presetIds,
        clearPending: options.clearPending,
        ...operation,
      });
      confirmActionMutation(context, operation);
    }
    if (presetIds.length > 0) {
      await recordTelegramUsageEvent(context.db, {
        eventType: "preset_unfollow",
        actionDetail: "preset",
        outcome: "success",
      });
    }
    await recordTelegramUsageEvent(context.db, {
      eventType: "unsubscribe",
      actionDetail: presetIds.length > 0 ? "preset" : "coin",
      outcome: "success",
    });
    if (presetIds.length > 0) {
      return buildPresetUnsubscribeSummaryMessage(coins, {
        presetIds,
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
        presetCoinCount: options.presetResolutionAvailable ? options.presetCoins.length : null,
      });
    }
    return buildUnsubscribeSuccessMessage(coins);
  },
  set: async (context, coins, payload, options) => {
    const { ticker: _ticker, ...normalizedSetting } = payload;
    const operation = await prepareActionMutation(context, "command:set", {
      coinIds: coins.map((coin) => coin.id),
      setting: normalizedSetting,
      initiatorUserId: context.initiatorUserId,
      clearPending: options.clearPending,
    });
    if (!context.wasMutationApplied) {
      await applySettingToSubscriptions(
        context.db,
        context.chatId,
        context.username,
        coins,
        payload,
        { ...operation, clearPending: options.clearPending },
      );
      confirmActionMutation(context, operation);
    }
    const subscriptions = await loadSubscriptionsByIds(
      context.db,
      context.chatId,
      coins.map((coin) => coin.id),
    );
    return buildSubscriptionSummaryMessage("Updated settings.", subscriptions);
  },
};

export type BoundActionRunner = <TActionType extends "subscribe" | "unsubscribe" | "set">(opts: {
  tickers: string[];
  actionType: TActionType;
  actionPayload: ActionPayloadMap[TActionType];
  alertTypes?: Set<string>;
  initialCoins?: ResolvedCoin[];
  clearPendingOnTerminal?: boolean;
  resolutionScope?: TickerResolutionScope;
}) => Promise<void>;

export interface ActionRunnerOptions {
  replyMarkupForCompletion?: (input: {
    actionType: CompletionActionType;
    coins: ResolvedCoin[];
    payload: ActionPayloadMap[CompletionActionType];
  }) => unknown | undefined;
}

/**
 * Optional gate that, when satisfied, defers subscribe/unsubscribe execution
 * behind an inline Confirm/Cancel keyboard. The gate fires once coin resolution
 * is complete; `kind` is fixed at handler construction so the deferred payload
 * matches the originating command.
 */
export type BulkGate =
  | {
      kind: "subscribe";
      alertTypes: string[];
      presetIds: string[];
      depegWorseningBpsStep?: 100 | 250 | 500 | null;
    }
  | {
      kind: "unsubscribe";
      presetIds: string[];
    };

function shouldGateBulk(coinCount: number): boolean {
  return coinCount > BULK_CONFIRM_COIN_THRESHOLD;
}

async function persistAndPromptBulkConfirm(
  context: TelegramActionContext,
  botToken: string,
  gate: BulkGate,
  directCoins: ResolvedCoin[],
  previewCoins: ResolvedCoin[],
  clearPending: boolean,
): Promise<CoinResolutionCompletion> {
  const coinIds = directCoins.map((coin) => coin.id);
  const symbols = previewCoins.map((coin) => coin.symbol);
  const payload: ConfirmBulkPayload =
    gate.kind === "subscribe"
      ? {
          kind: "subscribe",
          alertTypes: gate.alertTypes,
          presetIds: gate.presetIds,
          depegWorseningBpsStep: gate.depegWorseningBpsStep,
          coinIds,
          subscribeAll: false,
        }
      : {
          kind: "unsubscribe",
          presetIds: gate.presetIds,
          coinIds,
          unsubscribeAll: false,
        };
  const persisted = await persistBulkConfirmPrompt(context, payload, { clearPending });
  if (!persisted) {
    throw new Error(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
  }
  await context.beforeIrreversibleEffect?.("command-reply");
  await sendAuditedTelegramReply(
    context.db,
    context.chatId,
    buildBulkConfirmMessage(
      gate.kind,
      previewCoins.length,
      gate.kind === "subscribe" ? gate.alertTypes : [],
      symbols,
    ),
    botToken,
    { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
  );
  // We have already replied with the inline keyboard, so signal the flow to skip
  // its own outer reply.
  return { kind: "gated" };
}

export async function persistBulkConfirmPrompt(
  context: TelegramActionContext,
  payload: ConfirmBulkPayload,
  options: {
    clearPending?: boolean;
    requireMatchingStoredIntent?: boolean;
  } = {},
): Promise<boolean> {
  const intentKind = `command:${payload.kind}`;
  const canReuseStoredExpiry = !options.requireMatchingStoredIntent
    || context.storedIntent?.kind === intentKind;
  const storedExpiresAt = canReuseStoredExpiry
    ? Number(context.storedIntent?.payload.expiresAt)
    : NaN;
  const expiresAt = Number.isFinite(storedExpiresAt)
    ? storedExpiresAt
    : (context.operationNowSec ?? Math.floor(Date.now() / 1000)) + DISAMBIGUATION_TTL_SEC;
  const intentPayload: Record<string, unknown> = {
    stage: "bulk-confirm-prompt",
    payload,
    expiresAt,
  };
  if (options.clearPending != null) {
    intentPayload.clearPending = options.clearPending;
  }
  await context.planIntent?.(createTelegramWebhookIntent(intentKind, intentPayload, "required"));

  const actionPayload = JSON.stringify(payload);
  const operationStatements = context.preparePendingMutationAppliedStatement
    ? [context.preparePendingMutationAppliedStatement({
        chatId: context.chatId,
        actionType: "confirm-bulk",
        actionPayload,
        expiresAt,
      })]
    : undefined;
  const persisted = context.wasMutationApplied
    ? true
    : await persistPendingConfirmBulk(context.db, {
        chatId: context.chatId,
        payload,
        initiatorUserId: context.initiatorUserId,
        expiresAt,
        operationStatements,
      });
  if (persisted && !context.wasMutationApplied && operationStatements) {
    context.confirmAtomicMutationApplied?.();
  }
  return persisted;
}

export function makeActionRunner(
  context: TelegramActionContext,
  botToken: string,
  gate?: BulkGate,
  runnerOptions: ActionRunnerOptions = {},
): BoundActionRunner {
  const reply = async (message: string, options?: { replyMarkup?: unknown }) => {
    await context.beforeIrreversibleEffect?.("command-reply");
    await sendAuditedTelegramReply(
      context.db,
      context.chatId,
      message,
      botToken,
      options?.replyMarkup ? { replyMarkup: options.replyMarkup } : undefined,
    );
  };
  return ({ tickers, actionType, actionPayload, alertTypes, initialCoins, clearPendingOnTerminal, resolutionScope }) =>
    runCoinResolutionFlow({
      db: context.db,
      chatId: context.chatId,
      tickers,
      initialCoins,
      actionType,
      actionPayload,
      initiatorUserId: context.initiatorUserId,
      alertTypes,
      clearPendingOnTerminal,
      resolutionScope,
      persistAmbiguous: async (resolution) => {
        const storedExpiresAt = Number(context.storedIntent?.payload.expiresAt);
        const expiresAt = Number.isFinite(storedExpiresAt)
          ? storedExpiresAt
          : (context.operationNowSec ?? Math.floor(Date.now() / 1000)) + DISAMBIGUATION_TTL_SEC;
        const normalizedPayload = {
          stage: "disambiguation-prompt",
          actionType,
          actionPayload,
          resolvedCoinIds: resolution.coins.map((coin) => coin.id),
          ambiguousTicker: resolution.ticker,
          candidateIds: resolution.candidates.map((coin) => coin.id),
          remainingTickers: resolution.remainingTickers,
          initiatorUserId: context.initiatorUserId,
          expiresAt,
          clearPending: Boolean(clearPendingOnTerminal),
        };
        await context.planIntent?.(createTelegramWebhookIntent(`command:${actionType}`, normalizedPayload, "required"));
        const serializedActionPayload = JSON.stringify(actionPayload);
        const operationStatements = context.preparePendingMutationAppliedStatement
          ? [context.preparePendingMutationAppliedStatement({
              chatId: context.chatId,
              actionType,
              actionPayload: serializedActionPayload,
              expiresAt,
            })]
          : undefined;
        if (context.wasMutationApplied) return true;
        const persisted = await persistPendingDisambiguation(context.db, {
          chatId: context.chatId,
          actionType,
          actionPayload,
          alertTypes,
          resolvedCoins: resolution.coins,
          ambiguousTicker: resolution.ticker,
          candidates: resolution.candidates,
          remainingTickers: resolution.remainingTickers,
          initiatorUserId: context.initiatorUserId,
          expiresAt,
          operationStatements,
        });
        if (persisted && operationStatements) context.confirmAtomicMutationApplied?.();
        return persisted;
      },
      reply,
      replyWithMarkup: async (message, options) => {
        await context.beforeIrreversibleEffect?.("command-reply");
        await sendAuditedTelegramReply(
          context.db,
          context.chatId,
          message,
          botToken,
          options.replyMarkup ? { replyMarkup: options.replyMarkup } : undefined,
        );
      },
      onComplete: async (coins, resolutionOptions) => {
        const presetIds = actionType === "set"
          ? []
          : dedupePresetIds(
              (actionPayload as SubscribeActionPayload | UnsubscribeActionPayload).presetIds ?? [],
            );
        const resolvedPresetCoins = await resolvePresetCoins(context.db, presetIds);
        if (resolvedPresetCoins == null && actionType !== "unsubscribe") {
          await recordTelegramUsageEvent(context.db, {
            eventType: actionType === "unsubscribe" ? "unsubscribe" : "subscribe",
            actionDetail: "preset",
            outcome: "failure",
            failureClass: "preset_unavailable",
          });
          return { kind: "message", text: buildPresetUnavailableMessage() };
        }
        const presetCoins = resolvedPresetCoins ?? [];
        const previewCoins = dedupeCoins([...coins, ...presetCoins]);
        if (gate && shouldGateBulk(previewCoins.length) && (gate.kind === actionType)) {
          return persistAndPromptBulkConfirm(
            context,
            botToken,
            gate,
            coins,
            previewCoins,
            resolutionOptions.clearPending,
          );
        }
        const text = await completionHandlers[actionType](context, coins, actionPayload, {
          ...resolutionOptions,
          presetCoins,
          presetResolutionAvailable: resolvedPresetCoins != null,
        });
        const replyMarkup = runnerOptions.replyMarkupForCompletion?.({
          actionType,
          coins,
          payload: actionPayload as ActionPayloadMap[CompletionActionType],
        });
        return { kind: "message", text, replyMarkup };
      },
    });
}
