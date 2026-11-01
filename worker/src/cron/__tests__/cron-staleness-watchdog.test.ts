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
import { WORKER_ACTIVE_IDS, WORKER_READABLE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { CRON_RUNS_RETENTION_SEC } from "@shared/lib/retention-policy";
import { ACTIVE_CANARY_CHECK_IDS } from "../../lib/canary-checks";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import {
  CRON_STALENESS_ALERT_COOLDOWN_SEC,
  deriveCronFreshnessProducers,
  evaluateCronStaleness,
  loadDetailWriteFailures,
  runCronStalenessWatchdog,
} from "../cron-staleness-watchdog";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import {
  buildSupplySnapshotCompletionMarker,
  buildSupplySnapshotCoverageExpectation,
} from "../../lib/supply-snapshot-completion";

interface FakeFailureRow {
  key: string;
  value: string;
  updated_at: number;
}

interface FakeOperatorWatchRows {
  canaryRows?: Array<Record<string, unknown>>;
  probeRow?: Record<string, unknown> | null;
}

function defaultBlacklistSyncState(nowSec: number) {
  return CONTRACT_CONFIGS
    .filter((config) => WORKER_ACTIVE_IDS.has(config.stablecoinId))
    .map((config) => ({
      config_key: config.configKey,
      last_block: 1,
      cursor_value: null,
      attempt_generation: 1,
      last_attempted_at: nowSec - 60,
      last_succeeded_at: nowSec - 60,
      last_skipped_at: null,
      last_failed_at: null,
      consecutive_skips: 0,
      consecutive_failures: 0,
      last_outcome: "attempted",
    }));
}

/** Latest-schema fixtures start with an empty blacklist state table; seed a healthy roster. */
function openFixture() {
  const opened = fixtures.open();
  const insert = opened.sqlite.prepare(
    `INSERT INTO blacklist_sync_state (config_key, last_block, last_attempted_at, last_succeeded_at, last_outcome)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(config_key) DO UPDATE SET
       last_attempted_at = excluded.last_attempted_at,
       last_succeeded_at = excluded.last_succeeded_at,
       last_outcome = excluded.last_outcome`,
  );
  const rows = new Map(
    defaultBlacklistSyncState(Math.floor(Date.now() / 1000)).map((row) => [row.config_key, row]),
  );
  for (const row of rows.values()) {
    insert.run(row.config_key, row.last_block, row.last_attempted_at, row.last_succeeded_at, row.last_outcome);
  }
  return opened;
}

function fakeDb(
  failureRows: FakeFailureRow[] = [],
  producerPublishedAt?: number,
  operatorWatch: FakeOperatorWatchRows = {},
  blacklistSyncState?: unknown[],
): D1Database {
  const cacheRows = new Map<string, { value: string; updated_at: number }>();
  return {
    prepare: (sql: string) => {
      const all = async (args: unknown[]) => {
        if (sql.includes("ROW_NUMBER() OVER")) {
          const started_at = Math.floor(Date.now() / 1000);
          return { results: (args as string[]).map((job) => ({
            job,
            last_success_at: producerPublishedAt ?? started_at,
            last_run_at: started_at,
            last_status: "ok",
          })) };
        }
        if (sql.includes("FROM blacklist_sync_state")) {
          return {
            results: blacklistSyncState ?? defaultBlacklistSyncState(Math.floor(Date.now() / 1000)),
          };
        }
        if (sql.startsWith("SELECT key, updated_at FROM cache WHERE key IN")) {
          return { results: [] };
        }
        if (sql.includes("FROM worker_canary_runs")) {
          return { results: operatorWatch.canaryRows ?? [] };
        }
        if (sql.includes("supply-integrity-previous-rows") || sql.includes("FROM supply_history")) {
          return { results: [] };
        }
        if (sql.includes("FROM cron_runs")) {
          // No sync-stablecoins/charts run evidence: the supply dimensions
          // stay unknown rather than claiming healthy values.
          return { results: [] };
        }
        return { results: failureRows.filter((row) => row.updated_at >= (args[1] as number)) };
      };
      return {
        all: () => all([]),
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.startsWith("SELECT value, updated_at FROM cache WHERE key = ?")) {
              return cacheRows.get(args[0] as string) ?? null;
            }
            if (sql.includes("FROM status_probe_runs")) return operatorWatch.probeRow ?? null;
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
          all: () => all(args),
        }),
      };
    },
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

  it("alerts a blacklist config that has not succeeded for two producer intervals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const config = CONTRACT_CONFIGS.find((candidate) => WORKER_ACTIVE_IDS.has(candidate.stablecoinId))!;
    const states = defaultBlacklistSyncState(now);
    for (const state of states) {
      if (state.config_key === config.configKey) state.last_succeeded_at = now - 12 * 3600 - 1;
    }
    const db = fakeDb([], undefined, {}, states);
    mockCacheStatus({});
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };

    const raised = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Stale producers");
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain(config.stablecoin);
    expect(JSON.parse(raised.metadata ?? "{}").firedRuleIds).toContain("blacklist-config-stale");
    expect(JSON.parse(raised.metadata ?? "{}").quality.reasons).toContain("blacklist-config-stale");

    vi.setSystemTime(new Date("2026-08-22T01:00:00Z"));
    const recoveredAt = Math.floor(Date.now() / 1000);
    for (const state of states) state.last_succeeded_at = recoveredAt - 60;
    const recovered = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Recovered producers");
    expect(JSON.parse(recovered.metadata ?? "{}").alertTransitions).toMatchObject({
      recovered: [`sync-blacklist:${config.configKey}`],
      sent: true,
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

  it("alerts FX publication degradation and a missed daily slot, then reports recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
    const slotStart = Date.UTC(2026, 7, 22, 8, 0, 0) / 1000;
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };
    const db = fakeDb();
    const baseCaches = {
      stablecoins: { ageSeconds: 0 },
      "dex-liquidity": { ageSeconds: 0 },
      "yield-data": { ageSeconds: 0 },
      dews: { ageSeconds: 0 },
      "stablecoin-charts": { ageSeconds: 0 },
    };
    buildCacheStatusesMock.mockResolvedValue({
      caches: {
        ...baseCaches,
        "fx-rates": {
          ageSeconds: 60,
          publishedAt: Math.floor(Date.now() / 1000) - 60,
          mode: "cached-fallback",
          sourceStatus: "stale",
          consecutiveFallbackRuns: 3,
          warning: "peggedEUR business-daily reference is 2 publishes behind",
        },
        "usds-status": { ageSeconds: 1_000, publishedAt: slotStart - 86_400 },
        "bluechip-ratings": { ageSeconds: 1_000, publishedAt: slotStart + 300 },
      },
      warnings: [], failures: [], diagnostics: [],
    });

    const raised = await runCronStalenessWatchdog(db, undefined, options);
    const text = String(sendToChatMock.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("FX rate publication degraded");
    expect(text).toContain("peggedEUR business-daily reference is 2 publishes behind");
    expect(text).toContain("cached fallback (3 consecutive runs)");
    expect(text).toContain("Daily pricing lanes incomplete");
    expect(JSON.parse(raised.metadata ?? "{}").firedRuleIds).toEqual(expect.arrayContaining([
      "fx-source-stale", "fx-cached-fallback", "daily-lane-completion",
    ]));

    vi.setSystemTime(new Date(Date.now() + CRON_STALENESS_ALERT_COOLDOWN_SEC * 1_000));
    buildCacheStatusesMock.mockResolvedValue({
      caches: {
        ...baseCaches,
        "fx-rates": {
          ageSeconds: 60,
          publishedAt: Math.floor(Date.now() / 1000) - 60,
          mode: "live",
          sourceStatus: "fresh",
          consecutiveFallbackRuns: 0,
        },
        "usds-status": { ageSeconds: 60, publishedAt: slotStart + 60 },
        "bluechip-ratings": { ageSeconds: 60, publishedAt: slotStart + 300 },
      },
      warnings: [], failures: [], diagnostics: [],
    });
    await runCronStalenessWatchdog(db, undefined, options);
    const recoveryText = String(sendToChatMock.mock.calls[1]?.[1] ?? "");
    expect(recoveryText).toContain("FX rate publication recovered");
    expect(recoveryText).toContain("Daily pricing lanes complete");
  });

  it("reports DEX-to-DEWS dependency recovery state", async () => {
    mockCacheStatus({ "dex-liquidity": 120, dews: 4_000 });
    const result = await runCronStalenessWatchdog(fakeDb());
    const metadata = JSON.parse(result.metadata ?? "{}") as { dependencyRecoveryChecks?: Array<{ root: string; dependent: string; state: string }> };
    expect(metadata.dependencyRecoveryChecks).toContainEqual(expect.objectContaining({ root: "dex-liquidity", dependent: "dews", state: "root-recovered-dependent-stale" }));
  });

  it("does not claim the DEX-to-DEWS dependency caught up when the root regresses while DEWS is still stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };
    const db = fakeDb();

    // Run 1: DEX liquidity fresh, DEWS stale -> the dependency finding is raised.
    mockCacheStatus({ "dex-liquidity": 120, dews: 4_000 });
    const raised = await runCronStalenessWatchdog(db, undefined, options);
    expect(JSON.parse(raised.metadata ?? "{}").alertTransitions).toMatchObject({
      stale: expect.arrayContaining(["dependency:dex-liquidity->dews"]),
      sent: true,
    });

    // Run 2 past the cooldown: DEX liquidity itself is stale while DEWS is
    // still stale. The root regressed; the dependent never caught up.
    vi.setSystemTime(new Date(Date.now() + CRON_STALENESS_ALERT_COOLDOWN_SEC * 1_000));
    mockCacheStatus({ "dex-liquidity": 9_000, dews: 4_000 });
    const regressed = await runCronStalenessWatchdog(db, undefined, options);
    const metadata = JSON.parse(regressed.metadata ?? "{}") as {
      dependencyRecoveryChecks?: Array<{ state: string }>;
      alertTransitions: { recovered: string[] };
    };

    expect(metadata.dependencyRecoveryChecks).toContainEqual(expect.objectContaining({ state: "both-stale" }));
    expect(metadata.alertTransitions.recovered).not.toContain("dependency:dex-liquidity->dews");
    const calls = sendToChatMock.mock.calls;
    expect(calls[calls.length - 1]?.[1] ?? "").not.toContain("Dependency caught up");
  });

  it("bounds a systemic detail-write alert below Telegram's message cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const failureRows = [...WORKER_READABLE_IDS].slice(0, 200).map((stablecoinId) => ({
      key: `detail-write-failure:${stablecoinId}`,
      value: JSON.stringify({ reason: "write-error", bytes: 48_000 }),
      updated_at: Math.floor(Date.now() / 1000) - 60,
    }));
    const db = fakeDb(failureRows);
    mockCacheStatus({});
    loadPublicationHealthMock.mockResolvedValue({ status: "held", reasons: [{ code: "coverage-below-floor" }] });
    sendToChatMock.mockImplementation(async (...args: unknown[]) => ({
      ok: String(args[1] ?? "").length <= 4_096,
    }));

    const result = await runCronStalenessWatchdog(db, undefined, {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    const alerts = sendToChatMock.mock.calls.map((call) => String(call[1] ?? ""));
    const alertText = alerts.join("\n");

    expect(alerts.every((text) => text.length <= 4_096)).toBe(true);
    expect(alertText).toContain("Detail cache write failures");
    expect(alertText).toContain("Safety Score publication held");
    expect(JSON.parse(result.metadata ?? "{}").alertTransitions).toMatchObject({ sent: true });
    expect(result.status).toBe("ok");
  });

  it("does not report aged unresolved detail-write markers as recovered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const startSec = Math.floor(Date.now() / 1000);
    mockCacheStatus({});
    const { sqlite, db } = openFixture();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    // The last successful detail row predates the failed write; the coin is not
    // requested again, so no later detail write can clear the marker.
    insert.run("detail:usdt-tether", JSON.stringify({ price: 1 }), startSec - 600);
    insert.run("detail-write-failure:usdt-tether", JSON.stringify({ reason: "value-too-large", bytes: 21_000_000 }), startSec);

    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };
    const raised = await runCronStalenessWatchdog(db, undefined, options);
    expect(JSON.parse(raised.metadata ?? "{}").alertTransitions.stale).toContain("detail-write:usdt-tether");
    expect(sendToChatMock.mock.calls[0]?.[1] ?? "").toContain("Detail cache write failures");

    const fetchCountAfterRaise = sendToChatMock.mock.calls.length;
    // 25h later the marker is past any short freshness window but still inside
    // its retention, and no detail: row was rewritten.
    vi.setSystemTime(new Date((startSec + 25 * 3_600) * 1_000));
    const second = await runCronStalenessWatchdog(db, undefined, options);
    const transitions = JSON.parse(second.metadata ?? "{}").alertTransitions as { recovered: string[] };

    expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").all("detail-write-failure:usdt-tether"))
      .toEqual([{ key: "detail-write-failure:usdt-tether" }]);
    expect(transitions.recovered).not.toContain("detail-write:usdt-tether");
    expect(sendToChatMock.mock.calls.slice(fetchCountAfterRaise).map((call) => String(call[1] ?? "")).join("\n"))
      .not.toContain("Detail cache writes recovered");
  });

  it("alerts a confirmed overdue supply snapshot and its recovery", async () => {
    vi.useFakeTimers();
    const nowSec = startOfUtcDaySec(new Date("2026-08-22T00:00:00Z")) + 3_600;
    vi.setSystemTime(nowSec * 1_000);
    mockCacheStatus({});
    const { sqlite, db } = openFixture();
    const today = startOfUtcDaySec(new Date(nowSec * 1000));
    const yesterday = today - 86_400;
    const ids = [...ACTIVE_IDS].slice(0, 12);
    const marker = {
      ...buildSupplySnapshotCompletionMarker({
        snapshotDate: yesterday,
        coverage: buildSupplySnapshotCoverageExpectation(ids, []),
        accountedActiveCount: ids.length,
        ownedRowIds: ids,
        missingActiveIds: [],
        unavailableActiveIds: [],
      }),
      writtenRows: ids.length,
    };
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("snapshot-supply:last-write", JSON.stringify(marker), nowSec - 3_600);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      "stablecoins",
      JSON.stringify({
        peggedAssets: ids.map((id) => ({
          id, symbol: id.slice(0, 4).toUpperCase(), name: id, price: 1,
          supplySource: "defillama", supplyObservedAt: nowSec - 3_600,
          circulating: { peggedUSD: 101 },
        })),
      }),
      nowSec - 60,
    );
    const history = sqlite.prepare(
      "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, supply_provenance) VALUES (?, ?, ?, ?)",
    );
    for (const id of ids) {
      history.run(id, yesterday, 100, JSON.stringify({
        supplySource: "defillama",
        supplyObservedAt: yesterday,
        supplyChainGuard: null,
      }));
    }
    const runs = sqlite.prepare(
      "INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES (?, ?, 1, 'ok', 1, ?)",
    );
    for (const definition of CRON_JOB_DEFINITIONS) {
      if (definition.freshnessSurface === "none"
        || definition.job === "sync-stablecoins"
        || definition.job === "sync-stablecoin-charts") continue;
      runs.run(definition.job, nowSec - 600, JSON.stringify({ published: true }));
    }
    for (const startedAt of [nowSec - 900, nowSec - 1_800]) {
      runs.run("sync-stablecoins", startedAt, JSON.stringify({
        priceSourceHealth: {
          active: { supplyCoverage: { complete: true, observedCount: ids.length, unavailableCount: 0 } },
        },
      }));
    }
    runs.run("sync-stablecoin-charts", nowSec - 600, JSON.stringify({ reason: "published" }));
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };

    await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).not.toHaveBeenCalled();

    const confirmed = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Supply integrity findings");
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("snapshot overdue");
    expect(JSON.parse(confirmed.metadata ?? "{}").firedRuleIds).toContain("supply-snapshot-overdue");

    const currentMarker = {
      ...buildSupplySnapshotCompletionMarker({
        snapshotDate: today,
        coverage: buildSupplySnapshotCoverageExpectation(ids, []),
        accountedActiveCount: ids.length,
        ownedRowIds: ids,
        missingActiveIds: [],
        unavailableActiveIds: [],
      }),
      writtenRows: ids.length,
    };
    sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(currentMarker), nowSec + 60, "snapshot-supply:last-write");
    for (const id of ids) history.run(id, today, 101, null);
    vi.setSystemTime((nowSec + 3_600) * 1_000);
    const recovered = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Supply integrity recovered");
    expect(JSON.parse(recovered.metadata ?? "{}").alertTransitions.recovered).toContain("supply:snapshot-overdue");
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
    const result = await runCronStalenessWatchdog(fakeDb([{ key: "detail-write-failure:usdt-tether", value: JSON.stringify({ reason: "value-too-large", bytes: 21_000_000 }), updated_at: Math.floor(Date.now() / 1000) - 60 }]), undefined, {
      operatorTelegramCreds: { botToken: "bot", chatId: "ops" },
    });
    const metadata = JSON.parse(result.metadata ?? "{}") as { detailWriteFailures: Array<{ stablecoinId: string }> };
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata ?? "{}").quality.reasons).toContain("detail-cache-write-failed");
    expect(metadata.detailWriteFailures.map((failure) => failure.stablecoinId)).toEqual(["usdt-tether"]);
  });

  it("treats a marker as recovered when the detail row was rewritten after it", async () => {
    const nowSec = 1_790_000_000;
    const { sqlite, db } = openFixture();
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
    const { sqlite, db } = openFixture();
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
    const { sqlite } = openFixture();
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
    const { sqlite } = openFixture();
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
    const { sqlite, db } = openFixture();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', ?)");
    insert.run("detail-write-failure:old-coin", nowSec - 8 * 24 * 3600);
    insert.run("detail-write-failure:boundary-coin", nowSec - 7 * 24 * 3600);
    // Unresolved markers stay visible for the full retention window; only the
    // marker past retention is pruned.
    expect(await loadDetailWriteFailures(db, nowSec)).toEqual([
      { stablecoinId: "boundary-coin", reason: "unknown", bytes: null, ageSeconds: 7 * 24 * 3600 },
    ]);
    expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([{ key: "detail-write-failure:boundary-coin" }]);
  });

  it("alerts on a canary finding transition and recovers it once the cohort is clean", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const canaryRows = (failingCheckId: string | null) => ACTIVE_CANARY_CHECK_IDS.map((checkId) => ({
      check_id: checkId,
      status: checkId === failingCheckId ? "error" : "ok",
      severity: checkId === failingCheckId ? "error" : "info",
      observed_at: now,
      duration_ms: 1,
      metadata_json: JSON.stringify({ executionStatus: "completed" }),
      error: null,
    }));
    const watch = {
      canaryRows: canaryRows("stablecoins-cache-active-count"),
      probeRow: { created_at: now, details_json: JSON.stringify({ persistentProbeFailures: [] }) },
    };
    const db = fakeDb([], undefined, watch);
    mockCacheStatus({});
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" }, workerCanaryMode: "status" as const };

    const raised = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Canary findings raised");
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("stablecoins-cache-active-count");
    expect(JSON.parse(raised.metadata ?? "{}").firedRuleIds).toContain("canary-finding");
    expect(JSON.parse(raised.metadata ?? "{}").canaryWatch).toMatchObject({ active: 1, unknown: false });

    // A sustained finding is not re-alerted.
    await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);

    watch.canaryRows = canaryRows(null);
    vi.setSystemTime(new Date((now + CRON_STALENESS_ALERT_COOLDOWN_SEC + 1) * 1_000));
    await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
    expect(sendToChatMock.mock.calls[1]?.[1]).toContain("Canary findings recovered");
  });

  it("alerts on a persistently failing probe path and keeps its prior state when evidence is unreadable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const watch: FakeOperatorWatchRows = {
      canaryRows: [],
      probeRow: {
        created_at: now,
        details_json: JSON.stringify({
          persistentProbeFailures: [{
            plane: "external", lane: "external", origin: "https://api.pharos.watch",
            path: "/api/mint-burn-flows", failStreak: 2, lastProbedAt: now,
          }],
        }),
      },
    };
    const db = fakeDb([], undefined, watch);
    mockCacheStatus({});
    const options = { operatorTelegramCreds: { botToken: "bot", chatId: "ops" } };

    await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Probe paths persistently failing");
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("/api/mint-burn-flows");

    // Unreadable probe evidence is unknown: it must not report a recovery.
    vi.setSystemTime(new Date((now + CRON_STALENESS_ALERT_COOLDOWN_SEC + 1) * 1_000));
    watch.probeRow = null;
    const unknown = await runCronStalenessWatchdog(db, undefined, options);
    expect(sendToChatMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(unknown.metadata ?? "{}").probeWatch).toMatchObject({ unknown: true });
  });
});
