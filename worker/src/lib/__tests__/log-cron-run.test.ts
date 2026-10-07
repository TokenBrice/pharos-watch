import { afterEach, describe, it, expect, vi } from "vitest";

import { CronTerminalAccountingError, logCronRun } from "../cron-logger";
import { CRON_ABANDONED_JOB_GRACE_MS, CronJobAbandonedError } from "../cron-lease-primitives";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite, createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { buildResourcePressure } from "../cron-resource-pressure";

describe("logCronRun", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const db = mockD1([
    { match: "cron_runs", rows: [] },
  ]);

  it.each([-1, 0, 1])("selects result evidence only when equally recent or newer (%s)", async (offset) => {
    const { sqlite, db } = fixtures.open();
    const progress = buildResourcePressure({ phase: "decode", observedAt: 100, intakeBytes: 4 });
    const terminal = buildResourcePressure({ phase: "publish", observedAt: 100 + offset, intakeBytes: 8 });
    await logCronRun(db, "test-job", async (_signal, report) => {
      await report({ stage: "decode", metadata: { resourcePressure: progress } });
      return { metadata: JSON.stringify({ resourcePressure: terminal }) };
    });
    const row = sqlite.prepare("SELECT metadata FROM cron_runs").get() as { metadata: string };
    expect(JSON.parse(row.metadata).resourcePressure).toEqual(offset < 0 ? progress : terminal);
  });

  it("retains coalesced evidence on throw without refreshing its observation clock", async () => {
    const { sqlite, db } = fixtures.open();
    const first = buildResourcePressure({ phase: "intake", observedAt: 100, intakeBytes: 2 });
    const latest = buildResourcePressure({ phase: "decode", observedAt: 101, intakeBytes: 4 });
    await expect(logCronRun(db, "test-job", async (_signal, report) => {
      await report({ stage: "work", metadata: { resourcePressure: first } });
      await report({ stage: "work", metadata: { resourcePressure: latest } });
      throw new Error("decode failed");
    })).rejects.toThrow("decode failed");
    const row = sqlite.prepare("SELECT metadata FROM cron_runs").get() as { metadata: string };
    expect(JSON.parse(row.metadata).resourcePressure).toEqual(latest);
  });

  it("keeps suppressed progress evidence at terminal and compacts durable progress", async () => {
    const { sqlite, db } = fixtures.open();
    const pressure = buildResourcePressure({ phase: "intake", observedAt: 100, intakeBytes: 0 });
    await logCronRun(db, "test-job", async (_signal, report) => {
      await report({ stage: "work", metadata: { resourcePressure: pressure, bulk: "x".repeat(100_000) } });
      const progress = sqlite.prepare("SELECT metadata FROM cron_run_progress").get() as { metadata: string };
      expect(JSON.parse(progress.metadata).resourcePressure).toEqual(pressure);
      expect(progress.metadata.length).toBeLessThan(65_536);
      return {};
    });
    const row = sqlite.prepare("SELECT metadata FROM cron_runs").get() as { metadata: string };
    expect(JSON.parse(row.metadata).resourcePressure).toEqual(pressure);
  });

  it("does not infer heap or platform failure for uninstrumented errors", async () => {
    const { sqlite, db } = fixtures.open();
    await expect(logCronRun(db, "test-job", async () => { throw new Error("memory"); })).rejects.toThrow("memory");
    const row = sqlite.prepare("SELECT metadata FROM cron_runs").get() as { metadata: string };
    expect(JSON.parse(row.metadata).resourcePressure).toMatchObject({
      intakeBytes: null, cacheBytes: null, guard: "not-measured", heapUsedBytes: null, platformOutcome: null,
    });
  });

  it("retains valid resource evidence when this job suppresses progress writes", async () => {
    const { sqlite, db } = fixtures.open();
    const pressure = buildResourcePressure({ phase: "read", observedAt: 100, intakeBytes: 5 });
    await logCronRun(db, "future-watchdog", async (_signal, report) => {
      await report({ stage: "read", metadata: { resourcePressure: pressure } });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_run_progress").get()).toEqual({ count: 0 });
      return {};
    });
    const row = sqlite.prepare("SELECT metadata FROM cron_runs").get() as { metadata: string };
    expect(JSON.parse(row.metadata).resourcePressure).toEqual(pressure);
  });

  it("passes AbortSignal to the job function", async () => {
    let receivedSignal: AbortSignal | undefined;
    await logCronRun(db, "test-job", async (signal) => {
      receivedSignal = signal;
      return { itemCount: 0 };
    });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);
  });

  it("clears timeout on successful completion (signal not aborted)", async () => {
    vi.useFakeTimers();
    let signalRef: AbortSignal | undefined;
    await logCronRun(db, "test-job", async (signal) => {
      signalRef = signal;
      return { itemCount: 42 };
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + CRON_ABANDONED_JOB_GRACE_MS + 500);
    expect(signalRef!.aborted).toBe(false);
  });

  it("provides AbortSignal for jobs with custom timeouts", async () => {
    // sync-dex-liquidity has a custom override; verify signal is still passed
    let signalRef: AbortSignal | undefined;
    await logCronRun(db, "sync-dex-liquidity", async (signal) => {
      signalRef = signal;
      return { itemCount: 0 };
    });
    expect(signalRef).toBeInstanceOf(AbortSignal);
    expect(signalRef!.aborted).toBe(false);
  });

  it("logs error status when job throws", async () => {
    const { sqlite, db } = fixtures.open();
    await expect(
      logCronRun(db, "test-job", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(sqlite.prepare("SELECT status, item_count, error FROM cron_runs").all())
      .toEqual([{ status: "error", item_count: null, error: expect.stringContaining("boom") }]);
  });

  it("persists the producing generation clock rather than the successful attempt clock", async () => {
    const { sqlite, db } = fixtures.open();
    await logCronRun(db, "test-job", async () => ({
      itemCount: 10,
      productivity: { productive: true, publications: [
        { surface: "stablecoins", generationId: "stablecoins:1234", publishedAt: 1234 },
      ] },
    }));
    expect(sqlite.prepare("SELECT json_extract(metadata, '$.outputPublishedAt') AS published_at FROM cron_runs").get())
      .toEqual({ published_at: 1234 });
  });

  it.each(["skipped_locked", "skipped_neutral"] as const)("cannot count retained rows as publication on %s", async (status) => {
    const { sqlite, db: dbWithCapture } = fixtures.open();
    await logCronRun(dbWithCapture, "test-job", async () => ({
      status,
      itemCount: 100,
      metadata: JSON.stringify({ reason: status }),
    }));
    expect(sqlite.prepare(
      "SELECT status, degraded_reason, json_type(metadata, '$.outputPublishedAt') AS clock_type FROM cron_runs",
    ).get()).toEqual({ status, degraded_reason: status, clock_type: "null" });
  });

  it("writes and clears cron_run_progress when the job reports progress", async () => {
    const { sqlite, db: dbWithProgressCapture } = fixtures.open();

    await logCronRun(dbWithProgressCapture, "test-job", async (_signal, reportProgress) => {
      await reportProgress({
        stage: "scan",
        itemsDone: 1,
        itemsTotal: 3,
        message: "Scanning config 1/3",
      });
      expect(sqlite.prepare("SELECT stage, items_done, items_total FROM cron_run_progress").all())
        .toEqual([{ stage: "scan", items_done: 1, items_total: 3 }]);
      return { itemCount: 1 };
    });

    expect(sqlite.prepare("SELECT * FROM cron_run_progress").all()).toEqual([]);
    expect(sqlite.prepare("SELECT item_count FROM cron_runs").all()).toEqual([{ item_count: 1 }]);
  });

  it("keeps active leased progress across an overlapping invocation", async () => {
    const { sqlite, db: sqliteDb } = createLatestSchemaSqlite();
    const nowSec = Math.floor(Date.now() / 1000);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const activeProgress = {
      job: "dispatch-telegram-alerts",
      started_at: nowSec,
      slot_started_at: nowSec - 300,
      updated_at: nowSec - 1,
      stage: "source-loading",
      lease_owner: "active-owner",
    };
    try {
      sqlite
        .prepare(
          `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(activeProgress.job, activeProgress.lease_owner, nowSec + 300, nowSec, nowSec);
      sqlite
        .prepare(
          `INSERT INTO cron_run_progress
             (job, started_at, slot_started_at, updated_at, stage, lease_owner)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          activeProgress.job,
          activeProgress.started_at,
          activeProgress.slot_started_at,
          activeProgress.updated_at,
          activeProgress.stage,
          activeProgress.lease_owner,
        );

      await logCronRun(
        sqliteDb,
        activeProgress.job,
        async (_signal, reportProgress) => {
          await reportProgress({
            stage: "skipped-locked",
            leaseOwner: "contending-owner",
          });
          return { status: "skipped_locked" };
        },
        { slotStartedAt: activeProgress.slot_started_at },
      );

      expect(
        sqlite
          .prepare(
            `SELECT job, started_at, slot_started_at, updated_at, stage, lease_owner
               FROM cron_run_progress
              WHERE job = ?`,
          )
          .get(activeProgress.job),
      ).toEqual(activeProgress);

      await logCronRun(
        sqliteDb,
        activeProgress.job,
        async (_signal, reportProgress) => {
          await reportProgress({
            stage: "completed",
            leaseOwner: activeProgress.lease_owner,
          });
          return { itemCount: 1 };
        },
        { slotStartedAt: activeProgress.slot_started_at },
      );

      expect(
        sqlite
          .prepare("SELECT job FROM cron_run_progress WHERE job = ?")
          .get(activeProgress.job),
      ).toBeUndefined();
    } finally {
      dateNowSpy.mockRestore();
      sqlite.close();
    }
  });

  it("persists slot_started_at into cron_runs and cron_run_progress when provided", async () => {
    const { sqlite, db: dbWithSlotCapture } = fixtures.open();

    await logCronRun(
      dbWithSlotCapture,
      "test-job",
      async (_signal, reportProgress) => {
        await reportProgress({ stage: "started" });
        expect(sqlite.prepare("SELECT slot_started_at FROM cron_run_progress").all())
          .toEqual([{ slot_started_at: 1_772_495_700 }]);
        return { itemCount: 1 };
      },
      { slotStartedAt: 1_772_495_700 },
    );

    expect(sqlite.prepare("SELECT slot_started_at FROM cron_runs").all())
      .toEqual([{ slot_started_at: 1_772_495_700 }]);
  });

  it("fails fast with timeout error when job exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      const hangingJob = logCronRun(db, "test-job", async () => new Promise(() => {}));
      const timeoutExpectation = expect(hangingJob).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(5 * 60_000 + CRON_ABANDONED_JOB_GRACE_MS + 500);
      await timeoutExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs abandoned metadata when a timed-out job does not settle", async () => {
    vi.useFakeTimers();
    try {
      const { sqlite, db: dbWithCapture } = fixtures.open();

      const hangingJob = logCronRun(dbWithCapture, "test-job", async () => new Promise(() => {}));
      const abandonedExpectation = expect(hangingJob).rejects.toBeInstanceOf(CronJobAbandonedError);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + CRON_ABANDONED_JOB_GRACE_MS + 500);
      await abandonedExpectation;

      const row = sqlite.prepare("SELECT status, error, metadata, degraded_reason FROM cron_runs").get()!;
      expect(row.status).toBe("error");
      expect(row.error).toContain("abandoned");
      expect(row.degraded_reason).toBe("abandoned");
      expect(JSON.parse(String(row.metadata))).toMatchObject({
        reason: "abandoned",
        job: "test-job",
        stopReason: "timeout",
        errorDescriptor: { name: "CronJobAbandonedError", message: expect.stringContaining("abandoned") },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not DELETE from cron_runs on successful completion (prune moved to daily cron)", async () => {
    const { sqlite, db: recordingDb } = fixtures.open();
    sqlite.exec("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('historical', 1, 1, 'ok')");

    const result = await logCronRun(recordingDb, "test-job", async () => ({ itemCount: 1 }));
    expect(result).toMatchObject({ itemCount: 1 });

    expect(sqlite.prepare("SELECT job FROM cron_runs ORDER BY started_at").all())
      .toEqual([{ job: "historical" }, { job: "test-job" }]);
  });

  it("deduplicates an append-only cron row after an ambiguous committed retry", async () => {
    const committedKeys = new Set<string>();
    const attemptedKeys: string[] = [];
    let firstInsert = true;
    const ambiguousDb = makeNoopD1({
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (!sql.includes("INSERT INTO cron_runs")) {
              return { success: true, meta: { changes: 0 } };
            }
            const idempotencyKey = String(args[8]);
            attemptedKeys.push(idempotencyKey);
            if (!committedKeys.has(idempotencyKey)) committedKeys.add(idempotencyKey);
            if (firstInsert) {
              firstInsert = false;
              throw new Error("D1 DB storage operation exceeded timeout");
            }
            return { success: true, meta: { changes: 0 } };
          },
          first: async () => null,
          all: async () => ({ results: [], success: true, meta: {} }),
        }),
      }),
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    });

    await expect(logCronRun(ambiguousDb, "ambiguous-log", async () => ({ itemCount: 1 })))
      .resolves.toMatchObject({ itemCount: 1 });
    expect(attemptedKeys).toHaveLength(2);
    expect(new Set(attemptedKeys).size).toBe(1);
    expect(committedKeys.size).toBe(1);
  });

  it("does not rewrite a completed producer as failed when terminal cron telemetry stays overloaded", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const overloadedDb = mockD1([
      { match: "INSERT INTO cron_runs", rows: [], throwError: new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.") },
      { match: "cron_run_progress", rows: [] },
      { match: "worker_producer_history", rows: [] },
    ]);
    const result = {
      status: "ok" as const,
      itemCount: 255,
      metadata: JSON.stringify({ stage: "finalized" }),
    };

    try {
      const completion = logCronRun(overloadedDb, "sync-live-reserves", async () => result, {
        producer: {
          scheduleKey: "fourHourlyAt11",
          producerPath: "fourHourlyAt11",
          producerKind: "scheduled-job",
          invocationId: "invocation-1",
        },
      });
      const expectation = expect(completion).rejects.toMatchObject({
        name: "CronTerminalAccountingError", code: "cron-terminal-accounting-failed",
        stage: "cron-run", completedResult: result,
      });
      await vi.runAllTimersAsync();
      await expectation;

      const writes = overloadedDb.getHistory().filter(({ sql }) => sql.includes("INSERT INTO cron_runs"));
      expect(writes.map(({ binds }) => binds[3])).toEqual(["ok", "ok", "ok", "ok"]);
      expect(overloadedDb.getHistory().filter(({ sql }) => sql.includes("INSERT INTO worker_producer_history"))).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not overwrite a committed cron result when producer history telemetry fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const historyFailureDb = mockD1([
      { match: "INSERT INTO cron_runs", rows: [] },
      { match: "cron_run_progress", rows: [] },
      { match: "INSERT INTO worker_producer_history", rows: [], throwError: new Error("producer history unavailable") },
    ]);
    const result = { status: "ok" as const, itemCount: 12 };

    try {
      await expect(
        logCronRun(historyFailureDb, "sync-live-reserves", async () => result, {
          producer: {
            scheduleKey: "fourHourlyAt11",
            producerPath: "fourHourlyAt11",
            producerKind: "scheduled-job",
            invocationId: "invocation-2",
          },
        }),
      ).rejects.toMatchObject({
        name: "CronTerminalAccountingError", stage: "producer-history", completedResult: result,
      });

      const cronRunWrites = historyFailureDb.getHistory().filter(({ sql }) => sql.includes("INSERT INTO cron_runs"));
      expect(cronRunWrites).toHaveLength(1);
      expect(cronRunWrites[0].binds[3]).toBe("ok");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retains confirmed publication when completed accounting fails", async () => {
    const db = mockD1([{ match: "INSERT INTO cron_runs", rows: [], throwError: new Error("disk unavailable") }]);
    const result = {
      status: "degraded" as const,
      itemCount: 1,
      metadata: JSON.stringify({ reason: "partial-publication", outputPublishedAt: 123 }),
      productivity: { productive: true, reason: "published" },
    };
    const producer = vi.fn(async () => result);
    const error = await logCronRun(db, "test-job", producer).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CronTerminalAccountingError);
    expect(error).toMatchObject({ completedResult: result, outputPublishedAt: 123, productive: true, stage: "cron-run" });
    expect(producer).toHaveBeenCalledTimes(1);
    expect(db.getHistory().filter(({ sql }) => sql.includes("INSERT INTO cron_runs"))).toHaveLength(1);
  });

  it("keeps the original producer diagnostic and persistence cause when error accounting fails", async () => {
    const persistence = new Error("disk unavailable");
    const original = new Error("producer failed");
    const db = mockD1([{ match: "INSERT INTO cron_runs", rows: [], throwError: persistence }]);
    await expect(logCronRun(db, "test-job", async () => { throw original; })).rejects.toMatchObject({
      code: "cron-terminal-accounting-failed", cause: persistence,
      originalError: { message: "producer failed", name: "Error" },
      productive: false, outputPublishedAt: null,
    });
  });

  it("redacts cause diagnostics and gives non-error throws a named terminal reason", async () => {
    const { db, sqlite } = fixtures.open();
    const failure = { message: "failed Bearer credential", cause: { message: "owner@example.com https://provider.test/token" } };
    await expect(logCronRun(db, "test-job", async () => { throw failure; })).rejects.toBe(failure);
    const row = sqlite.prepare("SELECT error, metadata, degraded_reason FROM cron_runs").get()!;
    expect(row.degraded_reason).toBe("non-error-throw");
    expect(row.error).toContain("Bearer [redacted]");
    expect(row.error).toContain("[email] [url]");
    expect(JSON.parse(String(row.metadata))).toMatchObject({
      reason: "non-error-throw",
      errorDescriptor: { name: "NonError", cause: { message: "[email] [url]" } },
    });
  });
});
