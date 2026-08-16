import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_FAMILY_PHRASE_LIST,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { RECOMMENDED_SETUP_COMMAND } from "@/lib/telegram-route-constants";

const TELEGRAM_HOW_TO_STEPS = [
  {
    position: 1,
    name: "Open @PharosWatchBot",
    text: "Open @PharosWatchBot in Telegram and send /start.",
  },
  {
    position: 2,
    name: "Subscribe and tune",
    text: `Subscribe and tune with commands like ${RECOMMENDED_SETUP_COMMAND}, /presets, /set USDT dews WARNING, and /mute 22-07.`,
  },
  {
    position: 3,
    name: "Review active subscriptions",
    text: "Alerts arrive automatically when conditions change. Use /list to check active subscriptions and /presets to discover preset watchlists from inside Telegram.",
  },
] as const;

// One feature line per canonical alert family, then the non-alert features.
const TELEGRAM_FEATURE_LIST = [
  ...TELEGRAM_ALERT_FAMILIES.map((family) => family.featureLine),
  "On-demand market brief, top rankings, Safety Score explanations, and coverage checks",
  "Dynamic preset watchlists that keep tracking current cohorts",
  "Per-coin thresholds, timezone-aware quiet hours, and inline snooze",
  "Telegram Mini App for visual watchlist, settings, and presets management",
] as const;

export function buildTelegramPageJsonLd(siteUrl: string) {
  const gettingStartedUrl = `${siteUrl}/pharoswatchbot/#getting-started`;

  return [
    {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "Set up Pharos stablecoin alerts on Telegram",
      description: `Subscribe to Telegram alerts covering ${TELEGRAM_ALERT_FAMILY_PHRASE_LIST} for tracked stablecoins from the Pharos Telegram bot.`,
      totalTime: "PT2M",
      tool: [{ "@type": "HowToTool", name: "Telegram" }],
      step: TELEGRAM_HOW_TO_STEPS.map((step) => ({
        "@type": "HowToStep",
        ...step,
        url: gettingStartedUrl,
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "PharosWatchBot",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Telegram",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      url: `${siteUrl}/pharoswatchbot/`,
      installUrl: TELEGRAM_BOT_URL,
      description: `Opt-in Telegram bot for stablecoin alerts: ${TELEGRAM_ALERT_FAMILY_PHRASE_LIST}.`,
      featureList: TELEGRAM_FEATURE_LIST,
      publisher: { "@id": `${siteUrl}#organization` },
    },
  ];
}
