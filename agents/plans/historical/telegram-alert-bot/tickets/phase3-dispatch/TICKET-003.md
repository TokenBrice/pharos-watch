---
title: "Add dispatch cron tests"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Write tests for the alert dispatch cron job covering snapshot seeding, DEWS/depeg/safety detection, fan-out, and circuit breaker gating.

## Context

**Test patterns:** Follow the mocking pattern in `worker/src/cron/__tests__/compute-dews.test.ts`. Use `vi.mock()` to mock `../../lib/db` (for `getCache`/`setCache`), `../../lib/circuit-breaker` (for `shouldAttemptFetch`/`recordOutcome`), and `../../lib/telegram` (for `sendToChat`). Do NOT use `mockD1` for cache-based queries — `mockD1` matches on SQL substrings but cache keys are bind parameters, not SQL text.

**Function signature:** `dispatchTelegramAlerts(db, botToken, signal?)` returns `{ itemCount, metadata }`.

**Why vi.mock instead of mockD1 for cache:** The dispatch function calls `getCache(db, "alert:dews-snapshot")` which runs `SELECT value, updated_at FROM cache WHERE key = ?`. The cache key is a bind parameter, not part of the SQL text. `mockD1`'s `match` field only matches against SQL substrings, so `{ match: "alert:dews-snapshot" }` would NOT match this query. Use `vi.mock("../../lib/db")` to mock `getCache`/`setCache` directly.

## Task

1. **Create `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`**:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Mock dependencies at module level
const mockGetCache = vi.fn();
const mockSetCache = vi.fn();
vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    getCache: mockGetCache,
    setCache: mockSetCache,
  };
});

const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: mockShouldAttemptFetch,
  recordOutcome: mockRecordOutcome,
}));

const mockSendToChat = vi.fn();
vi.mock("../../lib/telegram", () => ({
  sendToChat: mockSendToChat,
}));

const { dispatchTelegramAlerts } = await import("../dispatch-telegram-alerts");

beforeEach(() => {
  mockGetCache.mockReset();
  mockSetCache.mockReset();
  mockShouldAttemptFetch.mockReset();
  mockRecordOutcome.mockReset();
  mockSendToChat.mockReset();
  mockSendToChat.mockResolvedValue({ ok: true, blocked: false });
  mockSetCache.mockResolvedValue(undefined);
  mockRecordOutcome.mockResolvedValue(undefined);
});

describe("dispatchTelegramAlerts", () => {
  it("skips when circuit breaker is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);
    const db = mockD1([]);
    const result = await dispatchTelegramAlerts(db, "bot-token");
    expect(JSON.parse(result.metadata)).toHaveProperty("skipped", "circuit-open");
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("seeds snapshots on first run", async () => {
    mockShouldAttemptFetch.mockResolvedValue(true);
    // No existing snapshots
    mockGetCache.mockResolvedValue(null);
    // DB queries for seeding current state
    const db = mockD1([
      { match: "stress_signals", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
    ]);
    const result = await dispatchTelegramAlerts(db, "bot-token");
    const meta = JSON.parse(result.metadata);
    expect(meta.snapshotSeeded).toBe(true);
    expect(meta.subscribersNotified).toBe(0);
    // Should have written 3 snapshots
    expect(mockSetCache).toHaveBeenCalledTimes(3);
  });

  it("detects DEWS band change and notifies subscriber", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockShouldAttemptFetch.mockResolvedValue(true);
    // Existing snapshots: USDC was CALM
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });
    const db = mockD1([
      // Current DEWS: USDC is now ALERT
      { match: "stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: JSON.stringify({ supply: 45, pool: 32 }) }] },
      // No active depegs
      { match: "depeg_events", rows: [] },
      // No safety changes
      { match: "safety_grade_history", rows: [] },
      // Subscriber query — someone subscribed to USDC DEWS alerts
      { match: "telegram_subscriptions", rows: [{ chat_id: "12345" }] },
      // Subscriber ordering
      { match: "telegram_subscribers", rows: [{ chat_id: "12345", last_active_at: now }] },
    ]);
    const result = await dispatchTelegramAlerts(db, "bot-token");
    const meta = JSON.parse(result.metadata);
    expect(meta.eventsDetected.dews).toBe(1);
  });

  it("ignores DEWS transitions to CALM/WATCH", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockShouldAttemptFetch.mockResolvedValue(true);
    // USDC was ALERT, now WATCH (not alertable)
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "ALERT" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });
    const db = mockD1([
      { match: "stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 20, band: "WATCH", signals_json: "{}" }] },
      { match: "depeg_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
    ]);
    const result = await dispatchTelegramAlerts(db, "bot-token");
    const meta = JSON.parse(result.metadata);
    expect(meta.eventsDetected.dews).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("deactivates subscriber on 403 (blocked)", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockShouldAttemptFetch.mockResolvedValue(true);
    mockSendToChat.mockResolvedValue({ ok: false, blocked: true });
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });
    const db = mockD1([
      { match: "stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }] },
      { match: "depeg_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
      { match: "telegram_subscriptions", rows: [{ chat_id: "99999" }] },
      { match: "telegram_subscribers", rows: [{ chat_id: "99999", last_active_at: now }] },
      // Deactivation UPDATE
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    const result = await dispatchTelegramAlerts(db, "bot-token");
    const meta = JSON.parse(result.metadata);
    expect(meta.blockedUsersCleanedUp).toBeGreaterThanOrEqual(0);
  });
});
```

## Acceptance Criteria

- `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts` exists
- Tests use `vi.mock("../../lib/db")` for `getCache`/`setCache` (NOT `mockD1` with cache key matches)
- Tests use `vi.mock("../../lib/circuit-breaker")` for `shouldAttemptFetch`
- Tests use `vi.mock("../../lib/telegram")` for `sendToChat`
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
