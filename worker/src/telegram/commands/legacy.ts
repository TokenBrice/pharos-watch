import { TELEGRAM_COMMAND_NAMES } from "@shared/lib/telegram-bot-registration";
import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { escapeHtml } from "../delivery/telegram";
import { resolveTicker, suggestClosestToken } from "../common/alerts-parser";
import {
  buildManageAlertsKeyboard,
  buildMiniAppOnlyKeyboard,
  cmdForChat,
  fitsCallbackData,
} from "../webhook/telegram-webhook-messages";
import type { WebhookCommandContext, WebhookCommandHandler } from "./context";
import { RETIRED_COMMAND_REPLIES, TELEGRAM_COMMAND_ALIASES, type TelegramCanonicalCommand } from "./definitions";
import { handleStatus } from "./status";

/**
 * Retired and alias commands. Each retired command answers with contextual
 * navigation buttons (Mini App deep links in private DMs, inline group settings
 * or public URL links in groups), so old habits and old docs keep landing
 * somewhere useful. Aliases forward to the command that replaced them.
 * Mutating aliases must keep a mutating policy in the ingress policy table.
 */

type RetiredCommandName = keyof typeof RETIRED_COMMAND_REPLIES;

const CHANNEL_LINK_MARKUP = {
  inline_keyboard: [[
    { text: "pharos.watch", url: SITE_ORIGIN },
    { text: "@pharoswatch", url: "https://t.me/pharoswatch" },
  ]],
};

const GROUP_SETTINGS_MARKUP = {
  inline_keyboard: [[{ text: "Group settings", callback_data: "settings:home" }]],
};

function retiredCommandMarkup(
  command: RetiredCommandName,
  chatType: string,
  args: string,
): unknown | undefined {
  const isPrivate = chatType === "private";
  switch (command) {
    case "/cancel":
      return undefined;
    case "/top":
    case "/brief":
    case "/market":
      return CHANNEL_LINK_MARKUP;
    case "/timezone":
    case "/mute":
    case "/unmutehours":
      return isPrivate ? buildMiniAppOnlyKeyboard("Alert settings", "settings") : GROUP_SETTINGS_MARKUP;
    case "/set": {
      const firstToken = args.trim().split(/\s+/)[0] ?? "";
      const match = firstToken ? resolveTicker(firstToken, "subscribable") : null;
      if (match?.status === "unique") {
        const coin = match.matches[0]!;
        if (isPrivate) {
          return buildMiniAppOnlyKeyboard(`Manage ${coin.symbol}`, formatCoinPayload(coin.id));
        }
        const openData = `settings:o:${coin.id}`;
        return fitsCallbackData(openData)
          ? { inline_keyboard: [[{ text: `${coin.symbol} settings`, callback_data: openData }]] }
          : GROUP_SETTINGS_MARKUP;
      }
      return isPrivate ? buildManageAlertsKeyboard("home") : GROUP_SETTINGS_MARKUP;
    }
    case "/presets":
      return isPrivate ? buildMiniAppOnlyKeyboard("Browse presets", "presets") : undefined;
    case "/export":
    case "/import":
    case "/add":
      return isPrivate ? buildMiniAppOnlyKeyboard("Add coins", "setup") : undefined;
    case "/recap":
      return isPrivate ? buildManageAlertsKeyboard("home") : undefined;
  }
}

function retiredCommandHandler(command: RetiredCommandName): WebhookCommandHandler {
  const reply = RETIRED_COMMAND_REPLIES[command]!;
  return async (ctx, args) => {
    const message = ctx.chatType === "private" ? reply.private : reply.group;
    const replyMarkup = retiredCommandMarkup(command, ctx.chatType, args);
    if (replyMarkup) {
      await ctx.replyToChatWithMarkup(escapeHtml(message), { replyMarkup });
      return;
    }
    await ctx.replyToChat(escapeHtml(message));
  };
}

export function buildLegacyCommandHandlers(
  canonicalHandlers: Record<TelegramCanonicalCommand, WebhookCommandHandler>,
): Readonly<Record<string, WebhookCommandHandler>> {
  return {
    ...Object.fromEntries((Object.keys(RETIRED_COMMAND_REPLIES) as RetiredCommandName[])
      .map((command) => [command, retiredCommandHandler(command)])),
    ...Object.fromEntries(Object.entries(TELEGRAM_COMMAND_ALIASES).map(([alias, binding]) => {
      const handler = canonicalHandlers[binding.target];
      return [alias, "args" in binding ? (ctx: WebhookCommandContext) => handler(ctx, binding.args) : handler];
    })),
  };
}

// Keep retired commands out of typo suggestions so short coin tickers like
// `/usdc` or `/sat` resolve as coins and users are never steered to retired commands.
const SUGGESTABLE_COMMANDS = [
  ...TELEGRAM_COMMAND_NAMES,
  "subscriptions",
];
const TICKER_COMMAND_PATTERN = /^\/[A-Za-z0-9.$]{2,15}$/;

/**
 * Reply for a command no handler owns. Checks tracked ticker resolution FIRST
 * (handling both unique and ambiguous symbols directly via `/status` with no
 * extra preamble message), then suggests the nearest live command by edit
 * distance.
 */
export async function replyToUnknownCommand(ctx: WebhookCommandContext, command: string): Promise<void> {
  const token = command.replace(/^\//, "");
  if (TICKER_COMMAND_PATTERN.test(command)) {
    const match = resolveTicker(token, "tracked");
    if (match.status === "unique") {
      await handleStatus(ctx, match.matches[0]!.id);
      return;
    }
    if (match.status === "ambiguous") {
      await handleStatus(ctx, token);
      return;
    }
  }
  const suggestion = suggestClosestToken(token, SUGGESTABLE_COMMANDS)
    ?? (token.length >= 6 ? suggestTwoEdits(token) : null);
  if (suggestion) {
    await replyWithHelp(ctx, `I don't know ${command}. Did you mean ${cmdForChat(suggestion, ctx.chatType)}?`);
    return;
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
