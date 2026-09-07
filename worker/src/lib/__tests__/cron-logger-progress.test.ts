import { afterEach, describe, expect, it, vi } from "vitest";

import { logCronRun } from "../cron-logger";
import { PROGRESS_TELEMETRY_SKIP_JOBS } from "../cron-timeouts";
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
