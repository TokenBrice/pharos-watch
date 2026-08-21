import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

const mocks = vi.hoisted(() => ({
  consumeDexLiquidityScoringStage: vi.fn(),
  reuseCurrentDexLiquidityScoringGeneration: vi.fn(),
  runDexExitRouteTurnoverWatchdog: vi.fn(),
  prepareSafetyScoreV9Input: vi.fn(),
  syncStablecoinCharts: vi.fn(),
}));

vi.mock("../../../cron/dex-liquidity/orchestrator", () => ({
  consumeDexLiquidityScoringStage: mocks.consumeDexLiquidityScoringStage,
  reuseCurrentDexLiquidityScoringGeneration: mocks.reuseCurrentDexLiquidityScoringGeneration,
}));
vi.mock("../../../cron/prepare-safety-score-v9-input", () => ({
  prepareSafetyScoreV9Input: mocks.prepareSafetyScoreV9Input,
}));
vi.mock("../../../cron/dex-exit-route-turnover-watchdog", () => ({
  runDexExitRouteTurnoverWatchdog: mocks.runDexExitRouteTurnoverWatchdog,
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
    scheduledTimeMs: 960_000,
    slotStartedAt: 960,
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
    mocks.reuseCurrentDexLiquidityScoringGeneration.mockResolvedValue({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        persistence: {
          generationId: "dex-liquidity-current",
          skipped: false,
          skippedReason: "liquidity-cadence-reuse",
        },
      }),
    });
    mocks.runDexExitRouteTurnoverWatchdog.mockResolvedValue({ status: "ok", itemCount: 1 });
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
      ["dex-exit-route-turnover-watchdog", "skipped", "upstream-dex-publication-unavailable"],
      ["prepare-safety-score-v9-input", "skipped", "upstream-dex-publication-unavailable"],
      ["sync-stablecoin-charts", "ok", undefined],
    ]);
    expect(summary.jobs[1]?.neutral).toBe(true);
    expect(summary.jobs[2]?.neutral).toBe(true);
  });

  it("skips V9 input neutrally when degraded DEX scoring withholds publication", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({
        persistence: {
          generationId: null,
          skipped: true,
          skippedReason: "defillama-yields-unavailable",
        },
      }),
    });
    const scheduledRuntime = runtime();

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["sync-dex-liquidity", "degraded", undefined],
      ["dex-exit-route-turnover-watchdog", "skipped", "upstream-dex-publication-unavailable"],
      ["prepare-safety-score-v9-input", "skipped", "upstream-dex-publication-unavailable"],
      ["sync-stablecoin-charts", "ok", undefined],
    ]);
    expect(summary.jobs[1]?.neutral).toBe(true);
    expect(summary.jobs[2]?.neutral).toBe(true);
  });

  it.each([
    { status: "error", skipped: false },
    { status: "degraded", skipped: true },
  ] as const)(
    "does not trust a retained generation on a $status DEX result with skipped=$skipped",
    async ({ status, skipped }) => {
      mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
        status,
        itemCount: 1,
        metadata: JSON.stringify({
          persistence: {
            generationId: "dex-liquidity-stale",
            skipped,
            skippedReason: skipped ? "publication-withheld" : null,
          },
        }),
      });
      const scheduledRuntime = runtime();

      const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

      expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
      expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
      expect(summary.jobs[2]).toMatchObject({
        job: "prepare-safety-score-v9-input",
        outcome: "skipped",
        reason: "upstream-dex-publication-unavailable",
        neutral: true,
      });
    },
  );

  it("skips V9 input neutrally when the DEX consumer lease is locked", async () => {
    const scheduledRuntime = runtime();
    vi.mocked(scheduledRuntime.runLeasedCron).mockImplementation(async (job, fn) => {
      if (job === "sync-dex-liquidity") {
        return { status: "skipped_locked" };
      }
      return fn(new AbortController().signal, vi.fn());
    });

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.consumeDexLiquidityScoringStage).not.toHaveBeenCalled();
    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(summary.jobs.map((job) => [job.job, job.outcome, job.reason])).toEqual([
      ["sync-dex-liquidity", "skipped", "lease-locked"],
      ["dex-exit-route-turnover-watchdog", "skipped", "upstream-dex-publication-unavailable"],
      ["prepare-safety-score-v9-input", "skipped", "upstream-dex-publication-unavailable"],
      ["sync-stablecoin-charts", "ok", undefined],
    ]);
    expect(summary.jobs[1]?.neutral).toBe(true);
    expect(summary.jobs[2]?.neutral).toBe(true);
  });

  it("fails closed when a successful DEX result omits its generation", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({
        persistence: {
          generationId: null,
          skipped: false,
        },
      }),
    });
    const scheduledRuntime = runtime();

    const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(summary.jobs[2]).toMatchObject({
      job: "prepare-safety-score-v9-input",
      outcome: "error",
      error: "DEX publication result omitted its exact generation id",
    });
  });

  it.each(["{malformed", "null", "[]"])(
    "keeps the DEX outcome intact and fails V9 closed for metadata %s",
    async (metadata) => {
      mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
        status: "ok",
        itemCount: 1,
        metadata,
      });
      const scheduledRuntime = runtime();

      const summary = await runHalfHourlyChartsSlot(scheduledRuntime);

      expect(mocks.prepareSafetyScoreV9Input).not.toHaveBeenCalled();
      expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
      expect(summary.jobs[0]).toMatchObject({
        job: "sync-dex-liquidity",
        outcome: "ok",
      });
      expect(summary.jobs[2]).toMatchObject({
        job: "prepare-safety-score-v9-input",
        outcome: "error",
        error: "DEX publication result omitted its exact generation id",
      });
    },
  );

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
      scheduledRuntime.chainRpcs,
    );
    expect(mocks.syncStablecoinCharts).toHaveBeenCalled();
    expect(mocks.runDexExitRouteTurnoverWatchdog).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
    );
  });

  it("refreshes prices without publishing liquidity on odd-hour :16", async () => {
    mocks.consumeDexLiquidityScoringStage.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ persistence: { generationId: "dex-liquidity-current" } }),
    });
    const scheduledRuntime = runtime();
    scheduledRuntime.slotStartedAt = 4_560; // 1970-01-01 01:16 UTC

    await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.consumeDexLiquidityScoringStage).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      expect.any(Function),
      scheduledRuntime.slotStartedAt,
      {
        publishLiquidity: false,
        publishShadowTargets: false,
        stageReadyDeadlineMs: scheduledRuntime.scheduledTimeMs! + 90_000,
      },
    );
    expect(mocks.runDexExitRouteTurnoverWatchdog).not.toHaveBeenCalled();
  });

  it("reuses the exact current generation at :46 without consuming a source stage", async () => {
    const scheduledRuntime = runtime();
    scheduledRuntime.slotStartedAt = 2_760; // 1970-01-01 00:46 UTC

    await runHalfHourlyChartsSlot(scheduledRuntime);

    expect(mocks.consumeDexLiquidityScoringStage).not.toHaveBeenCalled();
    expect(mocks.reuseCurrentDexLiquidityScoringGeneration).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
    );
    expect(mocks.prepareSafetyScoreV9Input).toHaveBeenCalledWith(
      scheduledRuntime.db,
      expect.any(AbortSignal),
      "dex-liquidity-current",
      scheduledRuntime.chainRpcs,
    );
    expect(mocks.runDexExitRouteTurnoverWatchdog).not.toHaveBeenCalled();
  });
});
