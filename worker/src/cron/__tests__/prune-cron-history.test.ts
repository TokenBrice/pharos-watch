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

/**
 * Minimal D1 stub that understands the two DELETE statements issued by
 * runPruneCronHistory plus the SELECT COUNT(*) verification queries used
 * in this test. Mirrors the pattern in prune-status-probe-runs.test.ts.
 */
function createStubDb(): {
  db: D1Database;
  cronRuns: CronRunRow[];
  slotExecs: SlotExecRow[];
} {
  const cronRuns: CronRunRow[] = [];
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

  return { db, cronRuns, slotExecs };
}

const ONE_WEEK_SEC = 7 * 24 * 60 * 60;
const TWO_WEEKS_SEC = 14 * 24 * 60 * 60;

describe("runPruneCronHistory", () => {
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

  it("reports both deleted counts in metadata", async () => {
    const { db, cronRuns, slotExecs } = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    cronRuns.push({ job: "sync-stablecoins", started_at: now - ONE_WEEK_SEC - 1 });
    slotExecs.push({ slot_key: "quarterHourly", slot_started_at: now - TWO_WEEKS_SEC - 1 });

    const result = await runPruneCronHistory(db);
    const metadata = JSON.parse(result.metadata!) as {
      cronRunsDeleted: number;
      slotExecutionsDeleted: number;
      cutoffCronRunsSec: number;
      cutoffSlotExecutionsSec: number;
    };

    expect(metadata.cronRunsDeleted).toBe(1);
    expect(metadata.slotExecutionsDeleted).toBe(1);
    expect(metadata.cutoffCronRunsSec).toBeCloseTo(now - ONE_WEEK_SEC, -2);
    expect(metadata.cutoffSlotExecutionsSec).toBeCloseTo(now - TWO_WEEKS_SEC, -2);
  });
});
