import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({ syncBlacklist: vi.fn() }));

vi.mock("../../../cron/sync-blacklist", () => ({ syncBlacklist: mocks.syncBlacklist }));

import { runSixHourlyBlacklistSlot } from "../hourly-blacklist";

describe("runSixHourlyBlacklistSlot", () => {
  it("runs blacklist sync as the slot's only leased job", async () => {
    mocks.syncBlacklist.mockResolvedValue({ status: "ok", itemCount: 1 });
    const signal = new AbortController().signal;
    const reportProgress = vi.fn();
    let leasedJob: string | undefined;
    const runtime = makeScheduledRuntime({
      scheduleKey: "sixHourlyBlacklist",
      cron: "3 */6 * * *",
      runLeasedCron: vi.fn(async (job, fn) => {
        leasedJob = job;
        return fn(signal, reportProgress);
      }),
    });

    const summary = await runSixHourlyBlacklistSlot(runtime);

    expect(leasedJob).toBe("sync-blacklist");
    expect(mocks.syncBlacklist).toHaveBeenCalledWith(expect.objectContaining({
      db: runtime.db,
      etherscanApiKey: null,
      signal,
      onProgress: reportProgress,
      chainRpcs: runtime.chainRpcs,
    }));
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-blacklist"]);
  });
});
