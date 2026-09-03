import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  freshness: vi.fn(),
  digest: vi.fn(),
  duration: vi.fn(),
  growth: vi.fn(),
  repair: vi.fn(),
  turnover: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock("../cron-staleness-watchdog", () => ({ runCronStalenessWatchdog: mocks.freshness }));
vi.mock("../digest-publication-watchdog", () => ({ runDigestPublicationWatchdog: mocks.digest }));
vi.mock("../cron-duration-watchdog", () => ({ runCronDurationWatchdog: mocks.duration }));
vi.mock("../mint-burn-growth-watchdog", () => ({ runMintBurnGrowthWatchdog: mocks.growth }));
vi.mock("../../lib/repair-tasks", () => ({ runWorkerRepairTaskRunner: mocks.repair }));
vi.mock("../dex-exit-route-turnover-watchdog", () => ({ runDexExitRouteTurnoverWatchdog: mocks.turnover }));
vi.mock("../reserve-post-sync-watchdog", () => ({ runReservePostSyncWatchdog: mocks.reserve }));

import { runCronSentinel } from "../cron-sentinel";

describe("runCronSentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mocks)) mock.mockResolvedValue({ itemCount: 0 });
  });

  it("runs the status sources and preserves a degraded result", async () => {
    mocks.freshness.mockResolvedValue({ status: "degraded", itemCount: 2, metadata: "{\"stale\":true}" });
    const result = await runCronSentinel({} as D1Database, { mode: "status", nowSec: 123 });
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(2);
    expect(mocks.freshness).toHaveBeenCalledTimes(1);
    expect(mocks.digest).toHaveBeenCalledTimes(1);
    expect(mocks.duration).not.toHaveBeenCalled();
  });

  it("runs the daily duration source", async () => {
    const signal = new AbortController().signal;
    const result = await runCronSentinel({} as D1Database, {
      mode: "daily",
      nowSec: 456,
      signal,
    });
    expect(result.status).toBe("ok");
    expect(mocks.growth).toHaveBeenCalledTimes(1);
    expect(mocks.duration).toHaveBeenCalledTimes(1);
    expect(mocks.repair).toHaveBeenCalledWith(expect.anything(), {
      nowSec: 456,
      signal,
      enabled: undefined,
    });
  });

  it.each([
    ["turnover", "turnover"],
    ["reserve-post-sync", "reserve"],
  ] as const)("runs only the %s producer-adjacent source", async (mode, mockName) => {
    const result = await runCronSentinel({} as D1Database, { mode });
    expect(result.status).toBe("ok");
    expect(mocks[mockName]).toHaveBeenCalledTimes(1);
    expect(mocks.freshness).not.toHaveBeenCalled();
    expect(mocks.duration).not.toHaveBeenCalled();
  });
});
