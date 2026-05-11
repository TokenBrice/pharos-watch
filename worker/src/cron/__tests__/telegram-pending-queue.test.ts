import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
        match: "SELECT p.id, p.chat_id, p.message_html",
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

  it("disables blocked subscribers and deletes their pending messages", async () => {
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
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result.blocked).toBe(1);
    expect(result.sent).toBe(0);
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
      deferred: 0,
      rateLimited: false,
      retryAfterSec: null,
      notBeforeAt: null,
    });
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
