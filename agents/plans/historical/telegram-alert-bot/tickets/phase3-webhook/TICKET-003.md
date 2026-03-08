---
title: "Add webhook handler tests"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Write tests for the Telegram webhook handler covering command routing, subscription CRUD, disambiguation flow, and error handling.

## Context

**Test patterns:** See `worker/src/api/__tests__/feedback.test.ts` for the POST handler test pattern. Use `mockD1` from `./helpers/mock-d1` for D1 mocking. Stub `fetch` globally for `sendToChat` calls.

**Handler signature:** `handleTelegramWebhook(db, request, webhookSecret, botToken)` returns `Response`.

## Task

1. **Create `worker/src/api/__tests__/telegram-webhook.test.ts`**:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { handleTelegramWebhook } = await import("../telegram-webhook");

function makeWebhookRequest(chatId: number, text: string, secret = "test-secret"): Request {
  return new Request(`https://x/api/telegram-webhook?secret=${secret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        chat: { id: chatId, username: "testuser" },
        text,
      },
    }),
  });
}

beforeEach(() => {
  fetchSpy.mockReset();
  // Default: sendToChat succeeds
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

describe("handleTelegramWebhook", () => {
  it("returns 200 for invalid secret", async () => {
    const db = mockD1([]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start", "wrong"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled(); // no reply sent
  });

  it("returns 200 for non-command text", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "hello"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replies to /start", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/start"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("Welcome");
  });

  it("replies to /help", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/help"), "test-secret", "bot-token");
    expect(res.status).toBe(200);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("Commands");
  });

  it("handles /subscribe validation: no tickers", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("ticker");
  });

  it("handles /subscribe validation: no types", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe USDC"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("alert type");
  });

  it("handles /list with no subscriptions", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      { match: "telegram_subscribers", rows: [] },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("No active subscriptions");
  });

  it("replies unknown command", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/foo"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("Unknown command");
  });

  it("handles /subscribe happy path with unique ticker", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      // Subscriber upsert + subscription insert (db.batch)
      { match: "INSERT", rows: [] },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews USDC"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("Subscribed"); // or confirmation message
  });

  it("handles /subscribe with unknown ticker", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews XYZZY"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("Unknown ticker");
  });

  it("handles /subscribe with ambiguous ticker (disambiguation)", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      // INSERT into disambiguation table
      { match: "INSERT", rows: [] },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/subscribe dews GUSD"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("matches"); // disambiguation prompt
  });

  it("handles /unsubscribe all", async () => {
    const db = mockD1([
      { match: "telegram_pending_disambiguation", rows: [] },
      // DELETE + UPDATE batch
      { match: "DELETE", rows: [] },
      { match: "UPDATE", rows: [] },
    ]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe all"), "test-secret", "bot-token");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("unsubscribed"); // or "removed" confirmation
  });

  it("handles D1 error gracefully", async () => {
    const db = mockD1([]);
    // Force first query to throw
    vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("D1 error");
    });
    const res = await handleTelegramWebhook(db, makeWebhookRequest(123, "/list"), "test-secret", "bot-token");
    expect(res.status).toBe(200); // always 200
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.text).toContain("Something went wrong");
  });
});
```

## Acceptance Criteria

- `worker/src/api/__tests__/telegram-webhook.test.ts` exists
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
