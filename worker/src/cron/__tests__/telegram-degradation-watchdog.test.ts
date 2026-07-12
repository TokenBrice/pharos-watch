import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAlertSafetySourceGeneration } from "../../lib/alert-safety-source-cache";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();
const mockDeleteCache = vi.fn();

vi.mock("../../lib/db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
  deleteCache: mockDeleteCache,
}));

const mockSendAlert = vi.fn();

vi.mock("../../lib/alerts", () => ({
  sendAlert: mockSendAlert,
}));

const {
  runTelegramDegradationWatchdog,
  PENDING_BACKLOG_THRESHOLD,
  PENDING_BACKLOG_SUSTAINED_SEC,
  ZERO_SEND_STREAK_THRESHOLD,
  WATCHDOG_KEYS,
} = await import("../telegram-degradation-watchdog");

interface CacheStore {
  values: Map<string, { value: string; updatedAt: number }>;
}

function installCacheStore(): CacheStore {
  const store: CacheStore = { values: new Map() };
  mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
    return store.values.get(key) ?? null;
  });
  mockSetCache.mockImplementation(async (_db: unknown, key: string, value: string) => {
    store.values.set(key, { value, updatedAt: Math.floor(Date.now() / 1000) });
  });
  mockDeleteCache.mockImplementation(async (_db: unknown, key: string) => {
    store.values.delete(key);
  });
  return store;
}

interface FakeDbConfig {
  pendingCount?: number;
  oldestPendingAgeSec?: number | null;
  nearTtl?: number;
  sending?: number;
  pendingExecutionUnknown?: number;
  freshExecutionUnknown?: number;
  oldestExecutionUnknownAgeSec?: number | null;
  capacityError?: boolean;
  dispatchRunId?: number;
  dispatchMetadata?: Record<string, unknown> | null;
}

const PENDING_CAPACITY_TOTAL_SQL =
  "SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total";

function isPendingCapacityQuery(sql: string): boolean {
  return sql.includes("FROM telegram_pending_alerts") && sql.includes(PENDING_CAPACITY_TOTAL_SQL);
}

function makePendingCapacityRow(config: FakeDbConfig = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const pendingCount = config.pendingCount ?? 0;
  const oldestPendingAgeSec = config.oldestPendingAgeSec ?? (pendingCount > 0 ? 60 : null);
  return {
    total: pendingCount,
    expired: 0,
    due: pendingCount,
    deferred: 0,
    near_ttl: config.nearTtl ?? 0,
    oldest_pending_created_at: oldestPendingAgeSec == null ? null : nowSec - oldestPendingAgeSec,
    oldest_due_created_at: oldestPendingAgeSec == null ? null : nowSec - oldestPendingAgeSec,
    pending_sending: config.sending ?? 0,
    pending_execution_unknown: config.pendingExecutionUnknown ?? 0,
    sent_cleanup: 0,
    oldest_pending_execution_unknown_at: config.oldestExecutionUnknownAgeSec == null
      ? null
      : nowSec - config.oldestExecutionUnknownAgeSec,
    fresh_sending: 0,
    fresh_execution_unknown: config.freshExecutionUnknown ?? 0,
    oldest_fresh_execution_unknown_at: null,
    fresh_uncertain_sample_count: config.freshExecutionUnknown ?? 0,
  };
}

function makeDispatchMetadataRow(meta: Record<string, unknown> | null, id = 1) {
  if (meta === null) return null;
  return { id, metadata: JSON.stringify(meta) };
}

function makeDb(config: FakeDbConfig = {}): D1Database {
  const prepare = vi.fn((sql: string) => {
    const bind = vi.fn(() => statement);
    const first = vi.fn(async () => {
      if (isPendingCapacityQuery(sql)) {
        if (config.capacityError) throw new Error("capacity unavailable");
        return makePendingCapacityRow(config);
      }
      if (sql.includes("FROM cron_runs WHERE job = 'dispatch-telegram-alerts'")) {
        const row = makeDispatchMetadataRow(config.dispatchMetadata ?? null, config.dispatchRunId ?? 1);
        return row;
      }
      return null;
    });
    const statement = { bind, first } as unknown as D1PreparedStatement;
    return statement;
  });
  return { prepare } as unknown as D1Database;
}

function makeSafetySourceCacheValue(publishedAt: number) {
  return {
    value: JSON.stringify({
      generation: getAlertSafetySourceGeneration(),
      methodologyVersion: "7.10",
      publishedAt,
      snapshot: { "usd-coin": { grade: "A", score: 90, methodologyVersion: "7.10" } },
    }),
    updatedAt: publishedAt,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
  mockGetCache.mockReset();
  mockSetCache.mockReset();
  mockDeleteCache.mockReset();
  mockSendAlert.mockReset();
  mockSendAlert.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runTelegramDegradationWatchdog · pending backlog", () => {
  it("preserves an active incident when capacity is unavailable", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, { value: String(nowSec - 3600), updatedAt: nowSec - 3600 });
    store.values.set(WATCHDOG_KEYS.pendingAlerted, { value: "1", updatedAt: nowSec - 1800 });

    const result = await runTelegramDegradationWatchdog(
      makeDb({ capacityError: true }),
      "https://hooks.example/x",
    );
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(result.status).toBe("degraded");
    expect(meta.pendingBacklog.availability).toBe("unknown");
    expect(meta.pendingBacklog.detail).toContain("incident state preserved");
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(true);
    expect(store.values.has(WATCHDOG_KEYS.pendingAlerted)).toBe(true);
    expect(mockSendAlert).not.toHaveBeenCalledWith(
      expect.anything(),
      "Telegram pending backlog recovered",
      expect.anything(),
    );
  });

  it("treats aged execution-unknown work as delivery risk", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30),
      updatedAt: nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30,
    });

    const result = await runTelegramDegradationWatchdog(makeDb({
      pendingExecutionUnknown: 1,
      oldestExecutionUnknownAgeSec: 1800,
    }), "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.executionUnknown).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram pending delivery risk",
      expect.stringContaining("executionUnknown=1"),
    );
  });

  it("uses a preloaded pending capacity snapshot instead of rereading the queue", async () => {
    const store = installCacheStore();
    const prepare = vi.fn((sql: string) => {
      const first = vi.fn(async () => {
        if (isPendingCapacityQuery(sql)) {
          throw new Error("pending capacity should have been reused");
        }
        if (sql.includes("FROM cron_runs WHERE job = 'dispatch-telegram-alerts'")) {
          return null;
        }
        return null;
      });
      const statement = { bind: vi.fn(() => statement), first } as unknown as D1PreparedStatement;
      return statement;
    });
    const db = { prepare } as unknown as D1Database;

    const result = await runTelegramDegradationWatchdog(
      db,
      "https://hooks.example/x",
      undefined,
      {
        pendingCapacitySnapshot: {
          total: PENDING_BACKLOG_THRESHOLD + 5,
          active: PENDING_BACKLOG_THRESHOLD + 5,
          due: PENDING_BACKLOG_THRESHOLD + 5,
          deferred: 0,
          expired: 0,
          nearTtl: 0,
          sending: 0,
          pendingExecutionUnknown: 0,
          freshExecutionUnknown: 0,
          executionUnknown: 0,
          sentCleanup: 0,
          oldestExecutionUnknownAgeSec: null,
          executionUnknownSampleLimit: 5_001,
          executionUnknownLowerBound: false,
          oldestPendingAgeSec: 60,
          oldestDuePendingAgeSec: 60,
          estimatedDrainTimeSec: 300,
          drainBudgetPerRun: 900,
          dispatchIntervalSec: 300,
        },
        safetySourceAssessment: {
          state: "ok",
          ageSeconds: 60,
          generation: getAlertSafetySourceGeneration(),
          envelope: null,
        },
      },
    );
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.pendingBacklog.count).toBe(PENDING_BACKLOG_THRESHOLD + 5);
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => isPendingCapacityQuery(String(sql)))).toBe(false);
  });

  it("does not alert on first observation above threshold", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set(
      "alert:safety-source-cache",
      makeSafetySourceCacheValue(nowSec - 60),
    );
    const db = makeDb({ pendingCount: PENDING_BACKLOG_THRESHOLD + 5 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.pendingBacklog.triggered).toBe(false);
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(true);
  });

  it("alerts once threshold has been sustained beyond window", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set(
      "alert:safety-source-cache",
      makeSafetySourceCacheValue(nowSec - 60),
    );
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30),
      updatedAt: nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30,
    });
    const db = makeDb({ pendingCount: PENDING_BACKLOG_THRESHOLD + 50 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram pending delivery risk",
      expect.stringContaining("pending="),
    );
    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.alertSent).toBe(true);
    expect(result.status).toBe("degraded");
  });

  it("does not mark a pending backlog episode alerted when the alert webhook fails", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    mockSendAlert.mockResolvedValueOnce(false);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30),
      updatedAt: nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30,
    });
    const db = makeDb({ pendingCount: PENDING_BACKLOG_THRESHOLD + 50 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.alertSent).toBe(false);
    expect(store.values.has(WATCHDOG_KEYS.pendingAlerted)).toBe(false);
  });

  it("emits recovery alert and clears flag when backlog drains", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set(
      "alert:safety-source-cache",
      makeSafetySourceCacheValue(nowSec - 60),
    );
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - 3600),
      updatedAt: nowSec - 3600,
    });
    store.values.set(WATCHDOG_KEYS.pendingAlerted, { value: "1", updatedAt: nowSec - 1800 });
    const db = makeDb({ pendingCount: 10 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram pending backlog recovered",
      expect.stringContaining("cleared"),
    );
    expect(meta.pendingBacklog.recovered).toBe(true);
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(false);
    expect(store.values.has(WATCHDOG_KEYS.pendingAlerted)).toBe(false);
  });

  it("does not repeat pending backlog alerts during the same episode", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30),
      updatedAt: nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30,
    });
    store.values.set(WATCHDOG_KEYS.pendingAlerted, { value: "1", updatedAt: nowSec - 60 });
    const db = makeDb({ pendingCount: PENDING_BACKLOG_THRESHOLD + 50 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.alertSent).toBe(false);
  });

  it("ignores the legacy pending-alerted flag during direct-delivery cutover", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30),
      updatedAt: nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30,
    });
    store.values.set("telegram:degradation:pending-alerted", { value: "1", updatedAt: nowSec - 60 });

    const result = await runTelegramDegradationWatchdog(
      makeDb({ pendingCount: PENDING_BACKLOG_THRESHOLD + 50 }),
      "https://hooks.example/x",
    );
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram pending delivery risk",
      expect.any(String),
    );
    expect(meta.pendingBacklog.alertSent).toBe(true);
    expect(store.values.has(WATCHDOG_KEYS.pendingSince)).toBe(true);
    expect(store.values.has(WATCHDOG_KEYS.pendingAlerted)).toBe(true);
    expect(store.values.has("telegram:degradation:pending-alerted")).toBe(true);
  });

  it("alerts on old pending age even when queue size is below the count threshold", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30),
      updatedAt: nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30,
    });
    const db = makeDb({ pendingCount: 10, oldestPendingAgeSec: 20 * 60 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram pending delivery risk",
      expect.stringContaining("oldestAgeSec="),
    );
    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.oldestAgeSec).toBe(20 * 60);
  });

  it("alerts on estimated drain time over the threshold", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30),
      updatedAt: nowSec - PENDING_BACKLOG_SUSTAINED_SEC - 30,
    });
    // 10,801 active pending rows at the shared 1,800/run drain budget estimate to 35 min.
    const db = makeDb({ pendingCount: 10_801 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram pending delivery risk",
      expect.stringContaining("estimatedDrainTimeSec="),
    );
    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.estimatedDrainTimeSec).toBe(35 * 60);
  });

  it("alerts immediately when pending rows are near TTL expiry", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.pendingSince, {
      value: String(nowSec - 60),
      updatedAt: nowSec - 60,
    });
    const db = makeDb({ pendingCount: 3, nearTtl: 1 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram pending delivery risk",
      expect.stringContaining("nearTtl=1"),
    );
    expect(meta.pendingBacklog.triggered).toBe(true);
    expect(meta.pendingBacklog.nearTtl).toBe(1);
  });
});

describe("runTelegramDegradationWatchdog · safety source", () => {
  it("alerts when safety-source cache is missing for sustained window", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    // safety-source-cache absent => state = missing
    store.values.set(WATCHDOG_KEYS.safetySourceSince, {
      value: String(nowSec - 4000), // > 2 * 900 = 1800
      updatedAt: nowSec - 4000,
    });
    const db = makeDb({ pendingCount: 0 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram safety-source cache degraded",
      expect.stringContaining("state=missing"),
    );
    expect(meta.safetySource.triggered).toBe(true);
  });

  it("does not alert until sustained window elapses", async () => {
    const store = installCacheStore();
    installCacheStore(); // reset
    const nowSec = Math.floor(Date.now() / 1000);
    // missing safety source, flag just tripped 60s ago
    store.values.set(WATCHDOG_KEYS.safetySourceSince, {
      value: String(nowSec - 60),
      updatedAt: nowSec - 60,
    });
    const db = makeDb({ pendingCount: 0 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.safetySource.triggered).toBe(false);
  });

  it("recovers when state returns to ok after sustained breach", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.safetySourceSince, {
      value: String(nowSec - 4000),
      updatedAt: nowSec - 4000,
    });
    store.values.set(WATCHDOG_KEYS.safetySourceAlerted, { value: "1", updatedAt: nowSec - 1800 });
    const db = makeDb({ pendingCount: 0 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram safety-source cache recovered",
      expect.stringContaining("ok"),
    );
    expect(meta.safetySource.recovered).toBe(true);
    expect(store.values.has(WATCHDOG_KEYS.safetySourceSince)).toBe(false);
    expect(store.values.has(WATCHDOG_KEYS.safetySourceAlerted)).toBe(false);
  });

  it("does not repeat safety-source alerts during the same episode", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set(WATCHDOG_KEYS.safetySourceSince, {
      value: String(nowSec - 4000),
      updatedAt: nowSec - 4000,
    });
    store.values.set(WATCHDOG_KEYS.safetySourceAlerted, { value: "1", updatedAt: nowSec - 60 });
    const db = makeDb({ pendingCount: 0 });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.safetySource.triggered).toBe(true);
    expect(meta.safetySource.alertSent).toBe(false);
  });
});

describe("runTelegramDegradationWatchdog · zero-send streak", () => {
  it("does not increment the same dispatch cron run twice", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    const db = makeDb({
      dispatchRunId: 77,
      dispatchMetadata: {
        eventsDetected: { dews: 1, depeg: 0, safety: 0, launch: 0, reserve: 0 },
        messagesSent: 0,
        freshCandidateChats: 1,
      },
    });

    await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const second = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(second.metadata ?? "{}");
    const state = JSON.parse(store.values.get(WATCHDOG_KEYS.zeroSendStreak)?.value ?? "{}");

    expect(state).toEqual({ streak: 1, lastRunIdentity: "77" });
    expect(meta.zeroSend.streak).toBe(1);
    expect(meta.zeroSend.evaluated).toBe(false);
    expect(meta.zeroSend.runIdentity).toBe("77");
  });

  it("does not alert before reaching streak threshold", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 1, depeg: 0, safety: 0, launch: 0 },
        messagesSent: 0,
        freshCandidateChats: 1,
      },
    });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.zeroSend.streak).toBe(1);
  });

  it("increments the streak for a reserve-only zero-send run", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 0, depeg: 0, safety: 0, launch: 0, reserve: 2 },
        messagesSent: 0,
        freshCandidateChats: 2,
      },
    });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.zeroSend.streak).toBe(1);
  });

  it("alerts after threshold consecutive zero-send runs", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, {
      value: String(ZERO_SEND_STREAK_THRESHOLD - 1),
      updatedAt: nowSec - 60,
    });
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 2, depeg: 1, safety: 0, launch: 0 },
        messagesSent: 0,
        freshCandidateChats: 3,
      },
    });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram dispatch sent zero messages with pending events",
      expect.stringContaining(`consecutiveZeroSendRuns=${ZERO_SEND_STREAK_THRESHOLD}`),
    );
    expect(meta.zeroSend.triggered).toBe(true);
    expect(meta.zeroSend.streak).toBe(ZERO_SEND_STREAK_THRESHOLD);
  });

  it("emits recovery alert and resets streak when dispatch sends again", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, {
      value: String(ZERO_SEND_STREAK_THRESHOLD),
      updatedAt: nowSec - 60,
    });
    store.values.set(WATCHDOG_KEYS.zeroSendAlerted, { value: "1", updatedAt: nowSec - 60 });
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 1, depeg: 0, safety: 0, launch: 0 },
        messagesSent: 7,
        freshCandidateChats: 3,
      },
    });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).toHaveBeenCalledWith(
      "https://hooks.example/x",
      "Telegram dispatch zero-send streak recovered",
      expect.stringContaining("messagesSent=7"),
    );
    expect(meta.zeroSend.recovered).toBe(true);
    expect(meta.zeroSend.streak).toBe(0);
    expect(store.values.has(WATCHDOG_KEYS.zeroSendStreak)).toBe(false);
    expect(store.values.has(WATCHDOG_KEYS.zeroSendAlerted)).toBe(false);
  });

  it("does not repeat zero-send alerts during the same episode", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, {
      value: String(ZERO_SEND_STREAK_THRESHOLD),
      updatedAt: nowSec - 60,
    });
    store.values.set(WATCHDOG_KEYS.zeroSendAlerted, { value: "1", updatedAt: nowSec - 60 });
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 2, depeg: 1, safety: 0, launch: 0 },
        messagesSent: 0,
        freshCandidateChats: 3,
      },
    });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.zeroSend.triggered).toBe(true);
    expect(meta.zeroSend.alertSent).toBe(false);
  });

  it("ignores runs with no events even if messagesSent is zero", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 0, depeg: 0, safety: 0, launch: 0 },
        messagesSent: 0,
        freshCandidateChats: 0,
      },
    });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.zeroSend.triggered).toBe(false);
    expect(meta.zeroSend.streak).toBe(0);
  });

  it("ignores runs with events but no candidate chats", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 2, depeg: 0, safety: 0, launch: 0 },
        messagesSent: 0,
        freshCandidateChats: 0,
      },
    });

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    expect(mockSendAlert).not.toHaveBeenCalled();
    expect(meta.zeroSend.triggered).toBe(false);
    expect(meta.zeroSend.streak).toBe(0);
  });
});

describe("runTelegramDegradationWatchdog · abort", () => {
  it("throws when signal is already aborted", async () => {
    installCacheStore();
    const db = makeDb({ pendingCount: 0 });
    const controller = new AbortController();
    controller.abort(new Error("scheduled abort"));

    await expect(
      runTelegramDegradationWatchdog(db, "https://hooks.example/x", controller.signal),
    ).rejects.toThrow("scheduled abort");
  });
});

describe("runTelegramDegradationWatchdog · aborted-run filter", () => {
  interface CronRunRow {
    id?: number;
    status: "ok" | "degraded" | "error" | "skipped_locked";
    metadata: Record<string, unknown> | null;
  }

  // Simulates D1 filtering: returns the first row whose status appears in the
  // SQL's `status IN (...)` clause. Rows are ordered newest-first by the caller.
  function makeDbWithCronRows(rows: CronRunRow[]): D1Database {
    const prepare = vi.fn((sql: string) => {
      const bind = vi.fn(() => statement);
      const first = vi.fn(async () => {
        if (isPendingCapacityQuery(sql)) {
          return makePendingCapacityRow();
        }
        if (sql.includes("FROM cron_runs WHERE job = 'dispatch-telegram-alerts'")) {
          const inMatch = sql.match(/status IN \(([^)]+)\)/);
          const allowed = inMatch
            ? new Set(inMatch[1].split(",").map((s) => s.trim().replace(/'/g, "")))
            : null;
          const row = rows.find((r) => (allowed == null ? true : allowed.has(r.status)));
          if (!row) return null;
          return { id: row.id ?? 1, metadata: row.metadata == null ? null : JSON.stringify(row.metadata) };
        }
        return null;
      });
      const statement = { bind, first } as unknown as D1PreparedStatement;
      return statement;
    });
    return { prepare } as unknown as D1Database;
  }

  it("skips aborted run and reads the prior succeeded run's metadata", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, { value: "2", updatedAt: nowSec - 60 });
    const db = makeDbWithCronRows([
      { status: "error", metadata: null },
      {
        status: "ok",
        metadata: {
          eventsDetected: { dews: 1, depeg: 0, safety: 0, launch: 0 },
          messagesSent: 5,
        },
      },
    ]);

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    // The completed run sent messages, so the streak resets.
    expect(meta.zeroSend.streak).toBe(0);
    expect(JSON.parse(store.values.get(WATCHDOG_KEYS.zeroSendStreak)?.value ?? "{}")).toEqual({
      streak: 0,
      lastRunIdentity: "1",
    });
  });

  it("preserves the streak when every recent run aborted (no metadata)", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    store.values.set(WATCHDOG_KEYS.zeroSendStreak, { value: "2", updatedAt: nowSec - 60 });
    const db = makeDbWithCronRows([
      { status: "error", metadata: null },
      { status: "error", metadata: null },
    ]);

    const result = await runTelegramDegradationWatchdog(db, "https://hooks.example/x");
    const meta = JSON.parse(result.metadata ?? "{}");

    // No completed run found, watchdog returns without touching the streak.
    expect(meta.zeroSend.streak).toBe(2);
    expect(store.values.get(WATCHDOG_KEYS.zeroSendStreak)?.value).toBe("2");
  });
});
