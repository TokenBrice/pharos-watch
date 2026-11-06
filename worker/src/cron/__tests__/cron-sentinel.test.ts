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

const sourceStates = vi.hoisted(() => new Map<string, { value: string; updatedAt: number }>());
vi.mock("../../lib/db-cache", () => ({
  getCaches: vi.fn(async () => new Map(sourceStates)),
  setCacheIfNewer: vi.fn(async (_db, key, value, updatedAt) => {
    if ((sourceStates.get(key)?.updatedAt ?? -1) <= updatedAt) sourceStates.set(key, { value, updatedAt });
    return { written: true, skippedBecauseNewer: false };
  }),
}));

import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import { runCronSentinel } from "../cron-sentinel";
import { runDailyCronSentinel } from "../cron-sentinel-daily";

function emptyDb(): D1Database {
  return { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
}

describe("runCronSentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceStates.clear();
    for (const mock of Object.values(mocks)) mock.mockResolvedValue({ itemCount: 0 });
  });

  it("runs the status sources and preserves a degraded result", async () => {
    mocks.freshness.mockResolvedValue({ status: "degraded", itemCount: 2, metadata: "{\"stale\":true}" });
    const result = await runCronSentinel(emptyDb(), { mode: "status", nowSec: 123 });
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(2);
    expect(mocks.freshness).toHaveBeenCalledTimes(1);
    expect(mocks.freshness).toHaveBeenCalledWith(expect.anything(), undefined, {
      operatorTelegramCreds: null,
    });
    expect(mocks.digest).toHaveBeenCalledTimes(1);
    expect(mocks.duration).not.toHaveBeenCalled();
  });

  it.each([undefined, "duration", "growth", "repair"] as const)("runs daily sources and retries failed %s across modes", async (failed) => {
    const signal = new AbortController().signal;
    if (failed) mocks[failed].mockRejectedValueOnce(Error("D1 overloaded")).mockRejectedValueOnce(Error("still overloaded"));
    const result = await runDailyCronSentinel(emptyDb(), {
      nowSec: 789, repairRunnerEnabled: true,
      signal,
    });

    expect(result.status).toBe(failed ? "error" : "ok");
    expect(mocks.growth).toHaveBeenCalledTimes(1);
    expect(mocks.duration).toHaveBeenCalledTimes(1);
    expect(mocks.repair).toHaveBeenCalledWith(expect.anything(), {
      nowSec: 789,
      signal, enabled: true,
    });
    if (!failed) return;
    for (const [at, calls, status] of [[1688, 1, "error"], [1689, 2, "error"], [1690, 2, "error"], [2589, 3, "ok"], [2590, 3, "ok"]] as const) {
      const mode = at === 1689 ? "turnover" : at === 2589 ? "reserve-post-sync" : "status";
      const retry = await runCronSentinel(emptyDb(), { mode, nowSec: at, repairRunnerEnabled: true, signal });
      expect(retry.status).toBe(status);
      expect(mocks[failed]).toHaveBeenCalledTimes(calls);
      const source = failed === "repair" ? "repair-debt" : failed;
      expect(JSON.parse(retry.metadata!).sources[source]).toMatchObject({
        intervalSec: 86400, maxAgeSec: 172800,
        attempt: { count: calls, attemptedAt: calls === 1 ? 789 : calls === 2 ? 1689 : 2589 },
      });
    }
  });

  it.each([
    ["turnover", "turnover"],
    ["reserve-post-sync", "reserve"],
  ] as const)("runs only the %s producer-adjacent source", async (mode, mockName) => {
    const result = await runCronSentinel(emptyDb(), { mode });
    expect(result.status).toBe("ok");
    expect(mocks[mockName]).toHaveBeenCalledTimes(1);
    expect(mocks.freshness).not.toHaveBeenCalled();
    expect(mocks.duration).not.toHaveBeenCalled();
  });
  it("keeps the freshness canary, PSI and probe rule ids in the sentinel metadata", async () => {
    mocks.freshness.mockResolvedValueOnce({
      status: "degraded", itemCount: 3,
      metadata: JSON.stringify({
        firedRuleIds: ["canary-finding", "probe-path-persistent-failure", "psi-daily-coverage"],
      }),
    });
    const result = await runCronSentinel(emptyDb(), { mode: "status", nowSec: 300 });
    const metadata = JSON.parse(result.metadata ?? "{}") as { firedRuleIds?: Record<string, string[]> };
    expect(metadata.firedRuleIds?.freshness).toEqual([
      "canary-finding", "probe-path-persistent-failure", "psi-daily-coverage",
    ]);
  });
  it("lifts a reserve source quality finding into the sentinel run summary", async () => {
    const db = emptyDb();
    mocks.reserve.mockResolvedValueOnce({
      status: "ok", itemCount: 1,
      metadata: JSON.stringify({
        firedRuleIds: ["reserve-score-ineligible-sustained"],
        quality: { reasons: ["reserve-score-ineligible-sustained"] },
      }),
    });
    const result = await runCronSentinel(db, { mode: "reserve-post-sync", nowSec: 500 });
    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.quality).toEqual({
      reason: "sentinel-source-findings",
      sources: { "reserve-post-sync": { reasons: ["reserve-score-ineligible-sustained"] } },
    });
    expect(getCronQualityReasons(metadata)).toEqual([
      "sentinel-source-findings", "reserve-post-sync:reserve-score-ineligible-sustained",
    ]);
    const retained = await runCronSentinel(db, { mode: "status", nowSec: 600 });
    expect(retained.status).toBe("ok");
    expect(JSON.parse(retained.metadata!).quality).toEqual(metadata.quality);
  });

  it("persists thrown source errors and rejects an older successful overwrite", async () => {
    const db = emptyDb();
    mocks.reserve.mockRejectedValueOnce(new Error("reserve evaluation failed"));
    expect((await runCronSentinel(db, { mode: "reserve-post-sync", nowSec: 200 })).status).toBe("error");
    expect((await runCronSentinel(db, { mode: "reserve-post-sync", nowSec: 100 })).status).toBe("error");
    expect((await runCronSentinel(db, { mode: "status", nowSec: 300 })).status).toBe("error");
    expect((await runCronSentinel(db, { mode: "reserve-post-sync", nowSec: 400 })).status).toBe("ok");
  });

  it("propagates cancellation without erasing saved source state", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(runCronSentinel(emptyDb(), { mode: "status", signal: controller.signal })).rejects.toThrow("cancelled");
    expect(sourceStates.size).toBe(0);
    expect(mocks.freshness).not.toHaveBeenCalled();
  });

  it("keeps a first unevaluated source neutral", async () => {
    mocks.turnover.mockResolvedValueOnce({ status: "skipped_neutral" });
    expect((await runCronSentinel(emptyDb(), { mode: "turnover", nowSec: 200 })).status).toBe("skipped_neutral");
  });

});
