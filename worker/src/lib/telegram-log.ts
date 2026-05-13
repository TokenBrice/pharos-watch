/**
 * Structured logger for the Telegram subsystem.
 *
 * Emits a single-line JSON record per event so log scrapers (and humans
 * tailing `wrangler tail`) can filter by chatId / action / level without
 * brittle regex on prose log lines.
 *
 * Pure, synchronous, no dependencies. Defaults `level` to "error" so a
 * bare `logTelegramEvent({ message })` mirrors the historical
 * `console.error(...)` ergonomics callers are replacing.
 */
export type TelegramLogLevel = "info" | "warn" | "error";

export interface TelegramLogEvent {
  level?: TelegramLogLevel;
  message: string;
  chatId?: string | number | null;
  userId?: string | number | null;
  action?: string | null;
  [key: string]: unknown;
}

const INVALID_SECRET_SPIKE_WINDOW_MS = 60_000;
const INVALID_SECRET_SPIKE_THRESHOLD = 5;

let invalidSecretWindowStartedAt = 0;
let invalidSecretWindowCount = 0;

interface TelegramLogRecord {
  ts: string;
  scope: "telegram";
  level: TelegramLogLevel;
  message: string;
  chatId?: string;
  userId?: string;
  action?: string;
  [key: string]: unknown;
}

function normalizeId(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function logTelegramEvent(event: TelegramLogEvent): void {
  const { level, message, chatId, userId, action, ...rest } = event;
  const resolvedLevel: TelegramLogLevel = level ?? "error";
  const record: TelegramLogRecord = {
    ts: new Date().toISOString(),
    scope: "telegram",
    level: resolvedLevel,
    message,
  };
  const normalizedChatId = normalizeId(chatId);
  if (normalizedChatId !== undefined) record.chatId = normalizedChatId;
  const normalizedUserId = normalizeId(userId);
  if (normalizedUserId !== undefined) record.userId = normalizedUserId;
  if (action !== null && action !== undefined && action !== "") record.action = action;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    record[key] = value;
  }
  const line = JSON.stringify(record);
  if (resolvedLevel === "warn") {
    console.warn(line);
  } else if (resolvedLevel === "info") {
    console.info(line);
  } else {
    console.error(line);
  }
}

export function logTelegramInvalidSecretAttempt(
  context: {
    hasCurrentSecret: boolean;
    hasPreviousSecret: boolean;
    presentedLength: number;
  },
): void {
  const nowMs = Date.now();
  if (
    invalidSecretWindowStartedAt === 0 ||
    nowMs - invalidSecretWindowStartedAt > INVALID_SECRET_SPIKE_WINDOW_MS
  ) {
    invalidSecretWindowStartedAt = nowMs;
    invalidSecretWindowCount = 0;
  }
  invalidSecretWindowCount += 1;

  logTelegramEvent({
    level: "warn",
    message: "invalid webhook secret",
    action: "auth-invalid-secret",
    signal: "invalid_secret",
    invalidSecretWindowCount,
    invalidSecretSpike: invalidSecretWindowCount >= INVALID_SECRET_SPIKE_THRESHOLD,
    ...context,
  });
}

/** @internal Exported for tests only. */
export function resetTelegramInvalidSecretLogStateForTests(): void {
  invalidSecretWindowStartedAt = 0;
  invalidSecretWindowCount = 0;
}
