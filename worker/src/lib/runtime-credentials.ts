import type { Env } from "./env";
import type { TelegramCreds } from "./telegram";
import type { TwitterCreds } from "./twitter";

export function buildTwitterCreds(env: Env): TwitterCreds | null {
  return env.TWITTER_API_KEY &&
    env.TWITTER_API_SECRET &&
    env.TWITTER_ACCESS_TOKEN &&
    env.TWITTER_ACCESS_TOKEN_SECRET
    ? {
        apiKey: env.TWITTER_API_KEY,
        apiSecret: env.TWITTER_API_SECRET,
        accessToken: env.TWITTER_ACCESS_TOKEN,
        accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET,
      }
    : null;
}

export function buildTelegramCreds(env: Env): TelegramCreds | null {
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? {
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
      }
    : null;
}

/**
 * Destination for operator-only alerts (cron freshness watchdog). Deliberately
 * separate from `buildTelegramCreds`: watchdog transitions are ops signal, not
 * audience content, so they must never reach the public digest channel. With
 * `TELEGRAM_OPERATOR_CHAT_ID` unset the alert is suppressed rather than
 * falling back to `TELEGRAM_CHAT_ID`.
 */
export function buildTelegramOperatorCreds(env: Env): TelegramCreds | null {
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OPERATOR_CHAT_ID
    ? {
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_OPERATOR_CHAT_ID,
      }
    : null;
}
