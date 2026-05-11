import type { WebhookCommandHandler } from "./context";

export const handleCancel: WebhookCommandHandler = async (ctx) => {
  await ctx.replyToChat("No pending selection to cancel.");
};
