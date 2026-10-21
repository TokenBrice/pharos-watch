import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const { buildCacheStatusesMock, sendToChatMock, loadPublicationHealthMock } = vi.hoisted(() => ({
  buildCacheStatusesMock: vi.fn(),
  sendToChatMock: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  loadPublicationHealthMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}));

vi.mock("../../lib/safety-score-v9/publication-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/safety-score-v9/publication-health")>()),
  loadSafetyScoreV9PublicationHealth: loadPublicationHealthMock,
}));

vi.mock("../../lib/api-freshness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api-freshness")>()),
  buildCacheStatuses: buildCacheStatusesMock,
}));

vi.mock("../../telegram/delivery/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../telegram/delivery/telegram")>()),
  sendToChat: sendToChatMock,
}));

import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { CRON_RUNS_RETENTION_SEC } from "@shared/lib/retention-policy";
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

function fakeDb(failureRows: FakeFailureRow[] = [], producerPublishedAt?: number): D1Database {
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
          if (sql.startsWith("INSERT INTO cache")) {
            cacheRows.set(args[0] as string, { value: args[1] as string, updated_at: args[2] as number });
          } else if (sql.startsWith("DELETE")) {
            const cutoff = args[1] as number;
            for (let i = failureRows.length - 1; i >= 0; i -= 1) {
              if (failureRows[i].updated_at < cutoff) failureRows.splice(i, 1);
            }
          }
          return { meta: { changes: 0 } };
        },
        all: async () => {
          if (sql.includes("ROW_NUMBER() OVER")) {
            const started_at = Math.floor(Date.now() / 1000);
            return { results: (args as string[]).map((job) => ({
              job,
              last_success_at: producerPublishedAt ?? started_at,
              last_run_at: started_at,
              last_status: "ok",
            })) };
          }
          if (sql.startsWith("SELECT key, updated_at FROM cache WHERE key IN")) {
            return { results: [] };
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
    sendToChatMock.mockClear();
    sendToChatMock.mockResolvedValue({ ok: true });
    loadPublicationHealthMock.mockReset();
    loadPublicationHealthMock.mockResolvedValue(null);
  });

  it("alerts detail write failures and reports their recovery once the marker clears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };
    const failureRows = [{
      key: "detail-write-failure:usdt-tether",
      value: JSON.stringify({ reason: "value-too-large" }),
      updated_at: Math.floor(Date.now() / 1000) - 60,
    }];
    const db = fakeDb(failureRows);
    mockCacheStatus({});
    await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Detail cache write failures</b>: usdt-tether (value-too-large)");

    failureRows.splice(0);
    vi.setSystemTime(new Date("2026-08-22T01:00:00Z"));
    const recovery = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Detail cache writes recovered</b>: usdt-tether");
    expect(JSON.parse(recovery.metadata ?? "{}").alertTransitions).toMatchObject({
      recovered: ["detail-write:usdt-tether"], sent: true,
    });
  });

  it("alerts a held Safety Score publication and keeps it pending while the health read fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };
    const db = fakeDb();
    mockCacheStatus({});
    loadPublicationHealthMock.mockResolvedValue({ status: "held", reasons: [{ code: "coverage-below-floor" }] });
    const held = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Safety Score publication held</b>: v9 (coverage-below-floor)");
    expect(JSON.parse(held.metadata ?? "{}").firedRuleIds).toContain("safety-publication-held");

    vi.setSystemTime(new Date("2026-08-22T01:00:00Z"));
    loadPublicationHealthMock.mockRejectedValue(new Error("read failed"));
    await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-08-22T02:00:00Z"));
    loadPublicationHealthMock.mockResolvedValue({ status: "accepted", reasons: [] });
    await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Safety Score publication released</b>: v9");
  });


  it("does not expect evidence from the retired Workflow observer", async () => {
    mockCacheStatus({});
    const result = await runCronStalenessWatchdog(fakeDb());
    const metadata = JSON.parse(result.metadata!);
    const job = "compute-safety-score-v9-workflow";
    expect(metadata.checkedProducers.includes(job)).toBe(false);
    expect(metadata.stale.some((observation: { producerJob: string }) => observation.producerJob === job)).toBe(false);
    expect(metadata.checkedProducers).toContain("compute-safety-score-v9");
  });

  it("retains assessed cache and cron generation clocks with the watchdog budgets", async () => {
    const now = 1_790_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    const publishedAt = now - 7 * 86400;
    buildCacheStatusesMock.mockResolvedValue({
      caches: { "dex-liquidity": { ageSeconds: now - publishedAt, publishedAt, generationId: "dex-generation:42" } },
      warnings: [], failures: [], diagnostics: [],
    });
    const result = await runCronStalenessWatchdog(fakeDb([], publishedAt));
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.stale.find((observation: { cacheKey: string }) => observation.cacheKey === "dex-liquidity")).toMatchObject({
      publishedAt, generationId: "dex-generation:42", assessedAt: now,
      ageSeconds: now - publishedAt, thresholdSec: 2 * CACHE_FRESHNESS_LANES.dexLiquidity.producerIntervalSec,
    });
    const cron = metadata.stale.find((observation: { laneKey: string | null; publishedAt: number }) =>
      observation.laneKey === null && observation.publishedAt === publishedAt);
    expect(cron).toMatchObject({ publishedAt, generationId: null, assessedAt: now, ageSeconds: now - publishedAt });
    expect(cron.thresholdSec).toBeGreaterThan(0);
    expect(evaluateCronStaleness({ "dex-liquidity": { ageSeconds: now - publishedAt, publishedAt, generationId: "dex-generation:42" } }, ["dexLiquidity"], now)[0])
      .toMatchObject({ publishedAt, generationId: "dex-generation:42", assessedAt: now });
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

  it.each([0, 1])("admits a producer only while its threshold fits retention (excess %s)", (excessSec) => {
    const producer = {
      ...CRON_JOB_DEFINITIONS[0],
      job: "retention-boundary-producer",
      freshnessSurface: "consumer" as const,
      intervalSec: (CRON_RUNS_RETENTION_SEC + excessSec) / 3,
    };
    expect(deriveCronFreshnessProducers([producer]).map(({ producerJob }) => producerJob))
      .toEqual(excessSec === 0 ? [producer.job] : []);
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

  it.each([-1, Number.NEGATIVE_INFINITY, 1_800])("keeps clamped or boundary cache age %s fresh", (ageSeconds) => {
    expect(evaluateCronStaleness({ stablecoins: { ageSeconds } }, ["stablecoins"])).toEqual([]);
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

  it("re-alerts a second stale producer after the shared cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const db = fakeDb();
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };
    mockCacheStatus({ stablecoins: 2_000 });
    await runCronStalenessWatchdog(db, undefined, options);

    vi.setSystemTime(new Date(Date.now() + 60_000));
    mockCacheStatus({ stablecoins: 2_000, "dex-liquidity": 15_000 });
    const during = await runCronStalenessWatchdog(db, undefined, options);
    expect(JSON.parse(during.metadata ?? "{}").alertTransitions).toMatchObject({
      stale: ["sync-dex-liquidity"], cooldown: true, sent: false,
    });

    vi.setSystemTime(new Date(Date.now() + CRON_STALENESS_ALERT_COOLDOWN_SEC * 1_000));
    const after = await runCronStalenessWatchdog(db, undefined, options);
    expect(JSON.parse(after.metadata ?? "{}").alertTransitions).toMatchObject({
      stale: ["sync-dex-liquidity"], cooldown: false, sent: true,
    });
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("sync-dex-liquidity");
  });

  it("retries a stale transition after alert delivery fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    sendToChatMock.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const db = fakeDb();
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };
    mockCacheStatus({ stablecoins: 2_000 });

    const first = await runCronStalenessWatchdog(db, undefined, options);
    expect(first.status).toBe("degraded");
    expect(JSON.parse(first.metadata ?? "{}").reason).toBe("operator-alert-delivery-failed");
    expect(JSON.parse(first.metadata ?? "{}").alertTransitions).toMatchObject({
      stale: ["sync-stablecoins"], sent: false,
    });
    const retry = await runCronStalenessWatchdog(db, undefined, options);
    expect(retry.status).toBe("ok");
    expect(JSON.parse(retry.metadata ?? "{}").alertTransitions).toMatchObject({
      stale: ["sync-stablecoins"], sent: true,
    });
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
  });

  it("degrades when detail cache writes are failing", async () => {
    mockCacheStatus({ stablecoins: 0 });
    const result = await runCronStalenessWatchdog(fakeDb([{ key: "detail-write-failure:usdt-tether", value: JSON.stringify({ reason: "value-too-large", bytes: 21_000_000 }), updated_at: Math.floor(Date.now() / 1000) - 60 }]));
    const metadata = JSON.parse(result.metadata ?? "{}") as { detailWriteFailures: Array<{ stablecoinId: string }> };
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata ?? "{}").quality.reasons).toContain("detail-cache-write-failed");
    expect(metadata.detailWriteFailures.map((failure) => failure.stablecoinId)).toEqual(["usdt-tether"]);
  });

  it("treats a marker as recovered when the detail row was rewritten after it", async () => {
    const nowSec = 1_790_000_000;
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)");
    for (let index = 0; index < 101; index += 1) {
      insert.run(`detail-write-failure:coin-${index}`, nowSec - 600);
      insert.run(`detail:coin-${index}`, nowSec - 60);
    }
    expect(await loadDetailWriteFailures(db, nowSec)).toEqual([]);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key LIKE 'detail-write-failure:%'").all()).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'detail:%'").get()).toEqual({ count: 101 });
  });

  it("keeps markers whose detail row predates the failure", async () => {
    const nowSec = 1_790_000_000;
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("detail-write-failure:usdt-tether", '{"reason":"write-error","bytes":500}', nowSec - 60);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)")
      .run("detail:usdt-tether", nowSec - 600);
    expect(await loadDetailWriteFailures(db, nowSec)).toEqual([
      { stablecoinId: "usdt-tether", reason: "write-error", bytes: 500, ageSeconds: 60 },
    ]);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key LIKE 'detail-write-failure:%'").all())
      .toEqual([{ key: "detail-write-failure:usdt-tether" }]);
  });

  it.each([
    { name: "newer failure", replacementAt: 1_790_000_000 },
    { name: "same-second different-value failure", replacementAt: 1_789_999_400 },
  ])("retains a $name written after the recovery scan", async ({ replacementAt }) => {
    const nowSec = 1_790_000_000;
    const key = "detail-write-failure:usdt-tether";
    const replacement = '{"reason":"value-too-large","bytes":21000000}';
    const { sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)")
      .run(key, nowSec - 600);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)")
      .run("detail:usdt-tether", nowSec - 60);
    let replaced = false;
    const db = createSqliteD1(sqlite, { onAll: (sql) => {
      if (!replaced && sql.startsWith("SELECT key, updated_at FROM cache")) {
        replaced = true;
        sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(replacement, replacementAt, key);
      }
    } });

    expect(await loadDetailWriteFailures(db, nowSec)).toEqual([]);
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(key))
      .toEqual({ value: replacement, updated_at: replacementAt });
    if (replacementAt === nowSec) {
      expect(await loadDetailWriteFailures(db, nowSec)).toEqual([
        { stablecoinId: "usdt-tether", reason: "value-too-large", bytes: 21_000_000, ageSeconds: 0 },
      ]);
    }
  });

  it("retains a scanned marker when its recovery evidence disappears before cleanup", async () => {
    const nowSec = 1_790_000_000;
    const { sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)");
    insert.run("detail-write-failure:usdt-tether", nowSec - 600);
    insert.run("detail:usdt-tether", nowSec - 60);
    const db = createSqliteD1(sqlite, { onAll: (sql) => {
      if (sql.startsWith("SELECT key, updated_at FROM cache")) {
        sqlite.prepare("DELETE FROM cache WHERE key = ?").run("detail:usdt-tether");
      }
    } });
    expect(await loadDetailWriteFailures(db, nowSec)).toEqual([]);
    expect(await loadDetailWriteFailures(db, nowSec)).toEqual([
      { stablecoinId: "usdt-tether", reason: "unknown", bytes: null, ageSeconds: 600 },
    ]);
  });

  it("prunes expired detail write-failure markers", async () => {
    const nowSec = 1_750_000_000;
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)");
    insert.run("detail-write-failure:old-coin", nowSec - 8 * 24 * 3600);
    insert.run("detail-write-failure:boundary-coin", nowSec - 7 * 24 * 3600);
    expect(await loadDetailWriteFailures(db, nowSec)).toEqual([]);
    expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([{ key: "detail-write-failure:boundary-coin" }]);
  });
});
