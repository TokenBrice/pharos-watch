import { listTelegramPresets } from "../../lib/telegram-presets";
import { buildPresetCatalogMessage } from "../telegram-webhook-messages";
import type { WebhookCommandHandler } from "./context";

export const handlePresets: WebhookCommandHandler = async (ctx) => {
  await ctx.replyToChat(buildPresetCatalogMessage(listTelegramPresets()));
};
