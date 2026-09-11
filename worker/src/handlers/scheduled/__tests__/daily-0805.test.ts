import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";

const mocks = vi.hoisted(() => ({
  syncBluechip: vi.fn(),
  generateDailyDigest: vi.fn(),
}));

vi.mock("../../../cron/sync-bluechip", () => ({ syncBluechip: mocks.syncBluechip }));
vi.mock("../../../cron/daily-digest", () => ({ generateDailyDigest: mocks.generateDailyDigest }));

import { runDaily0805Slot } from "../daily-0805";

function runtime(order: string[]): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  const env = createWorkerEnv({
    ANTHROPIC_API_KEY: "anthropic-key",
    TWITTER_API_KEY: "tw-key",
    TWITTER_API_SECRET: "tw-secret",
    TWITTER_ACCESS_TOKEN: "tw-token",
    TWITTER_ACCESS_TOKEN_SECRET: "tw-token-secret",
  });
  return makeScheduledRuntime({
    scheduleKey: "daily0805Utc",
    cron: "5 8 * * *",
    env,
    runLeasedCron: vi.fn(async (job, fn) => {
      order.push(job);
      return fn(signal, vi.fn());
    }),
  });
}

describe("runDaily0805Slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncBluechip.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.generateDailyDigest.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  afterEach(() => vi.restoreAllMocks());

  it("runs bluechip and daily digest in parallel, passing digest twitter credentials", async () => {
    const order: string[] = [];

    await runDaily0805Slot(runtime(order));

    expect([...order].sort()).toEqual(
      [...flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.daily0805Utc)].sort(),
    );
    expect(mocks.syncBluechip).toHaveBeenCalledOnce();
    expect(mocks.generateDailyDigest).toHaveBeenCalledOnce();
    const digestArgs = mocks.generateDailyDigest.mock.calls[0] as unknown[] | undefined;
    expect(digestArgs?.[2]).toEqual({
      apiKey: "tw-key",
      apiSecret: "tw-secret",
      accessToken: "tw-token",
      accessTokenSecret: "tw-token-secret",
    });
    expect(digestArgs?.[3]).toBe(false);
  });

  it("contains a daily digest failure while bluechip still runs", async () => {
    mocks.generateDailyDigest.mockRejectedValue(new Error("digest failed"));

    const summary = await runDaily0805Slot(runtime([]));

    expect(mocks.syncBluechip).toHaveBeenCalledOnce();
    expect(mocks.generateDailyDigest).toHaveBeenCalledOnce();
    expect(summary.jobs.find((job) => job.job === "daily-digest")?.outcome).toBe("error");
    expect(summary.jobs.find((job) => job.job === "sync-bluechip")?.outcome).toBe("ok");
  });
});
