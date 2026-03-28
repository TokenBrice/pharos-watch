import { setCache, shouldSkipFreshCache } from "./db-cache";

const DEFAULT_SELF_URL = "https://api.pharos.watch";
const TELEGRAM_WEBHOOK_PATH = "/api/telegram-webhook";
const TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY = "telegram:webhook-reconciled";
const TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC = 15 * 60;

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
    return new URL(TELEGRAM_WEBHOOK_PATH, selfUrl ?? DEFAULT_SELF_URL).toString();
  } catch {
    return new URL(TELEGRAM_WEBHOOK_PATH, DEFAULT_SELF_URL).toString();
  }
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

  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token", expectedUrl };
  }
  if (!webhookSecret) {
    return { attempted: false, skipped: true, reason: "missing-webhook-secret", expectedUrl };
  }
  if (await shouldSkipFreshCache(db, TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY, TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC)) {
    return { attempted: false, skipped: true, reason: "fresh-cache", expectedUrl };
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: expectedUrl,
      secret_token: webhookSecret,
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

  await setCache(db, TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY, JSON.stringify({ url: expectedUrl }));
  return { attempted: true, skipped: false, expectedUrl };
}

