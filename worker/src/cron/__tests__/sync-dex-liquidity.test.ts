import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getCronQualityReasons as qualReasons } from "@shared/lib/cron-quality-reasons";
import type { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { createLatestSchemaSqlite as mkSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type { StablecoinData } from "@shared/types/supply";
import type { DexApiPool } from "../../lib/dex-api-common";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { CronProgressReporter, CronProgressUpdate, CronResult } from "../../lib/cron-logger";
import type { LlamaPool, PoolEntry } from "../dex-liquidity/types";
import type { PoolProcessingRejection } from "../dex-liquidity/process-pool-types";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import * as priceVal from "../../lib/price-validation";
import * as poolShaping from "../../lib/dex-api-pool-shaping";
import { CRON_TIMEOUT_MS, createSlotDeadline } from "../../lib/cron-timeouts";
import { getCronMetadataBudgetBytes as metaBudget } from "../../lib/cron-metadata-persistence";
import { DexLiquidityCronMetadataSchema as MetaSchema } from "../../lib/schemas";
import * as v2Enrich from "../dex-liquidity/constant-product-v2";
import * as quoterEnrich from "../dex-liquidity/enrich-quoter-v2-targets";
import * as v4Enrich from "../dex-liquidity/uniswap-v4-identity";
import * as priceRef from "../dex-liquidity/price-refresh";
import { CURVE_CHAINS } from "../dex-liquidity/constants";
import { buildStagedPoolWriteback as buildWb } from "../dex-liquidity/staged-pool-writeback";

afterEach(() => { vi.restoreAllMocks(); });

const fx = vi.hoisted(() => {
  const primary = (o: Record<string, unknown> = {}) => ({ pools: [], rawPoolCount: 0, poolRejections: [] as PoolProcessingRejection[], dexProjects: new Set<string>(), protocolTvlCaps: new Map<string, number>(), curvePayloads: [], curveFailedChains: [], graphApiKey: "graph-key", dlYieldsAvailable: true, dlProtocolsAvailable: true, ...o });
  const stagedPools = () => ({ registryEvaluatedAtSec: Math.floor(Date.now() / 1e3), mergedCount: 0, skippedCount: 0, skippedByExactIdentityCount: 0, skippedByUniqueDerivedIdentityCount: 0, skippedByOptionalWildcardIdentityCount: 0, skippedByAuthoritativeProtocolCount: 0, skipDimensions: [], priceObservations: new Map(), registryRowsRead: 0, registryMultiSourcePools: 0, registryFamilyBySource: {}, deadPoolUnindexedChainSkips: {} });
  const diagnostics = (e: Record<string, unknown> = {}) => ({ protocolTvlQuarantine: { reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 0, protocolCount: 0, tvlUsd: 0 }, globalProtocolOverCapUsd: 0, measuredTargetFunnel: { stageOrigin: "scheduled", groups: [], groupsOmitted: 0, sourceFailures: [], sourceFailuresOmitted: 0 }, routeRemovalEvidence: new Map(), ...e });
  const scored = (e: Record<string, unknown> = {}) => ({ scoredMetrics: new Map(), measuredTargetInventory: { mode: "active", active: [], shadow: [] }, scores: new Map([["usdt-tether", { coverageClass: "primary", tvl: 0 }]]), globalAgg: { totalTvl: 0 }, retainedPoolsByStablecoin: new Map(), tvlStabilityMap: new Map(), diagnostics: diagnostics({ fallbackCounters: { tvlDepthMcapFallback: 2, retainedExclusionBlockedDex: 1 } }), ...e });
  const create = (o: Record<string, unknown> = {}) => ({
    directApi: { pools: [], ok: true, degraded: false, errors: [] as string[] },
    uniV3: { uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), uniV3PriceObs: new Map(), uniV3ExecutionCandidates: new Map(), failedChains: [], chainFailures: [] },
    uniswapV4: { uniswapV4ExecutionCandidates: new Map(), failedChains: [], chainFailures: [], exactAnsweredPoolIdsByChain: new Map() },
    primary: primary(), curve: { curvePoolMap: new Map(), curvePoolCandidatesByFingerprint: new Map(), curveBelowFloorTwinFingerprints: new Set<string>(), priceObservations: new Map() },
    knownPools: { exactKeys: new Set<string>(), exactStablecoinIdsByKey: new Map<string, Set<string>>(), derivedKeyCounts: new Map<string, number>(), derivedToExactKeys: new Map<string, Set<string>>(), wildcardKeyCounts: new Map<string, number>(), wildcardToExactKeys: new Map<string, Set<string>>(), concreteFeeVariantKeys: new Map<string, Set<string>>() },
    poolMetrics: { metrics: new Map(), rejections: [] }, stagedPools: stagedPools(), scores: scored(),
    stablecoinsCache: { kind: "error" as const, reason: "missing-cache" as const, updatedAt: null }, challenger: { publishedStablecoins: 0, skippedStablecoins: 0 }, ...o,
  });
  let current = create();
  return { primary, stagedPools, scored, diagnostics, get current() { return current; }, reset(o: Record<string, unknown> = {}) { current = create(o); } };
});

const directRes = () => fx.current.directApi;
const deferred = <T,>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>((r) => { resolve = r; }), resolve }; };

vi.mock("../dex-liquidity/subgraph-source-families", () => ({ fetchUniV3Data: vi.fn(async () => fx.current.uniV3), fetchUniswapV4Data: vi.fn(async () => fx.current.uniswapV4) }));
vi.mock("../dex-liquidity/fetch-primary", () => ({ fetchDataSources: vi.fn(async () => fx.current.primary), buildCurveLookups: vi.fn(async () => fx.current.curve), buildKnownPoolAddresses: vi.fn(() => fx.current.knownPools) }));
vi.mock("../dex-liquidity/process-pools", async (io) => ({ ...(await io<typeof import("../dex-liquidity/process-pools")>()), processPoolMetrics: vi.fn(() => fx.current.poolMetrics) }));
vi.mock("../dex-liquidity/staging-merge", async () => {
  const { buildStagedPoolWriteback: wb } = await import("../dex-liquidity/staged-pool-writeback");
  const { captureObservedPoolPrices: cap } = await import("../dex-liquidity/price-refresh");
  return { mergeStagedPools: vi.fn<typeof import("../dex-liquidity/staging-merge").mergeStagedPools>(async (_db, m, _k, now, _t, _r, _c, _cn, _s, obs) => ({ ...fx.current.stagedPools, stagedWriteback: wb(m, now), observedThisRun: cap({ metrics: m, priceObservations: obs }, now) })) };
});
vi.mock("../dex-liquidity/scoring", () => ({ loadCurrentDexScoringGenerationId: vi.fn(async () => null), computeStablecoinScores: vi.fn(async () => fx.current.scores), publishStablecoinScoreTargets: vi.fn(async () => {}), computeDexPrices: vi.fn(async () => {}) }));
vi.mock("../dex-liquidity/persistence", () => ({ persistScores: vi.fn(async (_db, _m, _s, _g, nowSec: number) => ({ generationId: `dex-liquidity-${nowSec}` })), writeHistoricalSnapshots: vi.fn(async () => {}), buildDexLiquidityPublicationGenerationId: (s: number) => `dex-liquidity-${s}` }));

const stageBuf = vi.hoisted(() => ({ chunks: [] as Array<{ payload: string; payloadBytes: number; recordCount: number }>, sourceSlotStartedAt: 0, syncStartSec: 0 }));
vi.mock("../dex-liquidity/scoring-stage", async () => {
  const a = await vi.importActual<typeof import("../dex-liquidity/scoring-stage")>("../dex-liquidity/scoring-stage");
  const load = async () => { const d = a.decodeDexLiquidityScoringStageChunks(stageBuf.chunks); return { generationId: `dex-liquidity-scoring-stage:${stageBuf.sourceSlotStartedAt}`, sourceSlotStartedAt: stageBuf.sourceSlotStartedAt, syncStartSec: stageBuf.syncStartSec, sourceState: d.sourceState, poolState: d.poolState }; };
  return {
    ...a, loadDexLiquidityScoringStage: vi.fn(load), loadDexLiquidityScoringStageWhenReady: vi.fn(load), markDexLiquidityScoringStageConsumed: vi.fn(async () => {}),
    persistDexLiquidityScoringStage: vi.fn(async (_db: D1Database, input: Parameters<typeof a.persistDexLiquidityScoringStage>[1]) => {
      stageBuf.chunks = []; let recordCount = 0, payloadBytes = 0;
      for (const c of a.encodeDexLiquidityScoringStageChunks(input.sourceState, input.poolState, a.DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES, true)) { stageBuf.chunks.push({ ...c }); recordCount += c.recordCount; payloadBytes += c.payloadBytes; }
      stageBuf.sourceSlotStartedAt = input.sourceSlotStartedAt; stageBuf.syncStartSec = input.syncStartSec;
      return { generationId: `dex-liquidity-scoring-stage:${input.sourceSlotStartedAt}`, sourceSlotStartedAt: input.sourceSlotStartedAt, chunkCount: stageBuf.chunks.length, recordCount, payloadBytes, retention: { cutoff: 0, deletedRows: 0, deletedChunkRows: 0, deletedStageRows: 0, oldestRemainingAt: null, durationMs: 0, error: null } };
    }),
  };
});
vi.mock("../dex-liquidity/challenger-publish", async () => ({ ...(await vi.importActual<typeof import("../dex-liquidity/challenger-publish")>("../dex-liquidity/challenger-publish")), publishDexPriceChallengerSnapshots: vi.fn(async () => fx.current.challenger) }));
vi.mock("../dex-liquidity/fetch-fallbacks", () => ({ getFallbackTargets: vi.fn(() => []) }));
vi.mock("../dex-liquidity/fetch-fluid", () => ({ fetchFluidPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-balancer", () => ({ fetchBalancerPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-raydium", () => ({ fetchRaydiumPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-orca", () => ({ fetchOrcaPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-meteora", () => ({ fetchMeteoraPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-pancakeswap", () => ({ fetchPancakeSwapPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-slipstream", () => ({ fetchSlipstreamPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-aero", async (io) => ({ ...(await io<typeof import("../dex-liquidity/fetch-aero")>()), fetchAeroSlipstreamPools: vi.fn(async () => directRes()), fetchAeroBasicPools: vi.fn(async () => directRes()) }));
vi.mock("../dex-liquidity/fetch-uniswap-v3-bsc", () => ({ fetchUniswapV3BscShadowPools: vi.fn(async () => directRes()) }));
vi.mock("../../lib/stablecoins-cache", async () => ({ ...(await vi.importActual<typeof import("../../lib/stablecoins-cache")>("../../lib/stablecoins-cache")), loadStablecoinsCache: vi.fn(async () => fx.current.stablecoinsCache) }));
vi.mock("../../lib/dex-api-common", async () => ({ ...(await vi.importActual<typeof import("../../lib/dex-api-common")>("../../lib/dex-api-common")), convertToGtNewPools: vi.fn(() => new Map()), extractPriceObservations: vi.fn(() => new Map()) }));

import { DEX_LIQUIDITY_STAGE_LEAD_SEC as STAGE_LEAD, getCronSlotStartedAtForSchedule as slotAt } from "@shared/lib/cron-jobs";
import { consumeDexLiquidityScoringStage as consumeStageFn, filterPrimaryPoolsPreferDirectApi as filterPools, stageDexLiquidityScoring as stageFn } from "../dex-liquidity/orchestrator";
import { MissingDexLiquidityScoringStageError as MissingStageErr, loadDexLiquidityScoringStage as loadStage, loadDexLiquidityScoringStageWhenReady as loadStageReady, markDexLiquidityScoringStageConsumed as markConsumed, persistDexLiquidityScoringStage as persistStage } from "../dex-liquidity/scoring-stage";
import { loadStablecoinsCache as loadCache } from "../../lib/stablecoins-cache";
import { convertToGtNewPools as convGt, extractPriceObservations as extObs } from "../../lib/dex-api-common";
import { buildCurveLookups as buildCurve, fetchDataSources as fetchSrcs, buildKnownPoolAddresses as buildKnown } from "../dex-liquidity/fetch-primary";
import { fetchUniV3Data as fetchV3 } from "../dex-liquidity/subgraph-source-families";
import { fetchFluidPools as fetchFluid } from "../dex-liquidity/fetch-fluid";
import { fetchBalancerPools as fetchBal } from "../dex-liquidity/fetch-balancer";
import { fetchRaydiumPools as fetchRay } from "../dex-liquidity/fetch-raydium";
import { fetchOrcaPools as fetchOrca } from "../dex-liquidity/fetch-orca";
import { fetchMeteoraPools as fetchMet } from "../dex-liquidity/fetch-meteora";
import { fetchPancakeSwapPools as fetchCake } from "../dex-liquidity/fetch-pancakeswap";
import { fetchSlipstreamPools as fetchSlip } from "../dex-liquidity/fetch-slipstream";
import { fetchUniswapV3BscShadowPools as fetchBscSh } from "../dex-liquidity/fetch-uniswap-v3-bsc";
import { computeDexPrices as compPrices, computeStablecoinScores as compScores, publishStablecoinScoreTargets as pubTargets, loadCurrentDexScoringGenerationId as loadGenId } from "../dex-liquidity/scoring";
import { logCronRun } from "../../lib/cron-logger";
import { persistScores, writeHistoricalSnapshots as writeHist } from "../dex-liquidity/persistence";
import { publishDexPriceChallengerSnapshots as pubChall } from "../dex-liquidity/challenger-publish";
import { buildSymbolLookups } from "../dex-liquidity/pool-helpers";
import { processPoolMetrics as procMetrics } from "../dex-liquidity/process-pools";
import { mergeStagedPools as mergeStaged } from "../dex-liquidity/staging-merge";
import * as regPersist from "../dex-discovery/persistence";
import { readDexSourcePaginationState as readPag } from "../dex-liquidity/source-pagination-state";
import { runPruneCronHistory as pruneHistory } from "../prune-cron-history";

const vm = vi.mocked, js = JSON.stringify, jp = JSON.parse, nowS = () => Math.floor(Date.now() / 1e3);
const USDT = "usdt-tether", USDC = "usdc-circle", GK = "graph-key", STG_JOB = "sync-dex-liquidity-stage";
const firstRowFor = (sql: string) => async () => (sql.includes("FROM cache") ? null : { cnt: 0 });
const emptyStmt = (sql: string) => ({ bind: () => ({ all: async () => ({ results: [], success: true }), first: firstRowFor(sql), run: async () => ({ success: true, meta: {} }) }), all: async () => ({ results: [], success: true }), first: firstRowFor(sql), run: async () => ({ success: true, meta: {} }) });
const db = makeNoopD1({ prepare: emptyStmt, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }), dump: async () => new ArrayBuffer(0) });
const guardDb = (tables: Array<MockTableConfig & { alsoMatch?: string }>, ov: Record<string, unknown> = {}) => makeNoopD1({
  prepare: (sql: string) => {
    const t = tables.find(({ match, alsoMatch }) => sql.includes(match) && (!alsoMatch || sql.includes(alsoMatch)));
    if (t) return mockD1([t]).prepare(sql);
    if (sql.includes("FROM cache") || sql.includes("INTO cache")) return emptyStmt(sql);
    throw new Error(`Unexpected D1 query in sync-dex-liquidity test: ${sql}`);
  },
  ...ov,
});

async function runCycle(database: D1Database = db, gk: string | null = GK, sig?: AbortSignal, cgKey?: string | null, rpcs?: Map<string, ChainRpcConfig>, prog?: CronProgressReporter, opts?: { publishShadowTargets?: boolean }): Promise<CronResult> {
  await stageFn(database, gk, sig, cgKey, rpcs, prog);
  return consumeStageFn(database, sig, prog, undefined, opts);
}
const readMeta = (r: CronResult) => jp(r.metadata ?? "{}");
const stageSrc = () => stageFn(db, GK);
const apiRes = (pools: DexApiPool[] = [], extra: Partial<Awaited<ReturnType<typeof fetchOrca>>> = {}) => ({ pools, ok: true, degraded: false, errors: [] as string[], ...extra });
const apiPool = (o: Partial<DexApiPool> & Pick<DexApiPool, "balances">): DexApiPool => ({
  source: "fluid", chain: "Ethereum", poolAddress: "0x1111111111111111111111111111111111111111", poolType: "fluid",
  tokens: [{ address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 }, { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 }],
  price: 1, tvlUsd: 1e5, volume24hUsd: 1e4, feeRate: 0.0001, ...o,
});
const llamaPool = (o: Pick<LlamaPool, "pool" | "chain" | "project" | "symbol" | "tvlUsd" | "underlyingTokens"> & Partial<LlamaPool>): LlamaPool => ({
  volumeUsd1d: null, volumeUsd7d: null, stablecoin: false, apyBase: null, apyReward: null, apy: 0, sigma: 0, exposure: "multi", count: 20, ...o,
});
const mkCoin = (id: string, symbol: string, price: number): StablecoinData => {
  const n = nowS();
  return { id, name: symbol, symbol, geckoId: null, pegType: "peggedUSD", pegMechanism: "fiat-backed", listingClass: null, price, priceSource: "pyth", priceConfidence: "single-source", priceUpdatedAt: n, priceObservedAt: n, priceObservedAtMode: "upstream", priceSyncedAt: n, consensusSources: ["pyth"], agreeSources: ["pyth"], supplySource: "defillama", circulating: { peggedUSD: 1e6 }, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {}, chainCirculating: {}, chains: [] };
};

describe("dex liquidity scoring stage cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks(); fx.reset();
    vm(convGt).mockReturnValue(new Map()); vm(extObs).mockReturnValue(new Map()); vm(loadGenId).mockResolvedValue(null);
  });

  it("overlaps only the independent serial CL capture families and settles them before staging", async () => {
    const v4S = deferred<void>(), qEnd = deferred<void>(), order: string[] = [], ref = vi.spyOn(priceRef, "refreshPoolPrices");
    vi.spyOn(quoterEnrich, "enrichQuoterV2ExecutionTargets").mockImplementationOnce(async () => { order.push("quoter-start"); await v4S.promise; order.push("quoter-end"); qEnd.resolve(); return { exactPoolCount: 0, exactCapableAssets: [], telemetry: [] }; });
    vi.spyOn(v4Enrich, "enrichUniswapV4ExecutionTargets").mockImplementationOnce(async () => { order.push("v4-start"); v4S.resolve(); await qEnd.promise; order.push("v4-end"); return []; });
    await stageSrc();
    expect(order).toEqual(["quoter-start", "v4-start", "quoter-end", "v4-end"]);
    expect(ref.mock.invocationCallOrder[0]).toBeGreaterThan(vm(mergeStaged).mock.invocationCallOrder[0]!);
    expect(persistStage).toHaveBeenCalledOnce();
  });

  it("evaluates late source-stage exact captures at the consumer clock without restamping registry volume", async () => {
    const srcClk = Date.parse("2026-10-11T12:10:00Z") / 1e3, consClk = srcClk + 360;
    fx.current.stagedPools.registryEvaluatedAtSec = srcClk + 180;
    const clock = vi.spyOn(Date, "now").mockReturnValue(srcClk * 1e3);
    try {
      await stageSrc(); expect(stageBuf.syncStartSec).toBe(srcClk);
      clock.mockReturnValue(consClk * 1e3); await consumeStageFn(db);
      const call = vm(compScores).mock.lastCall!;
      expect([call[4], call[9], stageBuf.syncStartSec]).toEqual([consClk, srcClk + 180, srcClk]);
      expect(srcClk + 240).toBeLessThanOrEqual(Number(call[4]));
      expect(vm(pubChall).mock.lastCall?.[1]).toMatchObject({ snapshotAt: srcClk, generationId: expect.any(String) });
    } finally { clock.mockRestore(); }
  });

  it.each(["registry", "stage", "after-stage"] as const)("leaves a fetched tail retryable after %s failure and acknowledges its replay", async (fail) => {
    const h = mkSqlite(), database = { ...db, prepare: (sql: string) => sql.includes("dex_source_pagination_state") ? h.db.prepare(sql) : db.prepare(sql) } as D1Database;
    const ctrl = new AbortController(), err = new Error(`injected ${fail} failure`), origP = vm(persistStage).getMockImplementation()!;
    const fetchTail = async () => {
      vm(fetchOrca).mockResolvedValueOnce(apiRes([], { pendingPaginationUpdates: [{ sourceKey: "orca:solana", cursor: "page9", cycleStartedAt: 100, nowSec: 100, completed: false, pagesFetched: 4, diagnostics: [], expectedRevision: (await readPag(database, "orca:solana")).revision!, generation: crypto.randomUUID() }] }));
    };
    try {
      await fetchTail();
      if (fail === "registry") vi.spyOn(regPersist, "upsertStagedPools").mockRejectedValueOnce(err);
      else if (fail === "stage") vm(persistStage).mockRejectedValueOnce(err);
      else vm(persistStage).mockImplementationOnce(async (...a) => { const r = await origP(...a); ctrl.abort(err); return r; });
      const first = stageFn(database, GK, ctrl.signal);
      if (fail === "registry") await first; else await expect(first).rejects.toBe(err);
      expect(await readPag(database, "orca:solana")).toMatchObject({ cursor: null });
      await fetchTail(); await stageFn(database, GK);
      expect(await readPag(database, "orca:solana")).toMatchObject({ cursor: "page9" });
    } finally { h.sqlite.close(); }
  });

  it("scopes Yearn vaults", async () => {
    const orig = priceRef.refreshPoolPrices;
    vi.spyOn(priceRef, "refreshPoolPrices").mockImplementationOnce(async (...a) => { const s = await orig(...a); s.demand.networks = Array(100).fill({ network: "ethereum", pools: 1, requests: 1 }); return s; });
    const real = await vi.importActual<typeof import("../dex-liquidity/process-pools")>("../dex-liquidity/process-pools");
    const pools = Array.from({ length: 67 }, (_, i) => llamaPool({ pool: `7d89af7a-24c9-4292-aa38-0000000000${i + 10}`, project: "yearn-finance", chain: "Ethereum", symbol: "", poolMeta: null, underlyingTokens: ["0x0000000000000000000000000000000000000000"], exposure: "single", tvlUsd: i ? 2e6 : 11_399_064 }));
    vm(procMetrics).mockImplementationOnce(real.processPoolMetrics);
    Object.assign(fx.current.primary, { pools, rawPoolCount: 67, dexProjects: new Set(["uniswap-v3"]), nonDexProjects: new Set(["yearn-finance"]) });
    for (const [job, res] of [[STG_JOB, await stageSrc()], ["sync-dex-liquidity", await consumeStageFn(db)]] as const) {
      expect(Buffer.byteLength(res.metadata!)).toBeLessThanOrEqual(metaBudget(job)); expect(res.status).toBe("ok");
      const m = readMeta(res); expect(m.reason).toBeUndefined();
      expect(m.poolRejections[0]).toMatchObject({ scope: "non-dex-project", protocol: "yearn-finance" });
      expect(m.poolRejectionMateriality).toMatchObject({ rejectedPoolCount: 67, rejectedPoolTvlUsd: 143_399_064, outOfScopeRejectedPoolCount: 67, candidateRejectedPoolCount: 0, candidateRejectedPoolTvlUsd: 0, detailsOmitted: 63, material: false });
    }
    const ch = stageBuf.chunks[0]!, [hdr, ...rest] = ch.payload.split("\n"), leg = jp(hdr!);
    delete leg.pool.poolRejections[0].scope;
    ch.payload = [js(leg), ...rest].join("\n"); ch.payloadBytes = Buffer.byteLength(ch.payload);
    vm(persistScores).mockClear();
    const held = await consumeStageFn(db);
    expect([held.status, readMeta(held).reason, readMeta(held).poolRejections[0].scope]).toEqual(["degraded", "pool-rejection-scope-unavailable", "unknown-project"]);
    expect(persistScores).not.toHaveBeenCalled();
  });

  it("throws on catastrophic source failure instead of silently returning", async () => {
    fx.reset({ primary: null });
    await expect(runCycle()).rejects.toThrow("catastrophic source failure");
  });

  it.each([
    ["surfaces a missing mandatory staging table from the producer", vm(mergeStaged), "D1_ERROR: no such table: dex_pool_registry"],
    ["surfaces a missing mandatory history table from the scoring producer", vm(compScores), "D1_ERROR: no such table: dex_liquidity_history"],
  ])("%s", async (_l, prod, msg) => {
    prod.mockRejectedValueOnce(new Error(msg));
    await expect(runCycle()).rejects.toThrow(msg);
  });

  it("returns degraded when non-catastrophic critical source family fails", async () => {
    fx.reset({ primary: fx.primary({ dlProtocolsAvailable: false }) });
    const res = await runCycle(), m = readMeta(res);
    expect(res.status).toBe("degraded"); expect(m.failedSources).toContain("defillama-protocols"); expect(m.fallbackMode).toContain("dl-protocols-unavailable");
    expect(m).toMatchObject({ rowsWritten: 0, persistence: { skipped: true, skippedReason: "defillama-protocols-unavailable" } });
    for (const fn of [persistScores, pubTargets, compPrices, pubChall, writeHist]) expect(fn).not.toHaveBeenCalled();
  });

  it("records the failed critical source as the stage degraded reason", async () => {
    fx.reset({ primary: fx.primary({ dlProtocolsAvailable: false }) });
    const res = await stageSrc();
    expect(res.status).toBe("degraded"); expect(readMeta(res).reason).toBe("defillama-protocols-unavailable");
    const h = mkSqlite();
    try {
      await logCronRun(h.db, STG_JOB, async () => res);
      expect(h.sqlite.prepare("SELECT status, degraded_reason FROM cron_runs WHERE job = ?").get(STG_JOB)).toEqual({ status: "degraded", degraded_reason: "defillama-protocols-unavailable" });
    } finally { h.sqlite.close(); }
  });

  it("returns degraded when DL fails but Curve succeeds", async () => {
    vm(fetchSrcs).mockResolvedValueOnce(fx.primary({ curvePayloads: [{ data: { poolData: [] } }], dlYieldsAvailable: false, dlProtocolsAvailable: false }));
    const res = await runCycle();
    expect(res.status).toBe("degraded"); expect(readMeta(res).failedSources).toContain("defillama-yields");
    for (const fn of [persistScores, pubTargets, pubChall]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["COUNT(*) as cnt FROM dex_liquidity", "coverage-count-read-failed"],
    ["SELECT total_tvl_usd, updated_at", "global-tvl-read-failed"],
    ["ORDER BY total_tvl_usd DESC", "top-ten-read-failed"],
    ["FROM cron_runs", "cron-history-read-failed"],
    ["SELECT value, updated_at FROM cache WHERE key = ?", "anchor-review-decision-read-failed"],
    ["FROM dex_liquidity_run_rows r", "coin-tvl-read-failed"],
    ["ORDER BY g.started_at DESC, g.generation_id DESC", "coin-tvl-read-failed"],
  ])("retains accepted rows and generation when %s is unreadable", async (match, reason) => {
    const h = mkSqlite(), pend = reason === "coin-tvl-read-failed", unobs = match.startsWith("ORDER BY g.started_at");
    const revClk = pend ? vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-20T11:16:00Z")) : undefined;
    try {
      h.sqlite.prepare("INSERT INTO dex_liquidity_publication_generations (generation_id, started_at, state, expected_row_count, created_at) VALUES ('accepted', 1700000000, 'published', 2, 1700000000)").run();
      const ins = h.sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, liquidity_score, coverage_class, updated_at, publication_generation_id, publication_state) VALUES (?, 'USD', ?, 80, 'primary', 1700000000, 'accepted', 'published')");
      ins.run(USDT, 100); ins.run("__global__", 100);
      if (pend) {
        ins.run("susdat-saturn", 3e6);
        h.sqlite.exec(`INSERT INTO dex_liquidity_run_rows (generation_id, stablecoin_id, symbol, total_tvl_usd, updated_at, coverage_class) VALUES ('accepted', 'susdat-saturn', 'sUSDat', ${unobs ? 0 : 3000000}, 1700000000, '${unobs ? "unobserved" : "primary"}')`);
        fx.current.scores.scores.set("susdat-saturn", { coverageClass: "primary", tvl: 2_579_000 });
      }
      if (pend || reason === "anchor-review-decision-read-failed") {
        const insP = h.sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-dex-liquidity', ?, 1000, 'degraded', ?)");
        const anchor = js({ sourceCoverage: { poolRejectionCoverage: { reason: "material-pool-rejections", material: true, baselineBeforeSec: 1_794_741_390, baselineTvlUsdByCoin: { "susdat-saturn": 4_811_562.319125249 }, coins: [], coinsOmitted: 0 } } });
        insP.run(1699999999, anchor); insP.run(1700000000, anchor);
        const insS = h.sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-dex-liquidity', ?, 1000, 'degraded', '{\"persistence\":{\"skipped\":true}}')");
        for (let i = 1; i <= 12; i++) { insP.run(1700000001, '{"sourceCoverage":{"dlYieldsAvailable":"unavailable"}}'); insS.run(1700000000 + i * 3600); }
      }
      const failDb = mockD1([{ match, rows: [], throwError: new Error("baseline read failed") }]);
      const database = { ...h.db, prepare: (sql: string) => { if (!sql.includes(match)) return h.db.prepare(sql); if (reason !== "anchor-review-decision-read-failed") return failDb.prepare(sql); const st = h.db.prepare(sql); return { ...st, bind: (...b: unknown[]) => (b[0] === "dex-liquidity:anchor-review:2142" ? failDb.prepare(sql) : st).bind(...b) }; } };
      let res = await runCycle(database, GK);
      if (reason === "anchor-review-decision-read-failed") {
        expect(readMeta(res).sourceCoverage.baselineReadFailures).toEqual([reason]);
        const clk = vi.spyOn(Date, "now").mockReturnValue((1700000001 + 7 * 86_400) * 1e3);
        const prune = await pruneHistory(h.db); clk.mockRestore();
        expect(prune.status).toBe("ok"); expect(readMeta(prune).cronRunsDeleted).toBe(1);
        res = await runCycle(database, GK);
      }
      const m = readMeta(res);
      expect(res.status).toBe("degraded");
      expect(m).toMatchObject({ reason: "required-baseline-read-failed", rowsWritten: 0, sourceCoverage: { baselineReadFailures: [reason] }, persistence: { skipped: true, skippedReason: "required-baseline-read-failed" } });
      expect(MetaSchema.safeParse(m).success).toBe(true);
      expect(h.sqlite.prepare("SELECT stablecoin_id, total_tvl_usd, updated_at, publication_generation_id FROM dex_liquidity ORDER BY stablecoin_id").all()).toEqual([
        { stablecoin_id: "__global__", total_tvl_usd: 100, updated_at: 1.7e9, publication_generation_id: "accepted" },
        ...(pend ? [{ stablecoin_id: "susdat-saturn", total_tvl_usd: 3e6, updated_at: 1.7e9, publication_generation_id: "accepted" }] : []),
        { stablecoin_id: USDT, total_tvl_usd: 100, updated_at: 1.7e9, publication_generation_id: "accepted" },
      ]);
      for (const fn of [persistScores, pubTargets, compPrices, writeHist, markConsumed]) expect(fn).not.toHaveBeenCalled();
    } finally { revClk?.mockRestore(); h.sqlite.close(); }
  });

  it.each([["GROUP BY coverage_class", "coverage-classes-read-failed"], ["SELECT stablecoin_id, pool_count", "watchlist-read-failed"], ["FROM dex_liquidity_run_rows r", "coin-tvl-read-failed"]])(
    "does not turn optional %s telemetry into a publication hold",
    async (match, reason) => {
      const failDb = mockD1([{ match, rows: [], throwError: new Error("optional baseline unavailable") }]);
      const res = await runCycle({ ...db, prepare: (sql: string) => sql.includes(match) ? failDb.prepare(sql) : db.prepare(sql) }, GK);
      expect(res.status).toBe("ok"); expect(readMeta(res).sourceCoverage.baselineReadFailures).toEqual([reason]);
      expect(persistScores).toHaveBeenCalledOnce(); expect(pubTargets).toHaveBeenCalledOnce();
    },
  );

  it("degrades and skips persistence instead of tripping hard value guard when DL yields is unavailable", async () => {
    vm(fetchSrcs).mockResolvedValueOnce(fx.primary({ dexProjects: new Set(["curve"]), curvePayloads: [{ data: { poolData: [] } }], dlYieldsAvailable: false }));
    vm(compScores).mockResolvedValueOnce(fx.scored({ scores: new Map([[USDT, { coverageClass: "primary", tvl: 2e9 }]]), globalAgg: { totalTvl: 2e9 }, diagnostics: fx.diagnostics() }) as unknown as Awaited<ReturnType<typeof compScores>>);
    const gdb = guardDb([
      { match: "COUNT(*) as cnt FROM dex_liquidity", rows: [], first: { cnt: 165 } },
      { match: "SELECT total_tvl_usd, updated_at, chain_tvl_json FROM dex_liquidity WHERE stablecoin_id = '__global__'", rows: [], first: { total_tvl_usd: 6e9, updated_at: 1_777_556_412 } },
      { match: "GROUP BY coverage_class", rows: [] }, { match: "ORDER BY total_tvl_usd DESC", rows: [{ stablecoin_id: USDT, total_tvl_usd: 4e9 }] },
      { match: "SELECT r.stablecoin_id, r.total_tvl_usd, r.protocol_tvl_json", rows: [] }, { match: "FROM cron_runs", rows: [] }, { match: "WHERE stablecoin_id IN", rows: [] },
    ], { batch: db.batch, exec: db.exec, dump: db.dump });
    const res = await runCycle(gdb, GK), m = readMeta(res);
    expect(res.status).toBe("degraded"); expect(m.failedSources).toContain("defillama-yields");
    expect(m).toMatchObject({ rowsWritten: 0, persistence: { skipped: true, skippedReason: "defillama-yields-unavailable" }, sourceCoverage: { currentGlobalTvl: 2e9, nearValueGuard: true, nearCoverageGuard: true, hardCoverageGuard: true } });
    for (const fn of [persistScores, pubTargets, compPrices, pubChall]) expect(fn).not.toHaveBeenCalled();
  });

  it.each(["critical-source", "coverage", "value", "persistence"] as const)("retains the measured target catalog after %s rejection and publishes only after accepted liquidity", async (rej) => {
    let cat = "accepted-targets";
    vm(pubTargets).mockImplementationOnce(async () => { cat = "candidate-targets"; });
    if (rej === "critical-source") fx.current.primary.dlYieldsAvailable = false;
    if (rej === "persistence") vm(persistScores).mockRejectedValueOnce(new Error("liquidity publication failed"));
    const gdb = guardDb([
      { match: "SELECT coverage_class, COUNT(*) as cnt", rows: [] }, { match: "COUNT(*) as cnt FROM dex_liquidity", rows: [], first: { cnt: rej === "coverage" ? 100 : 0 } },
      { match: "SELECT total_tvl_usd, updated_at, chain_tvl_json FROM dex_liquidity WHERE stablecoin_id = '__global__'", rows: [], first: rej === "value" ? { total_tvl_usd: 1e9, updated_at: 1_777_556_412 } : { total_tvl_usd: null, updated_at: null } },
      { match: "GROUP BY coverage_class", rows: [] }, { match: "ORDER BY total_tvl_usd DESC", rows: [] }, { match: "FROM cron_runs", rows: [] },
      { match: "WHERE stablecoin_id IN", rows: [] }, { match: "SELECT r.stablecoin_id, r.total_tvl_usd, r.protocol_tvl_json", rows: [] },
    ]);
    if (rej === "critical-source") expect((await runCycle(gdb, GK)).status).toBe("degraded");
    else await expect(runCycle(gdb, GK)).rejects.toThrow(rej === "persistence" ? "liquidity publication failed" : "coverage guard tripped");
    expect(cat).toBe("accepted-targets"); expect(pubTargets).not.toHaveBeenCalled();
    fx.reset(); expect((await runCycle()).status).toBe("ok"); expect(cat).toBe("candidate-targets"); expect(pubTargets).toHaveBeenCalledOnce();
    expect(vm(pubTargets).mock.invocationCallOrder[0]).toBeGreaterThan(vm(persistScores).mock.invocationCallOrder.slice(-1)[0]!);
  });

  it("publishes successful source inputs without direct CEX depth traffic or metadata", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch"), res = await runCycle(), m = readMeta(res);
    expect(res.status).toBe("ok");
    expect(m).toMatchObject({ failedSources: [], stagedPoolsSkippedByExactIdentity: 0, stagedPoolsSkippedByUniqueDerivedIdentity: 0, sourceCoverage: { nearCoverageGuard: false, weakCoverageCoins: 0, qualityDriftSeverity: "none", qualityDriftFlags: [], coinsWithoutMeasuredBalances: 0, protocolTvlQuarantine: { tvlUsd: 0 } } });
    expect(m.sourceCoverage).not.toHaveProperty("directCexOrderbookDepth"); expect(fetchSpy).not.toHaveBeenCalled();
    expect(persistScores).toHaveBeenCalledWith(expect.objectContaining({ prepare: expect.any(Function), batch: expect.any(Function) }), expect.any(Map), fx.current.scores.scores, fx.current.scores.globalAgg, expect.any(Number), fx.current.scores.tvlStabilityMap, undefined, fx.current.scores.diagnostics.routeRemovalEvidence, fx.current.scores.retainedPoolsByStablecoin, undefined, undefined);
  });

  it("carries partial-source telemetry through the stage into consumer metadata", async () => {
    vm(fetchCake).mockResolvedValueOnce(apiRes([], { degraded: true, errors: ["bsc: The operation was aborted due to timeout"], degradedChains: ["bsc"] }));
    const sRes = await stageSrc(), sq = qualReasons(readMeta(sRes));
    expect(readMeta(sRes).directApiSourceSummary.sourceWarnings).toEqual(["pancakeswap-api: bsc: The operation was aborted due to timeout"]);
    expect(sRes.status).toBe("ok"); expect(sq).toEqual(["source-partial:pancakeswap-api:bsc", "direct-api-source-warnings"]);
    const m = readMeta(await consumeStageFn(db));
    expect(m).toMatchObject({ degradedSources: ["pancakeswap-api:bsc"], failedSources: [] }); expect(qualReasons(m)).toEqual(sq);
  });

  it("reports failed optional stage sources as findings without failing successful staging", async () => {
    fx.reset({ uniswapV4: { uniswapV4ExecutionCandidates: new Map(), failedChains: ["ethereum", "arbitrum"], chainFailures: [], exactAnsweredPoolIdsByChain: new Map() } });
    const res = await stageSrc();
    expect(res.status).toBe("ok"); expect(qualReasons(readMeta(res))).toEqual(["source-failed:uniswap-v4-subgraph:ethereum", "source-failed:uniswap-v4-subgraph:arbitrum"]);
  });

  it("loads the source slot derived from the registered stage and consumer offsets", async () => {
    await stageSrc();
    const atMs = Date.parse("2026-09-22T12:16:00Z"), cSlot = slotAt("halfHourlyChartsOffset", atMs), sSlot = slotAt("halfHourlyOffset", atMs);
    await consumeStageFn(db, undefined, undefined, cSlot);
    expect(cSlot - STAGE_LEAD).toBe(sSlot);
    expect(loadStageReady).toHaveBeenLastCalledWith(expect.objectContaining({ prepare: expect.any(Function), batch: expect.any(Function) }), expect.objectContaining({ expectedSourceSlotStartedAt: sSlot }), undefined);
  });

  it("publishes active and shadow measured targets during the daily inventory cycle", async () => {
    await runCycle(db, GK, undefined, undefined, undefined, undefined, { publishShadowTargets: true });
    expect(vm(compScores).mock.lastCall?.[8]).toBe("active-and-shadow");
  });

  it("accepts compacted production-scale primary rows while reporting raw counts", async () => {
    const rawPoolCount = 15_430, [tk] = buildSymbolLookups().chainAddressToId.keys(); expect(tk).toBeDefined();
    const sep = tk!.indexOf(":"), tracked = llamaPool({ pool: "tracked-pool", chain: tk!.slice(0, sep), project: "scale-dex", symbol: "TRACKED-QUOTE", tvlUsd: 1e6, volumeUsd1d: 5e4, volumeUsd7d: 3e5, underlyingTokens: [tk!.slice(sep + 1), "unknown-quote"] }), now = nowS();
    vm(fetchSrcs).mockResolvedValueOnce(fx.primary({ pools: [tracked], rawPoolCount, dexProjects: new Set(["scale-dex"]), curvePayloads: [{ readStartedAtSec: now - 1, generatedTimeMs: (now - 10) * 1e3 }, { readStartedAtSec: now - 1, generatedTimeMs: (now + 3600) * 1e3 }] }));
    const updates: CronProgressUpdate[] = [], res = await runCycle(db, GK, undefined, undefined, undefined, async (u) => { updates.push(u); });
    expect(vm(buildKnown).mock.lastCall?.[0]).toEqual([tracked]);
    expect(vm(procMetrics).mock.lastCall?.[0]?.pools).toEqual([tracked]);
    expect(readMeta(res)).toMatchObject({ rowsRead: rawPoolCount });
    expect(updates.find((u) => u.stage === "primary-sources-loaded")).toMatchObject({ metadata: { countTotals: { defillamaPools: rawPoolCount }, curveBulkReads: [{ chain: CURVE_CHAINS[0], readStartedAtSec: now - 1, cacheGeneratedAtSec: now - 10 }, { chain: CURVE_CHAINS[1], readStartedAtSec: now - 1, cacheGeneratedAtSec: null }] } });
    expect(updates.find((u) => u.stage === "pool-processing")).toMatchObject({ itemsTotal: rawPoolCount, metadata: { countTotals: { primaryPools: rawPoolCount, primaryPoolsRetained: 1 } } });
  });

  it("releases consumed source graphs before materializing staged pools", async () => {
    const ents = [...buildSymbolLookups().chainAddressToId], te = ents.find(([k, id]) => k.startsWith("ethereum:") && id === USDT), qe = ents.find(([k, id]) => k.startsWith("ethereum:") && id === USDC);
    expect(te).toBeDefined(); expect(qe).toBeDefined();
    const chain = "ethereum", addr = te![0].slice(9), qAddr = qe![0].slice(9);
    const srcData = fx.primary({ pools: [llamaPool({ pool: "primary-pool", chain, project: "memory-dex", symbol: "TRACKED-QUOTE", tvlUsd: 1e6, volumeUsd1d: 5e4, volumeUsd7d: 3e5, stablecoin: false, underlyingTokens: [addr, qAddr] })], rawPoolCount: 1, dexProjects: new Set(["memory-dex"]) });
    const dPool: DexApiPool = { source: "fluid", chain, poolAddress: "0x1111111111111111111111111111111111111111", poolType: "fluid-dex", tokens: [{ address: addr, symbol: "TRACKED", decimals: 18 }, { address: qAddr, symbol: "QUOTE", decimals: 18 }], price: 1, tvlUsd: 1e6, volume24hUsd: 5e4, feeRate: 0.0005, balances: [1e6, 1e6] };
    const dRes = apiRes([dPool], { pagination: { state: "partial", headRefreshed: true, pagesFetched: 5, cursor: "next-page", cycleCompleted: false } });
    const cRes = apiRes([{ ...dPool, source: "pancakeswap", poolAddress: "0x3333333333333333333333333333333333333333", poolType: "pancakeswap-v3" }]);
    const curvePoolMap = new Map([["curve-key", {} as never]]), uniV3PoolFees = new Map([["fee-key", 500]]), uniV3ExecutionCandidates = new Map([["candidate-key", []]]);
    vm(fetchFluid).mockResolvedValueOnce(dRes); vm(fetchCake).mockResolvedValueOnce(cRes); vm(fetchRay).mockResolvedValueOnce(apiRes([], { warnings: ["release-warning"] }));
    vm(fetchSrcs).mockImplementationOnce(async () => {
      for (const fn of [fetchFluid, fetchBal, fetchCake, fetchMet, fetchRay, fetchOrca, fetchSlip]) expect(fn).toHaveBeenCalledOnce();
      expect([dRes.pools, cRes.pools]).toEqual([[], []]);
      return srcData;
    });
    vm(buildCurve).mockResolvedValueOnce({ curvePoolMap, curvePoolCandidatesByFingerprint: new Map(), curveBelowFloorTwinFingerprints: new Set(), priceObservations: new Map() });
    vm(fetchV3).mockResolvedValueOnce({ uniV3PoolFees, uniV3SymbolFees: new Map(), uniV3PriceObs: new Map(), uniV3ExecutionCandidates, failedChains: [], failedChainReasons: {}, chainFailures: [] });
    vm(mergeStaged).mockImplementationOnce(async (_db, m, _k, now, _t, _r, conf, _c, _s, obs) => {
      expect([srcData.pools, srcData.dexProjects.size, dRes.pools, cRes.pools, curvePoolMap.size, uniV3PoolFees.size, uniV3ExecutionCandidates.size]).toEqual([[], 0, [], [], 1, 1, 1]);
      expect(conf?.enforcedChainsByProtocol.get("fluid")).toBeUndefined(); expect(conf?.confirmedExactKeysByProtocol.get("fluid")).toBeUndefined();
      return { ...fx.stagedPools(), stagedWriteback: buildWb(m, now), observedThisRun: priceRef.captureObservedPoolPrices({ metrics: m, priceObservations: obs }, now) };
    });
    const startedAt = nowS(), res = await runCycle();
    expect(mergeStaged).toHaveBeenCalledOnce();
    const targets = [...vm(compScores).mock.lastCall![5]!.values()];
    expect(targets).toContainEqual(expect.objectContaining({ stablecoinId: USDT, adapterProfileId: "pancakeswap-v3-quoter-v2", poolId: "ethereum:0x3333333333333333333333333333333333333333", poolTokenAddresses: [addr, qAddr], tokenIn: expect.objectContaining({ address: addr, trackedAssetId: USDT }), tokenOut: expect.objectContaining({ address: qAddr, trackedAssetId: USDC }), feePips: 500, retainedTvlUsd: 1e6, capturedAt: expect.any(Number) }));
    expect(targets.every((t) => t.capturedAt >= startedAt)).toBe(true);
    const m = readMeta(res);
    expect(m.directApiSourceSummary?.sourceWarnings).toContain("raydium-api: release-warning");
    expect(m.directApiSourceSummary?.pagination).toContainEqual({ source: "fluid-dex-api", state: "partial", headRefreshed: true, pagesFetched: 5, cursor: "next-page", cycleCompleted: false });
  });

  it("keeps the run ok when an optional direct API source is unavailable but coverage stays intact", async () => {
    vm(fetchRay).mockResolvedValueOnce(apiRes([], { ok: false, degraded: true, errors: ["query poolType type error"] }));
    const res = await runCycle(), m = readMeta(res);
    expect(res.status).toBe("ok"); expect(m.failedSources).toContain("raydium-api"); expect(m.fallbackMode).toContain("raydium-api-unavailable");
    expect(m.sourceCoverage?.sourceDegradedFamilies).toEqual([]); expect(persistScores).toHaveBeenCalled();
  });

  it("carries BSC Uniswap V3 direct candidates into the shadow target accumulator", async () => {
    vm(fetchBscSh).mockResolvedValueOnce(apiRes([apiPool({ source: "uniswap-v3-shadow", chain: "bsc", poolAddress: "0xf150d29d92e7460a1531cbc9d1abeab33d6998e4", poolType: "uniswap-v3", tokens: [{ address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18 }, { address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", symbol: "USD1", decimals: 18 }], tvlUsd: 2e6, volume24hUsd: 5e4, balances: [1e6, 1e6] })]));
    await runCycle();
    expect([...vm(compScores).mock.lastCall![7]!.values()]).toContainEqual(expect.objectContaining({ stablecoinId: USDT, adapterProfileId: "uniswap-v3-quoter-v2", chain: "bsc", poolId: "bsc:0xf150d29d92e7460a1531cbc9d1abeab33d6998e4", feePips: 100, retainedTvlUsd: 2e6 }));
  });

  it("waits for direct API fetches before loading primary and subgraph sources", async () => {
    const gate = deferred<ReturnType<typeof directRes>>(), entered = deferred<void>();
    vm(fetchFluid).mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const p = runCycle();
    try { await entered.promise; expect(fetchSrcs).not.toHaveBeenCalled(); expect(fetchV3).not.toHaveBeenCalled(); }
    finally { gate.resolve(directRes()); await p; }
    expect(fetchSrcs).toHaveBeenCalledOnce(); expect(fetchV3).toHaveBeenCalledOnce();
  });

  it("threads tracked stablecoin cache prices into direct API conversion and observations", async () => {
    let conv: Map<string, number> | undefined, obs: Map<string, number> | undefined;
    vm(loadCache).mockResolvedValueOnce({ kind: "ok", updatedAt: 123, payload: { peggedAssets: [mkCoin(USDC, "USDC", 0.97), mkCoin(USDT, "USDT", 1.01), mkCoin("ignored-zero", "ZERO", 0)] } });
    vm(fetchFluid).mockResolvedValueOnce(apiRes([apiPool({ poolType: "fluid-dex", tvlUsd: 5e5, volume24hUsd: 12e4, balances: [25e4, 25e4] })]));
    vm(convGt).mockImplementationOnce((...a) => { conv = new Map(a[4]); return new Map([[USDC, []]]); });
    vm(extObs).mockImplementationOnce((...a) => { obs = new Map(a[4]); return new Map([[USDC, []]]); });
    await runCycle();
    for (const m of [conv, obs]) { expect(m).toBeInstanceOf(Map); expect([...(m?.entries() ?? [])]).toEqual([[USDC, 0.97], [USDT, 1.01]]); }
  });

  it.each([[false, true], [true, false], [true, true]])("requires both clocks to retain ratio prices (market %s, ratio %s)", async (hasMark, hasClk) => {
    const now = 1.79e9, obsAt = now - 60, adm = hasMark && hasClk;
    vi.spyOn(Date, "now").mockReturnValue(now * 1e3); fx.current.stagedPools.registryEvaluatedAtSec = now;
    let observations: unknown; const snap: { pool?: PoolEntry } = {}, origS = vm(compScores).getMockImplementation()!, origP = vm(compPrices).getMockImplementation()!;
    vm(compScores).mockImplementationOnce(async (...a) => { snap.pool = structuredClone(a[1].get(USDC)?.pools.find((p) => p.source === "direct_api")); return origS(...a); });
    vm(compPrices).mockImplementationOnce(async (...a) => { observations = structuredClone(a[0].exactPriceEvidenceByStablecoin?.get(USDC)); return origP(...a); });
    vi.spyOn(priceVal, "loadPriceValidationReferences").mockResolvedValueOnce({ rates: { peggedEUR: 1.25 }, type: "fresh", updatedAt: now });
    const cp = { stablecoinId: "eurc-circle", priceUsd: 1.25, observedAtSec: obsAt, observedAtMode: "upstream", source: "kraken+coinbase" };
    if (hasMark) vm(loadCache).mockResolvedValueOnce({ kind: "ok", updatedAt: now, payload: { peggedAssets: [{ ...mkCoin("eurc-circle", "EURC", 1.25), priceSource: "kraken+coinbase", priceConfidence: "high", agreeSources: ["kraken", "coinbase"], priceObservedAt: obsAt }] } });
    vm(convGt).mockImplementation(poolShaping.convertToGtNewPools); vm(extObs).mockImplementation(poolShaping.extractPriceObservations);
    vm(fetchFluid).mockResolvedValueOnce(apiRes([apiPool({ tokens: [{ address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 }, { address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", symbol: "EURC", decimals: 6 }], price: 0.8, ratioObservedAtSec: hasClk ? now - 20 : undefined, tvlUsd: 1e6, volume24hUsd: 1e5, balances: [5e5, 4e5] })]));
    await runCycle();
    expect(observations).toEqual(adm ? [expect.objectContaining({ price: expect.closeTo(1), observedAt: obsAt, counterpartyPrice: cp })] : undefined);
    const conv = vm(convGt).mock.results.flatMap((r) => r.type === "return" ? r.value.get(USDC) ?? [] : []);
    expect(conv).toEqual([expect.objectContaining({ address: "0x1111111111111111111111111111111111111111", tvlUsd: 1e6, price: adm ? expect.closeTo(1) : 0, priceObservedAt: adm ? obsAt : null, measurement: expect.objectContaining({ tvlMeasured: true, priceMeasured: adm }) })]);
    expect(conv[0]?.priceCounterparty).toEqual(adm ? cp : undefined);
    expect(snap.pool).toMatchObject({ source: "direct_api", tvlUsd: 1e6 });
    expect(snap.pool?.price).toEqual(adm ? expect.closeTo(1) : undefined); expect(snap.pool?.priceObservedAt).toBe(adm ? obsAt : undefined); expect(snap.pool?.priceCounterparty).toEqual(adm ? cp : undefined);
  });

  it("records drift and evidence telemetry when previous run metadata exists", async () => {
    vm(fetchSrcs).mockResolvedValueOnce(fx.primary({ protocolTvlCaps: new Map([["curve", 50]]) }));
    vm(fetchFluid).mockResolvedValueOnce(apiRes([apiPool({ poolAddress: "0xfluid-pool", balances: [5e10, 5e10] })]));
    vm(extObs).mockReturnValueOnce(new Map([[USDC, [{ sourceFamily: "gecko_terminal", price: 1, tvl: 100, chain: "Ethereum", protocol: "curve" }]]]));
    vm(compScores).mockResolvedValueOnce(fx.scored({
      scores: new Map([[USDC, { coverageClass: "fallback", coverageConfidence: 0.55, tvl: 100, balanceMeasuredTvlUsd: 0, sourceMix: { gecko_terminal: { poolCount: 1, tvlUsd: 100 } } }]]),
      globalAgg: { totalTvl: 100 }, retainedPoolsByStablecoin: new Map([[USDC, [{ source: "gecko_terminal", tvlUsd: 100, project: "curve", extra: { measurement: { balanceMeasured: false } } }]]]),
      diagnostics: fx.diagnostics({ protocolTvlQuarantine: { reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, protocolCount: 1, tvlUsd: 50 }, globalProtocolOverCapUsd: 60 }),
    }) as unknown as Awaited<ReturnType<typeof compScores>>);
    const driftDb = guardDb([
      { match: "COUNT(*) as cnt FROM dex_liquidity", rows: [], first: { cnt: 5 } },
      { match: "SELECT total_tvl_usd, updated_at, chain_tvl_json FROM dex_liquidity WHERE stablecoin_id = '__global__'", rows: [], first: { total_tvl_usd: 100 } },
      { match: "GROUP BY coverage_class", rows: [] }, { match: "ORDER BY total_tvl_usd DESC", rows: [{ stablecoin_id: USDC, total_tvl_usd: 100 }] },
      { match: "SELECT r.stablecoin_id, r.total_tvl_usd, r.protocol_tvl_json", rows: [] },
      { match: "SELECT started_at, status, metadata", alsoMatch: "cron_runs", rows: [{ started_at: 1, status: "ok", metadata: js({ stagedPoolsMerged: 10, stagedPoolsSkipped: 0, sourceCoverage: { dlYieldsAvailable: true, dlProtocolsAvailable: true, currentGlobalTvl: 100, priceObservationCoins: 5, measuredBalanceCoveragePct: 0.5, weakCoverageCoins: 0, qualityDriftCandidates: [{ flag: "price-observation-drop", consecutiveRuns: 1, baselineValue: 5, observedValue: 1 }, { flag: "measured-balance-drop", consecutiveRuns: 1, baselineValue: 0.5, observedValue: 0 }, { flag: "watchlist-pool-drop:usdc-circle", consecutiveRuns: 1, baselineValue: 5, observedValue: 1 }] } }) }] },
      { match: "WHERE stablecoin_id IN", rows: [{ stablecoin_id: USDC, pool_count: 5, coverage_confidence: 0.9, total_tvl_usd: 100, balance_measured_tvl_usd: 50 }] },
    ], { batch: db.batch, exec: db.exec, dump: db.dump });
    const m = readMeta(await runCycle(driftDb, GK));
    expect(m.sourceCoverage).toMatchObject({ qualityDriftSeverity: "high", coinsWithoutMeasuredBalances: 1, coinsGtOnly: 1, coinsCrawlerOnly: 1, coinsPriceOnlyNoMeasuredLiquidity: 1 });
    expect(m.sourceCoverage?.qualityDriftFlags).toEqual(expect.arrayContaining(["price-observation-drop", "measured-balance-drop", "watchlist-pool-drop:usdc-circle"]));
    expect(MetaSchema.parse(m).sourceCoverage).toMatchObject({ globalProtocolOverCapUsd: 60, protocolTvlQuarantine: { reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, protocolCount: 1, tvlUsd: 50 } });
    expect(m.sourceCoverage?.topAssetCoverageDeltas).toEqual([[USDC, -0.8], [USDT, null], ["dai-makerdao", null], ["usds-sky", null], ["usde-ethena", null]].map(([stablecoinId, poolCountPctDelta]) => expect.objectContaining({ stablecoinId, poolCountPctDelta })));
  });
});

describe("dex liquidity stage same-hour recovery", () => {
  const openDbs: DatabaseSync[] = [], schedMs = Date.parse("2026-09-23T15:16:00Z");
  const cSlot = slotAt("halfHourlyChartsOffset", schedMs), sSlot = cSlot - STAGE_LEAD, hSlot = slotAt("halfHourlyChartsOffset", Date.parse("2026-09-23T15:46:00Z"));
  let h: { sqlite: DatabaseSync; db: D1Database }, realStg: typeof import("../dex-liquidity/scoring-stage");
  beforeAll(async () => { realStg = await vi.importActual<typeof import("../dex-liquidity/scoring-stage")>("../dex-liquidity/scoring-stage"); });
  const consume = (opts?: Parameters<typeof consumeStageFn>[4], slot = cSlot, sig?: AbortSignal) => consumeStageFn(h.db, sig, undefined, slot, opts);
  const recErr = () => h.sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, slot_started_at) VALUES ('sync-dex-liquidity-stage', ?, 83449, 'error', ?)").run(sSlot + 13, sSlot);
  const recLease = (until = Math.floor(schedMs / 1e3) + 300) => h.sqlite.prepare("INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at) VALUES ('sync-dex-liquidity-stage', 'stage-owner', ?, ?, ?)").run(until, Math.floor(schedMs / 1e3), Math.floor(schedMs / 1e3));
  const usePoll = () => { vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(schedMs); };
  const stageHr = () => stageFn(h.db, GK, undefined, undefined, undefined, undefined, sSlot);
  const stgState = () => h.sqlite.prepare("SELECT state FROM dex_liquidity_scoring_stages WHERE source_slot_started_at = ?").get(sSlot);
  const cntTbl = (t: string) => h.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${t}`).get();

  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const s of openDbs.splice(0)) s.close(); });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(schedMs); vi.clearAllMocks(); fx.reset();
    vm(loadGenId).mockResolvedValue(null);
    vm(persistStage).mockImplementation(realStg.persistDexLiquidityScoringStage); vm(loadStage).mockImplementation(realStg.loadDexLiquidityScoringStage);
    vm(loadStageReady).mockImplementation(realStg.loadDexLiquidityScoringStageWhenReady); vm(markConsumed).mockImplementation(realStg.markDexLiquidityScoringStageConsumed);
    h = mkSqlite(); openDbs.push(h.sqlite);
  });

  it("consumes ready output once across both ticks and retries of :16", async () => {
    const ref = vi.spyOn(priceRef, "refreshPoolPrices");
    await stageHr(); await consume();
    vm(loadGenId).mockResolvedValue(`dex-liquidity-${Math.floor(schedMs / 1e3)}`);
    for (const slot of [cSlot, hSlot]) { const r = await consume(undefined, slot); expect(r.status).toBe("skipped_neutral"); expect(readMeta(r).reason).toBe("liquidity-cadence-reuse"); }
    expect(persistScores).toHaveBeenCalledOnce(); expect(markConsumed).toHaveBeenCalledOnce(); expect(ref).toHaveBeenCalledOnce();
  });

  it("reuses accepted output when the consumed marker failed without rescoring", async () => {
    await stageHr(); vm(markConsumed).mockRejectedValueOnce(new Error("marker unavailable")); await consume();
    vm(loadGenId).mockResolvedValue(`dex-liquidity-${Math.floor(schedMs / 1e3)}`);
    expect((await consume(undefined, hSlot)).status).toBe("skipped_neutral"); expect(persistScores).toHaveBeenCalledOnce();
  });

  it("skips an incompatible v9 stage before publication", async () => {
    await stageHr();
    h.sqlite.exec("UPDATE dex_liquidity_scoring_stage_chunks SET payload_json = replace(payload_json, '\"schemaVersion\":11', '\"schemaVersion\":9'), payload_bytes = payload_bytes - 1 WHERE chunk_index = 0; UPDATE dex_liquidity_scoring_stages SET payload_bytes = payload_bytes - 1;");
    const res = await consume();
    expect(res.status).toBe("skipped_neutral");
    expect(readMeta(res)).toMatchObject({ reason: "scoring-stage-payload-version-mismatch", payloadVersion: 9, persistence: { generationId: null, skipped: true, publicationStarted: false } });
    expect(persistScores).not.toHaveBeenCalled(); expect(markConsumed).not.toHaveBeenCalled();
  });

  it("leaves a source ready when a candidate is rejected by source guards", async () => {
    vm(fetchSrcs).mockResolvedValueOnce({ ...fx.current.primary, dlProtocolsAvailable: false });
    await stageHr(); await consume();
    expect(markConsumed).not.toHaveBeenCalled(); expect(stgState()).toEqual({ state: "ready" });
  });

  it.each([
    ["refuses recovery after its inherited invocation deadline before claiming the source lease", 9e5, "invocation-deadline-exhausted"],
    ["refuses recovery with only consumer headroom before claiming the source lease", CRON_TIMEOUT_MS["sync-dex-liquidity"]! - 12e4, "consumer-headroom-exhausted"],
  ])("%s", async (_l, ageMs, reason) => {
    recErr();
    await expect(consume({ deadline: createSlotDeadline(Date.now() - ageMs), stageRecovery: { graphApiKey: "heavy-graph-key" } })).rejects.toThrow(reason);
    expect(fetchSrcs).not.toHaveBeenCalled(); expect(cntTbl("cron_leases")).toEqual({ count: 0 });
  });

  it.each(["publication", "reuse"] as const)("passes the %s event deadline through recovery without using the old source slot", async (mode) => {
    recErr(); if (mode === "reuse") vi.setSystemTime(hSlot * 1e3);
    const dl = createSlotDeadline(Date.now() - 12e4);
    const spies = [vi.spyOn(v2Enrich, "enrichEvmV2ExecutionModels"), vi.spyOn(quoterEnrich, "enrichQuoterV2ExecutionTargets"), vi.spyOn(v4Enrich, "enrichUniswapV4ExecutionTargets")];
    await consume({ deadline: dl, stageReadyDeadlineMs: Date.now() + 9e4, stageRecovery: { graphApiKey: GK } }, mode === "publication" ? cSlot : hSlot);
    for (const s of spies) {
      expect(s).toHaveBeenCalledTimes(1);
      expect(s.mock.calls[0]![0].deadline).toMatchObject({ eventEntryMs: dl.eventEntryMs, platformDeadlineMs: Math.min(dl.latestAdmissionMs(0, 12e4), dl.eventEntryMs + CRON_TIMEOUT_MS["sync-dex-liquidity"]! - 12e4) });
    }
    expect(dl.eventEntryMs).not.toBe(sSlot * 1e3);
  });

  it("re-runs an errored source stage inline and publishes with recovery metadata", async () => {
    recErr();
    const res = await consume({ stageReadyDeadlineMs: schedMs + 9e4, stageRecovery: { graphApiKey: GK } });
    expect(res.status).toBe("ok");
    expect(readMeta(res)).toMatchObject({ stageRecovery: { reason: "stage-run-errored", sourceSlotStartedAt: sSlot, generationId: `dex-liquidity-scoring-stage:${sSlot}`, stageResult: { status: "ok", metadata: { graphApiKeyConfigured: true, targetEnrichment: [] } } }, measuredTargetFunnel: { stageOrigin: "recovery", graphApiKeyConfigured: true }, priceRefresh: { requests: 0 } });
    expect(stgState()).toEqual({ state: "consumed" });
    expect(h.sqlite.prepare("SELECT lease_until FROM cron_leases WHERE job = 'sync-dex-liquidity-stage'").get()).toBeUndefined();
  });

  it("re-runs a failed stage generation inline instead of waiting out the deadline", async () => {
    await stageHr(); h.sqlite.prepare("UPDATE dex_liquidity_scoring_stages SET state = 'failed' WHERE source_slot_started_at = ?").run(sSlot);
    const res = await consume({ stageReadyDeadlineMs: schedMs + 9e4, stageRecovery: { graphApiKey: GK } });
    expect(res.status).toBe("ok"); expect(readMeta(res).stageRecovery).toMatchObject({ reason: "stage-generation-failed", sourceSlotStartedAt: sSlot });
  });

  it("recovers a never-started stage once the readiness deadline has passed", async () => {
    const res = await consume({ stageReadyDeadlineMs: schedMs - 1, stageRecovery: { graphApiKey: GK } });
    expect(res.status).toBe("ok"); expect(readMeta(res).stageRecovery).toMatchObject({ reason: "stage-missing", sourceSlotStartedAt: sSlot });
  });

  it.each([null, "", "   "])("refuses misconfigured caller recovery without Graph (%j), not a heavy role restriction", async (graphApiKey) => {
    await expect(consume({ stageReadyDeadlineMs: schedMs - 1, stageRecovery: { graphApiKey } })).rejects.toThrow("missing-graph-api-key");
    for (const fn of [fetchSrcs, persistScores, pubTargets]) expect(fn).not.toHaveBeenCalled();
    for (const t of ["dex_liquidity_scoring_stages", "dex_liquidity_scoring_stage_chunks", "cron_leases"]) expect(cntTbl(t)).toEqual({ count: 0 });
  });

  it.each([1, 1e4])("carries compaction quarantine across real stage serialization into consumer quality (TVL=%s)", async (tvlUsd) => {
    fx.reset(); vm(fetchSrcs).mockResolvedValueOnce({ ...fx.current.primary, poolRejections: [{ reason: "invalid-pool-identity", poolIds: ["malformed-primary"], count: 1, tvlUsd }] });
    await stageHr();
    const res = await consume({ stageReadyDeadlineMs: schedMs - 1, stageRecovery: { graphApiKey: null } });
    expect(res.status).toBe(tvlUsd >= 1e4 ? "degraded" : "ok");
    expect(readMeta(res)).toMatchObject({ poolRejections: [], poolRejectionMateriality: { rejectedPoolCount: 1, rejectedPoolTvlUsd: tvlUsd, material: tvlUsd >= 1e4 ? null : false } });
  });

  it("consumes a ready source stage without requiring recovery credentials", async () => {
    await stageHr(); vm(fetchSrcs).mockClear();
    const res = await consume({ stageReadyDeadlineMs: schedMs - 1, stageRecovery: { graphApiKey: null } });
    expect(res.status).toBe("ok"); expect(fetchSrcs).not.toHaveBeenCalled(); expect(pubTargets).toHaveBeenCalledOnce(); expect(stgState()).toEqual({ state: "consumed" });
  });

  it("recovers inline with heavy's configured Graph key at the half-hour tick", async () => {
    recErr(); vi.setSystemTime(hSlot * 1e3);
    const res = await consume({ stageRecovery: { graphApiKey: "heavy-graph-key" } }, hSlot);
    expect(res.status).toBe("ok"); expect(fetchSrcs).toHaveBeenCalled(); expect(pubTargets).toHaveBeenCalledOnce();
    expect(readMeta(res).stageRecovery).toMatchObject({ reason: "stage-run-errored" }); expect(stgState()).toEqual({ state: "consumed" });
  });

  it("fails fast with a machine-readable reason when a terminal stage has no recovery", async () => {
    recErr();
    await expect(consume({ stageReadyDeadlineMs: schedMs + 9e4 })).rejects.toThrow(`DEX liquidity scoring stage run errored for source slot ${sSlot}`);
    expect(cntTbl("dex_liquidity_scoring_stages")).toEqual({ count: 0 });
  });

  it("returns a nonproductive producer-running neutral at the unchanged readiness deadline", async () => {
    usePoll(); recLease(); let done = false;
    const pend = consume({ stageReadyDeadlineMs: schedMs + 9e4, stageRecovery: { graphApiKey: null } }).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(89_999); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const res = await pend;
    expect(Date.now()).toBe(schedMs + 9e4);
    expect(res).toMatchObject({ status: "skipped_neutral", itemCount: 0, productivity: { productive: false, reason: "scoring-stage-producer-running" } });
    expect(readMeta(res)).toMatchObject({ reason: "scoring-stage-producer-running", sourceSlotStartedAt: sSlot, readinessDeadlineMs: schedMs + 9e4, persistence: { generationId: null, skipped: true, skippedReason: "scoring-stage-producer-running" }, d1Cost: { coverage: "partial" } });
    expect(readMeta(res).d1Cost.bindingCalls).toBeGreaterThan(0);
    for (const fn of [fetchSrcs, persistScores, pubTargets, markConsumed]) expect(fn).not.toHaveBeenCalled();
    for (const t of ["dex_liquidity_scoring_stages", "dex_liquidity_scoring_stage_chunks", "dex_liquidity"]) expect(cntTbl(t)).toEqual({ count: 0 });
    expect(h.sqlite.prepare("SELECT lease_owner FROM cron_leases WHERE job = 'sync-dex-liquidity-stage'").get()).toEqual({ lease_owner: "stage-owner" });
  });

  it.each(["absent", "expired"] as const)("does not classify an %s producer lease as a live wait", async (lease) => {
    usePoll(); if (lease === "expired") recLease(Math.floor(schedMs / 1e3) + 60);
    const rej = expect(consume({ stageReadyDeadlineMs: schedMs + 9e4 })).rejects.toBeInstanceOf(MissingStageErr);
    await vi.advanceTimersByTimeAsync(9e4); await rej;
    expect(Date.now()).toBe(schedMs + 9e4); expect(fetchSrcs).not.toHaveBeenCalled(); expect(persistScores).not.toHaveBeenCalled();
    expect(cntTbl("dex_liquidity_scoring_stages")).toEqual({ count: 0 });
  });

  it("keeps producer probe failures as errors instead of neutral waits", async () => {
    h.sqlite.exec("DROP TABLE cron_leases");
    await expect(consume({ stageReadyDeadlineMs: schedMs - 1 })).rejects.toThrow("no such table: cron_leases");
    expect(fetchSrcs).not.toHaveBeenCalled(); expect(persistScores).not.toHaveBeenCalled();
  });

  it("propagates cancellation during a live producer wait without publishing", async () => {
    usePoll(); recLease(); const ctrl = new AbortController(), fail = new Error("slot budget exhausted");
    const rej = expect(consume({ stageReadyDeadlineMs: schedMs + 9e4, stageRecovery: { graphApiKey: GK } }, cSlot, ctrl.signal)).rejects.toBe(fail);
    await vi.advanceTimersByTimeAsync(1e4); ctrl.abort(fail); await rej;
    expect(Date.now()).toBe(schedMs + 1e4); expect(vi.getTimerCount()).toBe(0);
    for (const fn of [fetchSrcs, persistScores, markConsumed]) expect(fn).not.toHaveBeenCalled();
  });

  it("publishes the same late exact stage at :46 after a producer-running :16 wait", async () => {
    recLease();
    const w = await consume({ stageReadyDeadlineMs: schedMs - 1, stageRecovery: { graphApiKey: null } });
    expect(w.status).toBe("skipped_neutral"); expect(readMeta(w).reason).toBe("scoring-stage-producer-running");
    expect(persistScores).not.toHaveBeenCalled(); expect(markConsumed).not.toHaveBeenCalled();
    vi.setSystemTime(schedMs + 12e4); await stageHr(); vm(fetchSrcs).mockClear();
    vi.setSystemTime(Date.parse("2026-09-23T15:46:00Z"));
    const res = await consume({ stageRecovery: { graphApiKey: null } }, hSlot);
    expect(res.status).toBe("ok"); expect(fetchSrcs).not.toHaveBeenCalled(); expect(persistScores).toHaveBeenCalledOnce();
    expect(readMeta(res)).toMatchObject({ stageRecovery: { reason: "stage-unconsumed", sourceSlotStartedAt: sSlot, generationId: `dex-liquidity-scoring-stage:${sSlot}` } });
    expect(stgState()).toEqual({ state: "consumed" });
  });

  it("re-runs a terminally failed source stage from the half-hour tick", async () => {
    recErr(); vi.setSystemTime(Date.parse("2026-09-23T15:46:00Z"));
    const res = await consume({ stageRecovery: { graphApiKey: GK } }, hSlot);
    expect(res.status).toBe("ok"); expect(readMeta(res).stageRecovery).toMatchObject({ reason: "stage-run-errored", sourceSlotStartedAt: sSlot }); expect(stgState()).toEqual({ state: "consumed" });
  });

  it("still skips neutral at the half-hour tick when the hour's stage was consumed", async () => {
    await stageHr(); h.sqlite.prepare("UPDATE dex_liquidity_scoring_stages SET state = 'consumed' WHERE source_slot_started_at = ?").run(sSlot);
    vm(loadGenId).mockResolvedValue("dex-liquidity-current"); vi.setSystemTime(Date.parse("2026-09-23T15:46:00Z"));
    const res = await consume({ stageRecovery: { graphApiKey: GK } }, hSlot);
    expect(res.status).toBe("skipped_neutral"); expect(readMeta(res)).toMatchObject({ cadenceReuse: true, persistence: { generationId: "dex-liquidity-current" } });
  });

  it("surfaces Curve identity R4 telemetry and Option F2 <2h hold", async () => {
    const now = Math.floor(schedMs / 1e3), src = "defillama-curve-identities";
    for (const [status, n, id, age, prev, hold] of [["partial", 3, "", 0, "", false], ["unavailable", 0, "g1", 3600, "ok", true], ["unavailable", 0, "g2", 7200, "ok", false], ["unavailable", 0, "g3", 1800, "unavailable", false]] as const) {
      h.sqlite.exec("DELETE FROM dex_liquidity_publication_generations;DELETE FROM dex_liquidity_scoring_stage_chunks;DELETE FROM dex_liquidity_scoring_stages;");
      if (id) { const t = now - age; h.sqlite.prepare("INSERT INTO dex_liquidity_publication_generations(generation_id,started_at,published_at,state,expected_row_count,created_at,metadata_json)VALUES(?,?,?,'published',2,?,?)").run(id, t, t, t, js({ methodologyVersion: "7.56", curveIdentityStatus: prev })); }
      vm(persistScores).mockClear();
      fx.reset({ primary: fx.primary({ curveIdentityAttachment: { status, curvePoolCount: 4, attachedPoolCount: n, unmatchedPoolCount: 4 - n } }) });
      await stageHr();
      const r = await consume(), m = readMeta(r);
      expect([r.status, vm(persistScores).mock.calls.length, qualReasons(m), hold ? m.reason : null]).toEqual([hold ? "skipped_neutral" : "ok", hold ? 0 : 1, [`source-partial:${src}`, `curve-identity-${status}`], hold ? "curve-identity-unavailable" : null]);
    }
  });
});

function makeOrcaPair() {
  const sol = "So11111111111111111111111111111111111111112", usdc = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
  return {
    primary: llamaPool({ pool: "4f44c5d5-b1c2-4b1c-a111-123456789abc", chain: "Solana", project: "orca-dex", symbol: "SOL-USDC", tvlUsd: 29e6, volumeUsd1d: 2.5e6, volumeUsd7d: 17e6, underlyingTokens: [sol, usdc] }),
    direct: apiPool({ source: "orca", chain: "solana", poolAddress: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc", poolType: "orca-whirlpool", tokens: [{ address: usdc, symbol: "USDC", decimals: 6 }, { address: sol, symbol: "SOL", decimals: 9 }], price: 150, tvlUsd: 29e6, volume24hUsd: 2.5e6, balances: [1e5, 2e5] }),
  };
}

describe("filterPrimaryPoolsPreferDirectApi", () => {
  const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const solMap = new Map([[`solana:${USDS_MINT}`, "usds-sky"], [`solana:${USDC_MINT}`, USDC]]);

  const dedup = (derived: number) => ({
    skippedByExactIdentity: 0, skippedByUniqueDerivedIdentity: derived, skippedByOptionalWildcardIdentity: 0,
  });

  it("does not let an absurd direct-API pool suppress a healthy primary pool", () => {
    const r = filterPools([llamaPool({ pool: "0xpool", chain: "Fantom", project: "balancer-stable", symbol: "USDC-USDT", tvlUsd: 2.5e6, volumeUsd1d: 25e4, volumeUsd7d: 1.5e6, stablecoin: true, underlyingTokens: ["0xusdc", "0xusdt"], count: 2 })], [apiPool({ source: "balancer", chain: "Fantom", poolAddress: "0xpool", poolType: "balancer-stable", tokens: [{ address: "0xusdc", symbol: "USDC", decimals: 6 }, { address: "0xusdt", symbol: "USDT", decimals: 6 }], tvlUsd: 337e9, volume24hUsd: 1e5, balances: [1e6, 1e6] })]);
    expect(r).toMatchObject(dedup(0)); expect(r.filteredPools).toHaveLength(1);
  });

  it("deduplicates an Orca DL pool via unique derived identity when fee metadata is missing", () => {
    const { primary, direct } = makeOrcaPair();
    expect(filterPools([primary], [direct])).toMatchObject({ filteredPools: [], ...dedup(1) });
  });

  it("deduplicates a Balancer V3 DL stable pool via na-variant derived identity when DL omits the stable subtype", () => {
    const t0 = "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", t1 = "0xe0126f0c4451b2b917064a93040fd4770d6774b5";
    expect(filterPools([llamaPool({ pool: "0511276f-4d37-4919-95ab-6cdf418ddd08", chain: "Plasma", project: "balancer-v3", symbol: "USDAI-WAPLAUSDT0", tvlUsd: 547_701, stablecoin: true, underlyingTokens: [t0, t1], apy: 1.39196, count: 180 })], [apiPool({ source: "balancer", chain: "Plasma", poolAddress: "0x01e2c7fcde2b8d5d1413732c4e274ba5b06b1e54", poolType: "balancer-stable", tokens: [{ address: t0, symbol: "USDai", decimals: 18 }, { address: t1, symbol: "waPlaUSDT0", decimals: 18 }], price: 0.999939, tvlUsd: 547_664.8, volume24hUsd: 5_900.52, balances: [240_716.79906230856, 301_609.539917] })]))
      .toMatchObject({ filteredPools: [], ...dedup(1) });
  });

  it("deduplicates a DL raydium-amm stable pair against the direct Raydium pool via the tracked-pair stability hint", () => {
    const pools = [llamaPool({ pool: "5b6c56a9-3b81-48ee-bee7-3f0dcd862e4d", chain: "Solana", project: "raydium-amm", symbol: "USDS-USDC", tvlUsd: 9_101_152, volumeUsd1d: 1_034_471, stablecoin: true, underlyingTokens: [USDS_MINT, USDC_MINT] })];
    const mkRay = (poolAddress: string, tvlUsd: number): DexApiPool => ({ source: "raydium", chain: "solana", poolAddress, poolType: "raydium-amm", tokens: [{ address: USDS_MINT, symbol: "USDS", decimals: 6 }, { address: USDC_MINT, symbol: "USDC", decimals: 6 }], price: 1, tvlUsd, volume24hUsd: tvlUsd / 9, feeRate: 0.0025, balances: [tvlUsd / 2, tvlUsd / 2] });
    const single = [mkRay("AS5MV3ib4bfudpsb65yfmyQwrB9nRbY4rEqMSpjwbAcT", 9_101_153)];
    expect(filterPools(pools, single, solMap)).toMatchObject({ filteredPools: [], skippedByUniqueDerivedIdentity: 1 });
    expect(filterPools(pools, [...single, mkRay("7kJb5ZQF2jWc5m9R8t2xVb4nD6yPeHhTQ3sLuNvAaBbC", 56_127)], solMap).filteredPools).toHaveLength(1);
  });

  it("deduplicates a DL Concentrated raydium-amm pool against the identical direct Raydium CLMM pool", () => {
    expect(filterPools([llamaPool({ pool: "5b6c56a9-3b81-48ee-bee7-3f0dcd862e4d", chain: "Solana", project: "raydium-amm", symbol: "USDS-USDC", poolMeta: "Concentrated - 0.01%", tvlUsd: 3_234_788, volumeUsd1d: 1_034_471, stablecoin: true, underlyingTokens: [USDS_MINT, USDC_MINT] })], [apiPool({ source: "raydium", chain: "solana", poolAddress: "AS5MV3ib4bfudpsb65yfmyQwrB9nRbY4rEqMSpjwbAcT", poolType: "raydium-clmm", tokens: [{ address: USDS_MINT, symbol: "USDS", decimals: 6 }, { address: USDC_MINT, symbol: "USDC", decimals: 6 }], tvlUsd: 3_234_790, volume24hUsd: 1_034_500, balances: [1_617_000, 1_617_500] })], solMap))
      .toMatchObject({ filteredPools: [], skippedByUniqueDerivedIdentity: 1 });
  });

  it("does not use optional wildcard dedup when multiple direct API Orca pools share the same pair", () => {
    const { primary, direct } = makeOrcaPair();
    const r = filterPools([primary], [direct, { ...direct, poolAddress: "8k6N7m5b4V3c2X1z9Y8w7u6T5r4e3W2q1P9o8i7u6Y5", tvlUsd: 5e5, volume24hUsd: 5e4, feeRate: 0.0005, balances: [1e4, 2e4] }]);
    expect(r.filteredPools).toHaveLength(1); expect(r.skippedByOptionalWildcardIdentity).toBe(0);
  });

  it("uses optional wildcard matching for a stable pair without a direct stability hint", () => {
    const { primary, direct } = makeOrcaPair();
    Object.assign(primary, { underlyingTokens: [USDS_MINT, direct.tokens[0].address], symbol: "USDS-USDC", stablecoin: true });
    direct.tokens[1] = { address: USDS_MINT, symbol: "USDS", decimals: 6 }; direct.price = 1;
    const r = filterPools([primary, { ...primary, pool: "unrelated", underlyingTokens: ["another-token", "different-token"] }], [direct]);
    expect(r.filteredPools.map((p) => p.pool)).toEqual(["unrelated"]);
    expect(r).toMatchObject({ skippedByOptionalWildcardIdentity: 1, skippedByUniqueDerivedIdentity: 0, skippedByExactIdentity: 0 });
  });

  it("prefers a healthy exact-address direct pool", () => {
    const { primary, direct } = makeOrcaPair();
    expect(filterPools([{ ...primary, pool: direct.poolAddress }], [direct])).toMatchObject({ filteredPools: [], skippedByExactIdentity: 1, skippedByUniqueDerivedIdentity: 0, skippedByOptionalWildcardIdentity: 0 });
  });

  it("retains both primary pools when their derived identity is ambiguous", () => {
    const { primary, direct } = makeOrcaPair(), r = filterPools([primary, { ...primary, pool: "second-primary" }], [direct]);
    expect(r.filteredPools.map((p) => p.pool)).toEqual([primary.pool, "second-primary"]);
    expect(r).toMatchObject({ skippedByUniqueDerivedIdentity: 0, skippedByOptionalWildcardIdentity: 0 });
  });
});
