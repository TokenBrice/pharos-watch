import { vi } from "vitest";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import { buildPendingAlertRow, mockCircuitBreaker, mockDbCache } from "../../test-helpers/cron";
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

vi.mock("../../lib/db-cache", () =>
  mockDbCache({
    getCacheFn: mockGetCache,
    setCacheFn: mockSetCache,
  }),
);

const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();

vi.mock("../../lib/circuit-breaker", () =>
  mockCircuitBreaker({
    shouldAttemptFetchFn: mockShouldAttemptFetch,
    recordOutcomeFn: mockRecordOutcome,
  }),
);

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
const { TELEGRAM_MAX_MESSAGES_PER_RUN, TELEGRAM_FORMAT_BUDGET_ALLOWANCE, TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } =
  await import("../../lib/telegram-constants");

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
        dews: [
          {
            stablecoinId: "usdc-circle",
            symbol: "USDC",
            oldBand: "CALM",
            newBand: "WARNING",
            score: 55,
            topSignals: [],
          },
        ],
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
    if (
      statements.some((statement) =>
        ((statement as { sql?: string }).sql ?? "").includes("INSERT INTO telegram_pending_alerts"),
      )
    ) {
      pendingInsertBatchCount += 1;
    }
    return originalBatch(statements);
  }) as D1Database["batch"];
  return () => pendingInsertBatchCount;
}

function parseLogRecords(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}
function resetDispatchTelegramAlertsTest() {
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
}

function cleanupDispatchTelegramAlertsTest() {
  vi.useRealTimers();
}

const fixtureMockD1 = mockD1;
const fixtureBuildPendingAlertRow = buildPendingAlertRow;

export {
  mockGetCache,
  mockSetCache,
  STABLECOINS_CACHE_WITH_USDC,
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
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  makeSafetySourceCache,
  makeSafetySnapshotCache,
  makeDewsOverflowPlan,
  countPendingAlertInsertBatches,
  parseLogRecords,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  type MockD1Database,
  type CronProgressUpdate,
  fixtureMockD1,
  fixtureBuildPendingAlertRow,
};
