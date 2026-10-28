import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint, type MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { loadMintBurnCoverageGaps, repairMintBurnCoverage, COVERAGE_REPAIR_MAX_BLOCKS } from "../mint-burn/repair-coverage";
import { createMintBurnConfigSummary, syncMintBurnConfig } from "../mint-burn/sync-config";
import type { runMintBurnConfigPhase } from "../mint-burn/run-configs";

import type * as SyncConfigModule from "../mint-burn/sync-config";
import type * as ConservationModule from "../../lib/mint-burn-conservation";
vi.mock("../mint-burn/sync-config", async (importOriginal) => ({
  ...await importOriginal<typeof SyncConfigModule>(), syncMintBurnConfig: vi.fn(),
}));
vi.mock("../../lib/mint-burn-conservation", async (importOriginal) => ({
  ...await importOriginal<typeof ConservationModule>(),
  fetchConservationBoundaries: vi.fn(async () => new Map()),
}));
const fixtures = createLatestSchemaFixtureTracker();
const now = Date.parse("2026-10-20T20:00:00Z") / 1000;
const config = makeMintBurnConfig({ asset: { startBlock: 100 } });
const key = mintBurnConfigKey(config);
function proof(fromBlock: number, toBlock: number, overrides: Partial<MintBurnScanCoverage> = {}): MintBurnScanCoverage {
  return { configKey: key, configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
    fromBlock, toBlock, fromTimestamp: now - 3600, toTimestamp: now - 60, finalizedBlock: 100_000,
    acceptedAt: now, ...overrides };
}
async function commit(db: D1Database, p: MintBurnScanCoverage) {
  await upsertMintBurnSyncState(db, p.configKey, p.toBlock, "monotonic-max", p);
}
function input(db: D1Database): Parameters<typeof runMintBurnConfigPhase>[0] {
  return { db, configs: [config], lane: "critical", jobName: "sync-mint-burn", budget: { limit: 200, count: 160 },
    chainContexts: new Map([[config.chain.chainId, { chainId: config.chain.chainId, chainHead: 100_000,
      rpcEndpoints: [], endpointHeads: new Map(), chainTimestampCache: new Map(), txContextCache: new Map() }]]),
    runTimestamp: now, priceContext: { priceObservations: new Map(), priceHistory: new Map() },
    lastBlocksAfterRun: new Map([[key, 300]]), pendingCursorUpdates: new Map(), pendingScanCoverage: new Map(),
    maxScanRange: 50_000, criticalConfigBudgetLimit: 60, extendedConfigBudgetLimit: 25, affectedHours: new Map(),
    deadlineMs: Date.now() + 60_000 };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
  vi.mocked(syncMintBurnConfig).mockReset().mockImplementation(async (request) => ({
    summary: { ...createMintBurnConfigSummary(request.config, request.key, request.tier), requestBudgetUsed: 4 },
    apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
    newLastBlock: request.scanTo, scanCoverage: proof(request.fromBlock, request.scanTo),
  }));
});
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

describe("bounded scanner coverage repair", () => {
  it("finds internal and tail holes without inheriting old-fingerprint proof", async () => {
    const { db } = fixtures.open();
    await commit(db, proof(100, 300, { configFingerprint: "old" }));
    await commit(db, proof(100, 110));
    await commit(db, proof(121, 200));
    const cursors = new Map([[key, 300]]);
    expect(await loadMintBurnCoverageGaps(db, [config], cursors, now)).toEqual([{ config, fromBlock: 111, toBlock: 120 }]);
    await commit(db, proof(111, 120));
    expect(await loadMintBurnCoverageGaps(db, [config], cursors, now)).toEqual([{ config, fromBlock: 201, toBlock: 300 }]);
  });
  it("finds leading holes and bounds replay to retained raw hours and block chunks", async () => {
    const { db } = fixtures.open();
    await commit(db, proof(100, 90_000, { configFingerprint: "old" }));
    await commit(db, proof(80_000, 90_000));
    expect(await loadMintBurnCoverageGaps(db, [config], new Map([[key, 90_000]]), now))
      .toEqual([{ config, fromBlock: 100, toBlock: 100 + COVERAGE_REPAIR_MAX_BLOCKS - 1 }]);
    expect(await loadMintBurnCoverageGaps(db, [config], new Map([[key, 90_000]]), now + 9 * 86_400)).toEqual([]);
  });
  it("never manufactures historical proof from a cursor with no ledger", async () => {
    const { db } = fixtures.open();
    expect(await loadMintBurnCoverageGaps(db, [config], new Map([[key, 300]]), now)).toEqual([]);
  });
  it("stages a genuine repair then commits monotonically behind the live cursor", async () => {
    const { db, sqlite } = fixtures.open();
    await commit(db, proof(100, 110));
    await commit(db, proof(121, 300));
    const request = input(db);
    const proofs: MintBurnScanCoverage[] = [];
    const summaries = await repairMintBurnCoverage(request, [{ config, fromBlock: 111, toBlock: 120 }], proofs, new Map());
    expect(summaries[0]?.repairReason).toBe("proof-staged");
    expect(request.pendingCursorUpdates.size).toBe(0);
    expect(request.lastBlocksAfterRun.get(key)).toBe(300);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage").get()).toEqual({ count: 2 });
    await commit(db, proofs[0]!);
    expect(sqlite.prepare("SELECT from_block, to_block FROM mint_burn_scan_coverage").all())
      .toEqual([{ from_block: 100, to_block: 300 }]);
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state").get()).toEqual({ last_block: 300 });
  });
  it.each(["unproved", "throw"])("keeps failed repair %s unproved with a machine-readable reason", async (failure) => {
    const { db } = fixtures.open();
    if (failure === "throw") vi.mocked(syncMintBurnConfig).mockRejectedValue(new Error("provider unavailable"));
    else vi.mocked(syncMintBurnConfig).mockImplementation(async (request) => ({
      summary: createMintBurnConfigSummary(config, key, request.tier), apiErrors: 1, effectiveBurns: 0,
      bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: null,
    }));
    const proofs: MintBurnScanCoverage[] = [];
    const request = input(db);
    const summaries = await repairMintBurnCoverage(request, [{ config, fromBlock: 111, toBlock: 120 }], proofs, new Map());
    expect(proofs).toEqual([]);
    expect(summaries[0]?.repairReason).toBe(failure === "throw" ? "repair-scan-failed" : "scan-coverage-unproven");
    if (failure === "throw") expect(request.budget.count).toBe(185);
  });
  it("caps configs, shared requests, and the wall-time window", async () => {
    const { db } = fixtures.open();
    const gaps = Array.from({ length: 8 }, (_, i) => ({ config, fromBlock: 111 + i * 10, toBlock: 120 + i * 10 }));
    await repairMintBurnCoverage(input(db), gaps, [], new Map());
    expect(syncMintBurnConfig).toHaveBeenCalledTimes(4);
    vi.mocked(syncMintBurnConfig).mockClear();
    const request = input(db);
    request.budget.count = 199;
    expect((await repairMintBurnCoverage(request, gaps, [], new Map()))[0]?.repairReason).toBe("repair-budget-exhausted");
    expect(syncMintBurnConfig).not.toHaveBeenCalled();
    request.budget.count = 160;
    request.deadlineMs = Date.now() + 4_000;
    expect((await repairMintBurnCoverage(request, gaps, [], new Map()))[0]?.repairReason).toBe("repair-runtime-exhausted");
    expect(syncMintBurnConfig).not.toHaveBeenCalled();
  });
  it("charges expensive replays to the shared 40-request reserve and rotates failures", async () => {
    const { db } = fixtures.open();
    vi.mocked(syncMintBurnConfig).mockImplementation(async (request) => ({
      summary: { ...createMintBurnConfigSummary(config, key, request.tier), requestBudgetUsed: request.configBudgetLimit },
      apiErrors: 1, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: null,
    }));
    const gaps = Array.from({ length: 5 }, (_, i) => ({ config, fromBlock: 111 + i * 10, toBlock: 120 + i * 10 }));
    const request = input(db);
    await repairMintBurnCoverage(request, gaps, [], new Map());
    expect(request.budget.count).toBe(200);
    expect(vi.mocked(syncMintBurnConfig).mock.calls.map(([scan]) => scan.configBudgetLimit)).toEqual([25, 15]);
    const firstStart = vi.mocked(syncMintBurnConfig).mock.calls[0]![0].fromBlock;
    vi.mocked(syncMintBurnConfig).mockClear();
    await repairMintBurnCoverage({ ...input(db), runTimestamp: now + 1800 }, gaps, [], new Map());
    expect(vi.mocked(syncMintBurnConfig).mock.calls[0]![0].fromBlock).not.toBe(firstStart);
  });
  it.each([330_000, 360_000])("caps pending repairs at six minutes without blocking admitted repairs (%i ms)", async (elapsed) => {
    const { db } = fixtures.open();
    const pending = makeMintBurnConfig({ asset: { contractAddress: "0x0000000000000000000000000000000000000002" } });
    const pendingKey = mintBurnConfigKey(pending);
    vi.setSystemTime(now * 1000 + elapsed);
    const request = { ...input(db), pendingAdmissionKeys: new Set([pendingKey]), deadlineMs: now * 1000 + 9 * 60_000 };
    const summaries = await repairMintBurnCoverage(request, [
      { config: pending, fromBlock: 111, toBlock: 120 }, { config, fromBlock: 111, toBlock: 120 },
    ], [], new Map());
    const calls = vi.mocked(syncMintBurnConfig).mock.calls.map(([scan]) => scan);
    expect(calls.find((scan) => scan.key === key)?.deadlineMs).toBe(Date.now() + 60_000);
    if (elapsed < 360_000) {
      expect(calls.find((scan) => scan.key === pendingKey)?.deadlineMs).toBe(now * 1000 + 360_000);
    } else {
      expect(calls).toHaveLength(1);
      expect(summaries.find((summary) => summary.key === pendingKey)?.repairReason).toBe("repair-runtime-exhausted");
    }
  });
});
