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
    `<a href="https://pharos.watch/digest/${date}">Read on Pharos →</a>`,
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

export interface SendToChatOpts {
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
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
}

function buildResponseFailure(statusCode: number): SendToChatResult {
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...(opts?.disableWebPagePreview && { disable_web_page_preview: true }),
        ...(opts?.disableNotification && { disable_notification: true }),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const retryAfterRaw = res.headers.get("Retry-After");
      const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : null;
      await drainResponseBody(res);
      const failure = buildResponseFailure(res.status);
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
}

/**
 * Send messages in parallel batches. Each batch sends up to `batchSize`
 * messages concurrently (must stay <= 6 to respect Workers connection limit).
 * Individual send failures are caught — a single 500 error does NOT abort the batch.
 * Returns one result per input message in the same order.
 */
export async function sendBatch(messages: BatchMessage[], botToken: string, batchSize: number): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (msg) => {
        const result = await sendToChat(msg.chatId, msg.html, botToken, {
          disableWebPagePreview: true,
          disableNotification: msg.disableNotification,
        });
        return { chatId: msg.chatId, ...result };
      }),
    );
    results.push(...batchResults);
  }
  return results;
}
