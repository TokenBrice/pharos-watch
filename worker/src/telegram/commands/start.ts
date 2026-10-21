import {
  classifyTelegramStartSource,
  recordTelegramUsageEvent,
} from "../store/usage-analytics";
import { parseStartPayload } from "../webhook/telegram-webhook-parsing";
import { sendOnboarding } from "../webhook/telegram-webhook-setup";
import { isGroupAdminActor, isGroupChatType } from "../webhook/telegram-webhook-auth";
import { buildManageAlertsKeyboard } from "../webhook/telegram-webhook-messages";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import type { WebhookCommandHandler } from "./context";
import { handleSubscribe } from "./subscribe";
import { handleSample } from "./sample";
import { handleStatus } from "./status";

const APP_PRIVATE_MESSAGE = "Add coins, set quiet hours or pause in Manage Alerts.";
const APP_GROUP_MESSAGE = "Message the bot privately to manage your own alerts.";
const BOT_DM_DEEP_LINK = `${TELEGRAM_BOT_URL}?start=app`;

export const handleStart: WebhookCommandHandler = async (ctx, args) => {
  const sourceCategory = classifyTelegramStartSource(args);
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "start",
    sourceCategory,
    actionDetail: sourceCategory,
    outcome: "received",
  });
  if (sourceCategory !== "none") {
    await recordTelegramUsageEvent(ctx.db, {
      eventType: "deep_link",
      sourceCategory,
      actionDetail: "/start",
      outcome: "received",
    });
  }

  const payload = parseStartPayload(args);
  switch (payload.kind) {
    case "subscribe":
      if (ctx.chatType !== "private") break;
      await handleSubscribe(ctx, payload.args);
      return;
    case "status":
    case "why":
    case "coverage":
      // Old why_/coverage_ links fold into the status card.
      await handleStatus(ctx, payload.coinId);
      return;
    case "app":
      // Groups cannot open the Mini App, so they get a link into the bot's DM.
      if (ctx.chatType === "private") {
        await ctx.replyToChatWithMarkup(APP_PRIVATE_MESSAGE, { replyMarkup: buildManageAlertsKeyboard("home") });
      } else {
        await ctx.replyToChatWithMarkup(APP_GROUP_MESSAGE, {
          replyMarkup: { inline_keyboard: [[{ text: "Open in DM", url: BOT_DM_DEEP_LINK }]] },
        });
      }
      return;
    case "sample":
      await handleSample(ctx, "");
      return;
    default:
      // Empty payload, `setup`, and landing-page tokens all open onboarding.
      break;
  }
  await sendOnboarding({
    db: ctx.db,
    botToken: ctx.botToken,
    chatId: ctx.chatId,
    chatType: ctx.chatType,
    isGroupAdmin: isGroupChatType(ctx.chatType)
      && await isGroupAdminActor(ctx.botToken, ctx.chatId, ctx.actorUserId),
    operationNowSec: ctx.operationNowSec,
  });
};
