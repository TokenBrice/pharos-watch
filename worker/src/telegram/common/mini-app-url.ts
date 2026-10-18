import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";

const TELEGRAM_MINI_APP_PATH = `/${TELEGRAM_BOT_USERNAME.toLowerCase()}/app/`;

export const TELEGRAM_MINI_APP_URL = new URL(TELEGRAM_MINI_APP_PATH, SITE_ORIGIN).toString();

export function buildTelegramMiniAppUrl(startParam?: string | null): string {
  const url = new URL(TELEGRAM_MINI_APP_URL);
  const trimmed = startParam?.trim();
  if (trimmed) {
    url.searchParams.set("startapp", trimmed);
  }
  return url.toString();
}
