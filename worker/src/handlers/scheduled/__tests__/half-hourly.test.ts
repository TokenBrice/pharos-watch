import { describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({ stageDexLiquidityScoring: vi.fn() }));

vi.mock("../../../cron/dex-liquidity/orchestrator", () => ({
  stageDexLiquidityScoring: mocks.stageDexLiquidityScoring,
}));

import { runHalfHourlySlot } from "../half-hourly";

describe("runHalfHourlySlot", () => {
  it("stages DEX liquidity scoring as the slot's only leased job", async () => {
    mocks.stageDexLiquidityScoring.mockResolvedValue({ status: "ok", itemCount: 1 });
    const signal = new AbortController().signal;
    const reportProgress = vi.fn();
    let leasedJob: string | undefined;
    const runtime = makeScheduledRuntime({
      scheduleKey: "halfHourlyOffset",
      cron: "10 * * * *",
      slotStartedAt: 600,
      runLeasedCron: vi.fn(async (job, fn) => {
        leasedJob = job;
        return fn(signal, reportProgress);
      }),
    });

    const summary = await runHalfHourlySlot(runtime);

    expect(leasedJob).toBe("sync-dex-liquidity-stage");
    expect(mocks.stageDexLiquidityScoring).toHaveBeenCalledWith(
      runtime.db,
      runtime.env.GRAPH_API_KEY ?? null,
      signal,
      runtime.coingeckoApiKey,
      runtime.chainRpcs,
      reportProgress,
      runtime.slotStartedAt,
    );
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-dex-liquidity-stage"]);
  });
});
