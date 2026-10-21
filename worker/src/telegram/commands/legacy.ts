import { TELEGRAM_COMMAND_NAMES } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../delivery/telegram";
import { resolveTicker, suggestClosestToken } from "../common/alerts-parser";
import { buildManageAlertsKeyboard } from "../webhook/telegram-webhook-messages";
import type { WebhookCommandContext, WebhookCommandHandler } from "./context";
import { handleList } from "./list";
import { handlePause } from "./pause";
import { handleStatus } from "./status";

/**
 * Retired and alias commands. Each retired command answers with one line plus
 * the Manage Alerts button (private chats), so old habits and old docs keep
 * landing somewhere useful. Aliases forward to the command that replaced them.
 * Mutating aliases must keep a mutating policy in the ingress policy table.
 */
const SETTINGS_MOVED = {
  private: "That setting moved to Manage Alerts.",
  group: "Use /settings to change this chat's alerts.",
};

const RETIRED_COMMAND_REPLIES: Readonly<Record<string, { private: string; group: string }>> = {
  "/set": SETTINGS_MOVED,
  "/mute": SETTINGS_MOVED,
  "/unmutehours": SETTINGS_MOVED,
  "/timezone": SETTINGS_MOVED,
  "/presets": {
    private: "Follow a preset with /subscribe usd-top25, or browse presets in Manage Alerts.",
    group: "Follow a preset with /subscribe usd-top25.",
  },
  "/top": {
    private: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
    group: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
  },
  "/brief": {
    private: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
    group: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
  },
  "/market": {
    private: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
    group: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
  },
  "/recap": {
    private: "Daily recaps were retired. Your alerts are unchanged.",
    group: "Daily recaps were retired. Your alerts are unchanged.",
  },
  "/cancel": { private: "Nothing to cancel.", group: "Nothing to cancel." },
  "/export": {
    private: "Watchlist export and import were retired. Add coins in Manage Alerts.",
    group: "Watchlist export and import were retired.",
  },
  "/import": {
    private: "Watchlist export and import were retired. Add coins in Manage Alerts.",
    group: "Watchlist export and import were retired.",
  },
  "/add": {
    private: "Use /subscribe followed by tickers, e.g. /subscribe USDC.",
    group: "Use /subscribe followed by tickers, e.g. /subscribe USDC.",
  },
};

async function replyWithManageAlerts(ctx: WebhookCommandContext, message: string): Promise<void> {
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(escapeHtml(message), { replyMarkup: buildManageAlertsKeyboard() });
    return;
  }
  await ctx.replyToChat(escapeHtml(message));
}

function retiredCommandHandler(command: string): WebhookCommandHandler {
  const reply = RETIRED_COMMAND_REPLIES[command]!;
  return (ctx) => replyWithManageAlerts(ctx, ctx.chatType === "private" ? reply.private : reply.group);
}

export const LEGACY_COMMAND_HANDLERS: Readonly<Record<string, WebhookCommandHandler>> = {
  ...Object.fromEntries(Object.keys(RETIRED_COMMAND_REPLIES).map((command) => [command, retiredCommandHandler(command)])),
  "/unsnooze": (ctx) => handlePause(ctx, "off"),
  "/health": handleList,
  "/subscriptions": handleList,
  "/why": handleStatus,
  "/coverage": handleStatus,
};

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
