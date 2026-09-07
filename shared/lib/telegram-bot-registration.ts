import { TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS, TELEGRAM_ALERT_FAMILY_PHRASE_LIST } from "./telegram-alert-families";

export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "my_chat_member",
  "inline_query",
  "chosen_inline_result",
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
  "Stablecoin risk alerts and a visual control panel for watchlists, quiet hours, and tuning.";
// The family list derives from the canonical alert-family manifest so the
// profile copy stays count-free and cannot drift from the runtime families.
export const TELEGRAM_BOT_DESCRIPTION =
  `Pharos Watch pushes alerts across the tracked stablecoin universe: ${TELEGRAM_ALERT_FAMILY_PHRASE_LIST}. Subscribe to curated presets like usd-top25, or build a custom watchlist of any tracked coin. Tap the menu button to open the Mini App — your visual control panel for watchlists, quiet hours, and per-coin tuning. Learn more at https://pharos.watch/pharoswatchbot/`;

/**
 * One typed form of a command. `syntax`/`help` are plain text; renderers are
 * responsible for HTML escaping (bot messages) or JSX text (public pages).
 */
export interface TelegramCommandVariant {
  /** Typed syntax with placeholders, e.g. "/subscribe <types> <targets>". */
  readonly syntax: string;
  /** Concise one-line meaning used by the bot's /help listing. */
  readonly help: string;
  /** Exact usage example for the public reference; null when the bare syntax is the example. */
  readonly example: string | null;
}

export interface TelegramCommandReferenceEntry {
  /** BotFather menu description for the private scope (group remap below). */
  readonly description: string;
  /** "private" hides the command from the group menu (start, forget, recap). */
  readonly audience: "private" | "chat";
  /** Syntax variants shared by /help and the public command reference. */
  readonly variants: readonly TelegramCommandVariant[];
  /** Deprecated command tokens still dispatched to this command. */
  readonly deprecatedAliases?: readonly string[];
}

// Canonical command reference. Insertion order is the BotFather menu order;
// registration menus, the bot's /help copy, and the public command reference
// all derive from this one manifest so the three surfaces cannot drift.
export const TELEGRAM_COMMAND_REFERENCE = {
  start: {
    description: "Get started with Pharos alerts",
    audience: "private",
    variants: [
      {
        syntax: "/start",
        help: "Open the guided setup flow or process a Telegram deep-link payload",
        example: "/start",
      },
    ],
  },
  help: {
    description: "Command reference",
    audience: "chat",
    variants: [{ syntax: "/help", help: "Show the command reference", example: null }],
  },
  sample: {
    description: "Preview a synthetic alert before subscribing",
    audience: "chat",
    variants: [
      {
        syntax: "/sample",
        help: "Preview a sample DEWS alert without changing subscriptions",
        example: "/sample",
      },
    ],
  },
  status: {
    description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)",
    audience: "chat",
    variants: [
      {
        syntax: "/status <ticker>",
        help: "Current peg, DEWS band, and safety grade for one coin — no subscription needed",
        example: "/status USDC",
      },
    ],
  },
  brief: {
    description: "Latest Pharos market brief",
    audience: "chat",
    deprecatedAliases: ["market"],
    variants: [
      {
        syntax: "/brief",
        help: "Latest market brief from the daily digest inputs",
        example: "/brief",
      },
    ],
  },
  top: {
    description: "Rank current views: depeg, dews, yield, liquidity, chains, safety",
    audience: "chat",
    variants: [
      {
        syntax: "/top <view>",
        help: "Rank current views: depeg, dews, yield, liquidity, chains, or safety",
        example: "/top depeg",
      },
    ],
  },
  why: {
    description: "Explain one coin Safety Score (e.g. /why USDC)",
    audience: "chat",
    variants: [
      {
        syntax: "/why <ticker>",
        help: "Explain the current Safety Score in plain language",
        example: "/why USDC",
      },
    ],
  },
  coverage: {
    description: "Show which Pharos data surfaces cover one coin",
    audience: "chat",
    variants: [
      {
        syntax: "/coverage <ticker>",
        help: "Show which Pharos data surfaces currently cover one coin",
        example: "/coverage USDC",
      },
    ],
  },
  health: {
    description: "Show delivery diagnostics for this chat",
    audience: "chat",
    variants: [
      {
        syntax: "/health",
        help: "Show delivery diagnostics for this chat: queued alerts, quiet hours, snooze, and recent failure class",
        example: null,
      },
    ],
  },
  list: {
    description: "Show your current subscriptions and settings",
    audience: "chat",
    variants: [{ syntax: "/list", help: "Show current subscriptions and settings", example: null }],
  },
  subscribe: {
    description: "Subscribe to alerts (e.g. /subscribe usd-top-50 depeg-step 250)",
    audience: "chat",
    variants: [
      {
        syntax: "/subscribe <types> <targets>",
        help: `Enable alert types (${TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS}) for coins; presets support dews, depeg, and safety only`,
        example: "/subscribe dews,depeg usd-top25",
      },
      {
        syntax: "/subscribe <types> all",
        help: "Enable alert types across all tracked stablecoins; safety all delivers downgrades only, with a 3-point drop when scored",
        example: "/subscribe depeg,safety all",
      },
      {
        syntax: "/subscribe <targets> depeg-step <value>",
        help: "Enable depeg alerts for coins or preset watchlists and re-alert when worsening crosses the step (100, 250, or 500 bps)",
        example: "/subscribe usd-top50 depeg-step 250",
      },
    ],
  },
  unsubscribe: {
    description: "Remove coin subscriptions",
    audience: "chat",
    variants: [
      {
        syntax: "/unsubscribe <targets>",
        help: "Remove specific coin subscriptions or preset-expanded coins",
        example: "/unsubscribe usd-top25",
      },
      {
        syntax: "/unsubscribe all",
        help: "Remove all per-coin and all-stablecoin subscriptions",
        example: null,
      },
    ],
  },
  presets: {
    description: "Browse preset watchlists like usd-top25 / non-usd-top25",
    audience: "chat",
    variants: [
      {
        syntax: "/presets",
        help: "Show the preset watchlist catalog and examples",
        example: "/presets",
      },
    ],
  },
  set: {
    description: "Tune per-coin or global thresholds (e.g. /set all depeg-step 250)",
    audience: "chat",
    variants: [
      {
        syntax: "/set <ticker> <setting> <value>",
        help: "Tune one coin's DEWS band, depeg on/off or step, safety mode, or launch/reserve/freeze toggles",
        example: "/set USDT dews WARNING",
      },
      {
        syntax: "/set all <setting> <value>",
        help: "Toggle an alert family across every tracked coin, or set the global depeg severity step",
        example: "/set all depeg-step 250",
      },
    ],
  },
  settings: {
    description: "Open the inline settings keyboard (e.g. /settings or /settings USDC)",
    audience: "chat",
    variants: [
      {
        syntax: "/settings",
        help: "Review and edit chat-level alert settings; add a ticker for the per-coin panel",
        example: "/settings USDC",
      },
    ],
  },
  mute: {
    description: "Enable quiet hours (e.g. /mute 22-07; uses your /timezone)",
    audience: "chat",
    variants: [
      {
        syntax: "/mute <start>-<end>",
        help: "Quiet hours like 22-07 in your /timezone (defaults to UTC; notifications silenced, messages still delivered)",
        example: "/mute 22-07",
      },
    ],
  },
  pause: {
    description: "Pause all alerts indefinitely; /pause off to resume",
    audience: "chat",
    variants: [
      {
        syntax: "/pause [off|1h|4h|24h]",
        help: "Pause all alert delivery indefinitely, resume with off, or pause for 1h, 4h, or 24h",
        example: "/pause 4h",
      },
    ],
  },
  timezone: {
    description: "Set chat timezone for quiet hours (e.g. /timezone Europe/Paris)",
    audience: "chat",
    variants: [
      {
        syntax: "/timezone <IANA-zone>",
        help: "Set chat timezone for quiet hours, or send /timezone alone to pick from common zones",
        example: "/timezone Europe/Paris",
      },
    ],
  },
  recap: {
    description: "Set your private daily watchlist recap",
    audience: "private",
    variants: [
      {
        syntax: "/recap [on|off]",
        help: "Show, enable, or disable your private daily watchlist recap (private chat only)",
        example: "/recap on",
      },
      {
        syntax: "/recap time <hour>",
        help: "Set the recap delivery hour 0-23 in your confirmed timezone",
        example: "/recap time 9",
      },
    ],
  },
  unsnooze: {
    description: "Clear active alert snooze",
    audience: "chat",
    variants: [{ syntax: "/unsnooze", help: "Clear an active alert snooze immediately", example: null }],
  },
  unmutehours: {
    description: "Disable quiet hours",
    audience: "chat",
    variants: [{ syntax: "/unmutehours", help: "Disable quiet hours", example: null }],
  },
  cancel: {
    description: "Cancel a pending ticker selection",
    audience: "chat",
    variants: [{ syntax: "/cancel", help: "Cancel a pending selection", example: null }],
  },
  export: {
    description: "Copy your watchlist out as a shareable token",
    audience: "chat",
    variants: [
      {
        syntax: "/export",
        help: "Copy your follows into a shareable portable token (quiet hours and snooze excluded)",
        example: "/export",
      },
    ],
  },
  import: {
    description: "Apply a watchlist token from /export (group admins only)",
    audience: "chat",
    variants: [
      {
        syntax: "/import <token>",
        help: "Apply a watchlist token from /export behind a confirmation (group admins only)",
        example: "/import eyJ2IjoxLC4uLn0",
      },
    ],
  },
  forget: {
    description: "Delete all your subscriber data",
    audience: "private",
    variants: [{ syntax: "/forget", help: "Delete all your subscriber data", example: null }],
  },
} as const satisfies Record<string, TelegramCommandReferenceEntry>;

// BotFather registration list derives from the reference so menu order and
// descriptions stay in sync with /help and the public command reference.
export const TELEGRAM_BOT_COMMANDS = Object.entries(TELEGRAM_COMMAND_REFERENCE).map(([command, entry]) => ({
  command,
  description: entry.description,
}));

// Derive the group command list from the same reference: "private"-audience
// commands are excluded and /import's description is remapped to reflect that
// group admins only can use it (the only intentional divergence).
export const TELEGRAM_BOT_GROUP_COMMANDS = Object.entries(TELEGRAM_COMMAND_REFERENCE)
  .filter(([, entry]) => entry.audience !== "private")
  .map(([command, entry]) =>
    command === "import"
      ? { command, description: "Apply a watchlist token from /export (admins only)" }
      : { command, description: entry.description },
  );

/** `/recap` is only advertised after the rollout reaches the public mode. */
export function getTelegramPrivateBotCommands(
  includeRecap: boolean,
): readonly (typeof TELEGRAM_BOT_COMMANDS)[number][] {
  return includeRecap
    ? TELEGRAM_BOT_COMMANDS
    : TELEGRAM_BOT_COMMANDS.filter((entry) => entry.command !== "recap");
}
