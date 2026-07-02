import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import {
  buildPendingAlertRow,
  mockCircuitBreaker,
  mockDbCache,
} from "../../test-helpers/cron";
import { getAlertSafetySourceGeneration } from "../../lib/alert-safety-source-cache";
import type { CronProgressUpdate } from "../../lib/cron-logger";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();

const STABLECOINS_CACHE_WITH_USDC = JSON.stringify({
  peggedAssets: [
    {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      pegType: "peggedUSD",
      price: 1,
      circulating: { peggedUSD: 50_000_000_000 },
    },
  ],
});

vi.mock("../../lib/db-cache", () => mockDbCache({
  getCacheFn: mockGetCache,
  setCacheFn: mockSetCache,
}));

const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();

vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker({
  shouldAttemptFetchFn: mockShouldAttemptFetch,
  recordOutcomeFn: mockRecordOutcome,
}));

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

// Count `formatConsolidatedMessage` invocations while preserving behavior, so the
// C102 budget-before-format reorder can be asserted (format-count <= fresh budget
// + allowance, not once per candidate).
const formatConsolidatedMessageSpy = vi.fn();
vi.mock("../../lib/telegram-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram-alerts")>();
  return {
    ...actual,
    formatConsolidatedMessage: (...args: Parameters<typeof actual.formatConsolidatedMessage>) => {
      formatConsolidatedMessageSpy(...args);
      return actual.formatConsolidatedMessage(...args);
    },
  };
});

const { dispatchTelegramAlerts } = await import("../dispatch-telegram-alerts");
const { deliverTelegramSubscriberQueue } = await import("../dispatch-telegram-delivery");
const { pruneOverflowPlanBacklogForChat } = await import("../dispatch-telegram-overflow");
const { buildDedupeKey, emptyDrainResult } = await import("../telegram-pending");
const { TELEGRAM_MAX_MESSAGES_PER_RUN, TELEGRAM_FORMAT_BUDGET_ALLOWANCE, TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } = await import(
  "../../lib/telegram-constants"
);

function makeSafetySourceCache(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  publishedAt: number,
) {
  return {
    value: JSON.stringify({
      generation: getAlertSafetySourceGeneration(),
      methodologyVersion: "7.10",
      publishedAt,
      snapshot,
    }),
    updatedAt: publishedAt,
  };
}

function makeSafetySnapshotCache(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  generation = getAlertSafetySourceGeneration(),
) {
  return {
    value: JSON.stringify({
      generation,
      snapshot,
    }),
    updatedAt: Math.floor(Date.now() / 1000) - 60,
  };
}

function makeDewsOverflowPlan(now: number, chatId = "chat-overflow") {
  return {
    chatId,
    alertType: "dews" as const,
    estimatedChunks: 1,
    entry: {
      lastActiveAt: now,
      alerts: {
        dews: [{
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          oldBand: "CALM",
          newBand: "WARNING",
          score: 55,
          topSignals: [],
        }],
        depegTriggered: [],
        depegResolved: [],
        depegWorsening: [],
        safety: [],
        launch: [],
        reserve: [],
      },
      quietHoursEnabled: false,
      quietHoursStartUtc: null,
      quietHoursEndUtc: null,
      timezone: null,
      specificCount: 1,
      globalCount: 0,
    },
  };
}

function countPendingAlertInsertBatches(db: MockD1Database): () => number {
  const originalBatch = db.batch.bind(db);
  let pendingInsertBatchCount = 0;
  db.batch = (async (statements: D1PreparedStatement[]) => {
    if (statements.some((statement) =>
      ((statement as { sql?: string }).sql ?? "").includes("INSERT INTO telegram_pending_alerts")
    )) {
      pendingInsertBatchCount += 1;
    }
    return originalBatch(statements);
  }) as D1Database["batch"];
  return () => pendingInsertBatchCount;
}

function parseLogRecords(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));

  mockGetCache.mockReset();
  mockSetCache.mockReset();
  formatConsolidatedMessageSpy.mockReset();
  mockShouldAttemptFetch.mockReset();
  mockRecordOutcome.mockReset();
  mockSendToChat.mockReset();
  mockSendBatch.mockReset();

  mockShouldAttemptFetch.mockResolvedValue(true);
  mockSetCache.mockResolvedValue(undefined);
  mockRecordOutcome.mockResolvedValue(undefined);
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

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchTelegramAlerts", () => {
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
    const db = mockD1([
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
    const db = mockD1([
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

    expect(mockSendBatch.mock.calls[0]?.[4]).toEqual({
      softDeadlineAtMs: dispatchStartedAtMs + TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
    });
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
    const db = mockD1([
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
    const db = mockD1([
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

    const db = mockD1([]);
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

    const db = mockD1([]);
    const result = await dispatchTelegramAlerts(db, "bot-token");

    expect(JSON.parse(result.metadata)).toHaveProperty("skipped", "circuit-open");
    expect(result.itemCount).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it("drains due pending rows even when the Telegram API circuit is open", async () => {
    mockShouldAttemptFetch.mockResolvedValue(false);
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "COUNT(*) AS total",
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
        rows: [buildPendingAlertRow({ id: 1, chatId: "100", html: "<b>Queued alert</b>", createdAt: now - 120 })],
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
    const db = mockD1([]);

    await expect(dispatchTelegramAlerts(db, "bot-token", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not record a Telegram API circuit failure for source-loading D1 errors", async () => {
    const db = mockD1([
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

    const db = mockD1([
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
        return makeSafetySourceCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
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
        return makeSafetySourceCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
        }, now - 60);
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

    const db = mockD1([
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

    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) =>
      call[1] === "telegram:dispatch-overflow-plan"
    );
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

    await pruneOverflowPlanBacklogForChat(mockD1([]), "chat-forgotten", now);

    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) =>
      call[1] === "telegram:dispatch-overflow-plan"
    );
    expect(overflowBacklogWrite).toBeDefined();
    const overflowBacklog = JSON.parse(String(overflowBacklogWrite?.[2])) as {
      plans: Array<{ chatId: string }>;
    };
    expect(overflowBacklog.plans.map((plan) => plan.chatId)).toEqual(["chat-kept"]);
  });

  it("does not enqueue cached overflow plans for chats without active subscriptions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const overflowPlan = makeDewsOverflowPlan(now, "chat-forgotten");

    const db = mockD1([
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
        return makeSafetySourceCache({
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      {
        match: "COUNT(*) AS total",
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

  it("detects DEWS/depeg/safety changes and fans out to subscribers", async () => {
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
        return makeSafetySourceCache({
          "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
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
      {
        match: "FROM safety_grade_history",
        rows: [{ stablecoin_id: "usdc-circle", grade: "C", score: 61 }],
      },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      // Phase 3: batched subscriber lookups
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }] },
      {
        match: "sub.alert_depeg = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number; depeg: number; safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected).toMatchObject({
      dews: 1,
      depeg: 1,
      depegTriggered: 1,
      depegResolved: 0,
      depegWorsening: 0,
      safety: 1,
      suppressedMethodologyChanges: 0,
    });
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
  });

  it("suppresses only safety alerts when the live safety source cache is from the wrong generation", async () => {
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
          "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.08" },
        }, "legacy-generation");
      }
      if (key === "alert:safety-source-cache") {
        return {
          value: JSON.stringify({
            generation: "legacy-generation",
            methodologyVersion: "7.09",
            publishedAt: now - 60,
            snapshot: {
              "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.09" },
            },
          }),
          updatedAt: now - 60,
        };
      }
      return null;
    });

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "FROM safety_grade_history",
        rows: [{
          stablecoin_id: "usdc-circle",
          grade: "C",
          score: 61,
          prev_grade: "B",
          prev_score: 78,
          recorded_at: now,
          methodology_version: "7.09",
        }],
      },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      {
        match: "sub.alert_safety = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number; safety: number };
      messagesSent: number;
      safetyAlertSourceState: string;
      safetyAlertsSuppressed: boolean;
    };

    expect(metadata.eventsDetected.dews).toBe(1);
    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.messagesSent).toBe(1);
    expect(metadata.safetyAlertSourceState).toBe("wrong-generation");
    expect(metadata.safetyAlertsSuppressed).toBe(true);
  });

  it("fans out global all-stablecoin alert subscriptions without per-coin rows", async () => {
    const now = Math.floor(Date.now() / 1000);

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

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
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
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.dews).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("777");
  });

  it("sends global safety alerts only for material downgrades", async () => {
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
          "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({
          "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_safety = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("777");
  });

  it("sends global safety alerts for scoreless downgrades", async () => {
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
          "usdc-circle": { grade: "B", score: null, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({
          "usdc-circle": { grade: "C+", score: null, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_safety = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("777");
  });

  it("suppresses minor global safety downgrades", async () => {
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
          "usdc-circle": { grade: "B-", score: 65, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({
          "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_safety = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(1);
    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("batches resolved depeg lookups into one query", async () => {
    const now = Math.floor(Date.now() / 1000);

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
              deviationBps: 125,
              price: 0.9875,
              pegReference: 1,
            },
            "usdt-tether": {
              symbol: "USDT",
              direction: "below",
              deviationBps: 110,
              price: 0.989,
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

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "FROM depeg_events event",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peak_deviation_bps: 125,
            started_at: now - 3600,
            ended_at: now - 300,
            recovery_price: 1,
          },
          {
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peak_deviation_bps: 110,
            started_at: now - 1800,
            ended_at: now - 240,
            recovery_price: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { depegResolved: number; depeg: number };
    };

    expect(metadata.eventsDetected.depegResolved).toBe(2);
    expect(metadata.eventsDetected.depeg).toBe(2);

    const resolvedLookupQueries = db.getHistory().filter((entry) => entry.sql.includes("FROM depeg_events event"));
    expect(resolvedLookupQueries).toHaveLength(1);
    expect(resolvedLookupQueries[0]?.binds).toHaveLength(2);
  });

  it("chunks resolved depeg and fan-out IN queries above 100 changed coins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 101 }, (_, index) => `synthetic-${index}`);
    const previousDepegSnapshot = Object.fromEntries(ids.map((stablecoinId, index) => [
      stablecoinId,
      {
        symbol: `S${index}`,
        direction: "below",
        deviationBps: 125,
        price: 0.9875,
        pegReference: 1,
      },
    ]));

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify(previousDepegSnapshot), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });

    const resolvedRows = ids.map((stablecoinId, index) => ({
      stablecoin_id: stablecoinId,
      symbol: `S${index}`,
      peak_deviation_bps: 125,
      started_at: now - 3_600,
      ended_at: now - 300,
      recovery_price: 1,
    }));
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM depeg_events event", rows: resolvedRows },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "FROM telegram_subscriptions\n          WHERE stablecoin_id IN", rows: [] },
      { match: "SELECT id, chat_id, message_html", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { depegResolved: number } };

    expect(metadata.eventsDetected.depegResolved).toBe(101);
    const inQueries = db.getHistory().filter((entry) =>
      entry.sql.includes("FROM depeg_events event") ||
      entry.sql.includes("sub.alert_depeg = 1") ||
      entry.sql.includes("FROM telegram_subscriptions\n          WHERE stablecoin_id IN")
    );
    expect(inQueries.length).toBeGreaterThanOrEqual(6);
    expect(inQueries.every((entry) => entry.binds.length <= 100)).toBe(true);
    const resolvedLookupQueries = inQueries.filter((entry) => entry.sql.includes("FROM depeg_events event"));
    expect(resolvedLookupQueries.map((entry) => entry.binds.length)).toEqual([90, 11]);
  });

  it("lets a per-coin DEWS threshold override a global all-stablecoin follow", async () => {
    const now = Math.floor(Date.now() / 1000);

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

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "777", last_active_at: now, dews_min_band: "WARNING" }],
      },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
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
    const metadata = JSON.parse(result.metadata) as {
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("lets a per-coin safety follow override the global material-only safety tier", async () => {
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
          "usdc-circle": { grade: "B-", score: 65, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({
          "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{
          stablecoin_id: "usdc-circle",
          chat_id: "777",
          last_active_at: now,
          safety_mode: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        }],
      },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
  });

  it("lets a restrictive per-coin safety mode suppress the global safety tier", async () => {
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
          "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" },
        });
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({
          "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_safety = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{
          stablecoin_id: "usdc-circle",
          chat_id: "777",
          last_active_at: now,
          safety_mode: "upgrade-only",
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
        }],
      },
      {
        match: "WHERE global_alert_safety = 1",
        rows: [{ chat_id: "777", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("treats first-seen ids in a partial legacy safety snapshot as seed-only without alerting", async () => {
    const now = 1_778_150_000;
    const snapshotUpdatedAt = now - 3600;

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:safety-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": { grade: "A", score: 84 },
          }),
          updatedAt: snapshotUpdatedAt,
        };
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({
          "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
          "bold-liquity": { grade: "B+", score: 79, methodologyVersion: "7.09" },
        }, snapshotUpdatedAt);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "GROUP BY stablecoin_id",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            grade: "A",
            score: 84,
            prev_grade: null,
            prev_score: null,
            recorded_at: snapshotUpdatedAt - 86_400,
          },
          {
            stablecoin_id: "bold-liquity",
            grade: "B+",
            score: 79,
            prev_grade: "A-",
            prev_score: 80,
            recorded_at: snapshotUpdatedAt + 60,
          },
        ],
      },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        // Timestamp bind is dynamic (Date.now() inside dispatcher) so matchBinds
        // here is loose — SQL substring alone distinguishes the safety lookup.
        match: "sub.alert_safety = 1",
        rows: [{ stablecoin_id: "bold-liquity", chat_id: "12345", last_active_at: now }],
      },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
    };

    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.subscribersNotified).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();

    const safetySnapshotCall = mockSetCache.mock.calls.find((call) => call[1] === "alert:safety-snapshot");
    expect(safetySnapshotCall?.[2]).toContain("\"bold-liquity\"");
    expect(safetySnapshotCall?.[2]).toContain("\"usdc-circle\"");
  });

  it("does not alert on historical rows missing from a partial legacy safety snapshot", async () => {
    const now = 1_778_150_000;
    const snapshotUpdatedAt = now - 3600;

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: snapshotUpdatedAt };
      }
      if (key === "alert:safety-snapshot") {
        return {
          value: JSON.stringify({
            "usdc-circle": { grade: "A", score: 84 },
          }),
          updatedAt: snapshotUpdatedAt,
        };
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({
          "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
          "bold-liquity": { grade: "A-", score: 80, methodologyVersion: "7.09" },
        }, snapshotUpdatedAt);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "GROUP BY stablecoin_id",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            grade: "A",
            score: 84,
            prev_grade: null,
            prev_score: null,
            recorded_at: snapshotUpdatedAt - 86_400,
          },
          {
            stablecoin_id: "bold-liquity",
            grade: "A-",
            score: 80,
            prev_grade: "B+",
            prev_score: 79,
            recorded_at: snapshotUpdatedAt - 86_400,
          },
        ],
      },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { safety: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.safety).toBe(0);
    expect(metadata.subscribersNotified).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();

    const safetySnapshotCall = mockSetCache.mock.calls.find((call) => call[1] === "alert:safety-snapshot");
    expect(safetySnapshotCall?.[2]).toContain("\"bold-liquity\"");
    expect(safetySnapshotCall?.[2]).toContain("\"usdc-circle\"");
  });

  it("ignores DEWS transitions to CALM/WATCH", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "ALERT" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 20, band: "WATCH", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Phase 1: pending queue drain (empty)
      { match: "FROM telegram_pending_alerts p", rows: [] },
      // Phase 6: cleanup expired pending
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as { eventsDetected: { dews: number } };

    expect(metadata.eventsDetected.dews).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not resend the same DEWS alert band after a silent WATCH/CALM dip", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "uusd-youves": "WATCH" }), updatedAt: now - 60 };
      }
      if (key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({ "uusd-youves": "ALERT" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "uusd-youves", score: 39, band: "ALERT", signals_json: "{}" }],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { dews: number };
      messagesSent: number;
    };

    expect(metadata.eventsDetected.dews).toBe(0);
    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();

    const dewsAlertableSnapshotCall = mockSetCache.mock.calls.find(
      (call) => call[1] === "alert:dews-alertable-snapshot",
    );
    expect(dewsAlertableSnapshotCall?.[2]).toContain("\"uusd-youves\":\"ALERT\"");
  });

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

    const db = mockD1([
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
    const strikeUpdate = history.find((entry) =>
      entry.sql.includes("UPDATE telegram_subscribers") &&
      entry.sql.includes("consecutive_block_count = ?")
    );
    expect(strikeUpdate?.binds[0]).toBe(1);
    const flagCascade = history.find((entry) =>
      entry.sql.includes("UPDATE telegram_subscribers") &&
      entry.sql.includes("alert_dews=0")
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

    const db = mockD1([
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
    const flagCascade = history.find((entry) =>
      entry.sql.includes("UPDATE telegram_subscribers") &&
      entry.sql.includes("alert_launch=0")
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

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      // Pending queue has 2 messages
      {
        match: "FROM telegram_pending_alerts p",
        rows: [
          buildPendingAlertRow({ id: 1, chatId: "100", html: "<b>Old alert</b>", createdAt: now - 120 }),
          buildPendingAlertRow({ id: 2, chatId: "200", html: "<b>Old alert 2</b>", disableNotification: 1, createdAt: now - 60 }),
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
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
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

    const db = mockD1([
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
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
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

    const db = mockD1([
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
    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) =>
      call[1] === "telegram:dispatch-overflow-plan"
    );
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
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: subscribers },
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
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }] },
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

      const systemicLog = parseLogRecords(errorSpy).find((record) =>
        record.action === "dispatch-systemic-fresh-failure"
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
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      {
        match: "FROM telegram_pending_alerts p",
        rows: [buildPendingAlertRow({ id: 1, chatId: "old-chat", html: "<b>Old</b>", createdAt: now - 60 })],
      },
      { match: "sub.alert_dews = 1", rows: [{ stablecoin_id: "usdc-circle", chat_id: "fresh-chat", last_active_at: now }] },
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
    expect(db.getHistory().filter((entry) => entry.sql.includes("COUNT(*) AS total")).length).toBe(2);
  });

  it("defers fresh alerts for chats already in per-chat backoff without sending", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }] },
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
    const sentChatIds = sendBatchCalls.flatMap(
      (call) => (call[0] as Array<{ chatId: string }>).map((m) => m.chatId),
    );
    expect(sentChatIds).toEqual(["chat-B"]);
  });

  it("requeues globally rate-limited fresh sends without per-chat not_before_at", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockSendBatch.mockResolvedValue([
      { chatId: "chat-1", ok: true, blocked: false, retryable: false, permanentFailure: false, statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null },
      { chatId: "chat-2", ok: true, blocked: false, retryable: false, permanentFailure: false, statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null },
      { chatId: "chat-3", ok: true, blocked: false, retryable: false, permanentFailure: false, statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null },
      { chatId: "chat-4", ok: true, blocked: false, retryable: false, permanentFailure: false, statusCode: 200, errorClass: null, delivery: "sent", retryAfterSec: null },
      { chatId: "chat-5", ok: false, blocked: false, retryable: true, permanentFailure: false, statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 45, rateLimitScope: "global", attempted: true },
      { chatId: "chat-6", ok: false, blocked: false, retryable: true, permanentFailure: false, statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 45, rateLimitScope: "global", attempted: false },
      { chatId: "chat-7", ok: false, blocked: false, retryable: true, permanentFailure: false, statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 45, rateLimitScope: "global", attempted: false },
      { chatId: "chat-8", ok: false, blocked: false, retryable: true, permanentFailure: false, statusCode: 429, errorClass: "rate_limit", delivery: "retryable_failure", retryAfterSec: 45, rateLimitScope: "global", attempted: false },
    ]);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      if (key === "alert:depeg-snapshot") return { value: "{}", updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: "{}", updatedAt: now - 60 };
      return null;
    });

    const subscribers = Array.from({ length: 8 }, (_, index) => ({
      stablecoin_id: "usdc-circle",
      chat_id: `chat-${index + 1}`,
      last_active_at: now - index,
    }));

    const db = mockD1([
      { match: "FROM stress_signals", rows: [{ stablecoin_id: "usdc-circle", score: 55, band: "WARNING", signals_json: "{}" }] },
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
    expect(mockSetCache).toHaveBeenCalledWith(
      db,
      "telegram:global-send-backoff-until",
      String(now + 45),
    );
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

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [{ stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 260, start_price: 0.974, peg_reference: 1 }],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_depeg = 1",
        rows: [{
          stablecoin_id: "usdc-circle",
          chat_id: "12345",
          last_active_at: now,
          depeg_worsening_bps_step: 100,
        }],
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

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [{ stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 125, start_price: 0.9875, peg_reference: 1 }],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      {
        match: "WHERE global_alert_depeg = 1",
        rows: [{
          chat_id: "global-123",
          last_active_at: now,
          global_depeg_worsening_bps_step: 250,
        }],
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

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [{ stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 260, start_price: 0.974, peg_reference: 1 }],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      {
        match: "WHERE global_alert_depeg = 1",
        rows: [{
          chat_id: "global-123",
          last_active_at: now,
          global_depeg_worsening_bps_step: 250,
        }],
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

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [{ stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: 260, start_price: 0.974, peg_reference: 1 }],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: [] },
      {
        match: "WHERE global_alert_depeg = 1",
        rows: [{
          chat_id: "global-123",
          last_active_at: now,
          global_depeg_worsening_bps_step: 100,
        }],
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
        return makeSafetySourceCache({
          "usdc-circle": { grade: "C", score: 61, methodologyVersion: "v2" },
        }, now - 60);
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      {
        match: "FROM safety_grade_history",
        rows: [{
          stablecoin_id: "usdc-circle",
          grade: "C",
          score: 61,
          prev_grade: "B",
          prev_score: 78,
          recorded_at: now,
          methodology_version: "v2",
        }],
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

    const db = mockD1([
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
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [{ stablecoin_id: "usdc-circle", chat_id: "99999", last_active_at: now }] },
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
    const subscriberUpdate = history.find((e) => e.sql.includes("UPDATE telegram_subscribers") && e.sql.includes("alert_launch"));
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

    const db = mockD1([
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

  it("attaches snooze inline keyboard to every fresh subscriber alert", async () => {
    const now = Math.floor(Date.now() / 1000);

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

    const db = mockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: [
        { stablecoin_id: "usdc-circle", chat_id: "42", last_active_at: now },
      ] },
      { match: "WHERE global_alert_dews = 1", rows: [] },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    // sendBatch is mocked at file scope — inspect the BatchMessage array for the
    // per-message replyMarkup. The third positional is the batch size.
    const calls = mockSendBatch.mock.calls;
    const lastCall = calls[calls.length - 1];
    const messages = lastCall?.[0] as Array<{ replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }>;
    const callbackData = messages?.[0]?.replyMarkup?.inline_keyboard?.flat().map((button) => button.callback_data);
    expect(callbackData).toContain("status:usdc-circle");
    expect(callbackData).toContain("snooze:4h");
    // P1-U10: compact per-coin snooze control on single-coin alerts.
    expect(callbackData).toContain("coinsnooze:usdc-circle:4h");
    expect(messages?.[0]?.replyMarkup?.inline_keyboard?.length).toBeLessThanOrEqual(2);
  });

  it("attaches link_preview_options to the first chunk of single-coin alerts", async () => {
    const now = Math.floor(Date.now() / 1000);

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

    const db = mockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", rows: [
        { stablecoin_id: "usdc-circle", chat_id: "42", last_active_at: now },
      ] },
      { match: "WHERE global_alert_dews = 1", rows: [] },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    await dispatchTelegramAlerts(db, "bot-token");

    const lastCall = mockSendBatch.mock.calls[mockSendBatch.mock.calls.length - 1];
    const messages = lastCall?.[0] as Array<{
      chunkIndex?: number;
      linkPreviewOptions?: { is_disabled: boolean; url: string; prefer_small_media: boolean; show_above_text: boolean };
    }>;
    expect(messages?.[0]?.linkPreviewOptions).toEqual({
      is_disabled: false,
      url: "https://pharos.watch/stablecoin/usdc-circle",
      prefer_small_media: true,
      show_above_text: false,
    });
  });

  it("skips a chat whose alert_snooze_until_ts is in the future and reports chatsWithActiveSnooze", async () => {
    const now = Math.floor(Date.now() / 1000);

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

    // Chat A is snoozed; chat B is not. Only B should receive the DEWS alert.
    const db = mockD1([
      {
        match: "WHERE alert_snooze_until_ts IS NOT NULL",
        rows: [{ chat_id: "A" }],
      },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [
          { chat_id: "B", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null },
        ],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
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
    const metadata = JSON.parse(result.metadata) as {
      messagesSent: number;
      chatsWithActiveSnooze: number;
    };

    expect(metadata.messagesSent).toBe(1);
    expect(metadata.chatsWithActiveSnooze).toBe(1);
  });

  it("skips a global subscriber for a coin with an active per-coin snooze (P1-U10)", async () => {
    const now = Math.floor(Date.now() / 1000);

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

    // Chat C is a global DEWS subscriber AND has a per-coin snooze on usdc-circle.
    // The dispatcher must respect the per-coin snooze and skip the alert for C.
    const db = mockD1([
      { match: "FROM telegram_subscribers\n        WHERE alert_snooze_until_ts", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      // Per-coin snooze map query (loadPerCoinSnoozeMap): chat C is snoozed for usdc-circle.
      {
        match: "FROM telegram_subscriptions\n          WHERE stablecoin_id IN",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "C" }],
      },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [
          { chat_id: "C", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null },
        ],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
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
    const metadata = JSON.parse(result.metadata) as { messagesSent: number };

    expect(metadata.messagesSent).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("deduplicates 403 cleanup for a chat hit across multiple alert types", async () => {
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

    // One subscriber (42) who global-subscribes to DEWS and depeg.
    // Both alert types fire; we should only clean them up ONCE.
    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_dews = 1", matchBinds: ["usdc-circle", now, now], rows: [] },
      {
        match: "WHERE global_alert_dews = 1",
        rows: [{ chat_id: "42", last_active_at: now, quiet_hours_enabled: 0, quiet_hours_start_utc: null, quiet_hours_end_utc: null }],
      },
      { match: "WHERE global_alert_depeg = 1", rows: [] },
      { match: "WHERE global_alert_safety = 1", rows: [] },
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

    // Even though chat 42 may produce multiple routable events in some scenarios,
    // the blocked-cleanup counter reports exactly one cleanup.
    expect(metadata.blockedUsersCleanedUp).toBe(1);
  });

  it("degrades preset delivery when the preset-subscribers query fails but still sends direct/global alerts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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
      if (key === "telegram:preset-query-failure-count") {
        return null;
      }
      if (key === "stablecoins") {
        return { value: STABLECOINS_CACHE_WITH_USDC, updatedAt: now - 60 };
      }
      return null;
    });

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      // Preset query fails for every alert type.
      { match: "FROM telegram_preset_subscriptions p", throwError: new Error("D1_ERROR: connection reset"), rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    try {
      const result = await dispatchTelegramAlerts(db, "bot-token");
      const metadata = JSON.parse(result.metadata) as {
        presetQueryFailures: number;
        presetResolutionFailures: number;
        presetFailure: boolean;
        snapshotSeeded: boolean;
        subscribersNotified: number;
        messagesSent: number;
      };

      expect(metadata.presetFailure).toBe(true);
      expect(metadata.presetQueryFailures).toBeGreaterThanOrEqual(1);
      expect(metadata.presetResolutionFailures).toBe(0);
      expect(metadata.snapshotSeeded).toBe(false);
      expect(metadata.subscribersNotified).toBe(1);
      expect(metadata.messagesSent).toBe(1);
      expect(mockSendToChat).toHaveBeenCalledTimes(1);

      const presetQueryLog = parseLogRecords(warnSpy).find((record) =>
        record.action === "preset-query"
      );
      expect(presetQueryLog).toMatchObject({
        scope: "telegram",
        level: "warn",
        module: "dispatch-telegram-subscribers",
        failureKind: "query-failed",
        alertType: "dews",
        requestedStablecoinCount: 1,
        err: "D1_ERROR: connection reset",
      });

      const snapshotWrites = mockSetCache.mock.calls.filter(([_db, key]) =>
        typeof key === "string" && key.startsWith("alert:"),
      );
      expect(snapshotWrites.length).toBeGreaterThan(0);

      // The failure counter is persisted.
      const counterWrite = mockSetCache.mock.calls.find(
        ([_db, key]) => key === "telegram:preset-query-failure-count",
      );
      expect(counterWrite).toBeTruthy();
      expect(counterWrite?.[2]).toBe("1");

      // Preset failure no longer poisons the Telegram API circuit when direct
      // delivery succeeds.
      expect(mockRecordOutcome).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not resolve dynamic presets when no preset subscriber rows exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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
      if (key === "telegram:preset-query-failure-count") {
        return null;
      }
      if (key === "stablecoins") {
        return { value: STABLECOINS_CACHE_WITH_USDC, updatedAt: now - 60 };
      }
      return null;
    });

    const db = mockD1([
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
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "direct-chat", last_active_at: now }],
      },
      { match: "FROM telegram_preset_subscriptions p", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    try {
      const result = await dispatchTelegramAlerts(db, "bot-token");
      const metadata = JSON.parse(result.metadata) as {
        presetFailure: boolean;
        presetQueryFailures: number;
        presetResolutionFailures: number;
        subscribersNotified: number;
        messagesSent: number;
      };

      expect(metadata.presetFailure).toBe(false);
      expect(metadata.presetQueryFailures).toBe(0);
      expect(metadata.presetResolutionFailures).toBe(0);
      expect(metadata.subscribersNotified).toBe(1);
      expect(metadata.messagesSent).toBe(1);
      expect(mockSendToChat).toHaveBeenCalledTimes(1);
      expect(mockSendToChat.mock.calls[0]?.[0]).toBe("direct-chat");

      expect(parseLogRecords(warnSpy).some((record) => record.action === "preset-resolution")).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("degrades preset delivery when dynamic preset resolution fails but keeps direct delivery", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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
      if (key === "telegram:preset-query-failure-count") {
        return null;
      }
      return null;
    });

    const db = mockD1([
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
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "direct-chat", last_active_at: now }],
      },
      {
        match: "FROM telegram_preset_subscriptions p",
        rows: [{
          chat_id: "preset-chat",
          preset_id: "usd-top25",
          last_active_at: now,
          depeg_worsening_bps_step: null,
          quiet_hours_enabled: 0,
          quiet_hours_start_utc: null,
          quiet_hours_end_utc: null,
          timezone: null,
        }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    try {
      const result = await dispatchTelegramAlerts(db, "bot-token");
      const metadata = JSON.parse(result.metadata) as {
        presetFailure: boolean;
        presetQueryFailures: number;
        presetResolutionFailures: number;
        subscribersNotified: number;
        messagesSent: number;
      };

      expect(metadata.presetFailure).toBe(true);
      expect(metadata.presetQueryFailures).toBe(0);
      expect(metadata.presetResolutionFailures).toBe(1);
      expect(metadata.subscribersNotified).toBe(1);
      expect(metadata.messagesSent).toBe(1);
      expect(mockSendToChat).toHaveBeenCalledTimes(1);
      expect(mockSendToChat.mock.calls[0]?.[0]).toBe("direct-chat");

      const presetResolutionLog = parseLogRecords(warnSpy).find((record) =>
        record.action === "preset-resolution"
      );
      expect(presetResolutionLog).toMatchObject({
        scope: "telegram",
        level: "warn",
        module: "dispatch-telegram-subscribers",
        failureKind: "resolution-failed",
        alertType: "dews",
        reason: "stablecoins-cache-unavailable",
        presetIds: expect.arrayContaining(["usd-top25"]),
        presetCount: 10,
        requestedStablecoinCount: 1,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("clears the preset-failure counter on a successful run", async () => {
    const now = Math.floor(Date.now() / 1000);

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
      if (key === "telegram:preset-query-failure-count") {
        return { value: "2", updatedAt: now - 60 };
      }
      if (key === "stablecoins") {
        return { value: STABLECOINS_CACHE_WITH_USDC, updatedAt: now - 60 };
      }
      return null;
    });

    const db = mockD1([
      {
        match: "FROM stress_signals",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            score: 42,
            band: "ALERT",
            signals_json: JSON.stringify({ supply: { value: 45, available: true } }),
          },
        ],
      },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_dews = 1",
        matchBinds: ["usdc-circle", now, now],
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      presetFailure: boolean;
      presetQueryFailures: number;
    };

    expect(metadata.presetFailure).toBe(false);
    expect(metadata.presetQueryFailures).toBe(0);

    const counterWrite = mockSetCache.mock.calls.find(
      ([_db, key]) => key === "telegram:preset-query-failure-count",
    );
    expect(counterWrite?.[2]).toBe("0");
  });
  it("attributes per-alert-type delivery stats by dominant category", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Subscriber A receives only a DEWS change → dominant = dews.
    // Subscriber C receives only a depeg trigger → dominant = depeg.
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:launch-snapshot") return { value: JSON.stringify([]), updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
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
      {
        match: "sub.alert_dews = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "A", last_active_at: now }],
      },
      {
        match: "sub.alert_depeg = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "C", last_active_at: now - 10 }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      perAlertType: Record<string, { sent: number; enqueued: number; failed: number; blocked: number; firstSendLatencyMs: number | null }>;
      messagesSent: number;
    };

    expect(metadata.messagesSent).toBe(2);
    expect(metadata.perAlertType.dews.sent).toBe(1);
    expect(metadata.perAlertType.depeg.sent).toBe(1);
    expect(metadata.perAlertType.safety.sent).toBe(0);
    expect(metadata.perAlertType.launch.sent).toBe(0);
    expect(metadata.perAlertType.dews.firstSendLatencyMs).not.toBeNull();
    expect(metadata.perAlertType.depeg.firstSendLatencyMs).not.toBeNull();
    expect(metadata.perAlertType.safety.firstSendLatencyMs).toBeNull();
    expect(metadata.perAlertType.launch.firstSendLatencyMs).toBeNull();
  });

  it("buckets blocked/failed/enqueued by alert type", async () => {
    const now = Math.floor(Date.now() / 1000);

    // One DEWS-only subscriber whose send returns blocked → blocked++.
    // One depeg-only subscriber whose send returns a permanent failure → failed++.
    mockSendBatch.mockResolvedValueOnce([
      {
        chatId: "A",
        ok: false,
        blocked: true,
        retryable: false,
        permanentFailure: true,
        statusCode: 403,
        errorClass: "blocked",
        delivery: "blocked",
        retryAfterSec: null,
      },
      {
        chatId: "B",
        ok: false,
        blocked: false,
        retryable: false,
        permanentFailure: true,
        statusCode: 400,
        errorClass: "permanent",
        delivery: "permanent_failure",
        retryAfterSec: null,
      },
    ]);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({ "usdc-circle": "CALM" }), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "WHERE alert_snooze_until_ts IS NOT NULL", rows: [] },
      {
        match: "FROM stress_signals",
        rows: [{ stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: "{}" }],
      },
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
      {
        match: "sub.alert_dews = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "A", last_active_at: now }],
      },
      {
        match: "sub.alert_depeg = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "B", last_active_at: now - 10 }],
      },
      { match: "UPDATE telegram_subscribers", rows: [] },
      { match: "UPDATE telegram_subscriptions", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      perAlertType: Record<string, { sent: number; enqueued: number; failed: number; blocked: number; firstSendLatencyMs: number | null }>;
    };

    expect(metadata.perAlertType.dews.blocked).toBe(1);
    expect(metadata.perAlertType.dews.sent).toBe(0);
    expect(metadata.perAlertType.depeg.failed).toBe(1);
    expect(metadata.perAlertType.depeg.sent).toBe(0);
  });

  it("chunks a 120-coin depeg fan-out for one chat and preserves overflow past the format budget", async () => {
    // P1-T2: a single chat subscribed to 120 stablecoins receives one
    // consolidated depeg message that splits into multiple chunks. Many
    // additional global subscribers push total chunk demand past the
    // MAX_MESSAGES_PER_RUN cap so overflow is preserved rather than being
    // dropped, while the heavy chat is still attempted.
    const now = Math.floor(Date.now() / 1000);

    // 120 distinct synthetic stablecoin ids. They do not need to be in the
    // tracked registry — getSymbol falls back to the id when unknown.
    const stablecoinIds = Array.from({ length: 120 }, (_, i) => `scale-depeg-${i.toString().padStart(3, "0")}`);

    const depegRows = stablecoinIds.map((id, i) => ({
      stablecoin_id: id,
      symbol: `SD${i}`,
      direction: "below",
      peak_deviation_bps: 150 + (i % 50),
      start_price: 0.985,
      peg_reference: 1,
    }));

    // One mega-subscribed chat owns rows for all 120 ids; depeg subscriptions
    // are looked up via a single batched query.
    const megaChatId = "mega-chat";
    const directDepegRows = stablecoinIds.map((id) => ({
      stablecoin_id: id,
      chat_id: megaChatId,
      last_active_at: now,
      depeg_worsening_bps_step: null,
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
    }));

    // Extra global subscribers — each receives the same consolidated 120-coin
    // message. The fixture is sized to exceed the current fresh-send cap.
    const globalDepegRows = Array.from({ length: 1250 }, (_, i) => ({
      chat_id: `global-${i}`,
      last_active_at: now - 1000 - i, // older than megaChatId so mega is sent first
      quiet_hours_enabled: 0,
      quiet_hours_start_utc: null,
      quiet_hours_end_utc: null,
      global_depeg_worsening_bps_step: null,
    }));

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      // Empty depeg snapshot ⇒ every active depeg row is a fresh trigger.
      if (key === "alert:depeg-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      if (key === "alert:safety-snapshot") return { value: JSON.stringify({}), updatedAt: now - 60 };
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: depegRows },
      { match: "FROM safety_grade_history", rows: [] },
      // Pending queue empty so freshBudget = TELEGRAM_MAX_MESSAGES_PER_RUN.
      { match: "FROM telegram_pending_alerts p", rows: [] },
      { match: "sub.alert_depeg = 1", rows: directDepegRows },
      { match: "WHERE global_alert_depeg = 1", rows: globalDepegRows },
      // Capacity-overflow enqueue (one batch INSERT per overflowed chunk).
      { match: "INSERT INTO telegram_pending_alerts", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { depeg: number; depegTriggered: number };
      cappedAtLimit: boolean;
      pendingEnqueued: number;
      messagesSent: number;
      freshAttempted: number;
    };

    // All 120 depeg events were detected and routed as fresh triggers.
    expect(metadata.eventsDetected.depeg).toBe(120);
    expect(metadata.eventsDetected.depegTriggered).toBe(120);

    // sendBatch is invoked at least once; locate the call carrying mega-chat
    // messages and confirm the consolidated body was split into >1 chunks.
    expect(mockSendBatch).toHaveBeenCalled();
    const allSentMessages = mockSendBatch.mock.calls.flatMap(
      ([messages]) => messages as Array<{ chatId: string; html: string; chunkIndex?: number; canonicalHtml?: string }>,
    );
    const megaMessages = allSentMessages.filter((msg) => msg.chatId === megaChatId);
    expect(megaMessages.length).toBeGreaterThan(1); // split into multiple chunks
    // Each chunk respects the 4000-char cap.
    for (const msg of megaMessages) {
      expect(msg.html.length).toBeLessThanOrEqual(4000);
    }
    // The canonical pre-split body is shared across mega's chunks and is the
    // SAME body, so all chunks reference the same canonicalHtml.
    const canonicals = new Set(megaMessages.map((m) => m.canonicalHtml));
    expect(canonicals.size).toBe(1);
    // chunkIndex covers [0, megaMessages.length - 1] without gaps.
    const indices = megaMessages.map((m) => m.chunkIndex ?? 0).sort((a, b) => a - b);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(megaMessages.length - 1);

    // Cap and overflow: the queue is capped and excess subscribers are accounted
    // for without formatting the whole deferred tail in this invocation.
    expect(metadata.cappedAtLimit).toBe(true);
    // freshAttempted is bounded by the cap.
    expect(metadata.freshAttempted).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGES_PER_RUN);

    // The residual overflow was persisted as an unformatted plan for a later
    // bounded enqueue pass.
    const overflowBacklogWrite = mockSetCache.mock.calls.find((call) =>
      call[1] === "telegram:dispatch-overflow-plan"
    );
    expect(overflowBacklogWrite).toBeDefined();
    const overflowBacklog = JSON.parse(String(overflowBacklogWrite?.[2])) as {
      plans: unknown[];
    };
    expect(overflowBacklog.plans.length).toBeGreaterThan(0);

    // Mega chat is among the chats that got at least one fresh attempt — the
    // multi-chunk consumer did not prevent other chats from being processed.
    const sentChatIds = new Set(allSentMessages.map((m) => m.chatId));
    expect(sentChatIds.has(megaChatId)).toBe(true);
    expect(sentChatIds.size).toBeGreaterThan(1);
  });

  it("preserves the launch snapshot in the seed branch so the next healthy run still detects the transition (P1.7)", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Stand-in prior launch snapshot: pretend usdc-circle was pre-launch on the
    // last healthy run. usdc-circle is in ACTIVE_IDS but not in the live
    // PRE_LAUNCH_STABLECOINS, so it represents the kind of pre-launch -> active
    // transition this test exercises.
    const preservedLaunchIds = ["usdc-circle"];
    // First cycle: dews + depeg snapshots are missing -> seed branch fires.
    let snapshotsHealthy = false;
    let cachedLaunchSnapshot: string = JSON.stringify(preservedLaunchIds);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:launch-snapshot") {
        return { value: cachedLaunchSnapshot, updatedAt: now - 60 };
      }
      if (!snapshotsHealthy) {
        // Force seed branch by returning null for dews/depeg in cycle 1.
        return null;
      }
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      return null;
    });

    // The seed branch writes via setCache; capture the launch-snapshot write
    // so we can prove it preserved the prior IDs instead of overwriting them
    // with the (empty-of-usdc-circle) current PRE_LAUNCH set.
    mockSetCache.mockImplementation(async (_db: unknown, key: string, value: string) => {
      if (key === "alert:launch-snapshot") {
        cachedLaunchSnapshot = value;
      }
      return undefined;
    });

    // Cycle 1: seed branch only needs the three source SELECTs.
    const dbCycle1 = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);
    const cycle1 = await dispatchTelegramAlerts(dbCycle1, "bot-token");
    const cycle1Meta = JSON.parse(cycle1.metadata) as { snapshotSeeded: boolean };
    expect(cycle1Meta.snapshotSeeded).toBe(true);

    // Bug regression guard: the seed branch must NOT have written the live
    // PRE_LAUNCH_STABLECOINS set; the prior `["usdc-circle"]` must survive.
    const parsedAfterSeed = JSON.parse(cachedLaunchSnapshot) as string[];
    expect(parsedAfterSeed).toContain("usdc-circle");

    // Cycle 2: snapshots are now healthy. The preserved prior launch snapshot
    // contains usdc-circle; the live PRE_LAUNCH_STABLECOINS does not (usdc-circle
    // is active), so the launch diff must surface a launch alert.
    snapshotsHealthy = true;
    const dbCycle2 = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_launch = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "555", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const cycle2 = await dispatchTelegramAlerts(dbCycle2, "bot-token");
    const cycle2Meta = JSON.parse(cycle2.metadata) as {
      eventsDetected: { launch: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(cycle2Meta.eventsDetected.launch).toBe(1);
    expect(cycle2Meta.subscribersNotified).toBe(1);
    expect(cycle2Meta.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0]?.[0]).toBe("555");
  });

  it("does not reset the reserve baseline when the producer snapshot is corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    let producerReserveSnapshot = "{";
    let cachedReserveDispatched = JSON.stringify(["usdc-circle"]);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot" || key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({});
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({}, now - 60);
      }
      if (key === "alert:reserve-snapshot") {
        return { value: producerReserveSnapshot, updatedAt: now - 60 };
      }
      if (key === "alert:reserve-dispatched-snapshot") {
        return { value: cachedReserveDispatched, updatedAt: now - 60 };
      }
      return null;
    });

    mockSetCache.mockImplementation(async (_db: unknown, key: string, value: string) => {
      if (key === "alert:reserve-dispatched-snapshot") {
        cachedReserveDispatched = value;
      }
      return undefined;
    });

    const dbCycle1 = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);

    const cycle1 = await dispatchTelegramAlerts(dbCycle1, "bot-token");
    const cycle1Meta = JSON.parse(cycle1.metadata) as {
      eventlessFastPath?: boolean;
      reserveSourceUnavailable?: boolean;
      eventsDetected: { reserve: number };
    };

    expect(cycle1Meta.eventlessFastPath).toBe(true);
    expect(cycle1Meta.reserveSourceUnavailable).toBe(true);
    expect(cycle1Meta.eventsDetected.reserve).toBe(0);
    expect(JSON.parse(cachedReserveDispatched)).toEqual(["usdc-circle"]);

    producerReserveSnapshot = JSON.stringify(["usdc-circle"]);
    const dbCycle2 = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
    ]);

    const cycle2 = await dispatchTelegramAlerts(dbCycle2, "bot-token");
    const cycle2Meta = JSON.parse(cycle2.metadata) as {
      eventlessFastPath?: boolean;
      reserveSourceUnavailable?: boolean;
      eventsDetected: { reserve: number };
    };

    expect(cycle2Meta.eventlessFastPath).toBe(true);
    expect(cycle2Meta.reserveSourceUnavailable).toBe(false);
    expect(cycle2Meta.eventsDetected.reserve).toBe(0);
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("persists alert job manifests for reserve fanout", async () => {
    const now = Math.floor(Date.now() / 1000);

    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot" || key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:depeg-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:safety-snapshot") {
        return makeSafetySnapshotCache({});
      }
      if (key === "alert:safety-source-cache") {
        return makeSafetySourceCache({}, now - 60);
      }
      if (key === "alert:reserve-snapshot") {
        return { value: JSON.stringify(["usdc-circle"]), updatedAt: now - 60 };
      }
      if (key === "alert:reserve-dispatched-snapshot") {
        return { value: JSON.stringify([]), updatedAt: now - 60 };
      }
      return null;
    });

    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM depeg_events WHERE ended_at IS NULL", rows: [] },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_reserve = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "555", last_active_at: now }],
      },
      { match: "WHERE global_alert_reserve = 1", rows: [] },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: { reserve: number };
      subscribersNotified: number;
      messagesSent: number;
    };

    expect(metadata.eventsDetected.reserve).toBe(1);
    expect(metadata.subscribersNotified).toBe(1);
    expect(metadata.messagesSent).toBe(1);
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_alert_jobs") &&
      entry.binds[1] === "reserve"
    )).toBe(true);
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_alert_job_targets") &&
      entry.binds[4] === "reserve"
    )).toBe(true);
  });

  it("emits only the new trigger when an active depeg closes and reopens within one window", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Prior depeg snapshot: event #1 active for usdc-circle (eventId carried).
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "alert:dews-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
      if (key === "alert:dews-alertable-snapshot") {
        return { value: JSON.stringify({}), updatedAt: now - 60 };
      }
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
              eventId: 1,
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

    // Current state: event #1 ended 1 minute ago; event #2 is now active for the
    // same coin with a different event_id. The active SELECT returns event #2;
    // the resolved-lookup SELECT (MAX(ended_at)) returns event #1.
    const db = mockD1([
      { match: "FROM stress_signals", rows: [] },
      {
        match: "FROM depeg_events WHERE ended_at IS NULL",
        rows: [
          {
            event_id: 2,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 90,
            start_price: 0.991,
            peg_reference: 1,
          },
        ],
      },
      {
        match: "FROM depeg_events event",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peak_deviation_bps: 120,
            started_at: now - 1800,
            ended_at: now - 60,
            recovery_price: 1,
          },
        ],
      },
      { match: "FROM safety_grade_history", rows: [] },
      { match: "FROM telegram_pending_alerts p", rows: [] },
      {
        match: "sub.alert_depeg = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "12345", last_active_at: now }],
      },
      { match: "DELETE FROM telegram_pending_alerts WHERE created_at", rows: [] },
    ]);

    const result = await dispatchTelegramAlerts(db, "bot-token");
    const metadata = JSON.parse(result.metadata) as {
      eventsDetected: {
        depeg: number;
        depegTriggered: number;
        depegResolved: number;
        depegWorsening: number;
      };
    };

    // The new event #2 triggers, but the just-ended event #1 is represented as
    // recovery context rather than a contradictory resolved section.
    expect(metadata.eventsDetected.depegTriggered).toBe(1);
    expect(metadata.eventsDetected.depegResolved).toBe(0);
    // Worsening must NOT fire — event #1 != event #2; the new event is a
    // fresh trigger, not a worsening of the prior event.
    expect(metadata.eventsDetected.depegWorsening).toBe(0);
    const sentHtml = String(mockSendToChat.mock.calls[0]?.[1] ?? "");
    expect(sentHtml).toContain("Depeg Detected");
    expect(sentHtml).not.toContain("Depeg Resolved");
    expect(sentHtml).toContain("Re-depegged after 29m recovery");
  });
});
