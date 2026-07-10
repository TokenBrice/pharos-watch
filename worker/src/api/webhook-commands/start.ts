import {
  classifyTelegramStartSource,
  recordTelegramUsageEvent,
} from "../../lib/telegram-usage-analytics";
import { buildTelegramMiniAppUrl } from "../../lib/telegram-webhook-registration";
import { parseStartPayload } from "../telegram-webhook-parsing";
import { sendWizardIntro } from "../telegram-webhook-setup";
import { START_MESSAGE } from "../telegram-webhook-shared";
import { isGroupAdminActor, isGroupChatType } from "../telegram-webhook-auth";
import { MINI_APP_PAYLOAD_NAMES } from "@shared/lib/telegram-mini-app-payloads";
import type { WebhookCommandHandler } from "./context";
import {
  recordTelegramAdoptionEvent,
  telegramAdoptionDimensionsForStart,
} from "../../lib/telegram-adoption-analytics";
import { handleSubscribe } from "./subscribe";
import { handleSample } from "./sample";
import { handleStatus } from "./status";
import { handleWhy } from "./why";
import { handleCoverage } from "./coverage";

const APP_PRIVATE_MESSAGE = "Open the Pharos Mini App to manage your alerts.";
const APP_GROUP_MESSAGE = "DM the bot to open the Pharos Mini App for your personal alerts.";
const BOT_DM_DEEP_LINK = "https://t.me/PharosWatchBot?start=app";

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

  const adoption = telegramAdoptionDimensionsForStart(args.trim().split(/\s+/, 1)[0] ?? "");
  await recordTelegramAdoptionEvent(ctx.db, {
    ...adoption,
    nowSec: ctx.operationNowSec ?? Math.floor(Date.now() / 1_000),
    stage: "bot_start",
  });

  const payload = parseStartPayload(args);
  switch (payload.kind) {
    case "subscribe":
      if (ctx.chatType !== "private") {
        await ctx.replyToChat(START_MESSAGE);
        return;
      }
      await handleSubscribe(ctx, payload.args);
      return;
    case "status":
      await handleStatus(ctx, payload.coinId);
      return;
    case "why":
      await handleWhy(ctx, payload.coinId);
      return;
    case "coverage":
      await handleCoverage(ctx, payload.coinId);
      return;
    case "app": {
      // `?start=app` / `?start=home` deep-link: nudge the user into the Mini
      // App home view. Private chats get a Web App button; groups (Telegram
      // rejects `web_app` outside private) get a URL button into the bot's DM.
      if (ctx.chatType === "private") {
        await ctx.replyToChatWithMarkup(APP_PRIVATE_MESSAGE, {
          replyMarkup: {
            inline_keyboard: [[
              {
                text: "Open control panel",
                web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.home) },
              },
            ]],
          },
        });
        return;
      }
      await ctx.replyToChatWithMarkup(APP_GROUP_MESSAGE, {
        replyMarkup: {
          inline_keyboard: [[{ text: "Open in DM", url: BOT_DM_DEEP_LINK }]],
        },
      });
      return;
    }
    case "sample":
      // `?start=sample` aliases `/sample`. `handleSample` enforces the
      // private-chat-only guard itself, so groups get the read-only reply.
      await handleSample(ctx, "");
      return;
    case "setup":
    case "adoption":
    case "none":
      if (
        isGroupChatType(ctx.chatType) &&
        !(await isGroupAdminActor(ctx.botToken, ctx.chatId, ctx.actorUserId))
      ) {
        await ctx.replyToChat(START_MESSAGE);
        return;
      }
      // Empty payload or `?start=setup` both open the wizard in private chats
      // and for group admins. Non-admin group members get the read-only start
      // message above.
      await sendWizardIntro(ctx.db, ctx.botToken, ctx.chatId, ctx.actorUserId, {
        adoptionToken: payload.kind === "adoption" ? payload.token : null,
        includeMiniAppButton: ctx.chatType === "private",
        beforeIrreversibleEffect: ctx.beforeIrreversibleEffect,
        planIntent: ctx.planIntent,
        prepareMutationAppliedStatement: ctx.prepareMutationAppliedStatement,
        confirmAtomicMutationApplied: ctx.confirmAtomicMutationApplied,
        wasMutationApplied: ctx.wasMutationApplied,
      });
      return;
  }
};
