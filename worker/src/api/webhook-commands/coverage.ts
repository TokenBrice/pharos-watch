import { formatCoveragePayload } from "@shared/lib/telegram-mini-app-payloads";
import { buildCoverageMessage } from "../telegram-webhook-insights";
import { buildStatusDiscoveryKeyboard } from "../telegram-webhook-messages";
import { loadStatusForCoin } from "../telegram-webhook-status";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";
import { resolveSingleStatusTarget } from "./single-target";

export const handleCoverage: WebhookCommandHandler = async (ctx, args) => {
  const coin = await resolveSingleStatusTarget(ctx, args, "/coverage");
  if (!coin) return;
  const status = await loadStatusForCoin(ctx.db, coin.id);
  const message = buildCoverageMessage(coin.symbol, status);
  await replyWithOptionalMiniApp(
    ctx,
    message,
    buildStatusDiscoveryKeyboard(coin.id, {
      includeMiniAppButton: true,
      miniAppPayload: formatCoveragePayload(coin.id),
    }),
  );
};
