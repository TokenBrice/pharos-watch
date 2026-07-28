import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

const mocks = vi.hoisted(() => ({
  consumeDexLiquidityScoringStage: vi.fn(),
  prepareSafetyScoreV9Input: vi.fn(),
  syncStablecoinCharts: vi.fn(),
}));

vi.mock("../../../cron/dex-liquidity/orchestrator", () => ({
  consumeDexLiquidityScoringStage: mocks.consumeDexLiquidityScoringStage,
}));
vi.mock("../../../cron/prepare-safety-score-v9-input", () => ({
  prepareSafetyScoreV9Input: mocks.prepareSafetyScoreV9Input,
}));
vi.mock("../../../cron/sync-stablecoin-charts", () => ({
  syncStablecoinCharts: mocks.syncStablecoinCharts,
}));

import { runHalfHourlyChartsSlot } from "../half-hourly-charts";

function runtime(): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return {
    db: {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
    } as unknown as D1Database,
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "16,46 * * * *",
    scheduleKey: "halfHourlyChartsOffset",
    scheduledTimeMs: 1_800_000,
    slotStartedAt: 1_800,
    workerVersion: "worker-v1",
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(async (_job, fn) => fn(signal, vi.fn())),
  };
}

describe("half-hourly charts scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareSafetyScoreV9Input.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.syncStablecoinCharts.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  it("skips V9 input after a DEX failure while keeping charts independent", async () => {
    mocks.consumeDexLiquidityScoringStage.mockRejectedValue(new Error("stale DEX stage"));
    const scheduledRuntime = runtime();

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      { scheduledAtSec: scheduledRuntime.slotStartedAt },
    );
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["sync-dex-liquidity", "error", undefined],
      ["prepare-safety-score-v9-input", "skipped", "upstream-failure:sync-dex-liquidity"],
      ["sync-stablecoin-charts", "ok", undefined],
    ]);
  });

  it("binds V9 input to the generation returned by a successful DEX publication", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({
        persistence: { generationId: "dex-liquidity-123" },
      }),
    });
    const scheduledRuntime = runtime();

    await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      "dex-liquidity-123",
    );
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
  });
});
