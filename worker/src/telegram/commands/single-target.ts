import { escapeHtml } from "../delivery/telegram";
import { resolveTicker, type ResolvedCoin } from "../common/alerts-parser";
import { buildNotFoundMessage } from "../webhook/telegram-webhook-messages";
import { buildPickKeyboard } from "../callbacks/pick";
import type { WebhookCommandContext } from "./context";

/**
 * Resolves a single coin from a ticker argument. Not-found replies with a
 * suggestion; an ambiguous ticker replies with one button per candidate.
 * Returns `null` when no single coin can be selected.
 */
export async function resolveSingleStatusTarget(
  ctx: WebhookCommandContext,
  args: string,
): Promise<ResolvedCoin | null> {
  const trimmed = args.trim();
  const resolution = resolveTicker(trimmed, "tracked");
  if (resolution.status === "not_found") {
    await ctx.replyToChat(buildNotFoundMessage(trimmed, resolution.suggestion));
    return null;
  }
  if (resolution.status === "ambiguous") {
    const keyboard = buildPickKeyboard({ kind: "status" }, trimmed, resolution.matches);
    if (keyboard) {
      await ctx.replyToChatWithMarkup(`"${escapeHtml(trimmed)}" matches ${resolution.matches.length} coins. Which one?`, { replyMarkup: keyboard });
      return null;
    }
    await ctx.replyToChat(`"${escapeHtml(trimmed)}" matches ${resolution.matches.length} coins. Send the exact Pharos coin id instead.`);
    return null;
  }
  return resolution.matches[0] ?? null;
}
