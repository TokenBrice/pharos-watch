import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

const mocks = vi.hoisted(() => ({
  computeDepegResolver: vi.fn(),
  syncSafetyScoreV9SupplyAttribution: vi.fn(),
}));
const leaseMocks = vi.hoisted(() => ({
  runCronWithLease: vi.fn(),
}));

vi.mock("../../../cron/compute-depeg-resolver", () => ({
  computeDepegResolver: mocks.computeDepegResolver,
}));
vi.mock("../../../lib/cron-lease-primitives", () => ({
  runCronWithLease: leaseMocks.runCronWithLease,
}));
vi.mock("../../../cron/sync-v9-supply-attribution", () => ({
  syncSafetyScoreV9SupplyAttribution:
    mocks.syncSafetyScoreV9SupplyAttribution,
}));

import { runV9SupplyAttributionSlot } from "../v9-supply-attribution";
import { runV9AfterCoreWithinWindow } from "../../../lib/v9-slot-window";

const SCHEDULED_TIME_MS = 1_800_000;
const V9_SUPPLY_WINDOW_MS = 3 * 60_000;
const V9_SUPPLY_MINIMUM_REMAINING_MS = 60_000;
const DDR_HANDOFF_MARGIN_MS = 10_000;
const HANDOFF_DELAY_MS = 5_000;
const DDR_BUDGET_MS =
  V9_SUPPLY_WINDOW_MS - V9_SUPPLY_MINIMUM_REMAINING_MS -
  DDR_HANDOFF_MARGIN_MS;

function dbWithReadyCoreSlot(): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("FROM cron_runs")) {
        return { first: vi.fn(async () => null) };
      }
      const first = vi.fn(async () =>
        sql.includes("FROM cron_slot_executions") &&
        sql.includes("slot_key = 'quarterHourly'")
          ? {
              state: "finished",
              result_status: "ok",
              worker_version: "worker-v1",
            }
          : null,
      );
      return {
        bind: vi.fn(() => ({ first })),
      };
    }),
  } as unknown as D1Database;
}

function runtime(): ScheduledRuntimeContext {
  return {
    db: dbWithReadyCoreSlot(),
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "8,38 * * * *",
    scheduleKey: "v9SupplyAttributionOffset",
    scheduledTimeMs: SCHEDULED_TIME_MS,
    slotStartedAt: SCHEDULED_TIME_MS / 1_000,
    workerVersion: "worker-v1",
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig:
      {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(async (job, fn) => {
      try {
        return await fn(new AbortController().signal, vi.fn());
      } catch (error) {
        if (job === "compute-depeg-resolver") {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, HANDOFF_DELAY_MS),
          );
        }
        throw error;
      }
    }),
  };
}

describe("V9 supply-attribution scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SCHEDULED_TIME_MS);
    vi.clearAllMocks();
    leaseMocks.runCronWithLease.mockImplementation(async (
      _db: D1Database,
      _job: string,
      run: (input: { signal: AbortSignal }) => Promise<unknown>,
      leaseOptions?: { abortSignal?: AbortSignal },
    ) => ({
      status: "ok",
      result: await run({
        signal:
          leaseOptions?.abortSignal ?? new AbortController().signal,
      }),
    }));
    mocks.syncSafetyScoreV9SupplyAttribution.mockResolvedValue({
      status: "ok",
      itemCount: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts hung DDR with handoff margin and admits attribution through the real window", async () => {
    let ddrSignal: AbortSignal | undefined;
    mocks.computeDepegResolver.mockImplementation(({
      signal,
    }: { signal: AbortSignal }) => {
      ddrSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });

    const run = runV9SupplyAttributionSlot(runtime());
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.computeDepegResolver).toHaveBeenCalledOnce();
    expect(ddrSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(DDR_BUDGET_MS);
    expect(ddrSignal?.aborted).toBe(true);
    expect(mocks.syncSafetyScoreV9SupplyAttribution).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HANDOFF_DELAY_MS);
    await run;

    expect(ddrSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(mocks.syncSafetyScoreV9SupplyAttribution).toHaveBeenCalledOnce();

    vi.setSystemTime(
      SCHEDULED_TIME_MS +
      V9_SUPPLY_WINDOW_MS - V9_SUPPLY_MINIMUM_REMAINING_MS +
      HANDOFF_DELAY_MS,
    );
    const withoutMarginRun = vi.fn(async () => ({
      status: "ok" as const,
      itemCount: 1,
    }));
    const withoutMarginResult = await runV9AfterCoreWithinWindow(
      {
        db: dbWithReadyCoreSlot(),
        scheduledTimeMs: SCHEDULED_TIME_MS,
        slotStartedAt: SCHEDULED_TIME_MS / 1_000,
        workerVersion: "worker-v1",
        deadlineOffsetMs: V9_SUPPLY_WINDOW_MS,
        minimumRemainingMs: V9_SUPPLY_MINIMUM_REMAINING_MS,
        lane: "sync-v9-supply-attribution",
        currentSlotKey: "v9-offset",
      },
      withoutMarginRun,
    );
    expect(withoutMarginResult.productivity?.reason).toBe(
      "v9-slot-window-too-short",
    );
    expect(withoutMarginRun).not.toHaveBeenCalled();
  });

  it("skips DDR neutrally when its derived budget is already exhausted", async () => {
    vi.setSystemTime(SCHEDULED_TIME_MS + DDR_BUDGET_MS);
    const scheduledRuntime = runtime();

    const summary = await runV9SupplyAttributionSlot(scheduledRuntime);
    const ddrResult = await vi.mocked(scheduledRuntime.runLeasedCron)
      .mock.results[0]?.value;

    expect(mocks.computeDepegResolver).not.toHaveBeenCalled();
    expect(ddrResult).toEqual({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "ddr-budget-exhausted" }),
      productivity: {
        productive: false,
        reason: "ddr-budget-exhausted",
      },
    });
    expect(summary.jobs[0]).toMatchObject({
      job: "compute-depeg-resolver",
      outcome: "skipped",
      reason: "ddr-budget-exhausted",
      neutral: true,
    });
    expect(mocks.syncSafetyScoreV9SupplyAttribution).toHaveBeenCalledOnce();
  });
});
