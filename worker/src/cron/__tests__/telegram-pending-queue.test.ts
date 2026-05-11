import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const mockSendToChat = vi.fn();

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return { ...actual, sendToChat: mockSendToChat };
});

const {
  disableBlockedSubscriber,
  drainPendingQueue,
  enqueuePendingAlerts,
  cleanupExpiredPendingAlerts,
  loadChatsInBackoff,
  registerSubscriberBlockAndShouldDisable,
  resetSubscriberBlockCount,
  pendingBackoffSec,
  PENDING_TTL_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_BACKOFF_SCHEDULE_SEC,
  BLOCK_STRIKE_WINDOW_SEC,
  buildDedupeKey,
} = await import("../telegram-pending-queue");
const { TELEGRAM_SPLIT_VERSION } = await import("../../lib/telegram-alerts");

beforeEach(() => {
  mockSendToChat.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
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
      { match: "UPDATE telegram_subscribers", rows: [], throwError: new Error("D1 overload") },
    ]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await disableBlockedSubscriber(db, "bad-chat");
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("registerSubscriberBlockAndShouldDisable", () => {
  it("returns false on the first strike and stamps the window", async () => {
    const now = 1_700_000_000;
    const db = mockD1([
      { match: "SELECT consecutive_block_count", rows: [] },
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-1", now);
    expect(shouldDisable).toBe(false);
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    expect(updateCall!.binds).toEqual([1, now, "chat-1"]);
  });

  it("returns true on the second strike within the window", async () => {
    const now = 1_700_000_000;
    const db = mockD1([
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-2", now);
    expect(shouldDisable).toBe(true);
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    // Count increments to 2 and first_at is preserved.
    expect(updateCall!.binds).toEqual([2, now - 60, "chat-2"]);
  });

  it("returns false when the prior strike falls outside the 24h window", async () => {
    const now = 1_700_000_000;
    const db = mockD1([
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - (BLOCK_STRIKE_WINDOW_SEC + 1) }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-3", now);
    expect(shouldDisable).toBe(false);
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    expect(updateCall!.binds).toEqual([1, now, "chat-3"]);
  });

  it("returns false and logs on D1 SELECT error to avoid disabling on stale state", async () => {
    const db = mockD1([
      { match: "SELECT consecutive_block_count", rows: [], throwError: new Error("D1 overload") },
    ]);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const shouldDisable = await registerSubscriberBlockAndShouldDisable(db, "chat-4", 1_700_000_000);
    expect(shouldDisable).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("resetSubscriberBlockCount", () => {
  it("issues an UPDATE clearing both counters", async () => {
    const db = mockD1([
      { match: "UPDATE telegram_subscribers", rows: [] },
    ]);
    await resetSubscriberBlockCount(db, "chat-reset");
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_subscribers"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain("consecutive_block_count = 0");
    expect(updateCall!.sql).toContain("consecutive_block_first_at = NULL");
    expect(updateCall!.binds).toEqual(["chat-reset"]);
  });
});

describe("drainPendingQueue", () => {
  it("keeps retrying retryable rows past the legacy 5-attempt cap (age-based retry)", async () => {
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
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 1, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 2 },
          { id: 2, chat_id: "200", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 5 },
          { id: 3, chat_id: "300", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 10 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    // All three rows are below PENDING_MAX_ATTEMPTS (20); TTL filter at SELECT time
    // is what bounds retries, not the per-row attempts counter.
    expect(result.retryQueued).toBe(3);
    expect(result.dropped).toBe(0);
    expect(result.droppedMaxAttemptsFallback).toBe(0);
    expect(result.droppedPermanentFailure).toBe(0);
  });

  it("drops retryable rows when the defensive PENDING_MAX_ATTEMPTS ceiling is hit", async () => {
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
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 1, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: PENDING_MAX_ATTEMPTS - 1 },
          { id: 2, chat_id: "200", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: PENDING_MAX_ATTEMPTS },
          { id: 3, chat_id: "300", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: PENDING_MAX_ATTEMPTS + 5 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.retryQueued).toBe(1);
    expect(result.dropped).toBe(2);
    expect(result.droppedMaxAttemptsFallback).toBe(2);
    expect(result.droppedPermanentFailure).toBe(0);
  });

  it("classifies non-retryable Telegram responses as permanent-failure", async () => {
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "bad_request",
      delivery: "permanent_failure",
      retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 50, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.dropped).toBe(1);
    expect(result.droppedPermanentFailure).toBe(1);
    expect(result.droppedMaxAttemptsFallback).toBe(0);
  });

  it("respects the 60→120→240→480→600 backoff schedule when Retry-After is absent", () => {
    expect(PENDING_BACKOFF_SCHEDULE_SEC).toEqual([60, 120, 240, 480, 600]);
    expect(pendingBackoffSec(0, null)).toBe(60);
    expect(pendingBackoffSec(1, null)).toBe(120);
    expect(pendingBackoffSec(2, null)).toBe(240);
    expect(pendingBackoffSec(3, null)).toBe(480);
    expect(pendingBackoffSec(4, null)).toBe(600);
    // Caps at 600 for any higher attempt count.
    expect(pendingBackoffSec(5, null)).toBe(600);
    expect(pendingBackoffSec(19, null)).toBe(600);
  });

  it("prefers Telegram Retry-After over the local backoff schedule", () => {
    expect(pendingBackoffSec(0, 30)).toBe(30);
    expect(pendingBackoffSec(4, 1800)).toBe(1800);
  });

  it("writes scheduled backoff into not_before_at on retry updates", async () => {
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

    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 401, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 0 },
          { id: 402, chat_id: "200", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 2 },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10);

    const history = db.getHistory();
    const updates = history.filter((e) => e.sql.includes("UPDATE telegram_pending_alerts") && e.sql.includes("SET attempts"));
    expect(updates).toHaveLength(2);
    // attempts=0 → backoff 60s; attempts=2 → backoff 240s.
    const notBeforeForRow401 = updates.find((u) => u.binds[u.binds.length - 1] === 401)?.binds[0];
    const notBeforeForRow402 = updates.find((u) => u.binds[u.binds.length - 1] === 402)?.binds[0];
    expect(notBeforeForRow401).toBe(now + 60);
    expect(notBeforeForRow402).toBe(now + 240);
  });

  it("sustains delivery across a 30 minute 429 storm by re-driving the queue", async () => {
    // Simulate the operational scenario from the plan: a single row hammered by 429s
    // for 30 minutes should eventually deliver (not expire). Each subsequent drain
    // succeeds once the wall clock advances past not_before_at; the row's attempts
    // counter rises but never trips the legacy 5-attempt cap.
    const rateLimited = {
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: 120,
    };
    const sent = {
      ok: true,
      blocked: false,
      retryable: false,
      permanentFailure: false,
      statusCode: 200,
      errorClass: null,
      delivery: "sent",
      retryAfterSec: null,
    };

    const created = Math.floor(Date.now() / 1000);
    let attempts = 0;
    let delivered = false;

    // Drain loop: each iteration advances by 5 minutes (well over the 120s Retry-After)
    // and reuses the same row id. The row stays inside PENDING_TTL_SEC for the full
    // 30 minutes (1800s < 3600s).
    for (let elapsedMin = 0; elapsedMin <= 30 && !delivered; elapsedMin += 5) {
      vi.setSystemTime(new Date(Date.now() + (elapsedMin === 0 ? 0 : 5 * 60_000)));
      // 5 of 7 iterations are 429; on the 6th iteration we let it succeed.
      mockSendToChat.mockResolvedValueOnce(elapsedMin >= 25 ? sent : rateLimited);

      const db = mockD1([
        {
          match: "SELECT p.id, p.chat_id, p.message_html",
          rows: [
            { id: 999, chat_id: "100", message_html: "<b>Alert</b>", disable_notification: 0, created_at: created, attempts },
          ],
        },
        { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
        { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      ]);

      const result = await drainPendingQueue(db, "bot-token", 10);
      if (result.sent === 1) {
        delivered = true;
      } else {
        expect(result.retryQueued).toBe(1);
        expect(result.dropped).toBe(0);
        attempts += 1;
        // Each iteration the row stays under the defensive ceiling.
        expect(attempts).toBeLessThan(PENDING_MAX_ATTEMPTS);
      }
    }

    expect(delivered).toBe(true);
  });

  it("deletes successfully sent messages from the queue", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
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

  it("records a first-strike 403 without zeroing alert flags and deletes the pending message", async () => {
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 403, errorClass: "blocked", delivery: "blocked", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 20, chat_id: "blocked-chat", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      // Two-strike SELECT: no prior strike on file.
      { match: "SELECT consecutive_block_count", rows: [] },
      // Counter UPDATE writes count=1, first_at=now.
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.blocked).toBe(1);
    expect(result.sent).toBe(0);

    const history = db.getHistory();
    // First strike must increment the counter, not zero out alert flags.
    const counterUpdate = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("consecutive_block_count"),
    );
    expect(counterUpdate).toBeDefined();
    expect(counterUpdate!.binds[0]).toBe(1);
    // No aggressive cascade on first strike.
    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_dews=0"),
    );
    expect(flagCascade).toBeUndefined();
  });

  it("disables the subscriber on a second 403 within the 24h window", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 403, errorClass: "blocked", delivery: "blocked", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 21, chat_id: "double-strike", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 0 },
        ],
      },
      // Prior strike recorded ~1h ago, still within 24h window.
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 3600 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.blocked).toBe(1);

    const history = db.getHistory();
    // Counter update goes first, then the aggressive cascade flips all alert flags.
    const counterUpdate = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("consecutive_block_count = ?"),
    );
    expect(counterUpdate).toBeDefined();
    expect(counterUpdate!.binds[0]).toBe(2);

    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_launch=0"),
    );
    expect(flagCascade).toBeDefined();
    expect(flagCascade!.sql).toContain("global_alert_launch=0");
    const subscriptionsCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscriptions") && entry.sql.includes("alert_launch=0"),
    );
    expect(subscriptionsCascade).toBeDefined();
  });

  it("treats a stale first strike (older than 24h) as a fresh first strike", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockSendToChat.mockResolvedValue({
      ok: false, blocked: true, retryable: false, permanentFailure: true,
      statusCode: 403, errorClass: "blocked", delivery: "blocked", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 22, chat_id: "stale-strike", message_html: "<b>Alert</b>", disable_notification: 0, created_at: now - 60, attempts: 0 },
        ],
      },
      // Prior strike recorded >24h ago: window expired, treat as fresh.
      {
        match: "SELECT consecutive_block_count",
        rows: [
          {
            consecutive_block_count: 1,
            consecutive_block_first_at: now - (BLOCK_STRIKE_WINDOW_SEC + 60),
          },
        ],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10);

    const history = db.getHistory();
    const counterUpdate = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("consecutive_block_count = ?"),
    );
    expect(counterUpdate).toBeDefined();
    // Stale strike re-stamps count=1 and first_at=now (not count=2).
    expect(counterUpdate!.binds[0]).toBe(1);
    expect(counterUpdate!.binds[1]).toBe(now);

    // No flag cascade because we are back at first strike.
    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_launch=0"),
    );
    expect(flagCascade).toBeUndefined();
  });

  it("resets the consecutive_block_count on a successful send", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });

    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          { id: 23, chat_id: "recovered", message_html: "<b>Alert</b>", disable_notification: 0, created_at: 1000, attempts: 0 },
        ],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.sent).toBe(1);

    const history = db.getHistory();
    const resetCall = history.find(
      (entry) =>
        entry.sql.includes("UPDATE telegram_subscribers") &&
        entry.sql.includes("consecutive_block_count = 0") &&
        entry.sql.includes("consecutive_block_first_at = NULL"),
    );
    expect(resetCall).toBeDefined();
    expect(resetCall!.binds).toEqual(["recovered"]);
  });

  it("stops draining the queue when a 429 rate limit is received", async () => {
    // SEND_BATCH_SIZE=4, so we need >4 messages to span multiple batches.
    // First batch (4 msgs): 3 ok + 1 rate_limit. Sets rateLimited=true.
    // Second batch (3 msgs): never attempted because rateLimited flag breaks the loop.
    const okResult = {
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    };
    const rateLimitResult = {
      ok: false, blocked: false, retryable: true, permanentFailure: false,
      statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 30,
    };

    // First 3 calls succeed, 4th returns 429 (within first batch of 4)
    mockSendToChat
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(rateLimitResult);

    // 8 pending messages -> batch 1 (ids 1-4), batch 2 (ids 5-8)
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, chat_id: `chat-${i}`, message_html: `msg${i}`, disable_notification: 0, created_at: 1000, attempts: 0,
    }));

    const db = mockD1([
      { match: "SELECT p.id, p.chat_id, p.message_html", rows },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 20);

    // Only first batch of 4 was attempted; second batch of 4 was skipped
    expect(result.attempted).toBe(4);
    expect(result.sent).toBe(3);
    expect(result.retryQueued).toBe(1);
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterSec).toBe(30);
    expect(mockSendToChat).toHaveBeenCalledTimes(4);
  });

  it("does not select expired or not-yet-ready pending rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT p.id, p.chat_id, p.message_html", rows: [] },
    ]);

    await drainPendingQueue(db, "bot-token", 10);

    expect(mockSendToChat).not.toHaveBeenCalled();
    const selectCall = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_pending_alerts p"));
    expect(selectCall?.sql).toContain("p.created_at >= ?");
    expect(selectCall?.sql).toContain("p.not_before_at IS NULL OR p.not_before_at <= ?");
    expect(selectCall?.binds).toEqual([now - PENDING_TTL_SEC, now, 10]);
  });

  it("defers currently snoozed pending rows without sending", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          {
            id: 30,
            chat_id: "snoozed",
            message_html: "<b>Alert</b>",
            disable_notification: 0,
            created_at: now - 60,
            attempts: 0,
            not_before_at: null,
            alert_snooze_until_ts: now + 900,
            quiet_hours_enabled: 0,
            quiet_hours_start_utc: null,
            quiet_hours_end_utc: null,
          },
        ],
      },
      { match: "UPDATE telegram_pending_alerts SET not_before_at", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.deferred).toBe(1);
    expect(result.attempted).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    const updateCall = db.getHistory().find((entry) => entry.sql.includes("SET not_before_at"));
    expect(updateCall?.binds).toEqual([now + 900, now, 30]);
  });

  it("sends pending rows during current quiet hours with notifications silenced", async () => {
    mockSendToChat.mockResolvedValue({
      ok: true, blocked: false, retryable: false, permanentFailure: false,
      statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null,
    });
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT p.id, p.chat_id, p.message_html",
        rows: [
          {
            id: 31,
            chat_id: "quiet",
            message_html: "<b>Alert</b>",
            disable_notification: 0,
            created_at: now - 60,
            attempts: 0,
            not_before_at: null,
            alert_snooze_until_ts: null,
            quiet_hours_enabled: 1,
            quiet_hours_start_utc: 0,
            quiet_hours_end_utc: 23,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);

    expect(result.deferred).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledWith(
      "quiet",
      "<b>Alert</b>",
      "bot-token",
      expect.objectContaining({ disableNotification: true }),
    );
  });

  it("returns zeros when queue is empty", async () => {
    const db = mockD1([
      { match: "SELECT p.id, p.chat_id, p.message_html", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result).toEqual({
      attempted: 0,
      sent: 0,
      blocked: 0,
      blockedCleanupFailed: 0,
      retryQueued: 0,
      dropped: 0,
      droppedPermanentFailure: 0,
      droppedMaxAttemptsFallback: 0,
      deferred: 0,
      rateLimited: false,
      retryAfterSec: null,
      notBeforeAt: null,
    });
  });

  it("handles a 500-row mixed-state pending queue and starves no eligible chat across 3 ticks", async () => {
    // P1-T1: at-scale verification of the pending queue with mixed row states.
    // Seeds 500 alerts spread across five categories (100 each) and walks the
    // drain dispatcher through three simulated ticks, asserting prioritization,
    // snooze deferral, quiet-hours silencing, expiration cleanup, and fairness.
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

    const now = Math.floor(Date.now() / 1000);
    const futureNotBefore = now + 300; // 5 min in the future
    const futureSnooze = now + 900;    // 15 min in the future
    const expiredCreatedAt = now - (PENDING_TTL_SEC + 60);

    // Helper: seed a balanced mix of 500 rows. Returns the full row set plus
    // the subset that would actually pass the production SELECT's WHERE clause
    // (created_at >= cutoff AND (not_before_at IS NULL OR <= now)).
    const seed = () => {
      const rows: Array<{
        id: number; chat_id: string; message_html: string; disable_notification: number;
        created_at: number; attempts: number; not_before_at: number | null;
        alert_snooze_until_ts: number | null; quiet_hours_enabled: number;
        quiet_hours_start_utc: number | null; quiet_hours_end_utc: number | null;
      }> = [];
      // 100 immediately deliverable rows (oldest first via created_at).
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 1000 + i,
          chat_id: `deliver-${i}`,
          message_html: `<b>D${i}</b>`,
          disable_notification: 0,
          created_at: now - 600 - i, // older = higher priority
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // 100 rows in per-chat backoff (not_before_at in the future).
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 2000 + i,
          chat_id: `backoff-${i}`,
          message_html: `<b>B${i}</b>`,
          disable_notification: 0,
          created_at: now - 400,
          attempts: 1,
          not_before_at: futureNotBefore,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // 100 rows owned by snoozed chats (subscriber alert_snooze_until_ts in future).
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 3000 + i,
          chat_id: `snoozed-${i}`,
          message_html: `<b>S${i}</b>`,
          disable_notification: 0,
          created_at: now - 500 - i,
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: futureSnooze,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // 100 rows owned by chats in active quiet hours. With vi system time
      // 2026-04-23T12:00:00Z, hour 12 UTC ∈ [0, 23) → quiet hours active.
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 4000 + i,
          chat_id: `quiet-${i}`,
          message_html: `<b>Q${i}</b>`,
          disable_notification: 0,
          created_at: now - 300 - i,
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 1,
          quiet_hours_start_utc: 0,
          quiet_hours_end_utc: 23,
        });
      }
      // 100 expired rows (created_at older than PENDING_TTL_SEC). These would
      // be filtered out by the SELECT in production; we still seed them so the
      // cleanup assertion exercises the same row set.
      for (let i = 0; i < 100; i++) {
        rows.push({
          id: 5000 + i,
          chat_id: `expired-${i}`,
          message_html: `<b>E${i}</b>`,
          disable_notification: 0,
          created_at: expiredCreatedAt,
          attempts: 0,
          not_before_at: null,
          alert_snooze_until_ts: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        });
      }
      // SELECT-pass subset matches the production SQL filters and the ORDER BY
      // (COALESCE(not_before_at, created_at) ASC, created_at ASC).
      const selectable = rows
        .filter((r) => r.created_at >= now - PENDING_TTL_SEC)
        .filter((r) => r.not_before_at == null || r.not_before_at <= now)
        .sort((a, b) => {
          const aKey = a.not_before_at ?? a.created_at;
          const bKey = b.not_before_at ?? b.created_at;
          return aKey - bKey || a.created_at - b.created_at;
        });
      return { rows, selectable };
    };

    const { rows: allRows, selectable } = seed();
    // Sanity: 500 seeded; 300 selectable (deliver + snoozed + quiet); 200 filtered
    // (100 expired by TTL + 100 by future not_before_at).
    expect(allRows).toHaveLength(500);
    expect(selectable).toHaveLength(300);

    // Tick 1: drain with limit=200. Returns the 200 oldest-eligible rows, of
    // which 100 snoozed get deferred (one per chat, since each row has a
    // distinct chat_id) and the rest get sent.
    const tick1Rows = selectable.slice(0, 200);
    const db1 = mockD1([
      { match: "SELECT p.id, p.chat_id, p.message_html", rows: tick1Rows },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET not_before_at", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const tick1 = await drainPendingQueue(db1, "bot-token", 200);
    // Oldest 200 selectable rows: depending on created_at they include the
    // deliverable batch (created_at ~ now-600..-699), the snoozed batch
    // (~now-500..-599), and the quiet batch (~now-300..-399). We expect every
    // snoozed row in tick1's slice to be deferred and the rest sent.
    const snoozedInTick1 = tick1Rows.filter((r) => r.alert_snooze_until_ts != null && r.alert_snooze_until_ts > now);
    expect(tick1.deferred).toBe(snoozedInTick1.length);
    expect(tick1.attempted).toBe(tick1Rows.length - snoozedInTick1.length);
    expect(tick1.sent).toBe(tick1.attempted);
    expect(tick1.dropped).toBe(0);
    expect(tick1.retryQueued).toBe(0);

    // Quiet-hours rows in tick1: every send call must carry disableNotification:true.
    const quietChatsInTick1 = new Set(
      tick1Rows.filter((r) => r.quiet_hours_enabled === 1).map((r) => r.chat_id),
    );
    if (quietChatsInTick1.size > 0) {
      const quietCalls = mockSendToChat.mock.calls.filter(([chatId]) =>
        quietChatsInTick1.has(chatId as string),
      );
      expect(quietCalls.length).toBeGreaterThan(0);
      for (const [, , , options] of quietCalls) {
        expect(options).toMatchObject({ disableNotification: true });
      }
    }

    // Snoozed rows must NOT be sent. Snooze defer writes carry the snooze
    // expiry as the new not_before_at.
    const tick1History = db1.getHistory();
    const deferCalls = tick1History.filter((e) => e.sql.includes("SET not_before_at"));
    expect(deferCalls.length).toBe(snoozedInTick1.length);
    for (const call of deferCalls) {
      // bind order: notBeforeAt, nowSec, id
      expect(call.binds[0]).toBeGreaterThanOrEqual(futureSnooze);
    }

    // Tick 2: drain remaining selectable rows (i.e. the leftover 100).
    const tick2Rows = selectable.slice(200);
    const db2 = mockD1([
      { match: "SELECT p.id, p.chat_id, p.message_html", rows: tick2Rows },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_pending_alerts SET not_before_at", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);
    const tick2 = await drainPendingQueue(db2, "bot-token", 200);
    const snoozedInTick2 = tick2Rows.filter((r) => r.alert_snooze_until_ts != null && r.alert_snooze_until_ts > now);
    expect(tick2.attempted).toBe(tick2Rows.length - snoozedInTick2.length);
    expect(tick2.sent).toBe(tick2.attempted);
    expect(tick2.deferred).toBe(snoozedInTick2.length);

    // Tick 3: queue is empty (selectable rows already drained).
    const db3 = mockD1([
      { match: "SELECT p.id, p.chat_id, p.message_html", rows: [] },
    ]);
    const tick3 = await drainPendingQueue(db3, "bot-token", 200);
    expect(tick3.attempted).toBe(0);
    expect(tick3.deferred).toBe(0);

    // Fairness check: across the three ticks every non-snoozed, non-backoff
    // deliverable+quiet chat (200 distinct chats total) had at least one send
    // attempt logged. Snoozed and backoff chats are excluded by design.
    const eligibleChats = new Set(
      [...allRows]
        .filter((r) => r.created_at >= now - PENDING_TTL_SEC)
        .filter((r) => r.not_before_at == null)
        .filter((r) => r.alert_snooze_until_ts == null || r.alert_snooze_until_ts <= now)
        .map((r) => r.chat_id),
    );
    expect(eligibleChats.size).toBe(200);
    const attemptedChats = new Set(mockSendToChat.mock.calls.map(([chatId]) => chatId as string));
    for (const chatId of eligibleChats) {
      expect(attemptedChats.has(chatId)).toBe(true);
    }

    // Expired-row cleanup: simulate the production sweep. cleanupExpiredPendingAlerts
    // would delete the 100 expired rows on its own statement.
    const cleanupDb = mockD1([
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [], runMeta: { changes: 100 } },
    ]);
    const expired = await cleanupExpiredPendingAlerts(cleanupDb, now);
    expect(expired).toBe(100);
    // No send call ever targeted an expired chat across the three ticks.
    for (let i = 0; i < 100; i++) {
      expect(attemptedChats.has(`expired-${i}`)).toBe(false);
    }
    // Likewise, no send call ever targeted a backoff-only chat.
    for (let i = 0; i < 100; i++) {
      expect(attemptedChats.has(`backoff-${i}`)).toBe(false);
    }
  });
});

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
    expect(inserts[0]?.sql).toContain("dedupe_key");
    expect(inserts[0]?.sql).toContain("ON CONFLICT(dedupe_key) DO UPDATE");
  });

  it("does nothing for empty message list", async () => {
    const db = mockD1([]);
    await enqueuePendingAlerts(db, [], 1000);
    expect(db.getHistory()).toHaveLength(0);
  });
});

describe("buildDedupeKey", () => {
  const canonicalHtml = "<b>Pharos Alerts</b>\n\nDEWS\nUSDC: ALERT → WATCH";

  it("produces the same key across runs for the same canonical body", () => {
    const a = buildDedupeKey({ chatId: "100", html: "post-split-chunk-A", canonicalHtml, disableNotification: false, chunkIndex: 0 });
    const b = buildDedupeKey({ chatId: "100", html: "different-post-split-chunk", canonicalHtml, disableNotification: false, chunkIndex: 0 });
    // Same canonical body + chunk index + split version => same key, regardless
    // of how splitMessage chopped the chunk html.
    expect(a).toBe(b);
  });

  it("produces a new key when the split version is bumped", () => {
    const v1 = buildDedupeKey(
      { chatId: "100", html: "chunk", canonicalHtml, disableNotification: false, chunkIndex: 0 },
      TELEGRAM_SPLIT_VERSION,
    );
    const v2 = buildDedupeKey(
      { chatId: "100", html: "chunk", canonicalHtml, disableNotification: false, chunkIndex: 0 },
      TELEGRAM_SPLIT_VERSION + 1,
    );
    expect(v1).not.toBe(v2);
  });

  it("produces a different key for each chunk index of the same canonical body", () => {
    const chunk0 = buildDedupeKey({ chatId: "100", html: "c0", canonicalHtml, disableNotification: false, chunkIndex: 0 });
    const chunk1 = buildDedupeKey({ chatId: "100", html: "c1", canonicalHtml, disableNotification: false, chunkIndex: 1 });
    const chunk2 = buildDedupeKey({ chatId: "100", html: "c2", canonicalHtml, disableNotification: false, chunkIndex: 2 });
    expect(new Set([chunk0, chunk1, chunk2]).size).toBe(3);
  });
});

describe("loadChatsInBackoff", () => {
  it("returns the set of chat ids whose pending rows have not_before_at in the future", async () => {
    const nowSec = 5000;
    const db = mockD1([
      {
        match: "SELECT DISTINCT chat_id",
        rows: [{ chat_id: "chat-A" }, { chat_id: "chat-B" }],
      },
    ]);

    const result = await loadChatsInBackoff(db, nowSec);
    expect(result).toEqual(new Set(["chat-A", "chat-B"]));

    const history = db.getHistory();
    const select = history.find((entry) => entry.sql.includes("SELECT DISTINCT chat_id"));
    expect(select?.sql).toContain("not_before_at IS NOT NULL");
    expect(select?.sql).toContain("not_before_at > ?");
    expect(select?.binds).toEqual([nowSec]);
  });

  it("returns an empty set when no rows are in backoff", async () => {
    const db = mockD1([
      { match: "SELECT DISTINCT chat_id", rows: [] },
    ]);
    expect(await loadChatsInBackoff(db, 1000)).toEqual(new Set());
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
