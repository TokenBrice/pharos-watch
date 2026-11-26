/**
 * Group `/settings` inline-keyboard handler.
 *
 * Views:
 *   - Home (`settings:home[:<page>]`): quiet hours, pause/resume, followed presets,
 *     `All stablecoins ▸`, and 2-column paginated direct coins (8/page).
 *   - All stablecoins (`settings:g:<page>`): chat-wide family toggles (`settings:gt`).
 *   - Preset detail (`settings:p:<preset>:<page>`): DEWS/Depeg/Safety toggles
 *     (`settings:pf`) and two-step Unfollow (`settings:pu` → `settings:pc`).
 *   - Per-coin (`settings:o:<coin>:<page>`): DEWS, Depeg (including `ds:a`),
 *     Safety on/off, Reserve, Freeze (`settings:c`).
 *
 * Each callback updates D1 then edits the message in place via `editMessage`.
 * If the edit fails (e.g. message too old), it falls back to a fresh reply.
 */

import { answerCallbackQuery, editMessage, escapeHtml } from "../delivery/telegram";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { resolveTicker } from "../common/alerts-parser";
import { TELEGRAM_PRESET_LABEL_BY_ID, type TelegramPresetId } from "../common/presets";
import { isSubscribableCoin } from "../store/subscription-eligibility";
import type { TelegramCallbackQuery } from "../callbacks/_shared";
import {
  buildNotFoundMessage,
  buildStatusAmbiguousMessage,
  cmdForChat,
  fitsCallbackData,
} from "./telegram-webhook-messages";
import { clearAlertSnooze } from "../store/snooze";
import { loadPresetSubscriptions, removePresetSubscriptions } from "../store/presets";
import { loadSubscriberByChat } from "../store/subscribers";
import { loadSubscriptionRowsByChat, loadSubscriptionsByIds } from "../store/subscriptions";
import {
  buildCoinKeyboard,
  buildCoinMessage,
  buildGlobalKeyboard,
  buildGlobalMessage,
  buildHomeKeyboard,
  buildHomeMessage,
  buildPresetKeyboard,
  buildPresetMessage,
  buildPresetUnfollowConfirmKeyboard,
  buildPresetUnfollowConfirmMessage,
} from "./telegram-webhook-settings-render";
import {
  applyCoinSetting,
  applySettingsSnooze,
  setQuietHours,
  toggleGlobalAlert,
  updatePresetFamilySetting,
} from "./telegram-webhook-settings-mutations";
import { parseSettingsCallback } from "./telegram-webhook-settings-shared";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_LAUNCH_RETIRED_MESSAGE,
} from "@shared/lib/telegram-alert-families";
import { isGroupChatType } from "./telegram-webhook-auth";

type SettingsCallbackQuery = TelegramCallbackQuery;

type RenderTarget = { mode: "send" } | { mode: "edit"; messageId: number };
interface SettingsRenderOptions {
  includeMiniAppButton?: boolean;
  subscriptionPage?: number;
  chatType?: string;
}

const MAX_SETTINGS_DISAMBIGUATION_BUTTONS = 8;

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
  const chatType = options.chatType ?? "group";
  if (!trimmed) {
    await renderHome(db, chatId, botToken, { mode: "send" }, { ...options, chatType });
    return;
  }
  const resolution = resolveTicker(trimmed, "tracked");
  if (resolution.status === "not_found") {
    await sendAuditedTelegramReply(db, chatId, buildNotFoundMessage(trimmed, resolution.suggestion), botToken, {
      actionDetail: "settings",
    });
    return;
  }
  if (resolution.status === "ambiguous") {
    const subscribable = resolution.matches.filter((coin) => isSubscribableCoin(coin.id));
    if (subscribable.length === 0) {
      await sendAuditedTelegramReply(
        db,
        chatId,
        escapeHtml(`${resolution.matches[0]!.symbol} is not active for alerts.`),
        botToken,
        { actionDetail: "settings" },
      );
      return;
    }
    if (subscribable.length === 1) {
      await renderCoin(db, chatId, subscribable[0]!.id, botToken, { mode: "send" }, { ...options, chatType });
      return;
    }
    const buttons = subscribable.length <= MAX_SETTINGS_DISAMBIGUATION_BUTTONS
      ? subscribable.map((coin) => [{
          text: `${coin.symbol} · ${coin.name}`,
          callback_data: `settings:o:${coin.id}`,
        }])
      : null;
    if (buttons && buttons.every(([btn]) => fitsCallbackData(btn!.callback_data))) {
      await sendAuditedTelegramReply(
        db,
        chatId,
        `"${escapeHtml(trimmed)}" matches ${subscribable.length} coins. Which one?`,
        botToken,
        { actionDetail: "settings", replyMarkup: { inline_keyboard: buttons } },
      );
      return;
    }
    await sendAuditedTelegramReply(
      db,
      chatId,
      buildStatusAmbiguousMessage(trimmed, subscribable, cmdForChat("settings", chatType)),
      botToken,
      { actionDetail: "settings" },
    );
    return;
  }
  const coin = resolution.matches[0]!;
  if (!isSubscribableCoin(coin.id)) {
    await sendAuditedTelegramReply(
      db,
      chatId,
      escapeHtml(`${coin.symbol} is not active for alerts.`),
      botToken,
      { actionDetail: "settings" },
    );
    return;
  }
  await renderCoin(db, chatId, coin.id, botToken, { mode: "send" }, { ...options, chatType });
}

const LAUNCH_RETIRED_TOAST = TELEGRAM_LAUNCH_RETIRED_MESSAGE;

/** Dispatch a `settings:*` callback_query. */
export async function handleSettingsCallback(
  db: D1Database,
  botToken: string,
  cb: SettingsCallbackQuery,
  subAction: string,
  subArg: string,
): Promise<void> {
  const answer = async (options?: { text?: string }): Promise<void> => {
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
  const parts = subArg === "" ? ["settings", subAction] : ["settings", subAction, ...subArg.split(":")];
  const parsed = parseSettingsCallback(parts);

  switch (parsed.kind) {
    case "invalid":
      await answer({ text: parsed.toast });
      return;

    case "retired_launch":
      await answer({ text: LAUNCH_RETIRED_TOAST });
      return;

    case "home":
      await renderHome(db, chatId, botToken, target, { subscriptionPage: parsed.page, chatType });
      await answer();
      return;

    case "global":
      await renderGlobal(db, chatId, botToken, target, parsed.page);
      await answer();
      return;

    case "open_coin":
      await renderCoin(db, chatId, parsed.coinId, botToken, target, { subscriptionPage: parsed.page, chatType });
      await answer();
      return;

    case "open_preset":
      await renderPreset(db, chatId, parsed.presetId, botToken, target, parsed.page);
      await answer();
      return;

    case "preset_unfollow_prompt":
      await deliver(
        db,
        chatId,
        buildPresetUnfollowConfirmMessage(parsed.presetId),
        buildPresetUnfollowConfirmKeyboard(parsed.presetId, parsed.page),
        botToken,
        target,
      );
      await answer();
      return;

    case "preset_unfollow_confirm": {
      await removePresetSubscriptions(db, chatId, [parsed.presetId]);
      await recordTelegramUsageEvent(db, {
        eventType: "preset_unfollow",
        actionDetail: "settings",
        outcome: "success",
      });
      await renderHome(db, chatId, botToken, target, { subscriptionPage: parsed.page, chatType });
      const label = TELEGRAM_PRESET_LABEL_BY_ID.get(parsed.presetId) ?? parsed.presetId;
      await answer({ text: `Unfollowed ${label}.` });
      return;
    }

    case "preset_family": {
      const outcome = await updatePresetFamilySetting(
        db,
        chatId,
        username,
        parsed.presetId,
        parsed.family,
        parsed.enabled,
      );
      if (outcome === "last-family-locked") {
        await answer({ text: "Keep at least one alert on, or tap Unfollow." });
        return;
      }
      await recordTelegramUsageEvent(db, {
        eventType: "preset_follow",
        actionDetail: `settings_${parsed.family}`,
        outcome: parsed.enabled ? "opt_in" : "opt_out",
      });
      await renderPreset(db, chatId, parsed.presetId, botToken, target, parsed.page);
      const familyLabel = TELEGRAM_ALERT_FAMILY_SHORT_LABELS[parsed.family];
      await answer({ text: `${familyLabel} ${parsed.enabled ? "on" : "off"}.` });
      return;
    }

    case "global_toggle":
      if (parsed.next === null) {
        // Legacy bare `settings:gt:<type>` button refreshes without toggling.
        await renderGlobal(db, chatId, botToken, target, parsed.page);
        await answer({ text: "Settings refreshed. Tap again to change." });
        return;
      }
      await toggleGlobalAlert(db, chatId, username, parsed.alertType, { next: parsed.next });
      await recordTelegramUsageEvent(db, {
        eventType: "global_alert_change",
        actionDetail: parsed.alertType,
        outcome: parsed.next ? "opt_in" : "opt_out",
      });
      await renderGlobal(db, chatId, botToken, target, parsed.page);
      await answer({ text: `Global ${parsed.alertType} ${parsed.next ? "on" : "off"}.` });
      return;

    case "quiet_hours":
      await setQuietHours(db, chatId, username, parsed.enabled, {});
      await recordTelegramUsageEvent(db, {
        eventType: "quiet_hours_change",
        actionDetail: "settings",
        outcome: parsed.enabled ? "enabled" : "disabled",
      });
      await renderHome(db, chatId, botToken, target, { chatType });
      await answer({ text: parsed.enabled ? "Quiet hours enabled." : "Quiet hours disabled." });
      return;

    case "snooze_clear":
      await clearAlertSnooze(db, chatId, username, {});
      await recordTelegramUsageEvent(db, {
        eventType: "snooze_change",
        actionDetail: "settings",
        outcome: "cleared",
      });
      await renderHome(db, chatId, botToken, target, { chatType });
      await answer({ text: "Alerts resumed." });
      return;

    case "snooze": {
      const toast = await applySettingsSnooze(db, chatId, username, parsed.action);
      await recordTelegramUsageEvent(db, {
        eventType: "snooze_change",
        actionDetail: "settings",
        outcome: parsed.action === "off" ? "cleared" : parsed.action === "pause" ? "enabled" : "set",
      });
      await renderHome(db, chatId, botToken, target, { chatType });
      await answer({ text: toast });
      return;
    }

    case "coin_setting": {
      const applied = await applyCoinSetting(
        db,
        chatId,
        username,
        parsed.coinId,
        parsed.setting,
        parsed.value,
        {},
      );
      if (!applied) {
        await answer({ text: "Unknown setting." });
        return;
      }
      await recordTelegramUsageEvent(db, {
        eventType: "subscribe",
        actionDetail: `settings_${parsed.setting}`,
        outcome: parsed.value === "0" ? "opt_out" : "opt_in",
      });
      await renderCoin(db, chatId, parsed.coinId, botToken, target, {
        subscriptionPage: parsed.page,
        chatType,
      });
      await answer({ text: applied });
      return;
    }
  }
}

async function renderHome(
  db: D1Database,
  chatId: string,
  botToken: string,
  target: RenderTarget,
  options: SettingsRenderOptions = {},
): Promise<void> {
  const [subscriber, subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriberByChat(db, chatId),
    loadSubscriptionRowsByChat(db, chatId),
    loadPresetSubscriptions(db, chatId),
  ]);
  await deliver(
    db,
    chatId,
    buildHomeMessage(subscriber, {
      hasCoinControls: subscriptions.length > 0,
      presetSubscriptions,
      chatType: options.chatType,
    }),
    buildHomeKeyboard(subscriber, { ...options, subscriptions, presetSubscriptions }),
    botToken,
    target,
  );
}

async function renderGlobal(
  db: D1Database,
  chatId: string,
  botToken: string,
  target: RenderTarget,
  returnPage = 0,
): Promise<void> {
  const subscriber = await loadSubscriberByChat(db, chatId);
  await deliver(
    db,
    chatId,
    buildGlobalMessage(subscriber),
    buildGlobalKeyboard(subscriber, returnPage),
    botToken,
    target,
  );
}

async function renderPreset(
  db: D1Database,
  chatId: string,
  presetId: TelegramPresetId,
  botToken: string,
  target: RenderTarget,
  returnPage: number,
): Promise<void> {
  const presets = await loadPresetSubscriptions(db, chatId);
  const row = presets.find((candidate) => candidate.preset_id === presetId) ?? null;
  await deliver(
    db,
    chatId,
    buildPresetMessage(presetId, row),
    buildPresetKeyboard(presetId, row, returnPage),
    botToken,
    target,
  );
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
    buildCoinKeyboard(coinId, row, {
      includeMiniAppButton: options.includeMiniAppButton,
      returnPage: options.subscriptionPage ?? 0,
    }),
    botToken,
    target,
  );
}

async function deliver(
  db: D1Database,
  chatId: string,
  message: string,
  replyMarkup: unknown,
  botToken: string,
  target: RenderTarget,
): Promise<void> {
  if (target.mode === "edit") {
    const ok = await editMessage(chatId, target.messageId, message, botToken, {
      disableWebPagePreview: true,
      replyMarkup,
    });
    if (ok) return;
    // Edit failed (e.g. message too old / unchanged content). Fall back to a
    // fresh send so the user still sees the new state.
  }
  await sendAuditedTelegramReply(db, chatId, message, botToken, {
    replyMarkup,
    actionDetail: "settings",
  });
}
