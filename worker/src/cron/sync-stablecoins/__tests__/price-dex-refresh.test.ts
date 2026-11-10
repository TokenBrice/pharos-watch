import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AbortModule from "../../../lib/abort";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import * as shared from "../shared";
import * as progress from "../enrich-prices-progress";
import * as dex from "../enrich-prices-dexscreener-pass";
import * as lifecycle from "../../../lib/pricing-provider-lifecycle";
import * as addressProviders from "../../../lib/address-price-providers";
import type { AddressPriceProviderCollectionResult } from "../../../lib/address-price-providers";
import * as circuit from "../../../lib/circuit-breaker";
import { getCache, setCacheIfNewer } from "../../../lib/db-cache";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import * as dexscreener from "../../../lib/dexscreener";
import { coingeckoResponse } from "../../../lib/__tests__/address-price-providers.test-support";
import * as coverage from "../../../lib/stablecoin-publication-coverage";
import { STABLECOIN_PRICE_GAP_REVIEWS } from "../../../lib/stablecoin-publication-coverage";
import { DEX_REFRESH_CACHE_KEY, PRICE_CORROBORATION_OBSERVATIONS_KEY, loadPriceCorroborationObservations } from "../price-corroboration-observations";
import type { PeggedAsset } from "../enrich-prices-shared";
import { nextDexRefreshCursor, planDexRefresh, runPriceDexRefresh } from "../price-dex-refresh";
import { makePeggedAsset } from "./_fixtures";
import * as shortLived from "../price-short-lived-refresh";

const { sleepWithSignalMock } = vi.hoisted(() => ({
  // Provider pacing (DexScreener 1100 ms between batches, CoinGecko on-chain
  // 250 ms between requests) is real I/O-shaped waiting, not the behavior under
  // test; zero it the way fetch-retry.test.ts does so the suite never sleeps
  // through the published rate limits.
  sleepWithSignalMock: vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => undefined),
}));
vi.mock("../../../lib/abort", async (importOriginal) => ({
  ...await importOriginal<typeof AbortModule>(),
  sleepWithSignal: sleepWithSignalMock,
}));

const id = "usdaf-asymmetry";
const target = { id, chain: "ethereum", target: "0x9cf12ccd6020b6888e4d4c4e4c7aca33c1eb91f8" };
const now = 1_800_000_540;
const observation = (observedAt: number, price = 0.99) => ({ ...target, source: "dexscreener-exact", price, observedAt, observedAtMode: "local_fetch" });
const published = () => makePeggedAsset({ id, symbol: "USDaf", price: null });
const allUnpriced = () =>
  new Map([...ACTIVE_META_BY_ID.values()].map((meta) => [meta.id, makePeggedAsset({ id: meta.id, symbol: meta.symbol, price: null })]))
// Already-refreshed rows whose first deployment sorts before Solana, so a
// missing Solana row falls behind the refresh batches without the missing-first tier.
const ethereumDexPricedRows = (count: number) => [...ACTIVE_META_BY_ID.values()]
  .filter((meta) => dex.buildDexScreenerTargets({ id: meta.id, name: meta.name, symbol: meta.symbol })[0]?.chain === "ethereum")
  .slice(0, count)
  .map((meta) => makePeggedAsset({
    id: meta.id, symbol: meta.symbol, price: 1, priceSource: "dexscreener-exact",
    priceObservedAt: now, priceObservedAtMode: "local_fetch", priceConfidence: "fallback",
  }));
const fixtures = createLatestSchemaFixtureTracker();
let db: D1Database;
function runRefresh(options: Partial<Omit<Parameters<typeof runPriceDexRefresh>[0], "db">> = {}) {
  return runPriceDexRefresh({ db, syncStartSec: now, ...options });
}
async function readRefreshState() {
  return JSON.parse((await getCache(db, DEX_REFRESH_CACHE_KEY))!.value);
}
beforeEach(() => {
  ({ db } = fixtures.open());
  vi.spyOn(shortLived, "runShortLivedPriceRefresh").mockResolvedValue({
    contractRefresh: { cohortSize: 0, resolved: 0, failedPasses: [], timedOut: false },
    jupiterRefresh: { cohortSize: 0, resolved: 0, failedPasses: [], timedOut: false },
    observations: [],
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fixtures.closeAll(); });

function prepareRefresh() {
  vi.spyOn(shared, "loadPreviousStablecoinsById");
  setPublished(published());
  vi.spyOn(progress, "loadFxRatesForPriceBounds").mockResolvedValue(undefined);
  vi.spyOn(lifecycle, "isProviderCircuitAllowed").mockResolvedValue(true);
  vi.spyOn(lifecycle, "recordProviderOutcomeSafe").mockResolvedValue(undefined);
  return vi.spyOn(dex, "runDexScreenerPass");
}

function setPublished(...assets: PeggedAsset[]) {
  vi.mocked(shared.loadPreviousStablecoinsById).mockResolvedValue({
    previousAssetsById: new Map(assets.map((asset) => [asset.id, asset])), cacheState: { state: "ok" },
  });
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
  it.each(["empty", "under-liquidity", "404"] as const)("invalidates an answered %s secondary hint and rediscovers the canonical route", async (response) => {
    prepareRefresh().mockRestore();
    const asset = makePeggedAsset({ id: "usdc-circle", symbol: "USDC", price: null });
    setPublished(asset);
    const reviewed = dex.buildDexScreenerTargets(asset);
    const secondary = reviewed.find((row) => row.chain !== reviewed[0].chain)!;
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, JSON.stringify({
      targets: [{ id: asset.id, chain: secondary.chain, target: secondary.address }], observations: [], cursor: 0,
    }), now - 900);
    const pairs = response === "under-liquidity" ? [{
      chainId: secondary.chain, dexId: "test", pairAddress: "0xpool",
      baseToken: { address: secondary.address, symbol: "USDC", name: "USDC" },
      quoteToken: { address: "0xquote", symbol: "USD", name: "USD" }, priceUsd: "1",
      liquidity: { usd: 1, base: 1, quote: 1 }, volume: null, pairCreatedAt: null,
    }] : [];
    vi.spyOn(dexscreener, "fetchDsTokenPoolsWithStatus").mockResolvedValue({
      ok: response !== "404", status: response === "404" ? 404 : 200, pairs,
    });
    const summary = await runRefresh();
    expect(summary).toMatchObject({ resolved: 0, attemptedBatches: 1, errorClasses: [] });
    expect(summary.assetDiagnostics).toEqual([expect.objectContaining({ assetId: asset.id, inCohort: true, hinted: true,
      attempt: expect.objectContaining({ result: "empty", rejectionClass: response === "under-liquidity" ? "missing-liquidity" : "empty-response" }) })]);
    expect(summary.providerDiagnostics).toEqual([expect.objectContaining({ status: response === "404" ? 404 : 200, success: true })]);
    const state = await readRefreshState();
    expect(state.targets).toEqual([]);
    expect(planDexRefresh([asset], state.targets, 0).batches[0][0].target).toEqual(reviewed[0]);
  });

  it("keeps cohort diagnostics ahead of stale hints and invalidates only answered misses", async () => {
    const fetch = prepareRefresh();
    const peer = makePeggedAsset({ id: "usdc-circle", symbol: "USDC", price: null });
    setPublished(published(), peer);
    const peerTarget = dex.buildDexScreenerTargets(peer)[0];
    const staleHints = [...ACTIVE_META_BY_ID.values()].filter((meta) => meta.id !== id && meta.id !== peer.id).flatMap((meta) => {
      const route = dex.buildDexScreenerTargets({ id: meta.id, name: meta.name, symbol: meta.symbol })[0];
      return route ? [{ id: meta.id, chain: route.chain, target: route.address }] : [];
    }).slice(0, 21);
    const hints = [...staleHints, target, { id: peer.id, chain: peerTarget.chain, target: peerTarget.address }];
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, JSON.stringify({ targets: hints, observations: [], cursor: 0 }), now - 900);
    fetch.mockImplementation(async (assets, _fx, _db, _signal, _history, _now, _missing, batch) => {
      const resolved = assets.find((row) => row.id === peer.id)!;
      Object.assign(resolved, { price: 1, priceSource: "dexscreener-exact", priceConfidence: "fallback", priceObservedAt: now, priceObservedAtMode: "local_fetch" });
      return { resolved: 1, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 200, ok: true, success: true,
        assetAttempts: batch!.map(({ entry, target: attempted }) => ({
          assetId: entry.asset.id, adapter: "dexscreener-exact", source: "dexscreener-exact",
          chain: attempted.chain, target: attempted.address, state: "attempted",
          result: entry.asset.id === peer.id ? "resolved" : "empty", replaySafe: false,
        })) }] };
    });
    const summary = await runRefresh();
    expect(summary.assetDiagnostics.slice(0, 2)).toMatchObject([
      { assetId: id, inCohort: true, attempt: { result: "empty" } }, { assetId: peer.id, inCohort: true, attempt: { result: "resolved" } },
    ]);
    expect(summary.assetDiagnosticsTruncated).toBe(3);
    const state = await readRefreshState();
    expect(state.targets).toEqual([...staleHints, { ...hints[hints.length - 1], observedAt: now }]);
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

  it("skips missing rows under a reviewed price gap but keeps reviewed rows that are DEX-priced", () => {
    const rows = [
      makePeggedAsset({ id: "wusd-worldwide", price: null }),
      makePeggedAsset({ id: "bd-basedollar", price: 0.017, priceSource: "dexscreener-exact", priceObservedAt: now, priceObservedAtMode: "local_fetch", priceConfidence: "fallback" }),
      makePeggedAsset({ id: "usdt-tether", price: null }),
    ];
    const plan = planDexRefresh(rows, [], 0, new Set(["wusd-worldwide", "bd-basedollar"]));
    expect(plan.cohort.map((row) => row.id)).toEqual(["usdt-tether", "bd-basedollar"]);
    expect(plan.acknowledgedGapsSkipped).toBe(1);
  });

  it("batches missing-price rows ahead of already DEX-priced refreshes under budget overflow", () => {
    // Seven full Ethereum refresh batches (the old slot window) sit ahead of a
    // missing Solana row in payload order. A rejected primary quote must still
    // be scheduled: eligibility alone is not recovery if the batch budget is
    // consumed by cosmetic refreshes.
    const rows = [...ethereumDexPricedRows(7 * 30), makePeggedAsset({ id: "moveusd-cfx", symbol: "MOVEUSD", price: null })];
    const plan = planDexRefresh(rows, [], 0);
    expect(plan.allBatchCount).toBeGreaterThan(7);
    expect(plan.batches).toHaveLength(7);
    expect(plan.missingBatchCount).toBe(1);
    expect(plan.rotationTier).toBe("refresh");
    expect(plan.batches[0].map(({ entry }) => entry.asset.id)).toEqual(["moveusd-cfx"]);
  });

  it("rotates inside the missing tier while it overflows the slot budget", () => {
    const assets = [...ACTIVE_META_BY_ID.values()].map((meta) => makePeggedAsset({ id: meta.id, symbol: meta.symbol, price: null }));
    const first = planDexRefresh(assets, [], 0);
    expect(first.rotationTier).toBe("missing");
    const next = planDexRefresh(assets, [], nextDexRefreshCursor(first, first.batches.length));
    expect(next.batches[0][0].entry.asset.id).not.toBe(first.batches[0][0].entry.asset.id);
    expect(next.missingBatchCount).toBe(next.allBatchCount);
  });

  it("advances the refresh cursor only past the missing batches it scheduled", () => {
    const plan = planDexRefresh(
      [...ethereumDexPricedRows(7 * 30), makePeggedAsset({ id: "moveusd-cfx", symbol: "MOVEUSD", price: null })],
      [],
      0,
    );
    // A 429 before the missing batch is reached must not skip it next slot.
    expect(nextDexRefreshCursor(plan, 0)).toBe(0);
    // Every missing batch plus three refreshes advances three refresh batches.
    expect(nextDexRefreshCursor(plan, plan.missingBatchCount + 3)).toBe(3);
  });

  it("probes a missing-price row in the same slot as already-priced refreshes", async () => {
    vi.setSystemTime(now * 1000);
    prepareRefresh().mockRestore();
    const priced = ethereumDexPricedRows(7 * 30);
    const missing = makePeggedAsset({ id: "moveusd-cfx", symbol: "MOVEUSD", price: null });
    setPublished(...priced, missing);
    vi.spyOn(dexscreener, "fetchDsTokenPoolsWithStatus").mockImplementation(async (chain, addresses) => ({
      ok: true,
      status: 200,
      pairs: chain === "solana" && String(addresses).includes("3AdhVEX6k85yNivHVXDEiY3WyP2WgFQTUZCahGaeC2qm")
        ? [{
            chainId: "solana", dexId: "orca", pairAddress: "63DFX4pkJkDs4LV5s1x1Z1658rkx8yvt7MY9XXGsBMUh",
            baseToken: { address: "3AdhVEX6k85yNivHVXDEiY3WyP2WgFQTUZCahGaeC2qm", name: "MoveUSD", symbol: "MOVEUSD" },
            quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USD Coin", symbol: "USDC" },
            priceNative: "0.9993", priceUsd: "0.9993",
            liquidity: { usd: 103_088.44, base: 5_117, quote: 97_974 },
            volume: { h24: 0.18 }, pairCreatedAt: 1_713_827_704_000,
          }]
        : [],
    } as never));

    const summary = await runRefresh();

    expect(summary).toMatchObject({ attemptedBatches: 7, resolved: 1 });
    const state = await readRefreshState();
    expect(state.observations).toEqual([
      expect.objectContaining({ id: "moveusd-cfx", source: "dexscreener-exact", price: 0.9993 }),
    ]);
    expect(state.cursor).toBe(6);
    // Publication adopts the fetched source; the next refresh must keep the now-priced row.
    Object.assign(missing, { price: state.observations[0].price, priceSource: "dexscreener-exact",
      priceObservedAt: state.observations[0].observedAt, priceObservedAtMode: "local_fetch", priceConfidence: "fallback" });
    setPublished(missing);
    vi.setSystemTime((now + 900) * 1000);
    expect(await runRefresh({ syncStartSec: now + 900 })).toMatchObject({
      resolved: 1, hintedAttempted: 1, assetDiagnostics: [expect.objectContaining({
        assetId: missing.id, inCohort: true, publishedSource: "dexscreener-exact", attempt: expect.objectContaining({ result: "resolved" }),
      })],
    });
    const next = await loadPriceCorroborationObservations(db, now + 1260);
    expect(next.byId.get(missing.id)?.[0].observedAt).toBe(now + 900);
    expect((await loadPriceCorroborationObservations(db, now + 1800)).byId.has(missing.id)).toBe(false);
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
    setPublished(asset);
    fetch.mockResolvedValue({ resolved: 0, failures: [] });
    await setCacheIfNewer(db, PRICE_CORROBORATION_OBSERVATIONS_KEY, JSON.stringify([
      { ...observation(now), id: asset.id, chain: secondary.chain, target: secondary.address },
    ]), now);
    await runRefresh({ syncStartSec: now + 900 });
    expect(fetch.mock.calls[0][7]?.[0].target).toEqual(secondary);
  });

  it("stages current contract and Jupiter quotes without rewriting their observation clocks", async () => {
    prepareRefresh().mockResolvedValue({ resolved: 0, failures: [] });
    const observations = [
      { id: "m-m0", source: "defillama-contract", price: 0.997, observedAt: now - 60, observedAtMode: "upstream" as const },
      { id: "xo-exodus", source: "jupiter", price: 0.999, observedAt: now, observedAtMode: "local_fetch" as const },
    ];
    vi.mocked(shortLived.runShortLivedPriceRefresh).mockResolvedValueOnce({
      contractRefresh: { cohortSize: 2, resolved: 1, failedPasses: [], timedOut: false },
      jupiterRefresh: { cohortSize: 2, resolved: 1, failedPasses: [], timedOut: false },
      observations,
    });
    const chainRpcs = new Map();
    const summary = await runRefresh({ jupiterApiKey: "test-key", chainRpcs });
    expect(shortLived.runShortLivedPriceRefresh).toHaveBeenCalledWith(expect.objectContaining({
      db, jupiterApiKey: "test-key", chainRpcs,
    }));
    expect(summary).toMatchObject({ contractRefresh: { resolved: 1 }, jupiterRefresh: { resolved: 1 } });
    const state = await readRefreshState();
    expect(state.observations).toEqual(observations);
    const staged = await loadPriceCorroborationObservations(db, now + 60);
    expect(staged.byId.get("m-m0")?.[0].observedAt).toBe(now - 60);
    expect(staged.byId.get("xo-exodus")?.[0].observedAt).toBe(now);
  });

  it("paces consecutive batches within the lane budget", async () => {
    const fetch = prepareRefresh();
    vi.spyOn(dexscreener, "dsRateLimit").mockResolvedValue(undefined);
    setPublished(...allUnpriced().values());
    fetch.mockResolvedValue({ resolved: 0, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 200, ok: true, success: true }] });
    await runRefresh();
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(dexscreener.dsRateLimit).toHaveBeenCalledTimes(fetch.mock.calls.length - 1);
  });

  it("stops issuing batches after a rate-limited refusal and defers the rest", async () => {
    const fetch = prepareRefresh();
    setPublished(...allUnpriced().values());
    fetch.mockResolvedValue({ resolved: 0, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 429, ok: false, success: false, errorClass: "rate-limited" }] });
    const summary = await runRefresh();
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

  it("recovers a non-closed refresh breaker when no candidate batch remains", async () => {
    const fetch = prepareRefresh();
    setPublished(makePeggedAsset({ id, symbol: "USDaf", price: 0.99, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: now, priceObservedAtMode: "upstream" }));
    for (let attempt = 0; attempt < 3; attempt++) await circuit.recordOutcome(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH, false);
    expect((await circuit.getCircuitRecord(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH)).state).toBe("open");
    const recover = vi.spyOn(lifecycle, "recoverProviderOnNoCandidates");

    const summary = await runRefresh();

    // The empty cohort must not consume a probe or a provider verdict; it
    // applies the documented no-candidate recovery instead of leaving the
    // breaker open until a future slot happens to have candidates again.
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH,
    }));
    expect(fetch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ cohortSize: 0, attemptedBatches: 0, resolved: 0, deferredBatches: 0,
      errorClasses: [], cacheWritten: true });
    expect(lifecycle.recordProviderOutcomeSafe).toHaveBeenCalledWith(expect.objectContaining({
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH, attempted: 0, successful: 0,
    }));
    const record = await circuit.getCircuitRecord(db, CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH);
    expect(record.state).toBe("closed");
    expect(record.consecutiveFailures).toBe(0);
  });

  it("writes no circuit outcome for an empty cohort while the breaker is healthy", async () => {
    prepareRefresh();
    setPublished(makePeggedAsset({ id, symbol: "USDaf", price: 0.99, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: now, priceObservedAtMode: "upstream" }));
    const recordOutcome = vi.spyOn(circuit, "recordOutcomeSafe");

    const summary = await runRefresh();

    expect(summary).toMatchObject({ cohortSize: 0, attemptedBatches: 0, errorClasses: [], cacheWritten: true });
    // A no-candidate run never fabricates an upstream success: the recovery is
    // a no-op on a closed breaker.
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("persists only newly fetched observations and retains routing hints after a failed refresh", async () => {
    const fetch = prepareRefresh();
    fetch.mockImplementation(async (assets, _fx, _db, _signal, _history, _now, _missing, batch) => {
      const asset = assets[batch![0].entry.index];
      Object.assign(asset, { price: .9891, priceSource: "dexscreener-exact", priceConfidence: "fallback", priceObservedAt: now, priceObservedAtMode: "local_fetch" });
      return { resolved: 1, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 200, ok: true, success: true,
        assetAttempts: [{ assetId: id, adapter: "dexscreener-exact", source: "dexscreener-exact", replaySafe: false, chain: target.chain, target: target.target, state: "attempted", result: "resolved", candidateAt: now }] }] };
    });
    expect(await runRefresh()).toMatchObject({ resolved: 1, cacheWritten: true, hintedAttempted: 0 });
    let state = await readRefreshState();
    expect(state.observations[0].observedAt).toBe(now);
    fetch.mockResolvedValue({ resolved: 0, failures: [], diagnostics: [{ source: "dexscreener-exact", stage: "fallback", endpoint: "test", status: 200, ok: false, success: false, errorClass: "timeout" }] });
    expect(await runRefresh({ syncStartSec: now + 900 })).toMatchObject({ resolved: 0, missingQuotes: 1, errorClasses: ["timeout"],
      hintedAttempted: 1, hintedResolved: 0 });
    state = await readRefreshState();
    expect(state.observations).toEqual([]);
    expect(state.targets).toEqual([{ ...target, observedAt: now }]);
  });

  it("fails explicitly for malformed routing state without fetching or replacing it", async () => {
    const fetch = prepareRefresh();
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, "bad-json", now);
    await expect(runRefresh({ syncStartSec: now + 900 })).rejects.toThrow("Invalid DEX routing state");
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
    const pending = runRefresh();
    await startedPromise;
    await vi.advanceTimersByTimeAsync(44_999);
    expect(requestSignal?.aborted).toBe(false);
    expect((await getCache(db, DEX_REFRESH_CACHE_KEY))!.value).toBe(oldValue);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ timedOut: true, attemptedBatches: 0, deferredBatches: 1,
      resolved: 0, missingQuotes: 1, errorClasses: ["timeout"], cacheWritten: true });
    // A batch aborted by this lane's own deadline never reached a provider
    // verdict: the circuit outcome must stay neutral (attempted 0), not count
    // the local wall-clock abort as a DexScreener failure.
    expect(lifecycle.recordProviderOutcomeSafe).toHaveBeenCalledWith(expect.objectContaining({
      circuitSource: CIRCUIT_SOURCE.DEXSCREENER_PRICES_REFRESH, attempted: 0, successful: 0,
    }));
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
    const pending = runRefresh({ signal: parent.signal });
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
    await expect(runRefresh()).rejects.toBe(failure);
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
    await expect(runRefresh()).rejects.toThrow("Invalid DEX routing state");
    expect(fetch).not.toHaveBeenCalled();
    expect(await getCache(db, key as string)).toMatchObject({ value: serialized, updatedAt: now - 60 });
  });

  it("fences a late refresh behind the newer slot", async () => {
    const fetch = prepareRefresh();
    fetch.mockResolvedValue({ resolved: 0, failures: [] });
    const value = JSON.stringify({ observations: [observation(now + 900)], targets: [target], cursor: 0 });
    await setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY, value, now + 900);
    expect(await runRefresh()).toMatchObject({ cacheWritten: false });
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

describe("exact-address coverage refresh", () => {
  // USDC: an active row whose only live lane is the exact-address provider.
  const usdc = () => makePeggedAsset({ id: "usdc-circle", symbol: "USDC", price: 0.9750917398,
    priceSource: "coingecko-onchain-address", priceConfidence: "fallback",
    priceObservedAt: now - 600, priceObservedAtMode: "local_fetch" });
  const addressProvider = { enabledProviders: "coingecko-onchain-address", cgApiKey: "cg-key" };
  const hint = { id: "usdc-circle", chain: "arbitrum", target: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", observedAt: now - 900 };
  const seedHint = () => setCacheIfNewer(db, DEX_REFRESH_CACHE_KEY,
    JSON.stringify({ observations: [], targets: [], cursor: 0, addressTargets: [hint] }), now - 900);
  const onchainRequest = (url: string) => url.includes("/onchain/networks/");
  // Only the deep network answers; everything else is an unindexed deployment,
  // exactly as the live provider sees USDC's long tail of chains.
  const onchainRoutes = (price = "0.9822") => [{
    match: (request: Request) => onchainRequest(request.url) && request.url.includes("/networks/arbitrum/"),
    respond: (request: Request) => coingeckoResponse(
      new URL(request.url).pathname.split("/tokens/multi/")[1]!.split(",")[0]!, price, "120000"),
  }, {
    match: (request: Request) => onchainRequest(request.url),
    status: 404,
    body: { error: { error_code: 404, error_message: "Not found" } },
  }];

  function prepareAddressRefresh(...published: PeggedAsset[]) {
    const fetch = prepareRefresh();
    setPublished(...published);
    fetch.mockResolvedValue({ resolved: 0, failures: [] });
    return fetch;
  }

  it("re-observes the row this lane prices and stages the quote for the next publication", async () => {
    prepareAddressRefresh(usdc());
    const cg = mockFetch(onchainRoutes());
    const before = Math.floor(Date.now() / 1_000);
    const recordOutcome = vi.spyOn(circuit, "recordOutcomeDecision").mockResolvedValue(undefined);
    const collect = vi.spyOn(addressProviders, "collectAddressPriceProviderQuotes");

    const summary = await runRefresh({ addressProvider });

    expect(summary.addressRefresh).toMatchObject({ enabled: true, cohortSize: 1, resolved: 1, circuitOpen: false,
      timedOut: false, failureClasses: [], successfulRequests: 1, cappedTargets: summary.addressRefresh.targetCount - 5 });
    expect(summary.addressRefresh.attemptedRequests).toBe(5);
    expect(summary.addressRefresh.targetCount).toBeGreaterThan(5);
    // Unindexed deployments are a healthy negative answer, never a circuit failure.
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.CG_ONCHAIN, "success");
    await expect(collect.mock.results[0]?.value).resolves.toMatchObject({
      providerOutcome: "success", attemptedRequests: 5, successfulRequests: 1,
    });
    const state = await readRefreshState();
    const observation = state.observations.find((row: { source: string }) => row.source === "coingecko-onchain-address");
    expect(observation).toMatchObject({ id: "usdc-circle", chain: "arbitrum", price: 0.9822, observedAtMode: "local_fetch" });
    expect(observation.observedAt).toBeGreaterThanOrEqual(before);
    expect(observation.observedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000));
    // The deployment that produced the quote becomes the next slot's routed target.
    expect(state.addressTargets).toEqual([{ ...hint, observedAt: observation.observedAt }]);
    expect(cg.getHistory().some((entry) => onchainRequest(entry.url))).toBe(true);
  });

  it("re-reads a stored deployment instead of re-probing every chain", async () => {
    prepareAddressRefresh(usdc());
    await seedHint();
    const cg = mockFetch(onchainRoutes());

    const summary = await runRefresh({ addressProvider });

    const requests = cg.getHistory().map((entry) => entry.url).filter(onchainRequest);
    expect(requests).toEqual([`https://pro-api.coingecko.com/api/v3/onchain/networks/arbitrum/tokens/multi/${hint.target}`]);
    expect(summary.addressRefresh).toMatchObject({ targetCount: 1, resolved: 1, cappedTargets: 0, successfulRequests: 1 });
  });

  it("refreshes a published address quote despite its gap review while excluding acknowledged missing rows", async () => {
    // Co-dated synthetic USDC and authored WUSD reviews: the spy returns the
    // real resolver's result for exactly these fixtures.
    const wusdReview = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide")!;
    const usdcReview = { ...wusdReview, stablecoinId: "usdc-circle" };
    const resolveReviews = coverage.resolveStablecoinPriceGapReviews;
    vi.spyOn(coverage, "resolveStablecoinPriceGapReviews").mockImplementation((ids, nowSec) =>
      resolveReviews(ids, nowSec, [usdcReview, wusdReview]));
    const slot = wusdReview.reviewedAt + 60;
    expect([...resolveReviews([...ACTIVE_META_BY_ID.keys()], slot, [usdcReview, wusdReview]).activeById.keys()].sort())
      .toEqual(["usdc-circle", "wusd-worldwide"]);
    prepareAddressRefresh({ ...usdc(), priceObservedAt: slot - 600 },
      makePeggedAsset({ id: "wusd-worldwide", symbol: "WUSD", price: null }));
    const cg = mockFetch(onchainRoutes());

    const summary = await runRefresh({ syncStartSec: slot, addressProvider });

    expect(summary.addressRefresh).toMatchObject({ cohortSize: 1, resolved: 1 });
    const state = await readRefreshState();
    expect(state.observations.filter((row: { source: string }) => row.source === "coingecko-onchain-address"))
      .toEqual([expect.objectContaining({ id: "usdc-circle", chain: "arbitrum", price: 0.9822 })]);
    expect(cg.getHistory().filter((entry) => onchainRequest(entry.url)).every((entry) =>
      !entry.url.includes("0x7cd017ca5ddb86861fa983a34b5f495c6f898c41"))).toBe(true);
  });

  it.each(["404", "missing", "thin"])("evicts a definitively unresolved %s address hint and broadens the next slot", async (kind) => {
    prepareAddressRefresh(usdc());
    await seedHint();
    const cg = mockFetch([{ match: (request) => onchainRequest(request.url),
      ...(kind === "404" ? { status: 404, body: { error: "not found" } }
        : kind === "missing" ? { body: { data: [] } }
          : { respond: (request: Request) => coingeckoResponse(new URL(request.url).pathname.split("/tokens/multi/")[1]!, "1", "1") }),
    }]);
    const missing = await runRefresh({ addressProvider });
    expect(missing.addressRefresh).toMatchObject({ resolved: 0, failureClasses: ["missing-quote"] });
    expect((await readRefreshState()).addressTargets).toEqual([]);
    cg.mockClear();
    mockFetch(onchainRoutes());
    const recovered = await runRefresh({ syncStartSec: now + 900, addressProvider });
    expect(recovered.addressRefresh.targetCount).toBeGreaterThan(1);
    expect(recovered.addressRefresh.resolved).toBe(1);
    expect((await readRefreshState()).addressTargets).toHaveLength(1);
  });

  it("records the exact-address circuit outcome and stages nothing when the provider refuses", async () => {
    prepareAddressRefresh(usdc());
    mockFetch([{ match: (request) => onchainRequest(request.url), status: 429, body: { error: "rate limited" } }]);
    const recordOutcome = vi.spyOn(circuit, "recordOutcomeDecision").mockResolvedValue(undefined);

    const summary = await runRefresh({ addressProvider });

    expect(summary.addressRefresh).toMatchObject({ enabled: true, resolved: 0, successfulRequests: 0,
      failureClasses: ["upstream-error"] });
    expect(recordOutcome).toHaveBeenCalledWith(db, CIRCUIT_SOURCE.CG_ONCHAIN, "failure");
    expect((await readRefreshState()).observations).toEqual([]);
  });

  it("skips the address lane without a request or circuit write while its breaker is open", async () => {
    prepareAddressRefresh(usdc());
    await seedHint();
    const cg = mockFetch(onchainRoutes());
    vi.spyOn(circuit, "shouldAttemptFetch").mockResolvedValue(false);
    const recordOutcome = vi.spyOn(circuit, "recordOutcomeDecision").mockResolvedValue(undefined);

    const summary = await runRefresh({ addressProvider });

    expect(summary.addressRefresh).toMatchObject({ enabled: true, circuitOpen: true, resolved: 0, attemptedRequests: 0 });
    expect(cg.getHistory().filter((entry) => onchainRequest(entry.url))).toEqual([]);
    expect(recordOutcome).not.toHaveBeenCalledWith(db, CIRCUIT_SOURCE.CG_ONCHAIN, expect.anything());
    expect((await readRefreshState()).addressTargets).toEqual([hint]);
  });

  it("runs no address request when the provider is unconfigured or the row is under a reviewed gap", async () => {
    prepareAddressRefresh(usdc());
    const cg = mockFetch([{ match: (request) => onchainRequest(request.url), respond: (request) =>
      coingeckoResponse(new URL(request.url).pathname.split("/tokens/multi/")[1]!.split(",")[0]!, "0.9822", "120000") }]);

    const disabled = await runRefresh();
    expect(disabled.addressRefresh).toMatchObject({ enabled: false, targetCount: 0, resolved: 0 });
    expect(cg.getHistory().filter((entry) => onchainRequest(entry.url))).toEqual([]);

    const review = STABLECOIN_PRICE_GAP_REVIEWS.find((entry) => entry.stablecoinId === "wusd-worldwide");
    expect(review).toBeDefined();
    prepareRefresh();
    setPublished(makePeggedAsset({ id: "wusd-worldwide", symbol: "WUSD", price: null }));
    cg.mockClear();
    const acknowledged = await runRefresh({ syncStartSec: review!.reviewedAt + 60, addressProvider });
    expect(acknowledged.addressRefresh).toMatchObject({ enabled: true, cohortSize: 0, targetCount: 0, resolved: 0 });
    expect(cg.getHistory().filter((entry) => onchainRequest(entry.url))).toEqual([]);
  });

  it("keeps the DEX lane and the staged payload intact when the address lane spends its deadline", async () => {
    vi.useFakeTimers();
    prepareAddressRefresh(usdc());
    vi.spyOn(addressProviders, "collectAddressPriceProviderQuotes").mockImplementation((params) => {
      let rejectRequest!: (reason?: unknown) => void;
      const pending = new Promise<AddressPriceProviderCollectionResult>((_resolve, reject) => { rejectRequest = reject; });
      params.signal!.addEventListener("abort", () => rejectRequest(params.signal!.reason), { once: true });
      return pending;
    });

    const pending = runRefresh({ addressProvider });
    await vi.advanceTimersByTimeAsync(25_000);

    await expect(pending).resolves.toMatchObject({ cacheWritten: true,
      addressRefresh: { enabled: true, timedOut: true, resolved: 0, failureClasses: [] } });
    expect(await getCache(db, DEX_REFRESH_CACHE_KEY)).not.toBeNull();
  });
});
