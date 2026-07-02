import { describe, expect, it } from "vitest";
import { runPruneCronHistory } from "../prune-cron-history";

interface CronRunRow {
  job: string;
  started_at: number;
}

interface SlotExecRow {
  slot_key: string;
  slot_started_at: number;
}

interface JobAttemptRow {
  updated_at: number;
  state: string;
}

interface RepairTaskRow {
  updated_at: number;
  state: string;
}

interface CanaryRunRow {
  observed_at: number;
}

interface SelectorSnapshotDailyQuotaRow {
  quota_date: string;
}

interface BlockTimestampCacheRow {
  updated_at: number;
}

/**
 * Minimal D1 stub that understands the DELETE statements issued by
 * runPruneCronHistory plus the SELECT COUNT(*) verification queries used
 * in this test. Mirrors the pattern in prune-status-probe-runs.test.ts.
 */
function createStubDb(): {
  db: D1Database;
  cronRuns: CronRunRow[];
  jobAttempts: JobAttemptRow[];
  repairTasks: RepairTaskRow[];
  canaryRuns: CanaryRunRow[];
  selectorSnapshotDailyQuotaRows: SelectorSnapshotDailyQuotaRow[];
  blockTimestampCacheRows: BlockTimestampCacheRow[];
  slotExecs: SlotExecRow[];
} {
  const cronRuns: CronRunRow[] = [];
  const jobAttempts: JobAttemptRow[] = [];
  const repairTasks: RepairTaskRow[] = [];
  const canaryRuns: CanaryRunRow[] = [];
  const selectorSnapshotDailyQuotaRows: SelectorSnapshotDailyQuotaRow[] = [];
  const blockTimestampCacheRows: BlockTimestampCacheRow[] = [];
  const slotExecs: SlotExecRow[] = [];

  function prepare(sql: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as unknown as D1PreparedStatement;
      },
      run: async () => {
        if (sql.startsWith("DELETE FROM cron_runs WHERE started_at <")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = cronRuns.length - 1; i >= 0; i--) {
            if (cronRuns[i].started_at < cutoff) {
              cronRuns.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM cron_slot_executions WHERE slot_started_at <")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = slotExecs.length - 1; i >= 0; i--) {
            if (slotExecs[i].slot_started_at < cutoff) {
              slotExecs.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM selector_snapshot_daily_quota WHERE quota_date <")) {
          const [cutoff] = bound as [string];
          let removed = 0;
          for (let i = selectorSnapshotDailyQuotaRows.length - 1; i >= 0; i--) {
            if (selectorSnapshotDailyQuotaRows[i].quota_date < cutoff) {
              selectorSnapshotDailyQuotaRows.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.startsWith("DELETE FROM block_timestamp_cache WHERE updated_at <")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = blockTimestampCacheRows.length - 1; i >= 0; i--) {
            if (blockTimestampCacheRows[i].updated_at < cutoff) {
              blockTimestampCacheRows.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.includes("DELETE FROM worker_job_attempts")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          const terminalStates = new Set(bound.slice(1).map(String));
          for (let i = jobAttempts.length - 1; i >= 0; i--) {
            if (jobAttempts[i].updated_at < cutoff && terminalStates.has(jobAttempts[i].state)) {
              jobAttempts.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.includes("DELETE FROM worker_repair_tasks")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          const terminalStates = new Set(bound.slice(1).map(String));
          for (let i = repairTasks.length - 1; i >= 0; i--) {
            if (repairTasks[i].updated_at < cutoff && terminalStates.has(repairTasks[i].state)) {
              repairTasks.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        if (sql.includes("DELETE FROM worker_canary_runs")) {
          const [cutoff] = bound as [number];
          let removed = 0;
          for (let i = canaryRuns.length - 1; i >= 0; i--) {
            if (canaryRuns[i].observed_at < cutoff) {
              canaryRuns.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: {} }),
    };
    return stmt as unknown as D1PreparedStatement;
  }

  const db = {
    prepare,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return {
    db,
    cronRuns,
    jobAttempts,
    repairTasks,
    canaryRuns,
    selectorSnapshotDailyQuotaRows,
    blockTimestampCacheRows,
    slotExecs,
  };
}

const ONE_WEEK_SEC = 7 * 24 * 60 * 60;
const TWO_DAYS_SEC = 2 * 24 * 60 * 60;
const TWO_WEEKS_SEC = 14 * 24 * 60 * 60;
const NINETY_DAYS_SEC = 90 * 24 * 60 * 60;

function toUtcDateString(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

describe("runPruneCronHistory", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const { db } = createStubDb();
    const controller = new AbortController();
    controller.abort(new Error("cron history prune aborted"));

    await expect(runPruneCronHistory(db, controller.signal)).rejects.toThrow("cron history prune aborted");
  });

  it("removes cron_runs older than 7 days and keeps newer rows", async () => {
    const { db, cronRuns } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    cronRuns.push({ job: "sync-stablecoins", started_at: now - ONE_WEEK_SEC - 3600 });
    cronRuns.push({ job: "sync-stablecoins", started_at: now - 3600 });

    const result = await runPruneCronHistory(db);

    expect(cronRuns).toHaveLength(1);
    expect(cronRuns[0].started_at).toBe(now - 3600);
    expect(result.itemCount).toBe(1);
    expect(result.status).toBe("ok");
  });

  it("removes cron_slot_executions older than 14 days and keeps newer rows", async () => {
    const { db, slotExecs } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    slotExecs.push({ slot_key: "quarterHourly", slot_started_at: now - TWO_WEEKS_SEC - 3600 });
    slotExecs.push({ slot_key: "quarterHourly", slot_started_at: now - 3600 });

    await runPruneCronHistory(db);

    expect(slotExecs).toHaveLength(1);
    expect(slotExecs[0].slot_started_at).toBe(now - 3600);
  });

  it("removes terminal worker_job_attempts older than 7 days and keeps active or newer rows", async () => {
    const { db, jobAttempts } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    jobAttempts.push({ state: "completed", updated_at: now - ONE_WEEK_SEC - 3600 });
    jobAttempts.push({ state: "running", updated_at: now - ONE_WEEK_SEC - 3600 });
    jobAttempts.push({ state: "failed", updated_at: now - 3600 });

    const result = await runPruneCronHistory(db);

    expect(jobAttempts).toEqual([
      { state: "running", updated_at: now - ONE_WEEK_SEC - 3600 },
      { state: "failed", updated_at: now - 3600 },
    ]);
    const metadata = JSON.parse(result.metadata!) as { jobAttemptsDeleted: number };
    expect(metadata.jobAttemptsDeleted).toBe(1);
  });

  it("removes terminal repair tasks older than 7 days and keeps active or newer rows", async () => {
    const { db, repairTasks } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    repairTasks.push({ state: "closed", updated_at: now - ONE_WEEK_SEC - 3600 });
    repairTasks.push({ state: "open", updated_at: now - ONE_WEEK_SEC - 3600 });
    repairTasks.push({ state: "cancelled", updated_at: now - 3600 });

    const result = await runPruneCronHistory(db);

    expect(repairTasks).toEqual([
      { state: "open", updated_at: now - ONE_WEEK_SEC - 3600 },
      { state: "cancelled", updated_at: now - 3600 },
    ]);
    const metadata = JSON.parse(result.metadata!) as { repairTasksDeleted: number };
    expect(metadata.repairTasksDeleted).toBe(1);
  });

  it("removes worker_canary_runs older than 90 days and keeps newer rows", async () => {
    const { db, canaryRuns } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    canaryRuns.push({ observed_at: now - NINETY_DAYS_SEC - 3600 });
    canaryRuns.push({ observed_at: now - 3600 });

    const result = await runPruneCronHistory(db);

    expect(canaryRuns).toEqual([{ observed_at: now - 3600 }]);
    const metadata = JSON.parse(result.metadata!) as { canaryRunsDeleted: number };
    expect(metadata.canaryRunsDeleted).toBe(1);
  });

  it("removes selector snapshot daily quota rows older than 2 days and keeps newer rows", async () => {
    const { db, selectorSnapshotDailyQuotaRows } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    selectorSnapshotDailyQuotaRows.push({ quota_date: toUtcDateString(now - TWO_DAYS_SEC - 24 * 60 * 60) });
    selectorSnapshotDailyQuotaRows.push({ quota_date: toUtcDateString(now - 3600) });

    const result = await runPruneCronHistory(db);

    expect(selectorSnapshotDailyQuotaRows).toEqual([{ quota_date: toUtcDateString(now - 3600) }]);
    const metadata = JSON.parse(result.metadata!) as { selectorSnapshotDailyQuotaDeleted: number };
    expect(metadata.selectorSnapshotDailyQuotaDeleted).toBe(1);
  });

  it("removes block timestamp cache rows older than 14 days and keeps newer rows", async () => {
    const { db, blockTimestampCacheRows } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    blockTimestampCacheRows.push({ updated_at: now - TWO_WEEKS_SEC - 3600 });
    blockTimestampCacheRows.push({ updated_at: now - 3600 });

    const result = await runPruneCronHistory(db);

    expect(blockTimestampCacheRows).toEqual([{ updated_at: now - 3600 }]);
    const metadata = JSON.parse(result.metadata!) as { blockTimestampCacheDeleted: number };
    expect(metadata.blockTimestampCacheDeleted).toBe(1);
  });

  it("reports all deleted counts in metadata", async () => {
    const {
      db,
      cronRuns,
      jobAttempts,
      repairTasks,
      canaryRuns,
      selectorSnapshotDailyQuotaRows,
      blockTimestampCacheRows,
      slotExecs,
    } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    cronRuns.push({ job: "sync-stablecoins", started_at: now - ONE_WEEK_SEC - 1 });
    jobAttempts.push({ state: "completed", updated_at: now - ONE_WEEK_SEC - 1 });
    repairTasks.push({ state: "closed", updated_at: now - ONE_WEEK_SEC - 1 });
    canaryRuns.push({ observed_at: now - NINETY_DAYS_SEC - 1 });
    selectorSnapshotDailyQuotaRows.push({ quota_date: toUtcDateString(now - TWO_DAYS_SEC - 24 * 60 * 60) });
    blockTimestampCacheRows.push({ updated_at: now - TWO_WEEKS_SEC - 1 });
    slotExecs.push({ slot_key: "quarterHourly", slot_started_at: now - TWO_WEEKS_SEC - 1 });

    const result = await runPruneCronHistory(db);
    const metadata = JSON.parse(result.metadata!) as {
      cronRunsDeleted: number;
      jobAttemptsDeleted: number;
      repairTasksDeleted: number;
      canaryRunsDeleted: number;
      selectorSnapshotDailyQuotaDeleted: number;
      blockTimestampCacheDeleted: number;
      slotExecutionsDeleted: number;
      cutoffCronRunsSec: number;
      cutoffJobAttemptsSec: number;
      cutoffRepairTasksSec: number;
      cutoffCanaryRunsSec: number;
      cutoffSelectorSnapshotDailyQuotaDate: string;
      cutoffBlockTimestampCacheSec: number;
      cutoffSlotExecutionsSec: number;
    };

    expect(metadata.cronRunsDeleted).toBe(1);
    expect(metadata.jobAttemptsDeleted).toBe(1);
    expect(metadata.repairTasksDeleted).toBe(1);
    expect(metadata.canaryRunsDeleted).toBe(1);
    expect(metadata.selectorSnapshotDailyQuotaDeleted).toBe(1);
    expect(metadata.blockTimestampCacheDeleted).toBe(1);
    expect(metadata.slotExecutionsDeleted).toBe(1);
    expect(metadata.cutoffCronRunsSec).toBeCloseTo(now - ONE_WEEK_SEC, -2);
    expect(metadata.cutoffJobAttemptsSec).toBeCloseTo(now - ONE_WEEK_SEC, -2);
    expect(metadata.cutoffRepairTasksSec).toBeCloseTo(now - ONE_WEEK_SEC, -2);
    expect(metadata.cutoffCanaryRunsSec).toBeCloseTo(now - NINETY_DAYS_SEC, -2);
    expect(metadata.cutoffSelectorSnapshotDailyQuotaDate).toBe(toUtcDateString(now - TWO_DAYS_SEC));
    expect(metadata.cutoffBlockTimestampCacheSec).toBeCloseTo(now - TWO_WEEKS_SEC, -2);
    expect(metadata.cutoffSlotExecutionsSec).toBeCloseTo(now - TWO_WEEKS_SEC, -2);
  });

  it("returns ok with zero counts when no rows are past either cutoff", async () => {
    const { db, cronRuns, slotExecs } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    // Only fresh rows — neither DELETE should match anything.
    cronRuns.push({ job: "sync-stablecoins", started_at: now - 3600 });
    slotExecs.push({ slot_key: "quarterHourly", slot_started_at: now - 3600 });

    const result = await runPruneCronHistory(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata!) as {
      cronRunsDeleted: number;
      slotExecutionsDeleted: number;
    };
    expect(metadata.cronRunsDeleted).toBe(0);
    expect(metadata.slotExecutionsDeleted).toBe(0);
    // Fresh rows must survive.
    expect(cronRuns).toHaveLength(1);
    expect(slotExecs).toHaveLength(1);
  });
});
