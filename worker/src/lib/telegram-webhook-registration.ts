import { API_ORIGIN, SITE_ORIGIN, resolveOrigin } from "@shared/lib/runtime-origins";
import { getCache, setCache } from "./db-cache";

const DEFAULT_SELF_URL = API_ORIGIN;
const TELEGRAM_WEBHOOK_PATH = "/api/telegram-webhook";
const TELEGRAM_MINI_APP_PATH = "/pharoswatchbot/app/";
const TELEGRAM_WEBHOOK_RECONCILED_CACHE_KEY = "telegram:webhook-reconciled";
const TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY = "telegram:commands-reconciled";
const TELEGRAM_PROFILE_RECONCILED_CACHE_KEY = "telegram:profile-reconciled";
const TELEGRAM_MENU_RECONCILED_CACHE_KEY = "telegram:menu-reconciled";
const TELEGRAM_WEBHOOK_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_COMMANDS_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_PROFILE_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_MENU_RECONCILE_TTL_SEC = 15 * 60;
const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;
const TELEGRAM_WEBHOOK_CACHE_VERSION = 2;
const TELEGRAM_COMMANDS_CACHE_VERSION = 5;
const TELEGRAM_PROFILE_CACHE_VERSION = 3;
const TELEGRAM_MENU_CACHE_VERSION = 1;

// Profile metadata shown on the bot's About page, card preview, and chat
// header. Kept in code so changes flow through git review and the 15-minute
// reconciliation loop self-heals any drift introduced via BotFather.
export const TELEGRAM_BOT_NAME = "Pharos Watch";
export const TELEGRAM_BOT_SHORT_DESCRIPTION =
  "Stablecoin alerts: DEWS stress, depeg events, safety grade changes, and launches. Track the Pharos universe.";
export const TELEGRAM_BOT_DESCRIPTION =
  "Pharos Watch pushes alerts when something matters across the Pharos stablecoin universe: DEWS stress bands, depeg events, safety grade changes, and new launches. Subscribe to curated presets like usd-top25, or build a custom watchlist of any tracked coin. Learn more at https://pharos.watch/pharoswatchbot/";
export const TELEGRAM_MINI_APP_URL = new URL(TELEGRAM_MINI_APP_PATH, SITE_ORIGIN).toString();
export const TELEGRAM_MINI_APP_BUTTON_TEXT = "Manage Alerts";

export const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Get started with Pharos alerts" },
  { command: "help", description: "Command reference" },
  { command: "status", description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)" },
  { command: "brief", description: "Latest Pharos market brief" },
  { command: "top", description: "Rank current views: depeg, dews, yield, liquidity, chains, safety" },
  { command: "why", description: "Explain one coin Safety Score (e.g. /why USDC)" },
  { command: "coverage", description: "Show which Pharos data surfaces cover one coin" },
  { command: "health", description: "Show delivery diagnostics for this chat" },
  { command: "list", description: "Show your current subscriptions and settings" },
  { command: "subscribe", description: "Subscribe to alerts (e.g. /subscribe usd-top-50 depeg-step 250)" },
  { command: "unsubscribe", description: "Remove coin subscriptions" },
  { command: "presets", description: "Browse preset watchlists like usd-top25 / usd-top-25" },
  { command: "set", description: "Tune per-coin or global thresholds (e.g. /set all depeg-step 250)" },
  { command: "settings", description: "Open the inline settings keyboard (e.g. /settings or /settings USDC)" },
  { command: "mute", description: "Enable quiet hours (e.g. /mute 22-07; uses your /timezone)" },
  { command: "timezone", description: "Set chat timezone for quiet hours (e.g. /timezone Europe/Paris)" },
  { command: "unsnooze", description: "Clear active alert snooze" },
  { command: "unmutehours", description: "Disable quiet hours" },
  { command: "cancel", description: "Cancel a pending ticker selection" },
] as const;

export const TELEGRAM_BOT_GROUP_COMMANDS = [
  { command: "subscribe", description: "Subscribe to alerts (e.g. /subscribe usd-top-50 depeg-step 250)" },
  { command: "unsubscribe", description: "Remove coin subscriptions" },
  { command: "list", description: "Show your current subscriptions and settings" },
  { command: "health", description: "Show delivery diagnostics for this chat" },
  { command: "status", description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)" },
  { command: "mute", description: "Enable quiet hours in UTC (e.g. /mute 22-07)" },
  { command: "help", description: "Command reference" },
] as const;

const TELEGRAM_PRIVATE_COMMAND_SCOPE = { type: "all_private_chats" } as const;
const TELEGRAM_GROUP_COMMAND_SCOPE = { type: "all_group_chats" } as const;

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

interface TelegramChatMenuButtonResponse extends TelegramApiResponse {
  result?: unknown;
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

export interface ReconcileTelegramProfileResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "fresh-cache";
}

export interface ReconcileTelegramMenuButtonResult {
  attempted: boolean;
  skipped: boolean;
  reason?: "missing-bot-token" | "fresh-cache" | "already-current";
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
    scopes: {
      all_private_chats: TELEGRAM_BOT_COMMANDS,
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

async function shouldSkipFreshMatchingProfileCache(db: D1Database, expectedValue: string): Promise<boolean> {
  const cached = await getCache(db, TELEGRAM_PROFILE_RECONCILED_CACHE_KEY);
  if (!cached) return false;
  if (Date.now() / 1000 - cached.updatedAt >= TELEGRAM_PROFILE_RECONCILE_TTL_SEC) return false;
  return cached.value === expectedValue;
}

async function shouldSkipFreshMatchingMenuCache(db: D1Database, expectedValue: string): Promise<boolean> {
  const cached = await getCache(db, TELEGRAM_MENU_RECONCILED_CACHE_KEY);
  if (!cached) return false;
  if (Date.now() / 1000 - cached.updatedAt >= TELEGRAM_MENU_RECONCILE_TTL_SEC) return false;
  return cached.value === expectedValue;
}

// Telegram returns 400 "Bad Request: <field> is not modified" when the
// submitted value matches the current value. That's the documented idempotent
// success path; treat it like ok=true so we still update the cache marker.
function isNotModifiedDescription(description: string | null | undefined): boolean {
  if (!description) return false;
  return /is not modified/i.test(description);
}

async function applyProfileField(
  botToken: string,
  method: "setMyName" | "setMyDescription" | "setMyShortDescription",
  payload: Record<string, string>,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  const responseText = await response.text();
  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  if (parsed?.ok === true) return;
  if (isNotModifiedDescription(parsed?.description)) return;

  if (!response.ok) {
    throw new Error(`Telegram ${method} HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }
  throw new Error(`Telegram ${method} rejected registration: ${(parsed?.description ?? responseText).slice(0, 300)}`);
}

async function fetchTelegramMenuButton(botToken: string): Promise<unknown | null> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
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

async function setMyCommandsForScope(
  botToken: string,
  commands: ReadonlyArray<{ command: string; description: string }>,
  scope: { type: string },
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands, scope }),
    signal: AbortSignal.timeout(10_000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Telegram setMyCommands HTTP ${response.status} (scope=${scope.type}): ${responseText.slice(0, 300)}`,
    );
  }

  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }

  if (parsed?.ok !== true) {
    throw new Error(
      `Telegram setMyCommands rejected registration (scope=${scope.type}): ${(parsed?.description ?? responseText).slice(0, 300)}`,
    );
  }
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

  await setMyCommandsForScope(botToken, TELEGRAM_BOT_COMMANDS, TELEGRAM_PRIVATE_COMMAND_SCOPE);
  await setMyCommandsForScope(botToken, TELEGRAM_BOT_GROUP_COMMANDS, TELEGRAM_GROUP_COMMAND_SCOPE);

  await setCache(db, TELEGRAM_COMMANDS_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false };
}

export async function reconcileTelegramProfileRegistration(
  db: D1Database,
  options: {
    botToken?: string | null;
  },
): Promise<ReconcileTelegramProfileResult> {
  const botToken = options.botToken?.trim();
  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token" };
  }

  const expectedCacheValue = buildExpectedProfileCacheValue();
  if (await shouldSkipFreshMatchingProfileCache(db, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache" };
  }

  await applyProfileField(botToken, "setMyName", { name: TELEGRAM_BOT_NAME });
  await applyProfileField(botToken, "setMyShortDescription", {
    short_description: TELEGRAM_BOT_SHORT_DESCRIPTION,
  });
  await applyProfileField(botToken, "setMyDescription", { description: TELEGRAM_BOT_DESCRIPTION });

  await setCache(db, TELEGRAM_PROFILE_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false };
}

export async function reconcileTelegramMenuButton(
  db: D1Database,
  options: {
    botToken?: string | null;
    miniAppUrl?: string | null;
  },
): Promise<ReconcileTelegramMenuButtonResult> {
  const botToken = options.botToken?.trim();
  const miniAppUrl = options.miniAppUrl?.trim() || TELEGRAM_MINI_APP_URL;
  const expectedCacheValue = buildExpectedMenuCacheValue(miniAppUrl);

  if (!botToken) {
    return { attempted: false, skipped: true, reason: "missing-bot-token", miniAppUrl };
  }
  if (await shouldSkipFreshMatchingMenuCache(db, expectedCacheValue)) {
    return { attempted: false, skipped: true, reason: "fresh-cache", miniAppUrl };
  }

  const current = await fetchTelegramMenuButton(botToken);
  if (menuButtonMatches(current, miniAppUrl)) {
    await setCache(db, TELEGRAM_MENU_RECONCILED_CACHE_KEY, expectedCacheValue);
    return { attempted: false, skipped: true, reason: "already-current", miniAppUrl };
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ menu_button: buildTelegramMenuButton(miniAppUrl) }),
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await response.text();
  let parsed: TelegramApiResponse | null = null;
  try {
    parsed = JSON.parse(responseText) as TelegramApiResponse;
  } catch {
    parsed = null;
  }
  if (parsed?.ok !== true) {
    if (!response.ok) throw new Error(`Telegram setChatMenuButton HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    throw new Error(`Telegram setChatMenuButton rejected reconciliation: ${(parsed?.description ?? responseText).slice(0, 300)}`);
  }

  await setCache(db, TELEGRAM_MENU_RECONCILED_CACHE_KEY, expectedCacheValue);
  return { attempted: true, skipped: false, miniAppUrl };
}
