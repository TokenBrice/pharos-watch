import { Bell, MessageSquareText, ShieldCheck, type LucideIcon } from "lucide-react";
import type { FaqItem } from "@/lib/faq";
import type { TelegramAlertType } from "@shared/types/status";
import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";

export const TELEGRAM_PAGE_DESCRIPTION =
  "PharosWatchBot delivers customizable stablecoin risk alerts, watchlists, daily recaps, quiet hours, and threshold controls in Telegram.";

export const TELEGRAM_ACTIONS = [
  {
    key: "bot",
    title: "PharosWatchBot",
    handle: "@PharosWatchBot",
    href: "https://t.me/PharosWatchBot",
    description:
      "Per-coin or all-stablecoin alerts for DEWS changes, depegs, safety-grade moves with reason lines, launches, live reserve-mix drift, and issuer freeze events, plus an optional private daily watchlist recap. Tune thresholds, set quiet hours, snooze on the fly.",
    cardButtonLabel: "Open Bot",
    finalButtonLabel: "Start Bot",
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
    finalButtonLabel: "Digest",
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
    finalButtonLabel: "Community",
    showArchiveLink: false,
    isPrimary: false,
  },
] as const;

export type TelegramActionKey = (typeof TELEGRAM_ACTIONS)[number]["key"];

export const MINI_APP_FEATURES = [
  { title: "Watchlist", detail: "Followed coins, alert toggles, live risk context." },
  { title: "Daily recap", detail: "One private summary when watched assets materially change." },
  { title: "Global alerts", detail: "DEWS, depeg, safety, launch, reserve, and freeze in one panel." },
  { title: "Per-coin tuning", detail: "DEWS bands, depeg steps, safety modes, reserve, and freeze switches." },
  { title: "Presets", detail: "One-tap cohorts like USD Top 25." },
  { title: "Quiet hours", detail: "Mute nights, snooze bursts, resume cleanly." },
  { title: "Delivery health", detail: "See whether Telegram can still reach you." },
  { title: "Coin search", detail: "Find and add stablecoins fast." },
  { title: "Bot sync", detail: "Commands and app share one alert state." },
  { title: "Deep links", detail: "Jump straight to settings, presets, or a coin." },
  { title: "Launch alerts", detail: "Catch tracked pre-launch assets going live." },
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

export const RECOMMENDED_SETUPS = [
  {
    title: "First watcher setup",
    command: "/subscribe dews,depeg usd-top25",
    description: "Top 25 USD stablecoins, DEWS plus depeg. The safe default if you're not sure where to start.",
    icon: Bell,
  },
  {
    title: "Research desk setup",
    command: "/subscribe safety mcap-ge-1b",
    description: "All safety-grade changes with reason lines, on coins above $1B mcap.",
    icon: ShieldCheck,
  },
  {
    title: "Group setup",
    command: "/subscribe@PharosWatchBot dews usd-top25",
    description: "Address commands to the bot so a shared Telegram group runs one watch desk without colliding with other bots.",
    icon: MessageSquareText,
  },
] as const satisfies readonly {
  title: string;
  command: string;
  description: string;
  icon: LucideIcon;
}[];

// Page-specific presentation for each alert-family example; keys, labels, and
// the message bodies themselves derive from the shared manifests so the
// bubbles stay exactly what the bot sends (worker contract test enforced).
// The taglines are the plain-language read of each family — jargon spelled
// out, honest caveat included. Times are the Night Watch narrative anchors.
const ALERT_EXAMPLE_PRESENTATION: Record<TelegramAlertType, { tagline: string; time: string }> = {
  dews: {
    tagline:
      "DEWS — the Depeg Early Warning System — scores stress before a peg breaks. Fires when a coin crosses into a worse band, with the two highest-stress signals named.",
    time: "23:47",
  },
  depeg: {
    tagline:
      "Fires when a peg moves past your severity step (100, 250, or 500 basis points), again on each worsening milestone, and when the peg recovers.",
    time: "00:32",
  },
  safety: {
    tagline:
      "Fires on live safety-grade shifts and names the driver on the Reason line, so you know why, not just what. Methodology re-scores never page you.",
    time: "01:18",
  },
  launch: {
    tagline: "Fires when a tracked pre-launch stablecoin goes live. Subscribe by ticker — presets don't cover launches.",
    time: "02:56",
  },
  reserve: {
    tagline:
      "Fires when a live-tracked coin's backing mix newly diverges from its curated profile. Entering drift only, and only on coins with live reserve tracking.",
    time: "04:21",
  },
  freeze: {
    tagline:
      "Fires when the verified on-chain tape records an issuer blacklist, release, or destroy event. Opt-in, per coin.",
    time: "05:12",
  },
};

export const TELEGRAM_ALERT_EXAMPLES = TELEGRAM_ALERT_FAMILIES.map((family) => ({
  key: family.key,
  label: family.label,
  tagline: ALERT_EXAMPLE_PRESENTATION[family.key].tagline,
  content: TELEGRAM_PUBLIC_ALERT_SAMPLES[family.key].message,
  time: ALERT_EXAMPLE_PRESENTATION[family.key].time,
}));

export const TELEGRAM_COMMAND_GROUPS = [
  {
    label: "Subscribe",
    commands: [
      {
        command: "/subscribe <types> <targets>",
        description:
          "Enable alert types for one or more coins, coin-ids, or presets. <types> is comma-separated.",
        example: "/subscribe dews,depeg usd-top25",
      },
      {
        command: "/subscribe <types> all",
        description:
          "Enable alert types across every tracked coin. safety all sends downgrades only and applies a 3-point filter when scored.",
        example: "/subscribe depeg,safety all",
      },
      {
        command: "/subscribe <targets> depeg-step <value>",
        description:
          "Enable depeg alerts, gate them by severity, and re-alert on each worsening milestone. <value> must be 100, 250, or 500 bps.",
        example: "/subscribe usd-top50 depeg-step 250",
      },
      {
        command: "/presets",
        description:
          "Browse preset watchlists (usd-top25, non-usd-top25, mcap-ge-1b, ...). Subscribing to a preset expands to its current member coins.",
        example: "/presets",
      },
    ],
  },
  {
    label: "Unsubscribe",
    commands: [
      {
        command: "/unsubscribe <targets>",
        description:
          "Remove coins by ticker, coin-id, or preset. Preset removal expands to its current member coins.",
        example: "/unsubscribe usd-top25",
      },
      {
        command: "/unsubscribe all",
        description:
          "Clear every per-coin, preset, and all-stablecoin subscription. Operational chat metadata can remain until inactive cleanup.",
        example: null,
      },
    ],
  },
  {
    label: "Tune",
    commands: [
      {
        command: "/set <ticker> <setting> <value>",
        description:
          "Tune one coin. <setting> is dews <band> (WARNING/ALERT/DANGER/off), depeg on|off, depeg-step <bps> (100/250/500), safety <mode> (downgrade-only/upgrade-only/all/off), launch on|off, reserve on|off, or freeze on|off.",
        example: "/set USDT dews WARNING",
      },
      {
        command: "/set all <setting> <value>",
        description:
          "Global toggle for dews, depeg, safety, launch, reserve, or freeze. safety globally supports all/off only (downgrades, 3-point filter when scored). depeg-step <bps> sets the global severity gate and worsening step.",
        example: "/set all depeg-step 250",
      },
      {
        command: "/mute <start>-<end>",
        description:
          "Set quiet hours (integer hours, 0–23) interpreted in the chat's /timezone (UTC if none is set). Notifications are silenced; messages still deliver. Use alert toggles or unsubscribes for all-day silence.",
        example: "/mute 22-07",
      },
      {
        command: "/timezone <IANA-zone>",
        description:
          "Set the chat's IANA timezone used to resolve /mute quiet hours locally (e.g. Europe/Paris, America/New_York). Sending /timezone with no argument shows the current zone and an inline keyboard of common zones.",
        example: "/timezone Europe/Paris",
      },
      {
        command: "/recap [on|off]",
        description:
          "Show, enable, or disable the private daily watchlist recap. Enabling requires a confirmed /timezone. A recap sends at most once per local day and only when watched assets materially changed.",
        example: "/recap on",
      },
      {
        command: "/recap time <hour>",
        description:
          "Set the recap delivery hour from 0 to 23 in your confirmed IANA timezone. Personalized recaps are private-chat only.",
        example: "/recap time 9",
      },
      {
        command: "/settings",
        description:
          "Open an inline-keyboard panel for chat-level settings (quiet hours, snooze clear, global DEWS/depeg/safety/launch/reserve/freeze toggles). Add a ticker (e.g. /settings USDC) to open the per-coin panel with DEWS floor, depeg step, safety mode, launch, reserve, and freeze toggles.",
        example: "/settings USDC",
      },
      {
        command: "/pause [off|1h|4h|24h]",
        description: "Pause all alerts indefinitely, resume with off, or apply a timed 1h, 4h, or 24h snooze.",
        example: "/pause 4h",
      },
      {
        command: "/unmutehours",
        description: "Disable quiet hours.",
        example: null,
      },
      {
        command: "/unsnooze",
        description: "Clear active alert snooze immediately.",
        example: null,
      },
    ],
  },
  {
    label: "Query",
    commands: [
      {
        command: "/status <ticker>",
        description:
          "Snapshot for one coin: price with age, supply, DEWS band, safety grade, active depeg, liquidity score with TVL, and 30d yield.",
        example: "/status USDC",
      },
      {
        command: "/brief",
        description:
          "Latest market brief: peg deviations, supply shifts, liquidity changes, and what changed overnight. /market is a deprecated compatibility alias.",
        example: "/brief",
      },
      {
        command: "/sample",
        description:
          "Private-chat-only preview of a synthetic USDC DEWS alert so you can inspect the alert format before subscribing.",
        example: "/sample",
      },
      {
        command: "/top <view>",
        description:
          "Rank current views. <view> is one of: depeg, dews, yield, liquidity, chains, safety.",
        example: "/top depeg",
      },
      {
        command: "/why <ticker>",
        description:
          "Plain-language breakdown of one coin's Safety Score: top weak dimensions and contributing report-card factors.",
        example: "/why USDC",
      },
      {
        command: "/coverage <ticker>",
        description:
          "List which Pharos modules cover one coin: price, DEWS, safety, liquidity, yield, mint/burn, reserves.",
        example: "/coverage USDC",
      },
    ],
  },
  {
    label: "Meta",
    commands: [
      {
        command: "/start",
        description: "Open the guided setup flow or process a supported Telegram deep-link payload.",
        example: "/start",
      },
      {
        command: "/list",
        description:
          "Audit your state: global alerts, dynamic preset follows, per-coin subscriptions with settings, quiet hours, and active snooze.",
        example: null,
      },
      {
        command: "/health",
        description:
          "Self-diagnostic for this chat: last successful delivery, queued alerts, quiet hours, snooze, and recent failure class.",
        example: null,
      },
      {
        command: "/cancel",
        description: "Cancel a pending ticker-selection prompt (when a symbol matches multiple coins).",
        example: null,
      },
      {
        command: "/help",
        description: "Show command reference.",
        example: null,
      },
      {
        command: "/forget",
        description:
          "Private-chat-only, two-step deletion of subscriber data, alert settings, quiet hours, snooze state, live delivery diagnostics, and chat-linked delivery audit rows.",
        example: null,
      },
      {
        command: "/export",
        description:
          "Create a portable watchlist token containing explicit follows, alert types, and followed presets. Quiet hours and snooze are excluded.",
        example: "/export",
      },
      {
        command: "/import <token>",
        description:
          "Validate a token from /export and stage its watchlist behind a confirmation. Group imports require an admin.",
        example: "/import eyJ2IjoxLC4uLn0",
      },
    ],
  },
] as const;

export const TELEGRAM_COMMAND_COUNT = TELEGRAM_COMMAND_GROUPS.reduce(
  (sum, group) => sum + group.commands.length,
  0,
);

export const TELEGRAM_PARAM_LEGEND = [
  { token: "<types>", meaning: `Comma-separated: ${TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS}` },
  { token: "<targets>", meaning: "Space-separated tickers, coin-ids, or presets" },
  { token: "<ticker>", meaning: "Symbol (USDC) or coin-id (usdc-circle)" },
  { token: "<value>", meaning: "Setting-specific; see the /set rows" },
  { token: "<view>", meaning: "depeg, dews, yield, liquidity, chains, safety" },
  { token: "<hour>", meaning: "Local delivery hour from 0 to 23 in the chat's confirmed /timezone" },
  { token: "<start>-<end>", meaning: "Integer hours, 0–23 (interpreted in the chat's /timezone; UTC by default)" },
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
      "Both work. Every alert family, preset, threshold, and daily recap setting is reachable through commands. There's also a Mini App you can open from the bot's menu button or via https://t.me/PharosWatchBot?startapp=home. It gives you a visual surface for the watchlist, settings, recap, snooze, and presets without typing slash commands. The Mini App and the bot share the same subscription state, so you can switch between them freely.",
  },
  {
    question: "How does the daily watchlist recap work?",
    answer:
      "The personalized recap is an optional private-chat summary of material changes in your own watchlist, separate from the market-wide Daily Digest channel. Set an IANA timezone with /timezone, then use /recap on and optionally /recap time <hour>. Pharos sends at most one recap per local day and sends nothing when your watched assets had no material changes. The same controls are available in the Mini App settings.",
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
  "Tickers are case-insensitive. Use the exact Pharos coin-id (e.g. usdc-circle) when a symbol is ambiguous.",
  "all is a reserved target for every tracked stablecoin. Launch and reserve alerts do not use preset watchlists; choose explicit tickers, coin-ids, or all.",
  "In Telegram groups, address commands to the bot: /subscribe@PharosWatchBot dews usd-top25. Pending ticker selections only complete for the user who started them.",
  "Typing / inside Telegram opens an inline command picker once the bot is registered.",
] as const;
