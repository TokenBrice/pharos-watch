---
title: "Add TELEGRAM_WEBHOOK_SECRET to Env and extend telegram lib"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Add the webhook secret to the Env interface and extend the Telegram utility module with a `sendToChat` helper for sending messages to individual users.

## Task

1. **`worker/src/lib/env.ts`** (line ~23, after `TELEGRAM_CHAT_ID`):
   Add `TELEGRAM_WEBHOOK_SECRET?: string;` to the `Env` interface.

2. **`worker/src/lib/telegram.ts`**:
   - Make `escapeHtml` exported (currently private — line 7, add `export` keyword). Phase 2 will import it.
   - Make `postTelegramMessage` exported (currently not exported — line 20, add `export` keyword).
   - Add a new exported function `sendToChat` after `postDigestToTelegram`:

```typescript
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
```

3. **Create `worker/src/lib/__tests__/telegram.test.ts`**:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { sendToChat } = await import("../telegram");

beforeEach(() => {
  fetchSpy.mockReset();
});

describe("sendToChat", () => {
  it("sends HTML message and returns ok", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await sendToChat("12345", "<b>Test</b>", "bot-token");
    expect(result).toEqual({ ok: true, blocked: false });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.chat_id).toBe("12345");
    expect(body.parse_mode).toBe("HTML");
  });

  it("returns blocked: true on 403", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toEqual({ ok: false, blocked: true });
  });

  it("throws on non-403 error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    await expect(sendToChat("12345", "test", "bot-token")).rejects.toThrow("Telegram API 500");
  });

  it("passes disable_web_page_preview when set", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendToChat("12345", "test", "bot-token", { disableWebPagePreview: true });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.disable_web_page_preview).toBe(true);
  });

  it("passes disable_notification when set", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendToChat("12345", "test", "bot-token", { disableNotification: true });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.disable_notification).toBe(true);
  });
});
```

## Acceptance Criteria

- `grep -c 'TELEGRAM_WEBHOOK_SECRET' worker/src/lib/env.ts` returns 1
- `grep -c 'export function escapeHtml' worker/src/lib/telegram.ts` returns 1
- `grep -c 'export async function sendToChat' worker/src/lib/telegram.ts` returns 1
- `grep -c 'export async function postTelegramMessage' worker/src/lib/telegram.ts` returns 1
- `worker/src/lib/__tests__/telegram.test.ts` exists
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
