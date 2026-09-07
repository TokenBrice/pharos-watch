import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledSlotTask } from "../../handlers/scheduled/slot-groups";
import type { CronResult } from "../../lib/cron-logger";
import { buildScheduledSlotSummary, summarizeCronResult } from "../../handlers/scheduled/slot-summary";

const { runSingleScheduledJob, computeSafetyScoreV9, runV9AfterCoreWithinWindow } = vi.hoisted(() => ({
  runSingleScheduledJob: vi.fn(),
  computeSafetyScoreV9: vi.fn(),
  runV9AfterCoreWithinWindow: vi.fn(),
}));

vi.mock("../../handlers/scheduled/slot-groups", () => ({
  runSingleScheduledJob,
}));

vi.mock("../../lib/v9-slot-window", () => ({
  runV9AfterCoreWithinWindow,
}));

vi.mock("../../cron/compute-safety-score-v9", () => ({
  computeSafetyScoreV9,
}));

import { runV9PublicationSlot } from "../../handlers/scheduled/v9-publication";
import type { ScheduledRuntimeContext } from "../../handlers/scheduled/context";

function runtimeWith(
  mode: string | undefined,
  workflow: Pick<Workflow, "create" | "get">,
): ScheduledRuntimeContext {
  return {
    slotStartedAt: 1788433200,
    env: {
      WORKER_V9_WORKFLOW_MODE: mode,
      SAFETY_SCORE_V9_WORKFLOW: workflow,
    },
  } as unknown as ScheduledRuntimeContext;
}

describe("V9 publication Workflow trigger", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    computeSafetyScoreV9.mockResolvedValue({
      status: "ok",
      metadata: JSON.stringify({ sourceGenerationId: "source", baseInputGenerationId: "base" }),
    });
    runV9AfterCoreWithinWindow.mockImplementation(async (_options, run: () => Promise<CronResult>) => run());
    runSingleScheduledJob.mockImplementation(async (_runtime, _label, task: ScheduledSlotTask) => {
      const compiled = await task.run(new AbortController().signal, vi.fn());
      return buildScheduledSlotSummary([summarizeCronResult("compute-safety-score-v9", compiled)]);
    });
  });

  it("does not access the Workflow binding while mode is off", async () => {
    const workflow = {
      create: vi.fn(),
      get: vi.fn(),
    };

    const result = await runV9PublicationSlot(runtimeWith("off", workflow));

    expect(result).toMatchObject({ jobsRun: 1, jobsSucceeded: 1 });
    expect(workflow.create).not.toHaveBeenCalled();
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it("creates one deterministic instance after the cron slot settles", async () => {
    const order: string[] = [];
    runSingleScheduledJob.mockImplementationOnce(async (_runtime, _label, task: ScheduledSlotTask) => {
      await task.run(new AbortController().signal, vi.fn());
      order.push("cron");
      return buildScheduledSlotSummary([{ job: "compute-safety-score-v9", outcome: "ok" }]);
    });
    const workflow = {
      create: vi.fn(async () => {
        order.push("workflow");
        return {} as WorkflowInstance;
      }),
      get: vi.fn(),
    };

    await runV9PublicationSlot(runtimeWith("shadow", workflow));

    expect(order).toEqual(["cron", "workflow"]);
    // The Workflow reads its slot from params; the id stays deterministic for
    // idempotency, but is not the input channel.
    expect(workflow.create).toHaveBeenCalledWith({
      id: "v9-publication-1788433200",
      params: { slotStartedAt: 1788433200 },
    });
  });

  it("does not start a shadow when source inputs are unavailable", async () => {
    computeSafetyScoreV9.mockResolvedValue({
      status: "degraded",
      metadata: JSON.stringify({ stage: "input-load", reason: "stablecoins-generation-mismatch" }),
    });
    const workflow = { create: vi.fn(), get: vi.fn() };
    await runV9PublicationSlot(runtimeWith("shadow", workflow));
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("does not start a shadow when the execution window skips the compiler", async () => {
    runV9AfterCoreWithinWindow.mockResolvedValue({ status: "skipped_neutral" });
    const workflow = { create: vi.fn(), get: vi.fn() };
    await runV9PublicationSlot(runtimeWith("shadow", workflow));
    expect(computeSafetyScoreV9).not.toHaveBeenCalled();
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("still shadows an evaluated held publication with generation identity", async () => {
    computeSafetyScoreV9.mockResolvedValue({
      status: "degraded",
      metadata: JSON.stringify({
        sourceGenerationId: "source",
        baseInputGenerationId: "base",
        publication: { status: "held" },
      }),
    });
    const workflow = { create: vi.fn(), get: vi.fn() };
    await runV9PublicationSlot(runtimeWith("shadow", workflow));
    expect(workflow.create).toHaveBeenCalledOnce();
  });

  it("does not shadow an identity-bearing cadence deferral", async () => {
    computeSafetyScoreV9.mockResolvedValue({
      status: "skipped_neutral",
      metadata: JSON.stringify({ sourceGenerationId: "source", baseInputGenerationId: "base" }),
    });
    const workflow = { create: vi.fn(), get: vi.fn() };
    await runV9PublicationSlot(runtimeWith("shadow", workflow));
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("does not shadow a callback whose scheduled finalization fails", async () => {
    runSingleScheduledJob.mockImplementationOnce(async (_runtime, _label, task: ScheduledSlotTask) => {
      await task.run(new AbortController().signal, vi.fn());
      return buildScheduledSlotSummary([{ job: "compute-safety-score-v9", outcome: "error" }]);
    });
    const workflow = { create: vi.fn(), get: vi.fn() };
    await runV9PublicationSlot(runtimeWith("shadow", workflow));
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("treats an existing deterministic instance as a duplicate no-op", async () => {
    const workflow = {
      create: vi.fn(async () => {
        throw new Error("instance already exists");
      }),
      get: vi.fn(async () => ({
        status: async () => ({ status: "complete" as const }),
      } as WorkflowInstance)),
    };

    const result = await runV9PublicationSlot(
      runtimeWith("shadow", workflow),
    );

    expect(result).toMatchObject({ jobsRun: 1, jobsSucceeded: 1 });
    expect(workflow.get).toHaveBeenCalledWith(
      "v9-publication-1788433200",
    );
  });
});
