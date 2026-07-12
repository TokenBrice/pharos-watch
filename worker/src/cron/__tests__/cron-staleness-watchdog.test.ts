import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildCacheStatusesMock, cacheStore, detailUpdatedAtStore, deletedCacheKeys, sendAlertMock } = vi.hoisted(() => ({
  buildCacheStatusesMock: vi.fn(),
  cacheStore: new Map<string, string>(),
  detailUpdatedAtStore: new Map<string, number>(),
  deletedCacheKeys: [] as string[],
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
  getCacheUpdatedAt: vi.fn(async (_db: D1Database, key: string) => detailUpdatedAtStore.get(key) ?? null),
  setCache: vi.fn(async (_db: D1Database, key: string, value: string) => {
    cacheStore.set(key, value);
  }),
  deleteCache: vi.fn(async (_db: D1Database, key: string) => {
    cacheStore.delete(key);
    deletedCacheKeys.push(key);
  }),
}));

import { evaluateCronStaleness, loadDetailWriteFailures, runCronStalenessWatchdog } from "../cron-staleness-watchdog";

const ALERT_KEY = "cron-staleness-watchdog:alert:stablecoins";
const DIRECT_ALERT_KEY = `${ALERT_KEY}:direct:v1`;
const DETAIL_ALERT_KEY = "cron-staleness-watchdog:alert:detail-write-failures";
const DETAIL_DIRECT_ALERT_KEY = `${DETAIL_ALERT_KEY}:direct:v1`;

interface FakeFailureRow {
  key: string;
  value: string;
  updated_at: number;
}

// Minimal D1 stand-in for the raw cache queries that bypass the mocked
// db-cache module: detail-write-failure marker scans plus the batched
// `IN (...)` reads/deletes for alert markers and detail updated_at lookups.
function fakeDb(failureRows: FakeFailureRow[] = []): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.startsWith("DELETE FROM cache WHERE key IN")) {
            for (const key of args as string[]) {
              cacheStore.delete(key);
              deletedCacheKeys.push(key);
            }
          } else if (sql.startsWith("DELETE")) {
            const cutoff = args[1] as number;
            for (let i = failureRows.length - 1; i >= 0; i -= 1) {
              if (failureRows[i].updated_at < cutoff) failureRows.splice(i, 1);
            }
          }
          return { meta: { changes: 0 } };
        },
        all: async () => {
          if (sql.startsWith("SELECT key, value FROM cache WHERE key IN")) {
            const keys = args as string[];
            return {
              results: keys
                .filter((key) => cacheStore.has(key))
                .map((key) => ({ key, value: cacheStore.get(key) })),
            };
          }
          if (sql.startsWith("SELECT key, updated_at FROM cache WHERE key IN")) {
            const keys = args as string[];
            return {
              results: keys
                .filter((key) => detailUpdatedAtStore.has(key))
                .map((key) => ({ key, updated_at: detailUpdatedAtStore.get(key) })),
            };
          }
          return {
            results: failureRows.filter((row) => row.updated_at >= (args[1] as number)),
          };
        },
      }),
    }),
  } as unknown as D1Database;
}

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
    detailUpdatedAtStore.clear();
    deletedCacheKeys.length = 0;
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

  it("treats malformed watched cache freshness as stale", () => {
    const stale = evaluateCronStaleness({
      stablecoins: { ageSeconds: Number.NaN },
      "fx-rates": { ageSeconds: Number.POSITIVE_INFINITY },
      "dex-liquidity": { ageSeconds: 0 },
      "yield-data": { ageSeconds: 0 },
      dews: { ageSeconds: 0 },
    });

    expect(stale).toEqual([
      expect.objectContaining({
        cacheKey: "stablecoins",
        ageSeconds: Number.NaN,
        availabilityImpacting: true,
      }),
      expect.objectContaining({
        cacheKey: "fx-rates",
        ageSeconds: Number.POSITIVE_INFINITY,
        availabilityImpacting: true,
      }),
    ]);
  });

  it("does not recover stale markers when watched cache freshness is malformed", async () => {
    cacheStore.set(ALERT_KEY, JSON.stringify({ firstStaleAt: 100, lastObservedAt: 100, lastAlertedAt: 100 }));
    mockCacheStatus({ stablecoins: Number.NaN });

    const result = await runCronStalenessWatchdog(fakeDb(), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      stale: Array<{ cacheKey: string }>;
      recovered: string[];
    };

    expect(result.status).toBe("degraded");
    expect(metadata.stale.map((entry) => entry.cacheKey)).toEqual(["stablecoins"]);
    expect(metadata.recovered).toEqual([]);
    expect(cacheStore.has(ALERT_KEY)).toBe(true);
  });

  it("does not mark stale alerts delivered when the webhook send fails", async () => {
    sendAlertMock.mockResolvedValueOnce(false);
    mockCacheStatus({ stablecoins: 1_801 });

    const result = await runCronStalenessWatchdog(fakeDb(), "https://alerts.example/webhook");
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
    expect(cacheStore.has(DIRECT_ALERT_KEY)).toBe(false);
  });

  it("ignores legacy delivery timestamps while preserving the stale observation", async () => {
    cacheStore.set(ALERT_KEY, JSON.stringify({ firstStaleAt: 100, lastObservedAt: 100, lastAlertedAt: 100 }));
    mockCacheStatus({ stablecoins: 1_801 });

    const result = await runCronStalenessWatchdog(fakeDb(), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as { alerted: string[] };

    expect(metadata.alerted).toEqual(["stablecoins"]);
    expect(sendAlertMock).toHaveBeenCalledWith(
      "https://alerts.example/webhook",
      "Cron freshness stale",
      expect.any(String),
    );
    expect(cacheStore.has(ALERT_KEY)).toBe(true);
    expect(JSON.parse(cacheStore.get(DIRECT_ALERT_KEY) ?? "{}")).toMatchObject({
      lastAlertedAt: expect.any(Number),
    });
  });

  it("reports DEX-to-DEWS dependency recovery state", async () => {
    mockCacheStatus({
      "dex-liquidity": 120,
      dews: 4_000,
    });

    const result = await runCronStalenessWatchdog(fakeDb(), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      dependencyRecoveryChecks?: Array<{ root: string; dependent: string; state: string }>;
    };

    expect(metadata.dependencyRecoveryChecks).toContainEqual({
      root: "dex-liquidity",
      dependent: "dews",
      state: "root-recovered-dependent-stale",
      rootAgeSeconds: 120,
      dependentAgeSeconds: 4_000,
    });
  });

  it("keeps recovered alert markers when the recovery webhook send fails", async () => {
    cacheStore.set(ALERT_KEY, JSON.stringify({ firstStaleAt: 100, lastObservedAt: 100, lastAlertedAt: 100 }));
    cacheStore.set(DIRECT_ALERT_KEY, JSON.stringify({ lastAlertedAt: 100 }));
    sendAlertMock.mockResolvedValueOnce(false);
    mockCacheStatus({ stablecoins: 0 });

    const result = await runCronStalenessWatchdog(fakeDb(), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      recovered: string[];
      failedRecoveryAlerts: string[];
    };

    expect(metadata.recovered).toEqual(["stablecoins"]);
    expect(metadata.failedRecoveryAlerts).toEqual(["stablecoins"]);
    expect(cacheStore.has(ALERT_KEY)).toBe(true);
    expect(cacheStore.has(DIRECT_ALERT_KEY)).toBe(true);
  });

  it("clears recovered alert markers after the recovery webhook is delivered", async () => {
    cacheStore.set(ALERT_KEY, JSON.stringify({ firstStaleAt: 100, lastObservedAt: 100, lastAlertedAt: 100 }));
    cacheStore.set(DIRECT_ALERT_KEY, JSON.stringify({ lastAlertedAt: 100 }));
    mockCacheStatus({ stablecoins: 0 });

    const result = await runCronStalenessWatchdog(fakeDb(), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      deliveredRecoveryAlerts: string[];
    };

    expect(metadata.deliveredRecoveryAlerts).toEqual(["stablecoins"]);
    expect(cacheStore.has(ALERT_KEY)).toBe(false);
    expect(cacheStore.has(DIRECT_ALERT_KEY)).toBe(false);
  });

  it("parses fresh detail write-failure markers and prunes expired ones", async () => {
    const nowSec = 1_750_000_000;
    const rows: FakeFailureRow[] = [
      {
        key: "detail-write-failure:usdt-tether",
        value: JSON.stringify({ reason: "value-too-large", bytes: 21_000_000 }),
        updated_at: nowSec - 600,
      },
      {
        key: "detail-write-failure:old-coin",
        value: JSON.stringify({ reason: "write-error", bytes: 100 }),
        updated_at: nowSec - 8 * 24 * 3600,
      },
    ];

    const failures = await loadDetailWriteFailures(fakeDb(rows), nowSec);

    expect(failures).toEqual([
      { stablecoinId: "usdt-tether", reason: "value-too-large", bytes: 21_000_000, ageSeconds: 600 },
    ]);
    // The 8-day-old marker is pruned by the retention DELETE.
    expect(rows.map((row) => row.key)).toEqual(["detail-write-failure:usdt-tether"]);
  });

  it("degrades and alerts when detail cache writes are failing", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const rows: FakeFailureRow[] = [
      {
        key: "detail-write-failure:usdt-tether",
        value: JSON.stringify({ reason: "value-too-large", bytes: 21_000_000 }),
        updated_at: Math.floor(Date.now() / 1000) - 60,
      },
    ];

    const result = await runCronStalenessWatchdog(fakeDb(rows), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      detailWriteFailures: Array<{ stablecoinId: string }>;
      detailFailureAlerted: boolean;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.detailWriteFailures.map((f) => f.stablecoinId)).toEqual(["usdt-tether"]);
    expect(metadata.detailFailureAlerted).toBe(true);
    expect(sendAlertMock).toHaveBeenCalledWith(
      "https://alerts.example/webhook",
      "Detail cache writes failing",
      expect.stringContaining("detail:usdt-tether: value-too-large"),
    );
    const marker = JSON.parse(cacheStore.get(DETAIL_ALERT_KEY) ?? "{}") as { lastAlertedAt?: number };
    expect(marker.lastAlertedAt).toBeGreaterThan(0);
    expect(JSON.parse(cacheStore.get(DETAIL_DIRECT_ALERT_KEY) ?? "{}")).toMatchObject({
      lastAlertedAt: expect.any(Number),
    });
  });

  it("treats a marker as recovered when the detail row was rewritten after it", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const nowSec = Math.floor(Date.now() / 1000);
    const rows: FakeFailureRow[] = [
      {
        key: "detail-write-failure:usdt-tether",
        value: JSON.stringify({ reason: "write-error", bytes: 500 }),
        updated_at: nowSec - 600,
      },
    ];
    detailUpdatedAtStore.set("detail:usdt-tether", nowSec - 60);

    const result = await runCronStalenessWatchdog(fakeDb(rows), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      detailWriteFailures: Array<{ stablecoinId: string }>;
    };

    expect(result.status).toBe("ok");
    expect(metadata.detailWriteFailures).toEqual([]);
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(deletedCacheKeys).toContain("detail-write-failure:usdt-tether");
  });

  it("keeps markers whose detail row predates the failure", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const nowSec = Math.floor(Date.now() / 1000);
    const rows: FakeFailureRow[] = [
      {
        key: "detail-write-failure:usdt-tether",
        value: JSON.stringify({ reason: "value-too-large", bytes: 2_000_000 }),
        updated_at: nowSec - 600,
      },
    ];
    detailUpdatedAtStore.set("detail:usdt-tether", nowSec - 3600);

    const result = await runCronStalenessWatchdog(fakeDb(rows), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      detailWriteFailures: Array<{ stablecoinId: string }>;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.detailWriteFailures.map((f) => f.stablecoinId)).toEqual(["usdt-tether"]);
    expect(deletedCacheKeys).not.toContain("detail-write-failure:usdt-tether");
  });

  it("respects the alert cooldown for detail write-failure alerts", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const nowSec = Math.floor(Date.now() / 1000);
    cacheStore.set(
      DETAIL_DIRECT_ALERT_KEY,
      JSON.stringify({ lastAlertedAt: nowSec - 120 }),
    );
    const rows: FakeFailureRow[] = [
      {
        key: "detail-write-failure:usdt-tether",
        value: JSON.stringify({ reason: "write-error", bytes: 500 }),
        updated_at: nowSec - 60,
      },
    ];

    const result = await runCronStalenessWatchdog(fakeDb(rows), "https://alerts.example/webhook");
    const metadata = JSON.parse(result.metadata ?? "{}") as { detailFailureAlerted: boolean };

    expect(result.status).toBe("degraded");
    expect(metadata.detailFailureAlerted).toBe(false);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });
});
