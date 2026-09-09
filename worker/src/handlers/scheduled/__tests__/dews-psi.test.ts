import { describe, expect, it, vi } from "vitest";

import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  computeAndStoreDEWS: vi.fn(),
  computeAndStoreStabilityIndex: vi.fn(),
  projectTape: vi.fn(),
}));

vi.mock("../../../cron/compute-dews", () => ({ computeAndStoreDEWS: mocks.computeAndStoreDEWS }));
vi.mock("../../../cron/stability-index", () => ({ computeAndStoreStabilityIndex: mocks.computeAndStoreStabilityIndex }));
vi.mock("../../../cron/project-tape", () => ({ projectTape: mocks.projectTape }));

import { runDewsPsiSlot } from "../dews-psi";

describe("runDewsPsiSlot", () => {
  it("runs DEWS before stability index and project tape in plan order", async () => {
    const order: string[] = [];
    const signal = new AbortController().signal;
    mocks.computeAndStoreDEWS.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.computeAndStoreStabilityIndex.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.projectTape.mockResolvedValue({ status: "ok", itemCount: 1 });

    const runtime = makeScheduledRuntime({
      scheduleKey: "dewsPsiOffset",
      cron: "26,56 * * * *",
      runLeasedCron: vi.fn(async (job, fn) => {
        order.push(job);
        return fn(signal, vi.fn());
      }),
    });

    await runDewsPsiSlot(runtime);

    expect(order).toEqual(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.dewsPsiOffset));
    expect(order[0]).toBe("compute-dews");
    expect(order[1]).toBe("stability-index");
  });
});
