import {
  TELEGRAM_MINI_APP_PAYLOAD_PATTERN,
  TELEGRAM_START_PAYLOAD_MAX_LENGTH,
} from "@shared/lib/telegram-mini-app-payloads";
import {
  telegramAdoptionEntryForPlacement,
  type TelegramAdoptionCatalogPlacement,
} from "@shared/lib/telegram-adoption-analytics";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";

export const PHAROSWATCHBOT_BOT_URL = TELEGRAM_BOT_URL;

export const RECOMMENDED_SETUP = {
  alertTypes: ["dews", "depeg"],
  presetId: "usd-top25",
} as const;

export const RECOMMENDED_SETUP_COMMAND = `/subscribe ${RECOMMENDED_SETUP.alertTypes.join(",")} ${RECOMMENDED_SETUP.presetId}`;

type SubscribeStartPayloadInput = {
  alertTypes: readonly string[];
  presetId: string;
};

function assertTelegramStartPayload(payload: string): string {
  if (payload.length > TELEGRAM_START_PAYLOAD_MAX_LENGTH || !TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(payload)) {
    throw new Error(`Invalid Telegram start payload: ${payload}`);
  }
  return payload;
}

function buildTelegramBotStartDeepLink(payload: string): string {
  const url = new URL(PHAROSWATCHBOT_BOT_URL);
  url.searchParams.set("start", assertTelegramStartPayload(payload));
  return url.toString();
}

function buildTelegramMiniAppDeepLink(payload: string): string {
  if (!TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(payload)) {
    throw new Error(`Invalid Telegram Mini App payload: ${payload}`);
  }
  const url = new URL(PHAROSWATCHBOT_BOT_URL);
  url.searchParams.set("startapp", payload);
  return url.toString();
}

export function buildTelegramAdoptionDeepLink(placement: TelegramAdoptionCatalogPlacement): string {
  const entry = telegramAdoptionEntryForPlacement(placement);
  return entry.destination === "setup"
    ? buildTelegramBotStartDeepLink(entry.token)
    : buildTelegramMiniAppDeepLink(entry.token);
}

export function buildSubscribeStartPayload(setup: SubscribeStartPayloadInput): string {
  return assertTelegramStartPayload(`sub_${setup.alertTypes.join("-")}_${setup.presetId}`);
}

export const SETUP_DEEP_LINK = buildTelegramAdoptionDeepLink("hero");
export const RECOMMENDED_SETUP_START_PAYLOAD = buildSubscribeStartPayload(RECOMMENDED_SETUP);
export const RECOMMENDED_SETUP_DEEP_LINK = buildTelegramBotStartDeepLink(RECOMMENDED_SETUP_START_PAYLOAD);
export const MINI_APP_SETUP_DEEP_LINK = buildTelegramAdoptionDeepLink("miniapp_setup");
export const MINI_APP_HOME_DEEP_LINK = buildTelegramAdoptionDeepLink("miniapp_home");
export const MINI_APP_WATCHLIST_DEEP_LINK = buildTelegramAdoptionDeepLink("miniapp_watchlist");
