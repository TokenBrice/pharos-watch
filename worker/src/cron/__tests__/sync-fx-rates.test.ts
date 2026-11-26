import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { PRIMARY_CURRENCY_TO_PEG, SECONDARY_FX_CURRENCY_TO_PEG } from "../../lib/fx-config";
import { mockFetchRetry } from "../../test-helpers/cron";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  findCacheWrite,
  makeChainlinkFxFeed,
  makeCacheRow,
  makeCompleteFxRates,
  makeCommodityStablecoinsCacheRow,
  makeFxRatesMeta,
  makeUniformFxRatesProvenance,
  frankfurterBody,
  makeFxRatesDb,
  makeFxRatesFetchRoutes as fxMirrors,
  secondaryBody,
} from "./rates-cron.test-support";

// The raw wrapper is its own spy so one test can assert JSON paths never fall through to it.
const fetchRetryMocks = vi.hoisted(() => {
  const passthrough = async (url: string, opts?: RequestInit) => fetch(url, opts);
  return { passthrough, fetchWithRetry: vi.fn(passthrough) };
});

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchRetryMocks.fetchWithRetry,
  fetchJsonWithRetry: mockFetchRetry({ failureAsNull: true }).fetchJsonWithRetry,
  fetchTextWithRetry: mockFetchRetry({ failureAsNull: true }).fetchTextWithRetry,
}));

import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { syncFxRates } from "../sync-fx-rates";
import { loadExchangeRateApiPayload, loadFrankfurterPayload, loadSecondaryCurrencyCandidate } from "../sync-fx-rates-sources";
import { buildFxCacheStatus, getFxReferenceTypeFromState, hydrateFxRateState } from "../../lib/fx-rate-state";

interface CachedFxMeta {
  usableSyncAt?: number;
  mode?: string;
  consecutiveFallbackRuns?: number;
  sourceUpdatedAtByPeg: Record<string, number | null>;
  sourceCadenceByPeg: Record<string, string>;
  sourceDateByPeg: Record<string, string | null>;
  sourceLastSuccessAtBySource: Record<string, number>;
  sources: Record<string, string>;
  observations?: Record<string, Record<string, unknown>>;
}

interface SyncFxResultMeta {
  rateCount?: number;
  mode?: string;
  fallbackMode?: string;
  reason?: string;
  missing?: string[];
  consecutiveFallbackRuns?: number;
  casSkipped?: boolean;
  cacheWriteMode?: string;
  cacheWriteSucceeded?: boolean;
  validationIssues?: string;
  sources: Record<string, string>;
}

const FULL_USD_RATES = {
  EUR: 0.925, GBP: 0.79, CHF: 0.88, BRL: 5.0, JPY: 149.5, IDR: 15800, SGD: 1.35, TRY: 36,
  AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, PHP: 56, MXN: 17.2, CNH: 7.28, RUB: 90, UAH: 41, ARS: 1400, KGS: 87, NGN: 1370, XOF: 560,
  MYR: 4.5, KRW: 1380, HKD: 7.81, INR: 85.5, VND: 25000, KES: 129, GHS: 11.6, COP: 3200, CLP: 950, PEN: 3.4,
  CZK: 21.8, PLN: 3.8998, AED: 3.6725, NZD: 1.7,
};

const ETH_SILVER_FEED = "0x379589227b15F1a12195D3f2d90bBc9F31f95235";
const ALL_FX_DOWN = {
  frankfurter: "unavailable", secondary: "omit", cdn: "unavailable", pages: "unavailable", exchangeRate: "unavailable",
} as const;
const NO_SECONDARY_OR_METALS = {
  secondary: "omit", datedCdn: "omit", cdn: "omit", pages: "omit", gold: "omit", silver: "omit", openExchange: "omit",
} as const;

type DbArg = Parameters<typeof findCacheWrite>[0];
const nowSec = () => Math.floor(Date.now() / 1000);
const epochSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const parseMeta = (r: { metadata?: string }): SyncFxResultMeta => JSON.parse(r.metadata ?? "{}");
const readCache = (db: DbArg, key: string) => JSON.parse(String(findCacheWrite(db, key)?.binds[1] ?? "{}"));
const readRates = (db: DbArg): Record<string, number> => readCache(db, "fx-rates");
const readMeta = (db: DbArg): CachedFxMeta => readCache(db, "fx-rates-meta");
const hasEvent = (db: DbArg, name: string) => findCacheWrite(db, `cron:event:sync-fx-rates:${name}`);
const readEventMeta = (db: DbArg, name: string) => readCache(db, `cron:event:sync-fx-rates:${name}`).metadata;
const readCircuit = (db: DbArg, source: string) => readCache(db, `circuit:${source}`);
const hydratePublished = (db: DbArg, at = nowSec()) => hydrateFxRateState(
  { value: String(findCacheWrite(db, "fx-rates")?.binds[1] ?? "{}"), updatedAt: at },
  { value: String(findCacheWrite(db, "fx-rates-meta")?.binds[1] ?? "{}"), updatedAt: at },
);

const lowerUsd = (overrides: Record<string, number> = {}): Record<string, number> => ({
  ...Object.fromEntries(Object.entries(FULL_USD_RATES).map(([c, v]) => [c.toLowerCase(), v])),
  ...overrides,
});
const usdFromRates = (rates: Record<string, number>, overrides: Record<string, number> = {}) => ({
  ...Object.fromEntries(
    [...Object.entries(PRIMARY_CURRENCY_TO_PEG), ...Object.entries(SECONDARY_FX_CURRENCY_TO_PEG)]
      .map(([c, peg]) => [c.toLowerCase(), 1 / rates[peg]]),
  ),
  ...overrides,
});
const primaryWithout = (rates: Record<string, number>, omitCurrency: string) => ({
  ...frankfurterBody(),
  rates: Object.fromEntries(
    Object.entries(PRIMARY_CURRENCY_TO_PEG).filter(([c]) => c !== omitCurrency).map(([c, peg]) => [c, 1 / rates[peg]]),
  ),
});
const secondaryFromRates = (rates: Record<string, number>) =>
  secondaryBody(Object.fromEntries(Object.entries(SECONDARY_FX_CURRENCY_TO_PEG).map(([c, peg]) => [c, 1 / rates[peg]])));

const freshSourceSuccess = (at: number, overrides: Record<string, number> = {}) => ({
  "secondary:jsdelivr": at, "secondary:pages.dev": at, "secondary:jsdelivr-versioned": at,
  openExchangeRates: at, metals: at, chainlink: at, ...overrides,
});

function splitDailyProvenance(
  rates: Record<string, number>,
  primaryUpdatedAt: number,
  secondaryUpdatedAt: number,
  primaryDate = "2025-06-13",
  secondaryDate = "2025-06-15",
) {
  const sec = new Set(Object.values(SECONDARY_FX_CURRENCY_TO_PEG));
  const map = <T>(fn: (isSec: boolean) => T) =>
    Object.fromEntries(Object.keys(rates).map((k) => [k, fn(sec.has(k))]));
  return {
    sourceUpdatedAtByPeg: map((s) => (s ? secondaryUpdatedAt : primaryUpdatedAt)),
    sourceCadenceByPeg: map((s) => (s ? "calendar-daily" : "business-daily")),
    sourceDateByPeg: map((s) => (s ? secondaryDate : primaryDate)),
    sourceModeByPeg: map(() => "live"),
  };
}

function makePrevFxDb(
  rates: Record<string, number>,
  meta: unknown,
  at: number,
  extra: Omit<NonNullable<Parameters<typeof makeFxRatesDb>[0]>, "previousRates" | "previousMeta"> = {},
) {
  return makeFxRatesDb({
    previousRates: makeCacheRow(rates, at),
    previousMeta: meta === null ? null : makeCacheRow(meta, at),
    ...extra,
  });
}

function staleSilverDb(now: number) {
  const prev = makeCompleteFxRates({ peggedGOLD: 2900, peggedSILVER: 40.448374 });
  const meta = makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 3600 });
  meta.sourceUpdatedAtByPeg.peggedSILVER = now - 26 * 3600;
  return makePrevFxDb(prev, meta, now - 60);
}

function mockSilverChainlinkCorroboration(now: number, roundAgeSec: number) {
  const silverObservedAt = now - 30;
  const { routes, chainRpcs } = makeChainlinkFxFeed({
    chain: "ethereum", feedAddress: ETH_SILVER_FEED, answer: 5_037_800_000n, updatedAt: now - roundAgeSec,
  });
  mockFetch([
    ...routes.filter((r) => !(typeof r.match === "string" && r.match.includes("gold-api.com/price/XAG"))),
    { match: "gold-api.com/price/XAG", body: { price: 50.39, updatedAt: new Date(silverObservedAt * 1000).toISOString() } },
  ], { requireMatch: true });
  return { chainRpcs, silverObservedAt };
}

function mockOlderSilverChainlink(now: number, answer: bigint) {
  const olderUpdatedAt = now - 11 * 3600;
  const { routes, chainRpcs } = makeChainlinkFxFeed({
    chain: "ethereum", feedAddress: ETH_SILVER_FEED, answer, updatedAt: olderUpdatedAt,
  });
  mockFetch(routes, { requireMatch: true });
  return { chainRpcs, olderUpdatedAt };
}

function mockZeroUsableOxr() {
  vi.setSystemTime(new Date("2025-06-16T08:00:00Z"));
  mockFetch(fxMirrors({
    secondary: { body: secondaryBody({}, { date: null }) },
    openExchange: { body: { timestamp: nowSec() - 600, rates: { EUR: 0.01, GBP: 0.01 } } },
  }));
}

function resetFetchRetryMocks(): void {
  fetchRetryMocks.fetchWithRetry.mockReset().mockImplementation(fetchRetryMocks.passthrough);
  vi.mocked(fetchJsonWithRetry).mockClear();
}

describe("syncFxRates", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    resetFetchRetryMocks();
  });
  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function oxrFixture() {
    const { db, sqlite } = fixtures.open();
    const read = sqlite.prepare("SELECT value FROM cache WHERE key = ?");
    return { sqlite, read: (key: string) => read.get(key), run: () => syncFxRates(db, undefined, "oxr-key") };
  }
  const oxrCalls = (fetchSpy: ReturnType<typeof mockFetch>) =>
    fetchSpy.mock.calls.filter(([url]) => String(url).includes("openexchangerates.org"));

  it("caches FX rates from frankfurter.dev when API succeeds", async () => {
    mockFetch(fxMirrors({
      frankfurter: { body: frankfurterBody({ HKD: 7.81, INR: 85.5 }) },
      secondary: { body: secondaryBody({ rub: 0, vnd: 26000, kes: 129, ghs: 11.6, cop: 3200, clp: 950, pen: 3.4 }) },
    }));
    const db = makeFxRatesDb();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncFxRates(db);
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.metadata).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://api.frankfurter.dev/v1/latest?base=USD&symbols="),
      expect.objectContaining({ headers: { "User-Agent": expect.any(String) } }),
    );

    const metadata = parseMeta(result);
    expect(metadata.rateCount).toBeGreaterThan(5);
    expect(metadata.sources.fawazahmed0).toBe("partial");
    expect(metadata.mode).toBe("live");

    const rates = readRates(db);
    expect(rates.peggedCNH).toBeCloseTo(1 / 7.28, 6);
    expect(rates.peggedCNH).not.toBe(rates.peggedCNY);
    expect(rates.peggedHKD).toBeCloseTo(1 / 7.81, 6);
    expect(rates.peggedINR).toBeCloseTo(1 / 85.5, 6);
    expect(rates).toMatchObject({
      peggedVND: 1 / 26_000, peggedIDR: 1 / 15_800, peggedCOP: 1 / 3_200,
      peggedCZK: 1 / 21.8, peggedPLN: 1 / 3.8998, peggedAED: 1 / 3.6725, peggedNZD: 1 / 1.7,
    });
    expect(rates.peggedRUB).toBeUndefined();
    expect(hasEvent(db, "hardcoded-rate-used")).toBeUndefined();
    expect(hasEvent(db, "ecb-rates-stale")).toBeUndefined();

    const meta = readMeta(db);
    expect(meta.usableSyncAt).toBe(nowSec());
    expect(meta.mode).toBe("live");
    expect(meta.sourceUpdatedAtByPeg.peggedEUR).toBeGreaterThan(0);
    expect(meta.sourceCadenceByPeg).toMatchObject({
      peggedEUR: "business-daily", peggedCNH: "calendar-daily",
      peggedCZK: "business-daily", peggedPLN: "business-daily",
      peggedNZD: "business-daily", peggedAED: "calendar-daily",
    });
    expect(meta.sourceDateByPeg).toMatchObject({
      peggedEUR: "2025-06-13", peggedCNH: "2025-06-15", peggedNZD: "2025-06-13", peggedAED: "2025-06-15",
    });
  });

  it.each([false, true])("publishes successful partial Frankfurter coverage with previous complete cache=%s", async (hasPrevious) => {
    const now = nowSec();
    const prev = makeCompleteFxRates();
    mockFetch(fxMirrors({
      frankfurter: { body: primaryWithout(prev, "EUR") },
      secondary: { body: secondaryFromRates(prev) },
      gold: { body: { price: 2900, updatedAt: new Date(now * 1000).toISOString() } },
      silver: { body: { price: 32, updatedAt: new Date(now * 1000).toISOString() } },
    }));
    const db = hasPrevious
      ? makePrevFxDb(prev, makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 3600 }), now - 60)
      : makeFxRatesDb();
    const result = await syncFxRates(db);
    const state = hydratePublished(db, now)!;
    expect(state.rates.peggedGBP).toBeGreaterThan(0);
    if (hasPrevious) {
      expect(state.rates.peggedEUR).toBe(prev.peggedEUR);
      expect(state.sourceUpdatedAtByPeg.peggedEUR).toBe(now - 3600);
      expect(state.sourceCadenceByPeg.peggedEUR).toBe("intraday");
      expect(buildFxCacheStatus(state, 1800, now).cacheStatus.degradedReason).toBeNull();
    } else {
      expect(state.rates.peggedEUR).toBeUndefined();
      expect(result.status).toBe("degraded");
      expect(parseMeta(result)).toMatchObject({
        reason: "incomplete-expected-fx-coverage", missing: expect.arrayContaining(["peggedEUR"]),
      });
      expect(buildFxCacheStatus(state, 1800, now).cacheStatus.healthy).toBe(false);
      expect(buildFxCacheStatus(state, 1800, now).cacheStatus.degradedReason).toContain("incomplete-expected-fx-coverage:");
    }
  });

  it.each([["fx-rates", "fx-rates-meta"], ["fx-rates-meta", "fx-rates"]] as const)(
    "a newer %s row blocks the whole FX pair publication",
    async (winningKey, losingKey) => {
      const { db, sqlite } = fixtures.open();
      const now = nowSec();
      const winningValue = JSON.stringify(winningKey === "fx-rates" ? { peggedEUR: 1.2345 } : { winner: "newer-provenance" });
      let publishedWinner = false;
      mockFetch(fxMirrors().map((route) => ({
        match: route.match,
        respond: () => {
          if (!publishedWinner) {
            publishedWinner = true;
            sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(winningKey, winningValue, now + 1);
          }
          return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
        },
      })));

      const result = await syncFxRates(db);
      expect(publishedWinner).toBe(true);
      expect(parseMeta(result)).toMatchObject({ casSkipped: true, cacheWriteMode: "skipped-newer", cacheWriteSucceeded: false });
      expect(result.itemCount).toBe(0);
      expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(winningKey)).toEqual({ value: winningValue, updated_at: now + 1 });
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(losingKey)).toBeUndefined();
    },
  );

  it("uses fresh commodity peer medians with a real quorum when gold-api.com is unavailable", async () => {
    mockFetch(fxMirrors({
      gold: { body: { error: "blocked" }, status: 503 },
      silver: { body: { error: "blocked" }, status: 503 },
    }));
    const now = nowSec();
    const stablecoinsUpdatedAt = now - 90;
    const stablecoins = JSON.parse(makeCommodityStablecoinsCacheRow(stablecoinsUpdatedAt).value) as {
      peggedAssets: { id: string; pegType: string; price: number; priceObservedAt: number }[];
    };
    for (const asset of stablecoins.peggedAssets) {
      if (asset.pegType === "peggedSILVER") asset.priceObservedAt = now - 7200;
    }
    stablecoins.peggedAssets.push({ ...stablecoins.peggedAssets[0], id: "future-gold", price: 2890, priceObservedAt: now + 1 });
    const prev = { peggedGOLD: 2900 };
    const db = makePrevFxDb(prev, makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 3600 }), now - 60, {
      stablecoins: makeCacheRow(stablecoins, stablecoinsUpdatedAt),
    });

    const result = await syncFxRates(db);
    expect(parseMeta(result)).toMatchObject({
      mode: "live", sources: { "gold-api.com": "error", "commodity-peer-median": "partial" },
    });

    const rates = readRates(db);
    expect(rates.peggedGOLD).toBeCloseTo(2905, 6);
    expect(rates.peggedSILVER).toBeUndefined();

    const meta = readMeta(db);
    expect(meta.sourceUpdatedAtByPeg.peggedGOLD).toBe(stablecoinsUpdatedAt - 30);
    expect(meta.sourceUpdatedAtByPeg.peggedSILVER).toBeUndefined();
    expect(meta.sourceCadenceByPeg.peggedGOLD).toBe("intraday");
    expect(meta.sourceDateByPeg.peggedGOLD).toBeNull();
    const state = hydratePublished(db, now);
    expect(state?.referenceMedianContributorsByPeg?.peggedGOLD?.map(({ assetId, observedAtSec }) => [assetId, observedAtSec]))
      .toEqual(["xaut-tether", "paxg-paxos", "kau-kinesis"].map((id) => [id, stablecoinsUpdatedAt - 30]));
    expect(state?.referenceMedianContributorsByPeg?.peggedSILVER).toBeUndefined();
  });

  it("rejects gold-api.com metal spots that diverge from the commodity peer median", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch(fxMirrors({ gold: { body: { price: 3100, updatedAt: new Date(Date.now() - 60_000).toISOString() } } }));
    const stablecoinsUpdatedAt = nowSec() - 120;
    const db = makeFxRatesDb({ stablecoins: makeCommodityStablecoinsCacheRow(stablecoinsUpdatedAt) });

    const result = await syncFxRates(db);
    expect(parseMeta(result)).toMatchObject({
      mode: "live", sources: { "gold-api.com": "partial", "commodity-peer-median": "partial" },
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Rejected gold-api.com peggedGOLD rate 3100"));

    const rates = readRates(db);
    expect(rates.peggedGOLD).toBeCloseTo(2905, 6);
    expect(rates.peggedSILVER).toBeCloseTo(32, 6);
    expect(readMeta(db).sourceUpdatedAtByPeg).toMatchObject({ peggedGOLD: stablecoinsUpdatedAt - 30, peggedSILVER: null });
  });

  it("keeps a stale cached silver spot when a dated low quote has no corroboration", async () => {
    const now = nowSec();
    mockFetch(fxMirrors({
      gold: { body: { price: 2900, updatedAt: new Date(now * 1000).toISOString() } },
      silver: { body: { price: 5.0378, updatedAt: new Date((now - 30) * 1000).toISOString() } },
    }));
    const db = staleSilverDb(now);
    const result = await syncFxRates(db);
    expect(parseMeta(result).sources["gold-api.com"]).toBe("partial");
    expect(readRates(db).peggedSILVER).toBeCloseTo(40.448374, 6);
    expect(readMeta(db).sourceUpdatedAtByPeg.peggedSILVER).toBe(now - 26 * 3600);
  });

  it("re-anchors a stale cached silver spot corroborated by a fresh Chainlink round", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = nowSec();
    const { chainRpcs, silverObservedAt } = mockSilverChainlinkCorroboration(now, 600);
    const db = staleSilverDb(now);
    const result = await syncFxRates(db, undefined, undefined, chainRpcs);
    expect(parseMeta(result).sources["gold-api.com"]).toBe("ok");
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Rejected peggedSILVER=50.39"));
    expect(readRates(db).peggedSILVER).toBeCloseTo(50.39, 6);
    expect(readMeta(db).sourceUpdatedAtByPeg.peggedSILVER).toBe(silverObservedAt);
  });

  it("does not treat a non-fresh Chainlink round as spot corroboration", async () => {
    const now = nowSec();
    const { chainRpcs } = mockSilverChainlinkCorroboration(now, 8 * 3600);
    const db = staleSilverDb(now);
    await syncFxRates(db, undefined, undefined, chainRpcs);
    expect(readRates(db).peggedSILVER).toBeCloseTo(40.448374, 6);
  });

  it("falls back to cached rates when frankfurter.dev is unavailable", async () => {
    mockFetch(fxMirrors({ frankfurter: "unavailable", secondary: "omit", gold: "omit", silver: "omit" }));
    const now = nowSec();
    const db = makePrevFxDb({ peggedEUR: 1.08, peggedRUB: 0.011 }, {
      usableSyncAt: now - 60,
      mode: "live",
      sourceUpdatedAtByPeg: { peggedEUR: now - 3600, peggedRUB: now - 7200 },
      sourceModeByPeg: { peggedEUR: "live", peggedRUB: "live" },
      sourceCadenceByPeg: { peggedEUR: "business-daily", peggedRUB: "calendar-daily" },
      sourceDateByPeg: { peggedEUR: "2025-06-14", peggedRUB: "2025-06-15" },
      consecutiveFallbackRuns: 0,
    }, now - 60);

    const result = await syncFxRates(db);
    expect(result.itemCount).toBe(2);
    expect(result.status).toBe("degraded");
    expect(parseMeta(result)).toMatchObject({
      reason: "incomplete-expected-fx-coverage", fallbackMode: "cached-fx-rates",
      mode: "cached-fallback", consecutiveFallbackRuns: 1,
    });
    expect(readMeta(db)).toMatchObject({
      usableSyncAt: now, mode: "cached-fallback", consecutiveFallbackRuns: 1,
      sourceUpdatedAtByPeg: { peggedEUR: now - 3600, peggedRUB: now - 7200 },
      sourceCadenceByPeg: { peggedEUR: "business-daily", peggedRUB: "calendar-daily" },
      sourceDateByPeg: { peggedEUR: "2025-06-14", peggedRUB: "2025-06-15" },
    });
  });

  it("uses the secondary FX mirror as a live full-set fallback when frankfurter.dev is unavailable", async () => {
    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      cdn: { body: { date: "2025-06-14", usd: lowerUsd({ eur: 0.93, gbp: 0.8, brl: 5.01, cnh: 7.31, nzd: 1.71 }) } },
      pages: { body: { date: "2025-06-15", usd: lowerUsd() } },
    }));
    const db = makeFxRatesDb();
    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    expect(parseMeta(result)).toMatchObject({
      mode: "live", fallbackMode: "secondary-live-fallback",
      sources: { frankfurter: "error", fawazahmed0: "ok" },
    });

    const rates = readRates(db);
    expect(rates.peggedEUR).toBeCloseTo(1 / 0.925, 6);
    expect(rates.peggedCNH).toBeCloseTo(1 / 7.28, 6);
    expect(rates.peggedNZD).toBeCloseTo(1 / 1.7, 6);

    const meta = readMeta(db);
    expect(meta.mode).toBe("live");
    expect(meta.sourceCadenceByPeg.peggedEUR).toBe("calendar-daily");
    expect(meta.sourceDateByPeg.peggedEUR).toBe("2025-06-15");
    for (const k of ["secondary:jsdelivr", "secondary:pages.dev", "secondary:jsdelivr-versioned"]) {
      expect(meta.sourceLastSuccessAtBySource[k]).toBeGreaterThan(0);
    }
  });

  it("preserves complete cached FX coverage and degrades when a live fallback is partial", async () => {
    const prev = makeCompleteFxRates();
    const now = nowSec();
    const partialUsd = lowerUsd({ brl: 5.1 });
    for (const k of ["eur", "czk", "pln", "aed", "nzd"]) delete partialUsd[k];
    mockFetch(fxMirrors({
      ...ALL_FX_DOWN, cdn: { body: { date: "2025-06-15", usd: partialUsd } }, gold: "omit", silver: "omit",
    }));
    const db = makePrevFxDb(prev, makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 48 * 3600 }), now - 60);

    const result = await syncFxRates(db);
    expect(result.status).toBe("degraded");
    expect(parseMeta(result)).toMatchObject({ reason: "partial-live-fallback-coverage", sources: { fawazahmed0: "partial" } });
    const rates = readRates(db);
    expect(rates).toMatchObject({ ...prev, peggedREAL: 1 / 5.1 });
    expect(rates.peggedEUR).toBe(prev.peggedEUR);
    const meta = readMeta(db);
    expect(meta.observations?.peggedREAL.source).toBe("fawazahmed0");
    expect(meta.sourceUpdatedAtByPeg.peggedEUR).toBe(now - 48 * 3600);
  });

  it("does not count a rejected secondary quote's stale previous value as live fallback coverage", async () => {
    const staleAt = nowSec() - 10 * 86_400;
    const prev = makeCompleteFxRates();
    // ARS devalues 1400 -> 1000 units/USD: 40% move, above the 20% prior-value bound.
    const usd = usdFromRates(prev, { ars: 1000 });
    mockFetch(fxMirrors({
      frankfurter: "unavailable", secondary: "omit", datedCdn: "unavailable",
      cdn: { body: { date: "2025-06-15", usd } }, pages: { body: { date: "2025-06-15", usd } },
      gold: "omit", silver: "omit",
    }));
    const db = makePrevFxDb(prev, makeFxRatesMeta(prev, {
      usableSyncAt: staleAt, updatedAt: staleAt, cadence: "calendar-daily", date: "2025-06-05",
    }), staleAt);

    const result = await syncFxRates(db);
    expect(result.status).toBe("degraded");
    expect(parseMeta(result)).toMatchObject({ reason: "partial-live-fallback-coverage", sources: { fawazahmed0: "partial" } });
    expect(readRates(db).peggedARS).toBe(prev.peggedARS);
  });

  it("does not count an out-of-bounds quote's stale previous value as live fallback coverage", async () => {
    const now = nowSec();
    const prev = makeCompleteFxRates();
    const prevMeta = makeFxRatesMeta(prev, {
      usableSyncAt: now - 900, updatedAt: now - 900, cadence: "calendar-daily", date: "2025-06-15",
    });
    prevMeta.sourceUpdatedAtByPeg.peggedAED = now - 3 * 86_400;
    prevMeta.sourceDateByPeg.peggedAED = "2025-06-12";
    // 2.5 AED/USD = 0.4 USD/AED, outside [0.25, 0.3].
    mockFetch(fxMirrors({
      frankfurter: "unavailable", secondary: "omit",
      cdn: { body: { date: "2025-06-15", usd: usdFromRates(prev, { aed: 2.5 }) } },
      gold: "omit", silver: "omit",
    }));
    const db = makePrevFxDb(prev, prevMeta, now - 900);

    const result = await syncFxRates(db);
    expect(result.status).toBe("degraded");
    expect(parseMeta(result)).toMatchObject({ reason: "partial-live-fallback-coverage", sources: { fawazahmed0: "partial" } });
    expect(readMeta(db).sources.fawazahmed0).toBe("partial");
  });

  it("uses ExchangeRate-API as a live full-set fallback when frankfurter and the secondary mirrors are unavailable", async () => {
    mockFetch(fxMirrors({
      ...ALL_FX_DOWN,
      datedCdn: { body: "definitely not json" },
      exchangeRate: {
        body: { result: "success", time_last_update_unix: epochSec("2025-06-15T00:02:31Z"), rates: FULL_USD_RATES },
      },
    }));
    const db = makeFxRatesDb();
    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    expect(parseMeta(result)).toMatchObject({
      mode: "live", fallbackMode: "exchange-rate-api-live-fallback",
      sources: { frankfurter: "error", exchangeRateApi: "ok" },
    });

    const rates = readRates(db);
    expect(rates.peggedEUR).toBeCloseTo(1 / 0.925, 6);
    expect(rates.peggedCNH).toBeCloseTo(1 / 7.28, 6);
    expect(rates.peggedNZD).toBeCloseTo(1 / 1.7, 6);
    expect(readMeta(db)).toMatchObject({
      mode: "live", sourceCadenceByPeg: { peggedEUR: "calendar-daily" }, sourceDateByPeg: { peggedEUR: "2025-06-15" },
    });
  });

  it("keeps timestamp-less live fallback values non-fresh", async () => {
    mockFetch(fxMirrors({
      ...ALL_FX_DOWN, datedCdn: "unavailable",
      exchangeRate: { body: { result: "success", rates: FULL_USD_RATES } },
    }));
    const db = makeFxRatesDb();
    const result = await syncFxRates(db);
    expect(result.status).toBe("degraded");
    expect(parseMeta(result)).toMatchObject({ reason: "incomplete-expected-fx-coverage", sources: { exchangeRateApi: "partial" } });
    const state = hydratePublished(db);
    expect(state?.sourceModeByPeg.peggedEUR).toBe("live");
    expect(state?.sourceUpdatedAtByPeg.peggedEUR).toBeNull();
    expect(getFxReferenceTypeFromState(state, "peggedEUR", 6 * 3600, nowSec())).toBe("none");
  });

  it("treats cadence-valid carry-forward rates as a live run when live FX fetches fail", async () => {
    mockFetch(fxMirrors(ALL_FX_DOWN));
    const prev = makeCompleteFxRates();
    const now = nowSec();
    const db = makePrevFxDb(prev, {
      usableSyncAt: now - 60, mode: "live", consecutiveFallbackRuns: 14,
      ...splitDailyProvenance(prev, epochSec("2025-06-13T16:00:00Z"), epochSec("2025-06-15T00:02:31Z")),
    }, now - 60);

    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    expect(parseMeta(result)).toMatchObject({
      mode: "live", fallbackMode: "cadence-valid-carry-forward",
      consecutiveFallbackRuns: 0, sources: { cache: "carry-forward" },
    });
    expect(readMeta(db)).toMatchObject({
      mode: "live", consecutiveFallbackRuns: 0,
      sourceDateByPeg: { peggedEUR: "2025-06-13", peggedCNH: "2025-06-15" },
    });
  });

  it("uses secondary API for non-ECB fiat rates including AED", async () => {
    mockFetch(fxMirrors({
      secondary: { body: secondaryBody({ kes: 129, ghs: 11.6, cop: 3200, clp: 950, pen: 3.4, aed: 3.672 }, { date: null }) },
    }));
    const db = makeFxRatesDb();
    await syncFxRates(db);
    expect(readRates(db).peggedAED).toBe(1 / 3.672);
  });

  it("does not synthesize an AED reference when live providers cannot supply a valid dirham quote", async () => {
    mockFetch(fxMirrors({ secondary: { body: secondaryBody({ aed: 0 }) }, exchangeRate: "unavailable" }));
    const db = makeFxRatesDb();
    await syncFxRates(db);
    expect(readRates(db)).toMatchObject({ peggedCZK: 1 / 21.8, peggedPLN: 1 / 3.8998 });
    expect(readRates(db).peggedAED).toBeUndefined();
  });

  it("degrades when Frankfurter omits NZD and inverts NZD on live secondary fallback", async () => {
    const full = makeCompleteFxRates();
    mockFetch(fxMirrors({ frankfurter: { body: primaryWithout(full, "NZD") }, secondary: { body: secondaryFromRates(full) } }));
    const db1 = makeFxRatesDb();
    const r1 = await syncFxRates(db1);
    expect(r1.status).toBe("degraded");
    expect(parseMeta(r1)).toMatchObject({ reason: "incomplete-expected-fx-coverage", missing: expect.arrayContaining(["peggedNZD"]) });
    expect(readRates(db1).peggedNZD).toBeUndefined();

    mockFetch(fxMirrors({ frankfurter: "unavailable", secondary: { body: { date: "2025-06-15", usd: lowerUsd() } } }));
    const db2 = makeFxRatesDb();
    expect((await syncFxRates(db2)).status).toBeUndefined();
    expect(readRates(db2).peggedNZD).toBe(1 / 1.7);
    expect(readMeta(db2).sourceCadenceByPeg.peggedNZD).toBe("calendar-daily");
  });

  it("prefers the fresher secondary FX mirror when the CDN payload lags a day behind", async () => {
    mockFetch(fxMirrors({
      secondary: "omit",
      cdn: { body: { date: "2025-06-14", usd: { cnh: 7.31, rub: 90.5, uah: 41.2, ars: 1401, kgs: 87.1, ngn: 1371, xof: 561 } } },
      pages: { body: secondaryBody() },
    }));
    const db = makeFxRatesDb();
    await syncFxRates(db);
    expect(readRates(db).peggedCNH).toBeCloseTo(1 / 7.28, 6);
    expect(readMeta(db).sourceDateByPeg.peggedCNH).toBe("2025-06-15");
  });

  it("keeps the fresher incumbent secondary generation when the only due mirror returns an older payload", async () => {
    const now = nowSec();
    const prev = makeCompleteFxRates();
    // Only pages.dev's 6h TTL has expired; its 2025-06-13 payload must not overwrite 2025-06-15.
    const db = makePrevFxDb(prev, {
      ...makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 60 }),
      ...splitDailyProvenance(prev, epochSec("2025-06-13T16:00:00Z"), epochSec("2025-06-15T05:00:00Z")),
      sourceLastSuccessAtBySource: freshSourceSuccess(now - 60, { "secondary:pages.dev": now - 7 * 3600 }),
    }, now - 60);
    mockFetch(fxMirrors({
      ...NO_SECONDARY_OR_METALS,
      pages: { body: secondaryBody({ cnh: 7.31, aed: 3.67 }, { date: "2025-06-13" }) },
    }));

    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    expect(readRates(db)).toMatchObject({ peggedCNH: prev.peggedCNH, peggedAED: prev.peggedAED });
    expect(readMeta(db).sourceDateByPeg).toMatchObject({ peggedCNH: "2025-06-15", peggedAED: "2025-06-15" });
    expect(hasEvent(db, "older-fx-observation-skipped")).toBeDefined();

    const state = hydratePublished(db, now);
    expect(state).not.toBeNull();
    expect(buildFxCacheStatus(state!, 1800, now).cacheStatus.sourceStatus).toBe("fresh");
  });

  it.each([0, 7 * 3600])("reports a partial Chainlink batch with one readable round aged %ss", async (age) => {
    const now = nowSec();
    const { routes, chainRpcs } = makeChainlinkFxFeed({
      chain: "base", feedAddress: "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F",
      answer: 108_101_000n, updatedAt: now - age,
    });
    mockFetch(routes, { requireMatch: true });
    const db = makeFxRatesDb();
    const result = await syncFxRates(db, undefined, undefined, chainRpcs);
    expect(parseMeta(result).sources.chainlink).toBe("partial");
    expect(readCircuit(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS)).toMatchObject({ consecutiveFailures: 0 });

    const rates = readRates(db);
    if (age > 0) {
      expect(rates.peggedEUR).toBeCloseTo(1 / 0.925);
      expect(readEventMeta(db, "chainlink-reference-out-of-budget")).toEqual({
        generation: now, rounds: { peggedEUR: { updatedAt: now - age, staleAfterSec: 6 * 3600 } },
      });
      return;
    }
    expect(rates.peggedEUR).toBeCloseTo(1.08101, 4);
    expect(readMeta(db)).toMatchObject({ sourceCadenceByPeg: { peggedEUR: "intraday" }, sourceDateByPeg: { peggedEUR: null } });
  });

  it.each([["2025-06-15T12:00:00Z", "2025-06-15"], ["2025-06-16T11:00:00Z", "2025-06-16"]])(
    "falls back for an impossible ECB fixing at %s",
    async (clock, date) => {
      vi.setSystemTime(new Date(clock));
      const rates = makeCompleteFxRates();
      mockFetch(fxMirrors({
        frankfurter: { body: { ...frankfurterBody(), date } },
        secondary: { body: secondaryBody(usdFromRates(rates), { date }) },
      }));
      const db = makeFxRatesDb();
      const result = await syncFxRates(db);
      expect(parseMeta(result)).toMatchObject({
        sources: { frankfurter: "invalid-payload" },
        fallbackMode: "secondary-live-fallback",
        validationIssues: "invalid-ecb-fixing-clock",
      });
      expect(readCircuit(db, CIRCUIT_SOURCE.FX_FRANKFURTER)).toMatchObject({ consecutiveFailures: 1 });
    },
  );

  it("reserves one OXR request per open hour and records a quota response", async () => {
    const { read, run } = oxrFixture();
    const fetchSpy = mockFetch(fxMirrors({ openExchange: { status: 429, body: { message: "quota" } } }));
    for (const [clock, calls] of [
      ["2025-06-15T12:00:00Z", 0], ["2025-06-16T08:00:00Z", 1],
      ["2025-06-16T08:30:00Z", 1], ["2025-06-16T09:00:00Z", 2],
    ] as const) {
      vi.setSystemTime(new Date(clock));
      await run();
      expect(oxrCalls(fetchSpy)).toHaveLength(calls);
    }
    const quota = read("cron:event:sync-fx-rates:openexchange-rates-quota-limited");
    expect(JSON.parse(String(quota?.value)).metadata).toMatchObject({ statusCode: 429 });
    expect(read("fx-oxr-last-success")).toBeUndefined();
  });

  it.each([false, true])("polls on the first eligible OXR recovery run with a transient storage failure=%s", async (failReservation) => {
    const { sqlite, read, run } = oxrFixture();
    const recoveredAt = Date.parse("2025-06-16T11:00:00Z");
    const fetchSpy = mockFetch([...fxMirrors({ openExchange: "omit" }), {
      match: "openexchangerates.org",
      respond: () => Date.now() < recoveredAt
        ? Response.json({ error: "provider failure" }, { status: 500 })
        : Response.json({ timestamp: recoveredAt / 1000, rates: { EUR: 0.925 } }),
    }]);
    const readOxrCircuit = () => JSON.parse(String(read(`circuit:${CIRCUIT_SOURCE.FX_REALTIME}`)?.value));
    for (const [time, calls, circuit] of [
      ["08:00", 1, "closed"], ["09:00", 2, "closed"], ["10:00", 3, "open"],
      ["10:30", 3, "open"], ["11:00", failReservation ? 3 : 4, failReservation ? "open" : "closed"],
      ["11:30", 4, "closed"],
    ] as const) {
      vi.setSystemTime(new Date(`2025-06-16T${time}:00Z`));
      if (failReservation && time === "11:00") {
        sqlite.exec("CREATE TEMP TRIGGER fail_oxr_reservation BEFORE INSERT ON cache WHEN NEW.key = 'fx-oxr-last-attempt' BEGIN SELECT RAISE(ABORT, 'test reservation failure'); END;");
      }
      if (failReservation && time === "11:30") sqlite.exec("DROP TRIGGER fail_oxr_reservation");
      await run();
      expect(oxrCalls(fetchSpy)).toHaveLength(calls);
      expect(readOxrCircuit().state).toBe(circuit);
    }
    expect(readOxrCircuit().lastSuccessAt).toBe(recoveredAt / 1000 + (failReservation ? 1800 : 0));
  });

  it("leaves the last successful OXR source clock intact after a future snapshot", async () => {
    const { read, run } = oxrFixture();
    const first = Date.parse("2025-06-16T08:00:00Z");
    const second = Date.parse("2025-06-16T09:00:00Z");
    mockFetch([...fxMirrors({ openExchange: "omit" }), {
      match: "openexchangerates.org",
      respond: () => Response.json({
        timestamp: nowSec() + (Date.now() === second ? 1 : 0),
        rates: { EUR: Date.now() === second ? 0.92 : 0.925 },
      }),
    }]);
    vi.setSystemTime(first);
    await run();
    vi.setSystemTime(second);
    expect(parseMeta(await run()).sources.openExchangeRates).toBe("unavailable");
    expect(read("fx-oxr-last-success")?.value).toBe(String(first / 1000));
    const meta = JSON.parse(String(read("fx-rates-meta")?.value));
    expect(meta.sourceLastSuccessAtBySource.openExchangeRates).toBe(first / 1000);
    expect(meta.observations.peggedEUR).toMatchObject({ observedAtSec: first / 1000, usdPerUnit: 1 / 0.925 });
    expect(JSON.parse(String(read("cron:event:sync-fx-rates:openexchange-rates-observation-rejected")?.value)).metadata)
      .toMatchObject({ reason: "timestamp-future", upstreamTimestamp: second / 1000 + 1 });
  });

  it("uses an older validated Chainlink timestamp when the metal source has no provenance", async () => {
    const { chainRpcs, olderUpdatedAt } = mockOlderSilverChainlink(nowSec(), 3_200_000_000n);
    const db = makeFxRatesDb();
    expect(parseMeta(await syncFxRates(db, undefined, undefined, chainRpcs)).sources.chainlink).toBe("partial");
    expect(readRates(db).peggedSILVER).toBeCloseTo(32, 6);
    expect(readMeta(db)).toMatchObject({
      sourceUpdatedAtByPeg: { peggedSILVER: olderUpdatedAt }, sourceCadenceByPeg: { peggedSILVER: "intraday" },
    });
    expect(hasEvent(db, "chainlink-older-metal-quote-validated")).toBeUndefined();
  });

  it("selects the dated Chainlink gold round when the spot clock is one second ahead", async () => {
    const now = nowSec();
    const { routes, chainRpcs } = makeChainlinkFxFeed({
      chain: "arbitrum", feedAddress: "0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c",
      answer: 291_000_000_000n, updatedAt: now - 15,
    });
    mockFetch([{ match: "gold-api.com/price/XAU", body: { price: 2900, updatedAt: new Date((now + 1) * 1000).toISOString() } }, ...routes], { requireMatch: true });
    const db = makeFxRatesDb();
    await syncFxRates(db, undefined, undefined, chainRpcs);
    const state = hydratePublished(db, now);
    expect(state?.rates.peggedGOLD).toBe(2910);
    expect(state?.observations?.peggedGOLD).toMatchObject({
      source: "chainlink", cadence: "intraday", observedAtSec: now - 15, usdPerUnit: 2910,
    });
    expect(getFxReferenceTypeFromState(state, "peggedGOLD", 21600, now)).toBe("fresh");
  });

  it("checks older Chainlink metal quotes for divergence before skipping them", async () => {
    const { chainRpcs } = mockOlderSilverChainlink(nowSec(), 4_200_000_000n);
    const db = makeFxRatesDb();
    expect(parseMeta(await syncFxRates(db, undefined, undefined, chainRpcs)).sources.chainlink).toBe("partial");
    expect(readRates(db).peggedSILVER).toBeCloseTo(32, 6);
    expect(readMeta(db).sourceUpdatedAtByPeg.peggedSILVER).toBeNull();
    expect(hasEvent(db, "chainlink-rate-diverged")).toBeDefined();
  });

  it("reconstructs daily fiat provenance from same-day live timestamps during carry-forward", async () => {
    mockFetch(fxMirrors(ALL_FX_DOWN));
    const prev = makeCompleteFxRates();
    const { sourceUpdatedAtByPeg, sourceModeByPeg } = makeUniformFxRatesProvenance(prev, {
      updatedAt: epochSec("2025-06-15T05:02:23Z"),
    });
    const now = nowSec();
    const db = makePrevFxDb(prev, {
      usableSyncAt: now - 60, mode: "cached-fallback", sourceUpdatedAtByPeg, sourceModeByPeg, consecutiveFallbackRuns: 12,
    }, now - 60);

    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    expect(parseMeta(result)).toMatchObject({
      mode: "live", fallbackMode: "cadence-valid-carry-forward",
      consecutiveFallbackRuns: 0, sources: { cache: "carry-forward" },
    });
    expect(readMeta(db)).toMatchObject({
      mode: "live", consecutiveFallbackRuns: 0,
      sourceCadenceByPeg: { peggedEUR: "business-daily", peggedCNH: "calendar-daily" },
      sourceDateByPeg: { peggedEUR: "2025-06-15", peggedCNH: "2025-06-15" },
    });
  });

  it("promotes cached fallback back to live when OXR restores fresh full-set FX coverage", async () => {
    vi.setSystemTime(new Date("2025-06-16T08:00:00Z"));
    const prev = makeCompleteFxRates();
    const now = nowSec();
    const oxrObservedAt = now - 600;
    mockFetch(fxMirrors({ ...ALL_FX_DOWN, openExchange: { body: { timestamp: oxrObservedAt, rates: FULL_USD_RATES } } }));
    const db = makePrevFxDb(prev, makeFxRatesMeta(prev, {
      usableSyncAt: now - 60, mode: "cached-fallback", updatedAt: epochSec("2025-06-12T12:00:00Z"), consecutiveFallbackRuns: 6,
    }), now - 60, { extraTables: [{ match: "circuit", rows: [], first: null }] });

    const result = await syncFxRates(db, undefined, "oxr-key");
    expect(result.status).toBeUndefined();
    expect(parseMeta(result)).toMatchObject({
      mode: "live", fallbackMode: "independent-live-recovery", consecutiveFallbackRuns: 0,
      sources: { openExchangeRates: "ok", cache: "recovered" },
    });
    expect(findCacheWrite(db, "fx-oxr-last-attempt")).toBeDefined();
    expect(findCacheWrite(db, "fx-oxr-last-success")).toBeDefined();
    expect(readMeta(db)).toMatchObject({
      mode: "live", consecutiveFallbackRuns: 0, sourceUpdatedAtByPeg: { peggedJPY: oxrObservedAt },
    });
  });

  it("preserves refreshed per-peg source metadata during cached fallback when recovery is only partial", async () => {
    vi.setSystemTime(new Date("2025-06-16T08:00:00Z"));
    const prev = makeCompleteFxRates({}, [
      "peggedMYR", "peggedKRW", "peggedHKD", "peggedINR", "peggedVND", "peggedKES", "peggedGHS",
      "peggedCOP", "peggedCLP", "peggedPEN", "peggedCZK", "peggedPLN", "peggedAED", "peggedNZD",
    ]);
    const staleAt = epochSec("2025-06-12T12:00:00Z");
    const now = nowSec();
    const oxrObservedAt = now - 600;
    mockFetch(fxMirrors({ ...ALL_FX_DOWN, openExchange: { body: { timestamp: oxrObservedAt, rates: { EUR: 0.925 } } } }));
    const db = makePrevFxDb(prev, makeFxRatesMeta(prev, {
      usableSyncAt: now - 60, mode: "cached-fallback", updatedAt: staleAt, consecutiveFallbackRuns: 2,
    }), now - 60, { extraTables: [{ match: "circuit", rows: [], first: null }] });

    const result = await syncFxRates(db, undefined, "oxr-key");
    expect(parseMeta(result)).toMatchObject({
      mode: "cached-fallback", fallbackMode: "cached-fx-rates",
      consecutiveFallbackRuns: 3, sources: { openExchangeRates: "ok" },
    });
    expect(readMeta(db)).toMatchObject({
      mode: "cached-fallback", consecutiveFallbackRuns: 3,
      sourceUpdatedAtByPeg: { peggedEUR: oxrObservedAt, peggedGBP: staleAt },
    });
    expect(readRates(db).peggedRUB).toBeUndefined();
  });

  it.each(["read", "write"])("records an OXR reservation %s error as a local storage outcome", async (operation) => {
    vi.setSystemTime(new Date("2025-06-16T08:00:00Z"));
    const fetchSpy = mockFetch(fxMirrors({ secondary: { body: secondaryBody({}, { date: null }) } }));
    const db = makeFxRatesDb({
      extraTables: [
        {
          match: operation === "read" ? "SELECT updated_at FROM cache WHERE key = ?" : "WHERE cache.updated_at < ?",
          matchBinds: operation === "read" ? ["fx-oxr-last-attempt"] : undefined,
          rows: [], throwError: new Error("telemetry write failed"),
        },
        { match: "circuit", rows: [] },
      ],
    });
    const result = await syncFxRates(db, undefined, "oxr-key");
    expect(result.itemCount).toBeGreaterThan(0);
    expect(findCacheWrite(db, "fx-rates")).toBeDefined();
    expect(findCacheWrite(db, "fx-rates-meta")).toBeDefined();
    expect(oxrCalls(fetchSpy)).toHaveLength(0);
    expect(readEventMeta(db, "openexchange-rates-reservation-failed")).toMatchObject({ operation });
    expect(findCacheWrite(db, `circuit:${CIRCUIT_SOURCE.FX_REALTIME}`)).toBeUndefined();
  });

  it("records the OXR cooldown after a completed response with zero usable rates", async () => {
    mockZeroUsableOxr();
    const db = makeFxRatesDb();
    const result = await syncFxRates(db, undefined, "oxr-key");
    expect(result.itemCount).toBeGreaterThan(0);
    expect(findCacheWrite(db, "fx-oxr-last-attempt")).toBeDefined();
    expect(findCacheWrite(db, "fx-oxr-last-success")).toBeUndefined();
    expect(parseMeta(result).sources.openExchangeRates).toBe("unavailable");
  });

  it("rejects a stale OXR snapshot instead of republishing it as a fresh overlay", async () => {
    vi.setSystemTime(new Date("2025-06-16T08:00:00Z"));
    mockFetch(fxMirrors({
      secondary: { body: secondaryBody({}, { date: null }) },
      // Within the 5% agreement band, so only its 30-day-old upstream time can reject it.
      openExchange: { body: { timestamp: nowSec() - 30 * 86_400, rates: { EUR: 0.93 } } },
    }));
    const db = makeFxRatesDb();
    expect(parseMeta(await syncFxRates(db, undefined, "oxr-key")).sources.openExchangeRates).toBe("unavailable");
    expect(findCacheWrite(db, "fx-oxr-last-attempt")).toBeDefined();
    expect(findCacheWrite(db, "fx-oxr-last-success")).toBeUndefined();
    expect(hasEvent(db, "openexchange-rates-observation-rejected")).toBeDefined();
    expect(readRates(db).peggedEUR).toBeCloseTo(1 / 0.925, 6);
    expect(readMeta(db).sourceCadenceByPeg.peggedEUR).toBe("business-daily");
  });

  it("releases the hour reservation when the OXR breaker declines the request", async () => {
    vi.setSystemTime(new Date("2025-06-16T08:00:00Z"));
    const now = nowSec();
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      `circuit:${CIRCUIT_SOURCE.FX_REALTIME}`,
      JSON.stringify({ state: "open", consecutiveFailures: 3, lastFailureAt: now - 60, lastSuccessAt: null, openedAt: now - 60 }),
      now - 60,
    );
    const fetchSpy = mockFetch(fxMirrors({ openExchange: { body: { timestamp: now, rates: { EUR: 0.925 } } } }));
    const read = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?");

    expect(parseMeta(await syncFxRates(db, undefined, "oxr-key")).sources.openExchangeRates).toBe("unavailable");
    expect(oxrCalls(fetchSpy)).toHaveLength(0);
    expect(read.get("fx-oxr-last-attempt")).toBeUndefined();
    expect(read.get("fx-oxr-last-success")).toBeUndefined();

    vi.setSystemTime((now + 1800) * 1000);
    await syncFxRates(db, undefined, "oxr-key");
    expect(oxrCalls(fetchSpy)).toHaveLength(1);
    const reservation = read.get("fx-oxr-last-attempt");
    expect(reservation?.updated_at).toBe(now + 1800);
    expect(Number.parseInt(String(reservation?.value), 10)).toBe(now + 1800);
  });

  it("records a breaker failure when OXR returns 200 with zero usable rates", async () => {
    mockZeroUsableOxr();
    const db = makeFxRatesDb();
    await syncFxRates(db, undefined, "oxr-key");
    expect(findCacheWrite(db, `circuit:${CIRCUIT_SOURCE.FX_REALTIME}`)).toBeDefined();
    const record = readCircuit(db, CIRCUIT_SOURCE.FX_REALTIME);
    expect(record.consecutiveFailures).toBe(1);
    expect(record.lastFailureAt).toBeGreaterThan(0);
  });

  it.each(["sourceLastSuccessAtBySource", "sourceLastSuccessAt"])("fetches only Frankfurter when %s TTL metadata is fresh", async (field) => {
    const now = nowSec();
    const prev = makeCompleteFxRates();
    const db = makePrevFxDb(prev, {
      ...makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 60 }),
      [field]: freshSourceSuccess(now - 60),
    }, now - 60);
    mockFetch(fxMirrors(NO_SECONDARY_OR_METALS));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncFxRates(db, undefined, "oxr-key");

    expect(result.itemCount).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.getHistory().filter((e) => e.sql.trimStart().startsWith("SELECT") && e.binds.includes("fx-rates-meta"))).toHaveLength(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("api.frankfurter.dev");
    expect(parseMeta(result).sources).toMatchObject({ fawazahmed0: "cached", openExchangeRates: "cached", chainlink: "cached" });
    expect(findCacheWrite(db, "fx-rates-meta")).toBeDefined();
  });

  it.each(["expired", "missing", "generation-mismatch"] as const)(
    "fetches secondary mirrors when source-success metadata is %s",
    async (condition) => {
      const now = nowSec();
      const prev = makeCompleteFxRates();
      const ttl = now - (condition === "expired" ? 21600 : 60);
      const previousMeta = condition === "missing" ? null : makeCacheRow({
        ...makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 60 }),
        sourceLastSuccessAtBySource: { "secondary:jsdelivr": ttl, "secondary:pages.dev": ttl, "secondary:jsdelivr-versioned": ttl },
      }, now - (condition === "generation-mismatch" ? 120 : 60));
      const fetchSpy = mockFetch(fxMirrors());
      await syncFxRates(makeFxRatesDb({ previousRates: makeCacheRow(prev, now - 60), previousMeta }));
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("currency-api"))).toHaveLength(3);
    },
  );

  it("attempts all secondary mirrors when Frankfurter fails despite fresh mirror TTLs", async () => {
    const now = nowSec();
    const prev = makeCompleteFxRates();
    const db = makePrevFxDb(prev, {
      ...makeFxRatesMeta(prev, { usableSyncAt: now - 60, updatedAt: now - 60 }),
      sourceLastSuccessAtBySource: freshSourceSuccess(now - 60),
    }, now - 60);
    const sec = { body: secondaryBody({ cnh: 7.28, rub: 90, uah: 41, ars: 1400, kgs: 87, ngn: 1370, xof: 560 }) };
    mockFetch(fxMirrors({
      ...NO_SECONDARY_OR_METALS, frankfurter: "unavailable", datedCdn: sec, cdn: sec, pages: sec,
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await syncFxRates(db, undefined, "oxr-key");

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.includes("api.frankfurter.dev"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("currency-api"))).toHaveLength(3);
  });

  it("skips a duplicate delivery for an already completed cadence bucket", async () => {
    const now = nowSec();
    const fetchMock = mockFetch([], { requireMatch: true });
    const db = makeFxRatesDb({
      cadence: makeCacheRow({
        version: 1, bucket: Math.floor(now / (30 * 60)), state: "completed",
        generation: "completed-test", claimedAt: now - 60, completedAt: now - 30,
      }, now - 30),
    });
    const result = await syncFxRates(db, undefined, undefined, undefined, undefined, undefined, { scheduledAtSec: now });
    expect(result.itemCount).toBe(0);
    expect(result.metadata).toBeDefined();
    expect(parseMeta(result).reason).toBe("cadence_bucket_completed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads secondary and ExchangeRate-API fallback JSON through body-aware retry helpers", async () => {
    mockFetch([
      { match: "cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest", body: { date: "2025-06-15", usd: { cnh: 7.28 } } },
      { match: "latest.currency-api.pages.dev", body: { date: "2025-06-14", usd: { cnh: 7.29 } } },
      { match: "cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2025.6.15", body: { date: "2025-06-15", usd: { cnh: 7.27 } } },
      { match: "open.er-api.com", body: { result: "success", time_last_update_unix: nowSec() - 60, rates: { EUR: 0.92 } } },
    ]);
    fetchRetryMocks.fetchWithRetry.mockImplementation(async () => {
      throw new Error("raw fetchWithRetry JSON path should not be used");
    });

    expect((await loadSecondaryCurrencyCandidate())?.endpoint).toBe("jsdelivr");
    expect((await loadExchangeRateApiPayload())?.rates.EUR).toBe(0.92);
    expect(fetchRetryMocks.fetchWithRetry).not.toHaveBeenCalled();
    const jsonUrls = vi.mocked(fetchJsonWithRetry).mock.calls.map(([url]) => String(url));
    expect(jsonUrls).toEqual(expect.arrayContaining([
      expect.stringContaining("@fawazahmed0/currency-api@latest"),
      expect.stringContaining("latest.currency-api.pages.dev"),
      expect.stringContaining("@fawazahmed0/currency-api@2025.6.15"),
      expect.stringContaining("open.er-api.com"),
    ]));
  });

  it("fires all secondary FX mirror fetches concurrently", async () => {
    const started = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockFetch([{ match: () => true, respond: async ({ url }) => {
      const endpoint = url.includes("latest.currency-api.pages.dev") ? "pagesDev"
        : url.includes("cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest") ? "jsdelivrLatest"
          : url.includes("cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@") ? "jsdelivrVersioned" : null;
      if (!endpoint) return new Response("not found", { status: 404 });
      started.add(endpoint);
      await gate;
      return Response.json(secondaryBody());
    } }]);

    const loading = loadSecondaryCurrencyCandidate();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect([...started].sort()).toEqual(["jsdelivrLatest", "jsdelivrVersioned", "pagesDev"]);
    } finally {
      release();
      await loading;
    }
  });

  it("uses the date-pinned jsdelivr package when @latest is behind", async () => {
    vi.setSystemTime(new Date("2026-05-20T07:30:00Z"));
    const fetchSpy = mockFetch([
      { match: "@2026.5.20/", body: { date: "2026-05-20", usd: { cnh: 7.18 } } },
      { match: "@latest", body: { date: "2025-05-19", usd: { cnh: 7.28 } } },
      { match: "pages.dev", body: { date: "2025-05-19", usd: { cnh: 7.28 } } },
    ]);
    const candidate = await loadSecondaryCurrencyCandidate();
    expect(candidate).toMatchObject({ endpoint: "jsdelivr-versioned", payload: { date: "2026-05-20", usd: { cnh: 7.18 } } });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("@2026.5.20/"))).toBe(true);
  });

  it("ignores malformed optional date-pinned secondary FX payloads when other mirrors are healthy", async () => {
    vi.setSystemTime(new Date("2026-05-20T07:30:00Z"));
    mockFetch([
      { match: "@2026.5.20/", body: "definitely not json" },
      { match: "@latest", body: { date: "2026-05-19", usd: { cnh: 7.28 } } },
      { match: "pages.dev", body: { date: "2026-05-18", usd: { cnh: 7.29 } } },
    ]);
    expect(await loadSecondaryCurrencyCandidate()).toMatchObject({
      endpoint: "jsdelivr", payload: { date: "2026-05-19", usd: { cnh: 7.28 } },
    });
  });

  it.each(["2099-01-01", "2025-06-16", "2025-02-30"])("rejects source date %s before ranking mirrors", async (date) => {
    mockFetch([
      { match: "api.frankfurter.dev", body: { base: "USD", date, rates: { EUR: 0.92 } } },
      { match: "@latest", body: { date, usd: { cnh: 7.28 } } },
      { match: "pages.dev", body: { date: "2025-06-15", usd: { cnh: 7.29 } } },
      { match: "@2025.6.15", body: { date, usd: { cnh: 7.28 } } },
    ]);
    expect(await loadFrankfurterPayload(["EUR"])).toMatchObject({ ok: false, kind: "invalid-payload" });
    expect(await loadSecondaryCurrencyCandidate()).toMatchObject({
      endpoint: "pages.dev", successfulEndpoints: ["pages.dev"],
    });
  });

  it.each(["EUR", "GBP", undefined])("rejects a Frankfurter payload with base=%s", async (base) => {
    const body = base === undefined ? { date: "2025-06-15", rates: { EUR: 0.92 } } : { base, date: "2025-06-15", rates: { EUR: 0.92 } };
    mockFetch([{ match: "api.frankfurter.dev", body }]);
    expect(await loadFrankfurterPayload(["EUR"])).toMatchObject({ ok: false, kind: "invalid-payload" });
  });

  it("accepts a USD-based Frankfurter payload", async () => {
    mockFetch([{ match: "api.frankfurter.dev", body: { base: "USD", date: "2025-06-15", rates: { EUR: 0.92 } } }]);
    expect(await loadFrankfurterPayload(["EUR"])).toMatchObject({ ok: true, data: { date: "2025-06-15", rates: { EUR: 0.92 } } });
  });

  it.each([60, 301])("rejects a source epoch %s seconds after the generation even if the fetch finishes later", async (ahead) => {
    const generation = Date.now() / 1000;
    mockFetch([{ match: "open.er-api.com", respond: () => {
      vi.setSystemTime((generation + ahead) * 1000);
      return Response.json({ result: "success", time_last_update_unix: generation + ahead, rates: { EUR: 0.92 } });
    } }]);
    expect(await loadExchangeRateApiPayload()).toBeNull();
  });
});
