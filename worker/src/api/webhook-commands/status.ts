import { resolveTicker } from "../../lib/telegram-alerts";
import {
  buildNotFoundMessage,
  buildStatusAmbiguousMessage,
  buildStatusDiscoveryKeyboard,
  buildStatusMessage,
} from "../telegram-webhook-messages";
import { loadStatusForCoin } from "../telegram-webhook-status";
import type { WebhookCommandHandler } from "./context";

export const handleStatus: WebhookCommandHandler = async (ctx, args) => {
  const trimmed = args.trim();
  if (!trimmed) {
    await ctx.replyToChat("Usage: /status &lt;ticker&gt;");
    return;
  }
  const resolution = resolveTicker(trimmed, "tracked");
  if (resolution.status === "not_found") {
    await ctx.replyToChat(buildNotFoundMessage(trimmed, resolution.suggestion));
    return;
  }
  if (resolution.status === "ambiguous") {
    await ctx.replyToChat(buildStatusAmbiguousMessage(trimmed, resolution.matches));
    return;
  }
  const coin = resolution.matches[0];
  const status = await loadStatusForCoin(ctx.db, coin.id);
  await ctx.replyToChatWithMarkup(buildStatusMessage(coin.symbol, status), {
    replyMarkup: buildStatusDiscoveryKeyboard(coin.id, { includeMiniAppButton: ctx.chatType === "private" }),
  });
};
