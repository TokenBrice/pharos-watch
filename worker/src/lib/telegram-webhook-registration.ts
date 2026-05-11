import { API_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";
import { getCache, setCache } from "./db-cache";

const DEFAULT_SELF_URL = API_ORIGIN;
const TELEGRAM_WEBHOOK_PATH = "/api/telegram-webhook";
const TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY = "telegram:webhook-reconciled";
const TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY = "telegram:commands-reconciled";
const TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_COMMANDS_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;
const TELEGRAM_WEBHOOK_CACHE_VERSION = 2;
const TELEGRAM_COMMANDS_CACHE_VERSION = 1;

export const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Get started with Pharos alerts" },
  { command: "help", description: "Command reference" },
  { command: "status", description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)" },
  { command: "brief", description: "Latest Pharos market brief" },
  { command: "top", description: "Rank current views: depeg, dews, yield, liquidity, chains, safety" },
  { command: "why", description: "Explain one coin Safety Score (e.g. /why USDC)" },
  { command: "coverage", description: "Show which Pharos data surfaces cover one coin" },
  { command: "list", description: "Show your current subscriptions and settings" },
  { command: "subscribe", description: "Subscribe to alerts (e.g. /subscribe usd-top-50 depeg-step 250)" },
  { command: "unsubscribe", description: "Remove coin subscriptions" },
  { command: "presets", description: "Browse preset watchlists like usd-top25 / usd-top-25" },
  { command: "set", description: "Tune per-coin or global thresholds (e.g. /set all depeg-step 250)" },
  { command: "mute", description: "Enable quiet hours in UTC (e.g. /mute 22-07)" },
  { command: "unsnooze", description: "Clear active alert snooze" },
  { command: "unmutehours", description: "Disable quiet hours" },
  { command: "cancel", description: "Cancel a pending ticker selection" },
] as const;

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

export interface ReconcileTelegramCommandResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "fresh-cache";
}

export function buildTelegramWebhookUrl(selfUrl?: string | null): string {
  try {
    return new URL(TELEGRAM_WEBHOOK_PATH, resolveOrigin(selfUrl, DEFAULT_SELF_URL)).toString();
  } catch {
    return new URL(TELEGRAM_WEBHOOK_PATH, DEFAULT_SELF_URL).toString();
  }
}

async function buildSecretTokenMarker(webhookSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(webhookSecret));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function buildExpectedWebhookCacheValue(expectedUrl: string, webhookSecret: string): Promise<string> {
  return JSON.stringify({
    version: TELEGRAM_WEBHOOK_CACHE_VERSION,
    url: expectedUrl,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    secret_token: {
      present: true,
      marker: await buildSecretTokenMarker(webhookSecret),
    },
  });
}

function buildExpectedCommandsCacheValue(): string {
  return JSON.stringify({
    version: TELEGRAM_COMMANDS_CACHE_VERSION,
    commands: TELEGRAM_BOT_COMMANDS,
  });
}

async function shouldSkipFreshMatchingWebhookCache(db: D1Database, expectedValue: string): Promise<boolean> {
  const cached = await getCache(db, TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY);
  if (!cached) return false;
  if (Date.now() / 1000 - cached.updatedAt >= TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC) return false;
  return cached.value === expectedValue;
}

async function shouldSkipFreshMatchingCommandCache(db: D1Database, expectedValue: string): Promise<boolean> {
  const cached = await getCache(db, TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY);
  if (!cached) return false;
  if (Date.now() / 1000 - cached.updatedAt >= TELEGRAM_COMMANDS_RECONCILE_TTL_SEC) return false;
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

  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token", expectedUrl };
  }
  if (!webhookSecret) {
    return { attempted: false, skipped: true, reason: "missing-webhook-secret", expectedUrl };
  }
  const expectedCacheValue = await buildExpectedWebhookCacheValue(expectedUrl, webhookSecret);
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

export async function reconcileTelegramCommandRegistration(
  db: D1Database,
  options: {
    botToken?: string | null;
  },
): Promise<ReconcileTelegramCommandResult> {
  const botToken = options.botToken?.trim();
  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token" };
  }

  const expectedCacheValue = buildExpectedCommandsCacheValue();
  if (await shouldSkipFreshMatchingCommandCache(db, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache" };
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: TELEGRAM_BOT_COMMANDS,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram setMyCommands HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  if (parsed?.ok !== true) {
    throw new Error(`Telegram setMyCommands rejected registration: ${(parsed?.description ?? responseText).slice(0, 300)}`);
  }

  await setCache(db, TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false };
}
