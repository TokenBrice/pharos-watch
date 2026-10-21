import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_FAMILY_PHRASE_LIST,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { RECOMMENDED_SETUP_COMMAND } from "@/lib/telegram-route-constants";
import { DAILY_CHANGES_TIME, DAILY_LIVE_ALERT_CAP } from "./telegram-content";

const TELEGRAM_HOW_TO_STEPS = [
  {
    position: 1,
    name: "Open @PharosWatchBot",
    text: "Open @PharosWatchBot in Telegram and send /start.",
  },
  {
    position: 2,
    name: "Follow the top 25 USD stablecoins",
    text: `Tap "Follow the top 25 USD stablecoins" to get depeg and stress alerts for the 25 largest USD stablecoins, or send ${RECOMMENDED_SETUP_COMMAND}.`,
  },
  {
    position: 3,
    name: "Adjust in Manage Alerts",
    text: "Tap Manage Alerts to add or remove coins, set quiet hours, or pause. Send /list to see what you follow.",
  },
] as const;

// One feature line per canonical alert family, then the non-alert features.
const TELEGRAM_FEATURE_LIST = [
  ...TELEGRAM_ALERT_FAMILIES.map((family) => family.featureLine),
  `Daily Changes message at ${DAILY_CHANGES_TIME} local time for smaller moves`,
  `Quiet by default: at most ${DAILY_LIVE_ALERT_CAP} live alerts a day outside depegs`,
  "Mute 24h, Pause all 4h and Fewer like this buttons on every alert",
  "Preset watchlists that keep tracking current cohorts",
  "Timezone-aware quiet hours and pause",
  "Telegram Mini App for coins, quiet hours and delivery status",
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
