import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  runSingleScheduledJob: vi.fn(),
  runV9AfterCoreWithinWindow: vi.fn(),
  computeSafetyScoreV9: vi.fn(),
  logWorkerEvent: vi.fn(),
}));

vi.mock("../slot-groups", () => ({
  runSingleScheduledJob: mocks.runSingleScheduledJob,
}));
vi.mock("../../../lib/v9-slot-window", () => ({
  runV9AfterCoreWithinWindow: mocks.runV9AfterCoreWithinWindow,
}));
vi.mock("../../../cron/compute-safety-score-v9", () => ({
  computeSafetyScoreV9: mocks.computeSafetyScoreV9,
}));
vi.mock("../../../lib/structured-log", () => ({
  logWorkerEvent: mocks.logWorkerEvent,
}));

import { runV9PublicationSlot } from "../v9-publication";

function runtime(): ScheduledRuntimeContext {
  return makeScheduledRuntime({
    db: {} as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    cron: "22,52 * * * *",
    scheduleKey: "v9PublicationOffset",
    scheduledTimeMs: 1_800_000,
    slotStartedAt: 1_800,
    workerVersion: "worker-v1",
  });
}

describe("V9 publication scheduling", () => {
  const published = { jobsRun: 1, jobsSucceeded: 1, jobsErrored: 0, jobsDegraded: 0, jobsSkipped: 0 };
  const identities = { sourceGenerationId: "source-7", baseInputGenerationId: "base-9" };

  function compilingRuntime(mode = "shadow", metadata: Record<string, string> = identities) {
    const scheduledRuntime = runtime();
    const workflow = { create: vi.fn().mockResolvedValue({}), get: vi.fn() };
    scheduledRuntime.env = {
      ...scheduledRuntime.env, WORKER_V9_WORKFLOW_MODE: mode,
      SAFETY_SCORE_V9_WORKFLOW: workflow,
    } as unknown as ScheduledRuntimeContext["env"];
    mocks.computeSafetyScoreV9.mockResolvedValue({ status: "ok", metadata: JSON.stringify(metadata) });
    mocks.runV9AfterCoreWithinWindow.mockImplementation(async (_options, run) => run(new AbortController().signal));
    return { scheduledRuntime, workflow };
  }

  afterEach(() => vi.restoreAllMocks());
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
      return published;
    });
  });

  it("admits the compiler timeout plus finalization headroom", async () => {
    const scheduledRuntime = runtime();

    await runV9PublicationSlot(scheduledRuntime);

    expect(mocks.runV9AfterCoreWithinWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        db: scheduledRuntime.db,
        scheduledTimeMs: scheduledRuntime.scheduledTimeMs,
        slotStartedAt: scheduledRuntime.slotStartedAt,
        workerVersion: "worker-v1",
        deadlineOffsetMs: 3 * 60_000,
        minimumRemainingMs: 10_000,
        lane: "compute-safety-score-v9",
        currentSlotKey: "v9PublicationOffset",
      }),
      expect.any(Function),
    );
  });

  it("runs the compiler and triggers shadow work with the original slot identity", async () => {
    const { scheduledRuntime, workflow } = compilingRuntime();
    expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
    expect(mocks.computeSafetyScoreV9).toHaveBeenCalledOnce();
    expect(workflow.create).toHaveBeenCalledExactlyOnceWith({
      id: "v9-publication-1800", params: { slotStartedAt: 1800 },
    });
  });

  it("requires both compiler identities and shadow mode", async () => {
    for (const [mode, metadata] of [
      ["shadow", { sourceGenerationId: "source-7" }],
      ["shadow", { baseInputGenerationId: "base-9" }],
      ["off", identities],
    ] as const) {
      const { scheduledRuntime, workflow } = compilingRuntime(mode, metadata);
      expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
      expect(workflow.create).not.toHaveBeenCalled();
    }
  });

  it("accepts duplicate creation when the existing instance has a known status", async () => {
    const { scheduledRuntime, workflow } = compilingRuntime();
    workflow.create.mockRejectedValue(new Error("already exists"));
    workflow.get.mockResolvedValue({ status: async () => ({ status: "complete" }) });
    expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
    expect(workflow.get).toHaveBeenCalledWith("v9-publication-1800");
    expect(mocks.logWorkerEvent).not.toHaveBeenCalled();
  });

  it.each(["unknown", "missing"])("reports %s instances without rejecting successful publication", async (state) => {
    const { scheduledRuntime, workflow } = compilingRuntime();
    workflow.create.mockRejectedValue(new Error("create failed"));
    if (state === "unknown") workflow.get.mockResolvedValue({ status: async () => ({ status: "unknown" }) });
    else workflow.get.mockRejectedValue(new Error("not found"));
    expect(await runV9PublicationSlot(scheduledRuntime)).toBe(published);
    expect(mocks.logWorkerEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: "safety_score_v9_shadow_workflow_trigger_failed",
      metadata: { instanceId: "v9-publication-1800", slotStartedAt: 1800, errorName: "Error" },
    }));
  });
});
