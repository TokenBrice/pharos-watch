import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import {
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
} from "../../../lib/public-dataset-snapshot-budget";

const mocks = vi.hoisted(() => ({
  snapshotSupply: vi.fn(),
  snapshotSafetyGradeHistory: vi.fn(),
  snapshotPsiDaily: vi.fn(),
  snapshotPublicDataset: vi.fn(),
  fetchTbillRate: vi.fn(),
  syncUsdsStatus: vi.fn(),
}));

vi.mock("../../../cron/snapshot-supply", () => ({ snapshotSupply: mocks.snapshotSupply }));
vi.mock("../../../cron/snapshot-safety-grade-history", () => ({ snapshotSafetyGradeHistory: mocks.snapshotSafetyGradeHistory }));
vi.mock("../../../cron/snapshot-psi", () => ({ snapshotPsiDaily: mocks.snapshotPsiDaily }));
vi.mock("../../../cron/snapshot-public-dataset", () => ({ snapshotPublicDataset: mocks.snapshotPublicDataset }));
vi.mock("../../../cron/fetch-tbill-rate", () => ({ fetchTbillRate: mocks.fetchTbillRate }));
vi.mock("../../../cron/sync-usds-status", () => ({ syncUsdsStatus: mocks.syncUsdsStatus }));

import { runDaily0800Slot } from "../daily-0800";

const SLOT_STARTED_AT = 1_777_777_800; // 2026-05-16T08:00:00Z

function runtime(order: string[]): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  return makeScheduledRuntime({
    scheduleKey: "daily0800Utc",
    cron: "0 8 * * *",
    slotStartedAt: SLOT_STARTED_AT,
    runLeasedCron: vi.fn(async (job, fn) => {
      order.push(job);
      return fn(signal, vi.fn());
    }),
  });
}

describe("runDaily0800Slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshotSupply.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotSafetyGradeHistory.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotPsiDaily.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotPublicDataset.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.fetchTbillRate.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.syncUsdsStatus.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  afterEach(() => vi.restoreAllMocks());

  it("dispatches all six jobs, gating snapshots on the cache freshness window", async () => {
    const order: string[] = [];
    const rt = runtime(order);

    await runDaily0800Slot(rt);

    expect([...order].sort()).toEqual(
      [...flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.daily0800Utc)].sort(),
    );
    expect(mocks.snapshotSafetyGradeHistory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.snapshotPsiDaily.mock.invocationCallOrder[0],
    );
    expect(mocks.snapshotPsiDaily.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.snapshotPublicDataset.mock.invocationCallOrder[0],
    );
    expect(mocks.snapshotSupply).toHaveBeenCalledWith(rt.db, expect.any(AbortSignal), {
      minStablecoinsCacheUpdatedAtSec: SLOT_STARTED_AT,
      freshnessGateLabel: "daily0800Utc",
    });
    expect(mocks.snapshotPublicDataset).toHaveBeenCalledWith(rt.db, expect.any(AbortSignal), {
      minStablecoinsCacheUpdatedAtSec: SLOT_STARTED_AT,
      freshnessGateLabel: "daily0800Utc",
      stablecoinsCacheRetryAttempts: PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
      stablecoinsCacheRetryDelayMs: PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
    });
  });

  it("contains a tbill failure in its chain and still runs sync-usds-status", async () => {
    mocks.fetchTbillRate.mockRejectedValue(new Error("tbill failed"));

    const summary = await runDaily0800Slot(runtime([]));

    expect(mocks.fetchTbillRate).toHaveBeenCalledOnce();
    expect(mocks.syncUsdsStatus).toHaveBeenCalledOnce();
    expect(summary.jobs.find((job) => job.job === "fetch-tbill-rate")?.outcome).toBe("error");
    expect(summary.jobs.find((job) => job.job === "sync-usds-status")?.outcome).toBe("ok");
  });
});
