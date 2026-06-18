import { formatWhyPayload } from "@shared/lib/telegram-mini-app-payloads";
import { buildWhyMessage } from "../telegram-webhook-insights";
import { buildStatusDiscoveryKeyboard } from "../telegram-webhook-messages";
import type { WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

export const handleWhy: WebhookCommandHandler = async (ctx, args) => {
  const coin = await resolveSingleStatusTarget(ctx, args, "/why");
  if (!coin) return;
  const message = await buildWhyMessage(ctx.db, coin.id);
  const includeMiniAppButton = ctx.chatType === "private";
  await ctx.replyToChatWithMarkup(message, {
    replyMarkup: buildStatusDiscoveryKeyboard(coin.id, {
      includeMiniAppButton,
      miniAppPayload: includeMiniAppButton ? formatWhyPayload(coin.id) : undefined,
    }),
  });
};
