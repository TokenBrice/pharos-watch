import { TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS } from "./telegram-alert-families";

export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "my_chat_member",
] as const;

// Canonical @-handle for the bot. Single source of truth for the dispatch
// addressed-to check, user-facing mentions, deep links, and the Mini App path
// so a rename is a one-line change. Telegram usernames are case-insensitive;
// keep the display casing here and lowercase at the comparison/path site.
export const TELEGRAM_BOT_USERNAME = "PharosWatchBot";
export const TELEGRAM_BOT_URL = `https://t.me/${TELEGRAM_BOT_USERNAME}`;

// Profile metadata shown on the bot's About page, card preview, and chat
// header. Kept in shared code so Worker reconciliation and manual recovery
// scripts use the same reviewed payloads.
export const TELEGRAM_BOT_NAME = "Pharos Watch";
export const TELEGRAM_BOT_SHORT_DESCRIPTION =
  "Alerts when a stablecoin you follow loses its peg, shows rising stress, or changes Safety grade. Free.";
export const TELEGRAM_BOT_DESCRIPTION = [
  "Pharos Watch messages you when a stablecoin you follow loses its peg, shows early signs of stress, or has its Safety grade changed.",
  "Tap Start to follow the 25 largest USD stablecoins in one tap, or choose your own coins. Change anything later in Manage Alerts.",
  "Free. Data and methods: https://pharos.watch/pharoswatchbot/",
].join("\n\n");

/**
 * One typed form of a command. `syntax`/`help` are plain text; renderers are
 * responsible for HTML escaping (bot messages) or JSX text (public pages).
 */
export interface TelegramCommandVariant {
  /** Typed syntax with placeholders, e.g. "/subscribe <targets>". */
  readonly syntax: string;
  /** Concise one-line meaning used by /help and the public command list. */
  readonly help: string;
  /** Exact usage example; null when the bare syntax is the example. */
  readonly example: string | null;
}

export interface TelegramCommandReferenceEntry {
  /** BotFather menu description. */
  readonly description: string;
  /**
   * Menu placement: "all" registers in private and group menus, "private" in
   * the private menu only, "typed" in neither (the command still works).
   */
  readonly menu: "all" | "private" | "typed";
  /** Syntax variants shared by /help and the public command list. */
  readonly variants: readonly TelegramCommandVariant[];
}

// Canonical command set. Insertion order is the BotFather menu order; the
// registration menus, the bot's /help copy, and the public command list on
// /pharoswatchbot all derive from this one manifest so they cannot drift.
// Retired commands are not listed here: the Worker answers them with a
// one-line redirect (worker/src/telegram/commands/legacy.ts).
export const TELEGRAM_COMMAND_REFERENCE = {
  start: {
    description: "Set up alerts",
    menu: "private",
    variants: [
      { syntax: "/start", help: "Follow the 25 largest USD stablecoins in one tap, or choose your own coins", example: null },
    ],
  },
  status: {
    description: "Your alerts, or one coin (e.g. /status USDC)",
    menu: "all",
    variants: [
      { syntax: "/status", help: "What you follow, whether alerts are on, and active depegs", example: null },
      { syntax: "/status <ticker>", help: "Peg, stress level and Safety grade for one coin", example: "/status USDC" },
    ],
  },
  list: {
    description: "What you follow",
    menu: "all",
    variants: [{ syntax: "/list", help: "Presets and coins you follow, quiet hours and pause", example: null }],
  },
  subscribe: {
    description: "Follow coins or a preset (e.g. /subscribe USDC)",
    menu: "all",
    variants: [
      {
        syntax: "/subscribe <targets>",
        help: "Follow coins or a preset for depeg and stress alerts",
        example: "/subscribe USDC USDT",
      },
      {
        syntax: "/subscribe <types> <targets>",
        help: `Choose alert types (${TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS}); presets support dews, depeg and safety`,
        example: "/subscribe dews,depeg usd-top25",
      },
    ],
  },
  settings: {
    description: "Alert settings",
    menu: "all",
    variants: [
      { syntax: "/settings", help: "Open alert settings (in groups, an inline settings keyboard)", example: null },
    ],
  },
  pause: {
    description: "Pause or resume all alerts",
    menu: "private",
    variants: [
      { syntax: "/pause [1h|4h|24h|off]", help: "Hold all alerts until you resume, or for a set time", example: "/pause 4h" },
    ],
  },
  help: {
    description: "Commands and help",
    menu: "all",
    variants: [{ syntax: "/help", help: "Short command list", example: null }],
  },
  unsubscribe: {
    description: "Stop following coins",
    menu: "typed",
    variants: [
      { syntax: "/unsubscribe <targets>", help: "Stop following coins or a preset", example: "/unsubscribe USDC" },
      { syntax: "/unsubscribe all", help: "Remove every follow and global alert in this chat", example: null },
    ],
  },
  forget: {
    description: "Delete all your data",
    menu: "typed",
    variants: [{ syntax: "/forget", help: "Delete everything Pharos Watch stores about this chat", example: null }],
  },
} as const satisfies Record<string, TelegramCommandReferenceEntry>;

export type TelegramCommandName = keyof typeof TELEGRAM_COMMAND_REFERENCE;

export const TELEGRAM_COMMAND_NAMES = Object.keys(TELEGRAM_COMMAND_REFERENCE) as TelegramCommandName[];

const commandEntries = Object.entries(TELEGRAM_COMMAND_REFERENCE) as [
  TelegramCommandName,
  TelegramCommandReferenceEntry,
][];

// BotFather private menu: every "all" and "private" command, in manifest order.
export const TELEGRAM_BOT_COMMANDS = commandEntries
  .filter(([, entry]) => entry.menu !== "typed")
  .map(([command, entry]) => ({ command, description: entry.description }));

// BotFather group menu: only "all" commands.
export const TELEGRAM_BOT_GROUP_COMMANDS = commandEntries
  .filter(([, entry]) => entry.menu === "all")
  .map(([command, entry]) => ({ command, description: entry.description }));
