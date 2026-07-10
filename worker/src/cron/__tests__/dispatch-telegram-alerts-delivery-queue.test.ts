import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockGetCache,
  mockSetCache,
  mockShouldAttemptFetch,
  mockRecordOutcome,
  mockInspectLegacyOverflowBacklog,
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

  it("drains a pending target produced by the legacy importer during an eventless run", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockInspectLegacyOverflowBacklog.mockResolvedValue({
      state: "imported",
      digest: "a".repeat(64),
      sourceEventId: "telegram-source:legacy-overflow:v1:imported",
      observedBytes: 1_024,
      observedPlanCount: 1,
      importCursor: 1,
      importedTargetCount: 1,
      errorClass: null,
    });

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
        rows: [fixtureBuildPendingAlertRow({
          id: 1,
          chatId: "chat-imported",
          html: "<b>Imported overflow alert</b>",
          createdAt: now - 120,
          sourceType: "legacy",
        })],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 1 } },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventlessFastPath?: boolean;
      pendingAttempted: number;
      pendingDrained: number;
      messagesSent: number;
    };

    expect(result.itemCount).toBe(1);
    expect(metadata.eventlessFastPath).toBe(true);
    expect(metadata.pendingAttempted).toBe(1);
    expect(metadata.pendingDrained).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(formatConsolidatedMessageSpy).not.toHaveBeenCalled();
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO telegram_pending_alerts"))).toBe(false);
    expect(mockInspectLegacyOverflowBacklog).toHaveBeenCalledWith(db, now);
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
      {
        match: "FROM telegram_pending_alerts p",
        rows: [fixtureBuildPendingAlertRow({
          id: 1,
          chatId: "eventless-due",
          html: "<b>Due during eventless run</b>",
          createdAt: now - 120,
        })],
      },
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
    expect(metadata.pendingTotal).toBe(0);
    expect(result.itemCount).toBe(1);
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
          pendingAttempted: 1,
          pendingSent: 1,
          pendingDeferred: 0,
          pendingDropped: 0,
        },
        deferredTail: {
          total: 0,
          due: 0,
        },
      },
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_pending_alerts p"))).toBe(true);
  });

  it.each([
    {
      label: "source-event-backfill-required",
      sourceStatus: "baseline_committed",
      expiresAtOffset: 600,
      recoveryMatch: "AS planned_targets",
      recoveryRow: {
        target_plan_state: "planning",
        target_plan_generation: 1,
        planned_targets: 1,
      },
    },
    {
      label: "source-event-expired",
      sourceStatus: "planned",
      expiresAtOffset: -1,
      recoveryMatch: "SELECT target_plan_generation FROM telegram_alert_source_events",
      recoveryRow: { target_plan_generation: 1 },
    },
  ])("drains due pending rows before the $label early return", async (scenario) => {
    const now = Math.floor(Date.now() / 1000);
    mockGetCache.mockResolvedValue(null);
    const emptyEvents = JSON.stringify({
      dewsChanges: [],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safetyChanges: [],
      launchPromoted: [],
      reservePromoted: [],
      suppressedMethodologyChanges: 0,
      dewsIds: [],
      depegIds: [],
      safetyIds: [],
      launchIds: [],
      reserveIds: [],
    });
    const emptyBaseline = JSON.stringify({
      dews: {},
      dewsAlertable: {},
      depeg: {},
      safety: {},
      launch: [],
      reserveDispatched: [],
    });
    const sourceEventId = `telegram-source:test:v1:${scenario.label}`;
    const db = fixtureMockD1([
      {
        match: "FROM telegram_legacy_overflow_state WHERE singleton = 1",
        rows: [],
        first: {
          state: "absent",
          blob_digest: null,
          synthetic_source_event_id: null,
          observed_bytes: 0,
          observed_plan_count: null,
          import_cursor: 0,
          imported_target_count: 0,
          last_error_class: null,
        },
      },
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
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
        match: "WHERE status IN ('resolving', 'planned', 'baseline_committed')",
        rows: [],
        first: {
          source_event_id: sourceEventId,
          schema_version: 1,
          status: scenario.sourceStatus,
          detected_at: now - 120,
          expires_at: now + scenario.expiresAtOffset,
          event_payload: emptyEvents,
          baseline_payload: emptyBaseline,
          attempt_count: 0,
          last_attempt_at: null,
          last_error_class: null,
          baseline_committed_at: scenario.sourceStatus === "baseline_committed" ? now - 30 : null,
          completed_at: null,
        },
      },
      {
        match: scenario.recoveryMatch,
        rows: [],
        first: scenario.recoveryRow,
      },
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          fixtureBuildPendingAlertRow({
            id: 1,
            chatId: `pending-${scenario.label}`,
            html: "<b>Queued recovery alert</b>",
            createdAt: now - 120,
          }),
        ],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE id IN", rows: [], runMeta: { changes: 1 } },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      skipped: string;
      pendingAttempted: number;
      pendingDrained: number;
      messagesSent: number;
      subscribersNotified: number;
    };

    expect(metadata).toMatchObject({
      skipped: scenario.label,
      pendingAttempted: 1,
      pendingDrained: 1,
      messagesSent: 1,
      subscribersNotified: 1,
    });
    expect(result.itemCount).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockRecordOutcome).toHaveBeenCalledWith(db, "telegram-api", true);
  });
});
