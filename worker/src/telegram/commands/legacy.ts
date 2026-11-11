import { TELEGRAM_COMMAND_NAMES } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../delivery/telegram";
import { resolveTicker, suggestClosestToken } from "../common/alerts-parser";
import { buildManageAlertsKeyboard } from "../webhook/telegram-webhook-messages";
import type { WebhookCommandContext, WebhookCommandHandler } from "./context";
import { RETIRED_COMMAND_REPLIES, TELEGRAM_COMMAND_ALIASES, type TelegramCanonicalCommand } from "./definitions";
import { handleStatus } from "./status";

/**
 * Retired and alias commands. Each retired command answers with one line plus
 * the Manage Alerts button (private chats), so old habits and old docs keep
 * landing somewhere useful. Aliases forward to the command that replaced them.
 * Mutating aliases must keep a mutating policy in the ingress policy table.
 */

async function replyWithManageAlerts(ctx: WebhookCommandContext, message: string): Promise<void> {
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(escapeHtml(message), { replyMarkup: buildManageAlertsKeyboard() });
    return;
  }
  await ctx.replyToChat(escapeHtml(message));
}

function retiredCommandHandler(command: keyof typeof RETIRED_COMMAND_REPLIES): WebhookCommandHandler {
  const reply = RETIRED_COMMAND_REPLIES[command]!;
  return (ctx) => replyWithManageAlerts(ctx, ctx.chatType === "private" ? reply.private : reply.group);
}

export function buildLegacyCommandHandlers(
  canonicalHandlers: Record<TelegramCanonicalCommand, WebhookCommandHandler>,
): Readonly<Record<string, WebhookCommandHandler>> {
  return {
    ...Object.fromEntries((Object.keys(RETIRED_COMMAND_REPLIES) as Array<keyof typeof RETIRED_COMMAND_REPLIES>)
      .map((command) => [command, retiredCommandHandler(command)])),
    ...Object.fromEntries(Object.entries(TELEGRAM_COMMAND_ALIASES).map(([alias, binding]) => {
      const handler = canonicalHandlers[binding.target];
      return [alias, "args" in binding ? (ctx: WebhookCommandContext) => handler(ctx, binding.args) : handler];
    })),
  };
}

const SUGGESTABLE_COMMANDS = [
  ...TELEGRAM_COMMAND_NAMES,
  ...Object.keys(RETIRED_COMMAND_REPLIES).map((command) => command.slice(1)),
  "subscriptions",
];
const TICKER_COMMAND_PATTERN = /^\/[A-Za-z0-9.$]{2,15}$/;

/**
 * Reply for a command no handler owns. A near-miss gets a suggestion; a
 * command token that names exactly one coin (`/usdc`) shows that coin.
 */
export async function replyToUnknownCommand(ctx: WebhookCommandContext, command: string): Promise<void> {
  const token = command.replace(/^\//, "");
  const suggestion = suggestClosestToken(token, SUGGESTABLE_COMMANDS)
    ?? (token.length >= 6 ? suggestTwoEdits(token) : null);
  if (suggestion) {
    await replyWithHelp(ctx, `I don't know ${command}. Did you mean /${suggestion}?`);
    return;
  }
  if (TICKER_COMMAND_PATTERN.test(command)) {
    const match = resolveTicker(token, "tracked");
    if (match.status === "unique") {
      await ctx.replyToChat(escapeHtml(`Showing ${match.matches[0]!.symbol}. Next time: /status ${match.matches[0]!.symbol}`));
      await handleStatus(ctx, match.matches[0]!.id);
      return;
    }
  }
  await replyWithHelp(ctx, `I don't know ${command}.`);
}

function suggestTwoEdits(token: string): string | null {
  // Longer typos (/subsriptions) are often two edits away; allow that only
  // when exactly one command is that close.
  const matches = SUGGESTABLE_COMMANDS.filter((candidate) => editDistance(token.toLowerCase(), candidate) <= 2);
  return matches.length === 1 ? matches[0]! : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

async function replyWithHelp(ctx: WebhookCommandContext, message: string): Promise<void> {
  const helpRow = [{ text: "Help", callback_data: "help:commands" }];
  const keyboard = ctx.chatType === "private"
    ? { inline_keyboard: [[...helpRow, ...buildManageAlertsKeyboard().inline_keyboard[0]!]] }
    : { inline_keyboard: [helpRow] };
  await ctx.replyToChatWithMarkup(escapeHtml(message), { replyMarkup: keyboard });
}
