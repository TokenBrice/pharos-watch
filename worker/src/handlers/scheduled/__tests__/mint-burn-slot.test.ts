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
    mocks.refreshAggregateMintBurnFlowCache.mockResolvedValue(new Response("{}"));
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
