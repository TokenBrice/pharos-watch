import { formatCoveragePayload } from "@shared/lib/telegram-mini-app-payloads";
import { buildCoverageMessage } from "../telegram-webhook-insights";
import { buildStatusDiscoveryKeyboard } from "../telegram-webhook-messages";
import { loadStatusForCoin } from "../telegram-webhook-status";
import type { WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

export const handleCoverage: WebhookCommandHandler = async (ctx, args) => {
  const coin = await resolveSingleStatusTarget(ctx, args, "/coverage");
  if (!coin) return;
  const status = await loadStatusForCoin(ctx.db, coin.id);
  const message = buildCoverageMessage(coin.symbol, status);
  const includeMiniAppButton = ctx.chatType === "private";
  await ctx.replyToChatWithMarkup(message, {
    replyMarkup: buildStatusDiscoveryKeyboard(coin.id, {
      includeMiniAppButton,
      miniAppPayload: includeMiniAppButton ? formatCoveragePayload(coin.id) : undefined,
    }),
  });
};
