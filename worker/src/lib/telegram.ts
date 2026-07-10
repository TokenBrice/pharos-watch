import { drainResponseBody } from "./response-body";
import { logTelegramEvent } from "./telegram-log";
import {
  TELEGRAM_GLOBAL_RATE_LIMIT_DISTINCT_CHAT_THRESHOLD,
  TELEGRAM_GLOBAL_RATE_LIMIT_RETRY_AFTER_THRESHOLD_SEC,
} from "./telegram-constants";
import type { PendingAlertScopeItem } from "./telegram-pending-provenance";

export interface TelegramCreds {
  botToken: string;
  chatId: string;
}

/** Telegram Bot API inline keyboard button shape. */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

/** Telegram Bot API inline keyboard markup. */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Telegram Bot API force-reply markup. */
export interface ForceReplyMarkup {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
}

export interface TelegramBotApiPostOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function postTelegramBotApi(
  botToken: string,
  method: string,
  payload: unknown,
  options: TelegramBotApiPostOptions = {},
): Promise<Response> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 10_000);
  return fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

/** Escape HTML special characters for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Build the full Telegram message for a digest. */
export function buildTelegramMessage(
  title: string,
  extended: string,
  date: string,
  editionNumber?: number | null,
  appendixHtml?: string | null,
): string {
  // Escape HTML first, then convert markdown bold **text** to <b>text</b>
  const body = escapeHtml(extended).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const kicker = editionNumber ? `Pharos Daily Digest #${editionNumber}\n` : "";
  const sections = [
    `${kicker}<b>${escapeHtml(title)}</b>`,
    body,
    appendixHtml ?? "",
    `<a href="https://pharos.watch/digest/${date}/">Read on Pharos →</a>`,
  ].filter((section) => section.trim().length > 0);
  return sections.join("\n\n");
}

/** Post a raw text message to a Telegram channel. Throws on API error. */
export async function postTelegramMessage(text: string, creds: TelegramCreds): Promise<void> {
  const result = await sendToChat(creds.chatId, text, creds.botToken);
  if (!result.ok) {
    throw new Error(`Telegram API ${result.statusCode ?? "?"}: ${result.errorClass}`);
  }
}

/**
 * Format and post a digest to the Telegram channel.
 * The caller is responsible for catching errors (this is non-fatal).
 */
export async function postDigestToTelegram(
  title: string,
  extended: string,
  date: string,
  creds: TelegramCreds,
  editionNumber?: number | null,
  appendixHtml?: string | null,
): Promise<void> {
  const text = buildTelegramMessage(title, extended, date, editionNumber, appendixHtml);
  await postTelegramMessage(text, creds);
  console.log(`[telegram] Posted digest (${text.length} chars)`);
}

/**
 * Telegram `link_preview_options` payload (Bot API 7.0+, Mar 2024).
 * Replaces the older `disable_web_page_preview` flag with a richer object.
 * When both are provided to `sendToChat`, `linkPreviewOptions` wins because
 * the Bot API ignores `disable_web_page_preview` whenever `link_preview_options`
 * is present.
 */
export interface LinkPreviewOptions {
  /** `true` disables previews entirely. */
  is_disabled?: boolean;
  /** Optional URL to preview instead of the first link in the message. */
  url?: string;
  /** Force a small preview thumbnail (mobile-friendly for inline keyboards). */
  prefer_small_media?: boolean;
  /** Force a large preview thumbnail. */
  prefer_large_media?: boolean;
  /** Render the preview above the message text. Defaults to below. */
  show_above_text?: boolean;
}

export interface SendToChatOpts {
  disableWebPagePreview?: boolean;
  /**
   * Bot API 7.0+ link-preview controls. Takes precedence over
   * `disableWebPagePreview` when both are set.
   */
  linkPreviewOptions?: LinkPreviewOptions;
  disableNotification?: boolean;
  replyMarkup?: unknown;
  signal?: AbortSignal;
}

export type TelegramSendErrorClass =
  | "blocked"
  | "rate_limit"
  | "server_error"
  | "bad_request"
  | "auth_error"
  | "timeout"
  | "network"
  | "unknown";

export interface SendToChatResult {
  ok: boolean;
  blocked: boolean;
  retryable: boolean;
  permanentFailure: boolean;
  statusCode: number | null;
  errorClass: TelegramSendErrorClass | null;
  delivery: "sent" | "blocked" | "retryable_failure" | "permanent_failure";
  retryAfterSec: number | null;
  rateLimitScope?: "chat" | "global";
}

export interface SendBatchOptions {
  softDeadlineAtMs?: number;
  beforeSendBatch?: (
    entries: readonly ScheduledBatchEntry<BatchMessage>[],
  ) => Promise<ReadonlyMap<number, PreSendBatchResult> | void>;
  afterSendBatch?: (
    entries: readonly ScheduledBatchEntry<BatchMessage>[],
    results: readonly BatchResult[],
  ) => Promise<void>;
}

function inferRateLimitScope(responseBody: string, retryAfterSec: number | null): "chat" | "global" {
  const lower = responseBody.toLowerCase();
  if (lower.includes("global") || lower.includes("bot-wide") || lower.includes("bot wide")) {
    return "global";
  }
  if (lower.includes("chat") || lower.includes("group") || lower.includes("user")) {
    return "chat";
  }
  if (retryAfterSec != null && retryAfterSec >= TELEGRAM_GLOBAL_RATE_LIMIT_RETRY_AFTER_THRESHOLD_SEC) {
    return "global";
  }
  return "chat";
}

function parseTelegramRetryAfter(responseBody: string): number | null {
  if (!responseBody.trim()) return null;
  try {
    const parsed = JSON.parse(responseBody) as {
      parameters?: { retry_after?: unknown };
      response_parameters?: { retry_after?: unknown };
    };
    const raw = parsed.parameters?.retry_after ?? parsed.response_parameters?.retry_after;
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : null;
    return value != null && Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function buildResponseFailure(statusCode: number, responseBody = "", retryAfterSec: number | null = null): SendToChatResult {
  if (statusCode === 403) {
    return {
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode,
      errorClass: "blocked",
      delivery: "blocked",
      retryAfterSec: null,
    };
  }
  if (statusCode === 429) {
    return {
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: null,
      rateLimitScope: inferRateLimitScope(responseBody, retryAfterSec),
    };
  }
  if (statusCode >= 500) {
    return {
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode,
      errorClass: "server_error",
      delivery: "retryable_failure",
      retryAfterSec: null,
    };
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 413) {
    return {
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode,
      errorClass: "bad_request",
      delivery: "permanent_failure",
      retryAfterSec: null,
    };
  }
  if (statusCode === 401) {
    return {
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode,
      errorClass: "auth_error",
      delivery: "permanent_failure",
      retryAfterSec: null,
    };
  }
  return {
    ok: false,
    blocked: false,
    retryable: true,
    permanentFailure: false,
    statusCode,
    errorClass: "unknown",
    delivery: "retryable_failure",
    retryAfterSec: null,
  };
}

function buildCaughtFailure(error: unknown): SendToChatResult {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return {
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: null,
      errorClass: "timeout",
      delivery: "retryable_failure",
      retryAfterSec: null,
    };
  }

  return {
    ok: false,
    blocked: false,
    retryable: true,
    permanentFailure: false,
    statusCode: null,
    errorClass: "network",
    delivery: "retryable_failure",
    retryAfterSec: null,
  };
}

function classifyCallbackAcknowledgementFailure(statusCode: number): TelegramSendErrorClass {
  if (statusCode === 429) return "rate_limit";
  if (statusCode >= 500) return "server_error";
  if (statusCode === 401 || statusCode === 403) return "auth_error";
  if (statusCode === 400 || statusCode === 404 || statusCode === 413) return "bad_request";
  return "unknown";
}

/** Send an HTML message to a specific Telegram chat. */
export async function sendToChat(
  chatId: string,
  text: string,
  botToken: string,
  opts?: SendToChatOpts,
): Promise<SendToChatResult> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        // `link_preview_options` (Bot API 7.0+) takes precedence over the legacy
        // boolean. We only emit the legacy field when the richer object is absent
        // so older callers keep their existing behavior.
        ...(opts?.linkPreviewOptions
          ? { link_preview_options: opts.linkPreviewOptions }
          : opts?.disableWebPagePreview && { disable_web_page_preview: true }),
        ...(opts?.disableNotification && { disable_notification: true }),
        ...(opts?.replyMarkup != null && { reply_markup: opts.replyMarkup }),
      }),
      signal,
    });

    if (!res.ok) {
      const retryAfterRaw = res.headers.get("Retry-After");
      const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : null;
      const body = await res.text().catch(() => "");
      const telegramRetryAfterSec = parseTelegramRetryAfter(body);
      const resolvedRetryAfterSec = telegramRetryAfterSec ?? (Number.isFinite(retryAfterSec) ? retryAfterSec : null);
      const failure = buildResponseFailure(res.status, body, resolvedRetryAfterSec);
      return {
        ...failure,
        retryAfterSec: resolvedRetryAfterSec,
      };
    }
    await drainResponseBody(res);
    return {
      ok: true,
      blocked: false,
      retryable: false,
      permanentFailure: false,
      statusCode: res.status,
      errorClass: null,
      delivery: "sent",
      retryAfterSec: null,
    };
  } catch (error) {
    return buildCaughtFailure(error);
  }
}

export interface BatchMessage {
  chatId: string;
  html: string;
  disableNotification: boolean;
  replyMarkup?: unknown;
  chunkIndex?: number;
  /**
   * Pre-split canonical message body used to derive a stable dedupe key for the
   * pending queue. Optional because send-only paths (e.g. raw `sendBatch` tests)
   * do not need it, but production routing populates it for every chunk so the
   * key survives unrelated changes to `splitMessage`.
   */
  canonicalHtml?: string;
  /**
   * Dominant alert type for the consolidated message this chunk belongs to.
   * Set by the dispatch router for fresh sends so the delivery loop can
   * aggregate per-type delivery metrics. Pending-queue replays do not carry
   * a type because the persisted row only stores the rendered HTML.
   */
  alertType?: import("@shared/types/status").TelegramAlertType;
  /**
   * Per-chunk Bot API 7.0+ link-preview override. When set, `sendBatch` forwards
   * it to `sendToChat`, which takes precedence over the batch-wide
   * `disable_web_page_preview: true` default. Used by the dispatch router to
   * enable a small preview card for the "View on Pharos" link on the first
   * chunk of single-coin alerts.
   */
  linkPreviewOptions?: LinkPreviewOptions;
  /** Immutable source identity for queued risk-alert provenance. */
  sourceEventId?: string;
  /** Chat preference generation observed while this alert target was planned. */
  preferenceGeneration?: number;
  /** Exact coin/family pairs represented by this immutable rendered target. */
  alertScope?: PendingAlertScopeItem[];
}

export interface BatchResult {
  chatId: string;
  ok: boolean;
  blocked: boolean;
  retryable: boolean;
  permanentFailure: boolean;
  statusCode: number | null;
  errorClass: TelegramSendErrorClass | null;
  delivery: "sent" | "blocked" | "retryable_failure" | "permanent_failure";
  retryAfterSec: number | null;
  rateLimitScope?: "chat" | "global";
  attempted?: boolean;
  skippedReason?: "predecessor_failure" | "global_rate_limit" | "aborted" | "soft_deadline" | "pre_send";
}

export type PreSendBatchResult = Omit<BatchResult, "chatId" | "attempted">;

/**
 * One input selected for a distinct-chat send wave. `index` always refers to
 * the item's position in the original input, even when the scheduler moves a
 * different chat forward to fill a concurrency slot.
 */
export interface ScheduledBatchEntry<T> {
  index: number;
  item: T;
}

interface PerChatBatchScheduleOptions<T> {
  signal?: AbortSignal;
  softDeadlineAtMs?: number | null;
  beforeSendBatch?: (
    entries: readonly ScheduledBatchEntry<T>[],
  ) => Promise<ReadonlyMap<number, PreSendBatchResult> | void>;
  afterSendBatch?: (entries: readonly ScheduledBatchEntry<T>[], results: readonly BatchResult[]) => Promise<void>;
}

function buildUnsentRetryResult(
  chatId: string,
  errorClass: TelegramSendErrorClass,
  retryAfterSec: number | null,
  rateLimitScope?: "chat" | "global",
  skippedReason?: BatchResult["skippedReason"],
): BatchResult {
  return {
    chatId,
    ok: false,
    blocked: false,
    retryable: true,
    permanentFailure: false,
    statusCode: errorClass === "rate_limit" ? 429 : null,
    errorClass,
    delivery: "retryable_failure",
    retryAfterSec,
    ...(rateLimitScope ? { rateLimitScope } : {}),
    attempted: false,
    ...(skippedReason ? { skippedReason } : {}),
  };
}

function buildPredecessorFailureResult(chatId: string, predecessor: BatchResult): BatchResult {
  return {
    ...predecessor,
    chatId,
    attempted: false,
    skippedReason: "predecessor_failure",
  };
}

interface PerChatQueue {
  chatId: string;
  indexes: number[];
  nextIndex: number;
}

/**
 * Run at most one item per chat in each bounded-concurrency wave. Chat queues
 * are round-robin, so a multi-chunk chat cannot monopolize the available
 * connection slots. A failed predecessor classifies the untouched same-chat
 * tail without launching it; successful chunks advance in stable input order.
 */
export async function schedulePerChatBatches<T extends { chatId: string }>(
  items: readonly T[],
  batchSize: number,
  send: (item: T) => Promise<SendToChatResult>,
  options: PerChatBatchScheduleOptions<T> = {},
): Promise<BatchResult[]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`schedulePerChatBatches requires a positive integer batchSize (received ${batchSize})`);
  }
  if (items.length === 0) return [];

  const results = new Array<BatchResult | undefined>(items.length);
  const queueByChat = new Map<string, PerChatQueue>();
  const readyQueues: PerChatQueue[] = [];
  for (const [index, item] of items.entries()) {
    let queue = queueByChat.get(item.chatId);
    if (!queue) {
      queue = { chatId: item.chatId, indexes: [], nextIndex: 0 };
      queueByChat.set(item.chatId, queue);
      readyQueues.push(queue);
    }
    queue.indexes.push(index);
  }

  const distinctRateLimitedChats = new Set<string>();
  const fillQueueTail = (queue: PerChatQueue, buildResult: (item: T) => BatchResult): void => {
    while (queue.nextIndex < queue.indexes.length) {
      const index = queue.indexes[queue.nextIndex++];
      results[index] = buildResult(items[index]);
    }
  };
  const fillAllReady = (buildResult: (item: T) => BatchResult): void => {
    for (const queue of readyQueues) fillQueueTail(queue, buildResult);
    readyQueues.length = 0;
  };

  while (readyQueues.length > 0) {
    if (options.signal?.aborted) {
      fillAllReady((item) => buildUnsentRetryResult(item.chatId, "timeout", null, undefined, "aborted"));
      break;
    }
    if (options.softDeadlineAtMs != null && Date.now() >= options.softDeadlineAtMs) {
      fillAllReady((item) => buildUnsentRetryResult(item.chatId, "timeout", null, undefined, "soft_deadline"));
      break;
    }

    const waveQueues = readyQueues.splice(0, batchSize);
    const entries = waveQueues.map((queue): ScheduledBatchEntry<T> => {
      const index = queue.indexes[queue.nextIndex++];
      return { index, item: items[index] };
    });
    const preSendResults = await options.beforeSendBatch?.(entries);

    const waveResults = await Promise.all(
      entries.map(async ({ index, item }) => {
        const preSendResult = preSendResults?.get(index);
        if (preSendResult) {
          return {
            ...preSendResult,
            chatId: item.chatId,
            attempted: false,
            skippedReason: preSendResult.skippedReason ?? "pre_send",
          } satisfies BatchResult;
        }
        const result = await send(item);
        return { chatId: item.chatId, ...result, attempted: true } satisfies BatchResult;
      }),
    );
    for (const [waveIndex, entry] of entries.entries()) {
      results[entry.index] = waveResults[waveIndex];
    }
    await options.afterSendBatch?.(entries, waveResults);

    let globalRateLimitedResult = waveResults.find(
      (result) =>
        result.attempted !== false && result.errorClass === "rate_limit" && result.rateLimitScope === "global",
    );
    if (!globalRateLimitedResult) {
      for (const result of waveResults) {
        if (result.attempted === false) continue;
        if (result.errorClass === "rate_limit" && result.rateLimitScope !== "global") {
          distinctRateLimitedChats.add(result.chatId);
        }
      }
      if (distinctRateLimitedChats.size >= TELEGRAM_GLOBAL_RATE_LIMIT_DISTINCT_CHAT_THRESHOLD) {
        globalRateLimitedResult = waveResults.find(
          (result) => result.errorClass === "rate_limit" && result.rateLimitScope !== "global",
        );
        for (const result of waveResults) {
          if (result.errorClass === "rate_limit" && result.rateLimitScope !== "global") {
            result.rateLimitScope = "global";
          }
        }
      }
    }

    if (globalRateLimitedResult) {
      const buildGlobalResult = (item: T) =>
        buildUnsentRetryResult(
          item.chatId,
          "rate_limit",
          globalRateLimitedResult?.retryAfterSec ?? null,
          "global",
          "global_rate_limit",
        );
      for (const queue of waveQueues) fillQueueTail(queue, buildGlobalResult);
      fillAllReady(buildGlobalResult);
      break;
    }

    for (const [waveIndex, queue] of waveQueues.entries()) {
      const result = waveResults[waveIndex];
      if (!result.ok) {
        fillQueueTail(queue, (item) => buildPredecessorFailureResult(item.chatId, result));
      } else if (queue.nextIndex < queue.indexes.length) {
        readyQueues.push(queue);
      }
    }
  }

  return results.map((result, index) => {
    if (result) return result;
    return buildUnsentRetryResult(items[index].chatId, "unknown", null);
  });
}

/**
 * Send messages serially within each chat and concurrently across distinct
 * chats. Concurrency must stay <= 6 to respect the Workers connection limit.
 * Individual send failures are caught by `sendToChat`; one failed chat does
 * not abort other chat queues. Results retain the original input order.
 */
export async function sendBatch(
  messages: BatchMessage[],
  botToken: string,
  batchSize: number,
  signal?: AbortSignal,
  options: SendBatchOptions = {},
): Promise<BatchResult[]> {
  const softDeadlineAtMs = Number.isFinite(options.softDeadlineAtMs)
    ? options.softDeadlineAtMs
    : null;
  return schedulePerChatBatches(
    messages,
    batchSize,
    (msg) =>
      sendToChat(msg.chatId, msg.html, botToken, {
        // Caller-supplied preview options win; otherwise default to no preview
        // for batch alert sends to keep the message dense on mobile.
        ...(msg.linkPreviewOptions ? { linkPreviewOptions: msg.linkPreviewOptions } : { disableWebPagePreview: true }),
        disableNotification: msg.disableNotification,
        replyMarkup: msg.replyMarkup,
        signal,
      }),
    {
      signal,
      softDeadlineAtMs,
      beforeSendBatch: options.beforeSendBatch,
      afterSendBatch: options.afterSendBatch,
    },
  );
}

export interface EditMessageOpts {
  disableWebPagePreview?: boolean;
  replyMarkup?: unknown;
}

function isNotModifiedDescription(description: unknown): boolean {
  return typeof description === "string" && /is not modified/i.test(description);
}

/**
 * Edit a previously sent message in place. Used by inline-keyboard flows
 * (e.g. /settings) so a tap mutates the visible message rather than appending
 * a fresh reply. Returns `true` on success, `false` on any Telegram error so
 * the caller can fall back to `sendToChat`. Body is drained to respect the
 * per-trigger 6-connection cap.
 */
export async function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  botToken: string,
  opts?: EditMessageOpts,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        ...(opts?.disableWebPagePreview && { disable_web_page_preview: true }),
        ...(opts?.replyMarkup != null && { reply_markup: opts.replyMarkup }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const responseText = await res.text();
    if (res.ok) return true;
    try {
      const parsed = JSON.parse(responseText) as { description?: unknown };
      return isNotModifiedDescription(parsed.description);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Answer a Telegram callback_query. Required to dismiss the spinner on the
 * user's tapped button within a few seconds. Body is drained to stay under the
 * Workers 6-connection cap.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  botToken: string,
  options: { text?: string; showAlert?: boolean } = {},
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: options.text,
        show_alert: options.showAlert ?? false,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  await drainResponseBody(res);
  if (!res.ok) {
    logTelegramEvent({
      level: "warn",
      message: "callback acknowledgement rejected",
      action: "answer-callback-query",
      statusCode: res.status,
      errorClass: classifyCallbackAcknowledgementFailure(res.status),
    });
  }
}
