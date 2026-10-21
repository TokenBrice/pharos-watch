import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  syncMintBurn: vi.fn(),
  refreshAggregateMintBurnFlowCache: vi.fn(),
}));

vi.mock("../../../cron/sync-mint-burn", () => ({ syncMintBurn: mocks.syncMintBurn }));
vi.mock("../../../api/mint-burn-flows", () => ({
  refreshAggregateMintBurnFlowCache: mocks.refreshAggregateMintBurnFlowCache,
}));
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeDecision: vi.fn(async () => undefined),
  mapCronStatusToCircuitOutcome: vi.fn((status: string | null | undefined) =>
    status === "error" ? "failure" : "success"),
}));

import { runHalfHourlyMintBurnCriticalSlot } from "../twenty-minute-mint-burn-critical";
import { runHalfHourlyMintBurnExtendedSlot } from "../twenty-minute-mint-burn-extended";

function runtime(scheduleKey: string, cron: string): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return makeScheduledRuntime({
    scheduleKey: scheduleKey as ScheduledRuntimeContext["scheduleKey"],
    cron,
    runLeasedCron: vi.fn(async (_job, fn) => fn(signal, vi.fn())),
  });
}

describe("mint/burn slot lanes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncMintBurn.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () =>
      new Response("{}", { headers: { "X-Data-Freshness": "fresh" } }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("runs the critical lane with 24h and 168h aggregate cache publication", async () => {
    const rt = runtime("halfHourlyMintBurnCritical", "4 * * * *");

    const summary = await runHalfHourlyMintBurnCriticalSlot(rt);

    expect(mocks.syncMintBurn).toHaveBeenCalledWith(
      rt.db,
      rt.env.ALCHEMY_API_KEY ?? null,
      expect.objectContaining({ lane: "critical", jobName: "sync-mint-burn" }),
    );
    expect(mocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledWith(rt.db, 24);
    expect(mocks.refreshAggregateMintBurnFlowCache).toHaveBeenCalledWith(rt.db, 168);
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-mint-burn"]);
  });

  it("retains FTQ advisories without degrading completed fresh flow publication", async () => {
    const warning = '199 - "Flight-to-quality classification is unavailable (publication-held)."';
    mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () =>
      new Response("{}", { headers: { "X-Data-Freshness": "fresh", Warning: warning } }));
    const rt = runtime("halfHourlyMintBurnCritical", "4 * * * *");

    const summary = await runHalfHourlyMintBurnCriticalSlot(rt);
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;

    expect(summary.jobs[0]).toMatchObject({ status: "ok", outcome: "ok" });
    expect(JSON.parse(result?.metadata ?? "{}").sidecars[0]).toMatchObject({
      status: "ok", reason: null, itemCount: 2,
      windows: [
        { hours: 24, published: true, freshness: "fresh", warning },
        { hours: 168, published: true, freshness: "fresh", warning },
      ],
    });
  });

  it.each(["degraded", "stale", "unknown", null])(
    "degrades published windows with %s flow freshness",
    async (freshness) => {
      mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () =>
        new Response("{}", { headers: freshness == null ? {} : { "X-Data-Freshness": freshness } }));
      const summary = await runHalfHourlyMintBurnCriticalSlot(runtime("halfHourlyMintBurnCritical", "4 * * * *"));

      expect(summary.jobs[0]).toMatchObject({
        status: "degraded", reason: "mint-burn-aggregate-freshness-unavailable",
      });
    },
  );

  it("names a failed aggregate publication without claiming the scan failed", async () => {
    mocks.refreshAggregateMintBurnFlowCache
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "X-Data-Freshness": "fresh" } }));
    const rt = runtime("halfHourlyMintBurnCritical", "4 * * * *");

    const summary = await runHalfHourlyMintBurnCriticalSlot(rt);
    const result = await vi.mocked(rt.runLeasedCron).mock.results[0].value;

    expect(summary.jobs[0]).toMatchObject({
      status: "degraded", reason: "mint-burn-aggregate-publication-failed",
    });
    expect(JSON.parse(result?.metadata ?? "{}").sidecars[0]).toMatchObject({
      status: "error", reason: "mint-burn-aggregate-publication-failed", itemCount: 1,
    });
  });

  it("preserves a primary scan failure reason when aggregate publication also fails", async () => {
    mocks.syncMintBurn.mockResolvedValue({
      status: "degraded", itemCount: 1, metadata: JSON.stringify({ reason: "finality-head-unavailable" }),
    });
    mocks.refreshAggregateMintBurnFlowCache.mockImplementation(async () => {
      throw new Error("cache write failed");
    });
    const summary = await runHalfHourlyMintBurnCriticalSlot(runtime("halfHourlyMintBurnCritical", "4 * * * *"));

    expect(summary.jobs[0]).toMatchObject({ status: "degraded", reason: "finality-head-unavailable" });
  });

  it("runs the extended lane without aggregate cache publication", async () => {
    const rt = runtime("halfHourlyMintBurnExtended", "18 * * * *");

    const summary = await runHalfHourlyMintBurnExtendedSlot(rt);

    expect(mocks.syncMintBurn).toHaveBeenCalledWith(
      rt.db,
      rt.env.ALCHEMY_API_KEY ?? null,
      expect.objectContaining({ lane: "extended", jobName: "sync-mint-burn-extended" }),
    );
    expect(mocks.refreshAggregateMintBurnFlowCache).not.toHaveBeenCalled();
    expect(summary.jobs.map((job) => job.job)).toEqual(["sync-mint-burn-extended"]);
  });
});
