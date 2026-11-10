import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_FAMILY_PHRASE_LIST,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { DAILY_CHANGES_TIME, DAILY_LIVE_ALERT_CAP } from "./telegram-content";

// One feature line per canonical alert family, then the non-alert features.
const TELEGRAM_FEATURE_LIST = [
  ...TELEGRAM_ALERT_FAMILIES.map((family) => family.featureLine),
  `Daily Changes message for smaller moves at ${DAILY_CHANGES_TIME} UTC unless you set a time zone`,
  `Quiet by default: at most ${DAILY_LIVE_ALERT_CAP} live alerts a day outside depegs`,
  "Mute 24h, Pause all 4h and Fewer like this buttons on every alert",
  "Preset watchlists that keep tracking current cohorts",
  "Timezone-aware quiet hours and pause",
  "Telegram Mini App for coins, quiet hours and delivery status",
] as const;

/**
 * HowTo is not emitted: Google retired HowTo rich results, and the visible
 * "How it works" steps carry the setup instructions.
 */
export function buildTelegramPageJsonLd(siteUrl: string) {
  return [
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
