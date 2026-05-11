import { drainResponseBody } from "./response-body";

export interface TelegramCreds {
  botToken: string;
  chatId: string;
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
  const url = `https://api.telegram.org/bot${creds.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: creds.chatId,
      text,
      parse_mode: "HTML",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 300)}`);
  }

  await drainResponseBody(res);
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

function inferRateLimitScope(responseBody: string): "chat" | "global" {
  const lower = responseBody.toLowerCase();
  if (lower.includes("global") || lower.includes("bot-wide") || lower.includes("bot wide")) {
    return "global";
  }
  return "chat";
}

function buildResponseFailure(statusCode: number, responseBody = ""): SendToChatResult {
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
      rateLimitScope: inferRateLimitScope(responseBody),
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
      const failure = buildResponseFailure(res.status, body);
      return {
        ...failure,
        retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
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
}

/**
 * Send messages in parallel batches. Each batch sends up to `batchSize`
 * messages concurrently (must stay <= 6 to respect Workers connection limit).
 * Individual send failures are caught — a single 500 error does NOT abort the batch.
 * Returns one result per input message in the same order.
 */
function buildUnsentRetryResult(
  message: BatchMessage,
  errorClass: TelegramSendErrorClass,
  retryAfterSec: number | null,
  rateLimitScope?: "chat" | "global",
): BatchResult {
  return {
    chatId: message.chatId,
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
  };
}

export async function sendBatch(
  messages: BatchMessage[],
  botToken: string,
  batchSize: number,
  signal?: AbortSignal,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    if (signal?.aborted) {
      results.push(...messages.slice(i).map((message) => buildUnsentRetryResult(message, "timeout", null)));
      break;
    }
    const batch = messages.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (msg) => {
        const result = await sendToChat(msg.chatId, msg.html, botToken, {
          // Caller-supplied preview options win; otherwise default to no preview
          // for batch alert sends to keep the message dense on mobile.
          ...(msg.linkPreviewOptions
            ? { linkPreviewOptions: msg.linkPreviewOptions }
            : { disableWebPagePreview: true }),
          disableNotification: msg.disableNotification,
          replyMarkup: msg.replyMarkup,
          signal,
        });
        return { chatId: msg.chatId, ...result, attempted: true };
      }),
    );
    results.push(...batchResults);
    // Stop sending further batches only when the response context indicates a
    // bot-wide limit. Single-chat 429s remain isolated to that chat.
    const globalRateLimitedResult = batchResults.find(
      (r) => r.errorClass === "rate_limit" && r.rateLimitScope === "global",
    );
    if (globalRateLimitedResult) {
      for (const skippedMessage of messages.slice(i + batchSize)) {
        results.push(buildUnsentRetryResult(
          skippedMessage,
          "rate_limit",
          globalRateLimitedResult.retryAfterSec,
          "global",
        ));
      }
      break;
    }
  }
  return results;
}

export interface EditMessageOpts {
  disableWebPagePreview?: boolean;
  replyMarkup?: unknown;
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
    await drainResponseBody(res);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Edit an existing chat message's text in place. Used by inline-keyboard
 * flows that want to re-render the same message rather than send a new one
 * (e.g. /list watchlist management pagination).
 *
 * Returns `true` on a 200 response. Body is drained to stay under the
 * Workers 6-connection cap. Callers should treat a `false` return as a hint
 * to fall back to sending a fresh message.
 */
export async function editMessageText(
  chatId: string,
  messageId: number,
  text: string,
  botToken: string,
  options: { replyMarkup?: unknown; disableWebPagePreview?: boolean } = {},
): Promise<boolean> {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/editMessageText`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        ...(options.disableWebPagePreview && { disable_web_page_preview: true }),
        ...(options.replyMarkup != null && { reply_markup: options.replyMarkup }),
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  await drainResponseBody(res);
  return res.ok;
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
}
