import { buildBriefMessage } from "../telegram-webhook-insights";
import type { WebhookCommandHandler } from "./context";

export const handleBrief: WebhookCommandHandler = async (ctx) => {
  await ctx.replyToChat(await buildBriefMessage(ctx.db));
};
