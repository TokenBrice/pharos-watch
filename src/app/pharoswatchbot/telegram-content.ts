import type { FaqItem } from "@/lib/faq";
import type { TelegramLiveAlertType } from "@shared/types/status";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import { TELEGRAM_ALERT_FAMILIES } from "@shared/lib/telegram-alert-families";
import {
  TELEGRAM_COMMAND_REFERENCE,
  type TelegramCommandReferenceEntry,
} from "@shared/lib/telegram-bot-registration";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import {
  PENDING_TTL_SEC,
  TELEGRAM_ALERT_POLICY,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
} from "@shared/lib/telegram-delivery-policy";

// Policy numbers quoted in the copy come from the delivery policy (R5).
export const DAILY_LIVE_ALERT_CAP = TELEGRAM_ALERT_POLICY.chatCap.maxRealtimeMessages;
export const DAILY_CHANGES_TIME = `${String(TELEGRAM_ALERT_POLICY.rollup.localHour).padStart(2, "0")}:00`;
const FREEZE_BATCH_MINUTES = TELEGRAM_ALERT_POLICY.freeze.batchIntervalSec / 60;
const FREEZE_BATCH_LABEL = FREEZE_BATCH_MINUTES === 60 ? "an hourly batch" : `a batch every ${FREEZE_BATCH_MINUTES} minutes`;
export const LIVE_FREEZE_MIN_LABEL = `$${TELEGRAM_ALERT_POLICY.freeze.realtimeMinAmountUsd / 1_000_000}M`;

export const TELEGRAM_PAGE_DESCRIPTION =
  "PharosWatchBot sends stablecoin depeg and risk alerts to Telegram. Quiet by default, with one daily message for smaller changes.";

export const TELEGRAM_COVERAGE_SENTENCE =
  `Stablecoin risk alerts in your Telegram chat, free for all ${ACTIVE_STABLECOIN_COUNT.toLocaleString("en-US")} active stablecoins. Five alert types watch every peg. Urgent moves arrive live; smaller ones wait for one daily message.`;

export const TELEGRAM_ACTIONS = [
  {
    key: "bot",
    title: "PharosWatchBot",
    handle: "@PharosWatchBot",
    href: "https://t.me/PharosWatchBot",
    description:
      "Depeg, stress, severe safety-grade and large freeze alerts for the coins you follow, plus one daily message for smaller changes.",
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
      "Daily market digest, AI-written from the same signals, including new stablecoin launches.",
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
      "Open chat where watchers compare notes on fresh depegs and risk signals.",
    cardButtonLabel: "Join Community",
    showArchiveLink: false,
    isPrimary: false,
  },
] as const;

export const MINI_APP_FEATURES = [
  { title: "Your coins", detail: "Every coin you follow, largest first, with what covers it." },
  { title: "Add coins", detail: "Search by name or ticker and add several at once." },
  { title: "Coin detail", detail: "Peg, coverage and a mute for one coin." },
  { title: "Make it quieter", detail: "Quiet hours, pause, and which alerts you get." },
  { title: "Delivery status", detail: "See whether Telegram can still reach you." },
  { title: "Saves as you go", detail: "No Save button. Chat and app share one setup." },
] as const satisfies readonly { title: string; detail: string }[];

export const MINI_APP_SCREENSHOTS = [
  {
    title: "Home",
    src: "/featured/telegram-mini-app/home.jpg",
    alt: "PharosWatchBot Mini App home screen: alerts on with quiet hours, followed groups, and coins listed largest first with the alerts each one gets",
    width: 549,
    height: 1280,
  },
  {
    title: "Coin detail",
    src: "/featured/telegram-mini-app/coin.jpg",
    alt: "PharosWatchBot Mini App coin screen for USDC with early warning, depeg and safety switches, a snooze row and a link to the coin on Pharos",
    width: 549,
    height: 1280,
  },
  {
    title: "Add coins",
    src: "/featured/telegram-mini-app/add-coins.jpg",
    alt: "PharosWatchBot Mini App search for usd with several stablecoins ticked and an Add 2 coins button",
    width: 549,
    height: 1280,
  },
  {
    title: "Settings",
    src: "/featured/telegram-mini-app/settings.jpg",
    alt: "PharosWatchBot Mini App settings screen with quiet hours and time zone, delivery status, and data controls",
    width: 549,
    height: 1280,
  },
] as const satisfies readonly { title: string; src: string; alt: string; width: number; height: number }[];

// Page-specific presentation for each alert-family example; keys, labels, and
// the message bodies themselves derive from the shared manifests so the
// bubbles stay exactly what the bot sends (worker contract test enforced).
// The taglines are the plain-language read of each family: jargon spelled
// out, and which moves arrive live versus in the daily Changes message.
const ALERT_EXAMPLE_PRESENTATION: Record<TelegramLiveAlertType, { tagline: string }> = {
  dews: {
    tagline:
      "DEWS, the Depeg Early Warning System, scores stress before a peg breaks. Sent live for coins you follow when a coin holds a worse stress level for about an hour; calmer readings, and market-wide DEWS under All stablecoins, go in the daily Changes message.",
  },
  depeg: {
    tagline:
      "Sent live when a peg moves past your step (1%, 2.5% or 5%), again each time it gets worse, and when it recovers. Depegs never count toward the daily limit.",
  },
  safety: {
    tagline:
      "Sent live only for a severe downgrade, held for 6 hours: two or more steps (B to C+, say) or a fall into D or F. At most once a day per coin. Smaller moves and upgrades go in the daily Changes message.",
  },
  reserve: {
    tagline:
      "Tells you when the live reserve data for a coin stops matching its last reviewed mix. Only for coins with live reserve tracking, and it is sent live when first detected.",
  },
  freeze: {
    tagline:
      `An issuer froze, released or destroyed tokens at an address. Destroys, and freezes or releases of ${LIVE_FREEZE_MIN_LABEL} or more, arrive live; smaller ones come in ${FREEZE_BATCH_LABEL}. Off unless you turn it on for a coin.`,
  },
};

export const TELEGRAM_ALERT_EXAMPLES = TELEGRAM_ALERT_FAMILIES.map((family) => ({
  key: family.key,
  label: family.label,
  shortLabel: family.shortLabel,
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

// Reliability copy derives from the shared delivery policy so the public
// contract cannot drift from production TTL/cadence constants (TGB-028).
function formatPolicyDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export const TELEGRAM_FAQ: FaqItem[] = [
  {
    question: "Is PharosWatchBot free?",
    answer:
      "Yes. Every alert type, preset, group feature and setting is free. Pharos is donor-funded; see the funding page if you want to support it.",
  },
  {
    question: "What alerts does Pharos send on Telegram?",
    answer:
      `Live alerts cover depegs and recoveries, rising DEWS stress, severe safety-grade downgrades, reserve drift, and freezes or destroys of ${LIVE_FREEZE_MIN_LABEL} or more. Smaller safety moves are grouped into one daily Changes message at ${DAILY_CHANGES_TIME} your time, sent only when something changed. Smaller freezes come in ${FREEZE_BATCH_LABEL}.`,
  },
  {
    question: "How many messages will I get?",
    answer:
      `Very few on a normal day. Outside depegs, a chat gets at most ${DAILY_LIVE_ALERT_CAP} live alerts a day; anything past that waits for the daily Changes message. Every alert has Mute 24h, Pause all 4h and Fewer like this buttons, and quiet hours keep nights silent.`,
  },
  {
    question: "Where do alerts land: DM or group?",
    answer:
      "Alerts go to the chat where you set them up. Message the bot for personal alerts, or add @PharosWatchBot to a Telegram group for a shared watch desk. In a group, only admins can change what it follows.",
  },
  {
    question: "Do I have to type commands?",
    answer:
      "No. Tap Manage Alerts, under any alert or next to the message box, to open the Mini App: add coins, set quiet hours and pause in a few taps. Commands such as /status USDC still work, and both share the same setup.",
  },
  {
    question: "What are presets?",
    answer:
      "Presets are ready-made coin lists such as USD Top 25. Following one keeps up with the market: when a coin joins or leaves the list, your alerts follow. Add one from the Mini App or send /subscribe usd-top25.",
  },
  {
    question: "Can I follow every active stablecoin at once?",
    answer:
      "Yes. Send /subscribe depeg all, or turn on All stablecoins in the Mini App. Market-wide safety and DEWS changes are grouped into the daily Changes message so the whole market does not page you.",
  },
  {
    question: "Can I rely on it as an emergency pager?",
    answer:
      `No. Alerts are a bounded notification service, not a guaranteed emergency pager. Pharos checks for new alerts every ${formatPolicyDuration(TELEGRAM_DISPATCH_INTERVAL_SEC)}; an alert that cannot be delivered within ${formatPolicyDuration(PENDING_TTL_SEC)} is dropped rather than sent late. Each message links to Pharos so you can check the signal yourself.`,
  },
  {
    question: "What does Pharos store about my chat?",
    answer:
      "Your chat ID, optional username, the coins and presets you follow, alert settings, quiet hours, pause state, and short-lived delivery records. Public adoption figures are aggregate counts, and small daily changes are hidden so no single chat can be identified.",
  },
  {
    question: "How do I stop alerts or delete my data?",
    answer:
      "Send /pause to stop alerts for a while, or /unsubscribe all to stop them for good. In a private chat, /forget deletes everything Pharos stores about that chat. Inactive unsubscribed chats are removed after 180 days.",
  },
];

export const TELEGRAM_COMMAND_REFERENCE_TIPS = [
  "In groups, address commands to the bot, as in /subscribe@PharosWatchBot usd-top25. Groups get status, list, subscribe, settings and help.",
] as const;
