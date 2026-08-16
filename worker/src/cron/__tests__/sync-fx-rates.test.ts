import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 as createMockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { mockFetchRetry } from "../../test-helpers/cron";

// The raw wrapper is deliberately its own spy rather than the JSON wrapper's
// base: one test asserts the JSON path never falls through to it.
const fetchRetryMocks = vi.hoisted(() => {
  const passthrough = async (url: string, opts?: RequestInit) => fetch(url, opts);
  return { passthrough, fetchWithRetry: vi.fn(passthrough) };
});

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchRetryMocks.fetchWithRetry,
  fetchJsonWithRetry: mockFetchRetry({ failureAsNull: true }).fetchJsonWithRetry,
}));

import { fetchJsonWithRetry } from "../../lib/fetch-retry";

function resetFetchRetryMocks(): void {
  fetchRetryMocks.fetchWithRetry.mockReset().mockImplementation(fetchRetryMocks.passthrough);
  vi.mocked(fetchJsonWithRetry).mockClear();
}

import { syncFxRates } from "../sync-fx-rates";

function mockD1(tables: Parameters<typeof createMockD1>[0] = []) {
  return createMockD1([
    ...tables,
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT value FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT OR IGNORE INTO cache", rows: [] },
    { match: "INSERT INTO cache", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "UPDATE cache", rows: [] },
  ]);
}

type FxRoutes = NonNullable<Parameters<typeof mockFetch>[0]>;
type FxRoute = FxRoutes[number];
type FxRouteSpec = Omit<FxRoute, "match"> | "unavailable" | "omit";

/** The 503 body every upstream-down fx test uses. */
const FX_UNAVAILABLE = { body: { error: "Service unavailable" }, status: 503 } as const;

/** frankfurter.dev's baseline symbol set; HKD/INR are the only per-test additions. */
const FX_FRANKFURTER_RATES = {
  EUR: 0.925, GBP: 0.79, CHF: 0.88, JPY: 149.5, BRL: 5.0, IDR: 15800, SGD: 1.35, TRY: 36,
  AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, PHP: 56, MXN: 17.2,
};

/** The secondary mirror's baseline USD leg. */
const FX_SECONDARY_USD = { cnh: 7.28, rub: 90, uah: 41, ars: 1400, kgs: 87, ngn: 1370, xof: 560 };

function frankfurterBody(extraRates: Record<string, number> = {}) {
  return { base: "USD", date: "2025-06-15", rates: { ...FX_FRANKFURTER_RATES, ...extraRates } };
}

function secondaryBody(
  extraUsd: Record<string, number> = {},
  options: { date?: string | null } = {},
) {
  const { date = "2025-06-15" } = options;
  return {
    ...(date == null ? {} : { date }),
    usd: { ...FX_SECONDARY_USD, ...extraUsd },
  };
}

/**
 * Route list for the fx mirror ladder, ordered the way `mockFetch` resolves it
 * (first substring hit wins, so the dated jsDelivr path must precede the generic
 * jsDelivr match). Each axis defaults to the healthy baseline; pass a body to
 * change one, `"unavailable"` for the shared 503, or `"omit"` to drop the route
 * entirely (an omitted route is an unmatched fetch, which is how the
 * "everything is down" tests express a dead endpoint).
 */
function fxMirrors(axes: {
  frankfurter?: FxRouteSpec;
  datedCdn?: FxRouteSpec;
  cdn?: FxRouteSpec;
  pages?: FxRouteSpec;
  secondary?: FxRouteSpec;
  exchangeRate?: FxRouteSpec;
  openExchange?: FxRouteSpec;
  gold?: FxRouteSpec;
  silver?: FxRouteSpec;
} = {}): FxRoutes {
  const defaults: Record<string, { match: string; spec: FxRouteSpec }> = {
    frankfurter: { match: "frankfurter.dev", spec: { body: frankfurterBody() } },
    datedCdn: { match: "@2025.6.15/", spec: "omit" },
    cdn: { match: "cdn.jsdelivr.net/npm/@fawazahmed0/currency-api", spec: "omit" },
    pages: { match: "latest.currency-api.pages.dev", spec: "omit" },
    secondary: { match: "currency-api", spec: { body: secondaryBody() } },
    exchangeRate: { match: "open.er-api.com/v6/latest/USD", spec: "omit" },
    openExchange: { match: "openexchangerates.org", spec: "omit" },
    gold: { match: "gold-api.com/price/XAU", spec: { body: { price: 2900 } } },
    silver: { match: "gold-api.com/price/XAG", spec: { body: { price: 32 } } },
  };
  const routes: FxRoutes = [];
  for (const [axis, { match, spec: fallback }] of Object.entries(defaults)) {
    const spec = axes[axis as keyof typeof axes] ?? fallback;
    if (spec === "omit") continue;
    routes.push({ match, ...(spec === "unavailable" ? FX_UNAVAILABLE : spec) } as FxRoute);
  }
  return routes;
}

function findCacheWrite(
  db: ReturnType<typeof mockD1>,
  key: string,
): { sql: string; binds: unknown[] } | undefined {
  return db.getHistory().find(
    (entry) => entry.sql.includes("INTO cache") && entry.binds[0] === key,
  );
}

describe("syncFxRates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    resetFetchRetryMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caches FX rates from frankfurter.dev when API succeeds", async () => {
    mockFetch(fxMirrors({
      frankfurter: { body: frankfurterBody({ HKD: 7.81, INR: 85.5 }) },
      secondary: { body: secondaryBody({ vnd: 25000, kes: 129, ghs: 11.6, cop: 3200, clp: 950, pen: 3.4 }) },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncFxRates(db);
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.metadata).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://api.frankfurter.dev/v1/latest?base=USD&symbols="),
      expect.objectContaining({
        headers: { "User-Agent": expect.any(String) },
      }),
    );

    const metadata = JSON.parse(result.metadata!);
    expect(metadata.rateCount).toBeGreaterThan(5);
    expect(metadata.sources.fawazahmed0).toBe("ok");
    expect(metadata.mode).toBe("live");

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedCNH).toBeCloseTo(1 / 7.28, 6);
    expect(cachedRates.peggedCNH).not.toBe(cachedRates.peggedCNY);
    expect(cachedRates.peggedHKD).toBeCloseTo(1 / 7.81, 6);
    expect(cachedRates.peggedINR).toBeCloseTo(1 / 85.5, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      usableSyncAt: number;
      mode: string;
      sourceUpdatedAtByPeg: Record<string, number>;
      sourceCadenceByPeg: Record<string, string>;
      sourceDateByPeg: Record<string, string | null>;
    };
    expect(cachedMeta.usableSyncAt).toBe(Math.floor(Date.now() / 1000));
    expect(cachedMeta.mode).toBe("live");
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedEUR).toBeGreaterThan(0);
    expect(cachedMeta.sourceCadenceByPeg.peggedEUR).toBe("business-daily");
    expect(cachedMeta.sourceCadenceByPeg.peggedCNH).toBe("calendar-daily");
    expect(cachedMeta.sourceDateByPeg.peggedEUR).toBe("2025-06-15");
    expect(cachedMeta.sourceDateByPeg.peggedCNH).toBe("2025-06-15");
  });

  it("uses fresh commodity peer medians from the stablecoins cache when gold-api.com is unavailable", async () => {
    mockFetch(fxMirrors({
      gold: { body: { error: "blocked" }, status: 503 },
      silver: { body: { error: "blocked" }, status: 503 },
    }));

    const stablecoinsUpdatedAt = Math.floor(Date.now() / 1000) - 90;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "xaut-tether",
                name: "Tether Gold",
                symbol: "XAUT",
                pegType: "peggedGOLD",
                pegMechanism: "rwa-backed",
                price: 2910,
                priceSource: "defillama",
                circulating: { peggedGOLD: 100_000_000 },
                chainCirculating: {},
                chains: ["Ethereum"],
              },
              {
                id: "paxg-paxos",
                name: "Pax Gold",
                symbol: "PAXG",
                pegType: "peggedGOLD",
                pegMechanism: "rwa-backed",
                price: 2900,
                priceSource: "defillama",
                circulating: { peggedGOLD: 80_000_000 },
                chainCirculating: {},
                chains: ["Ethereum"],
              },
              {
                id: "kag-kinesis",
                name: "Kinesis Silver",
                symbol: "KAG",
                pegType: "peggedSILVER",
                pegMechanism: "rwa-backed",
                price: 31.5,
                priceSource: "defillama",
                circulating: { peggedSILVER: 2_000_000 },
                chainCirculating: {},
                chains: ["Ethereum"],
              },
            ],
          }),
          updated_at: stablecoinsUpdatedAt,
        },
      },
    ]);

    const result = await syncFxRates(db);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.mode).toBe("live");
    expect(metadata.sources["gold-api.com"]).toBe("error");
    expect(metadata.sources["commodity-peer-median"]).toBe("ok");

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedGOLD).toBeCloseTo(2905, 6);
    expect(cachedRates.peggedSILVER).toBeCloseTo(31.5, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      sourceUpdatedAtByPeg: Record<string, number>;
      sourceCadenceByPeg: Record<string, string>;
      sourceDateByPeg: Record<string, string | null>;
    };
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedGOLD).toBe(stablecoinsUpdatedAt);
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedSILVER).toBe(stablecoinsUpdatedAt);
    expect(cachedMeta.sourceCadenceByPeg.peggedGOLD).toBe("intraday");
    expect(cachedMeta.sourceCadenceByPeg.peggedSILVER).toBe("intraday");
    expect(cachedMeta.sourceDateByPeg.peggedGOLD).toBeNull();
    expect(cachedMeta.sourceDateByPeg.peggedSILVER).toBeNull();
  });

  it("rejects gold-api.com metal spots that diverge from the commodity peer median", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch(fxMirrors({ gold: { body: { price: 3100 } } }));

    const stablecoinsUpdatedAt = Math.floor(Date.now() / 1000) - 120;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "xaut-tether",
                name: "Tether Gold",
                symbol: "XAUT",
                pegType: "peggedGOLD",
                pegMechanism: "rwa-backed",
                price: 2910,
                priceSource: "defillama",
                circulating: { peggedGOLD: 100_000_000 },
                chainCirculating: {},
                chains: ["Ethereum"],
              },
              {
                id: "paxg-paxos",
                name: "Pax Gold",
                symbol: "PAXG",
                pegType: "peggedGOLD",
                pegMechanism: "rwa-backed",
                price: 2900,
                priceSource: "defillama",
                circulating: { peggedGOLD: 80_000_000 },
                chainCirculating: {},
                chains: ["Ethereum"],
              },
              {
                id: "kag-kinesis",
                name: "Kinesis Silver",
                symbol: "KAG",
                pegType: "peggedSILVER",
                pegMechanism: "rwa-backed",
                price: 31.5,
                priceSource: "defillama",
                circulating: { peggedSILVER: 2_000_000 },
                chainCirculating: {},
                chains: ["Ethereum"],
              },
            ],
          }),
          updated_at: stablecoinsUpdatedAt,
        },
      },
    ]);

    const result = await syncFxRates(db);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.mode).toBe("live");
    expect(metadata.sources["gold-api.com"]).toBe("partial");
    expect(metadata.sources["commodity-peer-median"]).toBe("partial");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Rejected gold-api.com peggedGOLD rate 3100"));

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedGOLD).toBeCloseTo(2905, 6);
    expect(cachedRates.peggedSILVER).toBeCloseTo(32, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      sourceUpdatedAtByPeg: Record<string, number>;
    };
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedGOLD).toBe(stablecoinsUpdatedAt);
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedSILVER).toBe(Math.floor(Date.now() / 1000));
  });

  it("falls back to cached rates when frankfurter.dev is unavailable", async () => {
    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      gold: "omit",
      silver: "omit",
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedEUR: 1.08, peggedRUB: 0.011 }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: Math.floor(Date.now() / 1000) - 60,
            mode: "live",
            sourceUpdatedAtByPeg: {
              peggedEUR: Math.floor(Date.now() / 1000) - 3600,
              peggedRUB: Math.floor(Date.now() / 1000) - 7200,
            },
            sourceModeByPeg: {
              peggedEUR: "live",
              peggedRUB: "live",
            },
            sourceCadenceByPeg: {
              peggedEUR: "business-daily",
              peggedRUB: "calendar-daily",
            },
            sourceDateByPeg: {
              peggedEUR: "2025-06-14",
              peggedRUB: "2025-06-15",
            },
            consecutiveFallbackRuns: 0,
          }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
    ]);

    const result = await syncFxRates(db);
    expect(result.itemCount).toBe(2);
    // First consecutive fallback run (1 < 4 threshold) — not yet degraded
    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.fallbackMode).toBe("cached-fx-rates");
    expect(metadata.mode).toBe("cached-fallback");
    expect(metadata.consecutiveFallbackRuns).toBe(1);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      usableSyncAt: number;
      mode: string;
      sourceUpdatedAtByPeg: Record<string, number>;
      sourceCadenceByPeg: Record<string, string>;
      sourceDateByPeg: Record<string, string | null>;
      consecutiveFallbackRuns: number;
    };
    expect(cachedMeta.usableSyncAt).toBe(Math.floor(Date.now() / 1000));
    expect(cachedMeta.mode).toBe("cached-fallback");
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedEUR).toBe(Math.floor(Date.now() / 1000) - 3600);
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedRUB).toBe(Math.floor(Date.now() / 1000) - 7200);
    expect(cachedMeta.sourceCadenceByPeg.peggedEUR).toBe("business-daily");
    expect(cachedMeta.sourceCadenceByPeg.peggedRUB).toBe("calendar-daily");
    expect(cachedMeta.sourceDateByPeg.peggedEUR).toBe("2025-06-14");
    expect(cachedMeta.sourceDateByPeg.peggedRUB).toBe("2025-06-15");
    expect(cachedMeta.consecutiveFallbackRuns).toBe(1);
  });

  it("uses the secondary FX mirror as a live full-set fallback when frankfurter.dev is unavailable", async () => {
    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      cdn: {
        body: {
          date: "2025-06-14",
          usd: {
            eur: 0.93, gbp: 0.8, chf: 0.88, brl: 5.01, jpy: 149.8, idr: 15810, sgd: 1.35, try: 36.1,
            aud: 1.56, zar: 18.4, cad: 1.38, cny: 7.26, php: 56.1, mxn: 17.3, cnh: 7.31, rub: 90.5, uah: 41.2, ars: 1401, kgs: 87.1, ngn: 1371, xof: 561,
            myr: 4.51, krw: 1382, hkd: 7.82, inr: 85.6, vnd: 25000, kes: 129.1, ghs: 11.7, cop: 3201, clp: 951, pen: 3.41,
          },
        },
      },
      pages: {
        body: {
          date: "2025-06-15",
          usd: {
            eur: 0.925, gbp: 0.79, chf: 0.88, brl: 5.0, jpy: 149.5, idr: 15800, sgd: 1.35, try: 36,
            aud: 1.55, zar: 18.3, cad: 1.37, cny: 7.25, php: 56, mxn: 17.2, cnh: 7.28, rub: 90, uah: 41, ars: 1400, kgs: 87, ngn: 1370, xof: 560,
            myr: 4.5, krw: 1380, hkd: 7.81, inr: 85.5, vnd: 25000, kes: 129, ghs: 11.6, cop: 3200, clp: 950, pen: 3.4,
          },
        },
      },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
    ]);

    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.mode).toBe("live");
    expect(metadata.fallbackMode).toBe("secondary-live-fallback");
    expect(metadata.sources.frankfurter).toBe("error");
    expect(metadata.sources.fawazahmed0).toBe("ok");

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedEUR).toBeCloseTo(1 / 0.925, 6);
    expect(cachedRates.peggedCNH).toBeCloseTo(1 / 7.28, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      mode: string;
      sourceCadenceByPeg: Record<string, string>;
      sourceDateByPeg: Record<string, string | null>;
    };
    expect(cachedMeta.mode).toBe("live");
    expect(cachedMeta.sourceCadenceByPeg.peggedEUR).toBe("calendar-daily");
    expect(cachedMeta.sourceDateByPeg.peggedEUR).toBe("2025-06-15");
  });

  it("uses ExchangeRate-API as a live full-set fallback when frankfurter and the secondary mirrors are unavailable", async () => {
    const exchangeRateUpdatedAt = Math.floor(Date.parse("2025-06-15T00:02:31Z") / 1000);

    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      datedCdn: { body: "definitely not json" },
      cdn: "unavailable",
      pages: "unavailable",
      exchangeRate: {
        body: {
          result: "success",
          time_last_update_unix: exchangeRateUpdatedAt,
          rates: {
            EUR: 0.925, GBP: 0.79, CHF: 0.88, BRL: 5.0, JPY: 149.5, IDR: 15800, SGD: 1.35, TRY: 36,
            AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, PHP: 56, MXN: 17.2, CNH: 7.28, RUB: 90, UAH: 41, ARS: 1400, KGS: 87, NGN: 1370, XOF: 560,
            MYR: 4.5, KRW: 1380, HKD: 7.81, INR: 85.5, VND: 25000, KES: 129, GHS: 11.6, COP: 3200, CLP: 950, PEN: 3.4,
          },
        },
      },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
    ]);

    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.mode).toBe("live");
    expect(metadata.fallbackMode).toBe("exchange-rate-api-live-fallback");
    expect(metadata.sources.frankfurter).toBe("error");
    expect(metadata.sources.exchangeRateApi).toBe("ok");

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedEUR).toBeCloseTo(1 / 0.925, 6);
    expect(cachedRates.peggedCNH).toBeCloseTo(1 / 7.28, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      mode: string;
      sourceCadenceByPeg: Record<string, string>;
      sourceDateByPeg: Record<string, string | null>;
    };
    expect(cachedMeta.mode).toBe("live");
    expect(cachedMeta.sourceCadenceByPeg.peggedEUR).toBe("calendar-daily");
    expect(cachedMeta.sourceDateByPeg.peggedEUR).toBe("2025-06-15");
  });

  it("treats cadence-valid carry-forward rates as a live run when live FX fetches fail", async () => {
    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      cdn: "unavailable",
      pages: "unavailable",
      exchangeRate: "unavailable",
    }));

    const fullPrevRates: Record<string, number> = {
      peggedEUR: 1 / 0.925,
      peggedGBP: 1 / 0.79,
      peggedCHF: 1 / 0.88,
      peggedREAL: 1 / 5.0,
      peggedJPY: 1 / 149.5,
      peggedIDR: 1 / 15800,
      peggedSGD: 1 / 1.35,
      peggedTRY: 1 / 36,
      peggedAUD: 1 / 1.55,
      peggedZAR: 1 / 18.3,
      peggedCAD: 1 / 1.37,
      peggedCNY: 1 / 7.25,
      peggedPHP: 1 / 56,
      peggedMXN: 1 / 17.2,
      peggedCNH: 1 / 7.28,
      peggedRUB: 1 / 90,
      peggedUAH: 1 / 41,
      peggedARS: 1 / 1400,
      peggedKGS: 1 / 87,
      peggedNGN: 1 / 1370,
      peggedXOF: 1 / 560,
      peggedMYR: 1 / 4.5,
      peggedKRW: 1 / 1380,
      peggedHKD: 1 / 7.81,
      peggedINR: 1 / 85.5,
      peggedVND: 1 / 25000,
      peggedKES: 1 / 129,
      peggedGHS: 1 / 11.6,
      peggedCOP: 1 / 3200,
      peggedCLP: 1 / 950,
      peggedPEN: 1 / 3.4,
    };
    const calendarDailyPegs = new Set(["peggedCNH", "peggedRUB", "peggedUAH", "peggedARS", "peggedKGS", "peggedNGN", "peggedXOF", "peggedVND", "peggedKES", "peggedGHS", "peggedCOP", "peggedCLP", "peggedPEN"]);
    const sourceUpdatedAtByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [
        pegKey,
        calendarDailyPegs.has(pegKey)
          ? Math.floor(Date.parse("2025-06-15T00:02:31Z") / 1000)
          : Math.floor(Date.parse("2025-06-13T16:00:00Z") / 1000),
      ]),
    );
    const sourceCadenceByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [
        pegKey,
        calendarDailyPegs.has(pegKey) ? "calendar-daily" : "business-daily",
      ]),
    );
    const sourceDateByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [
        pegKey,
        calendarDailyPegs.has(pegKey) ? "2025-06-15" : "2025-06-13",
      ]),
    );
    const sourceModeByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, "live"]),
    );

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify(fullPrevRates),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: Math.floor(Date.now() / 1000) - 60,
            mode: "live",
            sourceUpdatedAtByPeg,
            sourceModeByPeg,
            sourceCadenceByPeg,
            sourceDateByPeg,
            consecutiveFallbackRuns: 14,
          }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
    ]);

    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.mode).toBe("live");
    expect(metadata.fallbackMode).toBe("cadence-valid-carry-forward");
    expect(metadata.consecutiveFallbackRuns).toBe(0);
    expect(metadata.sources.cache).toBe("carry-forward");

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      mode: string;
      sourceDateByPeg: Record<string, string | null>;
      consecutiveFallbackRuns: number;
    };
    expect(cachedMeta.mode).toBe("live");
    expect(cachedMeta.sourceDateByPeg.peggedEUR).toBe("2025-06-13");
    expect(cachedMeta.sourceDateByPeg.peggedCNH).toBe("2025-06-15");
    expect(cachedMeta.consecutiveFallbackRuns).toBe(0);
  });

  it("uses secondary API for CNH/RUB/UAH/ARS/KGS/NGN/XOF/KES/GHS/COP/CLP/PEN rates", async () => {
    mockFetch(fxMirrors({
      secondary: {
        body: secondaryBody({ kes: 129, ghs: 11.6, cop: 3200, clp: 950, pen: 3.4 }, { date: null }),
      },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
    ]);

    const result = await syncFxRates(db);
    const metadata = JSON.parse(result.metadata ?? "{}");
    // Should include gold and silver prices
    expect(metadata.rateCount).toBeGreaterThanOrEqual(20);
    expect(metadata.secondaryCoverage).toBe(12);
  });

  it("prefers the fresher secondary FX mirror when the CDN payload lags a day behind", async () => {
    mockFetch(fxMirrors({
      secondary: "omit",
      cdn: {
        body: { date: "2025-06-14", usd: { cnh: 7.31, rub: 90.5, uah: 41.2, ars: 1401, kgs: 87.1, ngn: 1371, xof: 561 } },
      },
      pages: { body: secondaryBody() },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
    ]);

    await syncFxRates(db);

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedCNH).toBeCloseTo(1 / 7.28, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      sourceDateByPeg: Record<string, string | null>;
    };
    expect(cachedMeta.sourceDateByPeg.peggedCNH).toBe("2025-06-15");
  });

  it("overlays fresh Chainlink reference feeds when they agree with current references", async () => {
    const decimalsHex = "0x0000000000000000000000000000000000000000000000000000000000000008";
    const nowSec = Math.floor(Date.now() / 1000);
    const toHexWord = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
    const latestRoundDataHex =
      "0x" +
      toHexWord(1n) +
      toHexWord(108_101_000n) +
      toHexWord(0n) +
      toHexWord(BigInt(nowSec)) +
      toHexWord(1n);

    mockFetch([
      { match: "frankfurter.dev", body: frankfurterBody() },
      { match: "currency-api", body: secondaryBody() },
      { match: "gold-api.com/price/XAU", body: { price: 2900 } },
      { match: "gold-api.com/price/XAG", body: { price: 32 } },
      {
        match: "https://rpc.base.test",
        matchBody: '"to":"0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F","data":"0x313ce567"',
        body: { jsonrpc: "2.0", id: 1, result: decimalsHex },
      },
      {
        match: "https://rpc.base.test",
        matchBody: '"to":"0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F","data":"0xfeaf968c"',
        body: { jsonrpc: "2.0", id: 1, result: latestRoundDataHex },
      },
    ], { requireMatch: true });

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);
    const chainRpcs = new Map([
      ["base", {
        chainId: "base",
        chainName: "Base",
        type: "evm" as const,
        rpcUrl: "https://rpc.base.test",
        explorerUrl: "https://basescan.org",
      }],
    ]);

    const result = await syncFxRates(db, undefined, undefined, chainRpcs);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.sources.chainlink).toBe("ok");

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedEUR).toBeCloseTo(1.08101, 4);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      sourceCadenceByPeg: Record<string, string>;
      sourceDateByPeg: Record<string, string | null>;
    };
    expect(cachedMeta.sourceCadenceByPeg.peggedEUR).toBe("business-daily");
    expect(cachedMeta.sourceDateByPeg.peggedEUR).toBe("2025-06-15");
  });

  it("validates an older Chainlink silver quote without replacing a fresher resolved metal source", async () => {
    const decimalsHex = "0x0000000000000000000000000000000000000000000000000000000000000008";
    const nowSec = Math.floor(Date.now() / 1000);
    const olderUpdatedAt = nowSec - (11 * 3600);
    const toHexWord = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
    const latestRoundDataHex =
      "0x" +
      toHexWord(1n) +
      toHexWord(3_200_000_000n) +
      toHexWord(0n) +
      toHexWord(BigInt(olderUpdatedAt)) +
      toHexWord(1n);

    mockFetch([
      { match: "frankfurter.dev", body: frankfurterBody() },
      { match: "currency-api", body: secondaryBody() },
      { match: "gold-api.com/price/XAU", body: { price: 2900 } },
      { match: "gold-api.com/price/XAG", body: { price: 32 } },
      {
        match: "https://rpc.ethereum.test",
        matchBody: '"to":"0x379589227b15F1a12195D3f2d90bBc9F31f95235","data":"0x313ce567"',
        body: { jsonrpc: "2.0", id: 1, result: decimalsHex },
      },
      {
        match: "https://rpc.ethereum.test",
        matchBody: '"to":"0x379589227b15F1a12195D3f2d90bBc9F31f95235","data":"0xfeaf968c"',
        body: { jsonrpc: "2.0", id: 1, result: latestRoundDataHex },
      },
    ], { requireMatch: true });

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);
    const chainRpcs = new Map([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm" as const,
        rpcUrl: "https://rpc.ethereum.test",
        explorerUrl: "https://etherscan.io",
      }],
    ]);

    const result = await syncFxRates(db, undefined, undefined, chainRpcs);
    const metadata = JSON.parse(result.metadata ?? "{}") as { sources?: { chainlink?: string } };
    expect(metadata.sources?.chainlink).toBe("ok");

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedSILVER).toBeCloseTo(32, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      sourceUpdatedAtByPeg: Record<string, number>;
      sourceCadenceByPeg: Record<string, string>;
    };
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedSILVER).toBe(nowSec);
    expect(cachedMeta.sourceCadenceByPeg.peggedSILVER).toBe("intraday");

    expect(findCacheWrite(db, "cron:event:sync-fx-rates:chainlink-older-metal-quote-validated")).toBeDefined();
  });

  it("checks older Chainlink metal quotes for divergence before skipping them", async () => {
    const decimalsHex = "0x0000000000000000000000000000000000000000000000000000000000000008";
    const nowSec = Math.floor(Date.now() / 1000);
    const olderUpdatedAt = nowSec - (11 * 3600);
    const toHexWord = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
    const latestRoundDataHex =
      "0x" +
      toHexWord(1n) +
      toHexWord(4_200_000_000n) +
      toHexWord(0n) +
      toHexWord(BigInt(olderUpdatedAt)) +
      toHexWord(1n);

    mockFetch([
      { match: "frankfurter.dev", body: frankfurterBody() },
      { match: "currency-api", body: secondaryBody() },
      { match: "gold-api.com/price/XAU", body: { price: 2900 } },
      { match: "gold-api.com/price/XAG", body: { price: 32 } },
      {
        match: "https://rpc.ethereum.test",
        matchBody: '"to":"0x379589227b15F1a12195D3f2d90bBc9F31f95235","data":"0x313ce567"',
        body: { jsonrpc: "2.0", id: 1, result: decimalsHex },
      },
      {
        match: "https://rpc.ethereum.test",
        matchBody: '"to":"0x379589227b15F1a12195D3f2d90bBc9F31f95235","data":"0xfeaf968c"',
        body: { jsonrpc: "2.0", id: 1, result: latestRoundDataHex },
      },
    ], { requireMatch: true });

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);
    const chainRpcs = new Map([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm" as const,
        rpcUrl: "https://rpc.ethereum.test",
        explorerUrl: "https://etherscan.io",
      }],
    ]);

    const result = await syncFxRates(db, undefined, undefined, chainRpcs);
    const metadata = JSON.parse(result.metadata ?? "{}") as { sources?: { chainlink?: string } };
    expect(metadata.sources?.chainlink).toBe("partial");

    const write = findCacheWrite(db, "fx-rates");
    const cachedRates = JSON.parse(String(write?.binds[1] ?? "{}")) as Record<string, number>;
    expect(cachedRates.peggedSILVER).toBeCloseTo(32, 6);

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      sourceUpdatedAtByPeg: Record<string, number>;
    };
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedSILVER).toBe(nowSec);
    expect(findCacheWrite(db, "cron:event:sync-fx-rates:chainlink-rate-diverged")).toBeDefined();
  });

  it("reconstructs daily fiat provenance from same-day live timestamps during carry-forward", async () => {
    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      cdn: "unavailable",
      pages: "unavailable",
      exchangeRate: "unavailable",
    }));

    const fullPrevRates: Record<string, number> = {
      peggedEUR: 1 / 0.925,
      peggedGBP: 1 / 0.79,
      peggedCHF: 1 / 0.88,
      peggedREAL: 1 / 5.0,
      peggedJPY: 1 / 149.5,
      peggedIDR: 1 / 15800,
      peggedSGD: 1 / 1.35,
      peggedTRY: 1 / 36,
      peggedAUD: 1 / 1.55,
      peggedZAR: 1 / 18.3,
      peggedCAD: 1 / 1.37,
      peggedCNY: 1 / 7.25,
      peggedPHP: 1 / 56,
      peggedMXN: 1 / 17.2,
      peggedCNH: 1 / 7.28,
      peggedRUB: 1 / 90,
      peggedUAH: 1 / 41,
      peggedARS: 1 / 1400,
      peggedKGS: 1 / 87,
      peggedNGN: 1 / 1370,
      peggedXOF: 1 / 560,
      peggedMYR: 1 / 4.5,
      peggedKRW: 1 / 1380,
      peggedHKD: 1 / 7.81,
      peggedINR: 1 / 85.5,
      peggedVND: 1 / 25000,
      peggedKES: 1 / 129,
      peggedGHS: 1 / 11.6,
      peggedCOP: 1 / 3200,
      peggedCLP: 1 / 950,
      peggedPEN: 1 / 3.4,
    };
    const sameDayUpdatedAt = Math.floor(Date.parse("2025-06-15T05:02:23Z") / 1000);
    const sourceUpdatedAtByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, sameDayUpdatedAt]),
    );
    const sourceModeByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, "live"]),
    );
    const sourceCadenceByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, "intraday"]),
    );
    const sourceDateByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, null]),
    );

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify(fullPrevRates),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: Math.floor(Date.now() / 1000) - 60,
            mode: "cached-fallback",
            sourceUpdatedAtByPeg,
            sourceModeByPeg,
            sourceCadenceByPeg,
            sourceDateByPeg,
            consecutiveFallbackRuns: 12,
          }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      { match: "circuit", rows: [] },
    ]);

    const result = await syncFxRates(db);
    expect(result.status).toBeUndefined();
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.mode).toBe("live");
    expect(metadata.fallbackMode).toBe("cadence-valid-carry-forward");
    expect(metadata.consecutiveFallbackRuns).toBe(0);
    expect(metadata.sources.cache).toBe("carry-forward");

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      mode: string;
      sourceCadenceByPeg: Record<string, string>;
      sourceDateByPeg: Record<string, string | null>;
      consecutiveFallbackRuns: number;
    };
    expect(cachedMeta.mode).toBe("live");
    expect(cachedMeta.sourceCadenceByPeg.peggedEUR).toBe("business-daily");
    expect(cachedMeta.sourceCadenceByPeg.peggedCNH).toBe("calendar-daily");
    expect(cachedMeta.sourceDateByPeg.peggedEUR).toBe("2025-06-15");
    expect(cachedMeta.sourceDateByPeg.peggedCNH).toBe("2025-06-15");
    expect(cachedMeta.consecutiveFallbackRuns).toBe(0);
  });

  it("promotes cached fallback back to live when OXR restores fresh full-set FX coverage", async () => {
    const fullPrevRates: Record<string, number> = {
      peggedEUR: 1 / 0.925,
      peggedGBP: 1 / 0.79,
      peggedCHF: 1 / 0.88,
      peggedREAL: 1 / 5.0,
      peggedJPY: 1 / 149.5,
      peggedIDR: 1 / 15800,
      peggedSGD: 1 / 1.35,
      peggedTRY: 1 / 36,
      peggedAUD: 1 / 1.55,
      peggedZAR: 1 / 18.3,
      peggedCAD: 1 / 1.37,
      peggedCNY: 1 / 7.25,
      peggedPHP: 1 / 56,
      peggedMXN: 1 / 17.2,
      peggedCNH: 1 / 7.28,
      peggedRUB: 1 / 90,
      peggedUAH: 1 / 41,
      peggedARS: 1 / 1400,
      peggedKGS: 1 / 87,
      peggedNGN: 1 / 1370,
      peggedXOF: 1 / 560,
      peggedMYR: 1 / 4.5,
      peggedKRW: 1 / 1380,
      peggedHKD: 1 / 7.81,
      peggedINR: 1 / 85.5,
      peggedVND: 1 / 25000,
      peggedKES: 1 / 129,
      peggedGHS: 1 / 11.6,
      peggedCOP: 1 / 3200,
      peggedCLP: 1 / 950,
      peggedPEN: 1 / 3.4,
    };
    const staleUpdatedAt = Math.floor(Date.parse("2025-06-12T12:00:00Z") / 1000);
    const sourceUpdatedAtByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, staleUpdatedAt]),
    );
    const sourceModeByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, "live"]),
    );
    const sourceCadenceByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, "intraday"]),
    );
    const sourceDateByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, null]),
    );

    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      cdn: "unavailable",
      pages: "unavailable",
      exchangeRate: "unavailable",
      openExchange: {
        body: {
          rates: {
            EUR: 0.925, GBP: 0.79, CHF: 0.88, BRL: 5.0, JPY: 149.5, IDR: 15800, SGD: 1.35, TRY: 36,
            AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, CNH: 7.28, PHP: 56, MXN: 17.2, RUB: 90, UAH: 41, ARS: 1400, KGS: 87, NGN: 1370, XOF: 560,
            MYR: 4.5, KRW: 1380, HKD: 7.81, INR: 85.5, VND: 25000, KES: 129, GHS: 11.6, COP: 3200, CLP: 950, PEN: 3.4,
          },
        },
      },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify(fullPrevRates),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: Math.floor(Date.now() / 1000) - 60,
            mode: "cached-fallback",
            sourceUpdatedAtByPeg,
            sourceModeByPeg,
            sourceCadenceByPeg,
            sourceDateByPeg,
            consecutiveFallbackRuns: 6,
          }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-attempt"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [], first: null },
    ]);

    const result = await syncFxRates(db, undefined, "oxr-key");
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.status).toBeUndefined();
    expect(metadata.mode).toBe("live");
    expect(metadata.fallbackMode).toBe("independent-live-recovery");
    expect(metadata.consecutiveFallbackRuns).toBe(0);
    expect(metadata.sources.openExchangeRates).toBe("ok");
    expect(metadata.sources.cache).toBe("recovered");
    expect(findCacheWrite(db, "fx-oxr-last-attempt")).toBeDefined();
    expect(findCacheWrite(db, "fx-oxr-last-success")).toBeDefined();

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      mode: string;
      sourceUpdatedAtByPeg: Record<string, number>;
      consecutiveFallbackRuns: number;
    };
    expect(cachedMeta.mode).toBe("live");
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedJPY).toBe(Math.floor(Date.now() / 1000));
    expect(cachedMeta.consecutiveFallbackRuns).toBe(0);
  });

  it("preserves refreshed per-peg source metadata during cached fallback when recovery is only partial", async () => {
    const fullPrevRates: Record<string, number> = {
      peggedEUR: 1 / 0.925,
      peggedGBP: 1 / 0.79,
      peggedCHF: 1 / 0.88,
      peggedREAL: 1 / 5.0,
      peggedJPY: 1 / 149.5,
      peggedIDR: 1 / 15800,
      peggedSGD: 1 / 1.35,
      peggedTRY: 1 / 36,
      peggedAUD: 1 / 1.55,
      peggedZAR: 1 / 18.3,
      peggedCAD: 1 / 1.37,
      peggedCNY: 1 / 7.25,
      peggedPHP: 1 / 56,
      peggedMXN: 1 / 17.2,
      peggedCNH: 1 / 7.28,
      peggedRUB: 1 / 90,
      peggedUAH: 1 / 41,
      peggedARS: 1 / 1400,
      peggedKGS: 1 / 87,
      peggedNGN: 1 / 1370,
      peggedXOF: 1 / 560,
      peggedMYR: 1 / 4.5,
      peggedKRW: 1 / 1380,
    };
    const staleUpdatedAt = Math.floor(Date.parse("2025-06-12T12:00:00Z") / 1000);
    const sourceUpdatedAtByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, staleUpdatedAt]),
    );
    const sourceModeByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, "live"]),
    );
    const sourceCadenceByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, "intraday"]),
    );
    const sourceDateByPeg = Object.fromEntries(
      Object.keys(fullPrevRates).map((pegKey) => [pegKey, null]),
    );

    mockFetch(fxMirrors({
      frankfurter: "unavailable",
      secondary: "omit",
      cdn: "unavailable",
      pages: "unavailable",
      exchangeRate: "unavailable",
      openExchange: { body: { rates: { EUR: 0.925 } } },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify(fullPrevRates),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: {
          value: JSON.stringify({
            usableSyncAt: Math.floor(Date.now() / 1000) - 60,
            mode: "cached-fallback",
            sourceUpdatedAtByPeg,
            sourceModeByPeg,
            sourceCadenceByPeg,
            sourceDateByPeg,
            consecutiveFallbackRuns: 2,
          }),
          updated_at: Math.floor(Date.now() / 1000) - 60,
        },
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-attempt"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [], first: null },
    ]);

    const result = await syncFxRates(db, undefined, "oxr-key");
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.mode).toBe("cached-fallback");
    expect(metadata.fallbackMode).toBe("cached-fx-rates");
    expect(metadata.consecutiveFallbackRuns).toBe(3);
    expect(metadata.sources.openExchangeRates).toBe("ok");

    const metaWrite = findCacheWrite(db, "fx-rates-meta");
    const cachedMeta = JSON.parse(String(metaWrite?.binds[1] ?? "{}")) as {
      mode: string;
      sourceUpdatedAtByPeg: Record<string, number>;
      consecutiveFallbackRuns: number;
    };
    expect(cachedMeta.mode).toBe("cached-fallback");
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedEUR).toBe(Math.floor(Date.now() / 1000));
    expect(cachedMeta.sourceUpdatedAtByPeg.peggedGBP).toBe(staleUpdatedAt);
    expect(cachedMeta.consecutiveFallbackRuns).toBe(3);
  });

  it("keeps syncing when the OXR telemetry write fails", async () => {
    mockFetch(fxMirrors({ secondary: { body: secondaryBody({}, { date: null }) } }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-attempt"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-fetch"],
        rows: [],
        first: null,
      },
      {
        match: "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        matchBinds: ["fx-oxr-last-attempt", String(Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000)],
        rows: [],
        throwError: new Error("telemetry write failed"),
      },
      { match: "circuit", rows: [] },
    ]);

    const result = await syncFxRates(db, undefined, "oxr-key");
    expect(result.itemCount).toBeGreaterThan(0);
    expect(findCacheWrite(db, "fx-rates")).toBeDefined();
    expect(findCacheWrite(db, "fx-rates-meta")).toBeDefined();
  });

  it("records the OXR cooldown after a completed response with zero usable rates", async () => {
    mockFetch(fxMirrors({
      secondary: { body: secondaryBody({}, { date: null }) },
      openExchange: { body: { rates: { EUR: 0.01, GBP: 0.01 } } },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-attempt"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);

    const result = await syncFxRates(db, undefined, "oxr-key");
    expect(result.itemCount).toBeGreaterThan(0);
    expect(findCacheWrite(db, "fx-oxr-last-attempt")).toBeDefined();
    expect(findCacheWrite(db, "fx-oxr-last-success")).toBeUndefined();

    const metadata = JSON.parse(result.metadata ?? "{}") as { sources?: { openExchangeRates?: string } };
    expect(metadata.sources?.openExchangeRates).toBe("unavailable");
  });

  it("skips the OXR fetch when the fx-realtime circuit breaker is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFetch(fxMirrors({
      secondary: { body: secondaryBody({}, { date: null }) },
      openExchange: { body: { error: "should not be called" }, status: 500 },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.FX_REALTIME}`],
        rows: [],
        first: {
          value: JSON.stringify({
            state: "open",
            consecutiveFailures: 3,
            lastFailureAt: nowSec - 60,
            lastSuccessAt: null,
            openedAt: nowSec - 60,
          }),
          updated_at: nowSec - 60,
        },
      },
      { match: "circuit", rows: [] },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await syncFxRates(db, undefined, "oxr-key");
    expect(result.itemCount).toBeGreaterThan(0);

    const oxrCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("openexchangerates.org"),
    );
    expect(oxrCalls).toHaveLength(0);

    expect(findCacheWrite(db, "fx-oxr-last-attempt")).toBeUndefined();
    expect(findCacheWrite(db, "fx-oxr-last-success")).toBeUndefined();

    const metadata = JSON.parse(result.metadata ?? "{}") as { sources?: { openExchangeRates?: string } };
    expect(metadata.sources?.openExchangeRates).toBe("unavailable");
  });

  it("records a breaker failure when OXR returns 200 with zero usable rates", async () => {
    mockFetch(fxMirrors({
      secondary: { body: secondaryBody({}, { date: null }) },
      openExchange: { body: { rates: { EUR: 0.01, GBP: 0.01 } } },
    }));

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates-meta"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-attempt"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value FROM cache WHERE key = ?",
        matchBinds: ["fx-oxr-last-fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);

    await syncFxRates(db, undefined, "oxr-key");

    const realtimeCircuitWrite = db
      .getHistory()
      .find((entry) =>
        entry.sql.includes("INSERT OR REPLACE INTO cache") &&
        entry.binds[0] === `circuit:${CIRCUIT_SOURCE.FX_REALTIME}`,
      );
    expect(realtimeCircuitWrite).toBeDefined();
    const recordedRecord = JSON.parse(String(realtimeCircuitWrite?.binds[1] ?? "{}")) as {
      state: string;
      consecutiveFailures: number;
      lastFailureAt: number | null;
    };
    expect(recordedRecord.consecutiveFailures).toBe(1);
    expect(recordedRecord.lastFailureAt).toBeGreaterThan(0);
  });

  it("skips a duplicate delivery for an already completed cadence bucket", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / (30 * 60));
    const fetchMock = mockFetch([], { requireMatch: true });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["sync-fx-rates:cadence"],
        rows: [{
          key: "sync-fx-rates:cadence",
          value: JSON.stringify({
            version: 1,
            bucket,
            state: "completed",
            generation: "completed-test",
            claimedAt: nowSec - 60,
            completedAt: nowSec - 30,
          }),
          updated_at: nowSec - 30,
        }],
      },
    ]);

    const result = await syncFxRates(db, undefined, undefined, undefined, undefined, undefined, {
      scheduledAtSec: nowSec,
    });

    expect(result.itemCount).toBe(0);
    expect(result.metadata).toBeDefined();
    const metadata = JSON.parse(result.metadata!) as { reason: string };
    expect(metadata.reason).toBe("cadence_bucket_completed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
