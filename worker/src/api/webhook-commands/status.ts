import {
  buildStatusDiscoveryKeyboard,
  buildStatusMessage,
} from "../telegram-webhook-messages";
import { loadStatusForCoin } from "../telegram-webhook-status";
import type { WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

export const handleStatus: WebhookCommandHandler = async (ctx, args) => {
  const coin = await resolveSingleStatusTarget(ctx, args, "/status");
  if (!coin) return;
  const status = await loadStatusForCoin(ctx.db, coin.id);
  await ctx.replyToChatWithMarkup(buildStatusMessage(coin.symbol, status), {
    replyMarkup: buildStatusDiscoveryKeyboard(coin.id, { includeMiniAppButton: ctx.chatType === "private" }),
  });
};
