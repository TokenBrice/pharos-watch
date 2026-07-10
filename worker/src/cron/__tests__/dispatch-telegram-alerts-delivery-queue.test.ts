import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockGetCache,
  mockSetCache,
  mockShouldAttemptFetch,
  mockRecordOutcome,
  mockSendToChat,
  mockSendBatch,
  formatConsolidatedMessageSpy,
  dispatchTelegramAlerts,
  deliverTelegramSubscriberQueue,
  pruneOverflowPlanBacklogForChat,
  buildDedupeKey,
  emptyDrainResult,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  makeSafetySourceCache,
  makeSafetySnapshotCache,
  makeDewsOverflowPlan,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  fixtureMockD1,
  fixtureBuildPendingAlertRow,
  type CronProgressUpdate,
} from "./dispatch-telegram-alerts.test-support";

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);
  it("filters already-terminal chunks before fresh delivery", async () => {
    const now = Math.floor(Date.now() / 1000);
    const terminalChunkKey = buildDedupeKey({
      chatId: "chat-1",
      html: "chunk-0",
      canonicalHtml: "canonical-body",
      disableNotification: false,
      chunkIndex: 0,
      alertType: "depeg",
    });
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
    ]);
    const db = fixtureMockD1([
      { match: "INSERT INTO telegram_chat_delivery_diagnostics", rows: [], runMeta: { changes: 1 } },
      { match: "UPDATE telegram_alert_job_targets", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [], runMeta: { changes: 0 } },
    ]);

    const result = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [
        {
          chatId: "chat-1",
          lastActiveAt: now,
          alerts: {
            dews: [],
            depegTriggered: [],
            depegResolved: [],
            depegWorsening: [],
            safety: [],
            launch: [],
            reserve: [],
          },
          canonicalHtml: "canonical-body",
          chunks: ["chunk-0", "chunk-1"],
          disableNotification: false,
          alertType: "depeg",
        },
      ],
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
      terminalTargetKeys: new Set([terminalChunkKey]),
    });

    expect(result.freshAttempted).toBe(1);
    expect(result.subscribersNotified).toBe(1);
    const sent = mockSendBatch.mock.calls[0]?.[0] as Array<{ html: string; chunkIndex?: number }>;
    expect(sent).toEqual([expect.objectContaining({ html: "chunk-1", chunkIndex: 1 })]);
  });

  it("passes a five-minute-lane soft deadline to fresh batch sends", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dispatchStartedAtMs = Date.now();
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
        attempted: true,
      },
    ]);
    const db = fixtureMockD1([
      { match: "INSERT INTO telegram_chat_delivery_diagnostics", rows: [], runMeta: { changes: 1 } },
      { match: "UPDATE telegram_alert_job_targets", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [], runMeta: { changes: 0 } },
    ]);

    await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [
        {
          chatId: "chat-1",
          lastActiveAt: now,
          alerts: {
            dews: [],
            depegTriggered: [],
            depegResolved: [],
            depegWorsening: [],
            safety: [],
            launch: [],
            reserve: [],
          },
          canonicalHtml: "canonical-body",
          chunks: ["chunk-0"],
          disableNotification: false,
          alertType: "depeg",
        },
      ],
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs,
    });

    expect(mockSendBatch.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      softDeadlineAtMs: dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
      beforeSendBatch: expect.any(Function),
      afterSendBatch: expect.any(Function),
    }));
  });

  it("uses existing pending attempts when re-enqueuing a retryable fresh chunk", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dedupeKey = buildDedupeKey({
      chatId: "chat-1",
      html: "chunk-0",
      canonicalHtml: "canonical-body",
      disableNotification: false,
      chunkIndex: 0,
      alertType: "depeg",
    });
    mockSendBatch.mockResolvedValue([
      {
        chatId: "chat-1",
        ok: false,
        blocked: false,
        retryable: true,
        permanentFailure: false,
        statusCode: 500,
        errorClass: "server_error",
        delivery: "retryable_failure",
        retryAfterSec: null,
        attempted: true,
      },
    ]);
    const db = fixtureMockD1([
      {
        match: "SELECT dedupe_key, attempts",
        rows: [{ dedupe_key: dedupeKey, attempts: 4, created_at: now - 60, expires_at: now + 600 }],
      },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    ]);

    const result = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [
        {
          chatId: "chat-1",
          lastActiveAt: now,
          alerts: {
            dews: [],
            depegTriggered: [],
            depegResolved: [],
            depegWorsening: [],
            safety: [],
            launch: [],
            reserve: [],
          },
          canonicalHtml: "canonical-body",
          chunks: ["chunk-0"],
          disableNotification: false,
          alertType: "depeg",
        },
      ],
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
    });

    expect(result.freshAttempted).toBe(1);
    expect(result.freshRetryQueued).toBe(1);
    const pendingInsert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(pendingInsert?.binds[4]).toBe(now + 600);
  });

  it("treats stale pending attempts as reset when re-enqueuing a retryable fresh chunk", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dedupeKey = buildDedupeKey({
      chatId: "chat-1",
      html: "chunk-0",
      canonicalHtml: "canonical-body",
      disableNotification: false,
      chunkIndex: 0,
      alertType: "depeg",
    });
    mockSendBatch.mockResolvedValue([
      {
        chatId: "chat-1",
        ok: false,
        blocked: false,
        retryable: true,
        permanentFailure: false,
        statusCode: 500,
        errorClass: "server_error",
        delivery: "retryable_failure",
        retryAfterSec: null,
        attempted: true,
      },
    ]);
    const db = fixtureMockD1([
      {
        match: "SELECT dedupe_key, attempts",
        rows: [{ dedupe_key: dedupeKey, attempts: 4, created_at: now - 90_000, expires_at: now - 30 }],
      },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    ]);

    const result = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [
        {
          chatId: "chat-1",
          lastActiveAt: now,
          alerts: {
            dews: [],
            depegTriggered: [],
            depegResolved: [],
            depegWorsening: [],
            safety: [],
            launch: [],
            reserve: [],
          },
          canonicalHtml: "canonical-body",
          chunks: ["chunk-0"],
          disableNotification: false,
          alertType: "depeg",
        },
      ],
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
    });

    expect(result.freshAttempted).toBe(1);
    expect(result.freshRetryQueued).toBe(1);
    const pendingInsert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"));
    expect(pendingInsert?.binds[4]).toBe(now + 60);
  });

  it("does not format planned overflow while global backoff is active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const overflowPlan = makeDewsOverflowPlan(now);

    const db = fixtureMockD1([]);
    const result = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [],
      overflowPlanned: [overflowPlan],
      overflowFormatBudget: 1,
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: now + 60,
      dispatchStartedAtMs: Date.now(),
    });

    expect(formatConsolidatedMessageSpy).not.toHaveBeenCalled();
    expect(result.pendingEnqueued).toBe(0);
    expect(result.freshOverflow).toBe(1);
    expect(result.remainingOverflowPlanned).toEqual([overflowPlan]);
  });

  it("skips when circuit breaker is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);

    const db = fixtureMockD1([]);
    const result = await dispatchTelegramAlerts(db, "bot-token");

    expect(JSON.parse(result.metadata)).toHaveProperty("skipped", "circuit-open");
    expect(result.itemCount).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it("drains due pending rows even when the Telegram API circuit is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total",
        rows: [],
        first: {
          total: 1,
          expired: 0,
          due: 1,
          deferred: 0,
          near_ttl: 0,
          oldest_pending_created_at: now - 120,
          oldest_due_created_at: now - 120,
        },
      },
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          fixtureBuildPendingAlertRow({ id: 1, chatId: "100", html: "<b>Queued alert</b>", createdAt: now - 120 }),
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      skipped: string;
      pendingAttempted: number;
      pendingDrained: number;
      messagesSent: number;
    };

    expect(metadata.skipped).toBe("circuit-open");
    expect(metadata.pendingAttempted).toBe(1);
    expect(metadata.pendingDrained).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(result.itemCount).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockRecordOutcome).toHaveBeenCalledWith(db, "telegram-api", true);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("does not record a Telegram API circuit failure when dispatch is aborted before delivery", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("dispatch deadline", "AbortError"));
    const db = fixtureMockD1([]);

    await expect(dispatchTelegramAlerts(db, "bot-token", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not record a Telegram API circuit failure for source-loading D1 errors", async () => {
    const db = fixtureMockD1([
      {
        match: "pharos:telegram-dispatch:active-snoozes",
        rows: [],
        throwError: new Error("D1_ERROR: source load failed"),
      },
    ]);

    await expect(dispatchTelegramAlerts(db, "bot-token")).rejects.toThrow("D1_ERROR: source load failed");

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("seeds snapshots on first run", async () => {
    mockGetCache.mockResolvedValue(null);

    const db = fixtureMockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      snapshotSeeded: boolean;
      subscribersNotified: number;
      safetyAlertSourceState: string | null;
      safetyAlertsSuppressed: boolean;
    };

    expect(result.itemCount).toBe(0);
    expect(metadata.snapshotSeeded).toBe(true);
    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.safetyAlertSourceState).toBe("missing");
    expect(metadata.safetyAlertsSuppressed).toBe(true);
    // 6 writes: dews, dewsAlertable, depeg, launch, reserveDispatched (C123) snapshots
    // (safety is suppressed when the live source is missing) + the preset-failure reset.
    expect(mockSetCache).toHaveBeenCalledTimes(6);
    expect(mockSetCache).toHaveBeenCalledWith(db, "telegram:preset-query-failure-count", "0");
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
  });

  it("uses the eventless fast path without fan-out when snapshots are healthy and unchanged", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
          },
          now - 60,
        );
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 12, band: "CALM", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventlessFastPath?: boolean;
      eventsDetected: { dews: number; depeg: number; safety: number; launch: number };
      messagesSent: number;
      pendingAttempted: number;
    };

    expect(result.itemCount).toBe(0);
    expect(metadata.eventlessFastPath).toBe(true);
    expect(metadata.eventsDetected).toMatchObject({ dews: 0, depeg: 0, safety: 0, launch: 0 });
    expect(metadata.messagesSent).toBe(0);
    expect(metadata.pendingAttempted).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("sub.alert_dews = 1"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("WHERE global_alert_dews = 1"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("FROM telegram_pending_alerts p"))).toBe(false);
  });

  it("drains stored overflow plans during an eventless run", async () => {
    const now = Math.floor(Date.now() / 1000);
    const overflowPlan = makeDewsOverflowPlan(now);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
          },
          now - 60,
        );
      }
      if (key === "telegram:dispatch-overflow-plan") {
        return {
          value: JSON.stringify({
            version: 1,
            writtenAt: now - 60,
            plans: [{ ...overflowPlan, expiresAt: now + 3600 }],
          }),
          updatedAt: now - 60,
        };
      }
      return null;
    });

    const db = fixtureMockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 12, band: "CALM", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "GROUP BY chat_id", rows: [] },
      { match: "SELECT s.chat_id", rows: [{ chat_id: overflowPlan.chatId, dews_active: 1 }] },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "UPDATE telegram_alert_job_targets", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventlessFastPath?: boolean;
      pendingEnqueued: number;
      freshOverflow: number;
      cappedAtLimit: boolean;
    };

    expect(result.itemCount).toBe(0);
    expect(metadata.eventlessFastPath).toBe(true);
    expect(metadata.pendingEnqueued).toBe(1);
    expect(metadata.freshOverflow).toBe(1);
    expect(metadata.cappedAtLimit).toBe(true);
    expect(formatConsolidatedMessageSpy).toHaveBeenCalledTimes(1);
    expect(mockSendToChat).not.toHaveBeenCalled();
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"))).toBe(true);
    const activeOverflowQuery = history.find((entry) => entry.sql.includes("SELECT s.chat_id"));
    expect(activeOverflowQuery?.sql).toContain("preset.alert_dews = 1");
    expect(activeOverflowQuery?.sql).toContain("preset.alert_depeg = 1");
    expect(activeOverflowQuery?.sql).toContain("preset.alert_safety = 1");
    expect(activeOverflowQuery?.sql).not.toContain("preset.alert_launch");
    expect(activeOverflowQuery?.sql).not.toContain("preset.alert_reserve");

    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) => call[1] === "telegram:dispatch-overflow-plan");
    expect(overflowBacklogWrite).toBeDefined();
    const overflowBacklog = JSON.parse(String(overflowBacklogWrite?.[2])) as {
      plans: unknown[];
    };
    expect(overflowBacklog.plans).toHaveLength(0);
  });

  it("prunes forgotten chats from the stored overflow plan backlog", async () => {
    const now = Math.floor(Date.now() / 1000);
    const forgottenPlan = makeDewsOverflowPlan(now, "chat-forgotten");
    const keptPlan = makeDewsOverflowPlan(now, "chat-kept");

    mockGetCache.mockResolvedValue({
      value: JSON.stringify({
        version: 1,
        writtenAt: now - 60,
        plans: [
          { ...forgottenPlan, expiresAt: now + 3600 },
          { ...keptPlan, expiresAt: now + 3600 },
        ],
      }),
      updatedAt: now - 60,
    });

    await pruneOverflowPlanBacklogForChat(fixtureMockD1([]), "chat-forgotten", now);

    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) => call[1] === "telegram:dispatch-overflow-plan");
    expect(overflowBacklogWrite).toBeDefined();
    const overflowBacklog = JSON.parse(String(overflowBacklogWrite?.[2])) as {
      plans: Array<{ chatId: string }>;
    };
    expect(overflowBacklog.plans.map((plan) => plan.chatId)).toEqual(["chat-kept"]);
  });

  it("does not enqueue cached overflow plans for chats without active subscriptions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const overflowPlan = makeDewsOverflowPlan(now, "chat-forgotten");

    const db = fixtureMockD1([
      { match: "SELECT s.chat_id", rows: [] },
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
    ]);

    const result = await deliverTelegramSubscriberQueue({
      db,
      subscriberQueue: [],
      overflowPlanned: [overflowPlan],
      overflowFormatBudget: 1,
      botToken: "bot-token",
      drainResult: emptyDrainResult(),
      maxMessagesPerRun: 10,
      nowSec: now,
      chatsInBackoff: new Map(),
      globalBackoffUntil: null,
      dispatchStartedAtMs: Date.now(),
    });

    expect(formatConsolidatedMessageSpy).not.toHaveBeenCalled();
    expect(result.pendingEnqueued).toBe(0);
    expect(result.remainingOverflowPlanned).toEqual([]);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"))).toBe(false);
  });

  it("still drains due pending rows during an otherwise eventless run", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache(
          {
            "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
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
      {
        match: "SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total",
        first: {
          total: 1,
          expired: 0,
          due: 1,
          deferred: 0,
          near_ttl: 0,
          oldest_pending_created_at: now - 120,
          oldest_due_created_at: now - 120,
        },
        rows: [],
      },
      { match: "FROM telegram_pending_alerts p", rows: [] },
    ]);

    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });

    const result = await dispatchTelegramAlerts(db, "bot-token", undefined, undefined, reportProgress);
    const metadata = JSON.parse(result.metadata) as {
      eventlessFastPath?: boolean;
      pendingTotal: number;
    };

    expect(metadata.eventlessFastPath).toBe(true);
    expect(metadata.pendingTotal).toBe(1);
    expect(result.itemCount).toBe(0);
    expect(progressUpdates.find((update) => update.stage === "source-loading")).toMatchObject({
      itemsTotal: 5,
      metadata: {
        providerFamilies: ["dews", "depeg", "safety", "launch", "reserve"],
      },
    });
    expect(progressUpdates.find((update) => update.stage === "source-loaded")).toMatchObject({
      itemsDone: 5,
      itemsTotal: 5,
      metadata: {
        providerFamilies: ["dews", "depeg", "safety", "launch", "reserve"],
        reserveSourceUnavailable: true,
        countTotals: {
          reserveDriftIds: 0,
        },
      },
    });
    expect(progressUpdates.find((update) => update.stage === "event-detection")).toMatchObject({
      itemsTotal: 5,
      metadata: {
        providerFamilies: ["dews", "depeg", "safety", "launch", "reserve"],
        reserveSourceUnavailable: true,
      },
    });
    expect(progressUpdates.find((update) => update.stage === "pending-drain")).toMatchObject({
      metadata: {
        providerFamily: "telegram-api",
        phase: "pending-drain",
        eventlessFastPath: true,
        deferredTail: {
          total: 1,
          due: 1,
          deferred: 0,
          expired: 0,
        },
      },
    });
    expect(progressUpdates.find((update) => update.stage === "complete")).toMatchObject({
      metadata: {
        providerFamily: "telegram-dispatch",
        phase: "complete",
        countTotals: {
          pendingAttempted: 0,
          pendingSent: 0,
          pendingDeferred: 0,
          pendingDropped: 0,
        },
        deferredTail: {
          total: 1,
          due: 1,
        },
      },
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_pending_alerts p"))).toBe(true);
  });
});
