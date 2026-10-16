import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  syncBluechip: vi.fn(),
  generateDailyDigest: vi.fn(),
}));

vi.mock("../../../cron/sync-bluechip", () => ({ syncBluechip: mocks.syncBluechip }));
vi.mock("../../../cron/daily-digest", () => ({ generateDailyDigest: mocks.generateDailyDigest }));

import { runDaily0805Slot } from "../daily-0805";

function runtime(order: string[]): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return makeScheduledRuntime({
    scheduleKey: "daily0805Utc",
    cron: "5 8 * * *",
    runLeasedCron: vi.fn(async (job, fn) => {
      order.push(job);
      return fn(signal, vi.fn());
    }),
  });
}

describe("runDaily0805Slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncBluechip.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.generateDailyDigest.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  afterEach(() => vi.restoreAllMocks());

  it("contains a daily digest failure while bluechip still runs", async () => {
    mocks.generateDailyDigest.mockRejectedValue(new Error("digest failed"));

    const summary = await runDaily0805Slot(runtime([]));

    expect(mocks.syncBluechip).toHaveBeenCalledOnce();
    expect(mocks.generateDailyDigest).toHaveBeenCalledOnce();
    expect(summary.jobs.find((job) => job.job === "daily-digest")?.outcome).toBe("error");
    expect(summary.jobs.find((job) => job.job === "sync-bluechip")?.outcome).toBe("ok");
  });
});
