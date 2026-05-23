import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildCacheStatusesMock, cacheStore, sendAlertMock } = vi.hoisted(() => ({
  buildCacheStatusesMock: vi.fn(),
  cacheStore: new Map<string, string>(),
  sendAlertMock: vi.fn(),
}));

vi.mock("../../lib/api-freshness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-freshness")>();
  return {
    ...actual,
    buildCacheStatuses: buildCacheStatusesMock,
  };
});

vi.mock("../../lib/alerts", () => ({
  sendAlert: sendAlertMock,
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async (_db: D1Database, key: string) => {
    const value = cacheStore.get(key);
    return value == null ? null : { value, updatedAt: 0 };
  }),
  setCache: vi.fn(async (_db: D1Database, key: string, value: string) => {
    cacheStore.set(key, value);
  }),
  deleteCache: vi.fn(async (_db: D1Database, key: string) => {
    cacheStore.delete(key);
  }),
}));

import { evaluateCronStaleness, runCronStalenessWatchdog } from "../cron-staleness-watchdog";

const ALERT_KEY = "cron-staleness-watchdog:alert:stablecoins";

function mockCacheStatus(ages: Record<string, number | null>) {
  buildCacheStatusesMock.mockResolvedValue({
    caches: {
      stablecoins: { ageSeconds: ages.stablecoins ?? 0 },
      "fx-rates": { ageSeconds: ages["fx-rates"] ?? 0 },
      "dex-liquidity": { ageSeconds: ages["dex-liquidity"] ?? 0 },
      "yield-data": { ageSeconds: ages["yield-data"] ?? 0 },
      dews: { ageSeconds: ages.dews ?? 0 },
    },
    worstRatio: 0,
    failures: [],
    diagnostics: [],
    statusFloor: "healthy",
    warnings: [],
  });
}

describe("cron staleness watchdog", () => {
  beforeEach(() => {
    buildCacheStatusesMock.mockReset();
    cacheStore.clear();
    sendAlertMock.mockReset();
    sendAlertMock.mockResolvedValue(true);
  });

  it("flags watched freshness lanes beyond twice their producer interval", () => {
    const stale = evaluateCronStaleness({
      stablecoins: { ageSeconds: 1_801 },
      "fx-rates": { ageSeconds: 1_799 },
      "dex-liquidity": { ageSeconds: 3_601 },
      "yield-data": { ageSeconds: 7_200 },
      dews: { ageSeconds: 1_000 },
    });

    expect(stale.map((entry) => entry.cacheKey)).toEqual([
      "stablecoins",
      "dex-liquidity",
    ]);
  });

  it("treats missing watched cache freshness as stale", () => {
    const stale = evaluateCronStaleness({
      stablecoins: { ageSeconds: 0 },
      "fx-rates": { ageSeconds: 0 },
      "dex-liquidity": { ageSeconds: 0 },
      dews: { ageSeconds: 0 },
    });

    expect(stale).toEqual([
      expect.objectContaining({
        cacheKey: "yield-data",
        ageSeconds: null,
      }),
    ]);
  });

  it("does not mark stale alerts delivered when the webhook send fails", async () => {
    sendAlertMock.mockResolvedValueOnce(false);
    mockCacheStatus({ stablecoins: 1_801 });

    const result = await runCronStalenessWatchdog({} as D1Database, "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      alerted: string[];
      attemptedAlerts: string[];
      failedAlerts: string[];
    };
    const marker = JSON.parse(cacheStore.get(ALERT_KEY) ?? "{}") as { lastAlertedAt?: number };

    expect(metadata.attemptedAlerts).toEqual(["stablecoins"]);
    expect(metadata.alerted).toEqual([]);
    expect(metadata.failedAlerts).toEqual(["stablecoins"]);
    expect(marker.lastAlertedAt).toBe(0);
  });

  it("keeps recovered alert markers when the recovery webhook send fails", async () => {
    cacheStore.set(ALERT_KEY, JSON.stringify({ firstStaleAt: 100, lastObservedAt: 100, lastAlertedAt: 100 }));
    sendAlertMock.mockResolvedValueOnce(false);
    mockCacheStatus({ stablecoins: 0 });

    const result = await runCronStalenessWatchdog({} as D1Database, "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      recovered: string[];
      failedRecoveryAlerts: string[];
    };

    expect(metadata.recovered).toEqual(["stablecoins"]);
    expect(metadata.failedRecoveryAlerts).toEqual(["stablecoins"]);
    expect(cacheStore.has(ALERT_KEY)).toBe(true);
  });

  it("clears recovered alert markers after the recovery webhook is delivered", async () => {
    cacheStore.set(ALERT_KEY, JSON.stringify({ firstStaleAt: 100, lastObservedAt: 100, lastAlertedAt: 100 }));
    mockCacheStatus({ stablecoins: 0 });

    const result = await runCronStalenessWatchdog({} as D1Database, "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      deliveredRecoveryAlerts: string[];
    };

    expect(metadata.deliveredRecoveryAlerts).toEqual(["stablecoins"]);
    expect(cacheStore.has(ALERT_KEY)).toBe(false);
  });
});
