import { COVERAGE_REPAIR_MAX_BLOCKS } from "../mint-burn/repair-policy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { mintBurnConfigKey } from "../../lib/mint-burn-contract-identity";
import { upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { hasMintBurnScanCoverage, mintBurnScanFingerprint, type MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { loadMintBurnCoverageGaps as loadGaps, repairMintBurnCoverage } from "../mint-burn/repair-coverage";
import { createMintBurnConfigSummary as configSummary, syncMintBurnConfig } from "../mint-burn/sync-config";
import type { runMintBurnConfigPhase } from "../mint-burn/run-configs";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { fetchConservationBoundaries, mintBurnConservationFingerprint } from "../../lib/mint-burn-conservation";
import * as rpc from "../../lib/mint-burn-pipeline/rpc";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import * as abort from "../../lib/abort";
import * as cache from "../../lib/db-cache";
import { abiWord, reviewedBurnFixture } from "../../lib/__tests__/mint-burn-supply-proof.test-support";
import {
  commitMintBurnSupplyProofRepair as commitSupplyRepair, loadMintBurnSupplyProofRepairRanges as loadSupplyRepairs,
  mintBurnSupplyProofRepairCursorKey as repairCursorKey, loadMintBurnSupplyProofRepairCursor as loadRepairCursor,
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
const sync = vi.mocked(syncMintBurnConfig);
const now = Date.parse("2026-10-20T20:00:00Z") / 1000;
const config = makeMintBurnConfig({ asset: { startBlock: 100 } });
const key = mintBurnConfigKey(config);
const supplyConfig = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "dai-makerdao")!;
const supplyKey = mintBurnConfigKey(supplyConfig);
const supplyCursorKey = repairCursorKey(supplyKey);
const supplyFingerprint = mintBurnConservationFingerprint(supplyConfig);
const empty = { apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: null };
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
      rpcEndpoints: [{ operator: "dwellir", maxLogBlockSpan: 1e4 } as never], endpointHeads: new Map(), chainTimestampCache: new Map(), txContextCache: new Map() }]]),
    runTimestamp: now, priceContext: { priceObservations: new Map(), priceHistory: new Map() },
    lastBlocksAfterRun: new Map([[key, 300]]), pendingCursorUpdates: new Map(), pendingScanCoverage: new Map(),
    maxScanRange: 50_000, criticalConfigBudgetLimit: 60, extendedConfigBudgetLimit: 25, affectedHours: new Map(),
    deadlineMs: Date.now() + 180_000 };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
  vi.spyOn(abort, "sleepWithSignal").mockImplementation(async (ms, signal) => {
    abort.throwIfAborted(signal);
    vi.setSystemTime(Date.now() + ms);
  });
  vi.mocked(fetchConservationBoundaries).mockReset().mockResolvedValue(new Map());
  sync.mockReset().mockImplementation(async (request) => ({
    summary: { ...configSummary(request.config, request.key, request.tier), requestBudgetUsed: 4 },
    ...empty, newLastBlock: request.scanTo, scanCoverage: proof(request.fromBlock, request.scanTo, {
      configKey: request.key, configFingerprint: mintBurnScanFingerprint(request.config), chainId: request.config.chain.chainId,
      finalizedBlock: request.chainHead,
    }),
  }));
});
afterEach(() => { vi.restoreAllMocks(); fixtures.closeAll(); vi.useRealTimers(); });

describe("bounded scanner coverage repair", () => {
  it.each(["deadline", "overload", "context"])("certifies the full range after %s without oscillation", async (failure) => {
    const { db, sqlite } = fixtures.open();
    const size = failure === "context" ? 300 : 100;
    const first = supplyConfig.startBlock, last = first + size * 100 - 1;
    const template = reviewedBurnFixture("dai-makerdao").log;
    const logs = Array.from({ length: size }, (_, i) => ({ ...template,
      blockNumber: `0x${(first + i * 100).toString(16)}`, blockHash: abiWord(BigInt(first + i * 100)),
      transactionHash: abiWord(BigInt(i + 1)), data: abiWord(1n) }));
    await commit(db, proof(first, last, { configKey: supplyKey,
      configFingerprint: mintBurnScanFingerprint(supplyConfig), finalizedBlock: last }));
    const scanner = (await vi.importActual<typeof SyncConfigModule>("../mint-burn/sync-config")).syncMintBurnConfig;
    sync.mockImplementation(async (request) => {
      if (failure !== "context" || request.scanTo - request.fromBlock < 5000) return scanner(request);
      return { summary: { ...configSummary(request.config, request.key, request.tier),
        scanFrom: request.fromBlock, scanTo: request.scanTo,
        errors: 1, failedEventDefs: ["tx-context:100", ...(request.fromBlock > first ? ["tx-context-request-not-started:100"] : [])], txContextShortfalls: 100 }, ...empty, apiErrors: 1 };
    });
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
      if (exhausted && statements.length === 100) { vi.setSystemTime(now * 1000 + 121_000); throw overload; }
      const result = await batch(statements);
      vi.setSystemTime(Date.now() + statements.length * 400);
      return result;
    });
    const ranges: number[][] = [], accepted: number[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      vi.setSystemTime((now + attempt * 1800) * 1000);
      exhausted = failure === "overload" && attempt === 0;
      const request = { ...input(db), deadlineMs: Date.now() + 540_000, runTimestamp: now + attempt * 1800 }, pending: MintBurnScanCoverage[] = [];
      request.chainContexts.get("ethereum")!.chainHead = last;
      const gaps = await loadSupplyRepairs(db, [supplyConfig], new Map([[supplyKey, last]]), now);
      if (!gaps.length) break;
      const [summary] = await repairMintBurnCoverage(request, gaps, pending, new Map(), { supplyProofRepair: true });
      ranges.push([summary!.scanFrom!, summary!.scanTo!]);
      accepted.push(pending.length);
      if (pending.length) {
        await recalcAffectedHours(db, request.affectedHours);
        await commitSupplyRepair(db, supplyConfig, pending[0]!);
      }
    }
    expect(ranges.slice(0, 2)).toEqual([[first, first + 9999], [first, first + 4999]]);
    if (failure === "context") expect(accepted.join("")).toContain("111");
    else expect(ranges[2]).toEqual([first + 5000, last]);
    expect(vi.mocked(fetchConservationBoundaries).mock.calls.map(([call]) =>
      [call.requests[0]!.fromBlock, call.requests[0]!.toBlock])).toEqual(ranges);
    expect(await loadSupplyRepairs(db, [supplyConfig], new Map([[supplyKey, last]]), now)).toEqual([]);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM mint_burn_events e JOIN mint_burn_supply_proofs p
      ON p.proof_id = e.supply_proof_id WHERE p.lifecycle = 'accepted' AND p.status = 'proven'`).get()).toEqual({ count: size });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_supply_proofs WHERE lifecycle = 'pending'").get())
      .toEqual({ count: failure === "context" ? 0 : 1 });
  });
  it("keeps oldest-first fallback outside live coverage", async () => {
    const { db } = fixtures.open();
    const load = () => loadGaps(db, [config], new Map([[key, 300]]), now);
    expect(await load()).toEqual([]);
    await commit(db, proof(100, 300, { configFingerprint: "old" }));
    expect(await load()).toEqual([{ config, fromBlock: 100, toBlock: 300 }]);
    await commit(db, proof(100, 110));
    await commit(db, proof(121, 200));
    expect(await load()).toEqual([{ config, fromBlock: 111, toBlock: 120 }]);
    await commit(db, proof(111, 120));
    expect(await load()).toEqual([{ config, fromBlock: 201, toBlock: 300 }]);
  });
  it("joins recent repairs through the real 24h reader", async () => {
    const { db, sqlite } = fixtures.open();
    const stamp = (block: number) => now - 86_400 + (block - 1000) * 12;
    const p = (from: number, to: number, configFingerprint = mintBurnScanFingerprint(config)) =>
      proof(from, to, { fromTimestamp: stamp(from), toTimestamp: stamp(to), configFingerprint });
    await commit(db, p(1000, 8200, "old"));
    await commit(db, p(1500, 2000));
    await commit(db, p(7000, 8200));
    await cache.setCacheIfNewer(db, repairCursorKey(key),
      JSON.stringify({ fingerprint: mintBurnConservationFingerprint(config), lastBlock: null, maxBlocks: 2000 }), now);
    const ranges: number[][] = [];
    sync.mockImplementation(async (request) => ({
      summary: configSummary(config, key, "critical"), ...empty,
      newLastBlock: request.scanTo, scanCoverage: p(request.fromBlock, request.scanTo),
    }));
    for (let turn = 0; turn < 4; turn++) {
      expect(await hasMintBurnScanCoverage(db, [config], now - 86_400, now)).toBe(false);
      const pending: MintBurnScanCoverage[] = [];
      const gaps = await loadGaps(db, [config], new Map([[key, 8200]]), now);
      await repairMintBurnCoverage(input(db), gaps, pending, new Map());
      const accepted = pending[0]!;
      ranges.push([accepted.fromBlock, accepted.toBlock]);
      await commit(db, accepted);
    }
    expect(ranges).toEqual([[5000, 6999], [2500, 4999], [2001, 2499], [1000, 1499]]);
    expect(await hasMintBurnScanCoverage(db, [config], now - 86_400, now)).toBe(true);
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state").get()).toEqual({ last_block: 8200 });
    expect(await loadGaps(db, [config], new Map([[key, 8200]]), now + 9 * 86_400)).toEqual([]);
  });
  it("bounds forward supply replay to retained hours", async () => {
    const { db, sqlite } = fixtures.open();
    const retainedHour = Math.ceil((now - 8 * 86_400) / 3600) * 3600;
    const first = supplyConfig.startBlock + 500;
    const live = first + 90_000;
    await commit(db, proof(supplyConfig.startBlock, live, { configKey: supplyKey, configFingerprint: "old",
      fromTimestamp: retainedHour - 3600, finalizedBlock: live }));
    sqlite.prepare("INSERT INTO block_timestamp_cache (chain_id, block_number, timestamp, updated_at) VALUES (?, ?, ?, ?)")
      .run(supplyConfig.chain.chainId, first, retainedHour, now);
    const load = () => loadSupplyRepairs(db, [supplyConfig], new Map([[supplyKey, live]]), now);
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
  });
  it("atomically fences repair cursor commits", async () => {
    const { db, sqlite } = fixtures.open();
    const p = proof(100, 199, { configKey: supplyKey });
    sqlite.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'cursor failed'); END");
    await expect(commitSupplyRepair(db, supplyConfig, p)).rejects.toThrow("cursor failed");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage").get()).toEqual({ count: 0 });
    sqlite.exec("DROP TRIGGER fail_repair");
    vi.spyOn(cache, "getCache").mockRejectedValue(overload);
    await commitSupplyRepair(db, supplyConfig, p);
    vi.mocked(cache.getCache).mockRestore();
    expect((await loadRepairCursor(db, supplyConfig)).lastBlock).toBe(p.toBlock);
  });
  it.each(["shrink", "grow", "mismatch", "rpc"])("separates sizing-write overload from %s evidence", async (mode) => {
    const { db } = fixtures.open();
    const local = mode === "shrink" || mode === "grow";
    if (local) await cache.setCacheIfNewer(db, repairCursorKey(key),
      JSON.stringify({ fingerprint: mintBurnConservationFingerprint(config), lastBlock: null, maxBlocks: 4 }), now);
    if (mode !== "grow") sync.mockResolvedValue({
      summary: { ...configSummary(config, key, "critical"), errors: 1,
        conservationFailure: mode === "mismatch", failedEventDefs: [mode === "shrink"
          ? "range-proof:persisted-event-readback-deadline" : "tx-context:1"] },
      rpcEvidenceIncomplete: mode === "rpc", ...empty, apiErrors: 1,
    });
    if (local) vi.spyOn(cache, "setCacheIfNewer").mockRejectedValue(overload);
    const pending: MintBurnScanCoverage[] = [];
    const result = await repairMintBurnCoverage(input(db), [
      { config, fromBlock: 111, toBlock: 120 }, ...(local ? [{ config, fromBlock: 121, toBlock: 130 }] : []),
    ], pending, new Map());
    expect(pending).toHaveLength(mode === "grow" ? 1 : 0);
    expect(syncMintBurnConfig).toHaveBeenCalledTimes(1);
    if (local) {
      expect(result[0]?.errors).toBeGreaterThan(0);
      expect(result[1]).toMatchObject({ attempted: false, repairReason: "repair-runtime-exhausted" });
      expect(abort.sleepWithSignal).toHaveBeenCalledWith(10_000, undefined);
    } else {
      expect(result[0]?.repairReason).toBe("scan-coverage-unproven");
      expect((await loadRepairCursor(db, config)).maxBlocks).toBeUndefined();
    }
  });
  it.each<[number, number, number, boolean, number[], "extended"?]>([
    [0, 1, 0, false, [120]], [160, 1, 0, false, [30]],
    [0, 2, 0, false, [120, 70]], [160, 2, 0, false, [15, 15]],
    [199, 1, 0, false, []], [0, 1, 480_000, false, []], [160, 8, 0, false, [9, 7, 7, 7]], [185, 4, 0, false, [3, 2], "extended"],
    [0, 2, 0, true, [120, 120]], [160, 2, 330_000, true, [15, 26]], [160, 2, 360_000, true, [15]], [178, 4, 0, false, [7, 3, 2], "extended"], [179, 4, 0, false, [5, 2, 2, 2]], [171, 4, 0, false, [12, 3, 2, 2], "extended"],
  ])("shares unused requests/time and protects admitted work (%#)", async (used, count, elapsed, pending, expected, tier) => {
    const { db } = fixtures.open();
    const configs = Array.from({ length: count }, (_, i) => i === 0 ? used > 170 ? { ...supplyConfig, tier } : config : makeMintBurnConfig({
      asset: { contractAddress: `0x${String(i + 1).padStart(40, "0")}`, tier },
    }));
    const pendingKey = mintBurnConfigKey(configs[configs.length - 1]!);
    vi.setSystemTime(now * 1000 + elapsed);
    const start = Date.now(), base = sync.getMockImplementation()!;
    sync.mockImplementation(async (scan) => {
      const result = await base(scan);
      if (!pending) return { ...empty, summary: { ...result.summary, requestBudgetUsed: scan.configBudgetLimit } };
      if (scan.key !== pendingKey) return result;
      vi.setSystemTime(scan.deadlineMs!);
      return { ...result, newLastBlock: null, scanCoverage: undefined, summary: { ...result.summary,
        errors: 1, failedEventDefs: ["tx-context:1"], txContextShortfalls: 1 } };
    });
    if (count === 8) vi.mocked(fetchConservationBoundaries).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1000); return new Map();
    });
    const request = { ...input(db), deadlineMs: now * 1000 + 540_000 };
    request.budget.count = used;
    if (pending) request.pendingAdmissionKeys = new Set([pendingKey]);
    const gaps = configs.map((config, i) => ({ config, fromBlock: 111 + i * 10, toBlock: i ? 120 + i * 10 : 1e6 }));
    // 171 used, two named holes: only the first attempted takes the 12 its run held back.
    const summaries = await repairMintBurnCoverage(request, pending ? [...gaps].reverse() : gaps, [], new Map(),
      used === 171 ? { leadKeys: new Set(configs.slice(0, 2).map(mintBurnConfigKey)), leadAllowance: 12 } : {});
    const calls = sync.mock.calls.map(([scan]) => scan);
    expect(calls.map((scan) => scan.configBudgetLimit)).toEqual(expected);
    expect(request.budget.count).toBe(used + (pending ? calls.length * 4 : expected.reduce((sum, n) => sum + n, 0)));
    const deadline = Math.min(start + 120_000, now * 1000 + 460_000);
    if (count === 2) expect(calls.map((scan) => [scan.key, scan.deadlineMs])).toEqual([
      [key, start + (deadline - start) / 2], ...(calls.length === 2
        ? [[pendingKey, pending ? Math.min(deadline, now * 1000 + 360_000) : deadline]] : []),
    ]);
    if (!expected.length || (pending && calls.length === 1)) expect(summaries[summaries.length - 1]).toMatchObject(used === 199
      ? { skippedReason: "repair-budget-exhausted", repairReason: "repair-budget-exhausted", requestBudgetLimit: 0 }
      : { repairReason: "repair-runtime-exhausted" });
    if (used === 185) expect(summaries[0]!.requestBudgetLimit).toBe(5);
    if (count === 8) {
      expect(abort.sleepWithSignal).toHaveBeenCalledWith(3000, undefined);
      for (const [lane, at] of [["critical", 1800], ["extended", 4680]] as const) {
        await repairMintBurnCoverage({ ...input(db), lane, runTimestamp: now + at }, gaps, [], new Map());
        expect(sync.mock.lastCall![0].fromBlock % 20).toBe(11);
      }
      // A run that held requests back for holes attempts them first, whatever the rotation.
      const first = sync.mock.calls.length, leadKeys = new Set([mintBurnConfigKey(configs[2]!)]);
      await repairMintBurnCoverage({ ...input(db), runTimestamp: now + 1800 }, gaps, [], new Map(), { leadKeys });
      expect(leadKeys.has(sync.mock.calls[first]![0].key)).toBe(true);
    }
  });
});
