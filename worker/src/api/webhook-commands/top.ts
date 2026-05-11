import { buildTopMessage } from "../telegram-webhook-insights";
import type { WebhookCommandHandler } from "./context";

export const handleTop: WebhookCommandHandler = async (ctx, args) => {
  const view = args.trim();
  if (!view) {
    await ctx.replyToChat("Usage: /top depeg|dews|yield|liquidity|chains|safety");
    return;
  }
  await ctx.replyToChat(await buildTopMessage(ctx.db, view));
};
