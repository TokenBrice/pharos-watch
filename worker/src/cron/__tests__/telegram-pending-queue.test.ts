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

  it("returns zeros when queue is empty", async () => {
    const db = mockD1([
      { match: "SELECT id, chat_id, message_html", rows: [] },
    ]);

    const result = await drainPendingQueue(db, "bot-token", 10);
    expect(result).toEqual({ attempted: 0, sent: 0, blocked: 0, blockedCleanupFailed: 0, retryQueued: 0, dropped: 0 });
  });
});
