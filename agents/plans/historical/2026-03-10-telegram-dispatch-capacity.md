# Telegram Alert Dispatch Capacity Improvement

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase Telegram alert dispatch capacity from ~50 subscribers/event to 1,000+ without infrastructure migration.

**Architecture:** Six changes composed together: (1) pending delivery queue in D1 for guaranteed eventual delivery, (2) raised per-run cap from 50 to 200, (3) parallel Telegram sends in batches of 5, (4) batched D1 subscriber lookups, (5) dedicated 5-minute cron slot with full isolation from the quarter-hourly pipeline, (6) consolidated dispatch (remove from quarter-hourly and daily slots). The pending queue decouples event detection from delivery so snapshots always stay current and overflow drains across subsequent runs.

**Tech Stack:** Cloudflare Workers, D1, Telegram Bot API, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `worker/migrations/0060_telegram_pending_alerts.sql` | D1 table for overflow delivery queue |
| Modify | `worker/src/cron/dispatch-telegram-alerts.ts` | Core refactor: pending queue, parallel sends, batched lookups, raised cap |
| Modify | `worker/src/lib/telegram.ts` | Add `sendBatch()` parallel send helper |
| Modify | `worker/src/handlers/scheduled.ts` | New cron case for dedicated slot; remove telegram dispatch from quarter-hourly and daily slots |
| Modify | `shared/lib/cron-jobs.ts` | New schedule key + job definition; remove `dispatch-telegram-alerts-daily` |
| Modify | `worker/wrangler.toml` | Add dedicated cron expression |
| Modify | `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts` | New tests for all changes |
| Modify | `worker/src/lib/__tests__/telegram.test.ts` | Tests for `sendBatch()` |
| Modify | `docs/telegram-alerts.md` | Update dispatch docs |
| Modify | `docs/worker-infrastructure.md` | Update cron slot docs |
| Modify | `docs/worker-and-api-limits.md` | Update Telegram capacity notes |

---

## Key Design Decisions

### Why a pending queue instead of conditional snapshot writes

Conditional snapshots (don't write if capped) are simpler but have edge cases: if new events fire while old snapshots are held, the next run merges old overflow with new events, potentially producing confusing combined alerts. The pending queue keeps snapshots always current: events are detected once, formatted into messages, and either sent immediately or enqueued for later delivery. No duplicate detection, no stale snapshots.

### Why `*/5` dedicated slot

The quarter-hourly slot runs 7 sequential jobs before telegram dispatch. Moving dispatch to its own slot gives it: (a) isolated 30s CPU budget, (b) dedicated 6-connection pool, (c) 5-minute cadence for fast overflow drain. A 200-subscriber event clears in 1 run. A 1,000-subscriber event clears in 5 runs (25 min). The 5-minute cadence can be relaxed to 10 minutes if invocation costs matter (just change the cron expression).

### Why remove `dispatch-telegram-alerts-daily`

The daily pass existed to chain after `snapshot-safety-grade-history` at 08:00 UTC. With a 5-minute cadence, the dedicated slot picks up safety changes within 5 minutes of the daily snapshot completing. The explicit chaining is no longer needed and removing it eliminates a potential race condition (two dispatch jobs diffing/writing the same snapshots simultaneously).

### Pending alert TTL

1 hour (3600s). A stablecoin alert older than 1 hour is stale and potentially misleading. Expired entries are cleaned up at the end of each dispatch run.

### In-progress work: daily slot split

The `scheduled.ts` file currently has uncommitted modifications that split the daily cron into two cases: `daily0800Utc` (line 402) and `daily0805Utc` (line 420). The `dispatch-telegram-alerts-daily` block is inside the `daily0800Utc` case (lines 406-411). This plan only touches that block. Do NOT modify the `daily0805Utc` case or any other in-progress changes.

Similarly, `shared/lib/cron-jobs.ts` is a new untracked file. It may not yet define `daily0805Utc`. This plan only adds `fiveMinuteTelegramAlerts` to `CRON_SCHEDULES` and leaves all other entries unchanged.

### Error handling in parallel sends

`sendToChat` throws on non-403 HTTP errors (e.g., 429 rate limit, 500 server error). Both `sendBatch` and `drainPendingQueue` wrap each `sendToChat` call in a try/catch so a single transient failure doesn't abort the entire batch via `Promise.all` rejection. Failed sends return `{ ok: false, blocked: false }` and are handled gracefully (retried via pending queue or dropped after max attempts).

---

## Chunk 1: Infrastructure (Migration + Helpers)

### Task 1: D1 Migration for Pending Alerts Table

**Files:**
- Create: `worker/migrations/0060_telegram_pending_alerts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Overflow delivery queue for telegram alert dispatch.
-- Messages that cannot be sent within a single dispatch run are
-- stored here and drained by subsequent runs.
CREATE TABLE IF NOT EXISTS telegram_pending_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_html TEXT NOT NULL,
  disable_notification INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_tpa_created ON telegram_pending_alerts(created_at);
```

- [ ] **Step 2: Verify migration file is valid SQL**

Run: `cd worker && npx wrangler d1 migrations list stablecoin-db --local`
Expected: Migration `0060_telegram_pending_alerts` appears in the list as "unapplied".

- [ ] **Step 3: Apply migration locally**

Run: `cd worker && npx wrangler d1 migrations apply stablecoin-db --local`
Expected: Migration applied successfully.

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0060_telegram_pending_alerts.sql
git commit -m "feat(telegram): add pending_alerts table for overflow delivery queue"
```

---

### Task 2: Parallel Send Helper

**Files:**
- Modify: `worker/src/lib/telegram.ts`
- Modify: `worker/src/lib/__tests__/telegram.test.ts`

- [ ] **Step 1: Write the failing test for `sendBatch`**

Add a new `describe("sendBatch", ...)` block inside the existing `worker/src/lib/__tests__/telegram.test.ts` file. Reuse the existing `fetchSpy` mock that the file already sets up. If the file doesn't have a top-level `fetchSpy`, add one.

```typescript
// Add this describe block alongside existing tests in telegram.test.ts

describe("sendBatch", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("sends messages in parallel batches of the given size", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = Array.from({ length: 7 }, (_, i) => ({
      chatId: `chat-${i}`,
      html: `<b>Alert ${i}</b>`,
      disableNotification: false,
    }));

    const results = await sendBatch(messages, "bot-token", 3);

    expect(results).toHaveLength(7);
    expect(results.every((r) => r.ok)).toBe(true);
    // 3 batches: [0,1,2], [3,4,5], [6]
    expect(fetchSpy).toHaveBeenCalledTimes(7);
  });

  it("reports blocked chats without throwing", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = [
      { chatId: "a", html: "hi", disableNotification: false },
      { chatId: "b", html: "hi", disableNotification: false },
      { chatId: "c", html: "hi", disableNotification: false },
    ];

    const results = await sendBatch(messages, "bot-token", 3);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ chatId: "a", ok: true, blocked: false });
    expect(results[1]).toEqual({ chatId: "b", ok: false, blocked: true });
    expect(results[2]).toEqual({ chatId: "c", ok: true, blocked: false });
  });

  it("catches transient errors without crashing the batch", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = [
      { chatId: "a", html: "hi", disableNotification: false },
      { chatId: "b", html: "hi", disableNotification: false },
      { chatId: "c", html: "hi", disableNotification: false },
    ];

    const results = await sendBatch(messages, "bot-token", 3);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ chatId: "a", ok: true, blocked: false });
    // 500 error: sendToChat throws, sendBatch catches it -> { ok: false, blocked: false }
    expect(results[1]).toEqual({ chatId: "b", ok: false, blocked: false });
    expect(results[2]).toEqual({ chatId: "c", ok: true, blocked: false });
  });

  it("returns empty array for empty input", async () => {
    const results = await sendBatch([], "bot-token", 5);
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

Also add `sendBatch` to the import from `../telegram` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run worker/src/lib/__tests__/telegram.test.ts`
Expected: FAIL — `sendBatch` is not exported from `../telegram`.

- [ ] **Step 3: Implement `sendBatch` in `worker/src/lib/telegram.ts`**

Add after the existing `sendToChat` function:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run worker/src/lib/__tests__/telegram.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/telegram.ts worker/src/lib/__tests__/telegram.test.ts
git commit -m "feat(telegram): add sendBatch() parallel send helper with error isolation"
```

---

### Task 3: Batched Subscriber Lookup

**Files:**
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts`

This task adds `loadSubscriberRowsBatch()` alongside the existing `loadSubscriberRows()`. The existing function is not removed yet — the refactor in Task 5 will switch to the batch version.

- [ ] **Step 1: Add `loadSubscriberRowsBatch` to `dispatch-telegram-alerts.ts`**

Add after the existing `loadSubscriberRows` function (which stays for now):

```typescript
async function loadSubscriberRowsBatch(
  db: D1Database,
  stablecoinIds: string[],
  type: AlertType,
): Promise<Map<string, SubscriberRow[]>> {
  if (stablecoinIds.length === 0) return new Map();
  const alertColumn = ALERT_COLUMN_BY_TYPE[type];
  const placeholders = stablecoinIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT s.stablecoin_id, s.chat_id, u.last_active_at
         FROM telegram_subscriptions s
         JOIN telegram_subscribers u ON u.chat_id = s.chat_id
        WHERE s.stablecoin_id IN (${placeholders})
          AND u.${alertColumn} = 1`,
    )
    .bind(...stablecoinIds)
    .all<{ stablecoin_id: string; chat_id: string; last_active_at: number }>();

  const map = new Map<string, SubscriberRow[]>();
  for (const row of result.results ?? []) {
    const existing = map.get(row.stablecoin_id) ?? [];
    existing.push({ chat_id: row.chat_id, last_active_at: row.last_active_at });
    map.set(row.stablecoin_id, existing);
  }
  return map;
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/dispatch-telegram-alerts.ts
git commit -m "feat(telegram): add batched subscriber lookup helper"
```

---

## Chunk 2: Core Dispatch Refactor

### Task 4: Pending Queue Helpers

**Files:**
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts`

These are pure helper functions added to the dispatch module. They'll be wired up in Task 5.

**Critical: `sendToChat` throws on non-403 HTTP errors (e.g., 500). Every `sendToChat` call inside `Promise.all` must be wrapped in try/catch to prevent a single failure from aborting the entire batch.**

- [ ] **Step 1: Add pending queue constants and helper functions**

Add these near the top of `dispatch-telegram-alerts.ts`, after the existing constants:

```typescript
const PENDING_TTL_SEC = 3600; // 1 hour — stale alerts are worse than no alert
const SEND_BATCH_SIZE = 5; // Parallel sends per batch (stay under Workers 6-conn limit)

interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  attempts: number;
}

/** Drain pending alerts, oldest first, up to `limit`. Returns count sent + blocked. */
async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ sent: number; blocked: number; failed: number }> {
  const rows = await db
    .prepare(
      `SELECT id, chat_id, message_html, disable_notification, created_at, attempts
         FROM telegram_pending_alerts
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<PendingAlertRow>();

  const pending = rows.results ?? [];
  if (pending.length === 0) return { sent: 0, blocked: 0, failed: 0 };

  let sent = 0;
  let blocked = 0;
  let failed = 0;
  const idsToDelete: number[] = [];
  const idsToRetry: number[] = [];

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          const result = await sendToChat(row.chat_id, row.message_html, botToken, {
            disableWebPagePreview: true,
            disableNotification: row.disable_notification === 1,
          });
          return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ...result };
        } catch {
          // Transient failure (500, timeout, etc.) — don't crash the batch
          return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ok: false, blocked: false };
        }
      }),
    );

    for (const result of results) {
      if (result.ok) {
        sent++;
        idsToDelete.push(result.id);
      } else if (result.blocked) {
        blocked++;
        idsToDelete.push(result.id);
        // Disable alerts for blocked user (best-effort)
        await db
          .prepare(
            "UPDATE telegram_subscribers SET alert_dews=0, alert_depeg=0, alert_safety=0 WHERE chat_id=?",
          )
          .bind(result.chatId)
          .run()
          .catch(() => {});
      } else {
        // Transient failure — retry up to 2 more times (3 attempts total)
        if (result.attempts >= 2) {
          failed++;
          idsToDelete.push(result.id);
        } else {
          idsToRetry.push(result.id);
        }
      }
    }
  }

  // Delete delivered/expired/failed rows
  if (idsToDelete.length > 0) {
    const placeholders = idsToDelete.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM telegram_pending_alerts WHERE id IN (${placeholders})`)
      .bind(...idsToDelete)
      .run();
  }

  // Increment attempts for retryable rows
  if (idsToRetry.length > 0) {
    const placeholders = idsToRetry.map(() => "?").join(",");
    await db
      .prepare(
        `UPDATE telegram_pending_alerts SET attempts = attempts + 1 WHERE id IN (${placeholders})`,
      )
      .bind(...idsToRetry)
      .run();
  }

  return { sent, blocked, failed };
}

/** Enqueue pre-split message chunks for delivery in subsequent runs. */
async function enqueuePendingAlerts(
  db: D1Database,
  messages: Array<{ chatId: string; html: string; disableNotification: boolean }>,
  nowSec: number,
): Promise<void> {
  if (messages.length === 0) return;

  // D1 batch — all-or-nothing
  const stmts = messages.map((msg) =>
    db
      .prepare(
        `INSERT INTO telegram_pending_alerts (chat_id, message_html, disable_notification, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(msg.chatId, msg.html, msg.disableNotification ? 1 : 0, nowSec),
  );
  await db.batch(stmts);
}

/** Remove pending alerts older than TTL. */
async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const cutoff = nowSec - PENDING_TTL_SEC;
  const result = await db
    .prepare("DELETE FROM telegram_pending_alerts WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors. (The helpers reference `sendToChat` which is already imported.)

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/dispatch-telegram-alerts.ts
git commit -m "feat(telegram): add pending queue drain/enqueue/cleanup helpers"
```

---

### Task 5: Refactor `dispatchTelegramAlerts`

**Files:**
- Modify: `worker/src/cron/dispatch-telegram-alerts.ts`

This is the core refactor. The function changes from:
1. Detect events -> sequential send (capped at 50) -> write snapshots (always)

To:
1. Drain pending queue first -> detect events -> batch subscriber lookups -> parallel send (capped at 200) -> enqueue overflow (pre-split) -> write snapshots (always) -> cleanup expired

- [ ] **Step 1: Update the constant and add the import**

Change `MAX_MESSAGES_PER_RUN` from 50 to 200:

```typescript
const MAX_MESSAGES_PER_RUN = 200;
```

Add `sendBatch` to the import from `../lib/telegram` (alongside existing `sendToChat`):

```typescript
import { sendToChat, sendBatch } from "../lib/telegram";
```

- [ ] **Step 2: Update `DispatchResult` interface**

Replace the existing interface with:

```typescript
interface DispatchResult {
  eventsDetected: { dews: number; depeg: number; safety: number };
  subscribersNotified: number;
  messagesSent: number;
  blockedUsersCleanedUp: number;
  cappedAtLimit: boolean;
  snapshotSeeded: boolean;
  pendingDrained: number;
  pendingEnqueued: number;
  pendingExpired: number;
}
```

Update `emptyResult` to include the new fields:

```typescript
function emptyResult(snapshotSeeded: boolean): DispatchResult {
  return {
    eventsDetected: { dews: 0, depeg: 0, safety: 0 },
    subscribersNotified: 0,
    messagesSent: 0,
    blockedUsersCleanedUp: 0,
    cappedAtLimit: false,
    snapshotSeeded,
    pendingDrained: 0,
    pendingEnqueued: 0,
    pendingExpired: 0,
  };
}
```

- [ ] **Step 3: Insert Phase 1 and replace Phase 3-6**

This is a two-part edit in `dispatch-telegram-alerts.ts`:

**Part A — Insert Phase 1 (drain pending queue) at line 329.**
After the `if (mustSeedSnapshots) { ... }` block (which ends at line 328 with `}`), insert this code BEFORE the existing `const dewsChanges` line (line 329):

```typescript

    // --- Phase 1: Drain pending queue ---
    const pendingBudget = Math.floor(MAX_MESSAGES_PER_RUN / 4); // Reserve 75% for fresh events
    const drainResult = await drainPendingQueue(db, botToken, pendingBudget, signal);

    throwIfAborted(signal);

```

**Part B — DO NOT TOUCH lines 329-411.** These contain the event detection logic (DEWS changes, depeg triggered/resolved, safety changes). They remain exactly as-is.

**Part C — Delete lines 413-509 and replace with Phases 3-6.** Delete everything from `const alertsByChat = new Map` (line 413) through `return { itemCount: messagesSent, metadata: JSON.stringify(result) };` (line 509). Replace with:

```typescript
    // --- Phase 3: Batched subscriber lookups ---
    const dewsIds = dewsChanges.map((c) => c.stablecoinId);
    const depegIds = [
      ...depegTriggered.map((e) => e.stablecoinId),
      ...depegResolved.map((e) => e.stablecoinId),
    ];
    const safetyIds = safetyChanges.map((c) => c.stablecoinId);

    const [dewsSubs, depegSubs, safetySubs] = await Promise.all([
      loadSubscriberRowsBatch(db, dewsIds, "dews"),
      loadSubscriberRowsBatch(db, depegIds, "depeg"),
      loadSubscriberRowsBatch(db, safetyIds, "safety"),
    ]);

    throwIfAborted(signal);

    // --- Phase 4: Build per-chat consolidated alerts ---
    const alertsByChat = new Map<string, { lastActiveAt: number; alerts: ConsolidatedAlerts }>();

    const addToChat = (
      chatId: string,
      lastActiveAt: number,
      append: (alerts: ConsolidatedAlerts) => unknown[],
      event: unknown,
    ): void => {
      const existing = alertsByChat.get(chatId);
      if (existing) {
        existing.lastActiveAt = Math.max(existing.lastActiveAt, lastActiveAt);
        append(existing.alerts).push(event);
        return;
      }
      const alerts = emptyAlerts();
      append(alerts).push(event);
      alertsByChat.set(chatId, { lastActiveAt, alerts });
    };

    for (const change of dewsChanges) {
      for (const sub of dewsSubs.get(change.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.dews, change);
      }
    }
    for (const event of depegTriggered) {
      for (const sub of depegSubs.get(event.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.depegTriggered, event);
      }
    }
    for (const event of depegResolved) {
      for (const sub of depegSubs.get(event.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.depegResolved, event);
      }
    }
    for (const change of safetyChanges) {
      for (const sub of safetySubs.get(change.stablecoinId) ?? []) {
        addToChat(sub.chat_id, sub.last_active_at, (a) => a.safety, change);
      }
    }

    // --- Phase 5: Format, split, send up to budget, enqueue overflow ---
    // Pre-split ALL messages once (avoid calling splitMessage twice)
    const subscriberQueue = [...alertsByChat.entries()]
      .map(([chatId, entry]) => {
        const message = formatConsolidatedMessage(entry.alerts);
        return {
          chatId,
          lastActiveAt: entry.lastActiveAt,
          alerts: entry.alerts,
          chunks: splitMessage(message),
          disableNotification: !hasEscalation(entry.alerts),
        };
      })
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const freshBudget = MAX_MESSAGES_PER_RUN - drainResult.sent;
    const toSend = subscriberQueue.slice(0, freshBudget);
    const toEnqueue = subscriberQueue.slice(freshBudget);

    // Build flat message list from pre-split chunks
    const sendList: Array<{
      chatId: string;
      html: string;
      disableNotification: boolean;
    }> = [];
    for (const sub of toSend) {
      for (const chunk of sub.chunks) {
        sendList.push({
          chatId: sub.chatId,
          html: chunk,
          disableNotification: sub.disableNotification,
        });
      }
    }

    const sendResults = await sendBatch(sendList, botToken, SEND_BATCH_SIZE);

    let subscribersNotified = 0;
    let messagesSent = 0;
    let blockedUsersCleanedUp = drainResult.blocked;

    // Track which chats were blocked so we skip counting them
    const blockedChats = new Set<string>();
    for (const result of sendResults) {
      if (result.blocked) {
        if (!blockedChats.has(result.chatId)) {
          blockedChats.add(result.chatId);
          blockedUsersCleanedUp++;
          await db
            .prepare(
              "UPDATE telegram_subscribers SET alert_dews=0, alert_depeg=0, alert_safety=0 WHERE chat_id=?",
            )
            .bind(result.chatId)
            .run();
        }
      } else if (result.ok) {
        messagesSent++;
      }
    }

    // Count subscribers where at least one chunk succeeded and none blocked
    for (const sub of toSend) {
      if (blockedChats.has(sub.chatId)) continue;
      if (sub.chunks.length > 0) subscribersNotified++;
    }

    // Enqueue overflow — store pre-split chunks so drain path can send directly.
    // Don't enqueue for blocked chats.
    const overflowMessages: Array<{ chatId: string; html: string; disableNotification: boolean }> = [];
    for (const sub of toEnqueue) {
      if (blockedChats.has(sub.chatId)) continue;
      for (const chunk of sub.chunks) {
        overflowMessages.push({
          chatId: sub.chatId,
          html: chunk,
          disableNotification: sub.disableNotification,
        });
      }
    }

    if (overflowMessages.length > 0) {
      await enqueuePendingAlerts(db, overflowMessages, nowSec);
    }

    // --- Phase 6: Always write snapshots, then cleanup ---
    await writeSnapshots(db, currentSnapshots);
    const expiredCount = await cleanupExpiredPendingAlerts(db, nowSec);
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);

    const result: DispatchResult = {
      eventsDetected: {
        dews: dewsChanges.length,
        depeg: depegTriggered.length + depegResolved.length,
        safety: safetyChanges.length,
      },
      subscribersNotified,
      messagesSent: messagesSent + drainResult.sent,
      blockedUsersCleanedUp,
      cappedAtLimit: toEnqueue.length > 0,
      snapshotSeeded: false,
      pendingDrained: drainResult.sent,
      pendingEnqueued: overflowMessages.length,
      pendingExpired: expiredCount,
    };
    return { itemCount: result.messagesSent, metadata: JSON.stringify(result) };
```

- [ ] **Step 4: Remove the now-unused `loadSubscriberRows` function**

Delete the original `loadSubscriberRows` function (the one that takes a single `stablecoinId`). It's fully replaced by `loadSubscriberRowsBatch`.

- [ ] **Step 5: Verify type-check passes**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/dispatch-telegram-alerts.ts
git commit -m "feat(telegram): refactor dispatch with pending queue, parallel sends, batched lookups, cap=200"
```

---

## Chunk 3: Dedicated Cron Slot

### Task 6: Add Dedicated Cron Slot

**Files:**
- Modify: `worker/wrangler.toml`
- Modify: `shared/lib/cron-jobs.ts`
- Modify: `worker/src/handlers/scheduled.ts`

- [ ] **Step 1: Add cron expression to `worker/wrangler.toml`**

Add `"2,7,12,17,22,27,32,37,42,47,52,57 * * * *"` to the `crons` array. This fires every 5 minutes offset by 2, avoiding collision with all existing cron minutes (0/15/30/45, 3/23/43, 4/24/44, 5/35, 6/26/46, 10/40, 13/33/53).

In `worker/wrangler.toml`, the `[triggers]` section becomes:

```toml
[triggers]
crons = [
  "*/15 * * * *",
  "3,23,43 * * * *",
  "4,24,44 * * * *",
  "5,35 * * * *",
  "6,26,46 * * * *",
  "13,33,53 * * * *",
  "10,40 * * * *",
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  "0 8 * * *",
]
```

- [ ] **Step 2: Update `shared/lib/cron-jobs.ts`**

**A. Add `"five-minute"` to the `CronGroupKey` type:**

```typescript
export type CronGroupKey =
  | "quarter-hourly"
  | "five-minute"
  | "twenty-minute"
  | "half-hourly"
  | "daily"
  | "other";
```

**B. Add a new group entry to `CRON_GROUPS` (insert after `"quarter-hourly"`):**

```typescript
{
  key: "five-minute",
  title: "5-minute slot",
  badge: "~5 min",
  description: "Telegram alert dispatch with dedicated connection pool and pending-queue drain.",
},
```

**C. Add the new schedule key to `CRON_SCHEDULES`:**

```typescript
export const CRON_SCHEDULES = {
  quarterHourly: "*/15 * * * *",
  twentyMinuteOffset: "3,23,43 * * * *",
  twentyMinuteMintBurn: "4,24,44 * * * *",
  halfHourlyCharts: "5,35 * * * *",
  twentyMinuteDexDiscovery: "6,26,46 * * * *",
  twentyMinuteExtendedOffset: "13,33,53 * * * *",
  halfHourlyOffset: "10,40 * * * *",
  fiveMinuteTelegramAlerts: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  daily0800Utc: "0 8 * * *",
} as const;
```

**D. Update the `dispatch-telegram-alerts` job definition** in `CRON_JOB_DEFINITIONS_BASE` to point to the new schedule key and group:

```typescript
{
  job: "dispatch-telegram-alerts",
  label: "Telegram alerts",
  group: "five-minute",
  intervalSec: 300,
  scheduleKey: "fiveMinuteTelegramAlerts",
  triggerMode: "isolated",
},
```

**E. Remove the `dispatch-telegram-alerts-daily` entry entirely** from `CRON_JOB_DEFINITIONS_BASE`. The 5-minute cadence subsumes its purpose.

- [ ] **Step 3: Add the new case to `scheduled.ts` and remove telegram from existing slots**

In `worker/src/handlers/scheduled.ts`, make three precise edits:

**A. Remove telegram dispatch from the quarter-hourly case (lines 204, 214, 230-235).**

The quarter-hourly case has a `dewsResult` variable that only exists to gate the telegram dispatch. Remove it.

**Before** (lines 204-214):
```typescript
        let dewsResult: CronResult | null = null;
        if (stablecoinsCacheSafe && depegPipelineSafe) {
          // PSI depends on stablecoins cache + fresh depeg events.
          await runQuarterHourlyJob("stability-index", (signal) => computeAndStoreStabilityIndex(db, signal));
        } else if (stablecoinsCacheSafe && !depegPipelineSafe) {
          console.warn("[cron] sync-stablecoins completed without a safe depeg pipeline — skipping stability-index");
        }

        if (stablecoinsCacheSafe) {
          // DEWS depends on stablecoins cache + dex data — run after sync
          dewsResult = await runQuarterHourlyJob("compute-dews", (signal) => computeAndStoreDEWS(db, signal));
        }
```

**After** (remove `dewsResult`, keep PSI and DEWS calls):
```typescript
        if (stablecoinsCacheSafe && depegPipelineSafe) {
          // PSI depends on stablecoins cache + fresh depeg events.
          await runQuarterHourlyJob("stability-index", (signal) => computeAndStoreStabilityIndex(db, signal));
        } else if (stablecoinsCacheSafe && !depegPipelineSafe) {
          console.warn("[cron] sync-stablecoins completed without a safe depeg pipeline — skipping stability-index");
        }

        if (stablecoinsCacheSafe) {
          // DEWS depends on stablecoins cache + dex data — run after sync
          await runQuarterHourlyJob("compute-dews", (signal) => computeAndStoreDEWS(db, signal));
        }
```

Then delete the telegram block entirely (lines 230-235):
```typescript
        // DELETE these 6 lines:
        // Telegram alert dispatch — must run LAST, after sync-stablecoins + compute-dews
        if (env.TELEGRAM_BOT_TOKEN && stablecoinsCacheSafe && depegPipelineSafe && dewsResult !== null) {
          await runQuarterHourlyJob("dispatch-telegram-alerts", (signal) =>
            dispatchTelegramAlerts(db, env.TELEGRAM_BOT_TOKEN!, signal),
          );
        }
```

**B. Remove telegram dispatch from the daily0800Utc case (lines 406-411).**

Inside the `case CRON_SCHEDULES.daily0800Utc` block, delete these exact lines:

```typescript
        // DELETE these 6 lines:
        if (env.TELEGRAM_BOT_TOKEN) {
          ctx.waitUntil(safetyGradePromise.then(() =>
            runLeasedCron("dispatch-telegram-alerts-daily", (signal) =>
              dispatchTelegramAlerts(db, env.TELEGRAM_BOT_TOKEN!, signal),
            ),
          ));
        }
```

**Note:** The current `scheduled.ts` has in-progress work splitting the daily slot into `daily0800Utc` (line 402) and `daily0805Utc` (line 420). The telegram-daily block is in the `daily0800Utc` case. Do NOT touch the `daily0805Utc` case — it has nothing to do with telegram.

**C. Add the new dedicated case.** Insert a new case BEFORE `case CRON_SCHEDULES.daily0800Utc` (line 401). The exact insertion point is after the `break;` of the previous case (line 399) and before the `// Daily A` comment (line 401):

```typescript
    // Telegram alert dispatch on dedicated 5-min trigger (:02/:07/:12/.../:57)
    case CRON_SCHEDULES.fiveMinuteTelegramAlerts: {
      if (env.TELEGRAM_BOT_TOKEN) {
        ctx.waitUntil(
          runLeasedCron("dispatch-telegram-alerts", (signal) =>
            dispatchTelegramAlerts(db, env.TELEGRAM_BOT_TOKEN!, signal),
          ),
        );
      }
      break;
    }
```

**D.** The `dispatchTelegramAlerts` import (line 28) stays — it's still used in the new case. After removing the telegram blocks from quarter-hourly and daily, check if any other code in those cases still references `dispatchTelegramAlerts`. If not (and it shouldn't), the import is only consumed by the new dedicated case.

- [ ] **Step 4: Verify type-check passes**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: No errors. The build succeeds. (The shared `cron-jobs.ts` changes are consumed by both frontend and worker.)

- [ ] **Step 5: Commit**

```bash
git add worker/wrangler.toml shared/lib/cron-jobs.ts worker/src/handlers/scheduled.ts
git commit -m "feat(telegram): dedicated 5-min cron slot, remove from quarter-hourly and daily"
```

---

## Chunk 4: Tests

### Task 7: Update and Add Tests

**Files:**
- Modify: `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`

The existing tests exercise the old flow. Update them for the refactored function and add new tests for the pending queue, parallel sends, batched lookups, and overflow behavior.

**Critical mock change:** The refactored function now calls `sendBatch` (from `../../lib/telegram`) for fresh subscriber sends. The existing mock only intercepts `sendToChat`. We must also mock `sendBatch`. The simplest approach: mock `sendBatch` to delegate to `mockSendToChat` per-message, so existing `mockSendToChat` assertions keep working.

- [ ] **Step 1: Update mock setup to include `sendBatch`**

At the top of the test file, alongside the existing `mockSendToChat`:

```typescript
const mockSendToChat = vi.fn();
const mockSendBatch = vi.fn();

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: mockSendToChat,
    sendBatch: mockSendBatch,
  };
});
```

In `beforeEach`, reset both mocks and set up `mockSendBatch` to delegate to `mockSendToChat`:

```typescript
beforeEach(() => {
  // ... existing resets ...
  mockSendBatch.mockReset();
  mockSendToChat.mockResolvedValue({ ok: true, blocked: false });

  // Default sendBatch: delegate each message to mockSendToChat
  mockSendBatch.mockImplementation(
    async (messages: Array<{ chatId: string; html: string; disableNotification: boolean }>, _botToken: string) => {
      const results = [];
      for (const msg of messages) {
        const result = await mockSendToChat(msg.chatId, msg.html, _botToken, {});
        results.push({ chatId: msg.chatId, ...result });
      }
      return results;
    },
  );
});
```

This way, tests that assert on `mockSendToChat` call counts still work, and `mockSendBatch` is exercised for the fresh-send path.

- [ ] **Step 2: Update existing tests to add pending queue mock entries**

Every existing test that exercises the full dispatch flow (not the circuit-open or snapshot-seeding tests) needs mock entries for the pending queue. The refactored function issues these new D1 queries:
1. `SELECT ... FROM telegram_pending_alerts ORDER BY created_at ASC LIMIT ?` — drain (Phase 1)
2. `DELETE FROM telegram_pending_alerts WHERE created_at < ?` — cleanup expired (Phase 6)
3. Subscriber lookups now use `IN (?)` instead of `= ?` — but the `match` string `u.alert_dews = 1` still appears in the query, so existing matchers should still work.

The `sendBatch` mock (set up in Step 1) delegates to `mockSendToChat`, so existing `mockSendToChat` call-count assertions remain valid.

**Fully worked example — update "detects DEWS/depeg/safety changes" test (lines 84-158):**

The current test's `mockD1` array is:
```typescript
const db = mockD1([
  { match: "FROM stress_signals", rows: [{ ... }] },
  { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [{ ... }] },
  { match: "FROM safety_grade_history", rows: [{ ... }] },
  { match: "u.alert_dews = 1", matchBinds: ["usdc-circle"], rows: [{ chat_id: "12345", last_active_at: now }] },
  { match: "u.alert_depeg = 1", matchBinds: ["usdc-circle"], rows: [{ chat_id: "12345", last_active_at: now }] },
  { match: "u.alert_safety = 1", matchBinds: ["usdc-circle"], rows: [{ chat_id: "12345", last_active_at: now }] },
]);
```

**Change it to:**
```typescript
const db = mockD1([
  { match: "FROM stress_signals", rows: [{ ... }] },
  { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [{ ... }] },
  { match: "FROM safety_grade_history", rows: [{ ... }] },
  // Phase 1: pending queue drain (empty)
  { match: "FROM telegram_pending_alerts", rows: [] },
  // Phase 3: batched subscriber lookups (matchers still work — query still contains these strings)
  { match: "u.alert_dews = 1", matchBinds: ["usdc-circle"], rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }] },
  { match: "u.alert_depeg = 1", matchBinds: ["usdc-circle"], rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }] },
  { match: "u.alert_safety = 1", matchBinds: ["usdc-circle"], rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }] },
  // Phase 6: cleanup expired pending
  { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
]);
```

Key changes:
- Added `stablecoin_id` field to subscriber rows (batched lookup returns it; old per-coin lookup didn't)
- Added pending queue drain mock (empty — no overflow from prior runs)
- Added cleanup-expired mock at the end
- The `mockSendToChat` assertion changes from `toHaveBeenCalledTimes(1)` to checking `mockSendBatch` was called. Since the default `mockSendBatch` delegates to `mockSendToChat`, the existing `mockSendToChat.toHaveBeenCalledTimes(1)` assertion should still pass.

**Apply the same pattern to these tests:**
- **"uses per-coin latest safety rows"** (line 160): Add `{ match: "FROM telegram_pending_alerts", rows: [] }` after the safety_grade_history entry (line 205), add subscriber `stablecoin_id` field, add cleanup DELETE at end.
- **"does not alert on historical rows"** (line 230): Add pending drain mock, add cleanup mock. No subscriber lookups to change (test has 0 events).
- **"ignores DEWS transitions to CALM/WATCH"** (line 300): Add pending drain mock after safety_grade_history entry (line 322), add cleanup DELETE at end.
- **"deactivates subscriber on blocked"** (line 332): Add pending drain mock after safety_grade_history entry, add subscriber `stablecoin_id` field, add cleanup DELETE. The `mockSendBatch` will return blocked results since its default impl delegates to `mockSendToChat` which is set to return `{ ok: false, blocked: true }` in this test.

**For the "seeds snapshots on first run" test (line 62):** No changes needed. The snapshot-seeding path returns before reaching Phase 1 (the drain). The function exits at line 326 before any pending queue queries.

- [ ] **Step 3: Add test: pending queue is drained before fresh events**

```typescript
it("drains pending queue before processing fresh events", async () => {
  const now = Math.floor(Date.now() / 1000);

  // Fresh snapshots — no diffs
  mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
    if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
    if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
    if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
    return null;
  });

  const db = mockD1([
    { match: "FROM stress_signals", rows: [] },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    // Pending queue has 2 messages
    {
      match: "FROM telegram_pending_alerts",
      rows: [
        { id: 1, chat_id: "100", message_html: "<b>Old alert</b>", disable_notification: 0, created_at: now - 120, attempts: 0 },
        { id: 2, chat_id: "200", message_html: "<b>Old alert 2</b>", disable_notification: 1, created_at: now - 60, attempts: 0 },
      ],
    },
    // DELETE for delivered pending alerts
    { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    // Cleanup expired
    { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
  ]);

  const result = await dispatchTelegramAlerts(db, "bot-token");
  const metadata = JSON.parse(result.metadata) as { pendingDrained: number; messagesSent: number };

  expect(metadata.pendingDrained).toBe(2);
  // drainPendingQueue calls sendToChat directly (not sendBatch)
  expect(mockSendToChat).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Add test: overflow is enqueued when subscriber count exceeds budget**

```typescript
it("enqueues overflow subscribers to pending queue", async () => {
  const now = Math.floor(Date.now() / 1000);

  mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
    if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
    if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
    if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
    return null;
  });

  // Generate more subscribers than MAX_MESSAGES_PER_RUN
  const subscriberCount = 250;
  const subscribers = Array.from({ length: subscriberCount }, (_, i) => ({
    stablecoin_id: "usdc-circle",
    chat_id: `chat-${i}`,
    last_active_at: now - i,
  }));

  const db = mockD1([
    {
      match: "FROM stress_signals",
      rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
    },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    // No pending queue items
    { match: "FROM telegram_pending_alerts", rows: [] },
    // Batched subscriber lookup returns all 250
    { match: "u.alert_dews = 1", rows: subscribers },
    // INSERT for overflow (db.batch call)
    { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    // Cleanup expired
    { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
  ]);

  const result = await dispatchTelegramAlerts(db, "bot-token");
  const metadata = JSON.parse(result.metadata) as {
    subscribersNotified: number;
    cappedAtLimit: boolean;
    pendingEnqueued: number;
  };

  expect(metadata.cappedAtLimit).toBe(true);
  expect(metadata.pendingEnqueued).toBeGreaterThan(0);
  // freshBudget = 200 (no pending drained), so 200 sent + 50 enqueued
  expect(metadata.subscribersNotified).toBeLessThanOrEqual(200);
});
```

- [ ] **Step 5: Add test: snapshots are always updated even when capped**

```typescript
it("writes snapshots even when subscriber queue is capped", async () => {
  const now = Math.floor(Date.now() / 1000);

  mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
    if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
    if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
    if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
    return null;
  });

  const subscribers = Array.from({ length: 250 }, (_, i) => ({
    stablecoin_id: "usdc-circle",
    chat_id: `chat-${i}`,
    last_active_at: now - i,
  }));

  const db = mockD1([
    {
      match: "FROM stress_signals",
      rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
    },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    { match: "FROM telegram_pending_alerts", rows: [] },
    { match: "u.alert_dews = 1", rows: subscribers },
    { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
  ]);

  await dispatchTelegramAlerts(db, "bot-token");

  // Snapshots are written with the NEW state (WARNING), not held back
  const dewsSnapshotCall = mockSetCache.mock.calls.find(
    (call) => call[1] === "alert:dews-snapshot",
  );
  expect(dewsSnapshotCall).toBeDefined();
  expect(dewsSnapshotCall?.[2]).toContain("WARNING");
});
```

- [ ] **Step 6: Add test: expired pending alerts are cleaned up**

```typescript
it("cleans up expired pending alerts", async () => {
  const now = Math.floor(Date.now() / 1000);

  mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
    if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
    if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
    if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
    return null;
  });

  const db = mockD1([
    { match: "FROM stress_signals", rows: [] },
    { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    { match: "FROM telegram_pending_alerts", rows: [] },
    { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [], runMeta: { changes: 5 } },
  ]);

  const result = await dispatchTelegramAlerts(db, "bot-token");
  const metadata = JSON.parse(result.metadata) as { pendingExpired: number };

  expect(metadata.pendingExpired).toBe(5);
});
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
Expected: All tests PASS (old tests updated + new tests).

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All tests PASS. No regressions.

- [ ] **Step 9: Commit**

```bash
git add worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts
git commit -m "test(telegram): update and add tests for dispatch capacity improvements"
```

---

## Chunk 5: Build Verification and Documentation

### Task 8: Full Build Verification

- [ ] **Step 1: Full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors.

---

### Task 9: Update Documentation

**Files:**
- Modify: `docs/telegram-alerts.md`
- Modify: `docs/worker-infrastructure.md`
- Modify: `docs/worker-and-api-limits.md`

- [ ] **Step 1: Update `docs/telegram-alerts.md`**

**A. Dispatch Cron section** — replace the current description with:

```markdown
## Dispatch Cron

`dispatchTelegramAlerts(db, botToken, signal?)` runs on a dedicated 5-minute cron slot
(`2,7,12,17,22,27,32,37,42,47,52,57 * * * *`), isolated from the quarter-hourly pipeline.

It no longer runs inside the quarter-hourly or daily slots. Safety-grade changes from the
daily `snapshot-safety-grade-history` job are detected within 5 minutes of the snapshot completing.
```

Remove the paragraph about `dispatch-telegram-alerts-daily` being chained in `scheduled.ts`.

**B. Message Formatting and Limits section** — update:

```markdown
### Message Formatting and Limits

- Messages are HTML-formatted via `formatConsolidatedMessage()`.
- Long messages are split with `splitMessage(html, 4000)`.
- `sendBatch()` posts in parallel batches of 5 (staying under Workers 6-connection limit).
- Hard cap: `200 subscriber deliveries per dispatch run`.
- Overflow subscribers are enqueued to `telegram_pending_alerts` and drained in subsequent runs.
- Pending alerts expire after `1 hour` (3600s) — stale alerts are cleaned up automatically.

When Telegram returns `403`, the send helper reports `{ blocked: true }` and the dispatcher
disables that user's alert flags to stop repeated failures.
```

**C. Add a new Pending Delivery Queue section** after Message Formatting:

```markdown
### Pending Delivery Queue

When the subscriber queue exceeds the per-run cap (200), overflow messages are written
to `telegram_pending_alerts` in D1 as pre-split HTML chunks. Each subsequent dispatch run
drains up to 25% of its budget from the pending queue before processing fresh events,
ensuring eventual delivery.

Pending alerts have a 1-hour TTL. Rows older than the TTL are deleted at the end of each
run. Failed sends retry up to 2 times (3 attempts total) before being dropped.

This design ensures snapshots always stay current (events are never "held back") while
guaranteeing delivery for large subscriber populations.
```

**D. D1 Schema table** — add the new table:

```markdown
| `telegram_pending_alerts` | Overflow delivery queue | `id`, `chat_id`, `message_html`, `disable_notification`, `created_at`, `attempts` |
```

- [ ] **Step 2: Update `docs/worker-infrastructure.md`**

Read the file first. Then:

- Add the new cron trigger to the trigger table/list. Document the expression `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` and that it runs `dispatch-telegram-alerts` in isolation.
- Remove any references to `dispatch-telegram-alerts-daily` as a separate job.
- Remove `dispatch-telegram-alerts` from the quarter-hourly slot's job list.
- Update the total cron expression count (was 8, now 9).
- Note the connection budget: the dedicated slot uses up to 5 of 6 available connections for parallel Telegram sends.

- [ ] **Step 3: Update `docs/worker-and-api-limits.md`**

Read the file first. Then update the Telegram Bot API section's "Current usage" note:

```markdown
**Current usage**: Subscriber alerts dispatch every 5 minutes on a dedicated cron slot.
Up to 200 messages per run, sent in parallel batches of 5. Overflow enqueued to D1
for subsequent runs. At full capacity (200 sends/run, 12 runs/hour), theoretical
throughput is 2,400 messages/hour — well within the 30 msgs/sec global limit.
```

Update the "Telegram / GitHub / Frankfurter / gold-api" row in the Summary table. Split Telegram into its own row:

```markdown
| Telegram subscriber alerts | 200/run, 12 runs/hour, pending overflow queue | 1,000+ subscribers comfortable |
| GitHub / Frankfurter / gold-api | No meaningful limits | |
```

- [ ] **Step 4: Commit**

```bash
git add docs/telegram-alerts.md docs/worker-infrastructure.md docs/worker-and-api-limits.md
git commit -m "docs: update telegram dispatch capacity, cron slot, pending queue"
```

---

## Post-Implementation Notes

### Capacity after all changes

| Metric | Before | After |
|---|---|---|
| Subscribers per event (single run) | 50 | 200 |
| Subscribers per event (eventual) | 50 (hard drop) | Unlimited (pending queue) |
| Dispatch cadence | 15 min (shared) | 5 min (dedicated) |
| Send parallelism | Sequential (1) | Batch of 5 |
| D1 queries per dispatch (subscriber lookups) | O(events) | O(alert_types) = max 3 |
| Comfortable total subscriber base | ~50 correlated | 1,000+ |

### Migration deployment

The `0060_telegram_pending_alerts.sql` migration must be applied to production D1 before deploying the worker code:

```bash
cd worker && npx wrangler d1 migrations apply stablecoin-db --remote
```

### Relaxing cadence

If 12 invocations/hour feels excessive for a small user base, change the cron expression to every 10 minutes: `2,12,22,32,42,52 * * * *` (6 invocations/hour). Update `CRON_SCHEDULES.fiveMinuteTelegramAlerts`, `intervalSec`, the group name/description, and the wrangler.toml entry to match.
