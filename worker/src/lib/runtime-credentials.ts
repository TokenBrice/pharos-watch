import type { Env } from "./env";
import type { TelegramCreds } from "./telegram";

export function buildTelegramCreds(env: Env): TelegramCreds | null {
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? {
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
      }
    : null;
}
