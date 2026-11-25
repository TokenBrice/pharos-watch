import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointIdentity as mkCkptId, checkpointTable as mkCkptTable, getReserveAdapterMock, mockLiveReserveAdapterRegistry as mockReg, mockLiveReserveD1 as mockD1, recordOutcomeSafeMock, recoverNoCandidateMock, shouldAttemptFetchMock } from "./live-reserves.test-support";
import { CHAIN_META } from "@shared/types/chain-identity";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS as ADAPTER_DEFS } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ReserveAdapterCoin } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { installAdapterNetwork } from "../reserve-adapters/__tests__/reserve-adapter.test-support";
import { fetchEscrowBalanceReserves } from "../reserve-adapters/escrow-balance";
import { fetchCrvUsdReserves } from "../reserve-adapters/crvusd";
import { fetchFlyingTulipFtUsdReserves } from "../reserve-adapters/flying-tulip-ftusd";
import flyingTulipCapture from "../reserve-adapters/__tests__/fixtures/flying-tulip-ftusd-dashboard-2026-09-30.json";
import { fetchJupUsdReserves } from "../reserve-adapters/jupusd";
import { fetchKavaCdpReserves } from "../reserve-adapters/kava-cdp";
import { KAVA_LCD_FIXTURES, LATEST_BLOCK, TOTAL_COLLATERAL, TOTAL_COLLATERAL_URL } from "../reserve-adapters/__tests__/kava-cdp.test-support";
import { adaptUnitedPorPayload } from "../reserve-adapters/united-por";
import { UNITED_POR_PAYLOAD } from "../reserve-adapters/__tests__/united-por.test-support";
import { resolveReserveResult } from "../../lib/live-reserves/store-views";
import { buildChainRpcs, hasRegistryRpc } from "../../lib/chain-registry";
import { unverifiedFreshnessMetadata } from "../reserve-adapters/freshness";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { breakerKeyForConfig, CONFIGURED_COINS, SYNC_ORDERED_CONFIGURED_COINS as QUEUE } from "../sync-live-reserves-shared";
import { advanceLiveReserveCheckpoint, beginLiveReserveCheckpoint } from "../reserve-adapters/reserve-checkpoint";
import { finalizeReserveSyncRun } from "../sync-live-reserves-finalize";
import { resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";
import { createAdapterLatencyCollector, syncReserveCoin } from "../sync-live-reserves-core";
import { getReserveSyncState } from "../../lib/live-reserves/store-read";
import { adaptMakinaStrategyReserves } from "../reserve-adapters/makina-strategy";
import { YUZU_REVIEW, installYuzuReview } from "../../lib/__tests__/live-reserves-store.test-support";
import type { ReserveSyncStateRecord } from "../../lib/live-reserves/store";

const MULTICHAIN_ADAPTERS = new Set(["usd1-bundle-oracle", "chronicle-nav", "chainlink-por", "sodax-sonic"]);
const isEvmOrTron = (c: string) => { const t = CHAIN_META[c]?.type; return t === "evm" || t === "tron"; };

function collectParamChains(v: unknown, out: Set<string>): void {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) collectParamChains(x, out); return; }
  const r = v as Record<string, unknown>;
  for (const k of ["chain", "chains"] as const) {
    const cv = r[k];
    if (typeof cv === "string" && isEvmOrTron(cv)) out.add(cv);
    else if (Array.isArray(cv)) for (const c of cv) if (typeof c === "string" && isEvmOrTron(c)) out.add(c);
  }
  for (const k of ["branches", "legs"] as const) collectParamChains(r[k], out);
}

function referencedLiveReserveChains(coin: (typeof ACTIVE_STABLECOINS)[number]): Set<string> {
  const out = new Set<string>(), cfg = coin.liveReservesConfig, p = cfg?.inputs.primary;
  if (p?.kind === "onchain-evm") out.add(p.chain);
  if (cfg && MULTICHAIN_ADAPTERS.has(cfg.adapter)) for (const c of coin.contracts ?? []) if (isEvmOrTron(c.chain)) out.add(c.chain);
  collectParamChains(cfg?.params, out);
  return out;
}

describe("syncLiveReserves", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  let runController: AbortController, replacedStore = false;
  afterEach(() => {
    runController.abort(); fixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks();
    if (replacedStore) { vi.doUnmock("../../lib/live-reserves/store"); vi.resetModules(); replacedStore = false; }
  });
  const cfgCoins = ACTIVE_STABLECOINS.filter((c) => c.liveReservesConfig);
  const configuredCount = cfgCoins.length;
  const sharedSourceCount = cfgCoins.reduce((keys, c) => {
    const cfg = c.liveReservesConfig!, p = cfg.inputs.primary;
    keys.add(ADAPTER_DEFS[cfg.adapter].sharedSourceMode !== "source-invariant" || (p.kind !== "http-json" && p.kind !== "http-html")
      ? `coin:${c.id}` : JSON.stringify({ adapter: cfg.adapter, version: cfg.version, semantics: cfg.semantics, inputs: { primary: p, fallbacks: cfg.inputs.fallbacks ?? null }, params: cfg.params ?? null }));
    return keys;
  }, new Set<string>()).size;
  const uniqueBreakerKeys = new Set(cfgCoins.map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`));

  type SyncFn = typeof import("../sync-live-reserves").syncLiveReserves;
  const healthy = () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] });
  const mockHealthy = () => mockReg(async () => healthy());
  const openCircuitVal = (nowSec = Math.floor(Date.now() / 1000) - 30, state = "open") =>
    JSON.stringify({ state, consecutiveFailures: 3, lastFailureAt: nowSec, lastSuccessAt: null, openedAt: nowSec });
  const mockSingleAdapter = (id: string, fn: (coin: ReserveAdapterCoin, config: LiveReservesConfig) => Promise<unknown>) =>
    getReserveAdapterMock.mockImplementation((k: keyof typeof ADAPTER_DEFS) => ({ ...ADAPTER_DEFS[k], key: k, fetch: async (coin: ReserveAdapterCoin, config: LiveReservesConfig) => coin.id === id ? fn(coin, config) : healthy() }));

  function finalizeRun(overrides: Pick<Parameters<typeof finalizeReserveSyncRun>[0], "counts"> & Partial<Parameters<typeof finalizeReserveSyncRun>[0]>) {
    const col = createAdapterLatencyCollector();
    return finalizeReserveSyncRun({
      db: mockD1(), total: 100, runStartedAt: Math.floor(Date.now() / 1000), runStartedMs: Date.now(), warningMessages: [], coinsWithErrors: [], coinsWithWarnings: [],
      breaker: { breakerKeys: new Set(), breakerOutcomes: new Map() },
      deferredTail: { nextCursorStablecoinId: null, cursorTailState: null, cursorRecordedAt: null, cursorTailCompletedAt: null, cursorTailFailedAt: null, cursorTailError: null, runBudgetTruncationCount: 0 },
      checkpointOwned: false, attemptFailureSummaries: [], budgetConfig: resolveLiveReserveSyncBudgetConfig(),
      phaseTimings: { setup: 0, queue: 0, adapter: 0, d1CoinPersistence: 0 }, adapterLatency: col.finalize(), adapterTelemetryProgress: col.progress(), ...overrides,
    });
  }
  async function runSync(db: Parameters<SyncFn>[0], budget?: Parameters<SyncFn>[4], progress?: Parameters<SyncFn>[3], ckpt?: Parameters<SyncFn>[5]) {
    return (await import("../sync-live-reserves")).syncLiveReserves(db, runController.signal, {}, progress, budget, ckpt);
  }
  async function runScopedSlice(sync: SyncFn, db: Parameters<SyncFn>[0], coinId: string, budget: NonNullable<Parameters<SyncFn>[4]> = {}) {
    const idx = QUEUE.findIndex((c) => c.id === coinId); if (idx < 0) throw new Error(`coin ${coinId} is not in the live reserve queue`);
    const id = mkCkptId(1, `scoped-${coinId}`);
    await beginLiveReserveCheckpoint(db, { slotStartedAt: id.slotStartedAt, invocationId: id.invocationId });
    await advanceLiveReserveCheckpoint(db, id, { nextItemKey: coinId, itemsDone: idx });
    return sync(db, runController.signal, {}, undefined, { maxCoinsPerSlice: 2, ...budget }, id);
  }
  async function expectRetainedBook(id: string, failNext: () => void, check: (s: Record<string, unknown>) => void) {
    const { db, sqlite } = fixtures.open(), { syncLiveReserves } = await import("../sync-live-reserves");
    const snap = () => sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(id);
    const succ = () => sqlite.prepare("SELECT last_success_at, last_success_attempt_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(id);
    await runScopedSlice(syncLiveReserves, db, id);
    const origSnap = snap(), origSucc = succ(), orig = await resolveReserveResult(db, id, Math.floor(Date.now() / 1000));
    expect(origSnap).toBeDefined(); expect(orig?.mode).toBe("live"); expect(orig?.reserves.length).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) {
      failNext(); await runScopedSlice(syncLiveReserves, db, id);
      expect(snap()).toEqual(origSnap); expect(succ()).toEqual(origSucc);
      const served = await resolveReserveResult(db, id, Math.floor(Date.now() / 1000));
      expect(served?.reserves).toEqual(orig?.reserves); expect(served?.liveAt).toBe(orig?.liveAt); expect(served?.metadata?.sourceTimestamp).toBe(orig?.metadata?.sourceTimestamp);
      const st = sqlite.prepare("SELECT * FROM reserve_sync_state WHERE stablecoin_id = ?").get(id)!;
      expect(st.last_status).toBe("error"); check(st);
    }
    return orig;
  }

  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); runController = new AbortController(); shouldAttemptFetchMock.mockResolvedValue(true); recordOutcomeSafeMock.mockResolvedValue(undefined); recoverNoCandidateMock.mockReset(); });

  it("keeps public RPC live-reserve inputs resolvable", () => {
    const rpcs = buildChainRpcs();
    const missing = ACTIVE_STABLECOINS.filter((c) => { const p = c.liveReservesConfig?.inputs.primary; return p?.kind === "onchain-evm" && p.rpcMode === "public-rpc"; }).flatMap((c) => {
      const cfg = c.liveReservesConfig!, p = cfg.inputs.primary; if (p.kind !== "onchain-evm") return [];
      const rpcUrl = typeof cfg.params === "object" && cfg.params !== null && !Array.isArray(cfg.params) ? (cfg.params as { rpcUrl?: unknown }).rpcUrl : undefined;
      const hasUrl = typeof rpcUrl === "string" && rpcUrl.length > 0;
      return [...referencedLiveReserveChains(c)].filter((ch) => !(ch === p.chain && hasUrl) && !hasRegistryRpc(rpcs.get(ch))).map((ch) => `${c.id}:${ch}`);
    });
    expect(missing).toEqual([]);
  });

  it("refuses a recovery suffix when the configured queue hash changed", async () => {
    const ck = mkCkptId(2, "recovery-owner");
    await expect(runSync(mockD1([mkCkptTable({ attemptNo: ck.attemptNo, invocationId: ck.invocationId, nextItemKey: QUEUE[0]?.id ?? null, itemsDone: 0, queueHash: "stale-queue-hash" })]), undefined, undefined, ck)).rejects.toThrow("refusing unsafe suffix replay");
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it("rejects a recovery attempt when its checkpoint is missing", async () => {
    await expect(runSync(mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [] }]), undefined, undefined, mkCkptId(2, "missing-owner"))).rejects.toThrow("live reserve checkpoint missing");
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an authoritative checkpoint item left the queue", nextItemKey: "removed-coin", currentDomainAttemptId: "authoritative-attempt", expected: "live reserve checkpoint item removed-coin no longer exists in the queue" },
    { label: "a pending checkpoint item left the queue", nextItemKey: "removed-coin", currentDomainAttemptId: null, expected: "live reserve checkpoint item removed-coin no longer exists in the queue" },
  ])("rejects unsafe recovery when $label", async ({ nextItemKey, currentDomainAttemptId, expected }) => {
    const ck = mkCkptId(2, "recovery-owner");
    const db = mockD1([mkCkptTable({ attemptNo: ck.attemptNo, invocationId: ck.invocationId, nextItemKey, currentItemKey: currentDomainAttemptId ? nextItemKey : null, currentDomainAttemptId, itemsDone: 0 }), ...(currentDomainAttemptId ? [{ match: "SELECT 1 AS finalized", rows: [{ finalized: 1 }] }] : [])]);
    await expect(runSync(db, undefined, undefined, ck)).rejects.toThrow(expected);
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it("refreshes the adapter clock after time spent earlier in the reserve queue", async () => {
    const startedMs = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(startedMs);
    const fetch = mockReg(async () => ({ slices: [{ name: "Cash", pct: 100, risk: "low" as const }] }));
    fetch.mockImplementationOnce(async () => { clock.mockReturnValue(startedMs + 180_000); return { slices: [{ name: "Cash", pct: 100, risk: "low" as const }], metadata: { freshnessMode: "not-applicable" as const } }; });
    try { await runSync(mockD1(), { runBudgetMs: 720_000 }); expect(fetch).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ nowSec: Math.floor(startedMs / 1_000) + 180 })); }
    finally { clock.mockRestore(); }
  });

  it("reuses identical shared HTTP reserve sources within a run", async () => {
    const fetch = mockHealthy(), { db, sqlite } = fixtures.open(), res = await runSync(db);
    expect(fetch).toHaveBeenCalledTimes(sharedSourceCount); expect(sharedSourceCount).toBeLessThan(configuredCount); expect(res.itemCount).toBe(configuredCount);
    const snaps = sqlite.prepare("SELECT stablecoin_id, slices FROM reserve_composition ORDER BY stablecoin_id").all();
    expect(snaps.map((r) => r.stablecoin_id)).toEqual(cfgCoins.map((c) => c.id).sort());
    expect(snaps.map((r) => JSON.parse(String(r.slices)))).toEqual(snaps.map(() => [{ name: "Mock Farm", pct: 100, risk: "low" }]));
  });

  const RESERVOIR_IDS = ["rusd-reservoir", "srusd-reservoir", "wsrusd-reservoir"] as const;
  it.each(["canonical", "reversed"] as const)("publishes each Reservoir coin's own redemption contract in %s queue order", async (order) => {
    vi.resetModules();
    const shared = await import("../sync-live-reserves-shared"), q = [...shared.SYNC_ORDERED_CONFIGURED_COINS];
    const slots = q.flatMap((c, i) => (RESERVOIR_IDS as readonly string[]).includes(c.id) ? [i] : []), rCoins = slots.map((i) => q[i]!);
    if (order === "reversed") rCoins.reverse();
    slots.forEach((i, pos) => { q[i] = rCoins[pos]!; });
    vi.doMock("../sync-live-reserves-shared", () => ({ ...shared, SYNC_ORDERED_CONFIGURED_COINS: q }));
    const fetch = mockReg(async (coin, cfg) => cfg?.adapter !== "reservoir" ? healthy() : ({
      slices: [{ name: "USDC positions", pct: 100, risk: "low" as const }],
      metadata: { ...unverifiedFreshnessMetadata("protocol-balance-sheet-api", "fixture balance sheet carries no timestamp"), unknownExposurePct: 0, supplyUsd: 95, redemption: { capacityUsd: 4, capacityKind: "live-direct", freshnessKind: "same-run-onchain", sourceTimestamp: Math.floor(Date.now() / 1000) - 12, blockNumber: 26_142_993, outputAssetKeys: ["usdc-circle"], sharedResourceKey: "ethereum:reservoir-psm:0x4809010926aec940b550d34a46a52739f996d75d", routeStatus: "open", routeStatusSource: "onchain", holderEligibility: "any-holder", settlementDelaySec: 0, ...(coin!.id === "srusd-reservoir" ? { feeBps: 1.34 } : coin!.id === "wsrusd-reservoir" ? { feeBps: 0 } : {}) } },
    }));
    try {
      const { syncLiveReserves } = await import("../sync-live-reserves"), { db, sqlite } = fixtures.open();
      await syncLiveReserves(db, runController.signal, {});
      const byCoin: Record<string, unknown> = {};
      for (const r of sqlite.prepare("SELECT stablecoin_id, metadata FROM reserve_composition ORDER BY stablecoin_id").all()) {
        if (typeof r.stablecoin_id !== "string" || typeof r.metadata !== "string") throw new TypeError("Expected strings");
        if ((RESERVOIR_IDS as readonly string[]).includes(r.stablecoin_id)) { const m: unknown = JSON.parse(r.metadata); byCoin[r.stablecoin_id] = m && typeof m === "object" && "redemption" in m ? m.redemption : undefined; }
      }
      expect(fetch.mock.calls.filter(([, cfg]) => cfg?.adapter === "reservoir")).toHaveLength(RESERVOIR_IDS.length);
      expect(Object.keys(byCoin).sort()).toEqual([...RESERVOIR_IDS]);
      expect(byCoin["rusd-reservoir"]).not.toHaveProperty("feeBps");
      expect(byCoin["srusd-reservoir"]).toMatchObject({ feeBps: 1.34 });
      expect(byCoin["wsrusd-reservoir"]).toMatchObject({ feeBps: 0 });
      for (const r of Object.values(byCoin)) expect(r).not.toHaveProperty("capacityRatioOfSupply");
    } finally { vi.doUnmock("../sync-live-reserves-shared"); vi.resetModules(); }
  });

  it.each(["observed-zero", "unavailable"] as const)("replaces positive escrow capacity only with an observed value (%s)", async (outcome) => {
    let nowMs = Date.now(), balance: bigint | null = 100_000_000n;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const net = installAdapterNetwork({ chains: { ethereum: "https://rpc.example" }, rpc: { "0xc47cf5ef": () => balance, "0x5c975abb": false } });
    mockSingleAdapter("usdcx-movement", (c, cfg) => fetchEscrowBalanceReserves(c, cfg, runController.signal, { chainRpcs: net.chainRpcs }));
    const { db, sqlite } = fixtures.open(), { syncLiveReserves } = await import("../sync-live-reserves");
    const row = () => sqlite.prepare("SELECT fetched_at, attempt_id, metadata FROM reserve_composition WHERE stablecoin_id = ?").get("usdcx-movement");
    await runScopedSlice(syncLiveReserves, db, "usdcx-movement");
    const before = row(); expect(before).toBeDefined();
    expect((await resolveReserveResult(db, "usdcx-movement", Math.floor(nowMs / 1000)))?.metadata?.redemption).toMatchObject({ capacityUsd: 100 });
    nowMs += 60_000; balance = outcome === "observed-zero" ? 0n : null;
    await runScopedSlice(syncLiveReserves, db, "usdcx-movement");
    const after = row(), served = await resolveReserveResult(db, "usdcx-movement", Math.floor(nowMs / 1000));
    expect(served?.metadata?.redemption).toMatchObject({ capacityUsd: outcome === "observed-zero" ? 0 : 100 });
    if (outcome === "observed-zero") {
      expect(after).not.toEqual(before); expect(served?.liveAt).toBe(Math.floor(nowMs / 1000));
      nowMs += 60_000; balance = null; await runScopedSlice(syncLiveReserves, db, "usdcx-movement");
      expect(row()).toEqual(after);
      const ret = await resolveReserveResult(db, "usdcx-movement", Math.floor(nowMs / 1000));
      expect(ret?.metadata?.redemption).toMatchObject({ capacityUsd: 0 }); expect(ret?.liveAt).toBe(Math.floor(nowMs / 1000) - 60);
    } else { expect(after).toEqual(before); expect(served?.liveAt).toBe(Math.floor(nowMs / 1000) - 60); }
  });

  it("replaces retained healthy aggregate backing with observed zero and retains that loss after a failed read", async () => {
    let nowMs = Date.now(), totalReserve = "110";
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockSingleAdapter("u-united-stables", async () => adaptUnitedPorPayload({ ...UNITED_POR_PAYLOAD, totalReserve, totalToken: "100", updatedAt: new Date(nowMs).toISOString() }, { name: "Aggregate backing", risk: "low" }));
    const { db, sqlite } = fixtures.open(), { syncLiveReserves } = await import("../sync-live-reserves");
    const comp = () => sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get("u-united-stables");
    await runScopedSlice(syncLiveReserves, db, "u-united-stables");
    const okRow = comp(); expect(okRow).toBeDefined();
    expect((await resolveReserveResult(db, "u-united-stables", Math.floor(nowMs / 1000)))?.metadata).toMatchObject({ totalReserveUsd: 110, collateralizationRatio: 1.1 });
    nowMs += 60_000; totalReserve = "0"; await runScopedSlice(syncLiveReserves, db, "u-united-stables");
    const adv = comp(); expect(adv).not.toEqual(okRow);
    const served = await resolveReserveResult(db, "u-united-stables", Math.floor(nowMs / 1000));
    expect(served?.metadata).toMatchObject({ totalReserveUsd: 0, supplyUsd: 100, collateralizationRatio: 0 }); expect(served?.liveAt).toBe(Math.floor(nowMs / 1000));
    const st = sqlite.prepare("SELECT last_status, warnings, last_success_at FROM reserve_sync_state WHERE stablecoin_id = ?").get("u-united-stables")!;
    expect(st).toMatchObject({ last_status: "degraded", last_success_at: Math.floor(nowMs / 1000) });
    expect(JSON.parse(String(st.warnings))).toContainEqual(expect.objectContaining({ code: "united-por-reserve-under-token", effect: "degraded" }));
    nowMs += 60_000; totalReserve = "unavailable"; await runScopedSlice(syncLiveReserves, db, "u-united-stables");
    expect(comp()).toEqual(adv);
    const ret = await resolveReserveResult(db, "u-united-stables", Math.floor(nowMs / 1000));
    expect(ret?.metadata).toMatchObject({ totalReserveUsd: 0, collateralizationRatio: 0 }); expect(ret?.liveAt).toBe(Math.floor(nowMs / 1000) - 60);
  });

  it.each(["curve-markets-incomplete", "yield-basis-incomplete"] as const)("retains the complete crvUSD book and original clocks after %s", async (reason) => {
    let nowMs = Date.now(), incomplete = false;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const net = installAdapterNetwork({ chains: { ethereum: "https://rpc.example" }, rpc: { "market_count()": () => incomplete && reason === "yield-basis-incomplete" ? null : 0n }, json: { "https://curve.example/markets": () => ({ chains: { ethereum: { data: [{ collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } }, { ...(incomplete && reason === "curve-markets-incomplete" ? {} : { collateral_amount_usd: 100 }), collateral_token: { symbol: "WETH" } }] } } }) } });
    mockSingleAdapter("crvusd-curve", (c, cfg) => fetchCrvUsdReserves(c, { ...cfg, inputs: { primary: { kind: "http-json", url: "https://curve.example/markets" } } }, runController.signal, { chainRpcs: net.chainRpcs }));
    const orig = await expectRetainedBook("crvusd-curve", () => { incomplete = true; nowMs += 60_000; }, (st) => {
      expect(JSON.parse(String(st.warnings))).toContainEqual(expect.objectContaining({ code: reason, effect: "fatal" }));
      const d = JSON.parse(String(st.metadata)).adapterDiagnostics;
      expect(d.details.measuredDirectCollateralUsd).toBe(reason === "curve-markets-incomplete" ? 100 : 200);
      expect(d).not.toHaveProperty("yieldBasisCollateralUsd"); expect(d).not.toHaveProperty("yieldBasisCollateralPct");
    });
    expect(orig?.reserves.map((s) => s.pct)).toEqual([50, 50]);
  });

  it("retains the complete ftusd-flying-tulip book and original clocks after scope loss", async () => {
    let nowMs = Date.now(), incomplete = false; vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const url = "https://reserves.example/book";
    const net = installAdapterNetwork({ json: { [url]: () => ({ ...flyingTulipCapture, lastUpdated: new Date(nowMs).toISOString(), chains: [...flyingTulipCapture.chains, ...(incomplete ? [{ chainId: 137, chainName: "Polygon", tvlUsd: 900, metrics: { totalSupplyUsd: 900 } }] : [])] }) } });
    mockSingleAdapter("ftusd-flying-tulip", (c, cfg) => fetchFlyingTulipFtUsdReserves(c, { ...cfg, inputs: { primary: { kind: "http-json", url } } }, runController.signal, { chainRpcs: net.chainRpcs }));
    await expectRetainedBook("ftusd-flying-tulip", () => { incomplete = true; nowMs += 60_000; }, (st) => {
      expect(st.last_error).toContain("unexpected-chain");
    });
  });

  it.each([{ id: "jupusd-jupiter", adapter: "jupusd", reason: "holdings-incomplete" }, { id: "usdx-kava", adapter: "kava-cdp", reason: "collateral-coverage-incomplete" }] as const)(
    "retains the complete $id book and original clocks after unavailable valuation",
    async ({ id, adapter, reason }) => {
      let nowMs = Date.now(), incomplete = false; vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const url = adapter === "jupusd" ? "https://jupusd.example/data" : TOTAL_COLLATERAL_URL;
      installAdapterNetwork({ json: adapter === "jupusd" ? { [url]: () => ({ totalSupply: "200000000", holdings: [{ name: "USDC", amount: "100000000", decimals: 6 }, { name: "USDtb", amount: "100000000", ...(incomplete ? {} : { decimals: 6 }) }] }), "https://jupusd.example/snapshots": () => ({ snapshots: [{ timestamp: Math.floor(nowMs / 1000) }] }) } : { ...KAVA_LCD_FIXTURES, [TOTAL_COLLATERAL_URL]: () => { const p = structuredClone(TOTAL_COLLATERAL); if (incomplete) p.total_collateral.find((r) => r.collateral_type === "swp-a")!.amount.amount = "1000000000"; return p; }, "https://api.kava.io/cosmos/base/tendermint/v1beta1/blocks/latest": () => ({ block: { header: { ...LATEST_BLOCK.block.header, time: new Date(nowMs).toISOString() } } }) } });
      mockSingleAdapter(id, (c, cfg) => (adapter === "jupusd" ? fetchJupUsdReserves : fetchKavaCdpReserves)(c, { ...cfg, inputs: { primary: { kind: "http-json", url } }, ...(adapter === "jupusd" ? { params: { snapshotsUrl: "https://jupusd.example/snapshots" } } : {}) }, runController.signal, { nowSec: Math.floor(nowMs / 1000) }));
      await expectRetainedBook(id, () => { incomplete = true; nowMs += 60_000; }, (st) => {
        expect(JSON.parse(String(st.warnings))).toContainEqual(expect.objectContaining({ code: reason, effect: "fatal" }));
        const d = JSON.parse(String(st.metadata)).adapterDiagnostics;
        for (const k of ["totalReserveUsd", "collateralizationRatio", "unknownExposurePct", "redemption"]) expect(d).not.toHaveProperty(k);
        expect(d.details).toMatchObject(adapter === "jupusd" ? { measuredHoldingsUsd: 100, unavailableHoldingNames: ["1:USDtb"] } : { unpricedCollateralTypes: ["swp-a"], unpricedPrincipalTokens: 4.889684 });
      });
    },
  );

  it("returns ok with warning metadata when the adapter yields warnings (warnings are metadata-only)", async () => {
    mockReg(async () => ({ ...healthy(), warnings: [{ code: "unknown-position", message: "Unmapped reserve position: new-farm", severity: "warning" as const }] }));
    const res = await runSync(mockD1());
    expect(res?.status).toBe("ok");
    expect((JSON.parse(res?.metadata ?? "{}") as { warningCount?: number }).warningCount).toBeGreaterThanOrEqual(configuredCount);
  });

  it.each(["open", "half-open"])("retains %s breaker admission/probe handling after the bulk read", async (state) => {
    shouldAttemptFetchMock.mockResolvedValue(false);
    mockReg(async () => { throw new Error("adapter should not run when circuit is open"); });
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([{ match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: QUEUE.map((c) => ({ key: `circuit:${breakerKeyForConfig(c.liveReservesConfig!)}`, value: openCircuitVal(now, state), updated_at: now })) }]);
    expect(await runSync(db)).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(db.getHistory().some((e) => e.sql.includes("reserve_sync_state"))).toBe(true);
    expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
    expect(shouldAttemptFetchMock).toHaveBeenCalledTimes(new Set(QUEUE.map((c) => breakerKeyForConfig(c.liveReservesConfig!))).size);
  });

  it.each([false, true])("records one outcome per breaker key (bulk read fails: %s)", async (bulkReadFails) => {
    mockHealthy();
    const db = mockD1(bulkReadFails ? [{ match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: [], throwError: new Error("bulk breaker read unavailable") }] : []);
    const res = await runSync(db), counts = new Map<string, number>();
    for (const [, k] of recordOutcomeSafeMock.mock.calls) counts.set(k as string, (counts.get(k as string) ?? 0) + 1);
    for (const [k, n] of counts) expect(n, k).toBe(1);
    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeys.size);
    if (bulkReadFails) {
      expect(JSON.parse(res.metadata!)).toMatchObject({ breakerOutcomesRecorded: uniqueBreakerKeys.size, breakerOutcomesSkippedClosedSuccess: 0 });
      expect(db.getHistory().some((e) => e.binds[0] === "cron:event:sync-live-reserves:live-reserve-breaker-bulk-read-failed")).toBe(true);
    }
  });

  it.each([false, true])("records failed breaker outcomes (write fails: %s)", async (writeFails) => {
    const first = QUEUE[0]!, failedKey = breakerKeyForConfig(first.liveReservesConfig!);
    mockReg(async (c) => { if (c?.id === first.id) throw new Error("HTTP 503 forced reserve source outage"); return healthy(); });
    if (writeFails) recordOutcomeSafeMock.mockImplementation(async (_db, k) => k === failedKey ? null : undefined);
    const db = mockD1(writeFails ? [] : [{ match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: Array.from(uniqueBreakerKeys, (k) => ({ key: `circuit:${k}`, updated_at: 1_700_000_000, value: JSON.stringify({ state: "closed", consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: 1_700_000_000, openedAt: null }) })) }]);
    const meta = JSON.parse((await runSync(db)).metadata!);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(expect.anything(), failedKey, false);
    expect(meta.breakerOutcomesRecorded).toBe(writeFails ? uniqueBreakerKeys.size - 1 : 1);
    if (writeFails) expect(meta.breakerOutcomeWriteFailures).toBe(1);
    else { expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(1); expect(meta.breakerOutcomesSkippedClosedSuccess).toBe(uniqueBreakerKeys.size - 1); }
  });

  it("records success breaker outcomes that still need state recovery", async () => {
    mockHealthy();
    const keys = Array.from(uniqueBreakerKeys), [halfOpen, debt, missingSuccess, lingering] = keys, recover = new Set(keys.slice(0, 4));
    const db = mockD1([{ match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: keys.map((k) => ({
      key: `circuit:${k}`, updated_at: 1_700_000_000,
      value: JSON.stringify({
        state: k === halfOpen ? "half-open" : "closed", consecutiveFailures: k === halfOpen || k === debt ? 2 : 0,
        lastFailureAt: k === halfOpen || k === debt ? 1_699_999_990 : null, lastSuccessAt: k === missingSuccess ? null : 1_700_000_000,
        openedAt: k === halfOpen || k === lingering ? 1_699_999_990 : null,
      }),
    })) }]);
    const meta = JSON.parse((await runSync(db))?.metadata ?? "{}");
    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(recover.size);
    for (const k of recover) expect(recordOutcomeSafeMock).toHaveBeenCalledWith(expect.anything(), k, true);
    expect(meta).toMatchObject({ breakerOutcomesRecorded: recover.size, breakerOutcomesSkippedClosedSuccess: keys.length - recover.size });
  });

  it("skips breaker outcome writes when finalization tail budget is exhausted", async () => {
    let nowMs = 1_700_000_000_000; const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockHealthy();
    try {
      const meta = JSON.parse((await runSync(mockD1(), { runBudgetMs: 5_000, adapterTimeoutMs: 1, d1FinalizeTimeoutMs: 1, finalizationMarginMs: 1 }, async (u) => { if (u.stage === "finalizing") nowMs += 10_000; }))?.metadata ?? "{}");
      expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
      expect(meta).toMatchObject({ breakerOutcomeBudgetExhausted: true, breakerOutcomesRecorded: 0, staleBreakerRecoveriesSkipped: 1 });
      expect(meta.breakerOutcomesSkippedBudget).toBeGreaterThan(0);
    } finally { spy.mockRestore(); }
  });

  it("cleans stale reserve artifacts by deleting only rows outside the active keep-list", async () => {
    mockHealthy();
    const keepId = cfgCoins[0]?.id;
    const db = mockD1([
      { match: "SELECT stablecoin_id FROM reserve_sync_state", rows: [{ stablecoin_id: "stale-sync-state" }, { stablecoin_id: keepId }] },
      { match: "SELECT stablecoin_id FROM reserve_composition", rows: [{ stablecoin_id: "stale-composition" }, { stablecoin_id: keepId }] },
      { match: "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'", rows: [{ key: "circuit:live-reserves:stale-breaker" }, { key: "circuit:live-reserves:infinifi" }] },
    ]);
    await runSync(db);
    const hist = db.getHistory();
    for (const [sql, bind] of [["DELETE FROM reserve_sync_state WHERE stablecoin_id IN", "stale-sync-state"], ["DELETE FROM reserve_composition WHERE stablecoin_id IN", "stale-composition"], ["DELETE FROM cache WHERE key IN", "circuit:live-reserves:stale-breaker"]]) {
      const rows = hist.filter((e) => e.sql.includes(sql));
      expect(rows).toHaveLength(1); expect(rows[0]?.binds).toEqual([bind]);
    }
    expect(hist.some((e) => e.sql.includes("DELETE FROM reserve_sync_state WHERE stablecoin_id = ?"))).toBe(false);
  });

  it.each([
    ["stale artifact cleanup", "cleanupStaleLiveReserveArtifacts", "artifact cleanup unavailable", "live-reserve-artifact-cleanup-failed"],
    ["history pruning", "pruneLiveReserveHistory", "history prune unavailable", "live-reserve-history-prune-failed"],
  ] as const)("keeps %s best-effort and records warning metadata", async (_label, op, error, eventType) => {
    mockHealthy();
    const actual = await vi.importActual<typeof import("../../lib/live-reserves/store")>("../../lib/live-reserves/store");
    replacedStore = true; vi.resetModules();
    vi.doMock("../../lib/live-reserves/store", () => ({ ...actual, [op]: vi.fn(async () => { throw new Error(error); }) }));
    const db = mockD1(), res = await runSync(db), meta = JSON.parse(res.metadata!);
    expect(res.status).toBe("ok");
    if (op === "cleanupStaleLiveReserveArtifacts") {
      expect(meta).toMatchObject({ artifactCleanup: null, artifactCleanupWarningCount: 1 });
      expect(meta.artifactCleanupWarnings).toEqual([{ eventType, message: "Ghost live-reserve artifact cleanup failed.", error }]);
    }
    else { expect(meta.historyPrune).toBeUndefined(); expect(meta.historyPruneSkipped).toBe(false); }
    const ev = db.getHistory().find((e) => e.sql.includes("INSERT INTO cache") && e.binds[0] === `cron:event:sync-live-reserves:${eventType}`);
    expect(ev).toBeDefined();
    if (op === "pruneLiveReserveHistory") expect(JSON.parse(String(ev!.binds[1]))).toMatchObject({ severity: "warning", metadata: { error } });
  });

  it("recovers stale live-reserve circuit breakers with no configured candidates", async () => {
    const staleKey = "live-reserves:removed-adapter-key", cfgKey = `live-reserves:${QUEUE[0]!.liveReservesConfig!.breakerScope ?? QUEUE[0]!.liveReservesConfig!.adapter}`, st = openCircuitVal();
    mockHealthy();
    await runSync(mockD1([{ match: "key >= 'circuit:' AND key < 'circuit;'", rows: [{ key: `circuit:${staleKey}`, value: st }, { key: `circuit:${cfgKey}`, value: st }] }]));
    expect(recoverNoCandidateMock.mock.calls.filter((c) => c[1] === staleKey)).toHaveLength(1);
    expect(recoverNoCandidateMock.mock.calls.filter((c) => c[1] === cfgKey)).toHaveLength(0);
  });

  it("skips remaining stale breaker recoveries when the finalization tail budget runs out mid-loop", async () => {
    let nowMs = 1_700_000_000_000; const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockHealthy(); const st = openCircuitVal(Math.floor(nowMs / 1000) - 30);
    recoverNoCandidateMock.mockImplementationOnce(async () => { nowMs += 10_000; });
    try {
      const res = await runSync(mockD1([{ match: "key >= 'circuit:' AND key < 'circuit;'", rows: [{ key: "circuit:live-reserves:removed-a", value: st }, { key: "circuit:live-reserves:removed-b", value: st }] }]), { runBudgetMs: 5_000, adapterTimeoutMs: 1, d1FinalizeTimeoutMs: 1, finalizationMarginMs: 1 });
      expect(JSON.parse(res?.metadata ?? "{}")).toMatchObject({ staleBreakerRecoveriesSkipped: 1, finalizationTailBudgetExhausted: true });
      expect(recoverNoCandidateMock.mock.calls.map((c) => c[1])).toEqual(["live-reserves:removed-a"]);
    } finally { spy.mockRestore(); }
  });

  it("keeps finalization best-effort and records a warning when stale breaker recovery fails", async () => {
    mockHealthy(); recoverNoCandidateMock.mockRejectedValueOnce(new Error("stale recovery unavailable"));
    const db = mockD1([{ match: "key >= 'circuit:' AND key < 'circuit;'", rows: [{ key: "circuit:live-reserves:removed-adapter-key", value: openCircuitVal() }] }]);
    expect((await runSync(db))?.status).toBe("ok");
    expect(recoverNoCandidateMock).toHaveBeenCalledTimes(1);
    const ev = db.getHistory().find((e) => e.sql.includes("INSERT INTO cache") && e.binds[0] === "cron:event:sync-live-reserves:live-reserve-breaker-recovery-failed");
    expect(JSON.parse(String(ev?.binds[1]))).toMatchObject({ severity: "warning", metadata: { error: "stale recovery unavailable" } });
  });

  it("classifies parser drift in sync attempt metadata", async () => {
    mockReg(async () => { throw new Error("circle-transparency: layout-changed: missing reserve attributes"); });
    const db = mockD1(); await runSync(db);
    const ins = db.getHistory().find((e) => e.sql.includes("reserve_sync_attempt_history"));
    expect(JSON.parse(ins!.binds[9] as string)).toMatchObject({ reason: "adapter-exception", failureCategory: "parser-drift" });
  });

  it("records timed out write finalization as a non-authoritative storage failure", async () => {
    mockHealthy();
    const actual = await vi.importActual<typeof import("../../lib/live-reserves/store")>("../../lib/live-reserves/store");
    let calls = 0; replacedStore = true; vi.resetModules();
    vi.doMock("../../lib/live-reserves/store", async () => ({ ...actual, finalizeReserveSyncSuccess: vi.fn(async (...a: Parameters<typeof actual.finalizeReserveSyncSuccess>) => ++calls === 1 ? new Promise<Awaited<ReturnType<typeof actual.finalizeReserveSyncSuccess>>>(() => undefined) : actual.finalizeReserveSyncSuccess(...a)) }));
    const { syncLiveReserves } = await import("../sync-live-reserves"), db = mockD1(), p = syncLiveReserves(db, runController.signal, {});
    await vi.advanceTimersByTimeAsync(30_100); const res = await p;
    expect(res).toMatchObject({ itemCount: configuredCount - 1, status: "degraded" });
    expect(JSON.parse(res.metadata!)).toMatchObject({ persistenceFailed: 1, reason: "reserve-adapter-or-persistence-failed" });
    const attempts = db.getHistory().filter((e) => e.sql.includes("reserve_sync_attempt_history"));
    const timedOut = attempts.find((e) => e.binds.some((b) => typeof b === "string" && b.includes("storage-write-timeout")));
    expect(timedOut).toBeDefined();
    const forCoin = attempts.filter((e) => e.binds[0] === timedOut!.binds[0]);
    expect(forCoin).toHaveLength(1);
    expect(forCoin.find((e) => e.binds.some((b) => typeof b === "string" && b.includes("success-finalize-rejected")))).toBeUndefined();
  });

  it("accepts a timed out write finalization when authoritative readback proves success", async () => {
    mockHealthy();
    const actual = await vi.importActual<typeof import("../../lib/live-reserves/store")>("../../lib/live-reserves/store");
    replacedStore = true; vi.resetModules();
    vi.doMock("../../lib/live-reserves/store", async () => ({ ...actual, finalizeReserveSyncSuccess: vi.fn(async () => new Promise<Awaited<ReturnType<typeof actual.finalizeReserveSyncSuccess>>>(() => undefined)), didReserveSyncSuccessBecomeAuthoritative: vi.fn(async () => true) }));
    const { syncLiveReserves } = await import("../sync-live-reserves"), db = mockD1();
    const p = syncLiveReserves(db, runController.signal, {}, undefined, { runBudgetMs: 12, adapterTimeoutMs: 1, d1FinalizeTimeoutMs: 10, finalizationMarginMs: 1 });
    await vi.advanceTimersByTimeAsync(11); const res = await p;
    expect(res?.itemCount).toBe(1);
    expect(JSON.parse(res?.metadata ?? "{}")).toMatchObject({ synced: 1, failed: 0 });
    expect(db.getHistory().find((e) => e.sql.includes("reserve_sync_attempt_history") && e.binds.some((b) => typeof b === "string" && b.includes("storage-write-timeout")))).toBeUndefined();
  });

  it("hard-times out a non-cooperative adapter attempt", async () => {
    const fetch = mockReg(async () => new Promise<never>(() => undefined)), { syncLiveReserves } = await import("../sync-live-reserves"), db = mockD1();
    const p = syncLiveReserves(db, runController.signal, {}, undefined, { runBudgetMs: 20, adapterTimeoutMs: 10, d1FinalizeTimeoutMs: 1, finalizationMarginMs: 1 });
    await vi.advanceTimersByTimeAsync(11); const res = await p;
    expect(fetch).toHaveBeenCalledTimes(1); expect(res?.status).toBe("error");
    expect(JSON.parse(res?.metadata ?? "{}")).toMatchObject({ failed: 1, deferredCoins: configuredCount - 1, runBudgetTruncated: true, reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed", "reserve-run-budget-deferred"] });
    expect(db.getHistory().find((e) => e.sql.includes("reserve_sync_attempt_history") && e.binds.some((b) => typeof b === "string" && b.includes("adapter-timeout")))).toBeDefined();
  });

  it("bounds non-cooperative fallback chains without treating the local deadline as source failure", async () => {
    const target = QUEUE.find((c) => (c.liveReservesConfig?.inputs.fallbacks?.length ?? 0) >= 2 && c.liveReservesConfig?.adapter !== "hive-hbd-protocol");
    if (!target) throw new Error("Expected multi-fallback source");
    const fetch = mockReg(async (c) => c?.id === target.id ? new Promise<never>(() => undefined) : healthy());
    const id = mkCkptId(2, "deadline-owner"), db = mockD1([mkCkptTable({ attemptNo: id.attemptNo, invocationId: id.invocationId, nextItemKey: target.id, itemsDone: QUEUE.findIndex((c) => c.id === target.id) }), { match: "UPDATE worker_scheduled_checkpoints", rows: [] }]);
    const p = runSync(db, { runBudgetMs: 60_000, adapterTimeoutMs: 20_000, d1FinalizeTimeoutMs: 30_000, finalizationMarginMs: 5_000 }, undefined, id);
    await vi.advanceTimersByTimeAsync(25_001); const res = await p;
    expect(fetch.mock.calls.filter(([c]) => c.id === target.id)).toHaveLength(2);
    expect(JSON.parse(res.metadata ?? "{}")).toMatchObject({ failed: 1, runBudgetTruncated: false, continuationPending: true });
    expect(recordOutcomeSafeMock).not.toHaveBeenCalledWith(expect.anything(), `live-reserves:${target.liveReservesConfig!.breakerScope ?? target.liveReservesConfig!.adapter}`, false);
    expect(db.getHistory().some((e) => e.sql.includes("reserve_sync_attempt_history") && e.binds[0] === target.id && e.binds.some((v) => typeof v === "string" && v.includes('"failureCategory":"run-budget-exhausted"')))).toBe(true);
  });

  it("records string abort reasons and the adapter fallback for non-error reasons", async () => {
    const { syncLiveReserves } = await import("../sync-live-reserves");
    for (const [reason, expAttempt, expRun] of [["operator cancelled", "operator cancelled", "operator cancelled"], [42, "adapter-timeout", "Operation aborted"]] as const) {
      const ctrl = new AbortController(), db = mockD1();
      mockReg(async () => { ctrl.abort(reason); return new Promise<never>(() => undefined); });
      await expect(syncLiveReserves(db, ctrl.signal, {})).rejects.toThrow(expRun);
      expect(db.getHistory().find((e) => e.sql.includes("reserve_sync_attempt_history") && e.binds.some((b) => typeof b === "string" && b.includes(expAttempt)))).toBeDefined();
    }
  });

  it("reports per-coin progress through the cron progress hook", async () => {
    mockHealthy(); const report = vi.fn(async (_u: unknown) => undefined);
    await runSync(mockD1(), undefined, report as never);
    const calls = report.mock.calls as Array<[{ stage?: string | null; itemsDone?: number | null; itemsTotal?: number | null; message?: string | null; metadata?: Record<string, unknown> | null }]>;
    expect(calls[0]?.[0]).toMatchObject({ stage: "setup", itemsDone: 0, itemsTotal: configuredCount, message: "Loaded live reserve sync state" });
    expect(calls.some(([u]) => u.stage === "syncing" && typeof u.metadata?.currentCoinId === "string" && typeof u.metadata?.currentAdapter === "string" && typeof u.metadata?.currentBreakerKey === "string")).toBe(true);
    expect(calls.filter(([u]) => u.stage === "syncing").length).toBeLessThanOrEqual(Math.ceil(configuredCount / 10));
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(configuredCount / 10) + 2);
    expect(calls[calls.length - 1]?.[0]).toMatchObject({ stage: "finalizing", itemsDone: configuredCount, itemsTotal: configuredCount });
  });

  it.each([
    ["below adapter timeout", { runBudgetMs: 1, adapterTimeoutMs: 20_000 }, "error"],
    ["below the finalize margin", { runBudgetMs: 1_699, adapterTimeoutMs: 1_000, d1FinalizeTimeoutMs: 500, finalizationMarginMs: 200 }, undefined],
  ] as const)("defers the full queue safely when remaining budget is %s", async (_label, budget, status) => {
    const fetch = mockHealthy(), res = await runSync(mockD1(), budget), meta = JSON.parse(res.metadata!);
    expect(fetch).not.toHaveBeenCalled();
    expect(meta).toMatchObject({ synced: 0, skipped: configuredCount, deferredCoins: configuredCount, runBudgetTruncated: true });
    if (status) { expect(res.status).toBe(status); expect(meta).toMatchObject({ reason: "reserve-run-budget-deferred", reasons: ["reserve-run-budget-deferred"] }); }
    else expect(meta.finalizationMarginMs).toBe(200);
  });

  it("keeps Yuzu's failed attempt and retained snapshot unchanged when acknowledging the cron finding", async () => {
    let now = Math.floor(Date.now() / 1000), fail = false;
    const reviews = await import("../../lib/reserve-feed-reviews"), review = { ...YUZU_REVIEW, reviewedAt: now - 1, expiresAt: now + 86400 };
    vi.spyOn(reviews, "resolveReserveFeedReviews").mockReturnValue({ activeById: new Map([[review.stablecoinId, review]]), expiredIds: [], invalidIds: [] });
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    mockReg(async (c) => { if (fail && c?.id === review.stablecoinId) throw new Error(review.errorPrefix!.replace("primary:http-json: ", "")); return healthy(); });
    const { db, sqlite } = fixtures.open(); await runSync(db);
    const snap = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(review.stablecoinId); expect(snap).toBeDefined();
    const origSucc = sqlite.prepare("SELECT last_success_at, last_success_attempt_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(review.stablecoinId);
    now += 60; fail = true; const res = await runSync(db);
    expect(res.status).toBe("ok");
    expect(JSON.parse(res.metadata!)).toMatchObject({ failed: 1, unacknowledgedFailed: 0, quality: { reason: "reserve-feed-failure-reviewed", acknowledgedFeedIds: [review.stablecoinId] } });
    const st = sqlite.prepare("SELECT * FROM reserve_sync_state WHERE stablecoin_id = ?").get(review.stablecoinId)!;
    expect(st).toMatchObject({ ...origSucc, last_status: "error", last_error: review.errorPrefix, last_attempted_at: now });
    expect(JSON.parse(String(st.metadata)).failureCategory).toBe(review.failureCategory);
    expect(sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(review.stablecoinId)).toEqual(snap);
  });

  it.each([0, 1])("exposes only a confirmed persisted failure for review (changed rows: %s)", async (changes) => {
    const coin = QUEUE.find((i) => i.id === "yzusd-yuzu")!, cfg = coin.liveReservesConfig!;
    const res = await syncReserveCoin({ db: mockD1([{ match: "UPDATE reserve_sync_state", rows: [], runMeta: { changes } }]), coin, signal: runController.signal, adapter: { ...ADAPTER_DEFS[cfg.adapter], fetch: vi.fn() }, runAdapter: async () => { throw new Error("issuer failure"); }, breakerCanFetch: new Map([[breakerKeyForConfig(cfg), true]]), previousState: null, d1FinalizeTimeoutMs: 1_000 });
    expect(res.status).toBe("failed");
    if (changes) expect(res.persistedFailure).toMatchObject({ stablecoinId: coin.id, lastStatus: "error", lastError: "issuer failure" });
    else expect(res.persistedFailure).toBeUndefined();
  });

  it.each([
    { name: "reviewed failure only", remaining: 0, expected: "ok" }, { name: "mixed reviewed and unexplained failures", remaining: 1, expected: "degraded" },
    { name: "reviewed feed excluded from an at-budget cohort", synced: 6, remaining: 2, expected: "ok" }, { name: "reviewed feed cannot dilute an over-budget cohort", synced: 5, remaining: 2, expected: "degraded" },
    { name: "expired review", expired: true, expected: "degraded" }, { name: "changed cause", changed: true, expected: "degraded" },
    { name: "timeout", timeout: true, expected: "degraded" }, { name: "uncertain persistence", uncertain: true, expected: "degraded" },
    { name: "unconfirmed persistence", unconfirmed: true, expected: "degraded" }, { name: "all failed but reviewed", synced: 0, expected: "ok" },
    { name: "reviewed circuit skip", circuit: true, expected: "ok" }, { name: "unreadable circuit history", circuit: true, unreadable: true, expected: "degraded" },
    { name: "budget exhausted before matching", budget: true, expected: "degraded" },
  ])("keeps raw attempts while accounting for $name", async (s) => {
    installYuzuReview(); const rev = YUZU_REVIEW, now = s.expired ? rev.expiresAt : rev.reviewedAt + 1;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const failure: ReserveSyncStateRecord = { stablecoinId: rev.stablecoinId, adapterKey: rev.adapterKey, breakerKey: "live-reserves:yzusd-yuzu", lastStatus: s.circuit ? "skipped" : "error", lastAttemptedAt: now, lastSuccessAt: now - 86400, lastAttemptId: "current-attempt", lastSuccessAttemptId: "retained-success", warningCount: 0, warnings: [], lastError: s.circuit ? null : `${rev.errorPrefix}${s.changed ? ": new cause" : ""}`, metadata: { failureCategory: s.timeout ? "network" : s.circuit ? "circuit-open" : rev.failureCategory, ...(s.uncertain ? { uncertainWrite: true } : {}) } };
    const orig = structuredClone(failure), synced = s.synced ?? 1, failed = s.circuit ? 0 : 1 + (s.remaining ?? 0), circuitSkipped = s.circuit ? 1 : 0;
    const db = mockD1([{ match: "status != 'skipped'", rows: [], first: { stablecoin_id: rev.stablecoinId, attempted_at: now - 1, adapter_key: rev.adapterKey, breaker_key: failure.breakerKey, status: "error", warnings: "[]", last_error: rev.errorPrefix, metadata: JSON.stringify({ failureCategory: rev.failureCategory }) }, ...(s.unreadable ? { throwError: new Error("history unreadable") } : {}) }]);
    const res = await finalizeRun({ db, total: synced + failed + circuitSkipped, runStartedAt: now, runStartedMs: (s.budget ? now - 3600 : now) * 1000, counts: { synced, failed, persistenceFailed: s.uncertain || s.unconfirmed ? 1 : 0, skipped: circuitSkipped, circuitSkipped, deferredCoins: 0, deferredSkipped: 0, attemptedCoins: synced + failed + circuitSkipped, ...(synced ? { latestPublishedAt: now - 2 } : {}) }, persistedFailures: s.unconfirmed ? [] : [failure], coinsWithErrors: failed ? [rev.stablecoinId] : [] });
    expect(res.status).toBe(s.expected); expect(failure).toEqual(orig);
    const meta = JSON.parse(res.metadata!), ack = s.expected === "ok" || (s.remaining ?? 0) > 0;
    expect(meta).toMatchObject({ failed, skipped: circuitSkipped, synced, unacknowledgedFailed: failed - (ack && !s.circuit ? 1 : 0), unacknowledgedCircuitSkipped: circuitSkipped - (ack && s.circuit ? 1 : 0) });
    expect(meta.adapterFailureBudget.attemptedFeeds).toBe(synced + failed - Number(ack && !s.circuit));
    if (ack) { expect(meta.quality).toMatchObject({ reason: "reserve-feed-failure-reviewed", acknowledgedFeedIds: [rev.stablecoinId] }); expect(meta.quality.acknowledgedFeeds).toEqual([rev]); }
    else expect(meta.quality).toBeUndefined();
    expect(meta.reason).toBe(s.expected === "ok" ? undefined : s.circuit ? "reserve-circuit-open" : "reserve-adapter-or-persistence-failed");
    expect(res.productivity).toEqual({ productive: synced > 0 }); expect(meta.outputPublishedAt).toBe(synced ? now - 2 : undefined);
  });

  const cRow = (synced: number, failed: number, skipped = 0, deferredCoins = 0, deferredSkipped = 0, circuitSkipped = 0) => ({ synced, failed, skipped, deferredCoins, deferredSkipped, circuitSkipped });
  it.each([
    { name: "simultaneous failure, budget deferral and circuit skip", counts: cRow(60, 10, 30, 25, 25, 5), status: "degraded", reason: "reserve-circuit-open", reasons: ["reserve-adapter-or-persistence-failed", "reserve-run-budget-deferred", "reserve-circuit-open"] },
    { name: "budget deferral only", counts: cRow(75, 0, 25, 25, 25, 0), status: "degraded", reason: "reserve-run-budget-deferred", reasons: ["reserve-run-budget-deferred"] },
    { name: "circuit skip only", counts: cRow(0, 0, 100, 0, 0, 100), status: "degraded", reason: "reserve-circuit-open", reasons: ["reserve-circuit-open"] },
    { name: "clean", counts: cRow(100, 0), status: "ok", reason: undefined, reasons: [] },
    { name: "one failed member of a hundred", counts: cRow(99, 1), status: "ok", reason: undefined, reasons: ["reserve-adapter-or-persistence-failed"] },
    { name: "one failed member of two", counts: cRow(1, 1), status: "degraded", reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed"] },
    { name: "two failed members of twenty", counts: cRow(18, 2), status: "ok", reason: undefined, reasons: ["reserve-adapter-or-persistence-failed"] },
    { name: "at the failure budget", counts: cRow(75, 25), status: "ok", reason: undefined, reasons: ["reserve-adapter-or-persistence-failed"] },
    { name: "above the failure budget", counts: cRow(74, 26), status: "degraded", reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed"] },
    { name: "one persistence failure of a hundred", persistenceFailed: 1, counts: cRow(99, 1), status: "degraded", reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed"] },
    { name: "one circuit-held member of a hundred", counts: cRow(99, 0, 1, 0, 0, 1), status: "degraded", reason: "reserve-circuit-open", reasons: ["reserve-circuit-open"] },
    { name: "circuit holds cannot dilute an over-budget fetched cohort", counts: cRow(2, 1, 97, 0, 0, 97), status: "degraded", reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed", "reserve-circuit-open"] },
    { name: "exact fresh-coverage equality after circuit exclusion", counts: cRow(3, 1, 96, 0, 0, 96), status: "degraded", reason: "reserve-circuit-open", reasons: ["reserve-adapter-or-persistence-failed", "reserve-circuit-open"] },
    { name: "deferred skip without a recorded deferred-coin count", counts: cRow(99, 0, 1, 0, 1, 0), status: "ok", reason: undefined, reasons: ["reserve-run-budget-deferred"] },
  ])("retains all applicable reasons with budget-aware terminal priority: $name", async ({ counts, status, reason, reasons, persistenceFailed = 0 }) => {
    const nowMs = Date.now(), res = await finalizeRun({ db: mockD1(), total: 100, runStartedAt: Math.floor(nowMs / 1000), runStartedMs: nowMs, counts: { ...counts, persistenceFailed, attemptedCoins: counts.synced + counts.failed + counts.circuitSkipped, ...(counts.synced > 0 ? { latestPublishedAt: 1_000 } : {}) } });
    const meta = JSON.parse(res.metadata ?? "{}");
    expect(res).toMatchObject({ status, itemCount: counts.synced, productivity: { productive: counts.synced > 0 } });
    expect(meta).toMatchObject({ reasons, failed: counts.failed, unacknowledgedFailed: counts.failed, persistenceFailed, runBudgetTruncated: counts.deferredCoins > 0 });
    expect(meta.adapterFailureBudget).toEqual({ maxFailureRatio: 0.25, attemptedFeeds: counts.synced + counts.failed, failedFeeds: counts.failed - persistenceFailed });
    expect(meta.reason).toBe(reason);
    expect(meta.outputPublishedAt).toBe(counts.synced > 0 ? 1_000 : undefined);
    if (counts.failed > 0 && persistenceFailed === 0 && counts.failed <= (counts.synced + counts.failed) * 0.25) expect(meta.quality.reasons).toEqual(["reserve-adapter-or-persistence-failed"]);
    expect(meta.reasons.length).toBeLessThanOrEqual(3); expect(new Set(meta.reasons).size).toBe(meta.reasons.length);
  });

  it.each([
    { name: "one failed feed in a two-feed tail", priorSynced: 328, priorFailed: 0, synced: 1, failed: 1, status: "ok" },
    { name: "an all-failed three-feed tail after a clean head", priorSynced: 327, priorFailed: 0, synced: 0, failed: 3, status: "ok" },
    { name: "an over-budget head followed by a clean tail", priorSynced: 90, priorFailed: 60, synced: 60, failed: 0, status: "degraded" },
    { name: "an exact-equality cohort", priorSynced: 6, priorFailed: 2, synced: 3, failed: 1, status: "ok" },
    { name: "a prior storage failure", priorSynced: 149, priorFailed: 1, priorPersistence: 1, synced: 2, failed: 0, status: "degraded" },
    { name: "missing prefix evidence", priorSynced: 150, priorFailed: 0, missing: true, synced: 2, failed: 0, status: "degraded" },
    { name: "a mismatched prefix frontier", priorSynced: 150, priorFailed: 0, mismatch: true, synced: 2, failed: 0, status: "degraded" },
  ])("grades the cumulative cohort for $name", async (s) => {
    const nowMs = Date.now(), prefix = s.priorSynced + s.priorFailed, complete = !s.missing && !s.mismatch;
    const res = await finalizeRun({ db: mockD1(), total: s.synced + s.failed, runStartedAt: Math.floor(nowMs / 1000), runStartedMs: nowMs, counts: { synced: s.synced, failed: s.failed, persistenceFailed: 0, skipped: 0, circuitSkipped: 0, deferredCoins: 0, deferredSkipped: 0, attemptedCoins: s.synced + s.failed }, cohortItemsDoneBeforeRun: prefix, cohortGradingBeforeRun: s.missing ? undefined : { itemsDone: prefix - Number(s.mismatch === true), complete: true, synced: s.priorSynced, failed: s.priorFailed, persistenceFailed: s.priorPersistence ?? 0, circuitSkipped: 0, attemptedCoins: prefix }, checkpointOwned: true });
    expect(res.status).toBe(s.status);
    const meta = JSON.parse(res.metadata!);
    expect(meta).toMatchObject({ failed: s.failed, synced: s.synced, unacknowledgedFailed: s.failed });
    expect(meta.adapterFailureBudget).toEqual({ maxFailureRatio: 0.25, attemptedFeeds: complete ? prefix + s.synced + s.failed : null, failedFeeds: complete ? s.priorFailed + s.failed - (s.priorPersistence ?? 0) : null });
    if (complete) expect(meta.cohortGrading).toMatchObject({ failed: s.priorFailed + s.failed, itemsDone: prefix + s.synced + s.failed });
    else expect(meta).toMatchObject({ cohortGrading: null, cohortGradingUnavailableReason: "checkpoint-grading-frontier-unavailable" });
  });

  it("finalizes breaker outcomes when deferred-tail persistence fails", async () => {
    const startedMs = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(startedMs);
    mockReg(async () => { clock.mockReturnValue(startedMs + 800); return healthy(); });
    const db = mockD1(), origBatch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (stmts) => { if (stmts.some((s) => { const p = s as unknown as { sql?: string; boundValues?: unknown[] }; return p.sql?.includes("INSERT INTO reserve_sync_state") && p.boundValues?.includes("run-budget-exhausted"); })) throw new Error("forced deferred-tail batch failure"); return origBatch(stmts); });
    const meta = JSON.parse((await runSync(db, { runBudgetMs: 1_000, adapterTimeoutMs: 100, d1FinalizeTimeoutMs: 100, finalizationMarginMs: 100 }))?.metadata ?? "{}");
    expect(meta).toMatchObject({ cursorTailState: "incomplete", cursorTailError: "Failed to record deferred reserve tail state: forced deferred-tail batch failure" });
    expect(meta.breakerOutcomesRecorded).toBeGreaterThan(0); expect(recordOutcomeSafeMock).toHaveBeenCalled();
  });

  it("does not repurpose Hive's corroborating node as a substitute primary", async () => {
    const fetch = mockReg(async (c) => { if (c?.id === "hbd-hive") throw new Error("material reads crossed a changing Hive head"); return { slices: [{ name: "Tracked vaults", pct: 100, risk: "low" as const }] }; });
    const db = mockD1(); await runSync(db);
    const hive = fetch.mock.calls.filter(([c]) => c.id === "hbd-hive");
    expect(hive).toHaveLength(1);
    expect(hive[0]![1].inputs).toMatchObject({ primary: { url: "https://api.openhive.network" }, fallbacks: [{ url: "https://api.deathwing.me" }] });
    expect(db.getHistory().some((e) => e.sql.includes("INSERT INTO reserve_composition") && e.binds[0] === "hbd-hive")).toBe(false);
  });

  const findHttpFallbackCoin = () => {
    const coin = ACTIVE_STABLECOINS.find((c) => c.liveReservesConfig?.inputs.primary.kind === "http-json" && c.liveReservesConfig.inputs.fallbacks?.length === 1 && c.liveReservesConfig.inputs.fallbacks[0]?.kind === "http-json");
    expect(coin).toBeDefined();
    const p = coin!.liveReservesConfig!.inputs.primary;
    if (p.kind !== "http-json") throw new Error("expected http-json primary");
    return { coin: coin!, primaryUrl: p.url };
  };

  it("emits a primary-fallback-used info warning when the fallback succeeds", async () => {
    const { coin, primaryUrl } = findHttpFallbackCoin();
    mockReg(async (_c, cfg) => { const inp = cfg?.inputs.primary; if (!inp || (inp.kind !== "http-json" && inp.kind !== "http-html")) throw new Error("unexpected input kind"); if (inp.url === primaryUrl) throw new Error("primary source down"); return { slices: [{ name: "Tracked vaults", pct: 100, risk: "low" as const }] }; });
    const db = mockD1(), res = await runSync(db);
    const att = db.getHistory().find((e) => e.sql.includes("reserve_sync_attempt_history") && e.binds[0] === coin.id);
    expect(typeof att!.binds[6]).toBe("string");
    expect((JSON.parse(att!.binds[6] as string) as Array<{ code?: string }>).find((w) => w.code === "primary-fallback-used")).toMatchObject({ effect: "info", severity: "info" });
    const lat = (JSON.parse(res.metadata ?? "{}") as { adapterLatency?: { groups?: Array<{ adapterKey?: string; stage?: string; attemptCount?: number }>; total?: { attemptCount?: number }; overflow?: boolean } }).adapterLatency;
    expect(lat?.groups?.find((g) => g.adapterKey === coin.liveReservesConfig!.adapter && g.stage === "fallback")?.attemptCount === 1 || (lat?.overflow === true && (lat.total?.attemptCount ?? 0) > configuredCount)).toBe(true);
  });

  it("persists full primary-plus-fallback failure context for reserve source chains", async () => {
    const { coin, primaryUrl } = findHttpFallbackCoin();
    mockReg(async (_c, cfg) => { const inp = cfg?.inputs.primary; if (!inp || (inp.kind !== "http-json" && inp.kind !== "http-html")) throw new Error("unexpected input kind"); throw new Error(inp.url === primaryUrl ? "primary reserve source failed" : "fallback reserve source failed"); });
    const db = mockD1(), res = await runSync(db);
    const attempts = [{ source: "primary", label: "primary:http-json", message: "primary reserve source failed" }, { source: "fallback", label: "fallback#1:http-json", message: "fallback reserve source failed" }];
    const att = db.getHistory().find((e) => e.sql.includes("reserve_sync_attempt_history") && e.binds.includes(coin.id) && e.binds.some((b) => typeof b === "string" && b.includes('"attemptSummaries"')));
    expect(JSON.parse(att!.binds.find((b): b is string => typeof b === "string" && b.includes('"attemptSummaries"'))!)).toMatchObject({ reason: "adapter-exception", attemptSummaries: attempts });
    expect(JSON.parse(res?.metadata ?? "{}").attemptFailureSummaries).toContainEqual({ stablecoinId: coin.id, adapter: coin.liveReservesConfig!.adapter, attempts });
  });
});

describe("buildSharedSourceCacheKey", () => {
  type Cfg = Parameters<typeof import("../sync-live-reserves-shared").buildSharedSourceCacheKey>[0];
  type Ad = Parameters<typeof import("../sync-live-reserves-shared").buildSharedSourceCacheKey>[1];
  const mkAd = (key: string) => ({ key, fetch: async () => ({ slices: [] }), sourceModel: "dynamic-mix", evidenceClass: "independent", sharedSourceMode: "source-invariant" }) as unknown as Ad;

  it("produces the same key regardless of key insertion order", async () => {
    const { buildSharedSourceCacheKey } = await import("../sync-live-reserves-shared"), ad = mkAd("mento");
    const a = buildSharedSourceCacheKey({ adapter: "mento", version: 1, semantics: "bucketed-collateral-mix", inputs: { primary: { kind: "http-json", url: "https://example.com/api" }, fallbacks: [{ kind: "http-json", url: "https://example.com/backup" }] }, params: { chain: "celo", foo: "bar" } } as unknown as Cfg, ad);
    const b = buildSharedSourceCacheKey({ params: { foo: "bar", chain: "celo" }, inputs: { fallbacks: [{ url: "https://example.com/backup", kind: "http-json" }], primary: { url: "https://example.com/api", kind: "http-json" } }, semantics: "bucketed-collateral-mix", version: 1, adapter: "mento" } as unknown as Cfg, ad);
    expect(a).toBeTypeOf("string"); expect(b).toBeTypeOf("string"); expect(a).toEqual(b);
  });

  it("keeps same-URL shared sources separate when parser params differ", async () => {
    const { buildSharedSourceCacheKey } = await import("../sync-live-reserves-shared"), ad = mkAd("circle-transparency");
    const base = { adapter: "circle-transparency", version: 1, semantics: "attestation-mix", inputs: { primary: { kind: "http-html", url: "https://www.circle.com/transparency" } } };
    expect(buildSharedSourceCacheKey({ ...base, params: { coinType: "usdc" } } as unknown as Cfg, ad)).not.toEqual(buildSharedSourceCacheKey({ ...base, params: { coinType: "eurc" } } as unknown as Cfg, ad));
  });
});

describe("syncReserveCoin makina sign contract", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  afterEach(() => fixtures.closeAll());
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../reserve-adapters/__tests__/fixtures");
  const strategyFx = JSON.parse(readFileSync(join(dir, "makina-strategy.json"), "utf8"));
  const allocFx = JSON.parse(readFileSync(join(dir, "makina-allocations.json"), "utf8"));
  const PARAMS = { allocationsUrl: "https://api.makina.finance/v1/strategies/0x6b006870C83b1Cd49E766Ac9209f8d68763Df721/allocations", machineAddress: "0x6b006870C83b1Cd49E766Ac9209f8d68763Df721", accountingTokenSymbol: "USDC", accountingTokenDecimals: 6, otherThresholdPct: 2, reconciliationTolerancePct: 0.5 };

  it("retains the accepted snapshot and original clocks when a below-tolerance debt loses its sign", async () => {
    const { sqlite, db } = fixtures.open(), coin = CONFIGURED_COINS.find((c) => c.id === "dusd-dialectic")!, sourceClock = Math.floor(Date.now() / 1000) - 120;
    const strategy = structuredClone(strategyFx), alloc = structuredClone(allocFx);
    strategy.meta.generated_at = alloc.meta.generated_at = new Date(sourceClock * 1000).toISOString();
    strategy.data.aum = strategy.data.lastReportedAum = "9990000000";
    alloc.data.base_tokens = [{ accounting_token_value: "10000000000", token: structuredClone(strategyFx.data.accountingToken) }];
    alloc.data.positions = [{ protocol: "aave-v4", value: "10000000", is_debt: true, updated_at: sourceClock }];
    const args = { db, coin, adapter: { ...ADAPTER_DEFS["makina-strategy"], fetch: vi.fn() }, signal: new AbortController().signal, breakerCanFetch: new Map([["live-reserves:makina-strategy", true]]), d1FinalizeTimeoutMs: 30_000, runAdapter: async () => adaptMakinaStrategyReserves(strategy, alloc, PARAMS) };
    expect((await syncReserveCoin({ ...args, previousState: null })).status).toBe("synced");
    const comp = () => sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(coin.id), before = comp(), prev = await getReserveSyncState(db, coin.id);
    expect(before).toBeDefined();
    delete alloc.data.positions[0].is_debt;
    expect((await syncReserveCoin({ ...args, previousState: prev })).status).toBe("failed");
    expect(comp()).toEqual(before);
    expect(await getReserveSyncState(db, coin.id)).toMatchObject({ lastStatus: "error", lastSuccessAt: prev!.lastSuccessAt, lastSuccessAttemptId: prev!.lastSuccessAttemptId, lastError: expect.stringMatching(/is_debt/) });
  });
});
