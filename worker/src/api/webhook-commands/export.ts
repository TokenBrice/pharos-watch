import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import { escapeHtml } from "../../lib/telegram";
import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../../lib/telegram/constants";
import { recordTelegramUsageEvent } from "../../lib/telegram/usage-analytics";
import { isSubscribableCoin } from "../../lib/telegram/subscription-eligibility";
import {
  encodeWatchlistTokenV3,
  MAX_WATCHLIST_TOKEN_CHARS,
  WATCHLIST_TOKEN_REGISTRY_VERSION,
} from "../../lib/telegram/watchlist-token";
import { loadWatchlistPortableState } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

const KNOWN_PRESET_IDS = new Set<string>(TELEGRAM_PRESET_IDS);

/** `/export` emits one lossless, self-contained pw3 portable-state token. */
export const handleExport: WebhookCommandHandler = async (ctx) => {
  const { db, chatId } = ctx;
  const { state } = await loadWatchlistPortableState(db, chatId, WATCHLIST_TOKEN_REGISTRY_VERSION);
  if (state.direct.length === 0 && state.presets.length === 0) {
    await ctx.replyToChat(
      "Nothing to export yet. Use /subscribe (or /presets) first, then /export to copy your watchlist to another chat.",
    );
    return;
  }

  const unavailableIds = state.direct
    .map((row) => row.stablecoinId)
    .filter((id) => !isSubscribableCoin(id));
  const unknownPresets = state.presets
    .map((row) => row.presetId)
    .filter((id) => !KNOWN_PRESET_IDS.has(id));
  if (unavailableIds.length > 0 || unknownPresets.length > 0) {
    await ctx.replyToChat(
      [
        "This watchlist contains retired or unknown entries, so a lossless token cannot be created yet.",
        "Remove those entries with /unsubscribe or the control panel, then run /export again. Nothing was changed.",
      ].join("\n"),
    );
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "export-v2",
      outcome: "blocked",
      failureClass: "unavailable-portable-state",
    });
    return;
  }

  let token: string;
  try {
    token = await encodeWatchlistTokenV3(state);
  } catch {
    await ctx.replyToChat(
      [
        `Your watchlist is too large for one safe Telegram copy/paste token (${state.direct.length} direct/local rows, ${state.presets.length} presets), so no token was sent.`,
        "Nothing was changed. Please report this to the Pharos team so the portable format can be expanded safely.",
      ].join("\n"),
    );
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "export-v2",
      outcome: "blocked",
      failureClass: "token-too-large",
    });
    return;
  }

  const tokenBlock = `<pre>${escapeHtml(token)}</pre>`;
  if (token.length > MAX_WATCHLIST_TOKEN_CHARS || tokenBlock.length > TELEGRAM_MESSAGE_CHUNK_LIMIT) {
    throw new Error("Encoded watchlist token escaped its copy/paste size contract");
  }
  await ctx.replyToChat([
    `Your lossless watchlist token (${state.direct.length} direct/local rows, ${state.presets.length} presets):`,
    tokenBlock,
    "Send it as <code>/import &lt;token&gt;</code>. Import shows an exact replacement preview before changing anything.",
    "Not included: global-all settings, quiet hours, timezone, chat/per-coin snoozes, pending actions, or delivery history.",
  ].join("\n"));
  await recordTelegramUsageEvent(db, { eventType: "subscribe", actionDetail: "export-v2", outcome: "success" });
};
