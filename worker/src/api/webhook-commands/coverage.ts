import { buildCoverageMessage } from "../telegram-webhook-insights";
import { loadStatusForCoin } from "../telegram-webhook-status";
import type { WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

export const handleCoverage: WebhookCommandHandler = async (ctx, args) => {
  const coin = await resolveSingleStatusTarget(ctx, args, "/coverage");
  if (!coin) return;
  const status = await loadStatusForCoin(ctx.db, coin.id);
  await ctx.replyToChat(buildCoverageMessage(coin.symbol, status));
};
