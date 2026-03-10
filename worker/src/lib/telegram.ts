export interface TelegramCreds {
  botToken: string;
  chatId: string;
}

/** Escape HTML special characters for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the full Telegram message for a digest. */
function buildTelegramMessage(title: string, extended: string, date: string): string {
  return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(extended)}\n\n<a href="https://pharos.watch/digest/${date}">Read on Pharos →</a>`;
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
): Promise<void> {
  const text = buildTelegramMessage(title, extended, date);
  await postTelegramMessage(text, creds);
  console.log(`[telegram] Posted digest (${text.length} chars)`);
}

export interface SendToChatOpts {
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
}

/** Send an HTML message to a specific Telegram chat. */
export async function sendToChat(
  chatId: string,
  text: string,
  botToken: string,
  opts?: SendToChatOpts,
): Promise<{ ok: boolean; blocked: boolean }> {
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

  if (res.status === 403) {
    await res.text().catch(() => {});
    return { ok: false, blocked: true };
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 300)}`);
  }
  // Consume body to release connection (Workers 6-conn limit)
  await res.json().catch(() => {});
  return { ok: true, blocked: false };
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
}

/**
 * Send messages in parallel batches. Each batch sends up to `batchSize`
 * messages concurrently (must stay <= 6 to respect Workers connection limit).
 * Individual send failures are caught — a single 500 error does NOT abort the batch.
 * Returns one result per input message in the same order.
 */
export async function sendBatch(
  messages: BatchMessage[],
  botToken: string,
  batchSize: number,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (msg) => {
        try {
          const result = await sendToChat(msg.chatId, msg.html, botToken, {
            disableWebPagePreview: true,
            disableNotification: msg.disableNotification,
          });
          return { chatId: msg.chatId, ...result };
        } catch {
          return { chatId: msg.chatId, ok: false, blocked: false };
        }
      }),
    );
    results.push(...batchResults);
  }
  return results;
}
