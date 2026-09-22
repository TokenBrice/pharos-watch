import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import * as shared from "../shared";
import * as progress from "../enrich-prices-progress";
import * as dex from "../enrich-prices-dexscreener-pass";
import * as lifecycle from "../../../lib/pricing-provider-lifecycle";
import { getCache, setCacheIfNewer } from "../../../lib/db-cache";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import * as dexscreener from "../../../lib/dexscreener";
import { DEX_REFRESH_CACHE_KEY, PRICE_CORROBORATION_OBSERVATIONS_KEY, loadPriceCorroborationObservations } from "../price-corroboration-observations";
import { planDexRefresh, runPriceDexRefresh } from "../price-dex-refresh";
import { makePeggedAsset } from "./_fixtures";

const id = "usdaf-asymmetry";
const target = { id, chain: "ethereum", target: "0x9cf12ccd6020b6888e4d4c4e4c7aca33c1eb91f8" };
const now = 1_800_000_540;
const observation = (observedAt: number, price = 0.99) => ({ ...target, source: "dexscreener-exact", price, observedAt, observedAtMode: "local_fetch" });
const published = () => makePeggedAsset({ id, symbol: "USDaf", price: null });
const allUnpriced = () =>
  new Map([...ACTIVE_META_BY_ID.values()].map((meta) => [meta.id, makePeggedAsset({ id: meta.id, symbol: meta.symbol, price: null })]))
let sql: DatabaseSync;
let db: D1Database;
beforeEach(() => {
  sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db = createSqliteD1(sql);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sql.close(); });

function prepareRefresh() {
  vi.spyOn(shared, "loadPreviousStablecoinsById").mockResolvedValue({ previousAssetsById: new Map([[id, published()]]), cacheState: { state: "ok" } });
  vi.spyOn(progress, "loadFxRatesForPriceBounds").mockResolvedValue(undefined);
  vi.spyOn(lifecycle, "isProviderCircuitAllowed").mockResolvedValue(true);
  vi.spyOn(lifecycle, "recordProviderOutcomeSafe").mockResolvedValue(undefined);
  return vi.spyOn(dex, "runDexScreenerPass");
}

describe("DEX refresh continuity", () => {
  it("keeps a reviewed secondary route and rejects an unknown hint", () => {
    const meta = ACTIVE_META_BY_ID.get("usdc-circle")!;
    const asset = makePeggedAsset({ id: meta.id, symbol: meta.symbol, price: null, address: "ethereum:0xwrong" });
    const reviewed = dex.buildDexScreenerTargets({ ...asset, address: undefined });
    const secondary = reviewed.find((row) => row.chain !== reviewed[0].chain)!;
    const plan = planDexRefresh([asset], [{ id: asset.id, chain: secondary.chain, target: secondary.address }], 0);
    expect(plan.batches[0][0].target).toEqual(secondary);
    expect(planDexRefresh([asset], [{ id: asset.id, chain: "ethereum", target: "0xwrong" }], 0).batches[0][0].target).toEqual(reviewed[0]);
  });

  it("retains validated secondary hints through a healthy primary-price interlude", () => {
    const asset = makePeggedAsset({ id: "usdc-circle", symbol: "USDC", price: 1, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: now, priceObservedAtMode: "upstream" });
    const reviewed = dex.buildDexScreenerTargets(asset);
    const secondary = reviewed.find((row) => row.chain !== reviewed[0].chain)!;
    const hint = { id: asset.id, chain: secondary.chain, target: secondary.address, observedAt: now - 900 };
    const healthy = planDexRefresh([asset], [hint], 0);
    expect(healthy.cohort).toEqual([]);
    expect([...healthy.targetsById.values()]).toEqual([hint]);
    const missing = planDexRefresh([{ ...asset, price: null }], [...healthy.targetsById.values()], 0);
    expect(missing.batches[0][0].target).toEqual(secondary);
  });

  it("refreshes already DEX-priced active rows but excludes other priced and untracked rows", () => {
    const rows = [published(), makePeggedAsset({ id: "usdc-circle", price: 1, priceSource: "dexscreener-exact", priceObservedAt: now, priceObservedAtMode: "local_fetch", priceConfidence: "fallback" }),
      makePeggedAsset({ id: "usdt-tether", price: 1, priceSource: "coingecko", priceObservedAt: now, priceObservedAtMode: "upstream", priceConfidence: "single-source" }),
      makePeggedAsset({ id: "not-tracked", price: null })];
    expect(planDexRefresh(rows, [], 0).cohort.map((row) => row.id)).toEqual([id, "usdc-circle"]);
  });

  it("bounds batches and advances fairly under overflow", () => {
    const assets = [...ACTIVE_META_BY_ID.values()].map((meta) => makePeggedAsset({ id: meta.id, symbol: meta.symbol, price: null }));
    const first = planDexRefresh(assets, [], 0);
    expect(first.allBatchCount).toBeGreaterThan(7);
    expect(first.batches).toHaveLength(7);
    expect(first.batches.every((batch) => batch.length <= 30)).toBe(true);
    const next = planDexRefresh(assets, [], 7);
    expect(next.batches[0][0].entry.asset.id).not.toBe(first.batches[0][0].entry.asset.id);
    expect(new Set([...first.batches, ...next.batches].flat().map((item) => item.entry.asset.id)).size)
      .toBeGreaterThan(new Set(first.batches.flat().map((item) => item.entry.asset.id)).size);
  });

  it("imports a successful hourly secondary hint instead of falling back to the first deployment", async () => {
    const asset = makePeggedAsset({ id: "usdc-circle", symbol: "USDC", price: 1, priceSource: "dexscreener-exact", priceConfidence: "fallback", priceObservedAt: now, priceObservedAtMode: "local_fetch" });
    const targets = dex.buildDexScreenerTargets(asset);
    const secondary = targets.find((row) => row.chain !== targets[0].chain)!;
    const fetch = prepareRefresh();
    vi.mocked(shared.loadPreviousStablecoinsById).mockResolvedValue({ previousAssetsById: new Map([[asset.id, asset]]), cacheState: { state: "ok" } });
    fetch.mockResolvedValue({ resolved: 0, failures: [] });
    await setCacheIfNewer(db, PRICE_CORROBORATION_OBSERVATIONS_KEY, JSON.stringify([
      { ...observation(now), id: asset.id, chain: secondary.chain, target: secondary.address },
    ]), now);
    await runPriceDexRefresh({ db, syncStartSec: now + 900 });
    expect(fetch.mock.calls[0][7]?.[0].target).toEqual(secondary);
  });

  it("forwards the same loaded FX bounds as hourly fallback", async () => {
    const fetch = prepareRefresh();
    const fxRates = { peggedCHF: 1.22, peggedEUR: 1.15 };
    vi.mocked(progress.loadFxRatesForPriceBounds).mockResolvedValueOnce(fxRates);
    fetch.mockResolvedValue({ resolved: 0, failures: [] });
    await runPriceDexRefresh({ db, syncStartSec: now });
    expect(progress.loadFxRatesForPriceBounds).toHaveBeenCalledWith(db);
    expect(fetch.mock.calls[0][1]).toBe(fxRates);
  });

  it("paces consecutive batches within the lane budget", async () => {
    const fetch = prepareRefresh();
    vi.spyOn(dexscreener, "dsRateLimit").mockResolvedValue(undefined);
    vi.mocked(shared.loadPreviousStablecoinsById).mockResolvedValue({ previousAssetsById: allUnpriced(), cacheState: { state: "ok" } });
    fetch.mockResolvedValue({ resolved: 0, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 200, ok: true, success: true }] });
    await runPriceDexRefresh({ db, syncStartSec: now });
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(dexscreener.dsRateLimit).toHaveBeenCalledTimes(fetch.mock.calls.length - 1);
  });

  it("stops issuing batches after a rate-limited refusal and defers the rest", async () => {
    const fetch = prepareRefresh();
    vi.mocked(shared.loadPreviousStablecoinsById).mockResolvedValue({ previousAssetsById: allUnpriced(), cacheState: { state: "ok" } });
    fetch.mockResolvedValue({ resolved: 0, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 429, ok: false, success: false, errorClass: "rate-limited" }] });
    const summary = await runPriceDexRefresh({ db, syncStartSec: now });
    expect(fetch).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({ attemptedBatches: 1, timedOut: false, errorClasses: ["rate-limited"] });
    expect(summary.deferredBatches).toBeGreaterThanOrEqual(9);
    expect(lifecycle.isProviderCircuitAllowed).toHaveBeenCalledWith(expect.objectContaining({
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH,
    }));
    expect(lifecycle.recordProviderOutcomeSafe).toHaveBeenCalledWith(expect.objectContaining({
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH,
    }));
  });

  it("persists only newly fetched observations and retains routing hints after a failed refresh", async () => {
    const fetch = prepareRefresh();
    fetch.mockImplementation(async (assets, _fx, _db, _signal, _history, _now, _missing, batch) => {
      const asset = assets[batch![0].entry.index];
      Object.assign(asset, { price: .9891, priceSource: "dexscreener-exact", priceConfidence: "fallback", priceObservedAt: now, priceObservedAtMode: "local_fetch" });
      return { resolved: 1, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 200, ok: true, success: true,
        assetAttempts: [{ assetId: id, adapter: "dexscreener-exact", source: "dexscreener-exact", replaySafe: false, chain: target.chain, target: target.target, state: "attempted", result: "resolved", candidateAt: now }] }] };
    });
    expect(await runPriceDexRefresh({ db, syncStartSec: now })).toMatchObject({ resolved: 1, cacheWritten: true, hintedAttempted: 0 });
    let state = JSON.parse((await getCache(db, DEX_REFRESH_CACHE_KEY))!.value);
    expect(state.observations[0].observedAt).toBe(now);
    fetch.mockResolvedValue({ resolved: 0, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 200, ok: false, success: false, errorClass: "timeout" }] });
    expect(await runPriceDexRefresh({ db, syncStartSec: now + 900 })).toMatchObject({ resolved: 0, missingQuotes: 1, errorClasses: ["timeout"],
      hintedAttempted: 1, hintedResolved: 0 });
    state = JSON.parse((await getCache(db, DEX_REFRESH_CACHE_KEY))!.value);
    expect(state.observations).toEqual([]);
    expect(state.targets).toEqual([{ ...target, observedAt: now }]);
  });

  it("fails explicitly for malformed routing state without fetching or replacing it", async () => {
    const fetch = prepareRefresh();
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, "bad-json", now);
    await expect(runPriceDexRefresh({ db, syncStartSec: now + 900 })).rejects.toThrow("Invalid DEX routing state");
    expect(fetch).not.toHaveBeenCalled();
    expect((await getCache(db, DEX_REFRESH_CACHE_KEY))!.value).toBe("bad-json");
  });

  it("stops at the actual 45-second deadline without renewing a failed quote", async () => {
    vi.useFakeTimers();
    const fetch = prepareRefresh();
    const oldValue = JSON.stringify({ observations: [observation(now - 900)], targets: [target], cursor: 0 });
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, oldValue, now - 900);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let requestSignal: AbortSignal | undefined;
    fetch.mockImplementation((_assets, _fx, _db, signal) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      started();
    }));
    const pending = runPriceDexRefresh({ db, syncStartSec: now });
    await startedPromise;
    await vi.advanceTimersByTimeAsync(44_999);
    expect(requestSignal?.aborted).toBe(false);
    expect((await getCache(db, DEX_REFRESH_CACHE_KEY))!.value).toBe(oldValue);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ timedOut: true, attemptedBatches: 1, resolved: 0,
      missingQuotes: 1, errorClasses: ["timeout"], cacheWritten: true });
    const cache = (await getCache(db, DEX_REFRESH_CACHE_KEY))!;
    expect(cache.updatedAt).toBe(now);
    expect(JSON.parse(cache.value)).toMatchObject({ observations: [], targets: [target] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates parent cancellation without writing a refresh or provider outcome", async () => {
    const fetch = prepareRefresh();
    const oldValue = JSON.stringify({ observations: [observation(now - 60)], targets: [target], cursor: 0 });
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, oldValue, now - 60);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    fetch.mockImplementation((_assets, _fx, _db, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      started();
    }));
    const parent = new AbortController();
    const reason = new Error("slot ownership lost");
    const pending = runPriceDexRefresh({ db, syncStartSec: now, signal: parent.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await startedPromise;
    parent.abort(reason);
    await rejected;
    expect(await getCache(db, DEX_REFRESH_CACHE_KEY)).toMatchObject({ value: oldValue, updatedAt: now - 60 });
    expect(lifecycle.recordProviderOutcomeSafe).not.toHaveBeenCalled();
  });

  it("propagates unexpected executor errors without overwriting existing evidence", async () => {
    const fetch = prepareRefresh();
    const oldValue = JSON.stringify({ observations: [observation(now - 60)], targets: [target], cursor: 0 });
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, oldValue, now - 60);
    const failure = new TypeError("unexpected decoder failure");
    fetch.mockRejectedValueOnce(failure);
    await expect(runPriceDexRefresh({ db, syncStartSec: now })).rejects.toBe(failure);
    expect(await getCache(db, DEX_REFRESH_CACHE_KEY)).toMatchObject({ value: oldValue, updatedAt: now - 60 });
    expect(lifecycle.recordProviderOutcomeSafe).not.toHaveBeenCalled();
  });

  it.each([
    [DEX_REFRESH_CACHE_KEY, { observations: [], targets: [], cursor: -1 }],
    [DEX_REFRESH_CACHE_KEY, { observations: [], cursor: 0 }],
    [DEX_REFRESH_CACHE_KEY, null],
    [PRICE_CORROBORATION_OBSERVATIONS_KEY, {}],
  ])("rejects malformed routing payloads in %s before providers or writes", async (key, value) => {
    const fetch = prepareRefresh();
    const serialized = JSON.stringify(value);
    await setCacheIfNewer(db, key as string, serialized, now - 60);
    await expect(runPriceDexRefresh({ db, syncStartSec: now })).rejects.toThrow("Invalid DEX routing state");
    expect(fetch).not.toHaveBeenCalled();
    expect(await getCache(db, key as string)).toMatchObject({ value: serialized, updatedAt: now - 60 });
  });

  it("fences a late refresh behind the newer slot", async () => {
    const fetch = prepareRefresh();
    fetch.mockResolvedValue({ resolved: 0, failures: [] });
    const value = JSON.stringify({ observations: [observation(now + 900)], targets: [target], cursor: 0 });
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, value, now + 900);
    expect(await runPriceDexRefresh({ db, syncStartSec: now })).toMatchObject({ cacheWritten: false });
    expect((await getCache(db, DEX_REFRESH_CACHE_KEY))!.value).toBe(value);
  });

  it("does not attribute a valid DEX observation to a future hourly generation", async () => {
    await setCacheIfNewer(db, PRICE_CORROBORATION_OBSERVATIONS_KEY, JSON.stringify([observation(now + 900)]), now + 900);
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, JSON.stringify({ observations: [observation(now)], targets: [target], cursor: 0 }), now);
    const result = await loadPriceCorroborationObservations(db, now + 30);
    expect(result.summary).toMatchObject({ stagingStatus: "ok", hourlyStagingStatus: "future", dexStagingStatus: "ok",
      stagingSlotStartedAt: now, stagingAgeSec: 30, loadedObservationCount: 1, eligibleObservationCount: 1 });
    expect(result.byId.get(id)?.[0].observedAt).toBe(now);
  });

  it("merges by actual observation time, retains other sources, and never extends the 900-second source TTL", async () => {
    await setCacheIfNewer(db, PRICE_CORROBORATION_OBSERVATIONS_KEY, JSON.stringify([
      observation(now - 300), { ...observation(now - 30), source: "coinmarketcap" },
    ]), now);
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, JSON.stringify({ observations: [observation(now, .9891)], targets: [target], cursor: 0 }), now);
    const early = await loadPriceCorroborationObservations(db, now + 30);
    expect(early.byId.get(id)).toHaveLength(2);
    expect(early.byId.get(id)?.[0].observedAt).toBe(now);
    expect(early.summary.discarded.superseded).toBe(1);
    expect(early.summary.loadedObservationCount).toBe(early.summary.eligibleObservationCount + Object.values(early.summary.discarded).reduce((sum, count) => sum + count, 0));
    expect(early.summary.minimumFreshnessHeadroomSec).toBe(870);
    let result = await loadPriceCorroborationObservations(db, now + 899);
    expect(result.byId.get(id)).toHaveLength(2);
    expect(result.byId.get(id)?.find((row) => row.source === "dexscreener-exact")?.price).toBe(.9891);
    result = await loadPriceCorroborationObservations(db, now + 900);
    expect(result.byId.get(id)?.some((row) => row.source === "dexscreener-exact")).toBe(false);
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, JSON.stringify({ observations: [observation(now + 900)], targets: [target], cursor: 0 }), now + 900);
    expect((await loadPriceCorroborationObservations(db, now + 1260)).byId.get(id)?.some((row) => row.source === "dexscreener-exact")).toBe(true);
  });
});
