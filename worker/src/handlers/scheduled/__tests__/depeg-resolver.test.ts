import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import {
  makeScheduledRuntime,
  mockSuccessfulCronLease,
} from "../../../test-helpers/scheduled-runtime.test-support";

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

  return makeScheduledRuntime({
    db,
    cron: "13 * * * *",
    scheduleKey: "depegResolverOffset",
    scheduledTimeMs: SLOT_STARTED_AT * 1_000,
    slotStartedAt: SLOT_STARTED_AT,
    workerVersion: "worker-v1",
  });
}

describe("depeg-resolver scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT_STARTED_AT * 1_000);
    vi.clearAllMocks();
    mockSuccessfulCronLease(leaseMocks.runCronWithLease);
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
