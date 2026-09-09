import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({ syncDexDiscovery: vi.fn() }));

vi.mock("../../../cron/dex-discovery/orchestrator", () => ({
  syncDexDiscovery: mocks.syncDexDiscovery,
}));

import { runTwoHourlyDexDiscoverySlot } from "../thirty-minute-dex-discovery";

describe("runTwoHourlyDexDiscoverySlot", () => {
  it("runs DEX discovery as the slot's only leased job", async () => {
    mocks.syncDexDiscovery.mockResolvedValue({ status: "ok", itemCount: 1 });
    const signal = new AbortController().signal;
    const reportProgress = vi.fn();
    let leasedJob: string | undefined;
    const runtime = makeScheduledRuntime({
      scheduleKey: "twoHourlyDexDiscovery",
      cron: "6 */2 * * *",
      runLeasedCron: vi.fn(async (job, fn) => {
        leasedJob = job;
        return fn(signal, reportProgress);
      }),
    });

    const summary = await runTwoHourlyDexDiscoverySlot(runtime);

    expect(leasedJob).toBe("sync-dex-discovery");
    expect(mocks.syncDexDiscovery).toHaveBeenCalledWith(
      runtime.db,
      runtime.env.COINGECKO_API_KEY ?? null,
      signal,
      reportProgress,
    );
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-dex-discovery"]);
  });
});
