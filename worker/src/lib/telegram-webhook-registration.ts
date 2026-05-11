import { API_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";
import { getCache, setCache } from "./db-cache";

const DEFAULT_SELF_URL = API_ORIGIN;
const TELEGRAM_WEBHOOK_PATH = "/api/telegram-webhook";
const TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY = "telegram:webhook-reconciled";
const TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;
const TELEGRAM_WEBHOOK_CACHE_VERSION = 2;

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

export interface ReconcileTelegramWebhookResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "missing-webhook-secret" | "fresh-cache";
  expectedUrl: string | null;
}

export function buildTelegramWebhookUrl(selfUrl?: string | null): string {
  try {
    return new URL(TELEGRAM_WEBHOOK_PATH, resolveOrigin(selfUrl, DEFAULT_SELF_URL)).toString();
  } catch {
    return new URL(TELEGRAM_WEBHOOK_PATH, DEFAULT_SELF_URL).toString();
  }
}

function buildExpectedWebhookCacheValue(expectedUrl: string): string {
  return JSON.stringify({
    version: TELEGRAM_WEBHOOK_CACHE_VERSION,
    url: expectedUrl,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    secret_token: {
      present: true,
      marker: "v1",
    },
  });
}

async function shouldSkipFreshMatchingWebhookCache(db: D1Database, expectedValue: string): Promise<boolean> {
  const cached = await getCache(db, TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY);
  if (!cached) return false;
  if (Date.now() / 1000 - cached.updatedAt >= TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC) return false;
  return cached.value === expectedValue;
}

export async function reconcileTelegramWebhookRegistration(
  db: D1Database,
  options: {
    botToken?: string | null;
    webhookSecret?: string | null;
    selfUrl?: string | null;
  },
): Promise<ReconcileTelegramWebhookResult> {
  const botToken = options.botToken?.trim();
  const webhookSecret = options.webhookSecret?.trim();
  const expectedUrl = buildTelegramWebhookUrl(options.selfUrl);
  const expectedCacheValue = buildExpectedWebhookCacheValue(expectedUrl);

  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token", expectedUrl };
  }
  if (!webhookSecret) {
    return { attempted: false, skipped: true, reason: "missing-webhook-secret", expectedUrl };
  }
  if (await shouldSkipFreshMatchingWebhookCache(db, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache", expectedUrl };
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: expectedUrl,
      secret_token: webhookSecret,
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram setWebhook HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  if (parsed?.ok !== true) {
    throw new Error(`Telegram setWebhook rejected registration: ${(parsed?.description ?? responseText).slice(0, 300)}`);
  }

  await setCache(db, TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false, expectedUrl };
}
