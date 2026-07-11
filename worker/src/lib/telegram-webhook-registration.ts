import { API_ORIGIN, SITE_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";
import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_BOT_NAME,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
  TELEGRAM_BOT_USERNAME,
} from "@shared/lib/telegram-bot-registration";
import { getTelegramPrivateBotCommands } from "@shared/lib/telegram-bot-registration";
import { getCache, setCache } from "./db-cache";
import { sha256Hex } from "./hash";
import { postTelegramBotApi } from "./telegram";

export {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_BOT_NAME,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
} from "@shared/lib/telegram-bot-registration";

const DEFAULT_SELF_URL = API_ORIGIN;
const TELEGRAM_WEBHOOK_PATH = "/api/telegram-webhook";
const TELEGRAM_MINI_APP_PATH = `/${TELEGRAM_BOT_USERNAME.toLowerCase()}/app/`;
const TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY = "telegram:webhook-reconciled";
const TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY = "telegram:commands-reconciled";
const TELEGRAM_PROFILE_RECONCILED_CACHE_KEY = "telegram:profile-reconciled";
const TELEGRAM_MENU_RECONCILED_CACHE_KEY = "telegram:menu-reconciled";
const TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_COMMANDS_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_PROFILE_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_MENU_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_RATE_LIMIT_CACHE_KEY_PREFIX = "telegram:reconcile:429:";
const TELEGRAM_RATE_LIMIT_DEFAULT_RETRY_AFTER_SEC = 60;
const TELEGRAM_WEBHOOK_CACHE_VERSION = 2;
const TELEGRAM_COMMANDS_CACHE_VERSION = 8;
const TELEGRAM_PROFILE_CACHE_VERSION = 3;
const TELEGRAM_MENU_CACHE_VERSION = 1;

export const TELEGRAM_MINI_APP_URL = new URL(TELEGRAM_MINI_APP_PATH, SITE_ORIGIN).toString();
export const TELEGRAM_MINI_APP_BUTTON_TEXT = "Manage Alerts";

export function buildTelegramMiniAppUrl(startParam?: string | null): string {
  const url = new URL(TELEGRAM_MINI_APP_URL);
  const trimmed = startParam?.trim();
  if (trimmed) {
    url.searchParams.set("startapp", trimmed);
  }
  return url.toString();
}

const TELEGRAM_PRIVATE_COMMAND_SCOPE = { type: "all_private_chats" } as const;
const TELEGRAM_GROUP_COMMAND_SCOPE = { type: "all_group_chats" } as const;

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface TelegramChatMenuButtonResponse extends TelegramApiResponse {
  result?: unknown;
}

export interface ReconcileTelegramWebhookResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "missing-webhook-secret" | "fresh-cache" | "rate-limited";
  expectedUrl: string | null;
}

export interface ReconcileTelegramCommandResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "fresh-cache" | "rate-limited";
}

export interface ReconcileTelegramProfileResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "fresh-cache" | "rate-limited";
}

export interface ReconcileTelegramMenuButtonResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "fresh-cache" | "already-current" | "rate-limited";
  miniAppUrl: string;
}

export function buildTelegramWebhookUrl(selfUrl?: string | null): string {
  try {
    return new URL(TELEGRAM_WEBHOOK_PATH, resolveOrigin(selfUrl, DEFAULT_SELF_URL)).toString();
  } catch {
    return new URL(TELEGRAM_WEBHOOK_PATH, DEFAULT_SELF_URL).toString();
  }
}

async function buildSecretTokenMarker(webhookSecret: string): Promise<string> {
  return (await sha256Hex(webhookSecret)).slice(0, 32);
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

function buildExpectedCommandsCacheValue(includeRecap: boolean): string {
  return JSON.stringify({
    version: TELEGRAM_COMMANDS_CACHE_VERSION + (includeRecap ? 0 : 1),
    scopes: {
      all_private_chats: getTelegramPrivateBotCommands(includeRecap),
      all_group_chats: TELEGRAM_BOT_GROUP_COMMANDS,
    },
  });
}

function buildExpectedProfileCacheValue(): string {
  return JSON.stringify({
    version: TELEGRAM_PROFILE_CACHE_VERSION,
    name: TELEGRAM_BOT_NAME,
    short_description: TELEGRAM_BOT_SHORT_DESCRIPTION,
    description: TELEGRAM_BOT_DESCRIPTION,
  });
}

function buildTelegramMenuButton(miniAppUrl = TELEGRAM_MINI_APP_URL): {
  type: "web_app";
  text: string;
  web_app: { url: string };
} {
  return {
    type: "web_app",
    text: TELEGRAM_MINI_APP_BUTTON_TEXT,
    web_app: { url: miniAppUrl },
  };
}

function buildExpectedMenuCacheValue(miniAppUrl = TELEGRAM_MINI_APP_URL): string {
  return JSON.stringify({
    version: TELEGRAM_MENU_CACHE_VERSION,
    menu_button: buildTelegramMenuButton(miniAppUrl),
  });
}

async function shouldSkipFreshMatchingCache(
  db: D1Database,
  key: string,
  ttlSec: number,
  expectedValue: string,
): Promise<boolean> {
  const cached = await getCache(db, key);
  if (!cached) return false;
  if (Date.now() / 1000 - cached.updatedAt >= ttlSec) return false;
  return cached.value === expectedValue;
}

function rateLimitCacheKey(endpoint: string): string {
  return `${TELEGRAM_RATE_LIMIT_CACHE_KEY_PREFIX}${endpoint}`;
}

async function isRateLimited(db: D1Database, endpoint: string): Promise<boolean> {
  const cached = await getCache(db, rateLimitCacheKey(endpoint));
  if (!cached) return false;
  const retryAfter = Number.parseInt(cached.value, 10);
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) return false;
  const ageSec = Date.now() / 1000 - cached.updatedAt;
  return ageSec < retryAfter;
}

async function recordRateLimit(db: D1Database, endpoint: string, retryAfter: number): Promise<void> {
  const seconds = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.ceil(retryAfter)
    : TELEGRAM_RATE_LIMIT_DEFAULT_RETRY_AFTER_SEC;
  await setCache(db, rateLimitCacheKey(endpoint), String(seconds));
  console.warn(
    `[telegram-reconcile] ${endpoint} rate-limited by Bot API; backing off for ${seconds}s`,
  );
}

function extractRetryAfter(
  response: Response,
  parsed: TelegramApiResponse | null,
): number | null {
  if (response.status === 429 || parsed?.error_code === 429) {
    const value = parsed?.parameters?.retry_after;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    return TELEGRAM_RATE_LIMIT_DEFAULT_RETRY_AFTER_SEC;
  }
  return null;
}

// Telegram returns 400 "Bad Request: <field> is not modified" when the
// submitted value matches the current value. That's the documented idempotent
// success path; treat it like ok=true so we still update the cache marker.
function isNotModifiedDescription(description: string | null | undefined): boolean {
  if (!description) return false;
  return /is not modified/i.test(description);
}

async function applyProfileField(
  db: D1Database,
  botToken: string,
  method: "setMyName" | "setMyDescription" | "setMyShortDescription",
  payload: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ throttled: boolean }> {
  if (await isRateLimited(db, method)) {
    return { throttled: true };
  }

  const response = await postTelegramBotApi(botToken, method, payload, { signal });

  const responseText = await response.text();
  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  const retryAfter = extractRetryAfter(response, parsed);
  if (retryAfter !== null) {
    await recordRateLimit(db, method, retryAfter);
    return { throttled: true };
  }

  if (parsed?.ok === true) return { throttled: false };
  if (isNotModifiedDescription(parsed?.description)) return { throttled: false };

  if (!response.ok) {
    throw new Error(`Telegram ${method} HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }
  throw new Error(`Telegram ${method} rejected registration: ${(parsed?.description ?? responseText).slice(0, 300)}`);
}

async function fetchTelegramMenuButton(botToken: string, signal?: AbortSignal): Promise<unknown | null> {
  const response = await postTelegramBotApi(botToken, "getChatMenuButton", {}, { signal });
  const responseText = await response.text();
  let parsed: TelegramChatMenuButtonResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramChatMenuButtonResponse;
  } catch {
    parsed = null;
  }
  if (parsed?.ok === true) return parsed.result ?? null;
  if (!response.ok) throw new Error(`Telegram getChatMenuButton HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  throw new Error(`Telegram getChatMenuButton rejected reconciliation: ${(parsed?.description ?? responseText).slice(0, 300)}`);
}

function menuButtonMatches(current: unknown, miniAppUrl: string): boolean {
  if (!current || typeof current !== "object") return false;
  const record = current as Record<string, unknown>;
  const webApp = record.web_app;
  return record.type === "web_app"
    && record.text === TELEGRAM_MINI_APP_BUTTON_TEXT
    && Boolean(webApp && typeof webApp === "object" && (webApp as Record<string, unknown>).url === miniAppUrl);
}

export async function reconcileTelegramWebhookRegistration(
  db: D1Database,
  options: {
    botToken?: string | null;
    webhookSecret?: string | null;
    selfUrl?: string | null;
    signal?: AbortSignal;
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
  if (await shouldSkipFreshMatchingCache(db, TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY, TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache", expectedUrl };
  }

  if (await isRateLimited(db, "setWebhook")) {
    return { attempted: false, skipped: true, reason: "rate-limited", expectedUrl };
  }

  const response = await postTelegramBotApi(botToken, "setWebhook", {
    url: expectedUrl,
    secret_token: webhookSecret,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
  }, { signal: options.signal });

  const responseText = await response.text();
  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  const retryAfter = extractRetryAfter(response, parsed);
  if (retryAfter !== null) {
    await recordRateLimit(db, "setWebhook", retryAfter);
    return { attempted: false, skipped: true, reason: "rate-limited", expectedUrl };
  }

  if (!response.ok) {
    throw new Error(`Telegram setWebhook HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  if (parsed?.ok !== true) {
    throw new Error(`Telegram setWebhook rejected registration: ${(parsed?.description ?? responseText).slice(0, 300)}`);
  }

  await setCache(db, TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false, expectedUrl };
}

async function setMyCommandsForScope(
  db: D1Database,
  botToken: string,
  commands: ReadonlyArray<{ command: string; description: string }>,
  scope: { type: string },
  signal?: AbortSignal,
): Promise<{ throttled: boolean }> {
  const endpoint = `setMyCommands:${scope.type}`;
  if (await isRateLimited(db, endpoint)) {
    return { throttled: true };
  }

  const response = await postTelegramBotApi(botToken, "setMyCommands", { commands, scope }, { signal });

  const responseText = await response.text();
  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  const retryAfter = extractRetryAfter(response, parsed);
  if (retryAfter !== null) {
    await recordRateLimit(db, endpoint, retryAfter);
    return { throttled: true };
  }

  if (!response.ok) {
    throw new Error(
      `Telegram setMyCommands HTTP ${response.status} (scope=${scope.type}): ${responseText.slice(0, 300)}`,
    );
  }

  if (parsed?.ok !== true) {
    throw new Error(
      `Telegram setMyCommands rejected registration (scope=${scope.type}): ${(parsed?.description ?? responseText).slice(0, 300)}`,
    );
  }
  return { throttled: false };
}

export async function reconcileTelegramCommandRegistration(
  db: D1Database,
  options: {
    botToken?: string | null;
    signal?: AbortSignal;
    /** Explicit rollout injection; compatibility callers retain the public command list. */
    includeRecap?: boolean;
  },
): Promise<ReconcileTelegramCommandResult> {
  const botToken = options.botToken?.trim();
  const includeRecap = options.includeRecap ?? true;
  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token" };
  }

  const expectedCacheValue = buildExpectedCommandsCacheValue(includeRecap);
  if (await shouldSkipFreshMatchingCache(db, TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY, TELEGRAM_COMMANDS_RECONCILE_TTL_SEC, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache" };
  }

  const privateResult = await setMyCommandsForScope(
    db,
    botToken,
    getTelegramPrivateBotCommands(includeRecap),
    TELEGRAM_PRIVATE_COMMAND_SCOPE,
    options.signal,
  );
  const groupResult = await setMyCommandsForScope(
    db,
    botToken,
    TELEGRAM_BOT_GROUP_COMMANDS,
    TELEGRAM_GROUP_COMMAND_SCOPE,
    options.signal,
  );

  if (privateResult.throttled || groupResult.throttled) {
    return { attempted: false, skipped: true, reason: "rate-limited" };
  }

  await setCache(db, TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false };
}

export async function reconcileTelegramProfileRegistration(
  db: D1Database,
  options: {
    botToken?: string | null;
    signal?: AbortSignal;
  },
): Promise<ReconcileTelegramProfileResult> {
  const botToken = options.botToken?.trim();
  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token" };
  }

  const expectedCacheValue = buildExpectedProfileCacheValue();
  if (await shouldSkipFreshMatchingCache(db, TELEGRAM_PROFILE_RECONCILED_CACHE_KEY, TELEGRAM_PROFILE_RECONCILE_TTL_SEC, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache" };
  }

  const nameResult = await applyProfileField(db, botToken, "setMyName", { name: TELEGRAM_BOT_NAME }, options.signal);
  const shortResult = await applyProfileField(db, botToken, "setMyShortDescription", {
    short_description: TELEGRAM_BOT_SHORT_DESCRIPTION,
  }, options.signal);
  const descResult = await applyProfileField(db, botToken, "setMyDescription", {
    description: TELEGRAM_BOT_DESCRIPTION,
  }, options.signal);

  if (nameResult.throttled || shortResult.throttled || descResult.throttled) {
    return { attempted: false, skipped: true, reason: "rate-limited" };
  }

  await setCache(db, TELEGRAM_PROFILE_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false };
}

export async function reconcileTelegramMenuButton(
  db: D1Database,
  options: {
    botToken?: string | null;
    miniAppUrl?: string | null;
    signal?: AbortSignal;
  },
): Promise<ReconcileTelegramMenuButtonResult> {
  const botToken = options.botToken?.trim();
  const miniAppUrl = options.miniAppUrl?.trim() || TELEGRAM_MINI_APP_URL;
  const expectedCacheValue = buildExpectedMenuCacheValue(miniAppUrl);

  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token", miniAppUrl };
  }
  if (await shouldSkipFreshMatchingCache(db, TELEGRAM_MENU_RECONCILED_CACHE_KEY, TELEGRAM_MENU_RECONCILE_TTL_SEC, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache", miniAppUrl };
  }

  const current = await fetchTelegramMenuButton(botToken, options.signal);
  if (menuButtonMatches(current, miniAppUrl)) {
    await setCache(db, TELEGRAM_MENU_RECONCILED_CACHE_KEY, expectedCacheValue);
    return { attempted: true, skipped: false, reason: "already-current", miniAppUrl };
  }

  if (await isRateLimited(db, "setChatMenuButton")) {
    return { attempted: false, skipped: true, reason: "rate-limited", miniAppUrl };
  }

  const response = await postTelegramBotApi(botToken, "setChatMenuButton", {
    menu_button: buildTelegramMenuButton(miniAppUrl),
  }, { signal: options.signal });
  const responseText = await response.text();
  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }
  const retryAfter = extractRetryAfter(response, parsed);
  if (retryAfter !== null) {
    await recordRateLimit(db, "setChatMenuButton", retryAfter);
    return { attempted: false, skipped: true, reason: "rate-limited", miniAppUrl };
  }
  if (parsed?.ok !== true) {
    if (!response.ok) throw new Error(`Telegram setChatMenuButton HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    throw new Error(`Telegram setChatMenuButton rejected reconciliation: ${(parsed?.description ?? responseText).slice(0, 300)}`);
  }

  await setCache(db, TELEGRAM_MENU_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false, miniAppUrl };
}
