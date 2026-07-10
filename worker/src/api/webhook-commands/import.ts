import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { decodeWatchlistToken } from "../../lib/telegram-watchlist-token";
import { escapeHtml } from "../../lib/telegram";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isSubscribableCoin } from "../../lib/telegram-subscription-eligibility";
import { PENDING_OWNERSHIP_CONFLICT_MESSAGE, persistPendingConfirmBulk } from "../telegram-webhook-store";
import type { ConfirmBulkPayload } from "../telegram-webhook-shared";
import {
  BULK_CONFIRM_REPLY_MARKUP,
  buildBulkConfirmMessage,
  dedupePresetIds,
  subscribableCoinCount,
} from "./action-runner";
import { TELEGRAM_PRESET_LABEL_BY_ID } from "../../lib/telegram-presets";
import type { WebhookCommandHandler } from "./context";

const VALID_IMPORT_ALERT_TYPES = new Set(["dews", "depeg", "safety", "launch", "reserve"]);

function buildImportConfirmMessage(
  coinCount: number,
  alertTypes: readonly string[],
  symbols: readonly string[],
  presetLabels: readonly string[],
): string {
  if (presetLabels.length === 0) {
    return buildBulkConfirmMessage("subscribe", coinCount, alertTypes, symbols);
  }

  const targetParts: string[] = [];
  if (coinCount > 0) targetParts.push(`${coinCount} ${coinCount === 1 ? "coin" : "coins"}`);
  targetParts.push(`${presetLabels.length} ${presetLabels.length === 1 ? "preset" : "presets"}`);

  const previewParts = [
    symbols.length > 0 ? symbols.join(", ") : "",
    `Presets: ${presetLabels.join(", ")}`,
  ].filter(Boolean);
  const previewLine = previewParts.length > 0 ? `\n${escapeHtml(previewParts.join("\n"))}` : "";
  const types = alertTypes.length > 0 ? alertTypes.join(", ") : "all";
  return `This will subscribe ${targetParts.join(" and ")} for alert types ${escapeHtml(types)}. Confirm?${previewLine}`;
}

/**
 * `/import <token>` — decode a watchlist token, validate ids against the live
 * registry, and stage a bulk subscribe through the existing confirm-bulk flow
 * (single pending slot + initiator lock). Group-admin-gated like /subscribe.
 * Applies no writes until the user taps Confirm.
 */
export const handleImport: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId } = ctx;
  const decoded = decodeWatchlistToken(args ?? "");
  if (!decoded.ok) {
    const message =
      decoded.error === "empty"
        ? "Usage: /import <token> — paste a token from /export in another chat."
        : decoded.error === "too-large"
          ? "That token is too large to import."
          : decoded.error === "unsupported-version"
            ? "That token is from a newer version of the bot and can't be imported. Re-run /export to get a current token."
            : "That token is malformed and could not be read. Copy the full token from /export and try again.";
    await ctx.replyToChat(message);
    await recordTelegramUsageEvent(db, { eventType: "subscribe", actionDetail: "import", outcome: "invalid" });
    return;
  }

  const seen = new Set<string>();
  const validIds: string[] = [];
  let droppedUnavailable = 0;
  for (const id of decoded.state.coinIds) {
    if (!isSubscribableCoin(id)) {
      droppedUnavailable += 1;
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      validIds.push(id);
    }
  }
  const cappedIds = validIds.slice(0, subscribableCoinCount());
  const presetIds = dedupePresetIds(decoded.state.presetIds);

  if (cappedIds.length === 0 && presetIds.length === 0) {
    await ctx.replyToChat("No coins available for new alerts or known presets were found in that token.");
    await recordTelegramUsageEvent(db, { eventType: "subscribe", actionDetail: "import", outcome: "invalid" });
    return;
  }

  const filteredTypes = decoded.state.alertTypes.filter((type) => VALID_IMPORT_ALERT_TYPES.has(type));
  // A valid /export always carries ≥1 alert type; default a degenerate token to the
  // recommended set so import never writes all-zero (dead) subscription rows.
  const alertTypes = filteredTypes.length > 0 ? filteredTypes : ["dews", "depeg"];

  const payload: ConfirmBulkPayload = {
    kind: "subscribe",
    alertTypes,
    presetIds,
    depegWorseningBpsStep: null,
    coinIds: cappedIds,
    subscribeAll: false,
  };

  const persisted = await persistPendingConfirmBulk(db, {
    chatId,
    payload,
    initiatorUserId: ctx.actorUserId,
  });
  if (!persisted) {
    await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
    return;
  }

  const symbols = cappedIds.map((id) => TRACKED_META_BY_ID.get(id)?.symbol ?? id);
  const presetLabels = presetIds.map((presetId) => TELEGRAM_PRESET_LABEL_BY_ID.get(presetId) ?? presetId);
  const droppedNote = droppedUnavailable > 0
    ? `\n(${droppedUnavailable} ${droppedUnavailable === 1 ? "coin is" : "coins are"} not available for new alerts and ${droppedUnavailable === 1 ? "was" : "were"} skipped.)`
    : "";
  await ctx.replyToChatWithMarkup(
    buildImportConfirmMessage(cappedIds.length, alertTypes, symbols, presetLabels) + droppedNote,
    { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
  );
  await recordTelegramUsageEvent(db, { eventType: "subscribe", actionDetail: "import", outcome: "preview" });
};
