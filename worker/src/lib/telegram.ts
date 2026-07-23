import { drainResponseBody, readResponseTextBoundedWithSignal } from "./response-body";
import { logTelegramEvent } from "./telegram-log";
import {
  classifyTelegramCaughtFailure,
  classifyTelegramResponseFailure,
  type TelegramTransportErrorClass,
} from "./telegram-transport-errors";

export interface TelegramCreds {
  botToken: string;
  chatId: string;
}

interface PendingAlertScopeItem {
  stablecoinId: string;
  family: import("@shared/types/status").TelegramAlertType;
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

export interface TelegramInlineQueryResultArticle {
  type: "article";
  id: string;
  title: string;
  description?: string;
  input_message_content: {
    message_text: string;
    parse_mode: "HTML";
    link_preview_options?: { is_disabled: boolean };
  };
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

export type TelegramSendErrorClass = TelegramTransportErrorClass;

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
  migrateToChatId?: string;
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
      const body = await readResponseTextBoundedWithSignal(res, 16_384, signal).catch(() => "");
      const failure = classifyTelegramResponseFailure(
        res.status,
        body,
        Number.isFinite(retryAfterSec) ? retryAfterSec : null,
      );
      return {
        ok: false,
        ...failure,
        statusCode: res.status,
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
    return {
      ok: false,
      ...classifyTelegramCaughtFailure(error),
      statusCode: null,
    };
  }
}

export interface BatchMessage {
  chatId: string;
  html: string;
  disableNotification: boolean;
  /** Persisted parse-mode policy for durable pending delivery. */
  disableWebPagePreview?: boolean;
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
  /** Safety model/policy/build identity bound to any safety items in this target. */
  safetyScoreIdentity?: import("@shared/types/safety-score-publication").SafetyScorePublicationIdentity;
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
  migrateToChatId?: string;
  attempted?: boolean;
  skippedReason?:
    | "predecessor_failure"
    | "global_rate_limit"
    | "aborted"
    | "soft_deadline"
    | "pre_send"
    | "transport_control"
    | "delivery_mode_pause";
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
    skippedReason:
      predecessor.skippedReason === "transport_control" || predecessor.skippedReason === "delivery_mode_pause"
        ? predecessor.skippedReason
        : "predecessor_failure",
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

    const transportStop = waveResults.find(
      (result) => result.attempted === false && result.skippedReason === "transport_control",
    );
    if (
      transportStop &&
      waveResults.every(
        (result) => result.attempted === false && result.skippedReason === "transport_control",
      )
    ) {
      const buildTransportStop = (item: T): BatchResult => ({
        ...transportStop,
        chatId: item.chatId,
        attempted: false,
      });
      for (const queue of waveQueues) fillQueueTail(queue, buildTransportStop);
      fillAllReady(buildTransportStop);
      break;
    }

    const globalRateLimitedResult = waveResults.find(
      (result) =>
        result.attempted !== false && result.errorClass === "rate_limit" && result.rateLimitScope === "global",
    );
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
 * chats. Concurrency stays <= 6 to match the repo's conservative outbound-request budget.
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
 * the caller can fall back to `sendToChat`. The body is drained so response
 * bytes and transport cleanup stay bounded.
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
 * user's tapped button within a few seconds. The body is drained so response
 * bytes and transport cleanup stay bounded.
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

/**
 * Answer a Telegram inline query with a bounded, cacheable result set. The
 * caller owns query validation and must not include user/query identifiers in
 * any telemetry or result payload beyond Telegram's required query id.
 */
export async function answerInlineQuery(
  inlineQueryId: string,
  botToken: string,
  results: readonly TelegramInlineQueryResultArticle[],
  options: { cacheTimeSec: number },
): Promise<boolean> {
  const res = await postTelegramBotApi(botToken, "answerInlineQuery", {
    inline_query_id: inlineQueryId,
    results,
    cache_time: options.cacheTimeSec,
    is_personal: false,
  });
  await drainResponseBody(res);
  if (res.ok) return true;
  logTelegramEvent({
    level: "warn",
    message: "inline query answer rejected",
    action: "answer-inline-query",
    statusCode: res.status,
    errorClass: classifyCallbackAcknowledgementFailure(res.status),
  });
  return false;
}
