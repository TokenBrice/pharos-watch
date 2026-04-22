import type { FaqItem } from "@/lib/faq";

export const TELEGRAM_PAGE_DESCRIPTION =
  "Set up Telegram alerts for specific stablecoins, preset watchlists, or all tracked stablecoins by alert type: depeg events, depeg worsening, DEWS threat level changes, safety grade shifts, and launch promotions for pre-launch assets. Plus get the Pharos digest straight in Telegram.";

export const TELEGRAM_ACTIONS = [
  {
    key: "bot",
    title: "Alert Bot",
    handle: "@PharosWatchBot",
    href: "https://t.me/PharosWatchBot",
    description:
      "Per-coin or all-stablecoin alerts for DEWS changes, depegs, safety-grade moves, and launch promotions for pre-launch assets. Configurable thresholds and quiet hours.",
    heroButtonLabel: "Start PharosWatchBot",
    cardButtonLabel: "Start Bot",
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
      "AI-written daily market recap every morning \u2014 peg deviations, supply shifts, liquidity changes, and emerging trends.",
    heroButtonLabel: "Daily Digest",
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
      "The live crowd \u2014 readers swapping notes on fresh depegs, risk signals, and the market moves worth watching before the next digest lands.",
    heroButtonLabel: "Community",
    cardButtonLabel: "Join Community",
    finalButtonLabel: "Community",
    showArchiveLink: false,
    isPrimary: false,
  },
] as const;

export type TelegramActionKey = (typeof TELEGRAM_ACTIONS)[number]["key"];

export const TELEGRAM_ALERT_EXAMPLES = [
  {
    key: "dews",
    label: "DEWS Threat Level",
    tagline: "band boundary crossings with top stress sub-signals",
    content: `DEWS

USDT \u2014 WATCH \u2192 ALERT (score: 42)
Top signals: pool_balance_drift (0.61), supply_velocity (0.48)

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
    time: "09:41",
  },
  {
    key: "depeg",
    label: "Depeg Events",
    tagline: "trigger, worsening milestones, and resolution with price context",
    content: `Depeg Detected

USDC \u2014 below peg by 1.2% (120 bps)
Price: $0.988 (peg: $1.00)

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    time: "09:43",
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    tagline: "live report-card grade shifts, with methodology-only regrades suppressed",
    content: `Safety Grade Change

DAI \u2014 A- \u2192 B+
Score: 71 \u2192 66

View on Pharos: pharos.watch/stablecoin/dai-makerdao`,
    time: "09:45",
  },
  {
    key: "launch",
    label: "Launch Promotions",
    tagline: "pre-launch assets moving live on Pharos, with presets intentionally excluded",
    content: `Stablecoin Launched

USDPT \u2014 US Dollar Payment Token has launched and is now tracked by Pharos

View on Pharos: pharos.watch/stablecoin/usdpt-western-union`,
    time: "09:47",
  },
] as const;

export const TELEGRAM_COMMANDS = [
  {
    command: "/subscribe <types> all",
    description:
      "Enable alert types across all tracked stablecoins; safety all sends downgrades only and needs a 3-point score drop when scored",
    example: "/subscribe depeg,safety all",
  },
  {
    command: "/subscribe <types> <targets>",
    description: "Enable alert types for coins or preset watchlists",
    example: "/subscribe dews,depeg USDT,USDC",
  },
  {
    command: "/status <ticker>",
    description: "Current peg, DEWS band, and safety grade for one coin \u2014 no subscription needed",
    example: "/status USDC",
  },
  {
    command: "/presets",
    description: "Show preset watchlists like usd-top25 or mcap-ge-1b",
    example: "/presets",
  },
  {
    command: "/unsubscribe <targets>",
    description: "Remove specific coin subscriptions or preset-expanded coins",
    example: "/unsubscribe usd-top25",
  },
  {
    command: "/unsubscribe all",
    description: "Clear all per-coin and all-stablecoin subscriptions",
    example: null,
  },
  {
    command: "/set <ticker> <setting> <value>",
    description:
      "DEWS floor (WARNING/DANGER), safety direction (downgrade-only/upgrade-only), or depeg-step (100/250/500 bps)",
    example: "/set USDT dews WARNING",
  },
  {
    command: "/set all <setting> <value>",
    description: "Toggle dews, depeg, or safety across every tracked coin",
    example: "/set all depeg off",
  },
  {
    command: "/mute <start>-<end>",
    description: "Silence Telegram notifications during UTC quiet hours",
    example: "/mute 22-07",
  },
  {
    command: "/unmutehours",
    description: "Disable quiet hours",
    example: null,
  },
  {
    command: "/list",
    description: "Show global alerts, subscribed coins, settings, and quiet hours",
    example: null,
  },
  {
    command: "/cancel",
    description: "Cancel a pending disambiguation prompt",
    example: null,
  },
  {
    command: "/help",
    description: "Show command reference",
    example: null,
  },
] as const;

export const TELEGRAM_FAQ: FaqItem[] = [
  {
    question: "What alerts does Pharos send on Telegram?",
    answer:
      "DEWS threat-level band crossings, depeg detections and worsening milestones, safety-grade changes, and launch promotions for pre-launch assets when they go live.",
  },
  {
    question: "Can I get alerts for all tracked stablecoins at once?",
    answer:
      "Yes. Send /subscribe <type> all, for example /subscribe depeg all, to subscribe to an alert type across every tracked stablecoin. For safety, the all-stablecoin tier is intentionally narrower: it sends downgrades only and applies a 3-point filter when scores are present.",
  },
  {
    question: "How do I silence Telegram notifications during certain hours?",
    answer:
      "Use /mute <start>-<end> with UTC hours. For example, /mute 22-07 silences alerts between 10pm and 7am UTC. Use /unmutehours to disable quiet hours.",
  },
  {
    question: "What are preset watchlists?",
    answer:
      "Presets are curated coin lists like usd-top25 or mcap-ge-1b. Subscribing to a preset expands to the current list of coins it contains. Send /presets in Telegram to browse them interactively.",
  },
  {
    question: "How do I unsubscribe?",
    answer:
      "Send /unsubscribe <targets> to remove specific coin subscriptions, or /unsubscribe all to clear every subscription and disable all alert flags.",
  },
];

export const TELEGRAM_HOW_IT_WORKS_CARDS = [
  {
    title: "Cadence",
    description:
      "The dispatcher runs every 5 minutes. DEWS and depeg alerts arrive within one cycle. Safety alerts are diffed against the live report-card publish path, and launch alerts fire within 5 minutes of a pre-launch asset going live.",
    unsubscribeCommand: null,
    descriptionAfterCommand: null,
  },
  {
    title: "Volume",
    description:
      "Expect zero alerts on a calm day, a handful during volatility. Repeated transitions to the same DEWS band are deduped against the last alertable snapshot, so you are not paged twice for the same state. Every alert includes snooze buttons (1h / 4h / 24h).",
    unsubscribeCommand: null,
    descriptionAfterCommand: null,
  },
  {
    title: "Privacy",
    description:
      "We store your Telegram chat ID, optional username, followed coins, alert settings, quiet hours, snooze state, and short-lived command/alert queue metadata.",
    unsubscribeCommand: "/unsubscribe all",
    descriptionAfterCommand: "at any time to remove coin subscriptions and disable alert flags.",
  },
] as const;

export const TELEGRAM_GETTING_STARTED_OPTIONS = [
  {
    command: "/subscribe dews,depeg USDT,USDC",
    description: "Per-coin alerts for specific stablecoins",
  },
  {
    command: "/presets",
    description: "Browse preset watchlists directly inside the bot",
  },
  {
    command: "/subscribe dews usd-top25",
    description: "Follow the current top USD stablecoins without listing them one by one",
  },
  {
    command: "/subscribe safety mcap-ge-1b",
    description: "Track every active stablecoin above the chosen market-cap floor",
  },
  {
    command: "/subscribe safety all",
    description:
      "Global safety watchtower for downgrades across all tracked stablecoins, with a 3-point filter when scores are present",
  },
  {
    command: "/subscribe launch USDPT",
    description: "Launch alerts for explicit pre-launch tickers or coin IDs",
  },
  {
    command: "/set USDT dews WARNING",
    description: "Only alert when DEWS reaches WARNING or DANGER",
  },
  {
    command: "/set DAI safety downgrade-only",
    description: "Silence upgrades; fire only on safety-grade regressions",
  },
  {
    command: "/set USDC depeg-step 250",
    description: "Worsening-depeg milestones every 250 bps",
  },
  {
    command: "/mute 22-07",
    description: "Quiet hours overnight (UTC)",
  },
] as const;

export const TELEGRAM_COMMAND_REFERENCE_NOTE = {
  beforeAll:
    "Ticker matching is case-insensitive. Exact Pharos coin IDs also work, which is useful when a ticker is ambiguous. Use",
  afterAll:
    "to follow an alert type across every tracked stablecoin. Launch alerts still require explicit tickers or coin IDs and do not support presets. Unknown tickers get a closest-match suggestion when possible.",
} as const;
