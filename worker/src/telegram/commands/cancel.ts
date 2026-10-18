import type { WebhookCommandHandler } from "./context";

export const handleCancel: WebhookCommandHandler = async (ctx) => {
  await ctx.replyToChat("No pending selection to cancel. Send /start to set up alerts or /list to review current subscriptions.");
};
