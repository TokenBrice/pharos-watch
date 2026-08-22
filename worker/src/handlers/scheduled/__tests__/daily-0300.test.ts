import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  runPruneStatusProbeRuns: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runPruneCronHistory: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runRepairTaskRunner: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runPruneDetailCache: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runTelegramInactiveCleanup: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runTelegramRetentionCleanup: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runMintBurnGrowthWatchdog: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
  runCronDurationWatchdog: vi.fn(async () => ({ status: "ok" as const, itemCount: 0 })),
}));

vi.mock("../../../cron/prune-status-probe-runs", () => ({
  runPruneStatusProbeRuns: mocks.runPruneStatusProbeRuns,
}));
vi.mock("../../../cron/prune-cron-history", () => ({ runPruneCronHistory: mocks.runPruneCronHistory }));
vi.mock("../../../cron/repair-task-runner", () => ({ runRepairTaskRunner: mocks.runRepairTaskRunner }));
vi.mock("../../../cron/prune-detail-cache", () => ({ runPruneDetailCache: mocks.runPruneDetailCache }));
vi.mock("../../../cron/telegram-inactive-cleanup", () => ({
  runTelegramInactiveCleanup: mocks.runTelegramInactiveCleanup,
}));
vi.mock("../../../cron/telegram-retention-cleanup", () => ({
  runTelegramRetentionCleanup: mocks.runTelegramRetentionCleanup,
}));
vi.mock("../../../cron/mint-burn-growth-watchdog", () => ({
  runMintBurnGrowthWatchdog: mocks.runMintBurnGrowthWatchdog,
}));
vi.mock("../../../cron/cron-duration-watchdog", () => ({
  runCronDurationWatchdog: mocks.runCronDurationWatchdog,
}));

import { runDaily0300Slot } from "../daily-0300";

function runtime(order: string[]): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return {
    db: {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
    } as unknown as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "0 3 * * *",
    scheduleKey: "daily0300Utc",
    scheduledTimeMs: null,
    slotStartedAt: 0,
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(async (job, fn) => {
      order.push(job);
      return fn(signal, vi.fn());
    }),
  };
}

describe("daily 03:00 scheduling", () => {
  it("keeps the handler order in parity with the canonical slot registry", async () => {
    const order: string[] = [];

    await runDaily0300Slot(runtime(order));

    expect(order).toEqual(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.daily0300Utc));
    expect(order.slice(0, 2)).toEqual([
      "mint-burn-growth-watchdog",
      "cron-duration-watchdog",
    ]);
  });
});
