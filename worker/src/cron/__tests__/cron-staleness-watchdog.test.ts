import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildCacheStatusesMock, detailUpdatedAtStore, deletedCacheKeys } = vi.hoisted(() => ({
  buildCacheStatusesMock: vi.fn(),
  detailUpdatedAtStore: new Map<string, number>(),
  deletedCacheKeys: [] as string[],
}));

vi.mock("../../lib/api-freshness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api-freshness")>()),
  buildCacheStatuses: buildCacheStatusesMock,
}));

vi.mock("../../lib/db-cache", () => ({
  getCacheUpdatedAt: vi.fn(async (_db: D1Database, key: string) => detailUpdatedAtStore.get(key) ?? null),
}));

import { evaluateCronStaleness, loadDetailWriteFailures, runCronStalenessWatchdog } from "../cron-staleness-watchdog";

interface FakeFailureRow {
  key: string;
  value: string;
  updated_at: number;
}

function fakeDb(failureRows: FakeFailureRow[] = []): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.startsWith("DELETE FROM cache WHERE key IN")) {
            deletedCacheKeys.push(...(args as string[]));
          } else if (sql.startsWith("DELETE")) {
            const cutoff = args[1] as number;
            for (let i = failureRows.length - 1; i >= 0; i -= 1) {
              if (failureRows[i].updated_at < cutoff) failureRows.splice(i, 1);
            }
          }
          return { meta: { changes: 0 } };
        },
        all: async () => {
          if (sql.startsWith("SELECT key, updated_at FROM cache WHERE key IN")) {
            const keys = args as string[];
            return { results: keys.filter((key) => detailUpdatedAtStore.has(key)).map((key) => ({ key, updated_at: detailUpdatedAtStore.get(key) })) };
          }
          return { results: failureRows.filter((row) => row.updated_at >= (args[1] as number)) };
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
  });
}

describe("cron staleness watchdog", () => {
  beforeEach(() => {
    buildCacheStatusesMock.mockReset();
    detailUpdatedAtStore.clear();
    deletedCacheKeys.length = 0;
  });

  it("flags watched freshness lanes beyond twice their producer interval", () => {
    expect(evaluateCronStaleness({
      stablecoins: { ageSeconds: 1_801 }, "fx-rates": { ageSeconds: 1_799 }, "dex-liquidity": { ageSeconds: 14_401 }, "yield-data": { ageSeconds: 7_200 }, dews: { ageSeconds: 1_000 },
    }).map((entry) => entry.cacheKey)).toEqual(["stablecoins", "dex-liquidity"]);
  });

  it("treats missing or malformed watched cache freshness as stale", () => {
    expect(evaluateCronStaleness({
      stablecoins: { ageSeconds: Number.NaN }, "fx-rates": { ageSeconds: Number.POSITIVE_INFINITY }, "dex-liquidity": { ageSeconds: 0 }, dews: { ageSeconds: 0 },
    }).map((entry) => entry.cacheKey)).toEqual(["stablecoins", "fx-rates", "yield-data"]);
  });

  it("reports DEX-to-DEWS dependency recovery state", async () => {
    mockCacheStatus({ "dex-liquidity": 120, dews: 4_000 });
    const result = await runCronStalenessWatchdog(fakeDb());
    const metadata = JSON.parse(result.metadata ?? "{}") as { dependencyRecoveryChecks?: Array<{ root: string; dependent: string; state: string }> };
    expect(metadata.dependencyRecoveryChecks).toContainEqual(expect.objectContaining({ root: "dex-liquidity", dependent: "dews", state: "root-recovered-dependent-stale" }));
  });

  it("degrades when detail cache writes are failing", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const result = await runCronStalenessWatchdog(fakeDb([{ key: "detail-write-failure:usdt-tether", value: JSON.stringify({ reason: "value-too-large", bytes: 21_000_000 }), updated_at: Math.floor(Date.now() / 1000) - 60 }]));
    const metadata = JSON.parse(result.metadata ?? "{}") as { detailWriteFailures: Array<{ stablecoinId: string }> };
    expect(result.status).toBe("degraded");
    expect(metadata.detailWriteFailures.map((failure) => failure.stablecoinId)).toEqual(["usdt-tether"]);
  });

  it("treats a marker as recovered when the detail row was rewritten after it", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const nowSec = Math.floor(Date.now() / 1000);
    detailUpdatedAtStore.set("detail:usdt-tether", nowSec - 60);
    const result = await runCronStalenessWatchdog(fakeDb([{ key: "detail-write-failure:usdt-tether", value: JSON.stringify({ reason: "write-error", bytes: 500 }), updated_at: nowSec - 600 }]));
    expect(result.status).toBe("ok");
    expect(deletedCacheKeys).toContain("detail-write-failure:usdt-tether");
  });

  it("keeps markers whose detail row predates the failure", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const nowSec = Math.floor(Date.now() / 1000);
    detailUpdatedAtStore.set("detail:usdt-tether", nowSec - 600);
    const result = await runCronStalenessWatchdog(fakeDb([{ key: "detail-write-failure:usdt-tether", value: JSON.stringify({ reason: "write-error", bytes: 500 }), updated_at: nowSec - 60 }]));
    const metadata = JSON.parse(result.metadata ?? "{}") as { detailWriteFailures: Array<{ stablecoinId: string }> };
    expect(result.status).toBe("degraded");
    expect(metadata.detailWriteFailures.map((failure) => failure.stablecoinId)).toEqual(["usdt-tether"]);
    expect(deletedCacheKeys).not.toContain("detail-write-failure:usdt-tether");
  });

  it("prunes expired detail write-failure markers", async () => {
    const nowSec = 1_750_000_000;
    const rows = [{ key: "detail-write-failure:old-coin", value: "{}", updated_at: nowSec - 8 * 24 * 3600 }];
    await loadDetailWriteFailures(fakeDb(rows), nowSec);
    expect(rows).toEqual([]);
  });
});
