import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  freshness: vi.fn(),
  digest: vi.fn(),
  duration: vi.fn(),
  growth: vi.fn(),
  repair: vi.fn(),
  turnover: vi.fn(),
  reserve: vi.fn(),
  reconciliation: vi.fn(),
}));

vi.mock("../cron-staleness-watchdog", () => ({ runCronStalenessWatchdog: mocks.freshness }));
vi.mock("../digest-publication-watchdog", () => ({ runDigestPublicationWatchdog: mocks.digest }));
vi.mock("../cron-duration-watchdog", () => ({ runCronDurationWatchdog: mocks.duration }));
vi.mock("../mint-burn-growth-watchdog", () => ({ runMintBurnGrowthWatchdog: mocks.growth }));
vi.mock("../../lib/repair-tasks", () => ({ runWorkerRepairTaskRunner: mocks.repair }));
vi.mock("../dex-exit-route-turnover-watchdog", () => ({ runDexExitRouteTurnoverWatchdog: mocks.turnover }));
vi.mock("../reserve-post-sync-watchdog", () => ({ runReservePostSyncWatchdog: mocks.reserve }));
vi.mock("../mint-burn-reconciliation-watchdog", () => ({ runMintBurnReconciliationWatchdog: mocks.reconciliation }));

const sourceStates = vi.hoisted(() => new Map<string, { value: string; updatedAt: number }>());
const watchdog = vi.hoisted(() => ({ context: vi.fn(), receipts: vi.fn(), delivery: vi.fn(), write: vi.fn() }));
vi.mock("../../lib/mint-burn-flows-service", () => ({ readMintBurnWindowContext: watchdog.context }));
vi.mock("../../lib/mint-burn-supply-reconciliation", () => ({ readMintBurnSupplyReconciliation: watchdog.receipts }));
vi.mock("../cron-sentinel-rules", async (original) => ({
  ...await original<typeof import("../cron-sentinel-rules")>(), deliverOperatorAlert: watchdog.delivery,
}));
vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async (_db, key) => sourceStates.get(key) ?? null),
  setCache: vi.fn(async (_db, key, value) => { sourceStates.set(key, { value, updatedAt: 500 }); }),
  getCaches: vi.fn(async () => new Map(sourceStates)),
  setCacheIfNewer: vi.fn(async (_db, key, value, updatedAt) => {
    if (sourceStates.get(key)?.updatedAt === updatedAt) await watchdog.write();
    if ((sourceStates.get(key)?.updatedAt ?? -1) <= updatedAt) sourceStates.set(key, { value, updatedAt });
    return { written: true, skippedBecauseNewer: false };
  }),
}));

import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import { runCronSentinel, type CronSentinelOptions } from "../cron-sentinel";
import { runDailyCronSentinel } from "../cron-sentinel-daily";

const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;

const run = (mode: CronSentinelOptions["mode"], nowSec?: number, options = {}) =>
  runCronSentinel(db, { mode, nowSec, ...options });

const observation = (metadata: unknown, itemCount = 0, status = "ok") =>
  ({ status, itemCount, metadata: JSON.stringify(metadata) });
const details = (result: { metadata?: string }) => JSON.parse(result.metadata!);
const called = (mock: Mock, count = 1) => expect(mock).toHaveBeenCalledTimes(count);
const uncalled = (...mocks: Mock[]) => mocks.forEach(mock => expect(mock).not.toHaveBeenCalled());
const verdict = async (result: ReturnType<typeof run>, expected = "error") => expect((await result).status).toBe(expected);
const reserve = run.bind(null, "reserve-post-sync");
const status = run.bind(null, "status");
const runDaily = runDailyCronSentinel.bind(null, db);

describe("runCronSentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceStates.clear();
    for (const mock of Object.values(mocks)) mock.mockResolvedValue({ itemCount: 0 });
  });

  it("runs the status sources and preserves a degraded result", async () => {
    mocks.freshness.mockResolvedValue(observation({ stale: true }, 2, "degraded"));
    const result = await status(123);
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(2);
    called(mocks.freshness);
    expect(mocks.freshness).toHaveBeenCalledWith(expect.anything(), undefined, {
      operatorTelegramCreds: null,
    });
    called(mocks.digest);
    uncalled(mocks.duration);
  });

  it.each([undefined, "duration", "growth", "reconciliation"] as const)("runs daily sources and retries failed %s across modes", async (failed) => {
    const signal = new AbortController().signal;
    if (failed) mocks[failed].mockRejectedValueOnce(Error("D1 overloaded")).mockRejectedValueOnce(Error("still overloaded"));
    const result = await runDaily({
      nowSec: 789, repairRunnerEnabled: true,
      signal,
    });

    expect(result.status).toBe(failed ? "error" : "ok");
    called(mocks.growth);
    called(mocks.duration);
    expect(mocks.reconciliation).toHaveBeenCalledWith(expect.anything(), {
      nowSec: 789, signal, operatorTelegramCreds: null,
    });
    expect(mocks.repair).toHaveBeenCalledWith(expect.anything(), {
      nowSec: 789,
      signal, enabled: true,
    });
    if (!failed) return;
    for (const [at, calls, status] of [[1688, 1, "error"], [1689, 2, "error"], [1690, 2, "error"], [2589, 3, "ok"], [2590, 3, "ok"]] as const) {
      const mode = at === 1689 ? "turnover" : at === 2589 ? "reserve-post-sync" : "status";
      const retry = await run(mode, at, { repairRunnerEnabled: true, signal });
      expect(retry.status).toBe(status);
      called(mocks[failed], calls);
      const source = failed === "reconciliation" ? "supply-reconciliation" : failed;
      expect(details(retry).sources[source]).toMatchObject({
        intervalSec: 86400, maxAgeSec: 172800,
        attempt: { count: calls, attemptedAt: calls === 1 ? 789 : calls === 2 ? 1689 : 2589 },
      });
    }
  });

  it.each(["status", "turnover", "reserve-post-sync"] as const)("keeps writing repairs out of %s replays", async (mode) => {
    mocks.repair.mockRejectedValueOnce(Error("repair read failed"));
    await runDaily({ nowSec: 100, repairRunnerEnabled: true });
    const result = await run(mode, 1000, { repairRunnerEnabled: true });
    called(mocks.repair);
    expect(result.status).toBe("error");
    expect(details(result).sources["repair-debt"]).toMatchObject({
      status: "error", reason: "source-evaluation-error", observedAt: 100, attempt: { count: 1 },
    });
    expect(details(result).sources["repair-debt"].nextRetryAt).toBeUndefined();
    const daily = await runDaily({ nowSec: 86_500, repairRunnerEnabled: true });
    expect(details(daily).sources["repair-debt"].status).toBe("ok");
    called(mocks.repair, 2);
  });

  it.each([
    ["turnover", "turnover"],
    ["reserve-post-sync", "reserve"],
  ] as const)("runs only the %s producer-adjacent source", async (mode, mockName) => {
    const result = await run(mode);
    expect(result.status).toBe("ok");
    called(mocks[mockName]);
    uncalled(mocks.freshness, mocks.duration);
  });
  it("keeps the freshness canary, PSI and probe rule ids in the sentinel metadata", async () => {
    mocks.freshness.mockResolvedValueOnce(observation({
      firedRuleIds: ["canary-finding", "probe-path-persistent-failure", "psi-daily-coverage"],
    }, 3, "degraded"));
    const result = await status(300);
    const metadata = details(result);
    expect(metadata.firedRuleIds?.freshness).toEqual([
      "canary-finding", "probe-path-persistent-failure", "psi-daily-coverage",
    ]);
  });
  it("lifts a reserve source quality finding into the sentinel run summary", async () => {
    const reason = "reserve-score-ineligible-sustained:iusd-infinifi";
    mocks.reserve.mockResolvedValueOnce(observation({
      firedRuleIds: ["reserve-score-ineligible-sustained"], quality: { reasons: [reason] },
    }, 1));
    const result = await reserve(500);
    expect(result.status).toBe("ok");
    const metadata = details(result);
    expect(metadata.quality).toEqual({
      reason: "sentinel-source-findings",
      sources: { "reserve-post-sync": { reasons: [reason] } },
    });
    expect(getCronQualityReasons(metadata)).toEqual([
      "sentinel-source-findings", `reserve-post-sync:${reason}`,
    ]);
    const retained = await status(600);
    expect(retained.status).toBe("ok");
    expect(details(retained).quality).toEqual(metadata.quality);
  });

  it("retains the distinct supply reconciliation findings across sentinel modes", async () => {
    const rules = ["mint-burn-unexplained-residual", "mint-burn-review-suppression"];
    mocks.reconciliation.mockResolvedValueOnce(observation({ quality: { reasons: rules }, firedRuleIds: rules }, 2));
    const daily = await runDaily({ nowSec: 500 });
    expect(daily.status).toBe("ok");
    const retained = await status(600);
    expect(details(retained).firedRuleIds["supply-reconciliation"]).toEqual(rules);
  });

  it("persists thrown source errors and rejects an older successful overwrite", async () => {
    mocks.reserve.mockRejectedValueOnce(new Error("reserve evaluation failed"));
    await verdict(reserve(200));
    await verdict(reserve(100));
    await verdict(status(300));
    await verdict(reserve(400), "ok");
  });

  it.each([null, -1801, 0, "failed", "getter", "wrapped", "write"] as const)("holds only in-age retriable failures (%s)", async (prior) => {
    if (prior !== null) await status(typeof prior === "number" ? prior : 0);
    const error = prior === "failed" || prior === "getter" ? "failed" : "D1 DB is overloaded";
    const thrown = prior === "wrapped" ? Object.assign(Error("query failed"), { cause: Error(error) }) : Error(error);
    if (prior === "getter") Object.defineProperty(thrown, "cause", { get() { throw Error(); } });
    mocks.digest.mockRejectedValue(thrown);
    if (prior === "write") watchdog.write.mockRejectedValueOnce(Error());
    for (const at of [919, 920]) {
      const failed = await status(at);
      expect(failed).toMatchObject({ status: "error", metadata: expect.stringContaining(thrown.message) });
      expect(details(failed).reason).toBe("status:digest-publication:error");
      if (prior === "write" && at === 919)
        expect(failed.metadata).toContain("attempt metadata not stored");
    }
    const held = prior === 0 || prior === "wrapped" || prior === "write";
    const next = await reserve(1305);
    expect(next.status).toBe(held ? "ok" : "error");
    expect(details(next).sources["digest-publication"]).toMatchObject({
      observedAt: held ? 0 : 920, attempt: { count: prior === "write" ? 1 : 2, attemptedAt: 920, status: "error" },
    });
    mocks.digest.mockResolvedValueOnce({ status: "skipped_locked" });
    for (const mode of ["status", "turnover", "reserve-post-sync"] as const)
      await verdict(run(mode, 1801), held ? "degraded" : "error");
    await verdict(runDaily({ nowSec: 1801 }), held ? "degraded" : "error");
    await verdict(status(1802));
    mocks.digest.mockResolvedValue({ status: "ok" });
    await verdict(status(1803), "ok");
  });

  it("propagates cancellation without erasing saved source state", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(run("status", undefined, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(sourceStates.size).toBe(0);
    uncalled(mocks.freshness);
  });

  it("keeps a first unevaluated source neutral", async () => {
    mocks.turnover.mockResolvedValueOnce({ status: "skipped_neutral" });
    await verdict(run("turnover", 200), "skipped_neutral");
  });

});

describe("daily reconciliation operator delivery", () => {
  it.each(["ok", "unavailable", "unsupported-law", "unexplained-residual", "review-suppression"])(
    "only alerts on findings, deduplicating %s", async (status) => {
      sourceStates.clear();
      watchdog.delivery.mockReset().mockResolvedValue({ ok: true });
      watchdog.context.mockResolvedValue({ diagnosticConfigs: [] });
      const activeFindings = status === "unexplained-residual" || status === "review-suppression"
        ? [{ day: 86_400, status, reason: status }] : [];
      // A later unavailable day must not hide the retained finding.
      watchdog.receipts.mockResolvedValue(new Map([["leg", { configKey: "leg", status: "unavailable", activeFindings }]]));
      const { runMintBurnReconciliationWatchdog } = await vi.importActual<typeof import("../mint-burn-reconciliation-watchdog")>("../mint-burn-reconciliation-watchdog");
      const options = { nowSec: 500, operatorTelegramCreds: { chatId: "operator", botToken: "test" } };
      const reconcile = runMintBurnReconciliationWatchdog.bind(null, db, options);
      const result = await reconcile();
      await reconcile();
      expect(result.status ?? "ok").toBe("ok");
      called(watchdog.delivery, activeFindings.length);
      if (!activeFindings.length) return;
      sourceStates.clear();
      watchdog.delivery.mockReset().mockResolvedValue({ ok: false });
      await verdict(reconcile(), "degraded");
      await reconcile();
      called(watchdog.delivery, 2);
    },
  );
});
