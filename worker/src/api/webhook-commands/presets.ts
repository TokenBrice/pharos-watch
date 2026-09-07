import { listTelegramPresets } from "../../lib/telegram/presets";
import { buildMiniAppOnlyKeyboard, buildPresetCatalogMessage } from "../telegram-webhook-messages";
import type { WebhookCommandHandler } from "./context";

export const handlePresets: WebhookCommandHandler = async (ctx) => {
  const message = buildPresetCatalogMessage(listTelegramPresets());
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(message, {
      replyMarkup: buildMiniAppOnlyKeyboard("Browse presets", "presets"),
    });
    return;
  }
  await ctx.replyToChat(message);
};
