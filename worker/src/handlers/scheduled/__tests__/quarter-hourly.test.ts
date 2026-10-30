import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { createScheduledRuntimeContext } from "../context";
import type { ScheduledRuntimeContext } from "../context";
import { makeScheduledEnv, makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({
  syncFxRates: vi.fn(),
  syncStablecoins: vi.fn(),
  syncYieldSupplemental: vi.fn(),
  snapshotSupply: vi.fn(),
  snapshotChainSupply: vi.fn(),
  snapshotPsiDaily: vi.fn(),
  snapshotPublicDataset: vi.fn(),
}));

vi.mock("../../../cron/sync-fx-rates", () => ({ syncFxRates: mocks.syncFxRates }));
vi.mock("../../../cron/sync-stablecoins", () => ({ syncStablecoins: mocks.syncStablecoins }));
vi.mock("../../../cron/sync-yield-supplemental", () => ({ syncYieldSupplemental: mocks.syncYieldSupplemental }));
vi.mock("../../../cron/snapshot-supply", () => ({ snapshotSupply: mocks.snapshotSupply }));
vi.mock("../../../cron/snapshot-chain-supply", () => ({ snapshotChainSupply: mocks.snapshotChainSupply }));
vi.mock("../../../cron/snapshot-psi", () => ({ snapshotPsiDaily: mocks.snapshotPsiDaily }));
vi.mock("../../../cron/snapshot-public-dataset", () => ({ snapshotPublicDataset: mocks.snapshotPublicDataset }));
vi.mock("../preflight-skip", () => ({ logSkippedCronRun: vi.fn(async () => undefined) }));

import { runQuarterHourlySlot, AAVE_TAIL_TOTAL_BUDGET_MS, QUARTER_HOURLY_SNAPSHOT_RESERVE_MS, AAVE_TAIL_DEFERRED_REASON } from "../quarter-hourly";
import { logSkippedCronRun } from "../preflight-skip";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { buildYieldSupplementalFamilyCache, getYieldSupplementalFamilyCacheKey, getYieldSupplementalRunOutcomeCacheKey } from "../../../cron/yield-sync/cache";
import { createSlotDeadline } from "../../../lib/cron-timeouts";
import * as rpc from "../../../cron/yield-sync/sources-rpc";
import type * as SupplementalModule from "../../../cron/sync-yield-supplemental";

const fixtures = createLatestSchemaFixtureTracker();

interface SnapshotPresence {
  psi: boolean;
  publicDataset: boolean;
}

const DAY_START = 1_790_035_200; // 2026-09-22T00:00:00Z
const SLOT_0700 = DAY_START + 7 * 3600;
const SLOT_0800 = DAY_START + CRON_SCHEDULE_CADENCES.daily0800Utc.offsetSec;
const SLOT_0900 = DAY_START + 9 * 3600;

function runtime(
  order: string[],
  presence: SnapshotPresence = { psi: true, publicDataset: true },
  slotStartedAt = SLOT_0900,
): ScheduledRuntimeContext {
  const signal = new AbortController().signal;
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => ({
          present: sql.includes("stability_index")
            ? Number(presence.psi)
            : Number(presence.publicDataset),
        }),
      }),
    }),
  } as unknown as D1Database;
  return makeScheduledRuntime({
    db,
    scheduleKey: "quarterHourly",
    cron: "0 * * * *",
    slotStartedAt,
    runLeasedCron: vi.fn(async (job, fn) => {
      order.push(job);
      return fn(signal, vi.fn());
    }),
  });
}

describe("runQuarterHourlySlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncFxRates.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.syncYieldSupplemental.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotSupply.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotChainSupply.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotPsiDaily.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.snapshotPublicDataset.mockResolvedValue({ status: "ok", itemCount: 1 });
  });

  afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([true, false])("forwards native capability into supply only when admitted: %s", async admitted => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "degraded", itemCount: 0, metadata: JSON.stringify({ downstreamSafe: false }),
    });
    const value = runtime([]);
    const capability = admitted ? createDwellirNativeCapability("native-test-key-placeholder") : undefined;
    value.dwellirNative = capability;
    await runQuarterHourlySlot(value);
    expect(mocks.syncStablecoins.mock.calls[0]?.[2]?.dwellirNative).toBe(capability);
  });

  it("defers Aave without a lease when the full allowance would consume snapshot headroom", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT_0700 * 1000);
    const value = runtime([], { psi: false, publicDataset: false }, SLOT_0700);
    value.deadline = createSlotDeadline(Date.now(), Date.now() + QUARTER_HOURLY_SNAPSHOT_RESERVE_MS);
    mocks.syncStablecoins.mockResolvedValue({
      status: "ok", metadata: JSON.stringify({ capabilities: { stablecoinsCache: true } }),
    });
    const summary = await runQuarterHourlySlot(value);
    expect(summary.jobs.find(({ job }) => job === "sync-yield-supplemental")).toMatchObject({
      outcome: "skipped", neutral: true, reason: AAVE_TAIL_DEFERRED_REASON,
    });
    expect(mocks.syncYieldSupplemental).not.toHaveBeenCalled();
    expect(vi.mocked(value.runLeasedCron).mock.calls.map(([job]) => job)).not.toContain("sync-yield-supplemental");
    expect(mocks.snapshotSupply).toHaveBeenCalledOnce();
    expect(mocks.snapshotChainSupply).toHaveBeenCalledOnce();
  });

  it("bounds a pre-RPC D1 stall under the real lease runtime and retries without late writes", async () => {
    // This one regression bypasses the suite's hoisted runner mock.
    const actual = await vi.importActual<typeof SupplementalModule>(
      "../../../cron/sync-yield-supplemental",
    );
    const fetchAave = vi.spyOn(rpc, "fetchAaveV3SupplyRates").mockResolvedValue({
      results: [], telemetry: rpc.createOptionalRpcFamilyTelemetry(0),
    });
    vi.useFakeTimers();
    const entryMs = SLOT_0700 * 1000;
    vi.setSystemTime(entryMs);
    const { db, sqlite } = fixtures.open();
    const aaveKey = getYieldSupplementalFamilyCacheKey("aaveV3");
    const previousAt = SLOT_0700 - 14_400;
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(aaveKey, buildYieldSupplementalFamilyCache([], previousAt), previousAt);
    let releaseRead!: () => void;
    const stalled = new Promise<void>((resolve) => { releaseRead = resolve; });
    const prepare = db.prepare.bind(db);
    let outcomeReads = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("SELECT key, value, updated_at FROM cache WHERE key IN")) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...args) => {
          const bound = bind(...args);
          if (args.includes(getYieldSupplementalRunOutcomeCacheKey())) {
            const all = bound.all.bind(bound);
            vi.spyOn(bound, "all").mockImplementation(async () => {
              outcomeReads++;
              await stalled;
              return all();
            });
          }
          return bound;
        });
      }
      return statement;
    });
    const retained: Promise<unknown>[] = [];
    const ctx = { waitUntil: (work: Promise<unknown>) => { retained.push(work); } } as ExecutionContext;
    const value = createScheduledRuntimeContext(makeScheduledEnv({ DB: db }), ctx, {
      cron: "0 * * * *", scheduleKey: "quarterHourly", scheduledTimeMs: entryMs,
      slotStartedAt: SLOT_0700, deadline: createSlotDeadline(entryMs),
    });
    mocks.syncStablecoins.mockImplementationOnce(async () => {
      // Leave exactly the complete Aave allowance plus the snapshot reserve.
      vi.setSystemTime(value.deadline.latestAdmissionMs(AAVE_TAIL_TOTAL_BUDGET_MS, QUARTER_HOURLY_SNAPSHOT_RESERVE_MS));
      return { status: "ok", metadata: JSON.stringify({ capabilities: { stablecoinsCache: true } }) };
    });
    mocks.syncYieldSupplemental.mockImplementationOnce(actual.syncYieldSupplemental);
    const snapshotBudgets: number[] = [];
    mocks.snapshotSupply.mockImplementationOnce(async () => {
      snapshotBudgets.push(value.deadline.remainingMs());
      return { status: "ok" };
    });
    mocks.snapshotChainSupply.mockImplementationOnce(async () => {
      snapshotBudgets.push(value.deadline.remainingMs());
      return { status: "ok" };
    });
    const pending = runQuarterHourlySlot(value);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomeReads).toBe(1);
    await vi.advanceTimersByTimeAsync(AAVE_TAIL_TOTAL_BUDGET_MS);
    const summary = await pending;
    expect(summary.jobs.find(({ job }) => job === "sync-yield-supplemental")).toMatchObject({
      outcome: "degraded", reason: AAVE_TAIL_DEFERRED_REASON,
    });
    expect(snapshotBudgets).toEqual([QUARTER_HOURLY_SNAPSHOT_RESERVE_MS, QUARTER_HOURLY_SNAPSHOT_RESERVE_MS]);
    expect(value.fetchBudget?.snapshot().allocated).toBe(3);
    expect(fetchAave).not.toHaveBeenCalled();
    const lease = sqlite.prepare("SELECT lease_until FROM cron_leases WHERE job = 'sync-yield-supplemental'").get();
    expect(lease).toBeDefined();
    expect(sqlite.prepare("SELECT status FROM cron_runs WHERE job = 'sync-yield-supplemental'").get())
      .toMatchObject({ status: "error" });
    releaseRead();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(retained);
    expect(fetchAave).not.toHaveBeenCalled();
    expect(value.fetchBudget?.snapshot().allocated).toBe(0);
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?").get(aaveKey))
      .toEqual({ updated_at: previousAt });
    expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(getYieldSupplementalRunOutcomeCacheKey()))
      .toBeUndefined();
    // A later natural producer can retry after the retained lease expires.
    vi.setSystemTime((Number(lease!.lease_until) + 1) * 1000);
    const next = createScheduledRuntimeContext(makeScheduledEnv({ DB: db }), ctx, {
      cron: "15 * * * *", scheduleKey: "quarterHourly", scheduledTimeMs: Date.now(),
      slotStartedAt: Math.floor(Date.now() / 1000),
    });
    await next.runLeasedCron("sync-yield-supplemental", (signal, progress) =>
      actual.syncYieldSupplemental(db, signal, next.chainRpcs, progress, {
        families: ["aaveV3"], catchUpMinMarkerAgeSec: 14_400,
      }), { deadline: createSlotDeadline(next.deadline.eventEntryMs, Date.now() + AAVE_TAIL_TOTAL_BUDGET_MS),
        deferredReason: AAVE_TAIL_DEFERRED_REASON });
    expect(outcomeReads).toBe(2);
    expect(fetchAave).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?").get(aaveKey))
      .toEqual({ updated_at: Math.floor(Date.now() / 1000) });
  });

  it("isolates Aave failure after publication and continues the snapshot chain", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "ok", metadata: JSON.stringify({ capabilities: { stablecoinsCache: true } }),
    });
    mocks.syncYieldSupplemental.mockRejectedValueOnce(new Error("Aave unavailable"));
    const order: string[] = [];
    const summary = await runQuarterHourlySlot(runtime(order));
    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins", "sync-yield-supplemental", "snapshot-supply", "snapshot-chain-supply"]);
    expect(summary.jobs.find(({ job }) => job === "sync-stablecoins")?.outcome).toBe("ok");
    expect(summary.jobs.find(({ job }) => job === "sync-yield-supplemental")?.outcome).toBe("error");
    expect(mocks.syncYieldSupplemental.mock.calls[0]?.[4]).toEqual({
      families: ["aaveV3"], catchUpMinMarkerAgeSec: 14_400,
    });
    expect(mocks.snapshotSupply).toHaveBeenCalledOnce();
  });

  it("skips all snapshot jobs when sync-stablecoins reports an unsafe cache", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ downstreamSafe: false }),
    });
    const order: string[] = [];

    const summary = await runQuarterHourlySlot(runtime(order, { psi: false, publicDataset: false }));

    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins"]);
    expect(mocks.syncYieldSupplemental).not.toHaveBeenCalled();
    expect(mocks.snapshotSupply).not.toHaveBeenCalled();
    expect(mocks.snapshotChainSupply).not.toHaveBeenCalled();
    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
    expect(summary.jobsSkipped).toBe(5);
  });

  it("keeps completed daily snapshots out of leased children even when cache-gated", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ downstreamSafe: false }),
    });
    const order: string[] = [];

    const summary = await runQuarterHourlySlot(runtime(order, { psi: true, publicDataset: true }));

    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins"]);
    expect(summary.jobsNeutralSkipped).toBe(2);
    expect(summary.jobs.filter(({ neutral }) => neutral)).toEqual([
      expect.objectContaining({ job: "snapshot-psi", reason: "same_day_snapshot_exists" }),
      expect.objectContaining({ job: "snapshot-public-dataset", reason: "same_day_snapshot_exists" }),
    ]);
    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
    const skippedJobs = vi.mocked(logSkippedCronRun).mock.calls.map(([, entry]) => entry.job);
    expect(skippedJobs).toEqual(["sync-yield-supplemental", "snapshot-supply", "snapshot-chain-supply"]);
  });

  it("records a failed due-check read as the job's error instead of treating the day as missing", async () => {
    mocks.syncStablecoins.mockResolvedValue({ status: "ok", itemCount: 1, metadata: JSON.stringify({ downstreamSafe: true, capabilities: { stablecoinsCache: true } }) });
    const order: string[] = [];
    const failingDb = {
      prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 unavailable"); } }) }),
    } as unknown as D1Database;

    const summary = await runQuarterHourlySlot({ ...runtime(order), db: failingDb });

    expect(order).toEqual(["sync-fx-rates", "sync-stablecoins", "sync-yield-supplemental", "snapshot-supply", "snapshot-chain-supply", "snapshot-psi", "snapshot-public-dataset"]);
    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
    expect(summary.jobsErrored).toBe(2);
  });

  it("retries a transient D1 overload in the same-day precheck instead of recording an error run", async () => {
    mocks.syncStablecoins.mockResolvedValue({ status: "ok", itemCount: 1, metadata: JSON.stringify({ downstreamSafe: true }) });
    const order: string[] = [];
    let psiReads = 0;
    let publicReads = 0;
    // First precheck read per job hits the transient D1 internal error seen
    // in production (cron run 2026-09-23 09:31); the retry succeeds.
    const flakyDb = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            const isPsi = sql.includes("stability_index");
            if (isPsi ? psiReads++ === 0 : publicReads++ === 0) {
              throw new Error("D1_ERROR: internal error; reference = fbgkvk0rf5kea3obe144noi3");
            }
            return { present: 1 };
          },
        }),
      }),
    } as unknown as D1Database;
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const summary = await runQuarterHourlySlot({ ...runtime(order), db: flakyDb });

      expect(order).toEqual([
        "sync-fx-rates",
        "sync-stablecoins",
        "sync-yield-supplemental",
        "snapshot-supply",
        "snapshot-chain-supply",
      ]);
      expect(summary.jobsErrored).toBe(0);
      expect(summary.jobsSkipped).toBe(0);
      expect(summary.jobsNeutralSkipped).toBe(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("runs snapshot jobs when sync-stablecoins writes a safe cache with depeg failures", async () => {
    mocks.syncStablecoins.mockResolvedValue({
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({
        downstreamSafe: true,
        depegErrorCount: 1,
        capabilities: { stablecoinsCache: true, depegPipeline: false },
      }),
    });

    await runQuarterHourlySlot(runtime([]));

    expect(mocks.snapshotSupply).toHaveBeenCalledOnce();
    expect(mocks.snapshotChainSupply).toHaveBeenCalledOnce();
  });

  it.each([SLOT_0800, SLOT_0900])("runs a missing daily snapshot once when due at %s, then admits no child", async (slotStartedAt) => {
    const presence = { psi: false, publicDataset: false };
    mocks.syncStablecoins.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ downstreamSafe: true }),
    });
    mocks.snapshotPsiDaily.mockImplementation(async () => {
      presence.psi = true;
      return { status: "ok", itemCount: 1 };
    });
    mocks.snapshotPublicDataset.mockImplementation(async () => {
      presence.publicDataset = true;
      return { status: "ok", itemCount: 1 };
    });

    const first = runtime([], presence, slotStartedAt);
    const second = runtime([], presence, slotStartedAt);
    await runQuarterHourlySlot(first);
    const summary = await runQuarterHourlySlot(second);

    expect(vi.mocked(first.runLeasedCron).mock.calls.filter(([job]) => (
      job === "snapshot-psi" || job === "snapshot-public-dataset"
    )).map(([job]) => job)).toEqual(["snapshot-psi", "snapshot-public-dataset"]);
    expect(vi.mocked(second.runLeasedCron).mock.calls.some(([job]) => (
      job === "snapshot-psi" || job === "snapshot-public-dataset"
    ))).toBe(false);
    expect(summary.jobsNeutralSkipped).toBe(2);

    expect(mocks.snapshotPsiDaily).toHaveBeenCalledOnce();
    expect(mocks.snapshotPsiDaily).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(AbortSignal),
      { completionReason: "same_day_catch_up", slotStartedAtSec: slotStartedAt },
    );
    expect(mocks.snapshotPublicDataset).toHaveBeenCalledOnce();
    expect(mocks.snapshotPublicDataset).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(AbortSignal),
      {
        completionReason: "same_day_catch_up",
        minStablecoinsCacheUpdatedAtSec: SLOT_0800,
        freshnessGateLabel: "daily0800Utc",
        slotStartedAtSec: slotStartedAt,
      },
    );
  });

  it("creates no snapshot leases or child writes before the preferred daily slot", async () => {
    const presence = { psi: false, publicDataset: false };
    mocks.syncStablecoins.mockResolvedValue({
      status: "ok",
      itemCount: 1,
      metadata: JSON.stringify({ downstreamSafe: true }),
    });

    const value = runtime([], presence, SLOT_0700);
    const prepare = vi.spyOn(value.db, "prepare");
    const summary = await runQuarterHourlySlot(value);

    expect(vi.mocked(value.runLeasedCron).mock.calls.map(([job]) => job)).toEqual([
      "sync-fx-rates", "sync-stablecoins", "sync-yield-supplemental", "snapshot-supply", "snapshot-chain-supply",
    ]);
    expect(prepare).not.toHaveBeenCalled();
    expect(logSkippedCronRun).not.toHaveBeenCalled();
    expect(summary.jobsNeutralSkipped).toBe(2);
    expect(summary.jobs.filter(({ neutral }) => neutral)).toEqual([
      expect.objectContaining({ job: "snapshot-psi", reason: "before_daily_slot" }),
      expect.objectContaining({ job: "snapshot-public-dataset", reason: "before_daily_slot" }),
    ]);

    expect(mocks.snapshotPsiDaily).not.toHaveBeenCalled();
    expect(mocks.snapshotPublicDataset).not.toHaveBeenCalled();
  });
});
