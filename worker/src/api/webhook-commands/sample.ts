import {
  formatConsolidatedMessage,
  type ConsolidatedAlerts,
} from "../../lib/telegram/alerts";
import { isGroupChatType } from "../telegram-webhook-auth";
import type { WebhookCommandHandler } from "./context";

/**
 * Synthetic single-coin DEWS band transition used by `/sample`. The fixture
 * coin (USDC) and band transition (WATCH → ALERT) are intentionally hard-coded
 * — this command exists to let new users preview the alert UX before
 * subscribing; it must not query live data.
 */
const SAMPLE_FOOTER =
  "\n\nThis was a sample alert — your real alerts will appear here. Use /unsubscribe to disable.";
export const SAMPLE_COIN_ID = "usdc-circle";

function buildSampleAlerts(): ConsolidatedAlerts {
  return {
    dews: [
      {
        stablecoinId: SAMPLE_COIN_ID,
        symbol: "USDC",
        oldBand: "WATCH",
        newBand: "ALERT",
        score: 42,
        topSignals: [
          { name: "depeg", value: 35 },
          { name: "liquidity", value: 28 },
        ],
        contextLine: "Sample context — your real alerts include live safety, liquidity, and supply signals.",
      },
    ],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
    reserve: [],
  };
}

export const handleSample: WebhookCommandHandler = async (ctx) => {
  if (isGroupChatType(ctx.chatType) || ctx.chatType === "channel") {
    await ctx.replyToChat("Only available in private chats.");
    return;
  }

  const alerts = buildSampleAlerts();
  const message = `${formatConsolidatedMessage(alerts)}${SAMPLE_FOOTER}`;
  await ctx.replyToChat(message);
};
