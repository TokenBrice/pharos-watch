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
  dispatchMetadata?: Record<string, unknown> | null;
}

function makeDispatchMetadataRow(meta: Record<string, unknown> | null) {
  if (meta === null) return null;
  return { metadata: JSON.stringify(meta) };
}

function makeDb(config: FakeDbConfig = {}): D1Database {
  const prepare = vi.fn((sql: string) => {
    const bind = vi.fn(() => statement);
    const first = vi.fn(async () => {
      if (sql.includes("FROM telegram_pending_alerts")) {
        return { n: config.pendingCount ?? 0 };
      }
      if (sql.includes("FROM cron_runs WHERE job = 'dispatch-telegram-alerts'")) {
        const row = makeDispatchMetadataRow(config.dispatchMetadata ?? null);
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
      "Telegram pending backlog sustained",
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
  it("does not alert before reaching streak threshold", async () => {
    const store = installCacheStore();
    const nowSec = Math.floor(Date.now() / 1000);
    store.values.set("alert:safety-source-cache", makeSafetySourceCacheValue(nowSec - 60));
    const db = makeDb({
      pendingCount: 0,
      dispatchMetadata: {
        eventsDetected: { dews: 1, depeg: 0, safety: 0, launch: 0 },
        messagesSent: 0,
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
