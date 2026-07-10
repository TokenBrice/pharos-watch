import { Bell, MessageSquareText, ShieldCheck, type LucideIcon } from "lucide-react";
import type { FaqItem } from "@/lib/faq";

export const TELEGRAM_PAGE_DESCRIPTION =
  "PharosWatchBot sends stablecoin Telegram alerts for DEWS threat bands, depegs, reasoned safety-grade shifts, launches, and live reserve-mix drift.";

export const TELEGRAM_ACTIONS = [
  {
    key: "bot",
    title: "PharosWatchBot",
    handle: "@PharosWatchBot",
    href: "https://t.me/PharosWatchBot",
    description:
      "Per-coin or all-stablecoin alerts for DEWS changes, depegs, safety-grade moves with reason lines, launches, and live reserve-mix drift. Tune thresholds, set quiet hours, snooze on the fly.",
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
  { title: "Global alerts", detail: "DEWS, depeg, safety, launch, and reserve in one panel." },
  { title: "Per-coin tuning", detail: "DEWS bands, depeg steps, safety modes, and reserve switches." },
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
    src: "/featured/telegram-mini-app/home.png",
    alt: "PharosWatchBot Mini App home screen with watcher state, snooze controls, quiet hours, and last delivery",
    width: 583,
    height: 1280,
  },
  {
    title: "Watchlist",
    src: "/featured/telegram-mini-app/watchlist.png",
    alt: "PharosWatchBot Mini App watchlist screen with per-coin alert toggles",
    width: 583,
    height: 1280,
  },
  {
    title: "Presets",
    src: "/featured/telegram-mini-app/presets.png",
    alt: "PharosWatchBot Mini App presets screen with followed and available preset watchlists",
    width: 583,
    height: 1280,
  },
  {
    title: "Settings",
    src: "/featured/telegram-mini-app/settings.png",
    alt: "PharosWatchBot Mini App settings screen with global alerts, depeg step, and quiet hours",
    width: 583,
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

export const TELEGRAM_ALERT_EXAMPLES = [
  {
    key: "dews",
    label: "DEWS Threat Level",
    tagline:
      "Fires when a coin crosses into a worse band of DEWS, Pharos's Depeg Early Warning System. Shows the two highest-stress sub-signals.",
    content: `DEWS

USDT — WATCH → ALERT (score: 42)
Top signals: pool_balance_drift (61%), supply_velocity (48%)

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
    time: "09:41",
  },
  {
    key: "depeg",
    label: "Depeg Events",
    tagline: "Fires on depegs that meet your step (100/250/500 bps), worsening milestones, and resolution.",
    content: `Depeg Detected

USDC — below peg by 1.2% (120 bps)
Price: $0.988 (peg: $1.00)

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    time: "09:43",
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    tagline: "Fires on live grade shifts and points to the driver. Re-scores from methodology changes don't page you.",
    content: `Safety Grade Change

USDR — B → F
Score: 70 → 39

Reason: Active depeg peak 7546 bps capped the pre-variant Safety Score at F (39). Now: Safety F 39 · Liquidity 57, DEX TVL $1.2M · Supply $13.1M

View on Pharos: pharos.watch/stablecoin/usdr-tangible`,
    time: "09:45",
  },
  {
    key: "launch",
    label: "Launch Promotions",
    tagline: "Fires when a tracked pre-launch asset goes live. Must be subscribed by ticker; presets don't apply here.",
    content: `Stablecoin Launched

USDPT — US Dollar Payment Token has launched and is now tracked by Pharos

View on Pharos: pharos.watch/stablecoin/usdpt-western-union`,
    time: "09:47",
  },
  {
    key: "reserve",
    label: "Reserve Drift",
    tagline:
      "Fires when a live-reserve-tracked coin newly diverges from its curated reserve profile. Entering drift only.",
    content: `Reserve Drift

USDC — Circle USD Coin live reserve mix has drifted from its curated profile

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    time: "09:49",
  },
] as const;

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
          "Tune one coin. <setting> is dews <band> (WARNING/ALERT/DANGER/off), depeg on|off, depeg-step <bps> (100/250/500), safety <mode> (downgrade-only/upgrade-only/all/off), launch on|off, or reserve on|off.",
        example: "/set USDT dews WARNING",
      },
      {
        command: "/set all <setting> <value>",
        description:
          "Global toggle for dews, depeg, safety, launch, or reserve. safety globally supports all/off only (downgrades, 3-point filter when scored). depeg-step <bps> sets the global severity gate and worsening step.",
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
        command: "/settings",
        description:
          "Open an inline-keyboard panel for chat-level settings (quiet hours, snooze clear, global DEWS/depeg/safety/launch/reserve toggles). Add a ticker (e.g. /settings USDC) to open the per-coin panel with DEWS floor, depeg step, safety mode, launch, and reserve toggles.",
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
  { token: "<types>", meaning: "Comma-separated: dews, depeg, safety, launch, reserve" },
  { token: "<targets>", meaning: "Space-separated tickers, coin-ids, or presets" },
  { token: "<ticker>", meaning: "Symbol (USDC) or coin-id (usdc-circle)" },
  { token: "<value>", meaning: "Setting-specific; see the /set rows" },
  { token: "<view>", meaning: "depeg, dews, yield, liquidity, chains, safety" },
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
      "DEWS threat-level band crossings, depeg detections and worsening milestones, safety-grade changes with reason lines, pre-launch assets going live, and entering live reserve-mix drift.",
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
  "Tickers are case-insensitive. Use the exact Pharos coin-id (e.g. usdc-circle) when a symbol is ambiguous.",
  "all is a reserved target for every tracked stablecoin. Launch and reserve alerts do not use preset watchlists; choose explicit tickers, coin-ids, or all.",
  "In Telegram groups, address commands to the bot: /subscribe@PharosWatchBot dews usd-top25. Pending ticker selections only complete for the user who started them.",
  "Typing / inside Telegram opens an inline command picker once the bot is registered.",
] as const;
