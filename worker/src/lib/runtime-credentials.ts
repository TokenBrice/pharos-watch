import type { Env } from "./env";
import type { TelegramCreds } from "./telegram";
import type { TwitterCreds } from "./twitter";

type TwitterCredentialEnv = Pick<
  Env,
  "TWITTER_API_KEY" | "TWITTER_API_SECRET" | "TWITTER_ACCESS_TOKEN" | "TWITTER_ACCESS_TOKEN_SECRET"
>;
type TelegramCredentialEnv = Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">;

function trimmed(value: string | undefined): string | undefined {
  const valueTrimmed = value?.trim();
  return valueTrimmed || undefined;
}

export function missingTwitterCredentialNames(env: TwitterCredentialEnv): string[] {
  const missing: string[] = [];
  if (!trimmed(env.TWITTER_API_KEY)) missing.push("TWITTER_API_KEY");
  if (!trimmed(env.TWITTER_API_SECRET)) missing.push("TWITTER_API_SECRET");
  if (!trimmed(env.TWITTER_ACCESS_TOKEN)) missing.push("TWITTER_ACCESS_TOKEN");
  if (!trimmed(env.TWITTER_ACCESS_TOKEN_SECRET)) missing.push("TWITTER_ACCESS_TOKEN_SECRET");
  return missing;
}

export function missingTelegramCredentialNames(env: TelegramCredentialEnv): string[] {
  const missing: string[] = [];
  if (!trimmed(env.TELEGRAM_BOT_TOKEN)) missing.push("TELEGRAM_BOT_TOKEN");
  if (!trimmed(env.TELEGRAM_CHAT_ID)) missing.push("TELEGRAM_CHAT_ID");
  return missing;
}

export function buildTwitterCreds(env: TwitterCredentialEnv): TwitterCreds | null {
  const apiKey = trimmed(env.TWITTER_API_KEY);
  const apiSecret = trimmed(env.TWITTER_API_SECRET);
  const accessToken = trimmed(env.TWITTER_ACCESS_TOKEN);
  const accessTokenSecret = trimmed(env.TWITTER_ACCESS_TOKEN_SECRET);
  return apiKey && apiSecret && accessToken && accessTokenSecret
    ? { apiKey, apiSecret, accessToken, accessTokenSecret }
    : null;
}

export function buildTelegramCreds(env: TelegramCredentialEnv): TelegramCreds | null {
  const botToken = trimmed(env.TELEGRAM_BOT_TOKEN);
  const chatId = trimmed(env.TELEGRAM_CHAT_ID);
  return botToken && chatId
    ? { botToken, chatId }
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
