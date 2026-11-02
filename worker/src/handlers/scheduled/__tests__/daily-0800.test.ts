import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import {
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_ATTEMPTS,
  PUBLIC_DATASET_STABLECOINS_CACHE_RETRY_DELAY_MS,
} from "@shared/lib/public-dataset-snapshot-budget";

const mocks = vi.hoisted(() => ({
  snapshotSupply: vi.fn(),
  snapshotSafetyGradeHistory: vi.fn(),
  snapshotPsiDaily: vi.fn(),
  snapshotPublicDataset: vi.fn(),
  fetchTbillRate: vi.fn(),
  syncUsdsStatus: vi.fn(),
  syncBluechip: vi.fn(),
  generateDailyDigest: vi.fn(),
}));

vi.mock("../../../cron/snapshot-supply", () => ({ snapshotSupply: mocks.snapshotSupply }));
vi.mock("../../../cron/snapshot-safety-grade-history", () => ({ snapshotSafetyGradeHistory: mocks.snapshotSafetyGradeHistory }));
vi.mock("../../../cron/snapshot-psi", () => ({ snapshotPsiDaily: mocks.snapshotPsiDaily }));
vi.mock("../../../cron/snapshot-public-dataset", () => ({ snapshotPublicDataset: mocks.snapshotPublicDataset }));
vi.mock("../../../cron/fetch-tbill-rate", () => ({ fetchTbillRate: mocks.fetchTbillRate }));
vi.mock("../../../cron/sync-usds-status", () => ({ syncUsdsStatus: mocks.syncUsdsStatus }));
vi.mock("../../../cron/sync-bluechip", () => ({ syncBluechip: mocks.syncBluechip }));
vi.mock("../../../cron/daily-digest", () => ({ generateDailyDigest: mocks.generateDailyDigest }));

import { runDaily0800Slot } from "../daily-0800";
import { runDaily0805Slot } from "../daily-0805";

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
    mocks.syncBluechip.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.generateDailyDigest.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  afterEach(() => vi.restoreAllMocks());

  it("gates both supply snapshots on the slot's stablecoins-cache freshness window", async () => {
    const rt = runtime([]);

    await runDaily0800Slot(rt);

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

describe("runDaily0805Slot", () => {
  it("contains a daily digest failure while bluechip still runs", async () => {
    mocks.generateDailyDigest.mockRejectedValue(new Error("digest failed"));
    const signal = new AbortController().signal;
    const rt = makeScheduledRuntime({
      scheduleKey: "daily0805Utc",
      cron: "5 8 * * *",
      runLeasedCron: vi.fn(async (_job, fn) => {
        return fn(signal, vi.fn());
      }),
    });

    const summary = await runDaily0805Slot(rt);

    expect(mocks.syncBluechip).toHaveBeenCalledOnce();
    expect(mocks.generateDailyDigest).toHaveBeenCalledOnce();
    expect(summary.jobs.find((job) => job.job === "daily-digest")?.outcome).toBe("error");
    expect(summary.jobs.find((job) => job.job === "sync-bluechip")?.outcome).toBe("ok");
  });
});
