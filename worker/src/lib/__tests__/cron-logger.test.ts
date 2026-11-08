import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  __resetCronFailureCountsForTests,
  logCronEvent,
  logCronRun,
  recordCronFailure,
} from "../cron-logger";
import { DEFAULT_CRON_METADATA_BUDGET_BYTES } from "../cron-metadata-persistence";
import {
  CRON_PROGRESS_LONG_RUN_AFTER_MS,
  CRON_PROGRESS_LONG_RUN_COALESCE_MS,
  PROGRESS_TELEMETRY_SKIP_JOBS,
} from "../cron-timeouts";
import { resolveScheduledSlotPolicy } from "../scheduled-slot-policy";
import { CRON_IN_FLIGHT_STALE_FLOOR_SEC } from "../status/cron-health";
import { CRON_SCHEDULE_DEFINITIONS } from "@shared/lib/cron-jobs";
import { makeCaptureDb, type DbCall } from "./cron-progress.test-support";
import { reportDigestCircuitOpen, reportDigestMissingApiKey } from "../../cron/digest/platform";

const PROGRESS_SKIP_TEST_JOBS = [...Object.keys(PROGRESS_TELEMETRY_SKIP_JOBS), "prune-future", "future-watchdog"];

describe("cron progress cleanup", () => {
  const fixtures = createLatestSchemaFixtureTracker();

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the owner that reached D1 when a later owner update is coalesced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    const { sqlite, db } = fixtures.open();

    await logCronRun(db, "test-job", async (_signal, reportProgress) => {
      await reportProgress({ stage: "syncing", leaseOwner: "owner-a", itemsDone: 1 });
      await reportProgress({ stage: "syncing", leaseOwner: "owner-b", itemsDone: 2 });

      expect(sqlite.prepare("SELECT lease_owner FROM cron_run_progress").all()).toEqual([
        { lease_owner: "owner-a" },
      ]);
      return { itemCount: 2 };
    });

    expect(sqlite.prepare("SELECT * FROM cron_run_progress").all()).toEqual([]);
  });

  it("enforces the job byte budget on persisted terminals without copying diagnostics into history", async () => {
    const { sqlite, db } = fixtures.open();
    await logCronRun(db, "test-budget", async () => ({
      status: "degraded", itemCount: 0,
      metadata: JSON.stringify({ reason: "source-incomplete", outputPublishedAt: null,
        quality: { reasons: ["source-incomplete"] }, mxLedgerV: 1, mxLedger0: "ledger",
        providerDiagnostics: Array.from({ length: 5_000 }, () => ({ payload: "x".repeat(50) })) }),
    }), { producer: { scheduleKey: "quarterHourly", producerPath: "quarterHourly",
      producerKind: "scheduled-job", invocationId: "budget-test" } });
    const run = sqlite.prepare("SELECT metadata FROM cron_runs WHERE job = 'test-budget'").get() as { metadata: string };
    expect(new TextEncoder().encode(run.metadata).length).toBeLessThanOrEqual(DEFAULT_CRON_METADATA_BUDGET_BYTES);
    expect(JSON.parse(run.metadata)).toMatchObject({ reason: "source-incomplete", outputPublishedAt: null,
      quality: { reasons: ["source-incomplete"] }, providerDiagnostics: { count: 5_000 } });
    const history = sqlite.prepare("SELECT metadata_json FROM worker_producer_history WHERE job = 'test-budget'").get() as { metadata_json: string };
    expect(JSON.parse(history.metadata_json)).toEqual({ mxLedgerV: 1, mxLedger0: "ledger" });
  });

  it.each(["ok", "degraded", "error"] as const)("persists a %s terminal when consumer evidence exceeds its metadata budget", async (status) => {
    const { sqlite, db } = fixtures.open();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stale = Array.from({ length: 1_000 }, () => ({ generationId: "generation-a" }));
    await logCronRun(db, "test-over-budget", async () => ({
      status, itemCount: 0,
      metadata: JSON.stringify({ reason: "source-incomplete", outputPublishedAt: null, stale }),
    }));
    const runs = sqlite.prepare("SELECT status, metadata FROM cron_runs WHERE job = 'test-over-budget'").all() as Array<{
      status: string; metadata: string;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe(status);
    expect(JSON.parse(runs[0].metadata)).toMatchObject({
      reason: "source-incomplete", outputPublishedAt: null, stale,
      persistenceCompaction: { overBudget: true, budgetBytes: DEFAULT_CRON_METADATA_BUDGET_BYTES },
    });
    expect(new TextEncoder().encode(runs[0].metadata).length).toBeGreaterThan(DEFAULT_CRON_METADATA_BUDGET_BYTES);
  });

  it("redacts signed URLs from thrown and resolved cron errors before persistence", async () => {
    const { sqlite, db } = fixtures.open();
    const signedUrl = "https://provider.example/data?token=super-secret";

    await expect(logCronRun(db, "thrown-error", async () => {
      throw new Error(`request failed for ${signedUrl}`);
    })).rejects.toThrow(signedUrl);

    await logCronRun(db, "resolved-error", async () => ({
      status: "error",
      error: `upstream rejected ${signedUrl}`,
    }));

    expect(
      sqlite.prepare("SELECT job, status, item_count, error FROM cron_runs ORDER BY job").all(),
    ).toEqual([
      { job: "resolved-error", status: "error", item_count: null, error: "upstream rejected [url]" },
      { job: "thrown-error", status: "error", item_count: null, error: "request failed for [url]" },
    ]);
  });
});

describe("degraded reason projection", () => {
  const fixtures = createLatestSchemaFixtureTracker();

  afterEach(() => {
    fixtures.closeAll();
    vi.restoreAllMocks();
  });

  // LV01's operator aggregate: every non-ok row must resolve to a reason.
  const NON_OK_REASONS = `SELECT job, status,
       COALESCE(degraded_reason, error, json_extract(metadata, '$.reason'), '(no-reason)') AS reason
     FROM cron_runs WHERE status <> 'ok' ORDER BY job`;

  it("projects a producer reason, a nested fallback and a terminal throw into degraded_reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sqlite, db } = fixtures.open();

    await logCronRun(db, "named-reason", async () => ({
      status: "degraded",
      metadata: JSON.stringify({ reason: "snapshot_write_failed" }),
    }));
    await logCronRun(db, "yield-style", async () => ({
      status: "degraded",
      metadata: JSON.stringify({ reason: "yield-publication-not-applied" }),
    }));
    await logCronRun(db, "silent-degrade", async () => ({ status: "degraded" }));
    await logCronRun(db, "neutral-skip", async () => ({ status: "skipped_neutral" }));
    await expect(logCronRun(db, "thrown", async () => {
      throw new TypeError("boom");
    })).rejects.toThrow("boom");

    expect(sqlite.prepare(NON_OK_REASONS).all()).toEqual([
      { job: "named-reason", status: "degraded", reason: "snapshot_write_failed" },
      { job: "neutral-skip", status: "skipped_neutral", reason: "skipped_neutral" },
      { job: "silent-degrade", status: "degraded", reason: "unspecified-degraded" },
      { job: "thrown", status: "error", reason: "TypeError" },
      { job: "yield-style", status: "degraded", reason: "yield-publication-not-applied" },
    ]);
    expect(console.warn).toHaveBeenCalledWith("[cron:silent-degrade] degraded result carries no metadata.reason");
  });

  it.each(["daily digest", "weekly recap"] as const)("persists reasoned %s generation terminals without publication", async (edition) => {
    const { sqlite, db } = fixtures.open();
    await logCronRun(db, "circuit", () => reportDigestCircuitOpen(undefined, edition));
    await logCronRun(db, "missing-key", () => reportDigestMissingApiKey(undefined, edition));
    expect(sqlite.prepare(`SELECT job, status, item_count, degraded_reason,
      json_extract(metadata, '$.outputPublishedAt') AS outputPublishedAt
      FROM cron_runs ORDER BY job`).all()).toEqual([
      { job: "circuit", status: "degraded", item_count: 0, degraded_reason: "anthropic-circuit-open", outputPublishedAt: null },
      { job: "missing-key", status: "skipped_neutral", item_count: 0, degraded_reason: "missing-api-key", outputPublishedAt: null },
    ]);
  });

  it("leaves an ok run with quality metadata unreasoned", async () => {
    const { sqlite, db } = fixtures.open();

    await logCronRun(db, "restored-only", async () => ({
      itemCount: 3,
      metadata: JSON.stringify({ quality: { degraded: true, reasons: ["yield-supplemental:family-degraded:pendle"] } }),
    }));

    expect(sqlite.prepare("SELECT status, degraded_reason, json_extract(metadata, '$.outputPublishedAt') AS outputPublishedAt FROM cron_runs").all()).toEqual([
      { status: "ok", degraded_reason: null, outputPublishedAt: expect.any(Number) },
    ]);
    expect(sqlite.prepare(NON_OK_REASONS).all()).toEqual([]);
  });
});

describe("cron progress telemetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces same-stage updates within ten seconds but always writes a stage change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
    const calls: DbCall[] = [];
    const db = makeCaptureDb(calls);

    await logCronRun(db, "sync-stablecoins", async (_signal, reportProgress) => {
      await reportProgress({ stage: "scan", itemsDone: 1 });
      vi.advanceTimersByTime(3_000);
      await reportProgress({ stage: "scan", itemsDone: 2 });
      await reportProgress({ stage: "publish", itemsDone: 2 });
      return { itemCount: 2 };
    });

    const progressCalls = calls.filter(({ sql }) => sql.includes("INSERT INTO cron_run_progress"));
    expect(progressCalls).toHaveLength(2);
    expect(progressCalls.map(({ args }) => args[4])).toEqual(["scan", "publish"]);
  });

  it("coalesces same-stage updates for thirty seconds once a run passes its first minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
    const calls: DbCall[] = [];
    const db = makeCaptureDb(calls);

    await logCronRun(db, "sync-stablecoins", async (_signal, reportProgress) => {
      await reportProgress({ stage: "scan", itemsDone: 1 });
      vi.advanceTimersByTime(CRON_PROGRESS_LONG_RUN_AFTER_MS);
      await reportProgress({ stage: "scan", itemsDone: 2 });
      vi.advanceTimersByTime(CRON_PROGRESS_LONG_RUN_COALESCE_MS - 1);
      await reportProgress({ stage: "scan", itemsDone: 3 });
      vi.advanceTimersByTime(1);
      await reportProgress({ stage: "scan", itemsDone: 4 });
      await reportProgress({ stage: "publish", itemsDone: 4 });
      return { itemCount: 4 };
    });

    const progressCalls = calls.filter(({ sql }) => sql.includes("INSERT INTO cron_run_progress"));
    expect(progressCalls.map(({ args }) => [args[4], args[5]])).toEqual([
      ["scan", 1], ["scan", 2], ["scan", 4], ["publish", 4],
    ]);
  });

  it("keeps liveness and stale-slot thresholds at least 5x the long-run coalesce interval", () => {
    const coalesceSec = CRON_PROGRESS_LONG_RUN_COALESCE_MS / 1000;
    // Status marks leased progress stale only after this floor: keep >= 5x margin.
    expect(CRON_IN_FLIGHT_STALE_FLOOR_SEC).toBeGreaterThanOrEqual(5 * coalesceSec);
    for (const slotKey of Object.keys(CRON_SCHEDULE_DEFINITIONS)) {
      const policy = resolveScheduledSlotPolicy(slotKey);
      expect(policy.childSilenceSec).toBeGreaterThanOrEqual(5 * coalesceSec);
      expect(policy.slotSilenceSec).toBeGreaterThanOrEqual(5 * coalesceSec);
    }
  });

  it.each(PROGRESS_SKIP_TEST_JOBS)(
    "does not write progress rows for short-job telemetry skip %s",
    async (job) => {
      const calls: DbCall[] = [];
      const db = makeCaptureDb(calls);

      await logCronRun(db, job, async (_signal, reportProgress) => {
        await reportProgress({ stage: "started" });
        return { itemCount: 1 };
      });

      expect(calls.filter(({ sql }) => sql.includes("INSERT INTO cron_run_progress"))).toHaveLength(0);
    },
  );
});

describe("recordCronFailure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetCronFailureCountsForTests();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("redacts nested credential metadata before writing cron logs", () => {
    recordCronFailure("sync-live-reserves", new Error("provider failed"), {
      metadata: {
        provider: {
          url: "https://example.com/rpc?apiKey=url-secret",
          error: new Error("Authorization=header-secret Bearer bearer-secret"),
        },
        token: "token=metadata-secret",
      },
    });

    const [, payload] = errorSpy.mock.calls[0] as [string, string];
    expect(payload).not.toContain("url-secret");
    expect(payload).not.toContain("header-secret");
    expect(payload).not.toContain("bearer-secret");
    expect(payload).not.toContain("metadata-secret");
    expect(payload).toContain("[redacted]");
  });

  it("persists non-terminal cron events as latest-event cache records", async () => {
    const db = mockD1();

    const record = await logCronEvent(db, {
      job: "sync-fx-rates",
      eventType: "openexchange-rates-fetch-failed",
      severity: "warning",
      message: "Open Exchange Rates realtime fetch failed.",
      metadata: {
        error: "x".repeat(700),
        attempts: [1, 2, 3],
      },
    });

    expect(record).toMatchObject({
      event: "cron_event",
      job: "sync-fx-rates",
      eventType: "openexchange-rates-fetch-failed",
      severity: "warning",
    });
    expect(warnSpy).toHaveBeenCalled();

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO cache"));
    expect(insert?.binds[0]).toBe("cron:event:sync-fx-rates:openexchange-rates-fetch-failed");
    const payload = JSON.parse(String(insert?.binds[1]));
    expect(payload.metadata.error.length).toBeLessThanOrEqual(503);
    expect(payload.metadata.attempts).toEqual([1, 2, 3]);
  });

  it("does not throw when durable cron event persistence fails", async () => {
    const db = mockD1([
      { match: "INSERT INTO cache", rows: [], throwError: new Error("D1 unavailable") },
    ]);

    await expect(
      logCronEvent(db, {
        job: "sync-dex-liquidity",
        eventType: "fallback-budget-exhausted",
        message: "Fallback budget exhausted.",
      }),
    ).resolves.toMatchObject({ job: "sync-dex-liquidity" });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist fallback-budget-exhausted"),
    );
  });
});
