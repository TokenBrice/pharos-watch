import { describe, expect, it } from "vitest";

import { createScheduledRuntimeContext } from "../context";
import { makeCaptureDb, type DbCall } from "../../../lib/__tests__/cron-progress.test-support";

describe("scheduled runtime context", () => {
  it("writes the started progress row only after acquiring the job lease", async () => {
    const calls: DbCall[] = [];
    const db = makeCaptureDb(calls);
    const runtime = createScheduledRuntimeContext(
      { DB: db } as Parameters<typeof createScheduledRuntimeContext>[0],
      {} as ExecutionContext,
      {
        cron: "*/15 * * * *",
        scheduleKey: "quarterHourly",
        scheduledTimeMs: null,
        slotStartedAt: Math.floor(Date.now() / 1000),
      },
    );

    await runtime.runLeasedCron("sync-stablecoins", async () => ({ itemCount: 1 }));

    const leaseIndex = calls.findIndex(({ sql }) => sql.includes("INSERT INTO cron_leases"));
    const startedProgressIndex = calls.findIndex(
      ({ sql, args }) => sql.includes("INSERT INTO cron_run_progress") && args[4] === "started",
    );
    expect(leaseIndex).toBeGreaterThanOrEqual(0);
    expect(startedProgressIndex).toBeGreaterThan(leaseIndex);
  });
});
