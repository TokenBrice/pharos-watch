import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint, type MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { loadMintBurnCoverageGaps, repairMintBurnCoverage, COVERAGE_REPAIR_MAX_BLOCKS } from "../mint-burn/repair-coverage";
import { createMintBurnConfigSummary, syncMintBurnConfig } from "../mint-burn/sync-config";
import type { runMintBurnConfigPhase } from "../mint-burn/run-configs";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { fetchConservationBoundaries, mintBurnConservationFingerprint } from "../../lib/mint-burn-conservation";
import * as rpc from "../../lib/mint-burn-pipeline/rpc";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import * as abort from "../../lib/abort";
import * as cache from "../../lib/db-cache";
import { abiWord, reviewedBurnFixture } from "../../lib/__tests__/mint-burn-supply-proof.test-support";
import {
  commitMintBurnSupplyProofRepair, loadMintBurnSupplyProofRepairRanges, mintBurnSupplyProofRepairCursorKey,
  loadMintBurnSupplyProofRepairCursor,
} from "../mint-burn/repair-supply-proofs";

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
const supplyConfig = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "dai-makerdao")!;
const supplyKey = mintBurnConfigKey(supplyConfig);
const supplyCursorKey = mintBurnSupplyProofRepairCursorKey(supplyKey);
const supplyFingerprint = mintBurnConservationFingerprint(supplyConfig);
const overload = new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window");
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
  vi.spyOn(abort, "sleepWithSignal").mockImplementation(async (ms, signal) => {
    abort.throwIfAborted(signal);
    vi.setSystemTime(Date.now() + ms);
  });
  vi.mocked(fetchConservationBoundaries).mockReset().mockResolvedValue(new Map());
  vi.mocked(syncMintBurnConfig).mockReset().mockImplementation(async (request) => ({
    summary: { ...createMintBurnConfigSummary(request.config, request.key, request.tier), requestBudgetUsed: 4 },
    apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
    newLastBlock: request.scanTo, scanCoverage: proof(request.fromBlock, request.scanTo, {
      configKey: request.key, configFingerprint: mintBurnScanFingerprint(request.config), chainId: request.config.chain.chainId,
      finalizedBlock: request.chainHead,
    }),
  }));
});
afterEach(() => { vi.restoreAllMocks(); fixtures.closeAll(); vi.useRealTimers(); });

describe("bounded scanner coverage repair", () => {
  it.each(["deadline", "overload"])("converges from absent state after persistence %s, with unchanged acceptance", async (failure) => {
    const { db, sqlite } = fixtures.open();
    const first = supplyConfig.startBlock, last = first + 9999;
    const template = reviewedBurnFixture("dai-makerdao").log;
    const logs = Array.from({ length: 100 }, (_, i) => ({ ...template,
      blockNumber: `0x${(first + i * 100).toString(16)}`, blockHash: abiWord(BigInt(first + i * 100)),
      transactionHash: abiWord(BigInt(i + 1)), data: abiWord(1n) }));
    await commit(db, proof(first, last, { configKey: supplyKey,
      configFingerprint: mintBurnScanFingerprint(supplyConfig), finalizedBlock: last }));
    const scanner = (await vi.importActual<typeof SyncConfigModule>("../mint-burn/sync-config")).syncMintBurnConfig;
    vi.mocked(syncMintBurnConfig).mockImplementation(scanner);
    vi.spyOn(rpc, "fetchMintBurnLogs").mockImplementation(async (_endpoints, _address, topics, from, to) => ({
      logs: topics.some((topic) => topic.index === 2) ? logs.filter((log) => Number(log.blockNumber) >= from
        && Number(log.blockNumber) <= to) : [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    }));
    vi.spyOn(rpc, "resolveMintBurnBlockTimestamps").mockImplementation(async (_endpoints, blocks) =>
      new Map(blocks.map((block) => [block, now - 600])));
    vi.mocked(fetchConservationBoundaries).mockImplementation(async ({ requests }) => new Map(requests.map((range) =>
      [range.key, { status: "ready" as const, fromBlockHash: abiWord(BigInt(range.fromBlock - 1)),
        toBlockHash: abiWord(BigInt(range.toBlock)), fromTimestamp: now - 600, toTimestamp: now - 600,
        fromSupplyRaw: String(1000 - logs.filter((log) => Number(log.blockNumber) < range.fromBlock).length),
        toSupplyRaw: String(1000 - logs.filter((log) => Number(log.blockNumber) <= range.toBlock).length) }])));
    const batch = db.batch.bind(db);
    let exhausted = false;
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      if (exhausted && statements.length === 100) { vi.setSystemTime(now * 1000 + 61_000); throw overload; }
      const result = await batch(statements);
      vi.setSystemTime(Date.now() + statements.length * 200);
      return result;
    });
    const ranges: number[][] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      vi.setSystemTime((now + attempt * 1800) * 1000);
      exhausted = failure === "overload" && attempt === 0;
      const request = { ...input(db), deadlineMs: Date.now() + 540_000, runTimestamp: now + attempt * 1800 }, pending: MintBurnScanCoverage[] = [];
      request.chainContexts.get("ethereum")!.chainHead = last;
      const gaps = await loadMintBurnSupplyProofRepairRanges(db, [supplyConfig], new Map([[supplyKey, last]]), now);
      const [summary] = await repairMintBurnCoverage(request, gaps, pending, new Map(), { supplyProofRepair: true });
      ranges.push([summary!.scanFrom!, summary!.scanTo!]);
      expect((await loadMintBurnSupplyProofRepairCursor(db, supplyConfig)).lastBlock).toBe(attempt < 2 ? null : first + 4999);
      if (attempt === 0) {
        expect(summary?.conservationFailure).not.toBe(true);
        expect(summary?.errors).toBeGreaterThan(0);
        expect(pending).toEqual([]);
      } else {
        expect(summary?.repairReason).toBe("proof-staged");
        await recalcAffectedHours(db, request.affectedHours);
        await commitMintBurnSupplyProofRepair(db, supplyConfig, pending[0]!);
      }
    }
    expect(ranges).toEqual([[first, last], [first, first + 4999], [first + 5000, last]]);
    expect(vi.mocked(fetchConservationBoundaries).mock.calls.slice(-3).map(([call]) =>
      [call.requests[0]!.fromBlock, call.requests[0]!.toBlock])).toEqual(ranges);
    expect(await loadMintBurnSupplyProofRepairRanges(db, [supplyConfig], new Map([[supplyKey, last]]), now)).toEqual([]);
    expect((await loadMintBurnSupplyProofRepairCursor(db, supplyConfig)).maxBlocks).toBe(10_000);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM mint_burn_events e JOIN mint_burn_supply_proofs p
      ON p.proof_id = e.supply_proof_id WHERE p.lifecycle = 'accepted' AND p.status = 'proven'`).get()).toEqual({ count: 100 });
    expect(sqlite.prepare("SELECT lifecycle, COUNT(*) AS count FROM mint_burn_supply_proofs GROUP BY lifecycle ORDER BY lifecycle").all())
      .toEqual([{ lifecycle: "accepted", count: 2 }, { lifecycle: "pending", count: 1 }]);
  });
  it("finds internal and tail holes without inheriting old-fingerprint proof", async () => {
    const { db } = fixtures.open();
    expect(await loadMintBurnCoverageGaps(db, [config], new Map([[key, 300]]), now)).toEqual([]);
    await commit(db, proof(100, 300, { configFingerprint: "old" }));
    await commit(db, proof(100, 110));
    await commit(db, proof(121, 200));
    const cursors = new Map([[key, 300]]);
    expect(await loadMintBurnCoverageGaps(db, [config], cursors, now)).toEqual([{ config, fromBlock: 111, toBlock: 120 }]);
    await commit(db, proof(111, 120));
    expect(await loadMintBurnCoverageGaps(db, [config], cursors, now)).toEqual([{ config, fromBlock: 201, toBlock: 300 }]);
  });
  it("finds leading holes and bounds replay to retained raw hours and block chunks", async () => {
    const { db, sqlite } = fixtures.open();
    await commit(db, proof(100, 90_000, { configFingerprint: "old" }));
    await commit(db, proof(80_000, 90_000));
    expect(await loadMintBurnCoverageGaps(db, [config], new Map([[key, 90_000]]), now))
      .toEqual([{ config, fromBlock: 100, toBlock: 100 + COVERAGE_REPAIR_MAX_BLOCKS - 1 }]);
    expect(await loadMintBurnCoverageGaps(db, [config], new Map([[key, 90_000]]), now + 9 * 86_400)).toEqual([]);

    const retainedHour = Math.ceil((now - 8 * 86_400) / 3600) * 3600;
    const first = supplyConfig.startBlock + 500;
    const live = first + 90_000;
    await commit(db, proof(supplyConfig.startBlock, live, { configKey: supplyKey, configFingerprint: "old",
      fromTimestamp: retainedHour - 3600, finalizedBlock: live }));
    sqlite.prepare("INSERT INTO block_timestamp_cache (chain_id, block_number, timestamp, updated_at) VALUES (?, ?, ?, ?)")
      .run(supplyConfig.chain.chainId, first, retainedHour, now);
    const load = () => loadMintBurnSupplyProofRepairRanges(db, [supplyConfig], new Map([[supplyKey, live]]), now);
    expect(await load()).toEqual([{ config: supplyConfig, fromBlock: first, toBlock: first + COVERAGE_REPAIR_MAX_BLOCKS - 1 }]);
    const cursor = (fingerprint: string, lastBlock: number) => sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(supplyCursorKey, JSON.stringify({ fingerprint, lastBlock }), now);
    cursor(supplyFingerprint, first + 99);
    expect((await load())[0]?.fromBlock).toBe(first + 100);
    cursor("old-law", live);
    expect((await load())[0]?.fromBlock).toBe(first);
    sqlite.prepare("DELETE FROM mint_burn_scan_coverage WHERE config_key = ?").run(supplyKey);
    for (const [fromBlock, toBlock] of [[first, first + 99], [first + 200, first + 299]]) {
      await commit(db, proof(fromBlock!, toBlock!, { configKey: supplyKey, configFingerprint: "old",
        fromTimestamp: retainedHour, finalizedBlock: live }));
    }
    cursor(supplyFingerprint, first + 99);
    expect(await load()).toEqual([]);
    sqlite.prepare("DELETE FROM block_timestamp_cache").run();
    expect(await load()).toEqual([]);
  });
  it("rolls back coverage if the fenced repair cursor commit fails", async () => {
    const { db, sqlite } = fixtures.open();
    const p = proof(100, 199, { configKey: supplyKey });
    sqlite.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'cursor failed'); END");
    await expect(commitMintBurnSupplyProofRepair(db, supplyConfig, p)).rejects.toThrow("cursor failed");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage").get()).toEqual({ count: 0 });
    sqlite.exec("DROP TRIGGER fail_repair");
    vi.spyOn(cache, "getCache").mockRejectedValue(overload);
    await commitMintBurnSupplyProofRepair(db, supplyConfig, p);
    vi.mocked(cache.getCache).mockRestore();
    expect((await loadMintBurnSupplyProofRepairCursor(db, supplyConfig)).lastBlock).toBe(p.toBlock);
  });
  it.each(["shrink", "grow"])("holds repairs on %s-write overload", async (mode) => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      mintBurnSupplyProofRepairCursorKey(key), JSON.stringify({ fingerprint: mintBurnConservationFingerprint(config),
        lastBlock: null, maxBlocks: 2 }), now);
    if (mode === "shrink") vi.mocked(syncMintBurnConfig).mockResolvedValue({
      summary: { ...createMintBurnConfigSummary(config, key, "critical"), errors: 1,
        failedEventDefs: ["range-proof:persisted-event-readback-deadline"] }, newLastBlock: null,
      apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
    });
    vi.spyOn(cache, "setCacheIfNewer").mockRejectedValue(overload);
    const pending: MintBurnScanCoverage[] = [];
    const result = await repairMintBurnCoverage(input(db), [
      { config, fromBlock: 111, toBlock: 120 }, { config, fromBlock: 121, toBlock: 130 },
    ], pending, new Map());
    expect(pending).toHaveLength(mode === "grow" ? 1 : 0);
    expect(result[0]?.errors).toBeGreaterThan(0);
    expect(result[1]).toMatchObject({ attempted: false, repairReason: "repair-runtime-exhausted" });
    expect(syncMintBurnConfig).toHaveBeenCalledTimes(1);
    expect(abort.sleepWithSignal).toHaveBeenCalledWith(10_000, undefined);
  });
  it.each(["unproved", "throw", "mismatch", "rpc"])("keeps failed repair %s unproved with a machine-readable reason", async (failure) => {
    const { db } = fixtures.open();
    if (failure === "throw") vi.mocked(syncMintBurnConfig).mockRejectedValue(new Error("provider unavailable"));
    else vi.mocked(syncMintBurnConfig).mockImplementation(async (request) => ({
      summary: { ...createMintBurnConfigSummary(config, key, request.tier), errors: 1,
        conservationFailure: failure === "mismatch", failedEventDefs: failure === "unproved" ? [] : ["range-proof:persisted-event-readback-deadline"] },
      rpcEvidenceIncomplete: failure === "rpc", apiErrors: 1, effectiveBurns: 0,
      bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: null,
    }));
    const proofs: MintBurnScanCoverage[] = [];
    const request = input(db);
    const summaries = await repairMintBurnCoverage(request, [{ config, fromBlock: 111, toBlock: 120 }], proofs, new Map());
    expect(proofs).toEqual([]);
    expect(summaries[0]?.repairReason).toBe(failure === "throw" ? "repair-scan-failed" : "scan-coverage-unproven");
    if (failure === "throw") expect(request.budget.count).toBe(185);
    expect((await loadMintBurnSupplyProofRepairCursor(db, config)).maxBlocks).toBeUndefined();
  });
  it("paces replays within request/config/time caps", async () => {
    const { db } = fixtures.open();
    vi.mocked(fetchConservationBoundaries).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1000); return new Map();
    });
    const gaps = Array.from({ length: 8 }, (_, i) => ({ config, fromBlock: 111 + i * 10, toBlock: 120 + i * 10 }));
    await repairMintBurnCoverage(input(db), gaps, [], new Map());
    expect(syncMintBurnConfig).toHaveBeenCalledTimes(4);
    expect(abort.sleepWithSignal).toHaveBeenCalledWith(3000, undefined);
    vi.mocked(syncMintBurnConfig).mockClear();
    const request = input(db);
    request.budget.count = 199;
    expect((await repairMintBurnCoverage(request, gaps, [], new Map()))[0]?.repairReason).toBe("repair-budget-exhausted");
    expect(syncMintBurnConfig).not.toHaveBeenCalled();
    request.budget.count = 160;
    request.deadlineMs = Date.now() + 4_000;
    expect((await repairMintBurnCoverage(request, gaps, [], new Map()))[0]?.repairReason).toBe("repair-runtime-exhausted");
    expect(syncMintBurnConfig).not.toHaveBeenCalled();
    request.deadlineMs = Date.now() + 60_000;
    request.budget.count = 160;
    vi.mocked(syncMintBurnConfig).mockImplementation(async (request) => ({
      summary: { ...createMintBurnConfigSummary(config, key, request.tier), requestBudgetUsed: request.configBudgetLimit },
      apiErrors: 1, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: null,
    }));
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
