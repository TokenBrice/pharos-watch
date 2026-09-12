import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronResult } from "../../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  syncYieldData: vi.fn(async (): Promise<CronResult> => ({ status: "ok", itemCount: 1 })),
  fetchTbillRate: vi.fn(async (): Promise<CronResult> => ({ status: "ok", itemCount: 0 })),
  syncYieldSupplemental: vi.fn(async (): Promise<CronResult> => ({ status: "ok", itemCount: 0 })),
}));

vi.mock("../../../cron/sync-yield-data", () => ({ syncYieldData: mocks.syncYieldData }));
vi.mock("../../../cron/fetch-tbill-rate", () => ({ fetchTbillRate: mocks.fetchTbillRate }));
vi.mock("../../../cron/sync-yield-supplemental", () => ({
  syncYieldSupplemental: mocks.syncYieldSupplemental,
}));

import { HOURLY_TBILL_MIN_REGISTRY_AGE_SEC, SUPPLEMENTAL_CATCH_UP_MIN_MARKER_AGE_SEC } from "../hourly-yield";
import { runHourlyYieldSlot } from "../hourly-yield";

function buildRuntime(): {
  runtime: ScheduledRuntimeContext;
  signal: AbortSignal;
  reportProgress: ReturnType<typeof vi.fn>;
  leasedJobs: string[];
} {
  const signal = new AbortController().signal;
  const reportProgress = vi.fn(async () => {});
  const leasedJobs: string[] = [];
  const runLeasedCron = vi.fn(async (job: string, fn: Parameters<ScheduledRuntimeContext["runLeasedCron"]>[1]) => {
    leasedJobs.push(job);
    return fn(signal, reportProgress);
  });
  return {
    runtime: makeScheduledRuntime({
      scheduleKey: "hourlyYieldSync",
      cron: "55 * * * *",
      runLeasedCron: runLeasedCron as ScheduledRuntimeContext["runLeasedCron"],
    }),
    signal,
    reportProgress,
    leasedJobs,
  };
}

describe("runHourlyYieldSlot", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs the catch-up, the benchmark refresh and the publication in one serial leased chain", async () => {
    const { runtime, signal, reportProgress, leasedJobs } = buildRuntime();

    const summary = await runHourlyYieldSlot(runtime);

    // Order is the contract: both retries publish evidence that the publication
    // reads inside the same slot.
    expect(leasedJobs).toEqual(["sync-yield-supplemental", "fetch-tbill-rate", "sync-yield-data"]);
    expect(summary.jobs.map((job) => job.job)).toEqual([
      "sync-yield-supplemental",
      "fetch-tbill-rate",
      "sync-yield-data",
    ]);
    expect(mocks.syncYieldSupplemental).toHaveBeenCalledWith(
      runtime.db,
      signal,
      runtime.chainRpcs,
      reportProgress,
      expect.objectContaining({ enabled: false }),
      { catchUpMinMarkerAgeSec: SUPPLEMENTAL_CATCH_UP_MIN_MARKER_AGE_SEC },
    );
    expect(mocks.fetchTbillRate).toHaveBeenCalledWith(runtime.db, signal, runtime.env, {
      minRegistryAgeSec: HOURLY_TBILL_MIN_REGISTRY_AGE_SEC,
    });
    expect(mocks.syncYieldData).toHaveBeenCalledWith(
      runtime.db,
      signal,
      runtime.chainRpcs,
      runtime.coingeckoApiKey,
      runtime.env.ETHERSCAN_API_KEY ?? null,
      reportProgress,
    );
  });

  it("keeps publishing when the opportunistic catch-up fails", async () => {
    mocks.syncYieldSupplemental.mockRejectedValueOnce(new Error("catch-up exploded"));
    const { runtime } = buildRuntime();

    const summary = await runHourlyYieldSlot(runtime);

    expect(summary.jobs.map(({ job, outcome }) => [job, outcome])).toEqual([
      ["sync-yield-supplemental", "error"],
      ["fetch-tbill-rate", "ok"],
      ["sync-yield-data", "ok"],
    ]);
    expect(mocks.syncYieldData).toHaveBeenCalledTimes(1);
  });

  it("continues past a not-due catch-up skip and still publishes", async () => {
    mocks.syncYieldSupplemental.mockResolvedValueOnce({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "supplemental-catch-up-not-due",
        newestFamilyMarkerAgeSec: 3 * 3600,
      }),
    });
    const { runtime } = buildRuntime();

    const summary = await runHourlyYieldSlot(runtime);

    expect(summary.jobs.map(({ job, outcome, neutral }) => [job, outcome, neutral])).toEqual([
      ["sync-yield-supplemental", "skipped", true],
      ["fetch-tbill-rate", "ok", undefined],
      ["sync-yield-data", "ok", undefined],
    ]);
    expect(summary.jobs[0]?.reason).toBe("supplemental-catch-up-not-due");
    expect(mocks.syncYieldData).toHaveBeenCalledTimes(1);
  });

  it("treats a fresh benchmark registry as a neutral no-op, not a failure", async () => {
    mocks.fetchTbillRate.mockResolvedValueOnce({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        skipped: true,
        skipReason: "risk-free-registry-fresh",
        minRegistryAgeSec: HOURLY_TBILL_MIN_REGISTRY_AGE_SEC,
      }),
    });
    const { runtime } = buildRuntime();

    const summary = await runHourlyYieldSlot(runtime);

    expect(summary.jobs.map(({ job, outcome }) => [job, outcome])).toEqual([
      ["sync-yield-supplemental", "ok"],
      ["fetch-tbill-rate", "skipped"],
      ["sync-yield-data", "ok"],
    ]);
    expect(mocks.syncYieldData).toHaveBeenCalledTimes(1);
  });
});
