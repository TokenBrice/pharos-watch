import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

const mocks = vi.hoisted(() => ({
  runSingleScheduledJob: vi.fn(),
  runV9AfterCoreWithinWindow: vi.fn(),
}));

vi.mock("../slot-groups", () => ({
  runSingleScheduledJob: mocks.runSingleScheduledJob,
}));
vi.mock("../../../lib/v9-slot-window", () => ({
  runV9AfterCoreWithinWindow: mocks.runV9AfterCoreWithinWindow,
}));

import { runV9PublicationSlot } from "../v9-publication";

function runtime(): ScheduledRuntimeContext {
  return {
    db: {} as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "22,52 * * * *",
    scheduleKey: "v9PublicationOffset",
    scheduledTimeMs: 1_800_000,
    slotStartedAt: 1_800,
    workerVersion: "worker-v1",
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(),
  };
}

describe("V9 publication scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runV9AfterCoreWithinWindow.mockResolvedValue({
      status: "skipped_neutral",
      itemCount: 0,
    });
    mocks.runSingleScheduledJob.mockImplementation(async (
      _scheduledRuntime: ScheduledRuntimeContext,
      _label: string,
      task: {
        run: (
          signal: AbortSignal,
          reportProgress: ReturnType<typeof vi.fn>,
        ) => Promise<unknown>;
      },
    ) => {
      await task.run(new AbortController().signal, vi.fn());
      return {
        jobsRun: 1,
        jobsErrored: 0,
        jobsDegraded: 0,
        jobsSkipped: 1,
      };
    });
  });

  it("admits a bounded 60-second compiler window with ten seconds required", async () => {
    const scheduledRuntime = runtime();

    await runV9PublicationSlot(scheduledRuntime);

    expect(mocks.runV9AfterCoreWithinWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        db: scheduledRuntime.db,
        scheduledTimeMs: scheduledRuntime.scheduledTimeMs,
        slotStartedAt: scheduledRuntime.slotStartedAt,
        workerVersion: "worker-v1",
        deadlineOffsetMs: 60_000,
        minimumRemainingMs: 10_000,
        lane: "compute-safety-score-v9",
        currentSlotKey: "v9PublicationOffset",
      }),
      expect.any(Function),
    );
  });
});
