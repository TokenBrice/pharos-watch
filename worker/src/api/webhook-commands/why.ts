import { buildWhyMessage } from "../telegram-webhook-insights";
import type { WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

export const handleWhy: WebhookCommandHandler = async (ctx, args) => {
  const coin = await resolveSingleStatusTarget(ctx, args, "/why");
  if (!coin) return;
  await ctx.replyToChat(await buildWhyMessage(ctx.db, coin.id));
};
