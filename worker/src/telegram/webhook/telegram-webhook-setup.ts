/**
 * `/start` onboarding. One card, three choices, a bounded Undo proof:
 *
 *   setup:top25   follow the USD Top 25 preset for depeg and Early warning (DEWS) alerts
 *   setup:undo:<mask>:<expiry>-<generation>.<identity>   restore the preset follow as it was before
 *                 the tap (prior families, base-36 expiry/generation, opaque identity; offered
 *                 only when the tap changed something)
 *   setup:sample  show one sample alert
 *
 * "Choose my own coins" is a Mini App button. Returning users and returning
 * groups get a short summary instead of the new-user card.
 */

import { TELEGRAM_BOT_URL, TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import { TELEGRAM_PRESET_ALERT_TYPES } from "@shared/lib/telegram-alert-families";
import { MINI_APP_PAYLOAD_NAMES } from "@shared/lib/telegram-mini-app-payloads";
import { editMessage, escapeHtml, type InlineKeyboardButton, type InlineKeyboardMarkup } from "../delivery/telegram";
import { buildTelegramMiniAppUrl } from "../common/mini-app-url";
import { TELEGRAM_PRESET_LABEL_BY_ID, resolveTelegramPresetTargets, type TelegramPresetId } from "../common/presets";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  loadPresetSubscriptions,
  followPresetForSetup,
  restorePresetSubscription,
} from "../store/presets";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { loadSubscriptionRowsByChat } from "../store/subscriptions";
import {
  MANAGE_ALERTS_LABEL,
  buildPresetUnavailableMessage,
  cmdForChat,
  describeDeliveryState,
  describeFollows,
  followsNothing,
} from "./telegram-webhook-messages";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import { decodeAlertTypes, encodeAlertTypes } from "../callbacks/pick";
import { isUnexpired } from "../callbacks/confirm";

const RECOMMENDED_PRESET_ID: TelegramPresetId = "usd-top25";
const FOLLOW_TOP_LABEL = "Follow the top 25 USD stablecoins";
const UNDO_TTL_SEC = 24 * 3600;

const NEW_USER_MESSAGE = `<b>Pharos Watch</b>
Stablecoin alerts from pharos.watch, sent only when something changes.

Tap below to follow the 25 largest USD stablecoins. You'll hear when one loses its peg or its Early warning (DEWS) stress rises.`;

const GROUP_ADMIN_MESSAGE = `<b>Pharos Watch</b>
Turn on alerts for this group in one tap, or type /subscribe@${TELEGRAM_BOT_USERNAME} followed by tickers or a preset.`;

const GROUP_MEMBER_MESSAGE = `<b>Pharos Watch is in this group.</b>
Admins can turn on alerts here, e.g. /subscribe@${TELEGRAM_BOT_USERNAME} usd-top25
For your own alerts and quiet hours, message me privately.`;

function manageAlertsButton(): InlineKeyboardButton {
  return { text: MANAGE_ALERTS_LABEL, web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.home) } };
}

/** Framed sample alert shared by `/sample` and `setup:sample`. */
export function buildSampleAlertMessage(): string {
  return [
    "<b>Sample alert</b> (example only, not live)",
    `<blockquote>${escapeHtml(TELEGRAM_PUBLIC_ALERT_SAMPLES.depeg.message)}</blockquote>`,
  ].join("\n");
}

/** The new-user choices. Private chats only: groups cannot open the Mini App. */
export function buildOnboardingKeyboard(options: { includeSample?: boolean; includeManageAlerts?: boolean } = {}): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [
    [{ text: FOLLOW_TOP_LABEL, callback_data: "setup:top25" }],
    [{ text: "Choose my own coins", web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.setup) } }],
  ];
  if (options.includeManageAlerts) rows.push([manageAlertsButton()]);
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

/** `/start` without a coin, status, or subscribe payload. */
export async function sendOnboarding(context: OnboardingReplyContext): Promise<void> {
  const [subscriber, subscriptions, presetSubscriptions] = await Promise.all([
    loadSubscriberByChat(context.db, context.chatId),
    loadSubscriptionRowsByChat(context.db, context.chatId),
    loadPresetSubscriptions(context.db, context.chatId),
  ]);
  const empty = followsNothing({ subscriber, subscriptions, presetSubscriptions });
  const nowSec = context.operationNowSec ?? unixNow();
  const isPaused = (subscriber?.alert_snooze_until_ts ?? 0) > nowSec;

  if (context.chatType !== "private") {
    if (empty) {
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
    const lines = [
      "<b>Pharos Watch is active in this group.</b> Following:",
      ...describeFollows({
        subscriber,
        subscriptions,
        presetSubscriptions,
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
        nowSec,
        chatType: context.chatType,
      }),
      ...describeDeliveryState(subscriber, nowSec, context.chatType),
    ];
    if (!context.isGroupAdmin) {
      await sendSetupReply(context, lines.join("\n"), {
        inline_keyboard: [[{ text: "Personal alerts", url: `${TELEGRAM_BOT_URL}?start=setup` }]],
      });
      return;
    }
    await sendSetupReply(context, lines.join("\n"), {
      inline_keyboard: [
        [{ text: "Group settings", callback_data: "settings:home" }],
        [
          isPaused ? { text: "Resume alerts", callback_data: "snooze:off" } : { text: "Pause 24h", callback_data: "snooze:24h" },
          { text: "Help", callback_data: "help:commands" },
        ],
      ],
    });
    return;
  }

  if (empty) {
    await sendSetupReply(context, NEW_USER_MESSAGE, buildOnboardingKeyboard());
    return;
  }
  const lines = [
    "<b>Welcome back.</b> You follow:",
    ...describeFollows({
      subscriber,
      subscriptions,
      presetSubscriptions,
      presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
      nowSec,
      chatType: context.chatType,
    }),
    ...describeDeliveryState(subscriber, nowSec, context.chatType),
  ];
  await sendSetupReply(context, lines.join("\n"), {
    inline_keyboard: [
      [manageAlertsButton()],
      [
        isPaused ? { text: "Resume alerts", callback_data: "snooze:off" } : { text: "Pause 24h", callback_data: "snooze:24h" },
        { text: "Help", callback_data: "help:commands" },
      ],
    ],
  });
}

interface SetupCallbackContext {
  db: D1Database;
  botToken: string;
  chatId: string;
  chatType: string;
  username: string | null;
  messageId?: number;
}

/** `setup:top25`: one tap follows the recommended preset; Undo replaces a confirm step. */
export async function handleSetupFollowTop(context: SetupCallbackContext): Promise<{ text: string }> {
  const resolved = await resolveTelegramPresetTargets(context.db, [RECOMMENDED_PRESET_ID]);
  if (resolved.kind !== "ok") {
    await sendSetupReply(context, buildPresetUnavailableMessage());
    return { text: "Try again in a moment." };
  }
  await recordTelegramUsageEvent(context.db, {
    eventType: "setup_choice",
    sourceCategory: "wizard",
    actionDetail: "recommended",
    outcome: "selected",
  });
  const result = await followPresetForSetup(context.db, context.chatId, context.username, RECOMMENDED_PRESET_ID);
  const alreadyFollowing = result.kind === "unchanged";
  let undoData: string | undefined;
  if (result.kind === "applied") {
    const prior = new Set(TELEGRAM_PRESET_ALERT_TYPES.filter((type) => result.prior?.[`alert_${type}`] === 1));
    undoData = `setup:undo:${encodeAlertTypes(prior)}:${(unixNow() + UNDO_TTL_SEC).toString(36)}-${result.generation.toString(36)}.${result.identity}`;
    await recordTelegramUsageEvent(context.db, {
      eventType: "setup_complete",
      sourceCategory: "recommended",
      actionDetail: "preset",
      outcome: "success",
    });
  }
  const count = resolved.presets[0]?.coins.length ?? 0;
  const isPrivate = context.chatType === "private";
  const settingsCmd = escapeHtml(cmdForChat("settings", context.chatType));
  const lines = alreadyFollowing
    ? [
        `<b>You already follow</b> the ${count} largest USD stablecoins for depeg and Early warning (DEWS) alerts.`,
        isPrivate
          ? `Open <b>${MANAGE_ALERTS_LABEL}</b> to add coins, set quiet hours or pause.`
          : `Change this group's alerts with ${settingsCmd}.`,
      ]
    : [
        `<b>Done.</b> You follow the ${count} largest USD stablecoins for depeg and Early warning (DEWS) alerts.`,
        "",
        "Here's what an alert looks like:",
        `<blockquote>${escapeHtml(TELEGRAM_PUBLIC_ALERT_SAMPLES.depeg.message)}</blockquote>`,
        isPrivate
          ? `<b>${MANAGE_ALERTS_LABEL}</b> (the button by the message box) is where you add coins, set quiet hours or pause.`
          : `Change this group's alerts with ${settingsCmd}.`,
        "Pharos news: @pharoswatch · Community: @pharoswatchers",
      ];
  const row: InlineKeyboardButton[] = isPrivate
    ? [manageAlertsButton()]
    : [{ text: "Group settings", callback_data: "settings:home" }];
  if (undoData) row.push({ text: "Undo", callback_data: undoData });
  await sendSetupReply(context, lines.join("\n"), { inline_keyboard: [row] });
  return { text: alreadyFollowing ? "Already following." : "Following." };
}

/**
 * `setup:undo:<mask>:<expiry>-<generation>.<identity>`: put the USD Top 25 follow back the way it was
 * before the one-tap setup. Mask 0 means there was no follow, so the row goes;
 * otherwise exactly the prior families are restored. Direct coin follows stay.
 */
export async function handleSetupUndo(
  context: SetupCallbackContext,
  maskCode: string | undefined,
  expiryCode: string | undefined,
): Promise<{ text: string }> {
  const prior = maskCode === "0" ? new Set<string>() : decodeAlertTypes(maskCode);
  if (!prior || [...prior].some((type) => !(TELEGRAM_PRESET_ALERT_TYPES as readonly string[]).includes(type))) {
    return { text: "Action not recognized." };
  }
  const [fence, identity, extraIdentity] = expiryCode?.split(".") ?? [];
  const [expiry, generationCode, extra] = fence?.split("-") ?? [];
  const generation = generationCode && /^[0-9a-z]{1,11}$/.test(generationCode) ? parseInt(generationCode, 36) : NaN;
  const expired = {
    text: context.chatType === "private"
      ? "This Undo expired. Change your alerts in Manage Alerts."
      : `This Undo expired. Use ${cmdForChat("settings", context.chatType)}.`,
  };
  if (!isUnexpired(expiry) || extra !== undefined || !Number.isSafeInteger(generation) || generation < 1
    || !identity || !/^[\w-]{22}$/.test(identity) || extraIdentity !== undefined) return expired;
  const outcome = await restorePresetSubscription(context.db, context.chatId, RECOMMENDED_PRESET_ID, prior, generation, identity);
  if (outcome === "stale") return expired;
  await recordTelegramUsageEvent(context.db, {
    eventType: "preset_unfollow",
    actionDetail: "setup_undo",
    outcome: "success",
  });
  if (context.messageId != null) {
    await editMessage(context.chatId, context.messageId, "Undone.", context.botToken, {
      disableWebPagePreview: true,
      replyMarkup: { inline_keyboard: [] },
    });
  }
  const startCmd = escapeHtml(cmdForChat("start", context.chatType));
  await sendSetupReply(
    context,
    prior.size === 0
      ? `Undone. You no longer follow the top 25 USD stablecoins. Send ${startCmd} to choose again.`
      : "Undone. Your USD Top 25 alerts are back to what they were.",
  );
  return { text: "Undone." };
}

/** `setup:sample`: the same framed sample `/sample` sends. */
export async function handleSetupSample(
  context: Pick<SetupCallbackContext, "db" | "botToken" | "chatId">,
): Promise<{ text: string }> {
  await sendSetupReply(
    context,
    buildSampleAlertMessage(),
    buildOnboardingKeyboard({ includeSample: false, includeManageAlerts: true }),
  );
  return { text: "Sample sent." };
}
