/**
 * `/start` onboarding. One card, three choices, no stored wizard state:
 *
 *   setup:top25   follow the USD Top 25 preset for depeg and stress alerts
 *   setup:undo:<mask>:<expiry>   restore the preset follow as it was before
 *                 the tap (mask of prior families, base-36 expiry; offered
 *                 only when the tap changed something)
 *   setup:sample  show one sample alert
 *
 * "Choose my own coins" is a Mini App button. Returning users get a short
 * summary instead of the new-user card.
 */

import { TELEGRAM_BOT_URL, TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import { MINI_APP_PAYLOAD_NAMES } from "@shared/lib/telegram-mini-app-payloads";
import { escapeHtml, type InlineKeyboardButton, type InlineKeyboardMarkup } from "../delivery/telegram";
import { buildTelegramMiniAppUrl } from "../common/mini-app-url";
import { TELEGRAM_PRESET_LABEL_BY_ID, resolveTelegramPresetTargets, type TelegramPresetId } from "../common/presets";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  applySubscribeIntent,
  applyUnsubscribeIntent,
  loadPresetSubscriptions,
  prepareSubscriberAndPresetPatchStatements,
} from "../store/presets";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import {
  MANAGE_ALERTS_LABEL,
  buildPresetUnavailableMessage,
  describeDeliveryState,
  describeFollows,
  followsNothing,
} from "./telegram-webhook-messages";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { executeAtomicBatch } from "../../lib/db";
import { decodeAlertTypes, encodeAlertTypes } from "../callbacks/pick";
import { isUnexpired } from "../callbacks/confirm";

export const RECOMMENDED_PRESET_ID: TelegramPresetId = "usd-top25";
const RECOMMENDED_ALERT_TYPES = ["dews", "depeg"] as const;
const FOLLOW_TOP_LABEL = "Follow the top 25 USD stablecoins";
const UNDO_TTL_SEC = 24 * 3600;

const NEW_USER_MESSAGE = `<b>Pharos Watch</b>
Stablecoin alerts from pharos.watch, sent only when something changes.

Tap below to follow the 25 largest USD stablecoins. You'll hear when one loses its peg or its stress level rises.`;

const GROUP_ADMIN_MESSAGE = `<b>Pharos Watch</b>
Turn on alerts for this group in one tap, or type /subscribe@${TELEGRAM_BOT_USERNAME} followed by tickers or a preset.`;

const GROUP_MEMBER_MESSAGE = `<b>Pharos Watch is in this group.</b>
Admins can turn on alerts here, e.g. /subscribe@${TELEGRAM_BOT_USERNAME} usd-top25
For your own alerts and quiet hours, message me privately.`;

function manageAlertsButton(): InlineKeyboardButton {
  return { text: MANAGE_ALERTS_LABEL, web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.watchlist) } };
}

/** The new-user choices. Private chats only: groups cannot open the Mini App. */
export function buildOnboardingKeyboard(options: { includeSample?: boolean } = {}): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [
    [{ text: FOLLOW_TOP_LABEL, callback_data: "setup:top25" }],
    [{ text: "Choose my own coins", web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.watchlist) } }],
  ];
  if (options.includeSample !== false) rows.push([{ text: "Show me a sample alert", callback_data: "setup:sample" }]);
  return { inline_keyboard: rows };
}

interface OnboardingReplyContext {
  db: D1Database;
  botToken: string;
  chatId: string;
  chatType: string;
  isGroupAdmin: boolean;
  operationNowSec?: number;
}

async function sendSetupReply(
  context: Pick<OnboardingReplyContext, "db" | "botToken" | "chatId">,
  message: string,
  replyMarkup?: unknown,
): Promise<void> {
  await sendAuditedTelegramReply(context.db, context.chatId, message, context.botToken, {
    actionDetail: "setup",
    ...(replyMarkup ? { replyMarkup } : {}),
  });
}

/** `/start` without a coin or subscribe payload. */
export async function sendOnboarding(context: OnboardingReplyContext): Promise<void> {
  if (context.chatType !== "private") {
    if (!context.isGroupAdmin) {
      await sendSetupReply(context, GROUP_MEMBER_MESSAGE, {
        inline_keyboard: [[{ text: "Personal alerts", url: `${TELEGRAM_BOT_URL}?start=setup` }]],
      });
      return;
    }
    await sendSetupReply(context, GROUP_ADMIN_MESSAGE, {
      inline_keyboard: [[{ text: FOLLOW_TOP_LABEL, callback_data: "setup:top25" }]],
    });
    return;
  }

  const [subscriber, subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriberByChat(context.db, context.chatId),
    loadSubscriptionRowsByChat(context.db, context.chatId),
    loadPresetSubscriptions(context.db, context.chatId),
  ]);
  if (followsNothing({ subscriber, subscriptions, presetSubscriptions })) {
    await sendSetupReply(context, NEW_USER_MESSAGE, buildOnboardingKeyboard());
    return;
  }
  const nowSec = context.operationNowSec ?? unixNow();
  const lines = [
    "<b>Welcome back.</b> You follow:",
    ...describeFollows({ subscriber, subscriptions, presetSubscriptions, presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID, nowSec }),
    ...describeDeliveryState(subscriber, nowSec),
  ];
  await sendSetupReply(context, lines.join("\n"), {
    inline_keyboard: [
      [manageAlertsButton()],
      [{ text: "Pause 24h", callback_data: "snooze:24h" }, { text: "Help", callback_data: "help:commands" }],
    ],
  });
}

interface SetupCallbackContext {
  db: D1Database;
  botToken: string;
  chatId: string;
  chatType: string;
  username: string | null;
}

/** `setup:top25`: one tap follows the recommended preset; Undo replaces a confirm step. */
export async function handleSetupFollowTop(context: SetupCallbackContext): Promise<{ text: string }> {
  const resolved = await resolveTelegramPresetTargets(context.db, [RECOMMENDED_PRESET_ID]);
  if (resolved.kind !== "ok") {
    await sendSetupReply(context, buildPresetUnavailableMessage());
    return { text: "Try again in a moment." };
  }
  const existing = (await loadPresetSubscriptions(context.db, context.chatId))
    .find((row) => row.preset_id === RECOMMENDED_PRESET_ID);
  const alreadyFollowing = Boolean(existing?.alert_dews && existing.alert_depeg);
  await recordTelegramUsageEvent(context.db, {
    eventType: "setup_choice",
    sourceCategory: "wizard",
    actionDetail: "recommended",
    outcome: "selected",
  });
  if (!alreadyFollowing) {
    await applySubscribeIntent(context.db, {
      chatId: context.chatId,
      username: context.username,
      alertTypes: new Set(RECOMMENDED_ALERT_TYPES),
      directStablecoinIds: [],
      presetIds: [RECOMMENDED_PRESET_ID],
      clearPending: true,
    });
    await recordTelegramUsageEvent(context.db, {
      eventType: "setup_complete",
      sourceCategory: "recommended",
      actionDetail: "preset",
      outcome: "success",
    });
  }
  const count = resolved.presets[0]?.coins.length ?? 0;
  const isPrivate = context.chatType === "private";
  const lines = [
    alreadyFollowing
      ? `<b>You already follow</b> the ${count} largest USD stablecoins for depeg and stress alerts.`
      : `<b>Done.</b> You follow the ${count} largest USD stablecoins for depeg and stress alerts.`,
    "",
    "Here's what an alert looks like:",
    `<blockquote>${escapeHtml(TELEGRAM_PUBLIC_ALERT_SAMPLES.depeg.message)}</blockquote>`,
    isPrivate
      ? `<b>${MANAGE_ALERTS_LABEL}</b> (the button by the message box) is where you add coins, set quiet hours or pause.`
      : "Change this group's alerts with /settings.",
    "Pharos news: @pharoswatch · Community: @pharoswatchers",
  ];
  const row: InlineKeyboardButton[] = isPrivate ? [manageAlertsButton()] : [];
  if (!alreadyFollowing) {
    const prior = new Set((["dews", "depeg", "safety"] as const).filter((type) => existing?.[`alert_${type}`] === 1));
    const expiry = (unixNow() + UNDO_TTL_SEC).toString(36);
    row.push({ text: "Undo", callback_data: `setup:undo:${encodeAlertTypes(prior)}:${expiry}` });
  }
  await sendSetupReply(context, lines.join("\n"), row.length > 0 ? { inline_keyboard: [row] } : undefined);
  return { text: alreadyFollowing ? "Already following." : "Following." };
}

/**
 * `setup:undo:<mask>:<expiry>`: put the USD Top 25 follow back the way it was
 * before the one-tap setup. Mask 0 means there was no follow, so the row goes;
 * otherwise exactly the prior families are restored. Direct coin follows stay.
 */
export async function handleSetupUndo(
  context: SetupCallbackContext,
  maskCode: string | undefined,
  expiryCode: string | undefined,
): Promise<{ text: string }> {
  const prior = maskCode === "0" ? new Set<string>() : decodeAlertTypes(maskCode);
  if (!prior || [...prior].some((type) => type !== "dews" && type !== "depeg" && type !== "safety")) {
    return { text: "Action not recognized." };
  }
  if (!isUnexpired(expiryCode)) return { text: "This Undo expired. Change your alerts in Manage Alerts." };
  if (prior.size === 0) {
    await applyUnsubscribeIntent(context.db, {
      chatId: context.chatId,
      directStablecoinIds: [],
      presetIds: [RECOMMENDED_PRESET_ID],
    });
  } else {
    await executeAtomicBatch(context.db, prepareSubscriberAndPresetPatchStatements(
      context.db, context.chatId, context.username, RECOMMENDED_PRESET_ID,
      { dews: prior.has("dews"), depeg: prior.has("depeg"), safety: prior.has("safety") },
      undefined,
    ));
  }
  await recordTelegramUsageEvent(context.db, {
    eventType: "preset_unfollow",
    actionDetail: "setup_undo",
    outcome: "success",
  });
  await sendSetupReply(
    context,
    prior.size === 0
      ? "Undone. You no longer follow the top 25 USD stablecoins. Send /start to choose again."
      : "Undone. Your USD Top 25 alerts are back to what they were.",
  );
  return { text: "Undone." };
}

/** `setup:sample`: the same sample `/sample` sends. */
export async function handleSetupSample(
  context: Pick<SetupCallbackContext, "db" | "botToken" | "chatId">,
): Promise<{ text: string }> {
  await sendSetupReply(
    context,
    `${escapeHtml(TELEGRAM_PUBLIC_ALERT_SAMPLES.depeg.message)}\n\n<i>This was a sample alert.</i>`,
    buildOnboardingKeyboard({ includeSample: false }),
  );
  return { text: "Sample sent." };
}
