import { resolveTicker, type ResolvedCoin } from "../../lib/telegram/alerts";
import {
  buildNotFoundMessage,
  buildStatusAmbiguousMessage,
} from "../telegram-webhook-messages";
import type { WebhookCommandContext } from "./context";

/**
 * Resolves a single coin from a ticker argument. Sends the appropriate error
 * message (usage / not-found / ambiguous) and returns `null` when no single
 * coin can be selected.
 */
export async function resolveSingleStatusTarget(
  ctx: WebhookCommandContext,
  args: string,
  commandName: string,
): Promise<ResolvedCoin | null> {
  const trimmed = args.trim();
  if (!trimmed) {
    await ctx.replyToChat(`Usage: ${commandName} &lt;ticker&gt;`);
    return null;
  }
  const resolution = resolveTicker(trimmed, "tracked");
  if (resolution.status === "not_found") {
    await ctx.replyToChat(buildNotFoundMessage(trimmed, resolution.suggestion));
    return null;
  }
  if (resolution.status === "ambiguous") {
    await ctx.replyToChat(buildStatusAmbiguousMessage(trimmed, resolution.matches, commandName));
    return null;
  }
  return resolution.matches[0] ?? null;
}
