/**
 * /settings inline-keyboard handler (P1-U7).
 *
 * Two views:
 *   - chat-level (no ticker): quiet hours toggle, snooze clear, global alert toggles.
 *   - per-coin (ticker arg): DEWS min band, safety mode, depeg step, launch.
 *
 * Callback namespace is `settings:*`. Render helpers live in
 * `telegram-webhook-settings-render.ts` and D1 mutations in settings/store
 * helpers so each surface stays narrow.
 *
 * Each callback updates D1 then edits the message in place via
 * `editMessage`. If the edit fails (e.g. message too old, identical
 * content rejected by Telegram), the handler sends a fresh message instead.
 */

import { answerCallbackQuery, editMessage } from "../lib/telegram";
import { recordTelegramUsageEvent } from "../lib/telegram-usage-analytics";
import { resolveTicker } from "../lib/telegram-alerts";
import {
  buildNotFoundMessage,
  buildStatusAmbiguousMessage,
} from "./telegram-webhook-messages";
import {
  clearAlertSnooze,
  loadSubscriberByChat,
  loadSubscriptionRowsByChat,
  loadSubscriptionsByIds,
} from "./telegram-webhook-store";
import {
  buildCoinKeyboard,
  buildCoinMessage,
  buildHomeKeyboard,
  buildHomeMessage,
} from "./telegram-webhook-settings-render";
import {
  applyCoinSetting,
  setQuietHours,
  toggleGlobalAlert,
} from "./telegram-webhook-settings-mutations";
import {
  isGlobalAlertType,
  isKnownStablecoinId,
  isSubscribableStablecoinId,
  subscriberHasGlobal,
} from "./telegram-webhook-settings-shared";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { isGroupChatType } from "./telegram-webhook-auth";
import { createTelegramWebhookIntent } from "./telegram-webhook-effect-fence";
import type { TelegramWebhookOperationIntent } from "./telegram-webhook-store";

// Re-export for tests so existing imports keep working.
export {
  buildCoinKeyboard,
  buildCoinMessage,
  buildHomeKeyboard,
  buildHomeMessage,
};

export interface SettingsCallbackQuery {
  id: string;
  data?: string;
  from?: { id?: number; username?: string };
  message?: { chat?: { id?: number; type?: string }; message_id?: number };
}

type RenderTarget = { mode: "send" } | { mode: "edit"; messageId: number };
interface SettingsRenderOptions {
  includeMiniAppButton?: boolean;
  subscriptionPage?: number;
  beforeIrreversibleEffect?: (kind: string) => Promise<void>;
}

export interface SettingsWebhookEffect {
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: () => D1PreparedStatement;
  confirmAtomicMutationApplied?: () => void;
  storedIntent?: TelegramWebhookOperationIntent | null;
  wasMutationApplied?: boolean;
}

/**
 * Render the chat-level or per-coin settings view as a top-level `/settings`
 * command. `args` is the raw command argument string (e.g. "USDC", "").
 */
export async function handleSettingsCommand(
  db: D1Database,
  botToken: string,
  chatId: string,
  _username: string | null,
  args: string,
  options: SettingsRenderOptions = {},
): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    await renderHome(db, chatId, botToken, { mode: "send" }, options);
    return;
  }
  const resolution = resolveTicker(trimmed, "tracked");
  if (resolution.status === "not_found") {
    await options.beforeIrreversibleEffect?.("settings-reply");
    await sendAuditedTelegramReply(db, chatId, buildNotFoundMessage(trimmed, resolution.suggestion), botToken, {
      actionDetail: "settings",
    });
    return;
  }
  if (resolution.status === "ambiguous") {
    await options.beforeIrreversibleEffect?.("settings-reply");
    await sendAuditedTelegramReply(db, chatId, buildStatusAmbiguousMessage(trimmed, resolution.matches), botToken, {
      actionDetail: "settings",
    });
    return;
  }
  await renderCoin(db, chatId, resolution.matches[0].id, botToken, { mode: "send" }, options);
}

/** Dispatch a `settings:*` callback_query. */
export async function handleSettingsCallback(
  db: D1Database,
  botToken: string,
  cb: SettingsCallbackQuery,
  subAction: string,
  subArg: string,
  effectInput: SettingsWebhookEffect | ((kind: string) => Promise<void>) = async () => undefined,
): Promise<void> {
  const effect: SettingsWebhookEffect = typeof effectInput === "function"
    ? { beforeIrreversibleEffect: effectInput }
    : effectInput;
  const { beforeIrreversibleEffect } = effect;
  const answer = async (options?: { text?: string }): Promise<void> => {
    await beforeIrreversibleEffect("callback-ack");
    await answerCallbackQuery(cb.id, botToken, options);
  };
  const chatId = cb.message?.chat?.id?.toString();
  const messageId = cb.message?.message_id;
  if (!chatId || messageId == null) {
    await answer();
    return;
  }
  const chatType = cb.message?.chat?.type ?? "private";
  const username = isGroupChatType(chatType) ? null : cb.from?.username ?? null;
  const target: RenderTarget = { mode: "edit", messageId };
  const prepareMutation = async (
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<{ operationStatements?: D1PreparedStatement[] }> => {
    await effect.planIntent?.(createTelegramWebhookIntent(kind, payload, "required"));
    return effect.prepareMutationAppliedStatement
      ? { operationStatements: [effect.prepareMutationAppliedStatement()] }
      : {};
  };
  const confirmMutation = (operation: { operationStatements?: D1PreparedStatement[] }): void => {
    if (operation.operationStatements) effect.confirmAtomicMutationApplied?.();
  };

  if (subAction === "home") {
    const subscriptionPage = parseSettingsHomePage(subArg);
    if (subscriptionPage == null) {
      await answer({ text: "Action not recognized." });
      return;
    }
    await renderHome(db, chatId, botToken, target, { subscriptionPage, beforeIrreversibleEffect });
    await answer();
    return;
  }

  if (subAction === "gt") {
    if (!isGlobalAlertType(subArg)) {
      await answer({ text: "Unknown alert type." });
      return;
    }
    const storedNext = Number(effect.storedIntent?.payload.next);
    const subscriber = storedNext === 0 || storedNext === 1
      ? null
      : await loadSubscriberByChat(db, chatId);
    const next: 0 | 1 = storedNext === 0 || storedNext === 1
      ? storedNext
      : (subscriberHasGlobal(subscriber, subArg) ? 0 : 1);
    const operation = await prepareMutation("callback:settings-gt", { alertType: subArg, next });
    if (!effect.wasMutationApplied) {
      await toggleGlobalAlert(db, chatId, username, subArg, { ...operation, next });
      confirmMutation(operation);
    }
    await recordTelegramUsageEvent(db, {
      eventType: "global_alert_change",
      actionDetail: subArg,
      outcome: "toggled",
    });
    await renderHome(db, chatId, botToken, target, { beforeIrreversibleEffect });
    await answer({ text: `Updated global ${subArg}.` });
    return;
  }

  if (subAction === "q") {
    if (subArg !== "0" && subArg !== "1") {
      await answer({ text: "Action not recognized." });
      return;
    }
    const enabled = subArg === "1";
    const operation = await prepareMutation("callback:settings-q", { enabled });
    if (!effect.wasMutationApplied) {
      await setQuietHours(db, chatId, username, enabled, operation);
      confirmMutation(operation);
    }
    await recordTelegramUsageEvent(db, {
      eventType: "quiet_hours_change",
      actionDetail: "settings",
      outcome: enabled ? "enabled" : "disabled",
    });
    await renderHome(db, chatId, botToken, target, { beforeIrreversibleEffect });
    await answer({
      text: enabled ? "Quiet hours enabled." : "Quiet hours disabled.",
    });
    return;
  }

  if (subAction === "sc") {
    if (subArg !== "") {
      await answer({ text: "Action not recognized." });
      return;
    }
    const operation = await prepareMutation("callback:settings-sc", { snoozeUntil: null });
    if (!effect.wasMutationApplied) {
      await clearAlertSnooze(db, chatId, username, operation);
      confirmMutation(operation);
    }
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "settings",
      outcome: "cleared",
    });
    await renderHome(db, chatId, botToken, target, { beforeIrreversibleEffect });
    await answer({ text: "Snooze cleared." });
    return;
  }

  if (subAction === "o") {
    if (!isKnownStablecoinId(subArg)) {
      await answer({ text: "Unknown coin." });
      return;
    }
    await renderCoin(db, chatId, subArg, botToken, target, { beforeIrreversibleEffect });
    await answer();
    return;
  }

  if (subAction === "c") {
    const settingParts = subArg.split(":");
    if (settingParts.length !== 3) {
      await answer({ text: "Unknown setting." });
      return;
    }
    const [coinId, setting, value] = settingParts;
    if (!isSubscribableStablecoinId(coinId) || !setting || value == null) {
      await answer({ text: "Unknown setting." });
      return;
    }
    const operation = await prepareMutation("callback:settings-c", { coinId, setting, value });
    const applied = effect.wasMutationApplied
      ? "Setting updated."
      : await applyCoinSetting(db, chatId, username, coinId, setting, value, operation);
    if (!applied) {
      await answer({ text: "Unknown setting." });
      return;
    }
    if (!effect.wasMutationApplied) confirmMutation(operation);
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: `settings_${setting}`,
      outcome: value === "0" ? "opt_out" : "opt_in",
    });
    await renderCoin(db, chatId, coinId, botToken, target, { beforeIrreversibleEffect });
    await answer({ text: applied });
    return;
  }

  await answer({ text: "Action not recognized." });
}

async function renderHome(
  db: D1Database,
  chatId: string,
  botToken: string,
  target: RenderTarget,
  options: SettingsRenderOptions = {},
): Promise<void> {
  const [subscriber, subscriptions] = await Promise.all([
    loadSubscriberByChat(db, chatId),
    loadSubscriptionRowsByChat(db, chatId),
  ]);
  await deliver(
    db,
    chatId,
    buildHomeMessage(subscriber, { hasCoinControls: subscriptions.length > 0 }),
    buildHomeKeyboard(subscriber, { ...options, subscriptions }),
    botToken,
    target,
    options.beforeIrreversibleEffect,
  );
}

function parseSettingsHomePage(subArg: string): number | null {
  if (subArg === "") return 0;
  if (!/^\d+$/.test(subArg)) return null;
  return Number(subArg);
}

async function renderCoin(
  db: D1Database,
  chatId: string,
  coinId: string,
  botToken: string,
  target: RenderTarget,
  options: SettingsRenderOptions = {},
): Promise<void> {
  const rows = await loadSubscriptionsByIds(db, chatId, [coinId]);
  const row = rows[0] ?? null;
  await deliver(
    db,
    chatId,
    buildCoinMessage(coinId, row),
    buildCoinKeyboard(coinId, row, options),
    botToken,
    target,
    options.beforeIrreversibleEffect,
  );
}

async function deliver(
  db: D1Database,
  chatId: string,
  message: string,
  replyMarkup: unknown,
  botToken: string,
  target: RenderTarget,
  beforeIrreversibleEffect: (kind: string) => Promise<void> = async () => undefined,
): Promise<void> {
  if (target.mode === "edit") {
    await beforeIrreversibleEffect("settings-edit");
    const ok = await editMessage(chatId, target.messageId, message, botToken, {
      disableWebPagePreview: true,
      replyMarkup,
    });
    if (ok) return;
    // Edit failed (e.g. message too old / unchanged content). Fall back to a
    // fresh send so the user still sees the new state.
  }
  await beforeIrreversibleEffect("settings-reply");
  await sendAuditedTelegramReply(db, chatId, message, botToken, {
    replyMarkup,
    actionDetail: "settings",
  });
}
