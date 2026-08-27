import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";

const mocks = vi.hoisted(() => ({
  computeDepegResolver: vi.fn(),
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

import { runDepegResolverSlot } from "../depeg-resolver";

const SLOT_STARTED_AT = 2_580;

function runtime(): ScheduledRuntimeContext {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("FROM cron_runs")) {
        return {
          first: vi.fn(async () => ({
            started_at: SLOT_STARTED_AT - 60,
            metadata: JSON.stringify({
              capabilities: {
                stablecoinsCache: true,
                depegPipeline: true,
              },
            }),
          })),
        };
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
      return { bind: vi.fn(() => ({ first })) };
    }),
  } as unknown as D1Database;

  return {
    db,
    env: {} as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "13 * * * *",
    scheduleKey: "depegResolverOffset",
    scheduledTimeMs: SLOT_STARTED_AT * 1_000,
    slotStartedAt: SLOT_STARTED_AT,
    workerVersion: "worker-v1",
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig:
      {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    chainRpcs: new Map(),
    runLeasedCron: vi.fn(async (_job, fn) =>
      fn(new AbortController().signal, vi.fn()),
    ),
  };
}

describe("depeg-resolver scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT_STARTED_AT * 1_000);
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
    mocks.computeDepegResolver.mockResolvedValue({
      status: "ok",
      itemCount: 21,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs DDR alone from fresh stablecoin capability evidence", async () => {
    const scheduledRuntime = runtime();
    const summary = await runDepegResolverSlot(scheduledRuntime);

    expect(scheduledRuntime.runLeasedCron).toHaveBeenCalledOnce();
    expect(scheduledRuntime.runLeasedCron).toHaveBeenCalledWith(
      "compute-depeg-resolver",
      expect.any(Function),
    );
    expect(mocks.computeDepegResolver).toHaveBeenCalledWith(expect.objectContaining({
      db: scheduledRuntime.db,
      slot: "scheduled-quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      syncCapabilities: expect.objectContaining({
        stablecoinsCache: true,
        depegPipeline: true,
        latestSyncStartedAt: SLOT_STARTED_AT - 60,
        stale: false,
      }),
    }));
    expect(summary.jobs).toEqual([
      expect.objectContaining({
        job: "compute-depeg-resolver",
        outcome: "ok",
      }),
    ]);
  });
});
