import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeMintBurnRun, type CompleteMintBurnRunInput } from "../mint-burn/run-completion";
import { createMintBurnConfigSummary, type MintBurnConfigSummary } from "../mint-burn/sync-config";
import type { MintBurnCoverageRepairSummary } from "../mint-burn/repair-coverage";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { mintBurnPublicationMetadata } from "../mint-burn/publication-metadata";
import { compactCronMetadataForPersistence } from "../../lib/cron-metadata-persistence";
import type { MintBurnPublication } from "@shared/types/mint-burn";
import { mintBurnConfigKey } from "../../lib/mint-burn-contract-identity";
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

  it.each([0, 3, 200])("persists provider and config evidence with a 200-leg roster (%s pending)", async (pendingCount) => {
    const input = buildRunInput();
    const configs = Array.from({ length: 200 }, (_, index) => makeMintBurnConfig({
      asset: { stablecoinId: `synthetic-${index}`, contractAddress: `0x${index.toString(16).padStart(40, "0")}` },
    }));
    input.configs = input.enabledConfigs = configs;
    input.contractsTotal = configs.length;
    input.phase.configBreakdown = configs.map((config, index) => ({
      ...createMintBurnConfigSummary(config, mintBurnConfigKey(config), "critical", {
        attempted: index < 94, scanFrom: 1, scanTo: 2, requestBudgetLimit: 25,
      }),
      skippedReason: index < 94 ? null : "runtime-budget-exhausted",
      advancedTo: index < 94 ? 2 : null, maxBlockSeen: 2, coverageFrontier: 2,
      advanceReason: index < 94 ? "full-success-empty" : "no-safe-frontier",
      requestBudgetUsed: index < 94 ? 1 : 0,
    } satisfies MintBurnConfigSummary));
    input.attemptCoverage = { ...input.attemptCoverage, expectedConfigs: 200,
      attemptedThisRun: 94, neverAttemptedCount: 106 };
    const publication: MintBurnPublication = {
      evaluatedAt: 1_793_232_000, requiredBaselineSec: 90 * 86400, freshnessBudgetSec: 3600,
      legs: configs.map((config, index) => ({
        configKey: mintBurnConfigKey(config), configFingerprint: "fingerprint".repeat(15),
        stablecoinId: config.stablecoinId, chainId: config.chain.chainId,
        status: index < pendingCount ? "pending-admission" : "admitted",
        reason: index < pendingCount ? "frontier-stale" : "legacy-grandfathered", admittedAt: null,
        baselineFrom: 1_785_456_000, baselineTo: 1_793_000_000,
        coveredSeconds: 7_544_000, frontierAgeSec: 232_000,
      })),
    };
    const completion = await completeMintBurnRun(input);
    expect(new TextEncoder().encode(JSON.stringify(completion.metadata)).byteLength).toBeLessThan(64 * 1024);
    expect(completion.metadata).not.toHaveProperty("configBreakdown");
    expect(completion.metadata).not.toHaveProperty("coverageCycle");
    expect(completion.metadata.configBreakdownSummary).toMatchObject({ total: 200, attempted: 94, skipped: 106 });
    expect(completion.metadata.configSamples).toHaveLength(12);
    expect(completion.metadata.runDrilldownCacheKey).toBe("mint-burn:run-detail:sync-mint-burn");
    const providerOutcomes = [{ provider: "alchemy", circuitSource: "alchemy", successes: 12, failures: 0 }];
    const metadata = {
      ...completion.metadata, publication: mintBurnPublicationMetadata(publication), providerOutcomes,
      schedulerMetadata: { detail: "x".repeat(4 * 1024) },
    };
    const persisted = compactCronMetadataForPersistence(JSON.stringify(metadata), undefined, "sync-mint-burn");
    expect(persisted.compacted).toBe(false);
    expect(persisted.persistedBytes).toBeLessThan(32 * 1024);
    const parsed = JSON.parse(persisted.metadata!);
    expect(parsed.providerOutcomes).toEqual(providerOutcomes);
    expect(parsed.configBreakdownSummary).toEqual(completion.metadata.configBreakdownSummary);
    expect(parsed.configSamples).toEqual(completion.metadata.configSamples);
    expect(parsed.finality).toEqual(completion.metadata.finality);
    expect(parsed.publication).toMatchObject({
      legCount: 200, admittedCount: 200 - pendingCount, pendingAdmissionCount: pendingCount,
      nonAdmittedLegCount: pendingCount,
    });
    expect(parsed.publication.legs).toHaveLength(parsed.publication.legsShown);
    expect(parsed.publication.legsShown + parsed.publication.legsOmitted).toBe(pendingCount);
    expect(parsed.publication.legs.length).toBeLessThanOrEqual(200);
    expect(parsed.publication.legs.every((leg: { status: string; reason: string; coveredSeconds: number }) =>
      leg.status === "pending-admission" && leg.reason === "frontier-stale" && leg.coveredSeconds === 7_544_000)).toBe(true);
    expect(parsed.publication.legsTruncated).toBe(pendingCount === 200);
  });

  it.each(["deadline", "context", "runtime", "budget", "unattempted", "scheduling-write",
    "live-deadline", "conservation", "repair-conservation", "reorg", "repair-rpc", "decode", "quarantine", "materialization", "api"])(
    "isolates repair debt: %s", async (kind) => {
      const input = buildRunInput();
      const config = makeMintBurnConfig();
      const live = { ...createMintBurnConfigSummary(config, "live", "critical"), scanFrom: 1, advancedTo: 2 };
      const repair: MintBurnCoverageRepairSummary = { ...live, key: "repair", attempted: true,
        advancedTo: null, errors: 1, repairReason: "scan-coverage-unproven" };
      const capacity = ["deadline", "context", "runtime", "budget", "unattempted", "scheduling-write"].includes(kind);
      input.phase.configBreakdown = [live];
      input.phase.coverageRepairs = [repair];
      if (!capacity && !kind.startsWith("repair-") && kind !== "decode" && kind !== "quarantine") {
        repair.errors = 0; repair.repairReason = "proof-committed";
      }
      if (kind.endsWith("deadline")) Object.assign(kind === "deadline" ? repair : live, {
        supplyProofStatus: "unavailable", supplyProofReason: "persisted-event-readback-deadline",
        failedEventDefs: ["range-proof:persisted-event-readback-deadline"], errors: 1,
      });
      if (kind === "context" || kind === "repair-rpc") Object.assign(repair, {
        failedEventDefs: ["tx-context:3801", "tx-context-request-not-started:3801"],
        txContextShortfalls: 3801, rpcEvidenceIncomplete: kind === "repair-rpc",
        conservationStatus: "unavailable", conservationReason: "incomplete-event-persistence-context",
      });
      if (kind === "runtime" || kind === "budget" || kind === "unattempted") {
        repair.attempted = false;
        repair.errors = 0;
        if (kind !== "unattempted") repair.repairReason = `repair-${kind}-exhausted`;
      }
      if (kind === "scheduling-write") repair.repairReason = "proof-committed";
      if (kind.includes("conservation") || kind === "reorg") Object.assign(kind === "repair-conservation" ? repair : live, {
        conservationFailure: true, conservationStatus: kind === "reorg" ? "unavailable" : "mismatch",
        conservationReason: kind === "reorg" ? "boundary-reorg" : undefined,
      });
      if (kind === "context") input.pendingAdmissionKeys = new Set([repair.key]);
      if (kind === "repair-rpc") input.phase.coverageRepairs.push({ ...repair, key: "debt", rpcEvidenceIncomplete: false });
      if (kind === "decode") repair.rowsDroppedDecode = 1;
      if (kind === "quarantine") repair.rowsQuarantinedDecode = 1;
      input.recalcFailed = kind === "materialization";
      if (kind === "api") input.phase.apiErrors = 2;
      // Recover an escalated producer; retain debt beyond the threshold.
      input.runState.degradedStreak = capacity ? 3 : 0;
      for (let run = 0; run < 5; run++) {
        const result = await completeMintBurnRun(input);
        expect(result.status).toBe(!capacity && run >= 2 ? "error" : kind === "api" && run === 0 ? "ok" : "degraded");
        expect(result.metadata.degradedSignal).toBe(!capacity);
        expect(result.metadata.degradedStreak).toBe(capacity ? 0 : run + 1);
        expect(result.metadata.outputPublishedAt != null).toBe(result.status !== "error" && !input.recalcFailed);
        expect(result.metadata.reason).toBe(result.status === "ok" ? undefined : kind.includes("conservation") || kind === "reorg"
          ? "mint-burn-conservation-failure" : input.recalcFailed ? "mint-burn-hourly-recalc-failed"
          : "mint-burn-source-coverage-degraded");
        input.runState.degradedStreak = result.metadata.degradedStreak as number;
        expect(setMintBurnRunState).toHaveBeenLastCalledWith(input.db, input.jobName, input.runState.degradedStreak, null);
      }
      if (kind === "api") {
        input.phase.apiErrors = 0;
        expect((await completeMintBurnRun(input)).status).toBe("ok");
        expect(setMintBurnRunState).toHaveBeenLastCalledWith(input.db, input.jobName, 0, null);
      }
    });

  it.each(["extended", "critical"] as const)("keeps diagnostic-only header unavailability separate from %s collection health", async (lane) => {
    const input = buildRunInput();
    input.lane = lane;
    input.chainHeads = new Map([["tron", 70_000_000]]);
    if (lane === "critical") {
      input.criticalContractsEnabled = 1;
      input.phase.criticalContractsSatisfied = 1;
    }
    input.phase.configBreakdown = [{ conservationFailure: false, conservationStatus: "unavailable",
      conservationReason: "invalid-boundary-header", supplyProofStatus: "unavailable", supplyProofReason: "audit-rpc-unavailable",
      key: "test", failedEventDefs: [], errors: 0 } as unknown as MintBurnConfigSummary];
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe("ok");
    expect(result.metadata.chainHeads).toEqual({ tron: 70_000_000 });
    expect(result.metadata.chainHead).toBeNull();
    expect(result.metadata.conservationUnavailable).toBe(1);
    expect(result.metadata.configSamples).toEqual(expect.arrayContaining([expect.objectContaining({
      supplyProofStatus: "unavailable", supplyProofReason: "audit-rpc-unavailable",
    })]));
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

  it.each(["standard", "atomic_roundtrip"])("resumes %s debt despite interrupted drain and failed maintenance", async (flowType) => {
    const { sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
       tx_hash, block_number, timestamp, explorer_tx_url, price_repair_status)
      VALUES ('restart', 'usdc-circle', 'USDC', 'ethereum', 'mint', 10, 10,
        'restart', 1, 3601, '', 'pending_aggregate')`).run();
    sqlite.prepare("UPDATE mint_burn_events SET flow_type = ?").run(flowType);
    sqlite.prepare(`INSERT INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, mint_volume_usd)
      VALUES ('usdc-circle', 'ethereum', 3600, 1, 10)`).run();
    const controller = new AbortController();
    const interruptedDb = createSqliteD1(sqlite, { onAll(sql) {
      if (sql.includes("FROM mint_burn_dirty_hours")) controller.abort(new Error("drain interrupted"));
    } });
    await expect(drainMintBurnMaterializationDebt(interruptedDb, { signal: controller.signal }))
      .rejects.toThrow("drain interrupted");
    expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all()).toEqual([{ hour_ts: 3600 }]);
    expect(sqlite.prepare("SELECT mint_volume_usd FROM mint_burn_hourly").get()).toEqual({ mint_volume_usd: 10 });
    vi.mocked(healNullPrices).mockRejectedValueOnce(new Error("heal unavailable"));
    vi.mocked(sweepRecentRoundtrips).mockRejectedValueOnce(new Error("sweep unavailable"));
    await completeMintBurnRun({ ...buildRunInput(), db: createSqliteD1(sqlite) });
    expect(sqlite.prepare("SELECT price_repair_status FROM mint_burn_events").get())
      .toEqual({ price_repair_status: "recovered" });
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: flowType === "standard" ? 1 : 0, mint_volume_usd: flowType === "standard" ? 10 : 0 });
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

  it.each([
    ["cycle-in-progress", null, 1800, 0, 0, "ok"],
    ["complete", 5400, 1800, 0, 0, "ok"],
    ["stalled", 5400, 7260, 0, 0, "degraded"],
    ["cycle-in-progress", null, 1800, 2, 1, "degraded"],
  ] as const)("judges extended %s by pass window and real failures (%#)", async (status, duration, elapsed, errors, streak, expected) => {
    const input = buildRunInput({ apiErrors: errors });
    input.lane = "extended";
    input.runState.degradedStreak = streak;
    if (status === "complete") input.attemptCoverage.oldestAttemptAgeSec = 75 * 60 + 60;
    input.coverageCycle = {
      status, expectedWindowSec: 7200, coverageCycleSec: duration,
      cycleElapsedSec: elapsed, lastCompletedAt: duration === null ? null : 1_790_000_000,
      incompleteConfigs: 89, providerDeferredConfigs: 0, stuckConfigs: [], stuckConfigCount: 0,
    };
    const result = await completeMintBurnRun(input);
    expect(result.status).toBe(expected);
    expect(result.metadata.degradedSignal).toBe(expected !== "ok");
    expect(result.metadata.reason).toBe(expected === "ok" ? undefined : status === "stalled"
      ? "mint-burn-coverage-cycle-stalled" : "mint-burn-source-coverage-degraded");
    expect(result.metadata.coverageCycle).toMatchObject(input.coverageCycle);
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
