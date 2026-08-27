import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import {
  makeScheduledRuntime,
  mockSuccessfulCronLease,
} from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  syncSafetyScoreV9SupplyAttribution: vi.fn(),
}));
const leaseMocks = vi.hoisted(() => ({
  runCronWithLease: vi.fn(),
}));

vi.mock("../../../lib/cron-lease-primitives", () => ({
  runCronWithLease: leaseMocks.runCronWithLease,
}));
vi.mock("../../../cron/sync-v9-supply-attribution", () => ({
  syncSafetyScoreV9SupplyAttribution:
    mocks.syncSafetyScoreV9SupplyAttribution,
}));

import { runV9SupplyAttributionSlot } from "../v9-supply-attribution";

const SCHEDULED_TIME_MS = 1_800_000;

function dbWithReadyCoreSlot(): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
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
  return makeScheduledRuntime({
    db: dbWithReadyCoreSlot(),
    cron: "8 * * * *",
    scheduleKey: "v9SupplyAttributionOffset",
    scheduledTimeMs: SCHEDULED_TIME_MS,
    slotStartedAt: SCHEDULED_TIME_MS / 1_000,
    workerVersion: "worker-v1",
  });
}

describe("V9 supply-attribution scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SCHEDULED_TIME_MS);
    vi.clearAllMocks();
    mockSuccessfulCronLease(leaseMocks.runCronWithLease);
    mocks.syncSafetyScoreV9SupplyAttribution.mockResolvedValue({
      status: "ok",
      itemCount: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs only supply attribution in the memory-isolated slot", async () => {
    const scheduledRuntime = runtime();
    const summary = await runV9SupplyAttributionSlot(scheduledRuntime);

    expect(scheduledRuntime.runLeasedCron).toHaveBeenCalledOnce();
    expect(scheduledRuntime.runLeasedCron).toHaveBeenCalledWith(
      "sync-v9-supply-attribution",
      expect.any(Function),
    );
    expect(mocks.syncSafetyScoreV9SupplyAttribution).toHaveBeenCalledOnce();
    expect(summary.jobs).toEqual([
      expect.objectContaining({
        job: "sync-v9-supply-attribution",
        outcome: "ok",
      }),
    ]);
  });
});
