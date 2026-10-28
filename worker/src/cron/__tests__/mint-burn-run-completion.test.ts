import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeMintBurnRun, type CompleteMintBurnRunInput } from "../mint-burn/run-completion";
import { createMintBurnConfigSummary, type MintBurnConfigSummary } from "../mint-burn/sync-config";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { setMintBurnRunState } from "../mint-burn/run-state";
import { getNullPriceBacklog, healNullPrices } from "../../lib/mint-burn-pipeline/price-heal";
import { sweepRecentRoundtrips } from "../../lib/mint-burn-pipeline/roundtrip-sweep";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  drainMintBurnMaterializationDebt,
  executeMintBurnMaintenanceMutations,
} from "../../lib/mint-burn-pipeline/materialization-debt";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

vi.mock("../mint-burn/run-state", () => ({
  setMintBurnRunState: vi.fn(),
}));

vi.mock("../../lib/mint-burn-pipeline/price-heal", () => ({
  getNullPriceBacklog: vi.fn(),
  healNullPrices: vi.fn(),
}));

vi.mock("../../lib/mint-burn-pipeline/roundtrip-sweep", () => ({
  sweepRecentRoundtrips: vi.fn(),
}));

function buildRunInput(overrides: { apiErrors?: number; signal?: AbortSignal } = {}): CompleteMintBurnRunInput {
  return {
    db: {} as D1Database,
    budget: { limit: 200, count: 7 },
    lane: "critical",
    jobName: "sync-mint-burn",
    chainHeads: new Map([["ethereum", 22_000_000]]),
    resumeConfigKey: null,
    enabledConfigs: [],
    configs: [],
    configsDisabled: 0,
    contractsTotal: 0,
    lastBlocksAfterRun: new Map(),
    runState: { degradedStreak: 0, resumeConfigKey: null },
    runStatePersistenceFailed: false,
    degradeConsecutiveThreshold: 2,
    errorConsecutiveThreshold: 3,
    criticalContractsEnabled: 0,
    phase: {
      rowsRead: 0,
      rowsParsed: 0,
      rowsInserted: 0,
      rowsIgnored: 0,
      rowsDropped: 0,
      contractsProcessed: 0,
      contractsSkipped: 0,
      contractsDeferredExtended: 0,
      runtimeBudgetHit: false,
      apiErrors: overrides.apiErrors ?? 0,
      effectiveBurns: 0,
      bridgeBurns: 0,
      reviewBurns: 0,
      atomicRoundtripsTotal: 0,
      txContextShortfalls: 0,
      bridgeClassificationDeferredRows: 0,
      criticalContractsSatisfied: 0,
      criticalContractsUnsatisfied: 0,
      configBreakdown: [],
      activeProviderDeferrals: new Map(),
    },
    attemptCoverage: {
      stateCacheKey: "mint-burn:attempt-state:sync-mint-burn",
      expectedConfigs: 0,
      attemptedThisRun: 0,
      providerDeferredThisRun: 0,
      neverAttemptedCount: 0,
      oldestAttemptAgeSec: null,
      laggingAttemptSamples: [],
      persistenceFailed: false,
    },
    coverageCycle: null,
    runDrilldown: {
      cacheKey: "mint-burn:run-detail:sync-mint-burn",
      persistenceFailed: false,
    },
    signal: overrides.signal,
  };
}

describe("completeMintBurnRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setMintBurnRunState).mockResolvedValue(true);
    vi.mocked(getNullPriceBacklog).mockResolvedValue({ recent: 0, historical: 0 });
    vi.mocked(healNullPrices).mockResolvedValue({ healed: 0, affectedHours: new Map() });
    vi.mocked(sweepRecentRoundtrips).mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });
  });

  it.each(["extended", "critical"] as const)("immediately degrades %s for one verified conservation failure", async (lane) => {
    const input = buildRunInput();
    input.lane = lane;
    input.phase.configBreakdown = [{ conservationFailure: true, conservationStatus: "mismatch",
      key: "test", failedEventDefs: [], errors: 1 } as unknown as MintBurnConfigSummary];
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("degraded");
    expect(result.metadata.conservationFailures).toBe(1);
    expect(result.metadata.apiErrors).toBe(0);
  });

  it("immediately degrades the critical lane for a validated boundary reorg", async () => {
    const input = buildRunInput();
    input.phase.configBreakdown = [{ conservationFailure: true, conservationStatus: "unavailable",
      conservationReason: "boundary-reorg", key: "test", failedEventDefs: [], errors: 1 } as unknown as MintBurnConfigSummary];
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("degraded");
    expect(result.metadata.reason).toBe("mint-burn-conservation-failure");
    expect(result.metadata.conservationFailures).toBe(1);
  });

  it.each(["extended", "critical"] as const)("keeps diagnostic-only header unavailability separate from %s collection health", async (lane) => {
    const input = buildRunInput();
    input.lane = lane;
    if (lane === "critical") {
      input.criticalContractsEnabled = 1;
      input.phase.criticalContractsSatisfied = 1;
    }
    input.phase.configBreakdown = [{ conservationFailure: false, conservationStatus: "unavailable",
      conservationReason: "invalid-boundary-header", key: "test", failedEventDefs: [], errors: 0 } as unknown as MintBurnConfigSummary];
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("ok");
    expect(result.metadata.conservationUnavailable).toBe(1);
    expect(result.metadata.conservationFailures).toBe(0);
    expect(result.metadata.reason).toBeUndefined();
    expect(result.metadata.apiErrors).toBe(0);
  });

  it.each([false, true])("retains healed source and %s rebuild failure debt without aborting completion", async (failRebuild) => {
    const { sqlite } = fixtures.open();
    const hourTs = Math.floor(Date.now() / 3_600_000) * 3600 - 7200;
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
       tx_hash, block_number, timestamp, explorer_tx_url, price_repair_status)
      VALUES ('healed', 'usdc-circle', 'USDC', 'ethereum', 'mint', 100, 101,
        'healed', 1, ?, '', 'pending_aggregate')`).run(hourTs + 1);
    sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', ?)").run(hourTs);
    sqlite.prepare(`INSERT INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_volume_usd, mint_unpriced_event_count, burn_unpriced_event_count)
      VALUES ('usdc-circle', 'ethereum', ?, 7, 0, 0)`).run(hourTs);
    const input = buildRunInput();
    input.db = createSqliteD1(sqlite, { onRun(sql) {
      if (failRebuild && sql.includes("DELETE FROM mint_burn_dirty_hours")) throw new Error("rebuild failed");
    } });
    vi.mocked(healNullPrices).mockResolvedValue({ healed: 1, affectedHours: new Map([
      ["healed", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs }],
    ]) });
    const result = await completeMintBurnRun(input);
    expect(result.metadata.nullPricesHealed).toBe(1);
    expect(sqlite.prepare("SELECT amount_usd, price_repair_status FROM mint_burn_events").get())
      .toEqual({ amount_usd: 101, price_repair_status: failRebuild ? "pending_aggregate" : "recovered" });
    expect(sqlite.prepare("SELECT mint_volume_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_volume_usd: failRebuild ? 7 : 101 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get())
      .toEqual({ count: failRebuild ? 1 : 0 });
    expect(sweepRecentRoundtrips).toHaveBeenCalled();
  });

  it("drains old non-standard debt even when both candidate maintenance stages fail", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
       tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
      VALUES ('old', 'usdc-circle', 'USDC', 'ethereum', 'mint', 100, 100,
        'old', 1, 3601, '', 'atomic_roundtrip')`).run();
    sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', 3600)").run();
    sqlite.prepare(`INSERT INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, mint_volume_usd)
      VALUES ('usdc-circle', 'ethereum', 3600, 1, 100)`).run();
    vi.mocked(healNullPrices).mockRejectedValueOnce(new Error("heal unavailable"));
    vi.mocked(sweepRecentRoundtrips).mockRejectedValueOnce(new Error("sweep unavailable"));
    await completeMintBurnRun({ ...buildRunInput(), db });
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 0, mint_volume_usd: 0 });
    expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
  });

  it.each([
    ["before", "amount"], ["after", "amount"],
    ["before", "classification"], ["after", "classification"],
  ] as const)("preserves a %s-rebuild %s mutation through an independent drain", async (boundary, kind) => {
    const { sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
       tx_hash, block_number, timestamp, explorer_tx_url)
      VALUES ('race', 'usdc-circle', 'USDC', 'ethereum', 'mint', 100, 100, 'race', 1, 3601, '')`).run();
    sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', 3600)").run();
    sqlite.prepare(`INSERT INTO mint_burn_sync_state VALUES ('race-cursor', 77)`).run();
    const mutationDb = createSqliteD1(sqlite);
    const mutate = () => executeMintBurnMaintenanceMutations(mutationDb, [{
      enqueue: mutationDb.prepare(`INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', 3600)
        ON CONFLICT (stablecoin_id, chain_id, hour_ts) DO UPDATE SET hour_ts = excluded.hour_ts
        RETURNING stablecoin_id, chain_id, hour_ts`),
      update: mutationDb.prepare(kind === "amount"
        ? "UPDATE mint_burn_events SET amount_usd = 150 WHERE id = 'race'"
        : "UPDATE mint_burn_events SET flow_type = 'atomic_roundtrip' WHERE id = 'race'"),
    }]);
    const db = createSqliteD1(sqlite);
    const batch = db.batch.bind(db);
    let interleaved = false;
    db.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
      const inject = !interleaved;
      interleaved = true;
      if (inject && boundary === "before") await mutate();
      const result = await batch<T>(statements);
      if (inject && boundary === "after") await mutate();
      return result;
    };
    const expectedVolume = kind === "amount" ? 150 : 0;
    expect(await drainMintBurnMaterializationDebt(db)).toBe(1);
    expect(sqlite.prepare("SELECT mint_volume_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_volume_usd: boundary === "before" ? expectedVolume : 100 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get())
      .toEqual({ count: boundary === "before" ? 0 : 1 });
    await drainMintBurnMaterializationDebt(db);
    expect(sqlite.prepare("SELECT mint_volume_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_volume_usd: expectedVolume });
    expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = 'race-cursor'").get())
      .toEqual({ last_block: 77 });
  });

  it("retains seeded debt across an interrupted drain and resumes without candidate work", async () => {
    const { sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
       tx_hash, block_number, timestamp, explorer_tx_url, price_repair_status)
      VALUES ('restart', 'usdc-circle', 'USDC', 'ethereum', 'mint', 10, 10,
        'restart', 1, 3601, '', 'pending_aggregate')`).run();
    const controller = new AbortController();
    const interruptedDb = createSqliteD1(sqlite, { onAll(sql) {
      if (sql.includes("FROM mint_burn_dirty_hours")) controller.abort(new Error("drain interrupted"));
    } });
    await expect(drainMintBurnMaterializationDebt(interruptedDb, { signal: controller.signal }))
      .rejects.toThrow("drain interrupted");
    expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all()).toEqual([{ hour_ts: 3600 }]);
    expect(sqlite.prepare("SELECT * FROM mint_burn_hourly").all()).toEqual([]);
    expect(await drainMintBurnMaterializationDebt(createSqliteD1(sqlite))).toBe(1);
    expect(sqlite.prepare("SELECT price_repair_status FROM mint_burn_events").get())
      .toEqual({ price_repair_status: "recovered" });
    expect(sqlite.prepare("SELECT mint_volume_usd FROM mint_burn_hourly").get()).toEqual({ mint_volume_usd: 10 });
    expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
  });

  it("does not persist run state when the run has already been aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("lease lost before completion"));

    await expect(completeMintBurnRun(buildRunInput({ signal: controller.signal })))
      .rejects.toThrow("lease lost before completion");

    expect(setMintBurnRunState).not.toHaveBeenCalled();
    expect(getNullPriceBacklog).not.toHaveBeenCalled();
    expect(healNullPrices).not.toHaveBeenCalled();
    expect(sweepRecentRoundtrips).not.toHaveBeenCalled();
  });

  it("persists a bounded summary instead of all 127 config details", async () => {
    vi.mocked(setMintBurnRunState).mockResolvedValue(true);
    vi.mocked(getNullPriceBacklog).mockResolvedValue({ recent: 0, historical: 0 });
    vi.mocked(healNullPrices).mockResolvedValue({ healed: 0, affectedHours: new Map() });
    vi.mocked(sweepRecentRoundtrips).mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });
    const input = buildRunInput();
    input.phase.configBreakdown = Array.from({ length: 127 }, (_, index) => ({
      key: `ethereum-0x${index.toString(16).padStart(40, "0")}`,
      symbol: `COIN${index}`,
      chainId: "ethereum",
      tier: "extended",
      attempted: index < 94,
      skippedReason: index < 94 ? null : "runtime-budget-exhausted",
      scanFrom: 1,
      scanTo: 2,
      advancedTo: index < 94 ? 2 : null,
      maxBlockSeen: 2,
      rowsRead: 0,
      rowsParsed: 0,
      rowsInserted: 0,
      rowsIgnored: 0,
      rowsDropped: 0,
      rowsDroppedDecode: 0,
      earliestDecodeFailureBlock: null,
      errors: 0,
      failedEventDefs: [],
      eventCoverage: [],
      coverageFrontier: 2,
      advanceReason: index < 94 ? "full-success-empty" : "no-safe-frontier",
      missingTimestampCount: 0,
      earliestMissingTimestampBlock: null,
      txContextShortfalls: 0,
      bridgeClassificationDeferredRows: 0,
      requestBudgetLimit: 25,
      requestBudgetUsed: index < 94 ? 1 : 0,
    } satisfies MintBurnConfigSummary));
    input.attemptCoverage = {
      ...input.attemptCoverage,
      expectedConfigs: 127,
      attemptedThisRun: 94,
      neverAttemptedCount: 33,
    };

    const result = await completeMintBurnRun(input);
    const serialized = JSON.stringify(result.metadata);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(64 * 1024);
    expect(result.metadata).not.toHaveProperty("configBreakdown");
    expect(result.metadata.configBreakdownSummary).toMatchObject({ total: 127, attempted: 94, skipped: 33 });
    expect(result.metadata.configSamples).toHaveLength(12);
    expect(result.metadata.runDrilldownCacheKey).toBe("mint-burn:run-detail:sync-mint-burn");
  });

  it("escalates critical failures and resets the streak on recovery", async () => {
    const input = buildRunInput({ apiErrors: 2 });
    expect((await completeMintBurnRun(input)).status).toBe("ok");
    input.runState.degradedStreak = 1;
    expect((await completeMintBurnRun(input)).status).toBe("degraded");
    input.runState.degradedStreak = 2;
    vi.mocked(healNullPrices).mockClear();
    vi.mocked(sweepRecentRoundtrips).mockClear();
    expect((await completeMintBurnRun(input)).status).toBe("error");
    expect(healNullPrices).not.toHaveBeenCalled();
    expect(sweepRecentRoundtrips).not.toHaveBeenCalled();
    input.phase.apiErrors = 0;
    expect((await completeMintBurnRun(input)).status).toBe("ok");
    expect(setMintBurnRunState).toHaveBeenLastCalledWith(input.db, input.jobName, 0, null);
  });

  it.each(["critical", "extended"] as const)("keeps pending findings visible without escalating %s publication health", async (lane) => {
    const input = buildRunInput({ apiErrors: 3 });
    const admitted = makeMintBurnConfig({ asset: { startBlock: 1, tier: "critical" } });
    const pending = makeMintBurnConfig({ chain: { chainId: "synthetic-pending" },
      asset: { stablecoinId: "synthetic-coin", startBlock: 1, tier: "critical" } });
    const admittedKey = mintBurnConfigKey(admitted);
    const pendingKey = mintBurnConfigKey(pending);
    input.lane = lane;
    input.configs = [admitted, pending];
    input.enabledConfigs = input.configs;
    input.pendingAdmissionKeys = new Set([pendingKey]);
    input.criticalContractsEnabled = 1;
    input.phase.criticalContractsSatisfied = 1;
    input.phase.admittedApiErrors = 0;
    input.phase.rowsInserted = 7;
    input.phase.configBreakdown = [
      { ...createMintBurnConfigSummary(admitted, admittedKey, "critical"), skippedReason: "up-to-date" },
      { ...createMintBurnConfigSummary(pending, pendingKey, "critical"), attempted: true, rowsInserted: 7,
        errors: 3, advanceReason: "scan-coverage-unproven", conservationFailure: true, conservationStatus: "mismatch" },
    ];
    input.runState.degradedStreak = 2;

    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("ok");
    expect(result.metadata).toMatchObject({
      apiErrors: 3, admittedApiErrors: 0,
      conservationFailures: 1, admittedConservationFailures: 0,
      scanCoverageUnproven: 1, admittedScanCoverageUnproven: 0,
      finality: { unavailableChains: ["synthetic-pending"] }, admittedFinalityUnavailableChains: [],
      degradedSignal: false, degradedStreak: 0, outputPublishedAt: null,
    });
    expect(result.metadata.configSamples).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: pendingKey, admissionStatus: "pending-admission", errors: 3 }),
    ]));
    expect(setMintBurnRunState).toHaveBeenLastCalledWith(input.db, input.jobName, 0, null);

    input.pendingAdmissionKeys = new Set();
    input.phase.admittedApiErrors = 3;
    const admittedFailure = await completeMintBurnRun(input);
    expect(admittedFailure.status).toBe(lane === "critical" ? "error" : "degraded");
    expect(admittedFailure.metadata).toMatchObject({
      admittedApiErrors: 3, admittedConservationFailures: 1, admittedScanCoverageUnproven: 1,
      admittedFinalityUnavailableChains: ["synthetic-pending"], degradedSignal: true, degradedStreak: 3,
      reason: "mint-burn-conservation-failure",
    });
  });

  it("keeps extended failures degraded at the critical error threshold", async () => {
    const input = buildRunInput({ apiErrors: 2 });
    input.lane = "extended";
    input.runState.degradedStreak = 2;
    expect((await completeMintBurnRun(input)).status).toBe("degraded");
  });

  it("keeps a rotated extended pass inside its window non-degraded", async () => {
    const input = buildRunInput();
    input.lane = "extended";
    input.coverageCycle = {
      status: "cycle-in-progress",
      expectedWindowSec: 7_200,
      coverageCycleSec: null,
      cycleElapsedSec: 1_800,
      lastCompletedAt: null,
      incompleteConfigs: 89,
      providerDeferredConfigs: 0,
    };
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("ok");
    expect(result.metadata.degradedSignal).toBe(false);
    expect(result.metadata.coverageCycle).toMatchObject({
      status: "cycle-in-progress",
      coverageCycleSec: null,
    });
  });

  it("does not degrade a completed pass for a config older than 75 minutes", async () => {
    const input = buildRunInput();
    input.lane = "extended";
    input.attemptCoverage = { ...input.attemptCoverage, oldestAttemptAgeSec: 75 * 60 + 60 };
    input.coverageCycle = {
      status: "complete",
      expectedWindowSec: 7_200,
      coverageCycleSec: 5_400,
      cycleElapsedSec: 1_800,
      lastCompletedAt: 1_790_000_000,
      incompleteConfigs: 89,
      providerDeferredConfigs: 0,
    };
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("ok");
    expect(result.metadata.coverageCycle).toMatchObject({ coverageCycleSec: 5_400 });
  });

  it("degrades the extended lane when a full pass misses the window", async () => {
    const input = buildRunInput();
    input.lane = "extended";
    input.coverageCycle = {
      status: "stalled",
      expectedWindowSec: 7_200,
      coverageCycleSec: 5_400,
      cycleElapsedSec: 7_260,
      lastCompletedAt: 1_790_000_000,
      incompleteConfigs: 88,
      providerDeferredConfigs: 0,
    };
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("degraded");
    expect(result.metadata.degradedSignal).toBe(true);
    expect(result.metadata.reason).toBe("mint-burn-coverage-cycle-stalled");
    expect(result.metadata.coverageCycle).toMatchObject({
      status: "stalled",
      coverageCycleSec: 5_400,
      expectedWindowSec: 7_200,
    });
  });

  it("still degrades an in-window extended pass for a genuinely failing config", async () => {
    const input = buildRunInput({ apiErrors: 2 });
    input.lane = "extended";
    input.runState.degradedStreak = 1;
    input.coverageCycle = {
      status: "cycle-in-progress",
      expectedWindowSec: 7_200,
      coverageCycleSec: null,
      cycleElapsedSec: 1_800,
      lastCompletedAt: null,
      incompleteConfigs: 89,
      providerDeferredConfigs: 0,
    };
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("degraded");
    expect(result.metadata.degradedSignal).toBe(true);
    expect(result.metadata.reason).toBe("mint-burn-source-coverage-degraded");
  });

  it("publishes no coverage cycle for the critical lane", async () => {
    const result = await completeMintBurnRun(buildRunInput());
    expect(result.status).toBe("ok");
    expect(result.metadata).not.toHaveProperty("coverageCycle");
  });

  it("degrades healthy completion for each failed persistence surface", async () => {
    for (const surface of ["state", "attempt", "drilldown"] as const) {
      const input = buildRunInput();
      vi.mocked(setMintBurnRunState).mockResolvedValue(surface !== "state");
      input.attemptCoverage.persistenceFailed = surface === "attempt";
      input.runDrilldown.persistenceFailed = surface === "drilldown";
      expect((await completeMintBurnRun(input)).status, surface).toBe("degraded");
    }
  });

  it("continues roundtrip maintenance after a recoverable healer failure", async () => {
    vi.mocked(healNullPrices).mockRejectedValueOnce(new Error("healer unavailable"));
    vi.mocked(sweepRecentRoundtrips).mockResolvedValueOnce({ reclassified: 7, affectedHours: new Map(), saturated: false });
    const result = await completeMintBurnRun(buildRunInput());
    expect(result.status).toBe("ok");
    expect(result.metadata.roundtripSweepCount).toBe(7);
  });

  it("degrades explicitly but completes maintenance when backlog metadata is unavailable", async () => {
    vi.useFakeTimers();
    vi.mocked(getNullPriceBacklog).mockRejectedValue(
      new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."),
    );
    vi.mocked(sweepRecentRoundtrips).mockResolvedValueOnce({
      reclassified: 4,
      affectedHours: new Map(),
      saturated: false,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const pending = completeMintBurnRun(buildRunInput());
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.status).toBe("degraded");
      expect(result.metadata).toMatchObject({
        nullPriceBacklog: null,
        nullPriceBacklogRecent: null,
        nullPriceBacklogHistorical: null,
        nullPriceBacklogAvailable: false,
        nullPriceBacklogError: "D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
        roundtripSweepCount: 4,
      });
      expect(getNullPriceBacklog).toHaveBeenCalledTimes(4);
      expect(healNullPrices).toHaveBeenCalledOnce();
      expect(sweepRecentRoundtrips).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("sync-mint-burn.null-price-backlog-query-failed"),
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
