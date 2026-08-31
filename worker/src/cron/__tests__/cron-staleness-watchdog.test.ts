import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildCacheStatusesMock, detailUpdatedAtStore, deletedCacheKeys, sendToChatMock } = vi.hoisted(() => ({
  buildCacheStatusesMock: vi.fn(),
  detailUpdatedAtStore: new Map<string, number>(),
  deletedCacheKeys: [] as string[],
  sendToChatMock: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.mock("../../lib/api-freshness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api-freshness")>()),
  buildCacheStatuses: buildCacheStatusesMock,
}));

vi.mock("../../lib/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/telegram")>()),
  sendToChat: sendToChatMock,
}));

import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";
import {
  CRON_STALENESS_ALERT_COOLDOWN_SEC,
  deriveCronFreshnessProducers,
  evaluateCronStaleness,
  loadDetailWriteFailures,
  runCronStalenessWatchdog,
} from "../cron-staleness-watchdog";

interface FakeFailureRow {
  key: string;
  value: string;
  updated_at: number;
}

function fakeDb(failureRows: FakeFailureRow[] = []): D1Database {
  const cacheRows = new Map<string, { value: string; updated_at: number }>();
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.startsWith("SELECT value, updated_at FROM cache WHERE key = ?")) {
            return cacheRows.get(args[0] as string) ?? null;
          }
          return null;
        },
        run: async () => {
          if (sql.startsWith("INSERT OR REPLACE INTO cache")) {
            cacheRows.set(args[0] as string, { value: args[1] as string, updated_at: args[2] as number });
          } else if (sql.startsWith("DELETE FROM cache WHERE key IN")) {
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
          if (sql.startsWith("SELECT job, MAX(started_at)")) {
            const started_at = Math.floor(Date.now() / 1000);
            return { results: (args as string[]).map((job) => ({ job, started_at })) };
          }
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
      "stablecoin-charts": { ageSeconds: ages["stablecoin-charts"] ?? 0 },
      "usds-status": { ageSeconds: ages["usds-status"] ?? 0 },
      "bluechip-ratings": { ageSeconds: ages["bluechip-ratings"] ?? 0 },
    },
    warnings: [],
    failures: [],
    diagnostics: [],
  });
}

describe("cron staleness watchdog", () => {
  beforeEach(() => {
    buildCacheStatusesMock.mockReset();
    detailUpdatedAtStore.clear();
    deletedCacheKeys.length = 0;
    sendToChatMock.mockClear();
    sendToChatMock.mockResolvedValue({ ok: true });
  });

  it("derives consumer freshness coverage from the canonical producer registry", () => {
    const added = {
      ...CRON_JOB_DEFINITIONS[0],
      job: "sync-new-consumer-surface",
      intervalSec: 600,
    };
    const producers = deriveCronFreshnessProducers([...CRON_JOB_DEFINITIONS, added]);
    expect(producers.map((producer) => producer.producerJob)).toEqual(expect.arrayContaining([
      "sync-stablecoin-charts",
      "sync-blacklist",
      "sync-mint-burn",
      "sync-live-reserves",
      "compute-safety-score-v9",
    ]));
    expect(producers)
      .toContainEqual(expect.objectContaining({
        producerJob: "sync-new-consumer-surface",
        thresholdSec: 1_800,
      }));
  });

  it("excludes producers whose staleness threshold exceeds cron_runs retention", () => {
    // A monthly cadence (3x interval = 90d) can never be proven fresh from
    // week-retained cron_runs rows; monitoring it would alert forever.
    const monthly = {
      ...CRON_JOB_DEFINITIONS[0],
      job: "yield-coverage-audit-like",
      intervalSec: 30 * 24 * 3600,
    };
    const producers = deriveCronFreshnessProducers([...CRON_JOB_DEFINITIONS, monthly]);
    expect(producers.map((producer) => producer.producerJob)).not.toContain("yield-coverage-audit-like");
    expect(producers.map((producer) => producer.producerJob)).not.toContain("yield-coverage-audit");
  });

  it("flags watched freshness lanes beyond twice their producer interval", () => {
    expect(evaluateCronStaleness({
      stablecoins: { ageSeconds: 1_801 }, "fx-rates": { ageSeconds: 1_799 }, "dex-liquidity": { ageSeconds: 14_401 }, "yield-data": { ageSeconds: 3_600 }, dews: { ageSeconds: 1_000 },
      "stablecoin-charts": { ageSeconds: 0 }, "usds-status": { ageSeconds: 0 }, "bluechip-ratings": { ageSeconds: 0 },
    }).map((entry) => entry.cacheKey)).toEqual(["stablecoins", "dex-liquidity"]);
  });

  it("treats missing or malformed watched cache freshness as stale", () => {
    expect(evaluateCronStaleness({
      stablecoins: { ageSeconds: Number.NaN }, "fx-rates": { ageSeconds: Number.POSITIVE_INFINITY }, "dex-liquidity": { ageSeconds: 0 }, dews: { ageSeconds: 0 },
      "stablecoin-charts": { ageSeconds: 0 }, "usds-status": { ageSeconds: 0 }, "bluechip-ratings": { ageSeconds: 0 },
    }).map((entry) => entry.cacheKey)).toEqual(["stablecoins", "fx-rates", "yield-data"]);
  });

  it("reports DEX-to-DEWS dependency recovery state", async () => {
    mockCacheStatus({ "dex-liquidity": 120, dews: 4_000 });
    const result = await runCronStalenessWatchdog(fakeDb());
    const metadata = JSON.parse(result.metadata ?? "{}") as { dependencyRecoveryChecks?: Array<{ root: string; dependent: string; state: string }> };
    expect(metadata.dependencyRecoveryChecks).toContainEqual(expect.objectContaining({ root: "dex-liquidity", dependent: "dews", state: "root-recovered-dependent-stale" }));
  });

  it("alerts only on stale and recovery transitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const db = fakeDb();
    mockCacheStatus({ stablecoins: 2_000 });
    await runCronStalenessWatchdog(db, undefined, { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } });
    await runCronStalenessWatchdog(db, undefined, { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-08-22T01:00:00Z"));
    mockCacheStatus({ stablecoins: 0 });
    await runCronStalenessWatchdog(db, undefined, { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } });
    await runCronStalenessWatchdog(db, undefined, { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } });
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Recovered producers");
    vi.useRealTimers();
  });

  it("sends the alert to the operator chat and suppresses it when unconfigured", async () => {
    mockCacheStatus({ stablecoins: 2_000 });
    await runCronStalenessWatchdog(fakeDb(), undefined, {
      operatorTelegramCreds: { botToken: "bot", chatId: "-1009999" },
    });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(sendToChatMock.mock.calls[0]?.[0]).toBe("-1009999");

    const unconfigured = await runCronStalenessWatchdog(fakeDb(), undefined, {});
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(unconfigured.metadata ?? "{}").alertTransitions).toMatchObject({
      stale: ["sync-stablecoins"],
      sent: false,
      cooldown: false,
    });
  });

  it("suppresses a flapping transition during the alert cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const db = fakeDb();
    mockCacheStatus({ stablecoins: 2_000 });
    await runCronStalenessWatchdog(db, undefined, { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } });

    vi.setSystemTime(new Date((Date.now() + CRON_STALENESS_ALERT_COOLDOWN_SEC * 1_000 - 1_000)));
    mockCacheStatus({ stablecoins: 0 });
    const recovery = await runCronStalenessWatchdog(db, undefined, { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } });
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(recovery.metadata ?? "{}").alertTransitions).toMatchObject({
      recovered: ["sync-stablecoins"],
      sent: false,
      cooldown: true,
    });
    vi.useRealTimers();
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
