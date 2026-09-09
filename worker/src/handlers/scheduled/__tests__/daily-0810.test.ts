import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  generateWeeklyRecap: vi.fn(),
  syncDexShadowMeasuredExecution: vi.fn(),
}));

vi.mock("../../../cron/weekly-recap", () => ({ generateWeeklyRecap: mocks.generateWeeklyRecap }));
vi.mock("../../../cron/measured-execution/sync", () => ({
  syncDexShadowMeasuredExecution: mocks.syncDexShadowMeasuredExecution,
}));

import { runDaily0810Slot } from "../daily-0810";

describe("runDaily0810Slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateWeeklyRecap.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.syncDexShadowMeasuredExecution.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ measuredCount: 1 }),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("runs weekly recap alongside the exit-depth shadow lane", async () => {
    const order: string[] = [];
    const signal = new AbortController().signal;
    const runtime = makeScheduledRuntime({
      scheduleKey: "daily0810Utc",
      cron: "10 8 * * *",
      runLeasedCron: vi.fn(async (job, fn) => {
        order.push(job);
        return fn(signal, vi.fn());
      }),
    });

    const summary = await runDaily0810Slot(runtime);

    expect([...order].sort()).toEqual(
      [...flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.daily0810Utc)].sort(),
    );
    expect(mocks.generateWeeklyRecap).toHaveBeenCalledOnce();
    expect(mocks.syncDexShadowMeasuredExecution).toHaveBeenCalledOnce();
    expect(summary.jobs.map((job) => job.job).sort()).toEqual(["sync-cl-exit-depth", "weekly-recap"]);
  });
});
