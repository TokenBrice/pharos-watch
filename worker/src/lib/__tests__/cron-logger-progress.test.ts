import { afterEach, describe, expect, it, vi } from "vitest";

import { logCronRun } from "../cron-logger";
import {
  CRON_PROGRESS_LONG_RUN_AFTER_MS,
  CRON_PROGRESS_LONG_RUN_COALESCE_MS,
  PROGRESS_TELEMETRY_SKIP_JOBS,
} from "../cron-timeouts";
import { resolveScheduledSlotPolicy } from "../scheduled-slot-policy";
import { CRON_IN_FLIGHT_STALE_FLOOR_SEC } from "../status/cron-health";
import { CRON_SCHEDULE_DEFINITIONS } from "@shared/lib/cron-jobs";
import { makeCaptureDb, type DbCall } from "./cron-progress.test-support";

const PROGRESS_SKIP_TEST_JOBS = [...Object.keys(PROGRESS_TELEMETRY_SKIP_JOBS), "prune-future", "future-watchdog"];

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
