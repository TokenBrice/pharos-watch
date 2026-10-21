import type { FaqItem } from "@/lib/faq";
import type { TelegramLiveAlertType } from "@shared/types/status";
import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS,
} from "@shared/lib/telegram-alert-families";
import {
  TELEGRAM_COMMAND_REFERENCE,
  type TelegramCommandReferenceEntry,
} from "@shared/lib/telegram-bot-registration";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";

export const TELEGRAM_PAGE_DESCRIPTION =
  "PharosWatchBot delivers customizable stablecoin risk alerts, watchlists, quiet hours, and threshold controls in Telegram.";

export const TELEGRAM_ACTIONS = [
  {
    key: "bot",
    title: "PharosWatchBot",
    handle: "@PharosWatchBot",
    href: "https://t.me/PharosWatchBot",
    description:
      "Per-coin or all-stablecoin alerts for DEWS changes, depegs, safety-grade moves with reason lines, launches, live reserve-mix drift, and issuer freeze events. Tune thresholds, set quiet hours, snooze on the fly.",
    cardButtonLabel: "Open Bot",
    showArchiveLink: false,
    isPrimary: true,
  },
  {
    key: "digest",
    title: "Daily Digest",
    handle: "@pharoswatch",
    href: "https://t.me/pharoswatch",
    description:
      "Optional daily recap, AI-written from the same signals: peg deviations, supply shifts, liquidity changes, and what changed overnight.",
    cardButtonLabel: "Join Channel",
    showArchiveLink: true,
    isPrimary: false,
  },
  {
    key: "community",
    title: "Community",
    handle: "@pharoswatchers",
    href: "https://t.me/pharoswatchers",
    description:
      "Optional open channel where watchers compare notes between digests: fresh depegs, risk signals, and live commentary.",
    cardButtonLabel: "Join Community",
    showArchiveLink: false,
    isPrimary: false,
  },
] as const;

export const MINI_APP_FEATURES = [
  { title: "Watchlist", detail: "Followed coins, alert toggles, live risk context." },
  { title: "Global alerts", detail: "DEWS, depeg, safety, launch, reserve, and freeze in one panel." },
  { title: "Per-coin tuning", detail: "DEWS bands, depeg steps, safety modes, reserve, and freeze switches." },
  { title: "Presets", detail: "One-tap cohorts like USD Top 25." },
  { title: "Quiet hours", detail: "Mute nights, snooze bursts, resume cleanly." },
  { title: "Delivery health", detail: "See whether Telegram can still reach you." },
  { title: "Coin search", detail: "Find and add stablecoins fast." },
  { title: "Bot sync", detail: "Commands and app share one alert state." },
  { title: "Deep links", detail: "Jump straight to settings, presets, or a coin." },
] as const satisfies readonly { title: string; detail: string }[];

export const MINI_APP_SCREENSHOTS = [
  {
    title: "Home",
    src: "/featured/telegram-mini-app/home.jpg",
    alt: "PharosWatchBot Mini App home screen with watcher state, snooze controls, quiet hours, and last delivery",
    width: 549,
    height: 1280,
  },
  {
    title: "Watchlist",
    src: "/featured/telegram-mini-app/watchlist.jpg",
    alt: "PharosWatchBot Mini App watchlist screen with per-coin alert toggles",
    width: 549,
    height: 1280,
  },
  {
    title: "Presets",
    src: "/featured/telegram-mini-app/presets.jpg",
    alt: "PharosWatchBot Mini App presets screen with followed and available preset watchlists",
    width: 549,
    height: 1280,
  },
  {
    title: "Settings",
    src: "/featured/telegram-mini-app/settings.jpg",
    alt: "PharosWatchBot Mini App settings screen with global alerts, depeg step, and quiet hours",
    width: 549,
    height: 1280,
  },
] as const satisfies readonly { title: string; src: string; alt: string; width: number; height: number }[];

// Page-specific presentation for each alert-family example; keys, labels, and
// the message bodies themselves derive from the shared manifests so the
// bubbles stay exactly what the bot sends (worker contract test enforced).
// The taglines are the plain-language read of each family — jargon spelled
// out, honest caveat included.
const ALERT_EXAMPLE_PRESENTATION: Record<TelegramLiveAlertType, { tagline: string }> = {
  dews: {
    tagline:
      "DEWS — the Depeg Early Warning System — scores stress before a peg breaks. Fires when a coin moves into a worse band and stays there for two readings, with the two highest-stress signals named.",
  },
  depeg: {
    tagline:
      "Fires when a peg moves past your severity step (100, 250, or 500 basis points), again on each worsening milestone, and when the peg recovers.",
  },
  safety: {
    tagline:
      "Fires only on severe downgrades — two or more notches, or into D or F — that hold for 6 hours, at most once a day per coin, and names the driver so you know why. Upgrades and small moves never page you.",
  },
  reserve: {
    tagline:
      "Fires when a live-tracked coin's backing mix newly diverges from its curated profile. Entering drift only, and only on coins with live reserve tracking.",
  },
  freeze: {
    tagline:
      "Fires when the verified on-chain tape records an issuer destroy event, or a blacklist or release of $1M or more. Opt-in, per coin.",
  },
};

export const TELEGRAM_ALERT_EXAMPLES = TELEGRAM_ALERT_FAMILIES.map((family) => ({
  key: family.key,
  label: family.label,
  tagline: ALERT_EXAMPLE_PRESENTATION[family.key].tagline,
  content: TELEGRAM_PUBLIC_ALERT_SAMPLES[family.key].message,
}));

// Public command list. Every row derives from the shared command manifest
// (the same source as the BotFather menus and the bot's /help), so the page
// cannot list a command the bot does not answer.
function commandRows(menu: "menu" | "typed"): TelegramCommandRow[] {
  return Object.values(TELEGRAM_COMMAND_REFERENCE as Record<string, TelegramCommandReferenceEntry>)
    .filter((entry) => (entry.menu === "typed") === (menu === "typed"))
    .flatMap((entry) => entry.variants.map((variant) => ({
      command: variant.syntax,
      description: variant.help,
      example: variant.example,
    })));
}

export interface TelegramCommandRow {
  command: string;
  description: string;
  example: string | null;
}

export const TELEGRAM_COMMAND_GROUPS: ReadonlyArray<{ label: string; commands: readonly TelegramCommandRow[] }> = [
  { label: "In the menu", commands: commandRows("menu") },
  { label: "Typed only", commands: commandRows("typed") },
];

export const TELEGRAM_COMMAND_COUNT = TELEGRAM_COMMAND_GROUPS.reduce(
  (sum, group) => sum + group.commands.length,
  0,
);

export const TELEGRAM_PARAM_LEGEND = [
  { token: "<types>", meaning: `Comma-separated: ${TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS}` },
  { token: "<targets>", meaning: "Space-separated tickers, coin-ids, or presets such as usd-top25" },
  { token: "<ticker>", meaning: "Symbol (USDC) or coin-id (usdc-circle)" },
  { token: "all", meaning: "Reserved target meaning every tracked stablecoin" },
] as const;

export const TELEGRAM_FAQ: FaqItem[] = [
  {
    question: "Is PharosWatchBot free?",
    answer:
      "Yes. All alert families, presets, group commands, and tuning controls are free. Pharos is donor-funded; see the funding page if you want to support it.",
  },
  {
    question: "Where do alerts land — DM or group?",
    answer:
      "Subscriptions are tied to the chat where you ran the command. DM the bot for personal alerts, or add @PharosWatchBot to a Telegram group for a shared watch desk.",
  },
  {
    question: "What alerts does Pharos send on Telegram?",
    answer:
      "DEWS threat-level band crossings, depeg detections and worsening milestones, safety-grade changes with reason lines, pre-launch assets going live, entering live reserve-mix drift, and verified issuer freeze events.",
  },
  {
    question: "Can I get alerts for all tracked stablecoins at once?",
    answer:
      "Yes. Send /subscribe <type> all, for example /subscribe depeg all, to subscribe across every tracked stablecoin. The safety lane is intentionally narrower globally: it sends downgrades only and applies a 3-point filter when scores are present.",
  },
  {
    question: "How do I silence Telegram notifications during certain hours?",
    answer:
      "Use /mute <start>-<end> with integer hours (0–23). For example, /mute 22-07 silences alerts between 10pm and 7am. Quiet hours are interpreted in the chat's /timezone: set it once with /timezone Europe/Paris (or any IANA zone) and /mute will use it; without /timezone, hours fall back to UTC. Use /unmutehours to disable quiet hours. Use alert toggles or unsubscribes for all-day silence.",
  },
  {
    question: "Is there a Mini App or do I have to type commands?",
    answer:
      "Both work. Every alert family, preset, and threshold is reachable through commands. There's also a Mini App you can open from the bot's menu button or via https://t.me/PharosWatchBot?startapp=home. It gives you a visual surface for the watchlist, settings, snooze, and presets without typing slash commands. The Mini App and the bot share the same subscription state, so you can switch between them freely.",
  },
  {
    question: "What are preset watchlists?",
    answer:
      "Presets are curated coin lists like usd-top25, non-usd-top25, or mcap-ge-1b (compact and dashed spellings both work). Subscribing to a preset expands to its current member coins. Send /presets in Telegram to browse them.",
  },
  {
    question: "Can I use the bot in a Telegram group?",
    answer:
      "Yes. Add @PharosWatchBot to the group and use addressed commands such as /subscribe@PharosWatchBot dews usd-top25. Subscriptions apply to that chat, and pending ticker selections can only be completed by the user who started them.",
  },
  {
    question: "How do I unsubscribe?",
    answer:
      "Send /unsubscribe <targets> to remove specific coin subscriptions, or /unsubscribe all to clear every subscription and disable all alert flags. This stops alerts but does not immediately delete operational chat metadata; use /forget in a private chat for immediate subscriber-data deletion.",
  },
  {
    question: "What does Pharos store for Telegram privacy?",
    answer:
      "Pharos stores chat-level alert settings, quiet hours, snooze state, and short-lived command or delivery metadata. /forget starts a private two-step deletion flow for subscriber data and live diagnostics. Inactive unsubscribed chats are pruned after 180 days, and public pulse metrics hide low-cardinality deltas while keeping the exact active watcher total visible.",
  },
];

export const TELEGRAM_COMMAND_REFERENCE_TIPS = [
  "Most settings (quiet hours, pause, per-coin tuning) live in Manage Alerts, the button next to the message box.",
  "Tickers are case-insensitive. When a symbol matches several coins, the bot shows one button per coin.",
  "In Telegram groups, address commands to the bot: /subscribe@PharosWatchBot usd-top25. Groups get status, list, subscribe, settings and help; changes need a group admin.",
  "Typing / inside Telegram opens the command menu.",
] as const;
