import { describe, expect, it, vi } from "vitest";

import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  runStatusSelfCheck: vi.fn(),
  runDataInvariantCanary: vi.fn(),
  runCronSentinel: vi.fn(),
}));

vi.mock("../../../cron/status-self-check", () => ({ runStatusSelfCheck: mocks.runStatusSelfCheck }));
vi.mock("../../../cron/data-invariant-canary", () => ({ runDataInvariantCanary: mocks.runDataInvariantCanary }));
vi.mock("../../../cron/cron-sentinel", () => ({ runCronSentinel: mocks.runCronSentinel }));

import { runStatusSelfCheckSlot } from "../status-self-check";

describe("runStatusSelfCheckSlot", () => {
  it("runs status self-check, canary, and sentinel in plan order", async () => {
    const order: string[] = [];
    const signal = new AbortController().signal;
    mocks.runStatusSelfCheck.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runDataInvariantCanary.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.runCronSentinel.mockResolvedValue({ status: "ok", itemCount: 1 });

    const runtime = makeScheduledRuntime({
      scheduleKey: "statusSelfCheckOffset",
      cron: "9 * * * *",
      runLeasedCron: vi.fn(async (job, fn) => {
        order.push(job);
        return fn(signal, vi.fn());
      }),
    });

    await runStatusSelfCheckSlot(runtime);

    expect(order).toEqual(flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.statusSelfCheckOffset));
    expect(order[0]).toBe("status-self-check");
    expect(order[1]).toBe("data-invariant-canary");
  });
});
