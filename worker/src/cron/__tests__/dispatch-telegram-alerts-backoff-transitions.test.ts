import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockGetCache,
  mockSetCache,
  mockSendToChat,
  mockSendBatch,
  formatConsolidatedMessageSpy,
  dispatchTelegramAlerts,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  makeSafetySourceCache,
  makeSafetySnapshotCache,
  countPendingAlertInsertBatches,
  parseLogRecords,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  fixtureMockD1,
  fixtureBuildPendingAlertRow,
} from "./dispatch-telegram-alerts.test-support";

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);
  it("records a fresh-send first strike without deactivating the subscriber", async () => {
    const now = Math.floor(Date.now() / 1000);

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
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "99999", last_active_at: now }],
      },
      { match: "SELECT consecutive_block_count", rows: [] },
      { match: "UPDATE telegram_subscribers", rows: [] },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { blockedUsersCleanedUp: number };

    expect(metadata.blockedUsersCleanedUp).toBe(0);
    const history = db.getHistory();
    const strikeUpdate = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("consecutive_block_count = ?"),
    );
    expect(strikeUpdate?.binds[0]).toBe(1);
    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_dews=0"),
    );
    expect(flagCascade).toBeUndefined();
  });

  it("deactivates a fresh-send blocked subscriber only on the second strike", async () => {
    const now = Math.floor(Date.now() / 1000);

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
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "99999", last_active_at: now }],
      },
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { blockedUsersCleanedUp: number };

    expect(metadata.blockedUsersCleanedUp).toBe(1);
    const history = db.getHistory();
    const flagCascade = history.find(
      (entry) => entry.sql.includes("UPDATE telegram_subscribers") && entry.sql.includes("alert_launch=0"),
    );
    expect(flagCascade).toBeDefined();
  });

  it("drains pending queue before processing fresh events", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Fresh snapshots — no diffs
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Pending queue has 2 messages
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          fixtureBuildPendingAlertRow({ id: 1, chatId: "100", html: "<b>Old alert</b>", createdAt: now - 120 }),
          fixtureBuildPendingAlertRow({
            id: 2,
            chatId: "200",
            html: "<b>Old alert 2</b>",
            disableNotification: 1,
            createdAt: now - 60,
          }),
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

  it("enqueues overflow subscribers to pending queue", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    // Generate more subscribers than TELEGRAM_MAX_MESSAGES_PER_RUN.
    const subscriberCount = TELEGRAM_MAX_MESSAGES_PER_RUN + 50;
    const subscribers = Array.from({ length: subscriberCount }, (_, i) => ({
      stablecoin_id: "usdc-circle",
      chat_id: `chat-${i}`,
      last_active_at: now - i,
    }));

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // No pending queue items
      { match: "FROM telegram_pending_alerts p", rows: [] },
      // Batched subscriber lookup returns all subscribers.
      { match: "sub.alert_dews = 1", rows: subscribers },
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
      freshCandidateChats: number;
      freshCandidateCount: number;
      freshOverflow: number;
      perAlertTypeTargets: Record<string, { chats: number; chunks: number }>;
      fanoutQueryMs: number;
      fanoutBuildMs: number;
    };

    expect(metadata.cappedAtLimit).toBe(true);
    expect(metadata.pendingEnqueued).toBeGreaterThan(0);
    expect(metadata.freshCandidateChats).toBe(subscriberCount);
    expect(metadata.freshCandidateCount).toBe(subscriberCount);
    expect(metadata.freshOverflow).toBe(50);
    expect(metadata.perAlertTypeTargets.dews).toEqual({ chats: subscriberCount, chunks: subscriberCount });
    expect(metadata.fanoutQueryMs).toBeGreaterThanOrEqual(0);
    expect(metadata.fanoutBuildMs).toBeGreaterThanOrEqual(0);
    // freshBudget = TELEGRAM_MAX_MESSAGES_PER_RUN (no pending drained), so max fresh cap + 50 enqueued.
    expect(metadata.subscribersNotified).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGES_PER_RUN);
    // C102: candidates fit within the format budget (MAX + allowance), so every
    // candidate is formatted exactly once — the budget-before-format reorder is
    // byte-identical to the pre-reorder behavior here.
    expect(formatConsolidatedMessageSpy).toHaveBeenCalledTimes(subscriberCount);
  });

  it("C102: caps hot-path formatting at the fresh budget under a market-wide burst", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const formatBudget = TELEGRAM_MAX_MESSAGES_PER_RUN + TELEGRAM_FORMAT_BUDGET_ALLOWANCE;
    // Far more single-chunk candidates than the format budget so an overflow tail
    // exists beyond what the hot fresh-send path may format.
    const overflowTail = 400;
    const subscriberCount = formatBudget + overflowTail;
    const subscribers = Array.from({ length: subscriberCount }, (_, i) => ({
      stablecoin_id: "usdc-circle",
      chat_id: `chat-${i}`,
      last_active_at: now - i,
    }));

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: subscribers },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      freshCandidateChats: number;
      freshCandidateCount: number;
      freshOverflow: number;
      pendingEnqueued: number;
      perAlertTypeTargets: Record<string, { chats: number; chunks: number }>;
    };

    // The hot fresh-send path (formatPlannedSubscribers) formats only the selected
    // slice — bounded by the format budget, NOT once per candidate. The residual
    // overflow tail is persisted unformatted for a later bounded enqueue pass, so
    // no alert is dropped and formatting does not scale with all subscribers.
    const totalFormats = formatConsolidatedMessageSpy.mock.calls.length;
    expect(totalFormats).toBe(formatBudget);
    // perAlertTypeTargets cover only the formatted-selected (hot-path) set, which
    // is capped at the format budget even though all candidates are accounted for.
    expect(metadata.perAlertTypeTargets.dews.chats).toBe(formatBudget);
    expect(metadata.perAlertTypeTargets.dews.chats).toBeGreaterThan(TELEGRAM_MAX_MESSAGES_PER_RUN);
    // Candidate metrics still reflect ALL routed chats via the cheap estimate.
    expect(metadata.freshCandidateChats).toBe(subscriberCount);
    expect(metadata.freshCandidateCount).toBe(subscriberCount);
    // Every candidate beyond the fresh send budget is accounted for: the selected
    // allowance is enqueued now, and the residual tail is durably planned.
    expect(metadata.freshOverflow).toBe(subscriberCount - TELEGRAM_MAX_MESSAGES_PER_RUN);
    expect(metadata.pendingEnqueued).toBe(TELEGRAM_FORMAT_BUDGET_ALLOWANCE);
    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) => call[1] === "telegram:dispatch-overflow-plan");
    expect(overflowBacklogWrite).toBeDefined();
    const overflowBacklog = JSON.parse(String(overflowBacklogWrite?.[2])) as {
      version: number;
      plans: unknown[];
    };
    expect(overflowBacklog.version).toBe(1);
    expect(overflowBacklog.plans).toHaveLength(overflowTail);
  });

  it("writes snapshots even when subscriber queue is capped", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const subscribers = Array.from({ length: 250 }, (_, i) => ({
      stablecoin_id: "usdc-circle",
      chat_id: `chat-${i}`,
      last_active_at: now - i,
    }));

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: subscribers },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    // The source baseline commits with the NEW state (WARNING) after targets
    // are durable, even when part of the subscriber queue overflows.
    const dewsSnapshotCall = db.getHistory().find(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "alert:dews-snapshot",
    );
    expect(dewsSnapshotCall).toBeDefined();
    expect(String(dewsSnapshotCall?.binds[1])).toContain("WARNING");
  });

  it("cleans up expired pending alerts", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "SELECT id, chat_id, message_html",
        rows: Array.from({ length: 5 }, (_, index) => ({
          id: index + 1,
          chat_id: `expired-${index}`,
          message_html: "<b>Expired</b>",
          created_at: now - 3_700,
          attempts: 0,
          last_error_class: null,
          dedupe_key: `expired-${index}`,
          chunk_index: 0,
          priority: 50,
          source_type: "risk_alert",
          alert_type: "depeg",
        })),
      },
      { match: "INSERT INTO telegram_alert_dead_letters", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 5 } },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { pendingExpired: number };

    expect(metadata.pendingExpired).toBe(5);
  });

  it("queues retryable fresh-send failures instead of dropping them", async () => {
    const now = Math.floor(Date.now() / 1000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }] },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    try {
      const result = await dispatchTelegramAlerts(db, "bot-token");
      const metadata = JSON.parse(result.metadata) as {
        freshAttempted: number;
        freshSent: number;
        freshRetryQueued: number;
        freshPermanentFailures: number;
        pendingEnqueued: number;
        messagesSent: number;
      };

      expect(metadata.freshAttempted).toBe(1);
      expect(metadata.freshSent).toBe(0);
      expect(metadata.freshRetryQueued).toBe(1);
      expect(metadata.freshPermanentFailures).toBe(0);
      expect(metadata.pendingEnqueued).toBe(1);
      expect(metadata.messagesSent).toBe(0);

      const systemicLog = parseLogRecords(errorSpy).find(
        (record) => record.action === "dispatch-systemic-fresh-failure",
      );
      expect(systemicLog).toMatchObject({
        scope: "telegram",
        level: "error",
        module: "dispatch-telegram-alerts",
        attemptedCount: 1,
        sentCount: 0,
        queuedCount: 1,
        permanentFailureCount: 0,
        pendingEnqueuedCount: 1,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("isolates rate-limit deferral to the affected chat and still sends fresh alerts for other chats", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Pending drain returns 429 for old-chat
    mockSendToChat.mockResolvedValueOnce({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      retryAfterSec: 45,
    });

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      {
        match: "FROM telegram_pending_alerts p",
        rows: [fixtureBuildPendingAlertRow({ id: 1, chatId: "old-chat", html: "<b>Old</b>", createdAt: now - 60 })],
      },
      {
        match: "sub.alert_dews = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "fresh-chat", last_active_at: now }],
      },
      { match: "UPDATE telegram_pending_alerts SET attempts", rows: [] },
      // loadChatsInBackoff query: old-chat is in backoff after the drain updates not_before_at
      { match: "SELECT chat_id, MAX(not_before_at)", rows: [{ chat_id: "old-chat", not_before_at: now + 45 }] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      pendingAttempted: number;
      pendingRetryQueued: number;
      freshAttempted: number;
      freshSent: number;
      freshDeferredPerChat: number;
      pendingEnqueued: number;
    };

    // old-chat: rate-limited pending drain, retry-queued
    expect(metadata.pendingAttempted).toBe(1);
    expect(metadata.pendingRetryQueued).toBe(1);
    // fresh-chat: NOT in backoff (different chat), proceeds against fresh budget
    expect(metadata.freshAttempted).toBe(1);
    expect(metadata.freshSent).toBe(1);
    expect(metadata.freshDeferredPerChat).toBe(0);
    expect(mockSendBatch).toHaveBeenCalled();
    expect(
      db
        .getHistory()
        .filter((entry) => entry.sql.includes("SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total"))
        .length,
    ).toBe(2);
  });

  it("defers fresh alerts for chats already in per-chat backoff without sending", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        rows: [
          { stablecoin_id: "usdc-circle", chat_id: "chat-A", last_active_at: now },
          { stablecoin_id: "usdc-circle", chat_id: "chat-B", last_active_at: now - 1 },
        ],
      },
      // chat-A is in backoff from a previous run; chat-B is not
      { match: "SELECT chat_id, MAX(not_before_at)", rows: [{ chat_id: "chat-A", not_before_at: now + 300 }] },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      freshAttempted: number;
      freshSent: number;
      freshDeferredPerChat: number;
      pendingEnqueued: number;
      perAlertType: Record<string, { enqueued: number }>;
    };

    // chat-B fresh send proceeds, chat-A is deferred and not sent
    expect(metadata.freshAttempted).toBe(1);
    expect(metadata.freshSent).toBe(1);
    expect(metadata.freshDeferredPerChat).toBe(1);
    expect(metadata.pendingEnqueued).toBe(1);
    expect(metadata.perAlertType.dews.enqueued).toBe(1);

    // Only chat-B was sent in this run
    const sendBatchCalls = mockSendBatch.mock.calls;
    const sentChatIds = sendBatchCalls.flatMap((call) => (call[0] as Array<{ chatId: string }>).map((m) => m.chatId));
    expect(sentChatIds).toEqual(["chat-B"]);
  });

  it("requeues globally rate-limited fresh sends without per-chat not_before_at", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockSendBatch.mockResolvedValue([
      {
        chatId: "chat-1",
        ok: true,
        blocked: false,
        retryable: false,
        permanentFailure: false,
        statusCode: 200,
        errorClass: null,
        delivery: "sent",
        retryAfterSec: null,
      },
      {
        chatId: "chat-2",
        ok: true,
        blocked: false,
        retryable: false,
        permanentFailure: false,
        statusCode: 200,
        errorClass: null,
        delivery: "sent",
        retryAfterSec: null,
      },
      {
        chatId: "chat-3",
        ok: true,
        blocked: false,
        retryable: false,
        permanentFailure: false,
        statusCode: 200,
        errorClass: null,
        delivery: "sent",
        retryAfterSec: null,
      },
      {
        chatId: "chat-4",
        ok: true,
        blocked: false,
        retryable: false,
        permanentFailure: false,
        statusCode: 200,
        errorClass: null,
        delivery: "sent",
        retryAfterSec: null,
      },
      {
        chatId: "chat-5",
        ok: false,
        blocked: false,
        retryable: true,
        permanentFailure: false,
        statusCode: 429,
        errorClass: "rate_limit",
        delivery: "retryable_failure",
        retryAfterSec: 45,
        rateLimitScope: "global",
        attempted: true,
      },
      {
        chatId: "chat-6",
        ok: false,
        blocked: false,
        retryable: true,
        permanentFailure: false,
        statusCode: 429,
        errorClass: "rate_limit",
        delivery: "retryable_failure",
        retryAfterSec: 45,
        rateLimitScope: "global",
        attempted: false,
      },
      {
        chatId: "chat-7",
        ok: false,
        blocked: false,
        retryable: true,
        permanentFailure: false,
        statusCode: 429,
        errorClass: "rate_limit",
        delivery: "retryable_failure",
        retryAfterSec: 45,
        rateLimitScope: "global",
        attempted: false,
      },
      {
        chatId: "chat-8",
        ok: false,
        blocked: false,
        retryable: true,
        permanentFailure: false,
        statusCode: 429,
        errorClass: "rate_limit",
        delivery: "retryable_failure",
        retryAfterSec: 45,
        rateLimitScope: "global",
        attempted: false,
      },
    ]);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const subscribers = Array.from({ length: 8 }, (_, index) => ({
      stablecoin_id: "usdc-circle",
      chat_id: `chat-${index + 1}`,
      last_active_at: now - index,
    }));

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: subscribers },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);
    const pendingInsertBatchCount = countPendingAlertInsertBatches(db);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      freshAttempted: number;
      freshSent: number;
      freshRetryQueued: number;
      pendingEnqueued: number;
      messagesSent: number;
    };

    expect(metadata.freshAttempted).toBe(5);
    expect(metadata.freshSent).toBe(4);
    expect(metadata.freshRetryQueued).toBe(4);
    expect(metadata.pendingEnqueued).toBe(4);
    expect(metadata.messagesSent).toBe(4);
    expect(mockSetCache).toHaveBeenCalledWith(db, "telegram:global-send-backoff-until", String(now + 45));
    const pendingInserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(pendingInserts).toHaveLength(4);
    expect(pendingInsertBatchCount()).toBe(1);
    expect(pendingInserts.every((entry) => entry.binds[4] == null)).toBe(true);
  });

  it("emits worsening depeg alerts when the configured bps step is crossed", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": {
              stablecoinId: "usdc-circle",
              symbol: "USDC",
              direction: "below",
              deviationBps: 120,
              price: 0.988,
              pegReference: 1,
            },
          }),
          updatedAt: now - 60,
        };
      }
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 260,
            start_price: 0.974,
            peg_reference: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_depeg = 1",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chat_id: "12345",
            last_active_at: now,
            depeg_worsening_bps_step: 100,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { depegWorsening: number } };

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(mockSendToChat.mock.calls[0]?.[1]).toContain("worsening");
  });

  it("suppresses fresh global depeg alerts below the configured bps step", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 125,
            start_price: 0.9875,
            peg_reference: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      {
        match: "WHERE global_alert_depeg = 1",
        rows: [
          {
            chat_id: "global-123",
            last_active_at: now,
            global_depeg_worsening_bps_step: 250,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { depegTriggered: number; depeg: number };
      messagesSent: number;
      subscribersNotified: number;
    };

    expect(metadata.eventsDetected.depeg).toBe(1);
    expect(metadata.eventsDetected.depegTriggered).toBe(1);
    expect(metadata.messagesSent).toBe(0);
    expect(metadata.subscribersNotified).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("sends fresh global depeg alerts when the configured bps step is met", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 260,
            start_price: 0.974,
            peg_reference: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      {
        match: "WHERE global_alert_depeg = 1",
        rows: [
          {
            chat_id: "global-123",
            last_active_at: now,
            global_depeg_worsening_bps_step: 250,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { depegTriggered: number };
      messagesSent: number;
      subscribersNotified: number;
    };

    expect(metadata.eventsDetected.depegTriggered).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("global-123");
    expect(mockSendToChat.mock.calls[0]?.[1]).toContain("below peg by 2.6%");
  });

  it("emits global worsening depeg alerts when the configured global bps step is crossed", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": {
              stablecoinId: "usdc-circle",
              symbol: "USDC",
              direction: "below",
              deviationBps: 120,
              price: 0.988,
              pegReference: 1,
            },
          }),
          updatedAt: now - 60,
        };
      }
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 260,
            start_price: 0.974,
            peg_reference: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      {
        match: "WHERE global_alert_depeg = 1",
        rows: [
          {
            chat_id: "global-123",
            last_active_at: now,
            global_depeg_worsening_bps_step: 100,
          },
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { depegWorsening: number } };

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("global-123");
    expect(mockSendToChat.mock.calls[0]?.[1]).toContain("worsening");
  });

  it("suppresses safety alerts when only the methodology version changed", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "v1" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C", score: 61, methodologyVersion: "v2" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "FROM safety_grade_history",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            grade: "C",
            score: 61,
            prev_grade: "B",
            prev_score: 78,
            recorded_at: now,
            methodology_version: "v2",
          },
        ],
      },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number; suppressedMethodologyChanges: number };
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.eventsDetected.suppressedMethodologyChanges).toBe(1);
    expect(metadata.messagesSent).toBe(0);
  });

  it("reports suppressedSafetyChangesAtSeed when reseeding hides real safety changes", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") {
        // Prior snapshot stored under a stale generation forces a reseed even
        // though the methodology version of the rows matches the live source.
        return makeSafetySnapshotCache(
          {
            "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.10" },
            "dai-makerdao": { grade: "B+", score: 80, methodologyVersion: "7.10" },
          },
          "legacy-generation",
        );
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.10" },
            "dai-makerdao": { grade: "C+", score: 65, methodologyVersion: "7.10" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      messagesSent: number;
      safetyAlertsSuppressed: boolean;
      suppressedSafetyChangesAtSeed: number;
    };

    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(metadata.safetyAlertsSuppressed).toBe(true);
    expect(metadata.suppressedSafetyChangesAtSeed).toBe(2);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("clears launch alert flags when deactivating a blocked subscriber", async () => {
    const now = Math.floor(Date.now() / 1000);

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
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot")
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:dews-alertable-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:launch-snapshot") return { value: JSON.stringify([]), updatedAt: now - 60 };
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "99999", last_active_at: now }],
      },
      {
        match: "SELECT consecutive_block_count",
        rows: [{ consecutive_block_count: 1, consecutive_block_first_at: now - 60 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    const history = db.getHistory();
    const subscriberUpdate = history.find(
      (e) => e.sql.includes("UPDATE telegram_subscribers") && e.sql.includes("alert_launch"),
    );
    expect(subscriberUpdate).toBeDefined();
    expect(subscriberUpdate!.sql).toContain("global_alert_launch=0");
  });

  it("does not emit a worsening alert when an active depeg flips direction (same stablecoin_id)", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Prior snapshot: usdc-circle below peg at 50 bps.
    // Current row: usdc-circle above peg at 100 bps (same stablecoin_id, new direction).
    // Because the active snapshot is keyed by stablecoin_id, the dispatcher does NOT
    // treat this as a fresh trigger or a resolved event; it is a no-op.
    // If this test later fails with a fresh depegTriggered/depegResolved count, it
    // means the dispatcher grew direction-aware detection — a behavior change worth
    // reviewing against the snapshot contract.
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": {
              symbol: "USDC",
              direction: "below",
              deviationBps: 50,
              price: 0.995,
              pegReference: 1,
            },
          }),
          updatedAt: now - 60,
        };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "above",
            peak_deviation_bps: 100,
            start_price: 1.01,
            peg_reference: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { depegTriggered: number; depegResolved: number; depegWorsening: number };
    };

    expect(metadata.eventsDetected.depegTriggered).toBe(0);
    expect(metadata.eventsDetected.depegResolved).toBe(0);
    expect(metadata.eventsDetected.depegWorsening).toBe(0);
  });
});
