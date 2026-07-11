import { TELEGRAM_ALERT_FAMILY_PHRASE_LIST } from "./telegram-alert-families";

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

export const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Get started with Pharos alerts" },
  { command: "help", description: "Command reference" },
  { command: "sample", description: "Preview a synthetic alert before subscribing" },
  { command: "status", description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)" },
  { command: "brief", description: "Latest Pharos market brief" },
  { command: "top", description: "Rank current views: depeg, dews, yield, liquidity, chains, safety" },
  { command: "why", description: "Explain one coin Safety Score (e.g. /why USDC)" },
  { command: "coverage", description: "Show which Pharos data surfaces cover one coin" },
  { command: "health", description: "Show delivery diagnostics for this chat" },
  { command: "list", description: "Show your current subscriptions and settings" },
  { command: "subscribe", description: "Subscribe to alerts (e.g. /subscribe usd-top-50 depeg-step 250)" },
  { command: "unsubscribe", description: "Remove coin subscriptions" },
  { command: "presets", description: "Browse preset watchlists like usd-top25 / non-usd-top25" },
  { command: "set", description: "Tune per-coin or global thresholds (e.g. /set all depeg-step 250)" },
  { command: "settings", description: "Open the inline settings keyboard (e.g. /settings or /settings USDC)" },
  { command: "mute", description: "Enable quiet hours (e.g. /mute 22-07; uses your /timezone)" },
  { command: "pause", description: "Pause all alerts indefinitely; /pause off to resume" },
  { command: "timezone", description: "Set chat timezone for quiet hours (e.g. /timezone Europe/Paris)" },
  { command: "recap", description: "Set your private daily watchlist recap" },
  { command: "unsnooze", description: "Clear active alert snooze" },
  { command: "unmutehours", description: "Disable quiet hours" },
  { command: "cancel", description: "Cancel a pending ticker selection" },
  { command: "export", description: "Copy your watchlist out as a shareable token" },
  { command: "import", description: "Apply a watchlist token from /export (group admins only)" },
  { command: "forget", description: "Delete all your subscriber data" },
] as const;

// Commands that are personal-only and must not appear in the group scope.
const PERSONAL_ONLY_COMMANDS = new Set(["start", "forget", "recap"]);

// Derive the group command list from the personal list so descriptions stay in
// sync: filter out personal-only commands and remap /import's description to
// reflect that group admins only can use it (the only intentional divergence).
export const TELEGRAM_BOT_GROUP_COMMANDS = TELEGRAM_BOT_COMMANDS
  .filter((entry) => !PERSONAL_ONLY_COMMANDS.has(entry.command))
  .map((entry) =>
    entry.command === "import"
      ? { ...entry, description: "Apply a watchlist token from /export (admins only)" }
      : entry,
  );
