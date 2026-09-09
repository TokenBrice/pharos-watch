import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({ syncYieldData: vi.fn() }));

vi.mock("../../../cron/sync-yield-data", () => ({ syncYieldData: mocks.syncYieldData }));

import { runHourlyYieldSlot } from "../hourly-yield";

describe("runHourlyYieldSlot", () => {
  it("runs yield publication as the slot's only leased job", async () => {
    mocks.syncYieldData.mockResolvedValue({ status: "ok", itemCount: 1 });
    const signal = new AbortController().signal;
    const reportProgress = vi.fn();
    let leasedJob: string | undefined;
    const runtime = makeScheduledRuntime({
      scheduleKey: "hourlyYieldSync",
      cron: "55 * * * *",
      runLeasedCron: vi.fn(async (job, fn) => {
        leasedJob = job;
        return fn(signal, reportProgress);
      }),
    });

    const summary = await runHourlyYieldSlot(runtime);

    expect(leasedJob).toBe("sync-yield-data");
    expect(mocks.syncYieldData).toHaveBeenCalledWith(
      runtime.db,
      signal,
      runtime.chainRpcs,
      runtime.coingeckoApiKey,
      runtime.env.ETHERSCAN_API_KEY ?? null,
      reportProgress,
    );
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-yield-data"]);
  });
});
