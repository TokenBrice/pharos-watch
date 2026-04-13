# Telegram Bot Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all issues found in the Telegram bot reliability audit and close test coverage gaps, ensuring every subscriber gets their notifications reliably.

**Architecture:** TDD approach — write a failing test that exposes each bug, then fix the bug. Test coverage tasks add dedicated test files for modules that were only tested indirectly (pending queue, snapshots, messages, resolution, pulse). All changes are worker-side; no frontend changes.

**Tech Stack:** Vitest, Cloudflare Workers, D1 (SQLite), Telegram Bot API

**Deferred:** Audit Critical #3 (snapshot write not crash-safe — duplicate alerts on timeout) is deferred. The `isSnapshotMissingOrStale` 24h staleness check limits blast radius, and a proper fix requires either write-ahead logging or an idempotency key per dispatch run — both significant changes beyond this plan's scope. Track separately if duplicate alerts are observed in production.

---

## File Map

### Modified files

| File | Change |
|------|--------|
| `worker/src/cron/telegram-pending-queue.ts:31-54` | Add `alert_launch=0, global_alert_launch=0` to `disableBlockedSubscriber()` |
| `worker/src/api/telegram-webhook.ts:364-381` | Add `alert_launch=0, global_alert_launch=0` to `/unsubscribe all` SQL |
| `worker/src/cron/telegram-pending-queue.ts:119` | Increase retry cap from 2 to 5 |
| `worker/src/api/telegram-webhook.ts:538-540` | Log non-ok results from `replyToChat()` |
| `worker/src/lib/telegram.ts:87-162` | Add `retryAfterSec` field; parse `Retry-After` header on 429 |
| `worker/src/cron/telegram-pending-queue.ts:95-107` | Stop batch on 429 (respect rate limit) |
| `worker/src/cron/dispatch-telegram-routing.ts:167-175` | Stop batch on 429 in fresh delivery |
| `worker/src/lib/telegram-alerts.ts:306-355` | HTML-safe fallback in `splitMessage()` character split |

### New test files

| File | Tests for |
|------|-----------|
| `worker/src/cron/__tests__/telegram-pending-queue.test.ts` | `drainPendingQueue`, `enqueuePendingAlerts`, `cleanupExpiredPendingAlerts`, `disableBlockedSubscriber` |
| `worker/src/cron/__tests__/telegram-alert-snapshots.test.ts` | `buildDewsSnapshot`, `buildDepegSnapshot`, `buildSafetySnapshot`, `parseSnapshotMap`, `isSnapshotMissingOrStale`, `extractTopSignals`, `isSafetyDeescalation` |
| `worker/src/api/__tests__/telegram-webhook-messages.test.ts` | `buildNotFoundMessage`, `buildSubscriptionSummaryMessage`, `buildListMessage`, `describeSubscriptionSettings`, `formatQuietHours` |
| `worker/src/api/__tests__/telegram-webhook-resolution.test.ts` | `resolveCoinTargets`, `runCoinResolutionFlow` |

### Modified test files

| File | Added tests |
|------|-------------|
| `worker/src/lib/__tests__/telegram.test.ts` | 429 rate-limit classification, timeout classification, `retryAfterSec` parsing |
| `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts` | Blocked subscriber launch flag cleanup, 429 batch-stop behavior |
| `worker/src/api/__tests__/telegram-webhook.test.ts` | `/unsubscribe all` clears launch flags |

---

## Task 1: Fix `disableBlockedSubscriber` — missing `alert_launch` reset

The function disables all alert flags when a user blocks the bot, but omits `alert_launch` and `global_alert_launch`. Blocked users keep receiving (and failing) launch alert attempts every dispatch cycle.

**Files:**
- Modify: `worker/src/cron/telegram-pending-queue.ts:31-54`
- Test: `worker/src/cron/__tests__/telegram-pending-queue.test.ts` (new file, started here)

- [ ] **Step 1: Create test file with failing test for launch flag reset**

```typescript
// worker/src/cron/__tests__/telegram-pending-queue.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const mockSendToChat = vi.fn();

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return { ...actual, sendToChat: mockSendToChat };
});

const { disableBlockedSubscriber, drainPendingQueue, enqueuePendingAlerts, cleanupExpiredPendingAlerts, PENDING_TTL_SEC } =
  await import("../telegram-pending-queue");

beforeEach(() => {
  mockSendToChat.mockReset();
});

describe("disableBlockedSubscriber", () => {
  it("resets all alert flags including launch for both subscribers and subscriptions", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
    ]);

    const result = await disableBlockedSubscriber(db, "blocked-chat");
    expect(result).toBe(true);

    const history = db.getHistory();
    const subscriberUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscribers"));
    expect(subscriberUpdate).toBeDefined();
    expect(subscriberUpdate!.sql).toContain("alert_launch=0");
    expect(subscriberUpdate!.sql).toContain("global_alert_launch=0");

    const subscriptionUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscriptions"));
    expect(subscriptionUpdate).toBeDefined();
    expect(subscriptionUpdate!.sql).toContain("alert_launch=0");
  });

  it("returns false and logs on D1 error", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", throwError: new Error("D1 overload") },
    ]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await disableBlockedSubscriber(db, "bad-chat");
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-pending-queue.test.ts --reporter verbose 2>&1 | tail -20`

Expected: FAIL — the SQL does not contain `alert_launch=0` or `global_alert_launch=0`

- [ ] **Step 3: Fix `disableBlockedSubscriber` to include launch flags**

In `worker/src/cron/telegram-pending-queue.ts`, replace the batch statements (lines 32-54):

```typescript
export async function disableBlockedSubscriber(db: D1Database, chatId: string): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE telegram_subscribers
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0,
                  global_alert_dews=0,
                  global_alert_depeg=0,
                  global_alert_safety=0,
                  global_alert_launch=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
      db
        .prepare(
          `UPDATE telegram_subscriptions
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
    ]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-pending-queue] Failed to disable blocked subscriber ${chatId}: ${message}`);
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-pending-queue.test.ts --reporter verbose 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/telegram-pending-queue.ts worker/src/cron/__tests__/telegram-pending-queue.test.ts
git commit -m "fix(telegram): include alert_launch in disableBlockedSubscriber

Blocked users retained alert_launch and global_alert_launch flags,
causing repeated failed delivery attempts every dispatch cycle."
```

---

## Task 2: Fix `/unsubscribe all` — missing launch flag reset

`/unsubscribe all` resets dews/depeg/safety but not launch flags. Users who think they fully unsubscribed still receive launch alerts.

**Files:**
- Modify: `worker/src/api/telegram-webhook.ts:364-381`
- Test: `worker/src/api/__tests__/telegram-webhook.test.ts` (append)

- [ ] **Step 1: Write failing test for `/unsubscribe all` clearing launch flags**

Append to `worker/src/api/__tests__/telegram-webhook.test.ts`, inside the existing `describe("handleTelegramWebhook")` block:

```typescript
  it("unsubscribe all clears launch alert flags", async () => {
    const db = mockD1([{ match: "telegram_pending_disambiguation", rows: [] }]);
    await handleTelegramWebhook(db, makeWebhookRequest(123, "/unsubscribe all"), "test-secret", "bot-token");

    const history = db.getHistory();
    const updateSql = history.find((e) => e.sql.includes("UPDATE telegram_subscribers"));
    expect(updateSql).toBeDefined();
    expect(updateSql!.sql).toContain("alert_launch = 0");
    expect(updateSql!.sql).toContain("global_alert_launch = 0");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/api/__tests__/telegram-webhook.test.ts -t "unsubscribe all clears launch" --reporter verbose 2>&1 | tail -20`

Expected: FAIL — the UPDATE SQL does not contain `alert_launch = 0`

- [ ] **Step 3: Fix the `/unsubscribe all` SQL**

In `worker/src/api/telegram-webhook.ts`, replace the UPDATE statement inside `handleUnsubscribe` (lines 368-380):

```typescript
      db
        .prepare(
          `UPDATE telegram_subscribers
            SET alert_dews = 0,
                alert_depeg = 0,
                alert_safety = 0,
                alert_launch = 0,
                global_alert_dews = 0,
                global_alert_depeg = 0,
                global_alert_safety = 0,
                global_alert_launch = 0,
                last_active_at = ?
          WHERE chat_id = ?`,
        )
        .bind(now, chatId),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/api/__tests__/telegram-webhook.test.ts -t "unsubscribe all clears launch" --reporter verbose 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/telegram-webhook.ts worker/src/api/__tests__/telegram-webhook.test.ts
git commit -m "fix(telegram): /unsubscribe all now clears launch alert flags

Previously left alert_launch and global_alert_launch set, so users
who fully unsubscribed still received launch notifications."
```

---

## Task 3: Increase pending queue retry cap

Messages are dropped after only 2 attempts (10 minutes). A short Telegram outage causes permanent message loss. Increase to 5 attempts while keeping the 1-hour TTL as the hard ceiling.

**Files:**
- Modify: `worker/src/cron/telegram-pending-queue.ts:119`
- Test: `worker/src/cron/__tests__/telegram-pending-queue.test.ts` (append)

- [ ] **Step 1: Write test that verifies messages survive >2 retryable failures**

Append to the test file created in Task 1, inside a new `describe("drainPendingQueue")` block:

```typescript
describe("drainPendingQueue", () => {
  it("retries messages up to 5 attempts before dropping", async () => {
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 500,
      errorClass: "server_error",
      delivery: "retryable_failure",
      retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [
          { id: 1, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 2 },
          { id: 2, chat_id: "200", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 4 },
          { id: 3, chat_id: "300", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 5 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    // id 1 (attempts=2) and id 2 (attempts=4) are below cap → retryQueued
    // id 3 (attempts=5) hits cap → dropped
    expect(result.retryQueued).toBe(2);
    expect(result.dropped).toBe(1);
  });

  it("deletes successfully sent messages from the queue", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [
          { id: 10, chat_id: "100", message_html: "<b>Sent</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.sent).toBe(1);
    expect(result.attempted).toBe(1);

    const history = db.getHistory();
    const deleteCall = history.find((e) => e.sql.includes("DELETE FROM telegram_pending_alerts WHERE id IN"));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.binds).toContain(10);
  });

  it("disables blocked subscribers and deletes their pending messages", async () => {
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 403, errorClass: "blocked", delivery: "blocked", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT id, chat_id, message_html",
        rows: [
          { id: 20, chat_id: "blocked-chat", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.blocked).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("returns zeros when queue is empty", async () => {
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result).toEqual({ attempted: 0, sent: 0, blocked: 0, blockedCleanupFailed: 0, retryQueued: 0, dropped: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify the retry cap test fails**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-pending-queue.test.ts -t "retries messages up to 5" --reporter verbose 2>&1 | tail -20`

Expected: FAIL — with cap at 2, id 1 (attempts=2) would be dropped instead of retried

- [ ] **Step 3: Increase retry cap to 5**

In `worker/src/cron/telegram-pending-queue.ts`, line 119, change:

```typescript
      } else if (result.retryable && result.attempts < 5) {
```

- [ ] **Step 4: Run all pending queue tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-pending-queue.test.ts --reporter verbose 2>&1 | tail -30`

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/telegram-pending-queue.ts worker/src/cron/__tests__/telegram-pending-queue.test.ts
git commit -m "fix(telegram): increase pending queue retry cap from 2 to 5

Two attempts meant a 15-minute Telegram outage permanently dropped
messages. Five attempts with the 1-hour TTL gives more runway."
```

---

## Task 4: Add `retryAfterSec` to `SendToChatResult` and parse 429 headers

When Telegram returns 429, we need to know how long to back off. Currently the code ignores the `Retry-After` header.

**Files:**
- Modify: `worker/src/lib/telegram.ts:87-162`
- Test: `worker/src/lib/__tests__/telegram.test.ts` (append)

- [ ] **Step 1: Write tests for 429 rate-limit classification and Retry-After parsing**

Append to `worker/src/lib/__tests__/telegram.test.ts`, inside the `describe("sendToChat")` block:

```typescript
  it("returns rate_limit with retryAfterSec on 429", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toMatchObject({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
    });
    expect(result.retryAfterSec).toBe(30);
  });

  it("returns retryAfterSec null when 429 has no Retry-After header", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result.retryAfterSec).toBeNull();
  });

  it("returns retryAfterSec null for non-429 errors", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result.retryAfterSec).toBeNull();
  });

  it("classifies timeout as retryable", async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      errorClass: "timeout",
      retryAfterSec: null,
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/lib/__tests__/telegram.test.ts -t "retryAfterSec" --reporter verbose 2>&1 | tail -20`

Expected: FAIL — `retryAfterSec` property does not exist on `SendToChatResult`

- [ ] **Step 3: Add `retryAfterSec` to the type and parse it**

In `worker/src/lib/telegram.ts`:

Add `retryAfterSec` to the `SendToChatResult` interface (after line 94):

```typescript
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
```

Add `retryAfterSec: null` to every return in `buildResponseFailure()` and `buildCaughtFailure()`. Example for 429:

```typescript
  if (statusCode === 429) {
    return {
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: null, // populated by caller with header value
    };
  }
```

In `sendToChat()`, parse the header and override:

```typescript
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
```

And for the success path, add `retryAfterSec: null`:

```typescript
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
```

Also add `retryAfterSec: null` to `buildCaughtFailure()` return values and add `retryAfterSec` to `BatchResult` interface.

- [ ] **Step 3b: Update existing test mock defaults to include `retryAfterSec`**

In `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`, update the `beforeEach` mock (line 45-53) to include the new field:

```typescript
  mockSendToChat.mockResolvedValue({
    ok: true,
    blocked: false,
    retryable: false,
    permanentFailure: false,
    statusCode: 200,
    errorClass: null,
    delivery: "sent",
    retryAfterSec: null,
  });
```

Also update the `mockGetCache` in the "deactivates subscriber on blocked telegram response" test (line 616-627) to include all 5 cache keys:

```typescript
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:dews-alertable-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:launch-snapshot") return { value: JSON.stringify([]), updatedAt: now - 60 };
      return null;
    });
```

And the same for the "drains pending queue" test (line 658-663) and "queues retryable fresh-send failures" test (line 815-820).

Also update the blocked mock in the "deactivates subscriber on blocked telegram response" test (line 607-615):

```typescript
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 403,
      errorClass: "blocked",
      delivery: "blocked",
      retryAfterSec: null,
    });
```

And the retryable mock in the "queues retryable fresh-send failures" test (line 805-813):

```typescript
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 500,
      errorClass: "server_error",
      delivery: "retryable_failure",
      retryAfterSec: null,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/lib/__tests__/telegram.test.ts --reporter verbose 2>&1 | tail -30`

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/telegram.ts worker/src/lib/__tests__/telegram.test.ts
git commit -m "feat(telegram): parse Retry-After header on 429 responses

Adds retryAfterSec to SendToChatResult and BatchResult so callers
can respect Telegram's rate-limit window."
```

---

## Task 5: Stop batch sending on 429 rate limit

When a 429 is received mid-batch, remaining messages should be enqueued rather than hammering Telegram.

**Files:**
- Modify: `worker/src/cron/telegram-pending-queue.ts:95-107`
- Modify: `worker/src/cron/dispatch-telegram-routing.ts:167-175`
- Test: `worker/src/cron/__tests__/telegram-pending-queue.test.ts` (append)
- Test: `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts` (append)

- [ ] **Step 1: Write test for pending drain stopping on 429**

Append to `worker/src/cron/__tests__/telegram-pending-queue.test.ts`:

```typescript
  it("stops draining the queue when a 429 rate limit is received", async () => {
    // SEND_BATCH_SIZE=5, so we need >5 messages to span multiple batches.
    // First batch (5 msgs): 4 ok + 1 rate_limit. Sets rateLimited=true.
    // Second batch (3 msgs): never attempted because rateLimited flag breaks the loop.
    const okResult = {
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    };
    const rateLimitResult = {
      ok: false, blocked: false, retryable: true, permanentFailure: false,
      statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 30,
    };

    // First 4 calls succeed, 5th returns 429 (within first batch of 5)
    mockSendToChat
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(rateLimitResult);

    // 8 pending messages → batch 1 (ids 1-5), batch 2 (ids 6-8)
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, chat_id: `chat-${i}`, message_html: `msg${i}`, disable_notification: 0, created_at: 1000, attempts: 0,
    }));

    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 20);

    // Only first batch of 5 was attempted; second batch of 3 was skipped
    expect(result.attempted).toBe(5);
    expect(result.sent).toBe(4);
    expect(result.retryQueued).toBe(1);
    // sendToChat was called exactly 5 times (not 8)
    expect(mockSendToChat).toHaveBeenCalledTimes(5);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-pending-queue.test.ts -t "stops draining" --reporter verbose 2>&1 | tail -20`

Expected: FAIL — currently all 3 messages are attempted

- [ ] **Step 3: Implement 429 batch-stop in `drainPendingQueue`**

In `worker/src/cron/telegram-pending-queue.ts`, add a `rateLimited` flag before the batch loop and break on 429:

```typescript
  let rateLimited = false;

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted || rateLimited) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        const result = await sendToChat(row.chat_id, row.message_html, botToken, {
          disableWebPagePreview: true,
          disableNotification: row.disable_notification === 1,
        });
        return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ...result };
      }),
    );

    for (const result of results) {
      attempted++;
      if (result.ok) {
        sent++;
        idsToDelete.push(result.id);
      } else if (result.blocked) {
        blocked++;
        idsToDelete.push(result.id);
        if (!(await disableBlockedSubscriber(db, result.chatId))) {
          blockedCleanupFailed++;
        }
      } else if (result.retryable && result.attempts < 5) {
        retryQueued++;
        idsToRetry.push(result.id);
        if (result.errorClass === "rate_limit") rateLimited = true;
      } else {
        dropped++;
        idsToDelete.push(result.id);
      }
    }
  }
```

- [ ] **Step 4: Implement 429 batch-stop in `deliverFreshAlerts`**

In `worker/src/cron/dispatch-telegram-routing.ts`, the `deliverFreshAlerts` function calls `sendBatch()` which sends all messages. We need to modify `sendBatch()` in `worker/src/lib/telegram.ts` to stop on 429.

Add early exit to `sendBatch()` (in `worker/src/lib/telegram.ts`).

Note: The 429 abort is batch-boundary-granular — messages within the same parallel batch (up to `batchSize`) are all in-flight via `Promise.all` before the rate-limit check runs. This is acceptable because `batchSize` is 5 (well under Telegram's ~30/sec limit), and the primary goal is preventing subsequent batches from firing.

```typescript
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
    // Stop sending further batches on rate limit — in-flight parallel sends
    // within this batch have already completed via Promise.all above.
    if (batchResults.some((r) => r.errorClass === "rate_limit")) break;
  }
  return results;
}
```

- [ ] **Step 5: Run all pending queue tests**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-pending-queue.test.ts --reporter verbose 2>&1 | tail -30`

Expected: All PASS

- [ ] **Step 6: Run the full telegram test suite to check for regressions**

Run: `cd worker && npx vitest run --reporter verbose 2>&1 | grep -E "PASS|FAIL|telegram" | head -20`

Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/telegram.ts worker/src/cron/telegram-pending-queue.ts worker/src/cron/dispatch-telegram-routing.ts worker/src/cron/__tests__/telegram-pending-queue.test.ts
git commit -m "fix(telegram): stop batch sending on 429 rate limit

When Telegram returns 429, remaining messages in the batch are now
skipped. This prevents cascading rate-limit failures and lets the
pending queue drain naturally in subsequent cycles."
```

---

## Task 6: Log webhook reply failures

`replyToChat()` discards `SendToChatResult`. Non-ok replies silently fail with no observability.

**Files:**
- Modify: `worker/src/api/telegram-webhook.ts:538-540`

- [ ] **Step 1: Add warn-level logging to `replyToChat`**

```typescript
async function replyToChat(chatId: string, message: string, botToken: string): Promise<void> {
  const result = await sendToChat(chatId, message, botToken, { disableWebPagePreview: true });
  if (!result.ok) {
    console.warn(`[telegram-webhook] Reply to ${chatId} failed: ${result.errorClass ?? "unknown"} (${result.statusCode})`);
  }
}
```

- [ ] **Step 2: Run webhook tests to verify no regressions**

Run: `cd worker && npx vitest run src/api/__tests__/telegram-webhook.test.ts --reporter verbose 2>&1 | tail -20`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/telegram-webhook.ts
git commit -m "fix(telegram): log failed webhook reply sends

Adds warn-level logging when replyToChat fails (rate limit, blocked,
etc.) for operational visibility."
```

---

## Task 7: HTML-safe message splitting

`splitMessage()` can break HTML tags when doing character-boundary splits. Telegram rejects malformed HTML with 400 (permanent failure), losing the message.

**Files:**
- Modify: `worker/src/lib/telegram-alerts.ts:306-355`
- Test: `worker/src/lib/__tests__/telegram-alerts.test.ts` (append)

- [ ] **Step 1: Write test for HTML tag safety in character splits**

Append to the existing test file `worker/src/lib/__tests__/telegram-alerts.test.ts`. The file already imports `splitMessage` at the top — use it directly (do NOT use `require()`):

```typescript
describe("splitMessage HTML safety", () => {
  it("does not break HTML tags at character boundaries", () => {
    // Build a long line with an HTML tag near the split boundary
    const longText = "<b>" + "x".repeat(3990) + "</b>" + "\n\n" + "<b>second</b>";
    const chunks = splitMessage(longText, 4000);
    // Every chunk with a <b> must also have </b>
    for (const chunk of chunks) {
      const opens = (chunk.match(/<b>/g) ?? []).length;
      const closes = (chunk.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("strips tags from chunks that would have broken HTML", () => {
    // A single long line that forces character-boundary splitting mid-tag
    const longLine = "x".repeat(3995) + "<b>bold</b>";
    const chunks = splitMessage(longLine, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const opens = (chunk.match(/<b>/g) ?? []).length;
      const closes = (chunk.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/telegram-alerts.test.ts -t "HTML safety" --reporter verbose 2>&1 | tail -20`

Expected: FAIL — the character split breaks mid-tag

- [ ] **Step 3: Add tag repair to `splitMessage`**

In `worker/src/lib/telegram-alerts.ts`, add a helper function before `splitMessage` and apply it to the hard-split chunks:

```typescript
/**
 * Repair a chunk that may have broken HTML tags from a hard character split.
 * Assumes input has been through escapeHtml() so literal > is encoded as &gt;.
 * Only safe for pre-escaped Telegram HTML (the only context splitMessage is used).
 */
function repairBrokenHtml(chunk: string): string {
  // Remove a trailing partial tag (e.g., "<b" or "<a href=\"...")
  let repaired = chunk.replace(/<[^>]*$/, "");
  // Remove a leading fragment from a tag that was split (e.g., 'ref="...">text</a>').
  // Only strip if the leading content looks like a tag attribute/close, not plain text.
  // Match: optional non-< chars followed by > but only when no < precedes the >.
  // This is safe because escapeHtml converts literal > to &gt;, so bare > in
  // pre-escaped content only appears inside HTML tags.
  repaired = repaired.replace(/^[^<]*>/, "");

  // Balance simple tags: <b>, <i>, <a>, <code>, <pre>
  const tags = ["b", "i", "code", "pre"];
  for (const tag of tags) {
    const openCount = (repaired.match(new RegExp(`<${tag}[> ]`, "g")) ?? []).length;
    const closeCount = (repaired.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    if (openCount > closeCount) {
      repaired += `</${tag}>`.repeat(openCount - closeCount);
    } else if (closeCount > openCount) {
      repaired = `<${tag}>`.repeat(closeCount - openCount) + repaired;
    }
  }
  // Handle <a> separately (has attributes)
  const aOpens = (repaired.match(/<a[\s>]/g) ?? []).length;
  const aCloses = (repaired.match(/<\/a>/g) ?? []).length;
  if (aOpens > aCloses) {
    repaired += "</a>".repeat(aOpens - aCloses);
  } else if (aCloses > aOpens) {
    // Strip orphaned </a> rather than prepending a fake <a>
    let surplus = aCloses - aOpens;
    repaired = repaired.replace(/<\/a>/g, (match) => {
      if (surplus > 0) { surplus--; return ""; }
      return match;
    });
  }
  return repaired;
}
```

Then in `splitOversizedSection`, apply the repair after the hard character split:

```typescript
      for (let index = 0; index < line.length; index += limit) {
        parts.push(repairBrokenHtml(line.slice(index, index + limit)));
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/lib/__tests__/telegram-alerts.test.ts -t "HTML safety" --reporter verbose 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 5: Run full telegram-alerts test suite**

Run: `cd worker && npx vitest run src/lib/__tests__/telegram-alerts.test.ts --reporter verbose 2>&1 | tail -20`

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/telegram-alerts.ts worker/src/lib/__tests__/telegram-alerts.test.ts
git commit -m "fix(telegram): repair broken HTML tags in hard character splits

splitMessage now repairs chunks from character-boundary splits to
ensure balanced HTML tags. Prevents Telegram 400 rejections that
would permanently drop messages."
```

---

## Task 8: Test suite — `telegram-alert-snapshots.ts`

This module has zero dedicated tests. It's exercised indirectly through dispatch tests but the individual functions are not verified.

**Files:**
- Create: `worker/src/cron/__tests__/telegram-alert-snapshots.test.ts`

- [ ] **Step 1: Write the snapshot test suite**

```typescript
// worker/src/cron/__tests__/telegram-alert-snapshots.test.ts
import { describe, it, expect } from "vitest";
import {
  buildDewsSnapshot,
  buildDewsAlertableSnapshot,
  buildDepegSnapshot,
  buildSafetySnapshot,
  filterAlertableBands,
  parseSnapshotMap,
  isSnapshotMissingOrStale,
  extractTopSignals,
  isSafetyDeescalation,
  SNAPSHOT_MAX_AGE_SEC,
  type DewsRow,
  type ActiveDepegRow,
  type SafetyRow,
} from "../telegram-alert-snapshots";

describe("parseSnapshotMap", () => {
  it("parses valid JSON into a record", () => {
    const cached = { value: JSON.stringify({ "usdc-circle": "ALERT" }), updatedAt: 1000 };
    expect(parseSnapshotMap(cached)).toEqual({ "usdc-circle": "ALERT" });
  });

  it("returns null for null input", () => {
    expect(parseSnapshotMap(null)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSnapshotMap({ value: "not json{", updatedAt: 1000 })).toBeNull();
  });

  it("returns null for array JSON", () => {
    expect(parseSnapshotMap({ value: "[]", updatedAt: 1000 })).toBeNull();
  });

  it("returns null for primitive JSON", () => {
    expect(parseSnapshotMap({ value: '"string"', updatedAt: 1000 })).toBeNull();
  });
});

describe("isSnapshotMissingOrStale", () => {
  it("returns true for null cache", () => {
    expect(isSnapshotMissingOrStale(null, 1000)).toBe(true);
  });

  it("returns true when snapshot is older than max age", () => {
    const cached = { value: "{}", updatedAt: 1000 };
    expect(isSnapshotMissingOrStale(cached, 1000 + SNAPSHOT_MAX_AGE_SEC + 1)).toBe(true);
  });

  it("returns false when snapshot is fresh", () => {
    const cached = { value: "{}", updatedAt: 1000 };
    expect(isSnapshotMissingOrStale(cached, 1000 + 60)).toBe(false);
  });
});

describe("buildDewsSnapshot", () => {
  it("maps rows to stablecoinId → band", () => {
    const rows: DewsRow[] = [
      { stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: null },
      { stablecoin_id: "dai-maker", score: 10, band: "CALM", signals_json: null },
    ];
    expect(buildDewsSnapshot(rows)).toEqual({
      "usdc-circle": "ALERT",
      "dai-maker": "CALM",
    });
  });

  it("returns empty object for empty input", () => {
    expect(buildDewsSnapshot([])).toEqual({});
  });
});

describe("buildDewsAlertableSnapshot", () => {
  it("only includes alertable bands and preserves previous entries", () => {
    const rows: DewsRow[] = [
      { stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: null },
      { stablecoin_id: "dai-maker", score: 10, band: "CALM", signals_json: null },
    ];
    const previous = { "old-coin": "WARNING" };
    const result = buildDewsAlertableSnapshot(rows, previous);
    expect(result).toEqual({
      "old-coin": "WARNING",
      "usdc-circle": "ALERT",
    });
    // CALM should NOT appear
    expect(result["dai-maker"]).toBeUndefined();
  });

  it("builds from scratch when no previous snapshot is provided", () => {
    const rows: DewsRow[] = [
      { stablecoin_id: "usdc-circle", score: 42, band: "WARNING", signals_json: null },
      { stablecoin_id: "dai-maker", score: 10, band: "CALM", signals_json: null },
    ];
    const result = buildDewsAlertableSnapshot(rows);
    expect(result).toEqual({ "usdc-circle": "WARNING" });
  });
});

describe("filterAlertableBands", () => {
  it("filters to only ALERT/WARNING/DANGER", () => {
    const snapshot = { a: "ALERT", b: "CALM", c: "WARNING", d: "WATCH", e: "DANGER" };
    expect(filterAlertableBands(snapshot)).toEqual({ a: "ALERT", c: "WARNING", e: "DANGER" });
  });

  it("returns empty object for null", () => {
    expect(filterAlertableBands(null)).toEqual({});
  });
});

describe("buildDepegSnapshot", () => {
  it("maps active depeg rows to structured payloads", () => {
    const rows: ActiveDepegRow[] = [{
      stablecoin_id: "usdc-circle",
      symbol: "USDC",
      direction: "below",
      peak_deviation_bps: 150,
      start_price: 0.985,
      peg_reference: 1,
    }];
    const result = buildDepegSnapshot(rows);
    expect(result["usdc-circle"]).toEqual({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      direction: "below",
      deviationBps: 150,
      price: 0.985,
      pegReference: 1,
    });
  });
});

describe("buildSafetySnapshot", () => {
  it("maps safety rows to grade/score/version", () => {
    const rows: SafetyRow[] = [{
      stablecoin_id: "usdc-circle",
      grade: "A",
      score: 92,
      prev_grade: "B+",
      prev_score: 85,
      recorded_at: 1000,
      methodology_version: "v2",
    }];
    expect(buildSafetySnapshot(rows)).toEqual({
      "usdc-circle": { grade: "A", score: 92, methodologyVersion: "v2" },
    });
  });

  it("handles null score and methodology_version", () => {
    const rows: SafetyRow[] = [{
      stablecoin_id: "x",
      grade: "NR",
      score: null,
      prev_grade: null,
      prev_score: null,
      recorded_at: 1000,
      methodology_version: null,
    }];
    expect(buildSafetySnapshot(rows)).toEqual({
      x: { grade: "NR", score: null, methodologyVersion: null },
    });
  });
});

describe("extractTopSignals", () => {
  it("returns top 2 signals sorted by value descending", () => {
    const json = JSON.stringify({
      liquidity: { value: 0.8, available: true },
      volatility: { value: 0.5, available: true },
      reserves: { value: 0.9, available: true },
    });
    const result = extractTopSignals(json);
    expect(result).toEqual([
      { name: "reserves", value: 0.9 },
      { name: "liquidity", value: 0.8 },
    ]);
  });

  it("returns empty array for null input", () => {
    expect(extractTopSignals(null)).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(extractTopSignals("not json")).toEqual([]);
  });

  it("excludes signals with available=false", () => {
    const json = JSON.stringify({
      liquidity: { value: 0.8, available: false },
      volatility: { value: 0.5, available: true },
    });
    expect(extractTopSignals(json)).toEqual([{ name: "volatility", value: 0.5 }]);
  });
});

describe("isSafetyDeescalation", () => {
  it("returns true when new grade is higher rank", () => {
    expect(isSafetyDeescalation("B", "A")).toBe(true);
  });

  it("returns false when new grade is lower rank", () => {
    expect(isSafetyDeescalation("A", "B")).toBe(false);
  });

  it("returns false for unknown grades", () => {
    expect(isSafetyDeescalation("X", "A")).toBe(false);
  });

  it("returns false for equal grades", () => {
    expect(isSafetyDeescalation("B", "B")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-alert-snapshots.test.ts --reporter verbose 2>&1 | tail -30`

Expected: All PASS (these test existing correct behavior)

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/__tests__/telegram-alert-snapshots.test.ts
git commit -m "test(telegram): add dedicated tests for telegram-alert-snapshots

Covers parseSnapshotMap, isSnapshotMissingOrStale, buildDewsSnapshot,
buildDewsAlertableSnapshot, buildDepegSnapshot, buildSafetySnapshot,
extractTopSignals, filterAlertableBands, and isSafetyDeescalation."
```

---

## Task 9: Test suite — `telegram-webhook-messages.ts`

Message formatting functions have zero test coverage.

**Files:**
- Create: `worker/src/api/__tests__/telegram-webhook-messages.test.ts`

- [ ] **Step 1: Write the messages test suite**

```typescript
// worker/src/api/__tests__/telegram-webhook-messages.test.ts
import { describe, it, expect } from "vitest";
import {
  buildNotFoundMessage,
  buildUnsubscribeSuccessMessage,
  buildSubscriptionSummaryMessage,
  buildGlobalAlertSummaryMessage,
  buildListMessage,
  describeSubscriptionSettings,
  describeGlobalAlertSettings,
  formatQuietHours,
} from "../telegram-webhook-messages";
import type { SubscriberRow, SubscriptionRow } from "../telegram-webhook-shared";

describe("buildNotFoundMessage", () => {
  it("includes the unknown ticker", () => {
    const msg = buildNotFoundMessage("XYZZY");
    expect(msg).toContain("XYZZY");
    expect(msg).toContain("not found");
  });

  it("includes suggestion when provided", () => {
    const msg = buildNotFoundMessage("UDS", { id: "usdc-circle", symbol: "USDC", name: "USD Coin" });
    expect(msg).toContain("USDC");
    expect(msg).toContain("Did you mean");
  });

  it("escapes HTML in ticker", () => {
    const msg = buildNotFoundMessage("<script>");
    expect(msg).not.toContain("<script>");
    expect(msg).toContain("&lt;script&gt;");
  });
});

describe("buildUnsubscribeSuccessMessage", () => {
  it("reports correct count for single coin", () => {
    const msg = buildUnsubscribeSuccessMessage([{ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }]);
    expect(msg).toContain("1 coin subscription");
    expect(msg).not.toContain("subscriptions");
  });

  it("reports correct count for multiple coins", () => {
    const msg = buildUnsubscribeSuccessMessage([
      { id: "usdc-circle", symbol: "USDC", name: "USD Coin" },
      { id: "dai-maker", symbol: "DAI", name: "Dai" },
    ]);
    expect(msg).toContain("2 coin subscriptions");
  });
});

describe("buildSubscriptionSummaryMessage", () => {
  it("includes header and formatted subscription rows", () => {
    const subscriptions: SubscriptionRow[] = [
      {
        stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
        dews_min_band: "WARNING", safety_mode: null, depeg_worsening_bps_step: null,
      },
    ];
    const msg = buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions);
    expect(msg).toContain("Updated subscriptions.");
    expect(msg).toContain("Coins (1)");
    expect(msg).toContain("DEWS&gt;=WARNING");
  });
});

describe("describeSubscriptionSettings", () => {
  it("shows DEWS with min band", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: "WARNING", safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("DEWS>=WARNING");
  });

  it("shows all types", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 1, alert_depeg: 1, alert_safety: 1, alert_launch: 1,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("DEWS, Depeg, Safety, Launch");
  });

  it("shows Muted when no types enabled", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("Muted");
  });

  it("shows safety mode", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 0, alert_safety: 1, alert_launch: 0,
      dews_min_band: null, safety_mode: "downgrade-only", depeg_worsening_bps_step: null,
    };
    expect(describeSubscriptionSettings(row)).toBe("Safety downgrade-only");
  });

  it("shows depeg step", () => {
    const row: SubscriptionRow = {
      stablecoin_id: "x", alert_dews: 0, alert_depeg: 1, alert_safety: 0, alert_launch: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: 250,
    };
    expect(describeSubscriptionSettings(row)).toBe("Depeg +250bps");
  });
});

describe("describeGlobalAlertSettings", () => {
  it("returns None for null subscriber", () => {
    expect(describeGlobalAlertSettings(null)).toBe("None");
  });

  it("lists enabled global types", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 1, global_alert_launch: 1,
      quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null,
    };
    expect(describeGlobalAlertSettings(sub)).toBe("DEWS, Safety, Launch");
  });
});

describe("formatQuietHours", () => {
  it("formats hours with zero-padding", () => {
    expect(formatQuietHours(2, 7)).toBe("02-07");
    expect(formatQuietHours(22, 7)).toBe("22-07");
  });

  it("returns Off for null values", () => {
    expect(formatQuietHours(null, null)).toBe("Off");
    expect(formatQuietHours(22, null)).toBe("Off");
  });
});

describe("buildListMessage", () => {
  it("shows no subscriptions message when empty", () => {
    expect(buildListMessage(null, [])).toContain("No active subscriptions");
  });

  it("includes global settings and coin list", () => {
    const sub: SubscriberRow = {
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 0, global_alert_launch: 0,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 7,
    };
    const msg = buildListMessage(sub, []);
    expect(msg).toContain("DEWS");
    expect(msg).toContain("22-07");
    expect(msg).toContain("Coins (0)");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run src/api/__tests__/telegram-webhook-messages.test.ts --reporter verbose 2>&1 | tail -30`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/__tests__/telegram-webhook-messages.test.ts
git commit -m "test(telegram): add dedicated tests for webhook message formatting

Covers buildNotFoundMessage, buildUnsubscribeSuccessMessage,
describeSubscriptionSettings, describeGlobalAlertSettings,
buildListMessage, and formatQuietHours."
```

---

## Task 10: Test suite — `telegram-webhook-resolution.ts`

The coin resolution flow (multi-ticker, disambiguation branching) is untested in isolation.

**Files:**
- Create: `worker/src/api/__tests__/telegram-webhook-resolution.test.ts`

- [ ] **Step 1: Write the resolution test suite**

```typescript
// worker/src/api/__tests__/telegram-webhook-resolution.test.ts
import { describe, it, expect } from "vitest";
import { resolveCoinTargets } from "../telegram-webhook-resolution";
import { resolveTicker } from "../../lib/telegram-alerts";

describe("resolveCoinTargets", () => {
  it("resolves a single unique ticker", () => {
    const result = resolveCoinTargets(["USDC"]);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.coins).toHaveLength(1);
      expect(result.coins[0].symbol).toBe("USDC");
    }
  });

  it("deduplicates repeated tickers", () => {
    const result = resolveCoinTargets(["USDC", "USDC"]);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.coins).toHaveLength(1);
    }
  });

  it("returns not_found for unknown ticker", () => {
    const result = resolveCoinTargets(["XYZZY"]);
    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") {
      expect(result.ticker).toBe("XYZZY");
    }
  });

  it("returns ambiguous with candidates and remaining tickers", () => {
    // Find an ambiguous ticker in the active stablecoins
    const ambiguous = resolveTicker("USDF");
    if (ambiguous.status !== "ambiguous") {
      // Skip if no ambiguous ticker available in test dataset
      return;
    }
    const result = resolveCoinTargets(["USDF", "USDC"]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.ticker).toBe("USDF");
      expect(result.candidates.length).toBeGreaterThan(1);
      expect(result.remainingTickers).toEqual(["USDC"]);
    }
  });

  it("includes initialCoins in the result", () => {
    const initial = [{ id: "dai-maker", symbol: "DAI", name: "Dai" }];
    const result = resolveCoinTargets(["USDC"], initial);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.coins.length).toBe(2);
      expect(result.coins.map((c) => c.symbol).sort()).toEqual(["DAI", "USDC"]);
    }
  });

  it("stops at first not_found ticker", () => {
    const result = resolveCoinTargets(["USDC", "XYZZY", "DAI"]);
    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") {
      expect(result.ticker).toBe("XYZZY");
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run src/api/__tests__/telegram-webhook-resolution.test.ts --reporter verbose 2>&1 | tail -20`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/__tests__/telegram-webhook-resolution.test.ts
git commit -m "test(telegram): add dedicated tests for coin resolution flow

Covers resolveCoinTargets: unique, ambiguous, not_found, deduplication,
initialCoins merging, and early-exit on first not_found."
```

---

## Task 11: Test for blocked subscriber launch flag cleanup in dispatch

Verifies the end-to-end fix from Task 1 works in the dispatch pipeline.

**Files:**
- Modify: `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts` (append)

- [ ] **Step 1: Add test for launch flag cleanup on blocked subscriber**

Append to the existing `describe("dispatchTelegramAlerts")` block:

```typescript
  it("clears launch alert flags when deactivating a blocked subscriber", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 403, errorClass: "blocked", delivery: "blocked", retryAfterSec: null,
    });
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:dews-alertable-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:launch-snapshot") return { value: JSON.stringify([]), updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle"], rows: [{ stablecoin_id: "usdc-circle", chat_id: "99999", last_active_at: now }] },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    const history = db.getHistory();
    const subscriberUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscribers") && e.sql.includes("alert_launch"));
    expect(subscriberUpdate).toBeDefined();
    expect(subscriberUpdate!.sql).toContain("global_alert_launch=0");
  });
```

- [ ] **Step 2: Run test**

Run: `cd worker && npx vitest run src/cron/__tests__/dispatch-telegram-alerts.test.ts -t "clears launch alert flags" --reporter verbose 2>&1 | tail -20`

Expected: PASS (since the fix was applied in Task 1)

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts
git commit -m "test(telegram): verify blocked subscriber launch flag cleanup in dispatch"
```

---

## Task 12: Remaining `enqueuePendingAlerts` and `cleanupExpiredPendingAlerts` tests

**Files:**
- Modify: `worker/src/cron/__tests__/telegram-pending-queue.test.ts` (append)

- [ ] **Step 1: Add tests for enqueue and cleanup**

Append to the test file:

```typescript
describe("enqueuePendingAlerts", () => {
  it("inserts messages into the pending table", async () => {
    const db = mockD1([
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    ]);

    await enqueuePendingAlerts(
      db,
      [
        { chatId: "100", html: "<b>Alert 1</b>", disableNotification: false },
        { chatId: "200", html: "<b>Alert 2</b>", disableNotification: true },
      ],
      1000,
    );

    const history = db.getHistory();
    const inserts = history.filter((e) => e.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(inserts.length).toBeGreaterThan(0);
  });

  it("does nothing for empty message list", async () => {
    const db = mockD1([]);
    await enqueuePendingAlerts(db, [], 1000);
    expect(db.getHistory()).toHaveLength(0);
  });
});

describe("cleanupExpiredPendingAlerts", () => {
  it("deletes alerts older than PENDING_TTL_SEC", async () => {
    const nowSec = 5000;
    const db = mockD1([
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [], runMeta: { changes: 3 } },
    ]);

    const expired = await cleanupExpiredPendingAlerts(db, nowSec);
    expect(expired).toBe(3);

    const history = db.getHistory();
    const deleteCall = history.find((e) => e.sql.includes("DELETE FROM telegram_pending_alerts"));
    expect(deleteCall).toBeDefined();
    // Cutoff = nowSec - PENDING_TTL_SEC = 5000 - 3600 = 1400
    expect(deleteCall!.binds[0]).toBe(nowSec - PENDING_TTL_SEC);
  });

  it("returns 0 when no alerts expired", async () => {
    const db = mockD1([
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [], runMeta: { changes: 0 } },
    ]);
    expect(await cleanupExpiredPendingAlerts(db, 5000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/telegram-pending-queue.test.ts --reporter verbose 2>&1 | tail -30`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/__tests__/telegram-pending-queue.test.ts
git commit -m "test(telegram): add tests for enqueuePendingAlerts and cleanupExpiredPendingAlerts"
```

---

## Task 13: Final validation

- [ ] **Step 1: Run the full worker test suite**

Run: `cd worker && npx vitest run --reporter verbose 2>&1 | tail -40`

Expected: All PASS, 0 failures

- [ ] **Step 2: Type-check the worker**

Run: `cd worker && npx tsc --noEmit 2>&1 | tail -10`

Expected: Clean (no errors)

- [ ] **Step 3: Run the merge gate**

Run: `npm run test:merge-gate 2>&1 | tail -20`

Expected: PASS
