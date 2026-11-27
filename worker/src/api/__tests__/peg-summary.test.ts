import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect, vi } from "vitest";
import { PEG_CURRENCY_VALUES, type PegCurrency } from "@shared/types/core";
import { PegSummaryResponseSchema, type PegSummaryCoin, type PegSummaryResponse } from "@shared/types/peg";
import { type StablecoinData } from "@shared/types/supply";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { selectActiveDepegCoins } from "@shared/lib/active-depegs";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { __pegSummaryTestHooks, handlePegSummary } from "../peg-summary";
import { deriveDepegSignal, signalCrossesThreshold } from "@shared/lib/depeg-signals";
import * as currentPegObservations from "../../lib/current-peg-observations";
import * as depegTrustPolicy from "../../lib/depeg-trust-policy";
import { derivePegAnalyticsSnapshot } from "../../lib/peg-analytics";
import { publishPegAnalyticsCache } from "../../lib/peg-analytics-cache";
import { MAX_OPEN_DEPEG_EVENTS } from "../../lib/depeg-threshold-policy";
import { DEX_PRICE_CHECK_FRESHNESS_SEC } from "../../lib/dex-cron-constants";

const nowSec = Math.floor(Date.now() / 1000);
const OPEN_FX_QUOTE_AT = 1_795_017_600;
const TODAY_START_SEC = Math.floor(nowSec / 86_400) * 86_400;
const sameDayCachedAt = (offsetSec: number) => Math.max(TODAY_START_SEC, nowSec - offsetSec);

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const cacheTable = (key: string, payload: unknown, updatedAt = nowSec, bind = true) => {
  const row = { key, value: typeof payload === "string" ? payload : JSON.stringify(payload), updated_at: updatedAt };
  return { match: "cache", ...(bind ? { matchBinds: [key] } : {}), rows: [row], first: row };
};

const dexPriceRow = (id: string, price: number, updatedAt: number, opts: { tvl?: number; observedAt?: number | null; bps?: number | null; pools?: number; arrayFormat?: boolean } = {}) => ({
  stablecoin_id: id, dex_price_usd: price, deviation_from_primary_bps: opts.bps !== undefined ? opts.bps : null,
  source_pool_count: opts.pools ?? 4, source_total_tvl: opts.tvl ?? 10_000_000, updated_at: updatedAt,
  price_sources_json: JSON.stringify(opts.arrayFormat ? [{ aggregateObservedAt: opts.observedAt ?? updatedAt }] : { aggregateObservedAt: opts.observedAt === undefined ? updatedAt : opts.observedAt, sources: [] }),
});

const usdt = (o: Parameters<typeof makeAsset>[0] = {}) => makeAsset({ id: "usdt-tether", symbol: "USDT", ...o });
const eurc = (o: Parameters<typeof makeAsset>[0] = {}) => makeAsset({ id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", ...o });
const coinOf = (body: { coins: PegSummaryCoin[] }, id: string) => body.coins.find((c) => c.id === id);
const emptyTail: MockTableConfig[] = [{ match: "dex_prices", rows: [] }, { match: "supply_history", rows: [] }];
const emptyEventsTail: MockTableConfig[] = [{ match: "depeg_events", rows: [] }, ...emptyTail];

function makePegSummaryDb(
  assets: ReturnType<typeof makeAsset>[] = [],
  fxFallbackRates?: Record<string, number>,
  depegRows: ReturnType<typeof makeDepegEventRow>[] = [],
  { fxReferenceObservations, updatedAt = nowSec }: { fxReferenceObservations?: unknown; updatedAt?: number } = {},
) {
  return mockD1([
    { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
    cacheTable("stablecoins", { peggedAssets: assets, fxFallbackRates, fxReferenceObservations }, updatedAt, false),
    { match: "depeg_events", rows: depegRows }, ...emptyTail,
  ]);
}

function makePegSummaryDbWithDexPrice(
  assets: ReturnType<typeof makeAsset>[], updatedAt: number, sourceTotalTvl = 10_000_000,
  observedAt: number | null = updatedAt, dexPriceUsd = 1.0002, deviationFromPrimaryBps: number | null = 2,
) {
  return mockD1([
    { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
    cacheTable("stablecoins", { peggedAssets: assets }, nowSec, false),
    { match: "depeg_events", rows: [] },
    { match: "dex_prices", rows: [dexPriceRow(assets[0].id, dexPriceUsd, updatedAt, { tvl: sourceTotalTvl, observedAt, bps: deviationFromPrimaryBps })] },
    { match: "supply_history", rows: [] },
  ]);
}

function makeDepegEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below" as const,
    peak_deviation_bps: 120, started_at: nowSec, ended_at: null, start_price: 0.99, peak_price: 0.988, recovery_price: null,
    peg_reference: 1, source: "live" as const, confirmation_sources: null, pending_reason: null, provenance_audit_verdict: null,
    ...overrides,
  };
}

function makeCachedPegCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "usdt-tether", symbol: "USDT", name: "Tether", pegType: "peggedUSD", pegCurrency: "USD", governance: "centralized",
    currentDeviationBps: 12, pegReference: { valueUsd: 1, source: "median", contributorCount: 5, asOf: nowSec - 1200 },
    pegScore: 99, pegPct: 99.9, severityScore: 7, spreadPenalty: 2, eventCount: 1, worstDeviationBps: -120,
    activeDepeg: false, lastEventAt: nowSec - 86_400, trackingSpanDays: 400, observationStartedAt: nowSec - 2000 * 86_400,
    historyCoverage: { startedAt: nowSec - 400 * 86_400, source: "audited-replay", status: "verified" },
    recent90d: { windowDays: 90, observedDays: 90, coverageLimited: false, pegPct: 99.5, incidentCount: 1, thresholdCrossingCount: 2, worstDeviationBps: -120 },
    methodologyVersion: "6.08", ...overrides,
  };
}

describe("handlePegSummary", () => {
  const readSummary = async (db: D1Database) => PegSummaryResponseSchema.parse(await readJsonResponse(await handlePegSummary(db), 200));
  const readRaw = async (db: D1Database) => readJsonResponse<PegSummaryResponse>(await handlePegSummary(db), 200);

  it.each([
    ["2026-11-20T21:15:00Z", 1.067, 0, null], ["2026-11-22T22:15:00Z", 1.067, 0, null], ["2026-11-22T23:01:00Z", 1.067, 1, 300],
    ["2026-11-20T21:15:00Z", 1.1 * (1 - 2499.6 / 10000), 0, null], ["2026-11-20T21:15:00Z", 0.77, 1, 3000],
  ] as const)("uses legacy census hours at %s for a $%s quote", async (at, price, totalTracked, medianDeviationBps) => {
    const now = Date.parse(at) / 1000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const body = await readSummary(makePegSummaryDb([eurc({ price, priceObservedAt: now })], { peggedEUR: 1.1 }, [], { updatedAt: now }));
    expect(body.summary).toMatchObject({ totalTracked, medianDeviationBps });
    expect(body.summary?.worstCurrent?.bps ?? null).toBe(medianDeviationBps == null ? null : -medianDeviationBps);
  });

  it.each([true, false])("honors a published %s price refusal independently of a reference-only refusal", async (priceRefused) => {
    const asset = makeAsset({ price: 0.98, priceObservedAt: OPEN_FX_QUOTE_AT, currentPeg: {
      currentDeviationBps: null, pegReference: priceRefused ? { valueUsd: 1, source: "fallback", contributorCount: 0, asOf: OPEN_FX_QUOTE_AT } : null,
      pegReferenceUnavailable: !priceRefused, currentPriceUnavailable: priceRefused, primaryTrust: "unusable", dexPriceCheck: null,
    } });
    const body = await readSummary(makePegSummaryDb([asset]));
    expect(coinOf(body, asset.id)).toMatchObject({ currentDeviationBps: null, currentPriceUnavailable: priceRefused, price: priceRefused ? null : 0.98, priceObservedAt: priceRefused ? null : OPEN_FX_QUOTE_AT });
    expect(body.summary).toMatchObject({ totalTracked: 0, medianDeviationBps: null });
  });

  it.each([true, false])("keeps only a separately admitted DEX comparison when the primary is held (fresh DEX: %s)", async (dexAfterReopen) => {
    const reopen = Date.parse("2026-11-15T22:00:00Z") / 1000;
    const now = reopen + 300;
    const refAt = now - 10;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const asset = eurc({ price: 1.15, priceObservedAt: reopen - 1, circulating: { peggedEUR: 100_000_000 } });
    const options = {
      peggedAssets: [asset], asOf: now, fxFallbackRates: { peggedEUR: 1.1 },
      fxReferenceObservations: { peggedEUR: { pegKey: "peggedEUR", source: "openExchangeRates", cadence: "intraday", observedAtSec: refAt, usdPerUnit: 1.1, repricing: { sessionOpenedAtSec: reopen, preCloseUsdPerUnit: 1.09 } } },
    };
    const currentPeg = currentPegObservations.deriveCurrentPegObservationMap(options).get(asset.id);
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({ ...options, peggedAssets: [{ ...asset, currentPeg }] }), now);
      sqlite.prepare("INSERT INTO dex_prices (stablecoin_id, symbol, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at, price_sources_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(asset.id, asset.symbol, 1.1, -435, 4, 10_000_000, now, JSON.stringify({ aggregateObservedAt: dexAfterReopen ? now : reopen - 1, sources: [] }));
      const coin = coinOf(await readSummary(db), asset.id);
      expect(coin).toMatchObject({ currentDeviationBps: null, admittedDeviationBps: null, pegReferenceUnavailable: true, referenceAdmission: { reason: "quote-before-reopen" } });
      if (dexAfterReopen) expect(coin).toMatchObject({ pegReference: { valueUsd: 1.1, asOf: refAt }, dexPriceCheck: { dexPrice: 1.1, dexDeviationBps: 0, agrees: false, referenceAdmission: { status: "admitted", referenceObservedAtSec: refAt } } });
      else expect([coin?.pegReference, coin?.dexPriceCheck]).toEqual([null, undefined]);
    } finally { sqlite.close(); }
  });

  it("keeps a historical score during a live quote outage when the daily quote is stored in provenance", async () => {
    const now = OPEN_FX_QUOTE_AT;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({ peggedAssets: ["usdt-tether", "usdc-circle"].map((id) => makeAsset({ id, price: null })) }), now);
      const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, supply_provenance) VALUES (?, ?, 100000000, ?)");
      const snapshotDate = Math.floor(now / 86400) * 86400;
      const prov = { supplySource: "coingecko-fallback", supplyObservedAt: now - 300, supplyChainGuard: null, nativeQuantityUnavailable: true };
      const rows = [["usdt-tether", 1, 100], ["usdc-circle", 0, null]] as const;
      for (const [id, price] of rows) insert.run(id, snapshotDate, JSON.stringify({ ...prov, marketQuote: { price, observedAt: now - 300 } }));
      const body = await readSummary(db);
      for (const [id, , pegScore] of rows) expect(coinOf(body, id)).toMatchObject({ currentPriceUnavailable: true, pegScore, pegPct: pegScore });
    } finally { sqlite.close(); }
  });

  it.each([undefined, {}])("keeps published unit refusals out of the census with FX map %j", async (fxReferenceObservations) => {
    vi.useFakeTimers(); vi.setSystemTime(OPEN_FX_QUOTE_AT * 1000);
    const refused = { currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true, currentPriceUnavailable: false, primaryTrust: "authoritative", dexPriceCheck: null } as const;
    const assets = [
      makeAsset({ id: "xagm-matrixdock", pegType: "peggedSILVER", price: 29.4, priceObservedAt: OPEN_FX_QUOTE_AT, currentPeg: refused }),
      makeAsset({ id: "susd-solayer", price: 1.06, priceSource: "protocol-redeem", priceObservedAt: OPEN_FX_QUOTE_AT, currentPeg: refused }),
      makeAsset({ id: "usdc-circle", price: 1, priceObservedAt: OPEN_FX_QUOTE_AT }),
    ];
    const body = await readSummary(makePegSummaryDb(assets, { peggedSILVER: 30 }, [], { updatedAt: OPEN_FX_QUOTE_AT, fxReferenceObservations }));
    for (const { id, price } of assets.slice(0, 2)) expect(coinOf(body, id)).toMatchObject({ price, currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true });
    expect(body.summary).toMatchObject({ totalTracked: 1, coinsAtPeg: 1, medianDeviationBps: 0 });
  });

  it.each([null, 0, -1, 1])("keeps historical analytics when the live price is %s", async (price) => {
    vi.useFakeTimers(); vi.setSystemTime(nowSec * 1000);
    const db = mockD1([
      cacheTable("stablecoins", { peggedAssets: [makeAsset({ price, priceObservedAt: nowSec, priceUpdatedAt: nowSec })] }),
      cacheTable("peg-analytics", { computedAtSec: nowSec, depegEventsToday: 2, depegEventsYesterday: 1, pegData: [makeCachedPegCoin()] }),
      { match: "dex_prices", rows: [] }, { match: "pharos:peg-summary:recently-priced-ids", rows: [{ stablecoin_id: "usdt-tether", price: 1 }] },
    ]);
    const body = await readSummary(db);
    expect(body.coins).toHaveLength(1);
    expect(body.coins[0]).toMatchObject({ price: price === 1 ? 1 : null, priceObservedAt: nowSec, currentDeviationBps: price === 1 ? 0 : null, pegScore: 99, eventCount: 1, worstDeviationBps: -120 });
    expect(body.summary).toMatchObject({ activeDepegCount: 0, medianDeviationBps: price === 1 ? 0 : null, worstCurrent: price === 1 ? { id: "usdt-tether", symbol: "USDT", bps: 0 } : null, coinsAtPeg: price === 1 ? 1 : 0, totalTracked: price === 1 ? 1 : 0, depegEventsToday: 2, depegEventsYesterday: 1 });
  });

  it("marks peg reference unavailable when current observation is missing", async () => {
    vi.spyOn(currentPegObservations, "deriveCurrentPegObservationMap").mockReturnValue(new Map());
    const body = await readRaw(makePegSummaryDb([usdt({ price: 1 })]));
    expect(coinOf(body, "usdt-tether")).toMatchObject({ price: null, currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true });
  });

  it.each([
    ...[99.6, 100, 100.4, -99.6, -100, -100.4].map((bps) => ({ bps, pegType: "peggedUSD", id: "usdt-tether", threshold: 100 })),
    ...[149.6, 150, 150.4, -149.6, -150, -150.4].map((bps) => ({ bps, pegType: "peggedEUR", id: "eurc-circle", threshold: 150 })),
  ])("classifies legacy raw threshold deviation $bps for $pegType while displaying rounded bps", async ({ bps, pegType, id, threshold }) => {
    const price = 1 + bps / 10_000;
    const body = await readRaw(makePegSummaryDb([makeAsset({ id, pegType, price, priceObservedAt: OPEN_FX_QUOTE_AT })], pegType === "peggedEUR" ? { peggedEUR: 1 } : undefined));
    const signal = deriveDepegSignal(price, 1)!;
    const coin = coinOf(body, id);
    expect(coin?.currentDeviationBps).toBe(signal.bps);
    expect(coin).not.toHaveProperty("admittedDeviationBps");
    expect(body.summary).toMatchObject({ totalTracked: 1, coinsAtPeg: signalCrossesThreshold(signal, threshold) ? 0 : 1 });
  });

  it.each([
    ["absent evidence map", "legacy", 0, 200, undefined, undefined, 1],
    ["empty evidence map", "empty", 0, 200, null, "reference-clock-unavailable", 0],
    ["two-hour pair", "intraday", 7200, 0, 0, "live-reference", 1],
    ["two hours plus one second", "intraday", 7201, 0, null, "quote-reference-unpaired", 0],
    ["Easter Monday with Thursday's fixing", "fixing", 60, 200, null, "quote-reference-unpaired", 0],
    ["clockless row in a clocked generation", "other-peg", 60, 0, null, "reference-clock-unavailable", 0],
  ] as const)("%s", async (_label, mode, quoteAge, raw, admitted, reason, count) => {
    const decisionAtSec = Date.parse("2027-03-29T16:00:00Z") / 1000;
    const updatedAt = decisionAtSec - 10;
    vi.spyOn(Date, "now").mockReturnValue(decisionAtSec * 1000);
    const asset = makeAsset({ id: "brz-transfero", pegType: "peggedREAL", price: 0.204, priceObservedAt: decisionAtSec - quoteAge });
    const usdPerUnit = mode === "fixing" || mode === "empty" || mode === "legacy" ? 0.2 : 0.204;
    const pegKey = mode === "other-peg" ? "peggedEUR" : "peggedREAL";
    const evidence = mode === "fixing"
      ? { pegKey, usdPerUnit, source: "frankfurter", cadence: "business-daily", observedAtSec: Date.parse("2027-03-25T13:10:00Z") / 1000 } as const
      : { pegKey, usdPerUnit, source: "openExchangeRates", cadence: "intraday", observedAtSec: decisionAtSec, repricing: { sessionOpenedAtSec: Date.parse("2027-03-28T21:00:00Z") / 1000, preCloseUsdPerUnit: 0.2 } } as const;
    const body = await readSummary(makePegSummaryDb([asset], { peggedREAL: usdPerUnit }, [], { fxReferenceObservations: mode === "legacy" ? undefined : mode === "empty" ? {} : { [pegKey]: evidence }, updatedAt }));
    const coin = coinOf(body, asset.id);
    expect(coin?.currentDeviationBps).toBe(reason && admitted == null ? null : raw);
    if (reason) {
      expect(coin).toMatchObject({ admittedDeviationBps: admitted, referenceAdmission: { reason, generation: `stablecoins:${updatedAt}` }, pegReferenceUnavailable: admitted == null });
      expect(coin?.pegReference?.asOf ?? null).toBe(mode === "empty" || mode === "other-peg" ? null : evidence.observedAtSec);
    } else {
      expect(coin).not.toHaveProperty("admittedDeviationBps");
      expect(coin).not.toHaveProperty("referenceAdmission");
      expect(coin?.pegReference?.asOf).toBe(updatedAt);
    }
    expect(body.summary).toMatchObject({ totalTracked: count, coinsAtPeg: count && raw === 0 ? 1 : 0, medianDeviationBps: count ? raw : null });
    expect(body.summary?.worstCurrent?.bps ?? null).toBe(count ? raw : null);
  });

  it.each(["accrued-token", undefined] as const)("keeps XOFm proceeds and Solayer valuation (%s) outside the parity census", async (parityQuoteUnit) => {
    const now = OPEN_FX_QUOTE_AT;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const assets = [
      makeAsset({ id: "xofm-mento", pegType: "peggedXOF", priceSource: "mento-broker", price: 0.98 / 600, priceObservedAt: now }),
      makeAsset({ id: "susd-solayer", pegType: "peggedUSD", priceSource: "cached", agreeSources: ["protocol-redeem"], parityQuoteUnit, price: 1.181399598224652, priceObservedAt: now }),
      makeAsset({ id: "usdc-circle", pegType: "peggedUSD", price: 1, priceObservedAt: now }),
    ];
    const body = await readSummary(makePegSummaryDb(assets, { peggedXOF: 1 / 600 }, [], { updatedAt: now, fxReferenceObservations: {} }));
    for (const a of assets.slice(0, 2)) expect(coinOf(body, a.id)).toMatchObject({ price: a.price, priceObservedAt: now, currentPriceUnavailable: false, currentDeviationBps: null, admittedDeviationBps: null });
    expect(body.summary).toMatchObject({ totalTracked: 1, coinsAtPeg: 1, medianDeviationBps: 0, worstCurrent: { id: "usdc-circle" } });
  });

  it.each([
    { priceSource: "coingecko", priceObservedAtMode: "nominal_reference" as const },
    { priceSource: "protocol-par", priceObservedAtMode: "upstream" as const },
    { priceSource: "coingecko+protocol-par", priceObservedAtMode: "upstream" as const },
  ])("withholds nominal current prices despite an older accepted at-peg reference: $priceSource", async (prov) => {
    vi.useFakeTimers(); vi.setSystemTime(nowSec * 1000);
    const cachedAt = sameDayCachedAt(1200);
    const body = await readRaw(mockD1([
      cacheTable("stablecoins", { peggedAssets: [usdt({ price: 1, ...prov })] }),
      cacheTable("peg-analytics", { computedAtSec: cachedAt, depegEventsToday: 0, depegEventsYesterday: 0, pegData: [makeCachedPegCoin()] }, cachedAt),
      { match: "dex_prices", rows: [] }, { match: "pharos:peg-summary:recently-priced-ids", rows: [] },
    ]));
    expect(body.coins[0]).toMatchObject({ price: null, currentDeviationBps: null, currentPriceUnavailable: true, pegScore: null, pegPct: null, recent90d: null });
    expect(body.summary).toMatchObject({ coinsAtPeg: 0, totalTracked: 0 });
  });

  it.each([false, true].flatMap((retained) => (["failed-read", "malformed-row"] as const).map((failure) => ({ retained, failure }))))(
    "does not substitute raw analytics on $failure projection with retained cache=$retained",
    async ({ retained, failure }) => {
      vi.useFakeTimers();
      const requestNowSec = Date.parse("2026-07-13T12:00:00Z") / 1000;
      vi.setSystemTime(requestNowSec * 1000);
      const computedAtSec = requestNowSec - 3600;
      const reason = failure === "failed-read" ? "incident-projection-read-failed" : "incident-projection-invalid";
      const db = mockD1([
        cacheTable("stablecoins", { peggedAssets: [usdt()] }, requestNowSec),
        { match: "cache", matchBinds: ["peg-analytics"], rows: retained ? [{ key: "peg-analytics", updated_at: computedAtSec, value: JSON.stringify({ computedAtSec, depegEventsToday: 1, depegEventsYesterday: 0, pegData: [makeCachedPegCoin({ eventCount: 1 })] }) }] : [], ...(retained ? {} : { first: null }) },
        { match: "pharos:depeg-event-projection:active-incidents", rows: failure === "malformed-row" ? [{ current_event_id: 2, first_started_at: 0, first_start_price: 0.97, first_peg_reference: 1, constituent_event_count: 2 }] : [], ...(failure === "failed-read" ? { throwError: new Error("projection unavailable") } : {}) },
        ...emptyTail, { match: "depeg_events", rows: [makeDepegEventRow(), makeDepegEventRow({ id: 2 })] },
      ]);
      const res = await handlePegSummary(db);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      if (retained) {
        const body = await readJsonResponse<PegSummaryResponse>(res, 200);
        expect(body.degradedReason).toBe(reason);
        expect(body.coins[0].eventCount).toBe(1);
        expect(res.headers.get("X-Data-Age")).toBe("3600");
      } else expect(await readJsonResponse(res, 503)).toMatchObject({ reason });
    },
  );

  it("handles unknown legacy-open coverage, currency vocabulary, 503 cache errors, deriveDexDeviationBps, and basic 200/provenance", async () => {
    const legacy = await readRaw(makePegSummaryDb([usdt({ price: 1 })], undefined, [makeDepegEventRow({ started_at: nowSec - 6 * 365 * 86400 })]));
    const lc = coinOf(legacy, "usdt-tether")!;
    expect(lc.pegScore).toBeNull();
    expect(lc.pegPct).toBeNull();
    expect(lc.unknownCoverageSeconds).toBeGreaterThan(3 * 365 * 86400);
    expect(lc.recent90d).toMatchObject({ pegPct: null, observedDays: 0, coverageLimited: true });

    const expected: Record<PegCurrency, string | undefined> = {
      USD: "peggedUSD", EUR: "peggedEUR", GBP: "peggedGBP", CHF: "peggedCHF", BRL: "peggedREAL", RUB: "peggedRUB", JPY: "peggedJPY",
      KRW: "peggedKRW", IDR: "peggedIDR", INR: "peggedINR", MYR: "peggedMYR", SGD: "peggedSGD", HKD: "peggedHKD", TRY: "peggedTRY",
      AUD: "peggedAUD", ZAR: "peggedZAR", CAD: "peggedCAD", CNY: "peggedCNY", CNH: "peggedCNH", PHP: "peggedPHP", MXN: "peggedMXN",
      VND: "peggedVND", UAH: "peggedUAH", ARS: "peggedARS", KGS: "peggedKGS", NGN: "peggedNGN", XOF: "peggedXOF", COP: "peggedCOP",
      CLP: "peggedCLP", GHS: "peggedGHS", KES: "peggedKES", PEN: "peggedPEN", CZK: "peggedCZK", PLN: "peggedPLN", AED: "peggedAED",
      NZD: "peggedNZD", GOLD: "peggedGOLD", SILVER: "peggedSILVER", VAR: undefined, OTHER: undefined,
    };
    expect(Object.fromEntries(PEG_CURRENCY_VALUES.map((c) => [c, __pegSummaryTestHooks.normalizePegTypeFromCurrency(c)]))).toEqual(expected);

    expect((await handlePegSummary(mockD1([{ match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null }]))).status).toBe(503);
    const corrupt = await handlePegSummary(mockD1([cacheTable("stablecoins", { nope: true }, nowSec, false)]));
    expect(corrupt.status).toBe(503);
    await expect(corrupt.json()).resolves.toMatchObject({ error: "Cached stablecoins data is corrupt" });
    expect(__pegSummaryTestHooks.deriveDexDeviationBps(1.02, null, {}, undefined, -100, 200)).toBe(98);
    expect(__pegSummaryTestHooks.deriveDexDeviationBps(1.02, null, {}, undefined, null, 200)).toBeNull();

    const ok = await readSummary(makePegSummaryDb([usdt({ price: 1 })]));
    expect(Array.isArray(ok.coins)).toBe(true);
    expect(ok.coins.some((c) => c.id === "usdt-tether")).toBe(true);
    expect(ok.summary).toMatchObject({ activeDepegCount: 0, medianDeviationBps: 0, totalTracked: ok.coins.filter((c) => c.currentDeviationBps !== null).length, worstCurrent: { id: "usdt-tether", symbol: "USDT", bps: 0 } });
    expect(ok.coins[0].methodologyVersion).toBe(ok.methodology.version);
    expect(ok.methodology.versionLabel.length).toBeGreaterThan(0);
    expect(ok.methodology.changelogPath).toBe("/methodology/depeg-changelog/");

    const provBody = await readSummary(makePegSummaryDb([usdt({ priceSource: "cached", price: 0.997, priceConfidence: "fallback", priceObservedAt: nowSec - 3600, priceObservedAtMode: "local_fetch", priceSyncedAt: nowSec - 1200, priceUpdatedAt: nowSec - 1800 })]));
    expect(coinOf(provBody, "usdt-tether")).toMatchObject({ price: 0.997, priceSource: "cached", priceConfidence: "fallback", priceObservedAt: nowSec - 3600, priceObservedAtMode: "local_fetch", priceSyncedAt: nowSec - 1200, priceUpdatedAt: nowSec - 1800, primaryTrust: "confirm_required" });
  });

  it.each([
    ["fresh", 1800, 10_000_000, 1800, true], ["stale publication", DEX_PRICE_CHECK_FRESHNESS_SEC, 10_000_000, 60, false],
    ["thin", 1800, 200_000, 60, false], ["stale original", 60, 10_000_000, DEX_PRICE_CHECK_FRESHNESS_SEC, false],
    ["six-hour original", 60, 10_000_000, 21_600, false], ["missing original", 60, 10_000_000, null, false],
  ] as const)("admits only fresh, thick original DEX observations: %s", async (_l, age, tvl, origAge, accepted) => {
    vi.useFakeTimers(); vi.setSystemTime(nowSec * 1000);
    const db = makePegSummaryDbWithDexPrice([usdt()], nowSec - age, tvl, origAge == null ? null : nowSec - origAge);
    const decode = vi.spyOn(depegTrustPolicy, "readDexAggregateObservedAt");
    const body = await readSummary(db);
    expect(db.getHistory().find(({ sql }) => sql.includes("FROM dex_prices"))?.sql).toContain("price_sources_json");
    expect(decode).toHaveBeenCalledTimes(age < DEX_PRICE_CHECK_FRESHNESS_SEC && tvl >= 250_000 ? 1 : 0);
    const check = coinOf(body, "usdt-tether")?.dexPriceCheck;
    if (accepted) expect(check).toEqual({ observedAtSec: nowSec - origAge!, dexPrice: 1.0002, dexDeviationBps: 2, agrees: true, sourcePools: 4, sourceTvl: 10_000_000 });
    else expect(check).toBeUndefined();
  });

  it("handles DEX failure degradation, missing primary with DEX, fixed-USD primary unavailable, NAV DEX basis, and secondary FX DEX", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failRes = await handlePegSummary(mockD1([
      cacheTable("stablecoins", { peggedAssets: [usdt()] }, nowSec, false),
      { match: "depeg_events", rows: [] }, { match: "dex_prices", rows: [], throwError: new Error("no such table: dex_prices") }, { match: "supply_history", rows: [] },
    ]));
    const failBody = PegSummaryResponseSchema.parse(await readJsonResponse(failRes, 200));
    expect(coinOf(failBody, "usdt-tether")?.dexPriceCheck).toBeUndefined();
    expect(failBody.degradedReason).toBe("dex-prices-read-failed");
    expect(failRes.headers.get("Cache-Control")).toBe("no-store");
    expect(failRes.headers.get("Warning")).toContain("DEX price read failed");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[peg-summary] DEX price query failed, serving degraded response:"));

    const noPrim = await readSummary(makePegSummaryDbWithDexPrice([usdt({ price: null })], nowSec - 1800));
    expect(coinOf(noPrim, "usdt-tether")?.dexPriceCheck).toEqual({ observedAtSec: nowSec - 1800, dexPrice: 1.0002, dexDeviationBps: 2, agrees: true, sourcePools: 4, sourceTvl: 10_000_000 });

    const at = nowSec - 60;
    const fixedUsd = await readSummary(makePegSummaryDbWithDexPrice([usdt({ price: null, currentPeg: { currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: false, currentPriceUnavailable: true, primaryTrust: "unusable", dexPriceCheck: null } })], at, 10_000_000, at, 0.96, -400));
    expect(coinOf(fixedUsd, "usdt-tether")).toMatchObject({ price: null, currentDeviationBps: null, currentPriceUnavailable: true, dexPriceCheck: { observedAtSec: at, dexPrice: 0.96, dexDeviationBps: -400, agrees: false, sourcePools: 4, sourceTvl: 10_000_000 } });

    const dexCoinFor = async (asset: StablecoinData, dexPrice: number) =>
      coinOf(await readSummary(makePegSummaryDbWithDexPrice([asset], at, 10_000_000, at, dexPrice, null)), asset.id);
    const navAsset = (ov: Partial<StablecoinData> = {}) => makeAsset({ id: "susde-ethena", name: "Ethena Staked USDe", symbol: "sUSDe", geckoId: "ethena-staked-usde", price: 1.2514, ...ov });
    const navOk = await dexCoinFor(navAsset(), 1.2513);
    expect(navOk?.price).toBe(1.2514);
    expect(navOk?.dexPriceCheck?.agrees).toBe(true);
    expect(Math.abs(navOk?.dexPriceCheck?.dexDeviationBps ?? Infinity)).toBeLessThan(50);
    expect((await dexCoinFor(navAsset(), 1.2))?.dexPriceCheck?.agrees).toBe(false);
    for (const ov of [{ price: null }, { priceObservedAtMode: "nominal_reference" as const }]) {
      const c = await dexCoinFor(navAsset(ov), 1.2513);
      expect(c?.price).toBeNull();
      expect(c?.dexPriceCheck).toBeUndefined();
    }
    for (const [p, bps] of [[0.97, -300], [0.4, -6000]]) expect((await dexCoinFor(makeAsset({ price: p }), p))?.dexPriceCheck).toMatchObject({ dexDeviationBps: bps, agrees: true });

    const fxSpecs = [["kgst-kyrgyz-som", "KGST", "peggedKGS", 1 / 87], ["cngn-compliant-naira", "cNGN", "peggedNGN", 1 / 1370], ["xofm-mento", "XOFm", "peggedXOF", 1 / 600]] as const;
    const fxBody = await readRaw(mockD1([
      cacheTable("stablecoins", { peggedAssets: fxSpecs.map(([id, symbol, peg]) => makeAsset({ id, symbol, pegType: "", price: null, circulating: { [peg]: 2_000_000 } })), fxFallbackRates: Object.fromEntries(fxSpecs.map(([, , peg, r]) => [peg, r])) }, nowSec, false),
      { match: "depeg_events", rows: [] }, { match: "dex_prices", rows: fxSpecs.map(([id, , , r]) => dexPriceRow(id, r, at, { tvl: 2_000_000, pools: 2, arrayFormat: true })) }, { match: "supply_history", rows: [] },
    ]));
    for (const [id] of fxSpecs) expect(coinOf(fxBody, id)?.dexPriceCheck).toMatchObject({ dexDeviationBps: 0, agrees: true });
  });

  it.each([[OPEN_FX_QUOTE_AT, 1], [1_794_758_400, 0]])("uses the live peg unit for the DEX cross-check and legacy at-peg threshold (%s)", async (t, atPeg) => {
    vi.useFakeTimers(); vi.setSystemTime(t * 1000);
    const price = 1.08 * 1.012;
    const body = await readRaw(mockD1([
      cacheTable("stablecoins", { peggedAssets: [eurc({ name: "EURC", symbol: "EURC", price, priceObservedAt: t, priceUpdatedAt: t, circulating: { peggedEUR: 100_000_000 } })], fxFallbackRates: { peggedEUR: 1.08 } }, t),
      cacheTable("peg-analytics", { computedAtSec: t - 60, depegEventsToday: 0, depegEventsYesterday: 0, pegData: [makeCachedPegCoin({ id: "eurc-circle", name: "EURC", symbol: "EURC", pegCurrency: "EUR", pegType: "peggedUSD", currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true })] }, t),
      { match: "dex_prices", rows: [dexPriceRow("eurc-circle", price, t - 60, { tvl: 5_000_000, pools: 3, arrayFormat: true })] },
    ]));
    const coin = coinOf(body, "eurc-circle");
    expect(coin).toMatchObject({ pegType: "peggedEUR", currentDeviationBps: 120, pegReference: { asOf: t }, dexPriceCheck: { dexDeviationBps: 120, agrees: true } });
    expect(coin).not.toHaveProperty("referenceAdmission");
    expect(body.summary).toMatchObject({ coinsAtPeg: atPeg, totalTracked: atPeg });
  });

  it("withholds NAV peg signals/event counters, bounds denominator to priced coins, enforces thin FX fallback, counts today/yesterday, and marks low-cap", async () => {
    const xgld = makeAsset({ id: "xgld-unitas", name: "Unitas Gold", symbol: "xGLD", pegType: "peggedVAR", price: 1.12 });
    const cjpy = makeAsset({ id: "cjpy-yamato", symbol: "CJPY", name: "Convertible JPY Token", pegType: "peggedJPY", price: 0.005, priceSource: "coingecko", priceConfidence: "single-source", priceUpdatedAt: nowSec, circulating: { peggedJPY: 500_000 } });
    const navBody = await readSummary(makePegSummaryDb([usdt(), xgld, cjpy], undefined, [makeDepegEventRow({ stablecoin_id: "xgld-unitas", symbol: "xGLD", peg_type: "peggedVAR", direction: "above", peak_deviation_bps: 1200 })]));
    expect(navBody.coins.length).toBeGreaterThanOrEqual(3);
    expect(coinOf(navBody, "usdt-tether")?.currentDeviationBps).not.toBeNull();
    expect(coinOf(navBody, "xgld-unitas")).toMatchObject({ currentDeviationBps: null, pegScore: null, pegPct: null, severityScore: 100, spreadPenalty: 0, activeDepeg: false, eventCount: 0, worstDeviationBps: null, lastEventAt: null, trackingSpanDays: 0 });
    expect(coinOf(navBody, "cjpy-yamato")).toMatchObject({ currentDeviationBps: null, depegEventCoverageLimited: true });
    expect(navBody.summary).toMatchObject({ activeDepegCount: 0, depegEventsToday: 0, depegEventsYesterday: 0, totalTracked: 1 });

    for (const priceUpdatedAt of [OPEN_FX_QUOTE_AT, null]) {
      expect((await readSummary(makePegSummaryDb([eurc({ price: 1.065, priceSource: "defillama", priceConfidence: "single-source", priceObservedAt: null, priceUpdatedAt })], { peggedEUR: 1.07 }))).summary).toMatchObject({ coinsAtPeg: 1, totalTracked: 1 });
    }

    const thinBody = await readRaw(mockD1([
      cacheTable("stablecoins", { peggedAssets: [eurc({ price: 1.065, priceSource: "defillama", priceUpdatedAt: nowSec })] }, nowSec, false),
      { match: "depeg_events", rows: [] }, { match: "dex_prices", rows: [dexPriceRow("eurc-circle", 1.065, nowSec - 60, { bps: 0, arrayFormat: true })] }, { match: "supply_history", rows: [] },
    ]));
    const thinCoin = coinOf(thinBody, "eurc-circle");
    expect(thinCoin).toMatchObject({ currentDeviationBps: null, pegReferenceUnavailable: true });
    expect(thinCoin?.dexPriceCheck).toBeUndefined();
    expect(thinBody.summary?.coinsAtPeg).toBe(0);

    const dayBody = await readRaw(makePegSummaryDb([usdt()], undefined, [
      makeDepegEventRow({ id: 1, started_at: Math.max(TODAY_START_SEC, nowSec - 60) }),
      makeDepegEventRow({ id: 2, started_at: TODAY_START_SEC - 60 }),
      makeDepegEventRow({ id: 3, started_at: TODAY_START_SEC - 86_460 }),
      makeDepegEventRow({ id: 4, started_at: Math.max(TODAY_START_SEC, nowSec - 30), provenance_audit_verdict: "disputed" }),
      makeDepegEventRow({ id: 5, started_at: TODAY_START_SEC - 30, provenance_audit_verdict: "false_positive" }),
    ]));
    expect(dayBody.summary).toMatchObject({ depegEventsToday: 1, depegEventsYesterday: 1 });
  });

  it("serves fresh peg-analytics cache, recomputes live deviations, falls back when cache throws, and handles midnight re-bucketing", async () => {
    vi.useFakeTimers(); vi.setSystemTime(nowSec * 1000);
    const cachedAt = sameDayCachedAt(1200);
    const cachedRes = await handlePegSummary(mockD1([
      cacheTable("stablecoins", { peggedAssets: [usdt({ price: 0.98 })] }),
      cacheTable("peg-analytics", { computedAtSec: cachedAt, depegEventsToday: 2, depegEventsYesterday: 5, pegData: [makeCachedPegCoin()] }),
      ...emptyEventsTail,
    ]));
    const cachedBody = await readJsonResponse<PegSummaryResponse>(cachedRes, 200);
    expect(cachedBody.summary).toMatchObject({ depegEventsToday: 2, depegEventsYesterday: 5 });
    expect(coinOf(cachedBody, "usdt-tether")).toMatchObject({ currentDeviationBps: -200, pegScore: 99, pegPct: 99.9, eventCount: 1, observationStartedAt: nowSec - 2000 * 86_400 });
    expect(cachedBody.methodology.asOf).toBe(cachedAt);
    expect(Number(cachedRes.headers.get("X-Data-Age"))).toBe(nowSec - cachedAt);

    const liveCases = [
      { id: "usdt-tether", asset: usdt({ price: 0.98 }), peg: makeCachedPegCoin(), expected: -200 },
      { id: "eurc-circle", asset: eurc({ symbol: "EURC", price: 1.08 }), peg: makeCachedPegCoin({ id: "eurc-circle", symbol: "EURC", name: "Euro Coin", pegType: "peggedEUR", pegCurrency: "EUR", pegReference: { valueUsd: 1.2, source: "fx", contributorCount: 0, asOf: nowSec - 1200 } }), expected: -1000 },
      { id: "xaut-tether", asset: makeAsset({ id: "xaut-tether", symbol: "XAUT", pegType: "peggedGOLD", price: 3030 }), peg: makeCachedPegCoin({ id: "xaut-tether", symbol: "XAUT", name: "Tether Gold", pegType: "peggedGOLD", pegCurrency: "GOLD", pegReference: { valueUsd: 3000, source: "median", contributorCount: 2, asOf: nowSec - 1200 } }), expected: 100 },
      { id: "cjpy-yamato", asset: makeAsset({ id: "cjpy-yamato", symbol: "CJPY", pegType: "peggedJPY", price: 0.006 }), peg: makeCachedPegCoin({ id: "cjpy-yamato", symbol: "CJPY", name: "Convertible JPY Token", pegType: "peggedJPY", pegCurrency: "JPY", currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true }), expected: null },
      { id: "usdc-circle", asset: makeAsset({ id: "usdc-circle", symbol: "USDC", price: null }), peg: makeCachedPegCoin({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }), expected: null },
      { id: "xgld-unitas", asset: makeAsset({ id: "xgld-unitas", symbol: "xGLD", pegType: "peggedVAR", price: 1.2 }), peg: makeCachedPegCoin({ id: "xgld-unitas", symbol: "xGLD", name: "Unitas Gold", pegType: "peggedVAR", pegCurrency: "VAR", currentDeviationBps: null, pegReference: null, pegScore: null }), expected: null },
    ];
    const multiBody = await readRaw(mockD1([
      cacheTable("stablecoins", { peggedAssets: liveCases.map((c) => c.asset), fxFallbackRates: { peggedEUR: 1.2, peggedGOLD: 3000 } }),
      cacheTable("peg-analytics", { computedAtSec: cachedAt, depegEventsToday: 0, depegEventsYesterday: 0, pegData: liveCases.map((c) => c.peg) }),
      { match: "dex_prices", rows: [] },
    ]));
    expect(Object.fromEntries(liveCases.map(({ id }) => { const c = coinOf(multiBody, id); return [id, [c?.price, c?.currentDeviationBps]]; })))
      .toEqual(Object.fromEntries(liveCases.map(({ id, asset, expected }) => [id, [asset.price, expected]])));

    const fbBody = await readRaw(mockD1([
      cacheTable("stablecoins", { peggedAssets: [usdt()] }),
      { match: "cache", matchBinds: ["peg-analytics"], rows: [], throwError: new Error("cache read failed") },
      { match: "FROM cache WHERE key = ?", rows: [], first: null }, { match: "INSERT INTO cache", rows: [] }, ...emptyEventsTail,
    ]));
    expect(fbBody.coins.some((c) => c.id === "usdt-tether")).toBe(true);

    const pubAt = Date.parse("2026-07-12T23:46:00Z") / 1000;
    const todayStart = Date.parse("2026-07-13T00:00:00Z") / 1000;
    vi.setSystemTime((todayStart + 300) * 1000);
    expect((await readSummary(mockD1([
      cacheTable("stablecoins", { peggedAssets: [usdt({ price: 1 })] }, pubAt),
      cacheTable("peg-analytics", { computedAtSec: pubAt, depegEventsToday: 1, depegEventsYesterday: 0, pegData: [makeCachedPegCoin()] }, pubAt),
      ...emptyEventsTail,
    ]))).summary).toMatchObject({ depegEventsToday: 0, depegEventsYesterday: 0 });

    const errRes = await handlePegSummary(mockD1([
      cacheTable("stablecoins", { peggedAssets: [usdt({ price: 1 })] }, pubAt),
      cacheTable("peg-analytics", { computedAtSec: pubAt, depegEventsToday: 3, depegEventsYesterday: 4, pegData: [makeCachedPegCoin()] }, pubAt),
      { match: "depeg_events_with_provenance", rows: [], throwError: new Error("D1 unavailable") }, { match: "dex_prices", rows: [] },
    ]));
    expect(errRes.headers.get("Cache-Control")).toBe("no-store");
    expect(await readJsonResponse(errRes, 503)).toMatchObject({ error: expect.stringContaining("depeg event"), reason: "peg-event-day-count-read-failed" });

    for (const [minute, retained] of [[5, false], [26, true]] as const) {
      const readAt = todayStart + minute * 60;
      vi.setSystemTime(readAt * 1000);
      const price = retained ? 0.98 : 1;
      const st = cacheTable("stablecoins", { peggedAssets: [usdt({ price, priceObservedAt: readAt - 60 })] }, pubAt);
      const res = await handlePegSummary(mockD1([
        st, cacheTable("peg-analytics", { computedAtSec: pubAt, depegEventsToday: 9, depegEventsYesterday: 9, pegData: [makeCachedPegCoin({ eventCount: 7, price: 1.1 })] }, pubAt),
        { ...st, matchBinds: undefined },
        { match: "pharos:depeg-event-projection:active-incidents", rows: [], throwError: new Error("projection unavailable") },
        { match: "depeg_events", rows: [makeDepegEventRow({ id: 1, started_at: todayStart + 60 }), makeDepegEventRow({ id: 2, started_at: todayStart - 60 })] },
        ...emptyTail,
      ]));
      const body = PegSummaryResponseSchema.parse(await readJsonResponse(res, 200));
      expect(body.degradedReason).toBe(retained ? "incident-projection-read-failed" : undefined);
      expect(res.headers.get("Cache-Control")).toContain(retained ? "no-store" : "s-maxage=300");
      expect(coinOf(body, "usdt-tether")).toMatchObject({ eventCount: 7, price, currentDeviationBps: retained ? -200 : 0, priceObservedAt: readAt - 60 });
      expect(body.summary).toMatchObject({ depegEventsToday: 1, depegEventsYesterday: 1 });
    }

    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      vi.setSystemTime((todayStart + 300) * 1000);
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("stablecoins", JSON.stringify({ peggedAssets: [usdt({ price: 1 })] }), todayStart + 300);
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("peg-analytics", JSON.stringify({ computedAtSec: pubAt, depegEventsToday: 1, depegEventsYesterday: 0, pegData: [makeCachedPegCoin()] }), pubAt);
      const ins = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference) VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', 200, ?, NULL, 0.99, 1)");
      const firstOnset = Date.parse("2026-07-12T23:00:00Z") / 1000;
      const fragAt = todayStart + 60;
      ins.run(101, fragAt); ins.run(102, firstOnset); ins.run(103, todayStart + 120);
      const key = `ddr2:${"a".repeat(32)}`;
      sqlite.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, 101, 'observed', 1700000100), (?, 102, 'observed', 1700000100)").run(key, key);
      sqlite.prepare("INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state, superseded_by_incident_key, source_fingerprint, created_at, updated_at) VALUES (?, 'usdt-tether', 'USD', 'below', 102, 101, ?, ?, 200, 'active', NULL, ?, 1700000100, 1700000100)").run(key, firstOnset, fragAt, "a".repeat(64));
      expect((await readSummary(db)).summary).toMatchObject({ depegEventsToday: 1, depegEventsYesterday: 1 });
    } finally { sqlite.close(); }
  });
});

describe("active-depeg census scope", () => {
  const CENSUS_NOW = 1_777_249_800;
  const GENERATION = CENSUS_NOW - 600;

  it("publishes one census when the retained generation still carries a retired coin's incident", async () => {
    vi.useFakeTimers(); vi.setSystemTime(CENSUS_NOW * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("stablecoins", JSON.stringify({
        peggedAssets: [makeAsset({ id: "usdt-tether", price: 0.9988, priceObservedAt: GENERATION, priceUpdatedAt: GENERATION, circulating: { peggedUSD: 150_000_000_000 } })],
      }), GENERATION);
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("peg-analytics", JSON.stringify({
        computedAtSec: GENERATION, depegEventsToday: 0, depegEventsYesterday: 1,
        pegData: [
          makeCachedPegCoin({ id: "usdt-tether", activeDepeg: true, pegReference: { valueUsd: 1, source: "median", contributorCount: 5, asOf: GENERATION - 60 } }),
          makeCachedPegCoin({ id: "usr-resolv", symbol: "USR", name: "Resolv USD", currentDeviationBps: -4_200, pegScore: 41, worstDeviationBps: -4_200, activeDepeg: true, pegReference: { valueUsd: 1, source: "median", contributorCount: 5, asOf: GENERATION - 60 } }),
        ],
      }), GENERATION);
      const body = PegSummaryResponseSchema.parse(await readJsonResponse(await handlePegSummary(db), 200));
      expect(body.coins.some((c) => c.id === "usr-resolv")).toBe(false);
      expect(body.coins.find((c) => c.id === "usdt-tether")?.listingClass).toBe("core-stablecoin");
      expect(body.coins.every((c) => c.listingClass != null && c.listingClass !== "excluded")).toBe(true);
      const census = selectActiveDepegCoins(body.coins, WORKER_ACTIVE_IDS).length;
      expect(census).toBe(1);
      expect(body.summary?.activeDepegCount).toBe(census);
    } finally { sqlite.close(); }
  });
});

describe("open-incident sidecar and live coverage overlay", () => {
  const NOW = 1_800_000_000;
  const DAY = 86_400;
  const [U, C, E] = ["usdt-tether", "usdc-circle", "eurc-circle"];
  const parsed = async (db: D1Database) => {
    const res = await handlePegSummary(db);
    return { res, body: PegSummaryResponseSchema.parse(await readJsonResponse(res, 200)) };
  };
  const covObj = (at = NOW - 60, kind: "trusted-off-peg" | "trusted-at-par" = "trusted-off-peg", gap: number | null = null) =>
    ({ lastObservationKind: kind, lastTrustedObservationAt: at, gapStartedAt: gap });
  const covRow = (id: number, coinId: string, extra: Record<string, unknown> = {}) => ({
    id, stablecoin_id: coinId,
    price_coverage_json: JSON.stringify({ intervals: [[NOW - 3600, NOW - 60]], lastObservationKind: "trusted-off-peg" }),
    last_trusted_price_at: NOW - 60, price_coverage_gap_started_at: null, ...extra,
  });

  function sidecarDb(opts: {
    pegData: PegSummaryCoin[];
    openIncidents?: Record<string, { eventId: number; startedAt: number; escalatedAt: number | null }>;
    coverageRows?: ReturnType<typeof covRow>[];
    coverageError?: Error;
  }) {
    const assets = opts.pegData.map((c) => makeAsset({ id: c.id, symbol: c.symbol, pegType: c.pegType, price: 0.96, priceObservedAt: NOW - 60 }));
    return mockD1([
      cacheTable("stablecoins", { peggedAssets: assets }, NOW),
      cacheTable("peg-analytics", { computedAtSec: NOW - 300, depegEventsToday: 1, depegEventsYesterday: 0, pegData: opts.pegData, ...(opts.openIncidents !== undefined ? { openIncidents: opts.openIncidents } : {}) }, NOW - 300),
      { match: "pharos:peg-summary:open-coverage", rows: opts.coverageRows ?? [], ...(opts.coverageError ? { throwError: opts.coverageError } : {}) },
      { match: "dex_prices", rows: [] }, { match: "pharos:peg-summary:recently-priced-ids", rows: [] },
    ]);
  }

  it("overlays live coverage matched by unique eventId, strips embedded referenceHold, and splits recent vs >30d", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const { res, body } = await parsed(sidecarDb({
      pegData: [
        makeCachedPegCoin({ id: U, symbol: "USDT", activeDepeg: true }),
        makeCachedPegCoin({ id: C, symbol: "USDC", name: "USD Coin", activeDepeg: true }),
        makeCachedPegCoin({ id: E, symbol: "EURC", name: "Euro Coin", pegType: "peggedEUR", pegCurrency: "EUR", activeDepeg: true }),
      ],
      openIncidents: {
        [U]: { eventId: 101, startedAt: NOW - 2 * DAY, escalatedAt: null },
        [C]: { eventId: 201, startedAt: NOW - 45 * DAY, escalatedAt: null },
        [E]: { eventId: 301, startedAt: NOW - 40 * DAY, escalatedAt: NOW - 2 * DAY },
      },
      coverageRows: [
        covRow(101, U, { price_coverage_json: JSON.stringify({ intervals: [[NOW - 3600, NOW - 60]], lastObservationKind: "trusted-off-peg", referenceHold: { reason: "reference-market-closed", declaredAtSec: NOW - 30, lastTrustedAtSec: NOW - 60, lastTrustedPeakBps: -400 } }) }),
        covRow(202, C), covRow(301, E), covRow(302, E),
      ],
    }));
    expect([res.headers.get("Warning"), res.headers.get("Cache-Control")?.includes("no-store"), body.openIncidentsAsOfSec]).toEqual([null, false, NOW]);
    expect(body.summary).toMatchObject({ activeDepegCount: 3, recentActiveDepegCount: 2, longRunningActiveDepegCount: 1 });
    expect(body.openIncidents).toEqual({
      [U]: { eventId: 101, startedAt: NOW - 2 * DAY, escalatedAt: null, coverage: covObj() },
      [C]: { eventId: 201, startedAt: NOW - 45 * DAY, escalatedAt: null, coverage: null },
      [E]: { eventId: 301, startedAt: NOW - 40 * DAY, escalatedAt: NOW - 2 * DAY, coverage: null },
    });
  });

  it("keeps split counts without Warning/no-store on coverage error or 201-row truncation, admits 200 rows, and ignores extra retired/NAV keys in retained sidecar", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pegData = [
      makeCachedPegCoin({ id: U, symbol: "USDT", activeDepeg: true }),
      makeCachedPegCoin({ id: "xgld-unitas", symbol: "xGLD", name: "Unitas Gold", pegType: "peggedVAR", pegCurrency: "VAR", activeDepeg: true }),
      makeCachedPegCoin({ id: "usr-resolv", symbol: "USR", name: "Resolv USD", activeDepeg: true }),
    ];
    const sidecar = {
      [U]: { eventId: 101, startedAt: NOW - 2 * DAY, escalatedAt: null },
      "usr-resolv": { eventId: 901, startedAt: NOW - 40 * DAY, escalatedAt: null },
      "xgld-unitas": { eventId: 902, startedAt: NOW - 5 * DAY, escalatedAt: null },
    };
    const { res: failRes, body: failBody } = await parsed(sidecarDb({ pegData, openIncidents: sidecar, coverageError: new Error("D1 coverage timeout") }));
    expect([failRes.headers.get("Warning"), failRes.headers.get("Cache-Control")?.includes("no-store")]).toEqual([null, false]);
    expect(failBody.summary).toMatchObject({ activeDepegCount: 1, recentActiveDepegCount: 1, longRunningActiveDepegCount: 0 });
    expect(failBody.openIncidents).toEqual({ [U]: { eventId: 101, startedAt: NOW - 2 * DAY, escalatedAt: null, coverage: null } });

    const mk = (i: number) => covRow(i === 0 ? 101 : 1000 + i, i === 0 ? U : `filler-${i}`);
    const one = { pegData: [pegData[0]], openIncidents: { [U]: sidecar[U] } };
    const { res: truncRes, body: truncBody } = await parsed(sidecarDb({ ...one, coverageRows: Array.from({ length: MAX_OPEN_DEPEG_EVENTS + 1 }, (_, i) => mk(i)) }));
    expect([truncRes.headers.get("Warning"), truncRes.headers.get("Cache-Control")?.includes("no-store")]).toEqual([null, false]);
    expect(truncBody.openIncidents?.[U]?.coverage).toBeNull();
    expect(truncBody.summary).toMatchObject({ recentActiveDepegCount: 1, longRunningActiveDepegCount: 0 });

    const { body: exactBody } = await parsed(sidecarDb({ ...one, coverageRows: Array.from({ length: MAX_OPEN_DEPEG_EVENTS }, (_, i) => mk(i)) }));
    expect(exactBody.openIncidents?.[U]?.coverage).toEqual(covObj());
    expect(warnSpy).toHaveBeenCalled();
  });

  it("omits split and openIncidents when sidecar is absent, inconsistent, or future-dated without mutating activeDepeg", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const pegData = [makeCachedPegCoin({ id: U, symbol: "USDT", activeDepeg: true }), makeCachedPegCoin({ id: C, symbol: "USDC", name: "USD Coin", activeDepeg: false })];
    for (const openIncidents of [
      undefined, {},
      { [U]: { eventId: 101, startedAt: NOW - DAY, escalatedAt: null }, [C]: { eventId: 201, startedAt: NOW - DAY, escalatedAt: null } },
      { [U]: { eventId: 101, startedAt: NOW + 60, escalatedAt: null } },
    ] as Array<Record<string, { eventId: number; startedAt: number; escalatedAt: number | null }> | undefined>) {
      const { body } = await parsed(sidecarDb({ pegData, openIncidents }));
      expect([coinOf(body, U)?.activeDepeg, body.summary?.activeDepegCount]).toEqual([true, 1]);
      for (const k of ["recentActiveDepegCount", "longRunningActiveDepegCount"]) expect(body.summary).not.toHaveProperty(k);
      for (const k of ["openIncidents", "openIncidentsAsOfSec"]) expect(body).not.toHaveProperty(k);
    }
  });

  it("matches direct-compute and cached coverage overlay parity across normal rows, duplicate physical fragments, and >200 open rows", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const first = NOW - 45 * DAY;
      const cur = NOW - 3600;
      const esc = NOW - 1800;
      const assets = [usdt({ price: 0.96, priceObservedAt: NOW - 60 }), makeAsset({ id: C, symbol: "USDC", price: 0.97, priceObservedAt: NOW - 60 })];
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({ peggedAssets: assets }), NOW);
      const ins = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, peg_reference, source, peak_escalated_at, price_coverage_json, last_trusted_price_at, price_coverage_gap_started_at) VALUES (?, ?, ?, 'peggedUSD', 'below', -400, ?, ?, 0.96, 0.96, 1, 'live', ?, ?, ?, ?)");
      ins.run(501, U, "USDT", first, cur - 300, null, null, null, null);
      ins.run(502, U, "USDT", cur, null, esc, JSON.stringify({ intervals: [[cur, NOW - 60]], lastObservationKind: "trusted-off-peg" }), NOW - 60, null);
      ins.run(601, C, "USDC", NOW - 40 * DAY, null, null, JSON.stringify({ intervals: [[NOW - 40 * DAY, NOW - 1800]], atParIntervals: [[NOW - 600, NOW - 60]], lastObservationKind: "trusted-at-par" }), NOW - 60, NOW - 600);
      const key = `ddr2:${"d".repeat(32)}`;
      sqlite.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, 501, 'observed', ?), (?, 502, 'observed', ?)").run(key, first, key, cur);
      sqlite.prepare("INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at) VALUES (?, 'usdt-tether', 'USD', 'below', 501, 502, ?, ?, 400, ?, ?, ?)").run(key, first, cur, "e".repeat(64), first, cur);

      const { body: direct } = await parsed(db);
      expect(direct.summary).toMatchObject({ activeDepegCount: 2, recentActiveDepegCount: 1, longRunningActiveDepegCount: 1 });
      expect(direct.openIncidents).toEqual({
        [U]: { eventId: 502, startedAt: first, escalatedAt: esc, coverage: covObj() },
        [C]: { eventId: 601, startedAt: NOW - 40 * DAY, escalatedAt: null, coverage: covObj(NOW - 60, "trusted-at-par", NOW - 600) },
      });

      const publish = async () => expect(await publishPegAnalyticsCache(db, await derivePegAnalyticsSnapshot(db, { peggedAssets: assets, methodologyAsOf: NOW, includeNavTokens: true }))).toBe(true);
      await publish();
      sqlite.prepare("UPDATE depeg_events SET last_trusted_price_at = ?, price_coverage_json = ? WHERE id = 502").run(NOW - 10, JSON.stringify({ intervals: [[cur, NOW - 10]], lastObservationKind: "trusted-off-peg" }));
      expect((await parsed(db)).body.openIncidents?.[U]?.coverage).toEqual(covObj(NOW - 10));

      ins.run(602, C, "USDC", NOW - 300, null, null, JSON.stringify({ intervals: [[NOW - 300, NOW - 60]], lastObservationKind: "trusted-off-peg" }), NOW - 60, null);
      sqlite.exec("DELETE FROM cache WHERE key = 'peg-analytics'");
      const { body: dupDirect } = await parsed(db);
      await publish();
      const { body: dupCached } = await parsed(db);
      expect([dupDirect.openIncidents?.[C]?.coverage, dupCached.openIncidents?.[C]?.coverage]).toEqual([null, null]);
      expect(dupDirect.openIncidents?.[U]?.coverage).toEqual(dupCached.openIncidents?.[U]?.coverage);

      for (let i = 0; i < MAX_OPEN_DEPEG_EVENTS; i++) ins.run(1000 + i, `filler-${i}`, `F${i}`, NOW - 600, null, null, null, null, null);
      sqlite.exec("DELETE FROM cache WHERE key = 'peg-analytics'");
      const { body: overDirect } = await parsed(db);
      await publish();
      const { body: overCached } = await parsed(db);
      for (const b of [overDirect, overCached]) {
        expect(b.summary?.activeDepegCount).toBe(2);
        expect(b.openIncidents).toBeUndefined();
        expect(b.summary?.recentActiveDepegCount).toBeUndefined();
        expect(b.summary?.longRunningActiveDepegCount).toBeUndefined();
      }
      // Malformed negative or fractional REAL peak_escalated_at on direct compute omits the split without failing schema validation.
      sqlite.exec("DELETE FROM depeg_events WHERE id >= 1000; DELETE FROM cache WHERE key = 'peg-analytics';");
      for (const badTs of [-1, NOW - 899.5]) {
        sqlite.prepare("UPDATE depeg_events SET peak_escalated_at = ? WHERE id = 502").run(badTs);
        const { body: badEsc } = await parsed(db);
        expect([badEsc.summary?.activeDepegCount, badEsc.openIncidents, badEsc.summary?.recentActiveDepegCount]).toEqual([2, undefined, undefined]);
      }
      // Cached boundary crossing: 40d escalating expiring in 60s + 1d recent reselects 1d at NOW + 120s;
      // 40d long-running + 30d-60s recent reselects older 40d (502) once both become long-running at NOW + 120s.
      sqlite.prepare("UPDATE depeg_events SET peak_escalated_at = ? WHERE id = 502").run(NOW - 7 * DAY + 60);
      ins.run(503, U, "USDT", NOW - DAY, null, null, null, null, null);
      await publish();
      expect((await parsed(db)).body.openIncidents?.[U]?.eventId).toBe(502);
      vi.setSystemTime((NOW + 120) * 1000);
      expect((await parsed(db)).body.openIncidents?.[U]?.eventId).toBe(503);
      vi.setSystemTime(NOW * 1000);
      sqlite.prepare("UPDATE depeg_events SET peak_escalated_at = NULL WHERE id = 502").run();
      sqlite.prepare("UPDATE depeg_events SET started_at = ? WHERE id = 503").run(NOW - 30 * DAY + 60);
      await publish();
      expect((await parsed(db)).body.openIncidents?.[U]?.eventId).toBe(503);
      vi.setSystemTime((NOW + 120) * 1000);
      expect((await parsed(db)).body.openIncidents?.[U]?.eventId).toBe(502);
    } finally { sqlite.close(); }
  });
});
