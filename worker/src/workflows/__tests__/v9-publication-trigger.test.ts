import { beforeEach, describe, expect, it, vi } from "vitest";

const { runSingleScheduledJob } = vi.hoisted(() => ({
  runSingleScheduledJob: vi.fn(async () => ({
    jobsRun: ["compute-safety-score-v9"],
  })),
}));

vi.mock("../../handlers/scheduled/slot-groups", () => ({
  runSingleScheduledJob,
}));

vi.mock("../../lib/v9-slot-window", () => ({
  runV9AfterCoreWithinWindow: vi.fn(),
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
    runSingleScheduledJob.mockClear();
  });

  it("does not access the Workflow binding while mode is off", async () => {
    const workflow = {
      create: vi.fn(),
      get: vi.fn(),
    };

    const result = await runV9PublicationSlot(runtimeWith("off", workflow));

    expect(result).toEqual({ jobsRun: ["compute-safety-score-v9"] });
    expect(workflow.create).not.toHaveBeenCalled();
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it("creates one deterministic instance after the cron slot settles", async () => {
    const order: string[] = [];
    runSingleScheduledJob.mockImplementationOnce(async () => {
      order.push("cron");
      return { jobsRun: ["compute-safety-score-v9"] };
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

    expect(result).toEqual({ jobsRun: ["compute-safety-score-v9"] });
    expect(workflow.get).toHaveBeenCalledWith(
      "v9-publication-1788433200",
    );
  });
});
