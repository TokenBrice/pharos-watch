import { mockD1, type MockD1Database, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import type { MockRoute } from "../../test-helpers/__shared/mock-fetch";

export type MockUrlResponse = Response | null | ((url: string, opts?: RequestInit) => Response | null);
export type BenchmarkFetchRoutes = Record<string, MockUrlResponse>;

export type FxRouteSpec = { body: unknown; status?: number } | "unavailable" | "omit";
export type FxRoutes = Array<{ match: string; body: unknown; status?: number }>;

const FX_UNAVAILABLE = { body: { error: "Service unavailable" }, status: 503 } as const;
const FX_FRANKFURTER_RATES = {
  EUR: 0.925, GBP: 0.79, CHF: 0.88, JPY: 149.5, BRL: 5.0, IDR: 15800, SGD: 1.35, TRY: 36,
  AUD: 1.55, ZAR: 18.3, CAD: 1.37, CNY: 7.25, PHP: 56, MXN: 17.2,
};
const FX_SECONDARY_USD = { cnh: 7.28, rub: 90, uah: 41, ars: 1400, kgs: 87, ngn: 1370, xof: 560 };

export function frankfurterBody(extraRates: Record<string, number> = {}) {
  return { base: "USD", date: "2025-06-15", rates: { ...FX_FRANKFURTER_RATES, ...extraRates } };
}

export function secondaryBody(
  extraUsd: Record<string, number> = {},
  options: { date?: string | null } = {},
) {
  const { date = "2025-06-15" } = options;
  return { ...(date == null ? {} : { date }), usd: { ...FX_SECONDARY_USD, ...extraUsd } };
}

const COMPLETE_FX_RATES: Record<string, number> = {
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

export function makeCompleteFxRates(
  overrides: Record<string, number> = {},
  omit: readonly string[] = [],
): Record<string, number> {
  const omitted = new Set(omit);
  return Object.fromEntries(
    Object.entries({ ...COMPLETE_FX_RATES, ...overrides }).filter(([key]) => !omitted.has(key)),
  );
}

export function makeUniformFxRatesProvenance(
  rates: Record<string, number>,
  {
    updatedAt,
    mode = "live",
    cadence = "intraday",
    date = null,
  }: { updatedAt: number; mode?: string; cadence?: string; date?: string | null },
): {
  sourceUpdatedAtByPeg: Record<string, number>;
  sourceModeByPeg: Record<string, string>;
  sourceCadenceByPeg: Record<string, string>;
  sourceDateByPeg: Record<string, string | null>;
} {
  const keys = Object.keys(rates);
  return {
    sourceUpdatedAtByPeg: Object.fromEntries(keys.map((key) => [key, updatedAt])),
    sourceModeByPeg: Object.fromEntries(keys.map((key) => [key, mode])),
    sourceCadenceByPeg: Object.fromEntries(keys.map((key) => [key, cadence])),
    sourceDateByPeg: Object.fromEntries(keys.map((key) => [key, date])),
  };
}

export function makeFxRatesMeta(
  rates: Record<string, number>,
  overrides: {
    usableSyncAt: number;
    mode?: string;
    updatedAt: number;
    cadence?: string;
    date?: string | null;
    consecutiveFallbackRuns?: number;
  },
) {
  return {
    usableSyncAt: overrides.usableSyncAt,
    mode: overrides.mode ?? "live",
    ...makeUniformFxRatesProvenance(rates, {
      updatedAt: overrides.updatedAt,
      mode: "live",
      cadence: overrides.cadence,
      date: overrides.date,
    }),
    consecutiveFallbackRuns: overrides.consecutiveFallbackRuns ?? 0,
  };
}

export function makeChainlinkFxRoutes({
  rpcUrl,
  feedAddress,
  decimalsHex,
  latestRoundDataHex,
}: {
  rpcUrl: string;
  feedAddress: string;
  decimalsHex: string;
  latestRoundDataHex: string;
}): MockRoute[] {
  const callRoute = (data: string, result: string): MockRoute => ({
    match: rpcUrl,
    matchBody: `"to":"${feedAddress}","data":"${data}"`,
    body: { jsonrpc: "2.0", id: 1, result },
  });
  return [
    { match: "frankfurter.dev", body: frankfurterBody() },
    { match: "currency-api", body: secondaryBody() },
    { match: "gold-api.com/price/XAU", body: { price: 2900 } },
    { match: "gold-api.com/price/XAG", body: { price: 32 } },
    callRoute("0x313ce567", decimalsHex),
    callRoute("0xfeaf968c", latestRoundDataHex),
  ];
}

export function makeFxRatesFetchRoutes(axes: {
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
    routes.push({ match, ...(spec === "unavailable" ? FX_UNAVAILABLE : spec) });
  }
  return routes;
}

const HEALTHY_BENCHMARK_ROUTES: BenchmarkFetchRoutes = {
  "markets.newyorkfed.org": new Response(
    JSON.stringify({ refRates: [{ effectiveDate: "2026-03-02", type: "EFFR", percentRate: 4.33 }] }),
    { status: 200 },
  ),
  "id=DFF": new Response("DATE,DFF\n2026-03-02,4.33\n", { status: 200 }),
  "fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2": new Response(
    "observation_date,IUDZOS2\n2026-01-01,100\n2026-04-01,101\n",
    { status: 200 },
  ),
  "bankofengland.co.uk": new Response("DATE,IUDZOS2\n01 Jan 2026,100\n01 Apr 2026,101\n", { status: 200 }),
  "stat-search.boj.or.jp": new Response(JSON.stringify({
    RESULTSET: [{ SERIES_CODE: "STRDCLUCON", VALUES: { SURVEY_DATES: [20260302], VALUES: [0.1] } }],
  }), { status: 200 }),
  "rba.gov.au/statistics/tables/csv/f1-data.csv": new Response(
    "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate\n"
      + "02-Mar-2026,4.30,,4.31\n",
    { status: 200 },
  ),
  "banxico.org.mx": new Response(
    JSON.stringify({ bmx: { series: [{ datos: [{ fecha: "26/03/2026", dato: "10.45" }] }] } }),
    { status: 200 },
  ),
  "api.bcb.gov.br": new Response(JSON.stringify([{ data: "26/03/2026", valor: "0.050747" }]), { status: 200 }),
  "bankofcanada.ca/valet": new Response(
    JSON.stringify({ observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }] }),
    { status: 200 },
  ),
  "DailyInfoWebServ": new Response(
    `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <KeyRateXMLResponse xmlns="http://web.cbr.ru/">
      <KeyRateXMLResult>
        <KR><DT>2026-06-09T00:00:00+03:00</DT><Rate>18.00</Rate></KR>
        <KR><DT>2026-06-11T00:00:00+03:00</DT><Rate>14.50</Rate></KR>
      </KeyRateXMLResult>
    </KeyRateXMLResponse>
  </soap:Body>
</soap:Envelope>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  ),
  "evds3.tcmb.gov.tr/igmevdsms-dis/fe": new Response(JSON.stringify({
    totalCount: 2,
    items: [
      { Tarih: "06-05-2026", TP_BISTTLREF_ORAN: "39.99" },
      { Tarih: "06-08-2026", TP_BISTTLREF_ORAN: "40.00" },
    ],
  }), { status: 200 }),
};

export function makeBenchmarkFetchRoutes(overrides: BenchmarkFetchRoutes = {}): BenchmarkFetchRoutes {
  return { ...HEALTHY_BENCHMARK_ROUTES, ...overrides };
}

/**
 * Healthy baseline for fetch-tbill-rate scenarios. Individual tests only need
 * to declare the provider failure or payload variation they are exercising.
 */
export function makeTbillFetchRoutes(overrides: BenchmarkFetchRoutes = {}): BenchmarkFetchRoutes {
  return makeBenchmarkFetchRoutes({
    "data-api.ecb.europa.eu": new Response(
      "KEY,FREQ,BENCHMARK_ITEM,DATA_TYPE_EST,TIME_PERIOD,OBS_VALUE\n"
        + "EST.B.EU000A2QQF32.CR,B,EU000A2QQF32,CR,2026-03-26,1.9358\n",
      { status: 200 },
    ),
    "id=DGS3MO": new Response("DATE,DGS3MO\n2026-03-02,3.72\n", { status: 200 }),
    "oauth/token": new Response(JSON.stringify({ access_token: "guest-token" }), { status: 200 }),
    "report-download": new Response(
      "date;end_date;start_date;symbol;value;day_count;dcc\n25.03.2026;26.03.2026;24.12.2025;SAR3MC;-0.0539;92;360\n",
      { status: 200, headers: { "Content-Type": "text/csv" } },
    ),
    ...overrides,
  });
}

/** Baseline for scenarios that exercise the newer native benchmark feeds. */
export function makeNewCurrencyFetchRoutes(overrides: BenchmarkFetchRoutes = {}): BenchmarkFetchRoutes {
  return makeTbillFetchRoutes({
    "id=DFF": new Response("DATE,DFF\n2026-03-02,4.33\n", { status: 200 }),
    "DailyInfoWebServ": new Response(
      "<KeyRate><KR><DT>2026-06-11T00:00:00+03:00</DT><Rate>14.50</Rate></KR></KeyRate>",
      { status: 200 },
    ),
    "evds3.tcmb.gov.tr/igmevdsms-dis/fe": new Response(JSON.stringify({
      totalCount: 2,
      items: [
        { Tarih: "06-05-2026", TP_BISTTLREF_ORAN: "39.99" },
        { Tarih: "06-08-2026", TP_BISTTLREF_ORAN: "40.00" },
      ],
    }), { status: 200 }),
    "stat-search.boj.or.jp": new Response(JSON.stringify({
      RESULTSET: [{ SERIES_CODE: "STRDCLUCON", VALUES: { SURVEY_DATES: [20260302], VALUES: [0.1] } }],
    }), { status: 200 }),
    "rba.gov.au/statistics/tables/csv/f1-data.csv": new Response(
      "Title,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate\n"
        + "02-Mar-2026,4.30,,4.31\n",
      { status: 200 },
    ),
    "api.bcb.gov.br": new Response(JSON.stringify([{ data: "26/03/2026", valor: "0.050747" }]), { status: 200 }),
    "bankofcanada.ca/valet": new Response(
      JSON.stringify({ observations: [{ d: "2026-03-26", V122530: { v: "4.75" } }] }),
      { status: 200 },
    ),
    ...overrides,
  });
}

export function makeUnavailableTbillFetchRoutes(overrides: BenchmarkFetchRoutes = {}): BenchmarkFetchRoutes {
  return {
    "data-api.ecb.europa.eu": null,
    "markets.newyorkfed.org": null,
    "id=DGS3MO": null,
    "id=DFF": null,
    "fred.stlouisfed.org": null,
    "alfred.stlouisfed.org": null,
    "bankofengland.co.uk": null,
    "home.treasury.gov": null,
    "oauth/token": null,
    "report-download": null,
    "stat-search.boj.or.jp": null,
    "rba.gov.au/statistics/tables/csv/f1-data.csv": null,
    "banxico.org.mx": null,
    "api.bcb.gov.br": null,
    "bankofcanada.ca/valet": null,
    "DailyInfoWebServ": null,
    "evds3.tcmb.gov.tr/igmevdsms-dis/fe": null,
    ...overrides,
  };
}

export function installBenchmarkFetch(
  mock: {
    mockImplementation(
      implementation: (url: string, opts?: RequestInit) => Promise<Response | null>,
    ): unknown;
  },
  routes: BenchmarkFetchRoutes,
  calls?: string[],
): void {
  mock.mockImplementation(async (url, opts) => {
    calls?.push(url);
    for (const [pattern, response] of Object.entries(routes)) {
      if (!url.includes(pattern)) continue;
      const resolved = typeof response === "function" ? response(url, opts) : response;
      return resolved?.clone() ?? null;
    }
    return null;
  });
}

export type CacheRow = { value: string; updatedAt: number };
export type CacheFixture = CacheRow | null | (() => CacheFixture | Promise<CacheFixture>);

export function makeCacheRow(value: unknown, updatedAt: number): CacheRow {
  return {
    value: typeof value === "string" ? value : JSON.stringify(value),
    updatedAt,
  };
}

export function makeRiskFreeRatesCacheRow(
  benchmarkOverrides: Record<string, unknown>,
  updatedAt: number,
): CacheRow {
  return makeCacheRow({ version: 1, benchmarks: benchmarkOverrides }, updatedAt);
}

export type BenchmarkCacheEntryOptions = {
  key: string;
  rate: number;
  recordDate?: string | null;
  fetchedAt?: number;
  source?: string;
  label?: string;
  currency?: string;
  isFallback?: boolean;
  fallbackMode?: string | null;
  isProxy?: boolean;
  lastMarketRate?: number | null;
  lastMarketRecordDate?: string | null;
  lastMarketFetchedAt?: number | null;
  lastMarketSource?: string | null;
};

export function makeBenchmarkCacheEntry({
  key,
  rate,
  recordDate = null,
  fetchedAt = 1774479600,
  source = `${key.toLowerCase()}-test`,
  label = `${key} benchmark`,
  currency = key,
  isFallback = false,
  fallbackMode = null,
  isProxy = false,
  lastMarketRate = rate,
  lastMarketRecordDate = recordDate,
  lastMarketFetchedAt = fetchedAt,
  lastMarketSource = source,
}: BenchmarkCacheEntryOptions): Record<string, unknown> {
  return {
    key,
    label,
    currency,
    rate,
    recordDate,
    fetchedAt,
    source,
    isFallback,
    fallbackMode,
    isProxy,
    lastMarketRate,
    lastMarketRecordDate,
    lastMarketFetchedAt,
    lastMarketSource,
  };
}

export function makeCommodityStablecoinsCacheRow(updatedAt: number): CacheRow {
  return makeCacheRow({
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
  }, updatedAt);
}

async function resolveCacheFixture(fixture: CacheFixture): Promise<CacheRow | null> {
  if (fixture === null) return null;
  if (typeof fixture === "function") return resolveCacheFixture(await fixture());
  return fixture;
}

export function installCacheByKey(
  mock: {
    mockImplementation(
      implementation: (db: D1Database, key: string, signal?: AbortSignal) => Promise<CacheRow | null>,
    ): unknown;
  },
  rows: Readonly<Record<string, CacheFixture>>,
  options: { fallback?: CacheFixture; requireMatch?: boolean } = {},
): void {
  mock.mockImplementation(async (_db, key, _signal) => {
    const row = rows[key];
    if (row === undefined) {
      const fallback = options.fallback;
      if (fallback !== undefined) return resolveCacheFixture(fallback);
      if (options.requireMatch) throw new Error(`rates-cron.test-support: unexpected cache key ${key}`);
      return null;
    }
    return resolveCacheFixture(row);
  });
}

export type FxRatesDbOptions = {
  previousRates?: CacheRow | null;
  previousMeta?: CacheRow | null;
  stablecoins?: CacheRow | null;
  cadence?: CacheRow | null;
  cacheRows?: Readonly<Record<string, CacheRow | null>>;
  extraTables?: MockTableConfig[];
};

function cacheReadTable(key: string, row: CacheRow | null): MockTableConfig {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [key],
    rows: [],
    first: row ? { key, value: row.value, updated_at: row.updatedAt } : null,
  };
}

export function makeFxRatesDb({
  previousRates = null,
  previousMeta = null,
  stablecoins = null,
  cadence = null,
  cacheRows = {},
  extraTables = [],
}: FxRatesDbOptions = {}): MockD1Database {
  const cacheTables = [
    cacheReadTable("fx-rates", previousRates),
    cacheReadTable("fx-rates-meta", previousMeta),
    ...(stablecoins ? [cacheReadTable("stablecoins", stablecoins)] : []),
    ...(cadence ? [cacheReadTable("sync-fx-rates:cadence", cadence)] : []),
    ...Object.entries(cacheRows).map(([key, row]) => cacheReadTable(key, row)),
  ];
  const hasCircuitTable = extraTables.some((table) => table.match.includes("circuit"));
  return mockD1([
    ...(hasCircuitTable ? [] : [{ match: "circuit", rows: [] }]),
    ...extraTables,
    ...cacheTables,
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT value FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT OR IGNORE INTO cache", rows: [] },
    { match: "INSERT INTO cache", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "UPDATE cache", rows: [] },
  ]);
}

export function findCacheWrite(
  db: Pick<MockD1Database, "getHistory">,
  key: string,
): { sql: string; binds: unknown[] } | undefined {
  return db.getHistory().find((entry) => entry.sql.includes("INTO cache") && entry.binds[0] === key);
}
