import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  runPruneStatusProbeRuns: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runPruneCronHistory: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runPruneDetailCache: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runTelegramInactiveCleanup: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runTelegramRetentionCleanup: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runDailyCronSentinel: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
}));

vi.mock("../../../cron/prune-status-probe-runs", () => ({
  runPruneStatusProbeRuns: mocks.runPruneStatusProbeRuns,
}));
vi.mock("../../../cron/prune-cron-history", () => ({ runPruneCronHistory: mocks.runPruneCronHistory }));
vi.mock("../../../cron/prune-detail-cache", () => ({ runPruneDetailCache: mocks.runPruneDetailCache }));
vi.mock("../../../cron/telegram-inactive-cleanup", () => ({
  runTelegramInactiveCleanup: mocks.runTelegramInactiveCleanup,
}));
vi.mock("../../../cron/telegram-retention-cleanup", () => ({
  runTelegramRetentionCleanup: mocks.runTelegramRetentionCleanup,
}));
vi.mock("../../../cron/cron-sentinel-daily", () => ({ runDailyCronSentinel: mocks.runDailyCronSentinel }));

import { runDaily0300Slot } from "../daily-0300";

function runtime(order: string[]): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return makeScheduledRuntime({
    db: makeNoopD1({
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
    }),
    cron: "3 3 * * *",
    scheduleKey: "daily0300Utc",
    scheduledTimeMs: null,
    slotStartedAt: 0,
    runLeasedCron: vi.fn(async (job, fn) => {
      order.push(job);
      return fn(signal, vi.fn());
    }),
  });
}

describe("daily 03:00 scheduling", () => {
  it("keeps the handler order in parity with the canonical slot registry", async () => {
    const order: string[] = [];

    await runDaily0300Slot(runtime(order));

    expect(order).toEqual(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.daily0300Utc));
    expect(order[0]).toBe("cron-sentinel");
    expect(mocks.runDailyCronSentinel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      repairRunnerEnabled: true,
    }));
  });
});
