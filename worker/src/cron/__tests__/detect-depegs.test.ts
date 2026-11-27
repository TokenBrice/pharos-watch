import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { createMockD1Preset } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { seedOpenEvent, seedDexEvidence } from "./detect-depegs.test-support";

const sqliteFixtures = createLatestSchemaFixtureTracker();
const mockD1 = createMockD1Preset([
  { match: "FROM cache WHERE key IN", rows: [] },
  { match: "FROM dex_price_challenger_snapshots", rows: [] },
  { match: "FROM dex_price_challengers", rows: [] },
  { match: "SELECT stablecoin_id, top_pools_json", rows: [] },
  { match: "INSERT INTO depeg_pending", rows: [] },
]);

vi.mock("@shared/lib/psi-eligible", () => {
  const list = [
    { id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false, pegCurrency: "USD" }, commodityOunces: undefined },
    { id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false, pegCurrency: "USD" }, commodityOunces: undefined },
    { id: "susd-solayer", symbol: "sUSD", pegType: "peggedUSD", flags: { navToken: false, pegCurrency: "USD" } },
    { id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false, pegCurrency: "EUR" }, commodityOunces: undefined },
    { id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", geckoId: "brz", flags: { navToken: false, pegCurrency: "BRL" }, commodityOunces: undefined },
    { id: "a7a5-old-vector", symbol: "A7A5", pegType: "peggedRUB", geckoId: "a7a5", flags: { navToken: false, pegCurrency: "RUB" }, commodityOunces: undefined },
    { id: "nav-token-test", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true, pegCurrency: "USD" }, commodityOunces: undefined },
    { id: "iron-historical", symbol: "IRON", pegType: "peggedUSD", geckoId: "iron-stablecoin", flags: { navToken: false, pegCurrency: "USD" }, commodityOunces: undefined },
  ];
  return {
    PSI_ELIGIBLE_STABLECOINS: list,
    PSI_ELIGIBLE_META_BY_ID: new Map(list.map((c) => [c.id, c])),
    PSI_HISTORICAL_IDS: new Set(["iron-historical"]),
  };
});

vi.mock("@shared/lib/peg-rates", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shared/lib/peg-rates")>(),
  derivePegRates: (_assets: unknown, _metaById: unknown, fxFallbackRates?: Record<string, number>) => ({
    rates: {
      peggedUSD: 1,
      peggedEUR: fxFallbackRates?.peggedEUR ?? 1.08,
      peggedREAL: fxFallbackRates?.peggedREAL ?? 0.18765951,
      ...(fxFallbackRates?.peggedRUB ? { peggedRUB: fxFallbackRates.peggedRUB } : {}),
    },
    sources: { peggedUSD: "median", peggedEUR: fxFallbackRates?.peggedEUR ? "fx" : "median", peggedREAL: fxFallbackRates?.peggedREAL ? "fx" : "median", peggedRUB: fxFallbackRates?.peggedRUB ? "fallback" : "median" },
    counts: { peggedUSD: 4, peggedEUR: 4, peggedREAL: 2, peggedRUB: 1 },
  }),
  getPegReference: (pegType: string, rates: Record<string, number>) => rates[pegType] ?? 1,
  normalizePegType: (pegType: string | undefined) => pegType,
}));

vi.mock("../../lib/native-peg-quotes", () => ({ fetchCurrentNativePegQuotes: vi.fn(async () => new Map()) }));

import { detectDepegEvents } from "../detect-depegs";
import { referenceState, tradedPair } from "../depeg-detection/__tests__/reference-fixtures";
import { persistFxRateState } from "../../lib/fx-rate-state";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import { rowToDepegEvent, type DepegRow } from "../../lib/depeg-helpers";
import { mergeDepegSeconds, mergeUnknownDepegSeconds } from "@shared/lib/peg-utils";

const isCloseEventUpdate = (sql: string) => sql.startsWith("UPDATE depeg_events SET ended_at = ?, recovery_price = ?, close_reason = ?");
const nowSec = () => Math.floor(Date.now() / 1000);

function trackPrepare(db: D1Database): string[] {
  const sqls: string[] = [];
  const orig = db.prepare.bind(db);
  db.prepare = vi.fn((sql: string) => { sqls.push(sql); return orig(sql); }) as typeof db.prepare;
  return sqls;
}

const openRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below",
  peak_deviation_bps: -220, started_at: nowSec() - 3600, start_price: 0.978, peak_price: 0.978,
  peg_reference: 1, recovery_price: null, ended_at: null, source: "live", ...overrides,
});

const dexRow = (price: number, sources: Array<{ protocol: string; price: number; tvl: number; chain?: string }>, extra: Record<string, unknown> = {}) => {
  const at = nowSec() - 60;
  return {
    stablecoin_id: "usdt-tether", dex_price_usd: price, deviation_from_primary_bps: 0, source_pool_count: 5,
    source_total_tvl: 5_000_000, updated_at: at,
    price_sources_json: JSON.stringify(sources.map((s) => ({ chain: "ethereum", ...s, sourceFamily: s.protocol, observedAt: at, aggregateObservedAt: at }))),
    ...extra,
  };
};

function makeAsset(overrides: {
  id: string; symbol: string; price: number | null; pegType?: string; circulating?: Record<string, number>;
  priceSource?: string; priceConfidence?: "high" | "single-source" | "low" | "fallback";
  priceUpdatedAt?: number; priceObservedAt?: number | null; priceObservedAtMode?: "upstream" | "local_fetch" | "unknown" | null;
  agreeSources?: string[];
}) {
  return {
    id: overrides.id, symbol: overrides.symbol, price: overrides.price,
    priceSource: overrides.priceSource ?? "pyth", priceConfidence: overrides.priceConfidence ?? "single-source",
    priceUpdatedAt: overrides.priceUpdatedAt ?? nowSec(),
    priceObservedAt: "priceObservedAt" in overrides ? overrides.priceObservedAt : nowSec() - 60,
    priceObservedAtMode: overrides.priceObservedAtMode, agreeSources: overrides.agreeSources,
    pegType: overrides.pegType ?? "peggedUSD", circulating: overrides.circulating ?? { ethereum: 50_000_000 },
  };
}

const usdt = (price: number | null, extra: Partial<Parameters<typeof makeAsset>[0]> = {}) =>
  makeAsset({ id: "usdt-tether", symbol: "USDT", price, ...extra });
const usdc = (price: number | null, extra: Partial<Parameters<typeof makeAsset>[0]> = {}) =>
  makeAsset({ id: "usdc-circle", symbol: "USDC", price, ...extra });
const eurc = (price: number | null, extra: Partial<Parameters<typeof makeAsset>[0]> = {}) =>
  makeAsset({ id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", price, ...extra });
const brz = (price: number | null, extra: Partial<Parameters<typeof makeAsset>[0]> = {}) =>
  makeAsset({ id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", price, ...extra });
const a7a5 = (price: number | null, extra: Partial<Parameters<typeof makeAsset>[0]> = {}) =>
  makeAsset({ id: "a7a5-old-vector", symbol: "A7A5", pegType: "peggedRUB", price, ...extra });
const qAll = (s: ReturnType<typeof sqliteFixtures.open>["sqlite"], sql: string) => s.prepare(sql).all();

describe("detectDepegEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-18T12:00:00Z"));
    vi.mocked(fetchCurrentNativePegQuotes).mockReset().mockResolvedValue(new Map());
  });
  afterEach(() => { vi.useRealTimers(); sqliteFixtures.closeAll(); vi.restoreAllMocks(); });

  it("persists the existing native hydration quote for an active event without fetching again", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = nowSec();
    seedOpenEvent(sqlite, { id: 90738, stablecoin_id: "eurc-circle", symbol: "EURC", peg_type: "peggedEUR", started_at: now - 77 * 86400 });
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValueOnce(new Map([["eurc-circle", { stablecoinId: "eurc-circle", geckoId: "euro-coin", pegCurrency: "EUR", vsCurrency: "eur", price: 0.98, updatedAt: now - 60 }]]));
    await detectDepegEvents(db, [makeAsset({ id: "eurc-circle", symbol: "EURC", pegType: "peggedEUR", price: 1.0584, priceConfidence: "high" })]);
    expect(fetchCurrentNativePegQuotes).toHaveBeenCalledTimes(1);
    const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get("depeg-native-indicative:v1:90738") as { value: string; updated_at: number };
    expect(JSON.parse(row.value)).toEqual({ value: 0.98, observedAt: now - 60, source: "coingecko" });
    expect(row.updated_at).toBe(now - 60);
  });

  it("records a sticky coverage gap for an omitted asset without closing its incident", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = nowSec();
    seedOpenEvent(sqlite, { price_coverage_json: JSON.stringify({ intervals: [[now - 900, now]] }), last_trusted_price_at: now });
    for (const off of [900, 3600]) { vi.setSystemTime((now + off) * 1000); await detectDepegEvents(db, []); }
    const event = rowToDepegEvent(sqlite.prepare("SELECT * FROM depeg_events WHERE id = 1").get() as unknown as DepegRow);
    expect(event.endedAt).toBeNull();
    expect(event.priceCoverage).toMatchObject({ lastTrustedObservationAt: now, gapStartedAt: now + 900 });
    expect([mergeDepegSeconds([event], now - 3600, now + 3600), mergeUnknownDepegSeconds([event], now - 3600, now + 3600)]).toEqual([900, 6300]);
  });

  it.each(["invalid-json", '{"intervals":[[200,100]]}'])("continues processing healthy events when another row has malformed coverage: %s", async (malformed) => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = nowSec();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedOpenEvent(sqlite, { price_coverage_json: malformed });
    seedOpenEvent(sqlite, { id: 2, stablecoin_id: "usdc-circle", symbol: "USDC", price_coverage_json: JSON.stringify({ intervals: [[now - 900, now - 900]], lastObservationKind: "trusted-off-peg" }), last_trusted_price_at: now - 900 });
    await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: null }), makeAsset({ id: "usdc-circle", symbol: "USDC", price: 0.96 })]);
    const events = (sqlite.prepare("SELECT * FROM depeg_events ORDER BY id").all() as unknown as DepegRow[]).map(rowToDepegEvent);
    expect([events[0]!.endedAt, mergeDepegSeconds([events[0]!], now - 3600, now), events[1]!.peakDeviationBps, mergeDepegSeconds([events[1]!], now - 3600, now)]).toEqual([null, 0, -400, 900]);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))).some((r) => r.level === "warn" && r.metadata?.eventId === 1)).toBe(true);
  });

  it("aborts cleanly on cancellation and stops before orphan cleanup on persistence failure", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedOpenEvent(sqlite);
    seedOpenEvent(sqlite, { id: 2, started_at: nowSec() - 7200 });
    const controller = new AbortController();
    const reason = new Error("cancel hydration");
    vi.mocked(fetchCurrentNativePegQuotes).mockImplementationOnce(async () => { controller.abort(reason); return new Map(); });
    await expect(detectDepegEvents(db, [usdt(0.96)], undefined, controller.signal)).rejects.toBe(reason);
    expect(qAll(sqlite, "SELECT id, peak_deviation_bps FROM depeg_events ORDER BY id")).toEqual([{ id: 1, peak_deviation_bps: -200 }, { id: 2, peak_deviation_bps: -200 }]);
    expect(qAll(sqlite, "SELECT * FROM depeg_pending")).toEqual([]);

    const { sqlite: s2, db: db2 } = sqliteFixtures.open();
    seedOpenEvent(s2);
    seedOpenEvent(s2, { id: 99, stablecoin_id: "removed-coin" });
    s2.exec("CREATE TRIGGER fail_peak BEFORE UPDATE OF peak_deviation_bps ON depeg_events BEGIN SELECT RAISE(ABORT, 'peak write failed'); END");
    await expect(detectDepegEvents(db2, [usdt(0.96)])).rejects.toThrow("peak write failed");
    expect(qAll(s2, "SELECT id, peak_deviation_bps, ended_at FROM depeg_events ORDER BY id")).toEqual([
      { id: 1, peak_deviation_bps: -200, ended_at: null }, { id: 99, peak_deviation_bps: -200, ended_at: null },
    ]);
  });

  it("emits degraded warnings when hydration or orphan-cleanup open-event queries reach the cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db1 = mockD1([{ match: "depeg_events", rows: Array.from({ length: 200 }, (_, id) => openRow({ id, stablecoin_id: `open-${id}`, symbol: `OPEN${id}`, started_at: 1_700_000_000, recovery_first_seen_at: null })) }, { match: "dex_prices", rows: [] }]);
    const sqls1 = trackPrepare(db1);
    await detectDepegEvents(db1, [usdt(0.98)]);
    expect(sqls1.some((s) => s.includes("INSERT INTO depeg_pending"))).toBe(false);
    expect(warnSpy.mock.calls.map(([m]) => String(m))).toContainEqual(expect.stringContaining('"event":"depeg_open_event_limit_reached"'));

    const db2 = mockD1([{ match: "SELECT open_event.*", rows: [] }, { match: "SELECT id, stablecoin_id, started_at FROM depeg_events", rows: Array.from({ length: 200 }, (_, id) => ({ id, stablecoin_id: `orphan-${id}`, started_at: 1_700_000_000 })) }, { match: "dex_prices", rows: [] }]);
    const sqls2 = trackPrepare(db2);
    await detectDepegEvents(db2, [usdt(1.001)]);
    expect(sqls2.some((s) => s.includes("UPDATE depeg_events SET ended_at"))).toBe(false);
    expect(warnSpy.mock.calls.map(([m]) => String(m))).toContainEqual(expect.stringContaining('"pass":"orphan-cleanup"'));
  });

  it("creates no rows for stable/NAV/invalid prices and builds accurate census across failure modes and historical members", async () => {
    const { sqlite: s0, db: db0 } = sqliteFixtures.open();
    await detectDepegEvents(db0, [usdt(1.001), usdc(0.999), makeAsset({ id: "nav-token-test", symbol: "NAVT", price: 0.5 }), eurc(null), brz(NaN), a7a5(0)]);
    expect([qAll(s0, "SELECT * FROM depeg_pending"), qAll(s0, "SELECT * FROM depeg_events")]).toEqual([[], []]);

    const { sqlite, db } = sqliteFixtures.open();
    const now = nowSec();
    seedOpenEvent(sqlite, { id: 7, stablecoin_id: "eurc-circle", symbol: "EUROC", peg_type: "peggedEUR", peg_reference: 1.08, source: "backfill" });
    const lifecycle = "SELECT id, ended_at, peak_deviation_bps, peak_price, recovery_price, close_reason FROM depeg_events ORDER BY id";
    const before = qAll(sqlite, lifecycle);
    const result = await detectDepegEvents(db, [
      usdt(1.001), usdt(null), usdc(null),
      makeAsset({ id: "susd-solayer", symbol: "sUSD", price: 1.1814, priceSource: "protocol-redeem", priceObservedAtMode: "upstream", circulating: { solana: 730_000 } }),
      eurc(1.08, { circulating: {} }), brz(0.1876, { circulating: { ethereum: 0 } }),
      makeAsset({ id: "nav-token-test", symbol: "NAVT", price: 0.5 }), makeAsset({ id: "untracked-coin", symbol: "UNT", price: 0.5 }),
    ]);
    expect(result).toEqual({
      status: "completed",
      census: {
        scope: "psi-non-nav-before-supply-floor", evaluatedAt: now, eligibleCount: 6, observedCount: 1, unavailableCount: 4, belowFloorCount: 1,
        reasonCounts: { "primary-unusable": 2, "supply-unavailable": 1, "asset-absent": 1 }, unavailableIdsTruncated: false,
        unavailableAssets: [
          { id: "usdc-circle", reason: "primary-unusable", reviewedNominalReference: false },
          { id: "susd-solayer", reason: "primary-unusable", reviewedNominalReference: false, observedNonParityProtocolRedeem: true },
        ],
      },
    });
    expect(qAll(sqlite, lifecycle)).toEqual(before);
    expect(qAll(sqlite, "SELECT * FROM depeg_pending")).toEqual([]);

    for (const invalid of [{ priceObservedAt: undefined }, { price: null }]) {
      const mark = makeAsset({ id: "susd-solayer", symbol: "sUSD", price: 1.1814, priceSource: "protocol-redeem", priceObservedAtMode: "upstream" });
      const res = await detectDepegEvents(sqliteFixtures.open().db, [{ ...mark, ...invalid } as ReturnType<typeof makeAsset>, mark]);
      expect(res.status === "completed" ? res.census.unavailableAssets : null).toEqual([{ id: "susd-solayer", reason: "primary-unusable", reviewedNominalReference: false }]);
    }

    const { sqlite: sG, db: dbG } = sqliteFixtures.open();
    seedOpenEvent(sG, { id: 8, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 1, start_price: 0.97, peak_price: 0.97, peak_deviation_bps: -300 });
    const gaps = await detectDepegEvents(dbG, [brz(0.1876), a7a5(0.02)], { peggedREAL: 0.18765951 });
    expect(gaps.status === "completed" ? gaps.census.reasonCounts : null).toEqual({ "native-quote-unavailable": 1, "non-authoritative-reference": 1, "asset-absent": 4 });
    expect(await detectDepegEvents(sqliteFixtures.open().db, [])).toMatchObject({
      status: "completed", census: { eligibleCount: 6, observedCount: 0, belowFloorCount: 0, unavailableCount: 6, reasonCounts: { "asset-absent": 6 } },
    });

    for (const reviewed of [true, false]) {
      const ref = { price: 1, source: "protocol-par", mode: "nominal_reference" as const };
      const res = await detectDepegEvents(sqliteFixtures.open().db, [{ ...usdc(1, { priceSource: "protocol-par" }), ...(reviewed ? { nominalPriceReference: ref } : {}) }]);
      expect(res.census?.unavailableAssets).toContainEqual({ id: "usdc-circle", reason: "primary-unusable", reviewedNominalReference: reviewed });
    }

    const active = () => [usdt(1), usdc(1), { ...makeAsset({ id: "susd-solayer", symbol: "sUSD", price: 1 }), parityQuoteUnit: "accrued-token" as const }, eurc(1.08), brz(0.18765951), a7a5(0.02)];
    const censusOf = async (assets: ReturnType<typeof makeAsset>[]) => {
      const r = await detectDepegEvents(sqliteFixtures.open().db, assets);
      if (r.status !== "completed") throw new Error("Expected completed");
      return r.census;
    };
    const complete = await censusOf(active());
    expect([complete.eligibleCount, complete.reasonCounts["asset-absent"]]).toEqual([6, undefined]);
    const withHist = await censusOf([...active(), makeAsset({ id: "iron-historical", symbol: "IRON", price: 1 })]);
    expect([withHist.eligibleCount, withHist.observedCount]).toEqual([7, complete.observedCount + 1]);
    const missing = await censusOf(active().slice(1));
    expect([missing.eligibleCount, missing.reasonCounts["asset-absent"], missing.unavailableCount]).toEqual([6, 1, complete.unavailableCount + 1]);
  });

  it.each([
    ["usdt-tether", "USDT", "peggedUSD", 1, 99, false], ["usdt-tether", "USDT", "peggedUSD", 1, 100, true],
    ["eurc-circle", "EUROC", "peggedEUR", 1.08, 149, false], ["eurc-circle", "EUROC", "peggedEUR", 1.08, 150, true],
  ] as const)("routes %s at %i reference and %i bps to pending=%s", async (id, symbol, pegType, reference, bps, pending) => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = nowSec();
    const fx = referenceState({ peggedEUR: 1.08 }, now - 60);
    await persistFxRateState(db, fx.rates, fx, now - 60);
    await detectDepegEvents(db, [makeAsset({ id, symbol, pegType, price: reference * (1 - bps / 10000), priceObservedAtMode: "upstream", priceObservedAt: now - 30 })], { peggedEUR: 1.08 });
    expect(qAll(sqlite, "SELECT stablecoin_id, direction, ROUND(first_seen_bps) AS first_seen_bps FROM depeg_pending"))
      .toEqual(pending ? [{ stablecoin_id: id, direction: "below", first_seen_bps: -bps }] : []);
    expect(qAll(sqlite, "SELECT * FROM depeg_events")).toEqual([]);
  });

  it("persists peak updates, sustained recovery, legacy DEX veto, direction flips, duplicate merges, supply floor, and extreme pending", async () => {
    const now = nowSec();
    const { sqlite: s1, db: db1 } = sqliteFixtures.open();
    seedOpenEvent(s1, { started_at: now - 600 });
    await detectDepegEvents(db1, [usdt(0.96)]);
    expect(qAll(s1, "SELECT id, started_at, start_price, peak_deviation_bps, peak_price, ended_at FROM depeg_events"))
      .toEqual([{ id: 1, started_at: now - 600, start_price: 0.98, peak_deviation_bps: -400, peak_price: 0.96, ended_at: null }]);

    const { sqlite: s2, db: db2 } = sqliteFixtures.open();
    seedOpenEvent(s2, { recovery_first_seen_at: now - 900, recovery_last_seen_at: now - 900 });
    await detectDepegEvents(db2, [usdt(1.001)]);
    expect(qAll(s2, "SELECT id, ended_at, recovery_price, recovery_first_seen_at FROM depeg_events"))
      .toEqual([{ id: 1, ended_at: now, recovery_price: 1.001, recovery_first_seen_at: null }]);

    const { sqlite: s3, db: db3 } = sqliteFixtures.open();
    seedOpenEvent(s3, { recovery_first_seen_at: now - 900, recovery_last_seen_at: now - 900 });
    const sources = ["curve", "balancer"].map((protocol) => ({ protocol, chain: "ethereum", price: 0.92, tvl: 2e6 }));
    seedDexEvidence(s3, 1, sources);
    s3.prepare("UPDATE dex_prices SET price_sources_json = ?").run(JSON.stringify({ aggregateObservedAt: now - DEX_FRESHNESS_SEC, sources }));
    await detectDepegEvents(db3, [usdt(1)]);
    expect(s3.prepare("SELECT ended_at, recovery_first_seen_at FROM depeg_events").get()).toEqual({ ended_at: null, recovery_first_seen_at: null });

    const { sqlite: s4, db: db4 } = sqliteFixtures.open();
    seedOpenEvent(s4);
    await detectDepegEvents(db4, [usdt(1.02)]);
    expect(qAll(s4, "SELECT id, direction, ended_at, recovery_price, close_reason FROM depeg_events"))
      .toEqual([{ id: 1, direction: "below", ended_at: now, recovery_price: null, close_reason: "superseded-direction" }]);
    expect(qAll(s4, "SELECT stablecoin_id, direction, first_price FROM depeg_pending"))
      .toEqual([{ stablecoin_id: "usdt-tether", direction: "above", first_price: 1.02 }]);

    const { sqlite: s5, db: db5 } = sqliteFixtures.open();
    seedOpenEvent(s5, { id: 2, started_at: now - 3600, peak_deviation_bps: -300, peak_price: 0.97 });
    seedOpenEvent(s5, { id: 7, started_at: now - 7200, start_price: 0.985, peak_deviation_bps: -150, peak_price: 0.985 });
    await detectDepegEvents(db5, [usdt(0.98)]);
    expect(qAll(s5, "SELECT id, started_at, start_price, peak_deviation_bps, peak_price, ended_at FROM depeg_events"))
      .toEqual([{ id: 7, started_at: now - 7200, start_price: 0.985, peak_deviation_bps: -300, peak_price: 0.97, ended_at: null }]);

    for (const [circulating, closed] of [[{}, false], [{ ethereum: 0 }, true]] as const) {
      const { sqlite, db } = sqliteFixtures.open();
      seedOpenEvent(sqlite);
      await detectDepegEvents(db, [usdt(0.9, { circulating })]);
      expect(qAll(sqlite, "SELECT id, ended_at, recovery_price, close_reason FROM depeg_events"))
        .toEqual([closed ? { id: 1, ended_at: now, recovery_price: null, close_reason: "coverage-lost-supply" } : { id: 1, ended_at: null, recovery_price: null, close_reason: null }]);
    }

    for (const [price, direction] of [[5, "above"], [0.01, "below"]] as const) {
      const { sqlite, db } = sqliteFixtures.open();
      await detectDepegEvents(db, [usdt(price)]);
      expect(qAll(sqlite, "SELECT stablecoin_id, direction, first_price FROM depeg_pending")).toEqual([{ stablecoin_id: "usdt-tether", direction, first_price: price }]);
      expect(qAll(sqlite, "SELECT * FROM depeg_events")).toEqual([]);
    }

    const { sqlite: s6, db: db6 } = sqliteFixtures.open();
    seedOpenEvent(s6, { recovery_first_seen_at: now - 960, recovery_last_seen_at: now - 960, recovery_evidence_source: "dex" });
    seedDexEvidence(s6, 0.9998, [{ protocol: "fluid", price: 0.9997, tvl: 900_000 }, { protocol: "balancer", price: 1.0001, tvl: 700_000 }, { protocol: "curve", price: 0.9999, tvl: 300_000 }]);
    await detectDepegEvents(db6, [usdt(0.9999, { priceSource: "cached", priceConfidence: "fallback", priceUpdatedAt: now - 600 })]);
    expect(qAll(s6, "SELECT id, ended_at, recovery_price, close_reason FROM depeg_events")).toEqual([{ id: 1, ended_at: now, recovery_price: 0.9998, close_reason: "recovered-dex" }]);
  });

  it("handles mockD1 primary/DEX corroboration, vetoes, low-cap, RUB fail-closed, native BRL recovery, and orphan cleanup", async () => {
    const now = nowSec();
    const runMock = async (rows: Record<string, unknown>[], dex: Record<string, unknown>[], assets: ReturnType<typeof makeAsset>[], fx?: Record<string, number>) => {
      const db = mockD1([{ match: "depeg_events", rows }, { match: "dex_prices", rows: dex }]);
      const sqls = trackPrepare(db);
      await detectDepegEvents(db, assets, fx);
      return { db, sqls };
    };
    const hasSql = (sqls: string[], sub: string) => sqls.some((s) => s.includes(sub));

    const r1 = await runMock([openRow({ recovery_first_seen_at: now - 900, recovery_last_seen_at: now - 900 })], [], [usdt(0.9992, { priceSource: "coingecko+defillama-list", priceConfidence: "high", priceObservedAtMode: "unknown", agreeSources: ["coingecko", "defillama-list"] })]);
    expect(hasSql(r1.sqls, "UPDATE depeg_events SET ended_at")).toBe(true);

    const above = [openRow({ direction: "above", peak_deviation_bps: 220, start_price: 1.022, peak_price: 1.022 })];
    const r2 = await runMock(above, [], [usdt(0.55, { priceSource: "coingecko", priceConfidence: "low" })]);
    expect(["UPDATE depeg_events SET ended_at", "INSERT INTO depeg_pending", "INSERT INTO depeg_events"].some((q) => hasSql(r2.sqls, q))).toBe(false);
    const r3 = await runMock(above, [dexRow(0.55, [{ protocol: "curve", price: 0.55, tvl: 3e6 }, { protocol: "uniswap", price: 0.551, tvl: 2e6 }])], [usdt(0.55, { priceSource: "coingecko", priceConfidence: "low" })]);
    expect(["UPDATE depeg_events SET ended_at", "INSERT INTO depeg_pending", "INSERT INTO depeg_events"].map((q) => hasSql(r3.sqls, q))).toEqual([true, true, false]);

    for (const assets of [[usdc(0.9, { circulating: { ethereum: 500_000 } })], [a7a5(0.02)]]) {
      const r = await runMock([], [], assets);
      expect(hasSql(r.sqls, "INSERT INTO depeg_events") || hasSql(r.sqls, "INSERT INTO depeg_pending")).toBe(false);
    }
    expect(hasSql((await runMock([], [{ stablecoin_id: "usdt-tether", dex_price_usd: 1.0005, deviation_from_primary_bps: 5, source_pool_count: 1, source_total_tvl: 250_000, updated_at: now - 60 }], [usdt(0.98)])).sqls, "INSERT INTO depeg_pending")).toBe(true);
    const rCached = await runMock([], [], [usdt(0.98, { priceSource: "cached", priceConfidence: "fallback", priceUpdatedAt: now - 600 })]);
    expect([hasSql(rCached.sqls, "INSERT INTO depeg_events"), hasSql(rCached.sqls, "INSERT INTO depeg_pending")]).toEqual([false, true]);

    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValueOnce(new Map([["brz-transfero", { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: 0.995, updatedAt: now - 60, derivation: tradedPair }]]));
    const rBrl = await runMock([openRow({ stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above", peak_deviation_bps: 180, start_price: 0.1909, peak_price: 0.191, recovery_first_seen_at: now - 900, recovery_last_seen_at: now - 900 })], [], [brz(0.190587)], { peggedREAL: 0.18765951 });
    expect([rBrl.sqls.some(isCloseEventUpdate), hasSql(rBrl.sqls, "SET recovery_first_seen_at = ?")]).toEqual([false, true]);

    expect(hasSql((await runMock([openRow({ peak_deviation_bps: -4000, start_price: 0.6, peak_price: 0.6 })], [{ stablecoin_id: "usdt-tether", dex_price_usd: 0.3, deviation_from_primary_bps: 0, source_pool_count: 4, source_total_tvl: 5e6, updated_at: now - 60 }], [usdt(0.3)])).sqls, "UPDATE depeg_events SET peak_deviation_bps")).toBe(true);
    const rLowPeak = await runMock([openRow({ peak_deviation_bps: -200, start_price: 0.98, peak_price: 0.98 })],
      [dexRow(0.985, [{ protocol: "curve", price: 0.985, tvl: 2e6 }, { protocol: "uniswap", price: 0.9845, tvl: 2e6 }], { deviation_from_primary_bps: 240, source_pool_count: 4, source_total_tvl: 4e6 })],
      [usdt(0.97, { priceSource: "coingecko", priceConfidence: "low" })]);
    expect(rLowPeak.db.getHistory().find((e) => e.sql.startsWith("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ?"))?.binds).toEqual([-300, 0.97, 1, "usd", null, null, 1]);

    const oneNearDex = dexRow(0.9993, [{ protocol: "bunni-ethereum", price: 0.9993, tvl: 1_451_774 }, { protocol: "uniswap-v4-ethereum", price: 0.31388474, tvl: 627_528 }, { protocol: "curve", price: 0.111775, tvl: 64_711 }], { deviation_from_primary_bps: 5, source_pool_count: 6, source_total_tvl: 2_143_513 });
    expect(hasSql((await runMock([openRow({ peak_deviation_bps: -8800, started_at: now - 7200, start_price: 0.12, peak_price: 0.11 })], [oneNearDex], [usdt(1.0001, { priceSource: "cached", priceConfidence: "fallback", priceUpdatedAt: now - 600 })])).sqls, "UPDATE depeg_events SET ended_at")).toBe(false);
    expect(hasSql((await runMock([], [oneNearDex], [usdt(0.98)])).sqls, "INSERT INTO depeg_pending")).toBe(true);

    const contraDex = dexRow(0.9439, [{ protocol: "curve", price: 0.9438, tvl: 11e6 }, { protocol: "pancakeswap", chain: "bsc", price: 0.9461, tvl: 5e6 }, { protocol: "uniswap-v4", price: 0.9442, tvl: 3e6 }], { deviation_from_primary_bps: -566, source_pool_count: 6, source_total_tvl: 19_900_000 });
    expect(hasSql((await runMock([openRow({ peak_deviation_bps: -1059, started_at: now - 10 * 86400, start_price: 0.989, peak_price: 0.894 })], [contraDex], [usdt(1.0006, { priceSource: "coingecko", priceConfidence: "high", priceUpdatedAt: now - 60 })])).sqls, "UPDATE depeg_events SET ended_at")).toBe(false);

    expect((await runMock([openRow({ peak_deviation_bps: -240, started_at: now - 7200 })], [], [usdt(Number.NaN, { priceSource: "defillama", circulating: { ethereum: 10e6 } })])).sqls.filter(isCloseEventUpdate)).toHaveLength(0);
    expect((await runMock([openRow({ peak_deviation_bps: -240, started_at: now - 7200 })], [], [usdc(1)])).db.getHistory().filter((e) => isCloseEventUpdate(e.sql))).toHaveLength(0);
    const rOrphan = await runMock([openRow({ id: 99, stablecoin_id: "removed-coin", symbol: "OLD", peak_deviation_bps: -240, started_at: now - 7200 })], [], [usdc(1)]);
    expect(rOrphan.db.getHistory().find((e) => isCloseEventUpdate(e.sql))?.binds).toEqual([now, null, "orphan-tracking-removed", null, 99]);
  });

  describe("long-running (>30d) re-escalation", () => {
    const D = 86_400;
    const readEsc = (s: ReturnType<typeof sqliteFixtures.open>["sqlite"], id = 1) =>
      s.prepare("SELECT peak_deviation_bps, peak_escalated_at, peak_escalation_anchor_bps, peak_escalation_candidate_at, peak_escalation_candidate_seen_at FROM depeg_events WHERE id = ?").get(id);
    const esc = (bps: number, escAt: number | null, anchor: number | null, cand: number | null = null, seen: number | null = cand) =>
      ({ peak_deviation_bps: bps, peak_escalated_at: escAt, peak_escalation_anchor_bps: anchor, peak_escalation_candidate_at: cand, peak_escalation_candidate_seen_at: seen });
    const auth = (t: number, price: number, ov: Partial<Parameters<typeof makeAsset>[0]> = {}) =>
      usdt(price, { priceUpdatedAt: t - 30, priceObservedAt: t - 30, priceObservedAtMode: "upstream", ...ov });
    const runAt = async (db: D1Database, t: number, assets: ReturnType<typeof makeAsset>[], fx?: Record<string, number>) => {
      vi.setSystemTime(t * 1000);
      await detectDepegEvents(db, assets, fx);
    };

    it("never arms Days 0-30, seeds >30d anchor, and confirms consecutive qualifying ticks spanning >=15m", async () => {
      const { sqlite, db } = sqliteFixtures.open();
      const t0 = nowSec();
      seedOpenEvent(sqlite, { started_at: t0 - 28 * D, peak_deviation_bps: -300, peak_price: 0.97 });
      await runAt(db, t0, [auth(t0, 0.8)]);
      await runAt(db, t0 + 1_200, [auth(t0 + 1_200, 0.8)]);
      expect(readEsc(sqlite)).toEqual(esc(-2_000, null, null));
      await runAt(db, t0 + 2 * D, [auth(t0 + 2 * D, 0.75)]);
      expect(readEsc(sqlite)).toEqual(esc(-2_500, null, null));

      const { sqlite: s2, db: db2 } = sqliteFixtures.open();
      seedOpenEvent(s2, { started_at: t0 - 31 * D, peak_deviation_bps: -1_500, peak_price: 0.85 });
      await runAt(db2, t0, [auth(t0, 0.96)]);
      expect(readEsc(s2)).toEqual(esc(-1_500, null, 400));
      const d1 = t0 + 900;
      await runAt(db2, d1, [auth(d1, 0.935)]);
      expect(readEsc(s2)).toMatchObject({ peak_escalated_at: null, peak_escalation_candidate_at: d1 - 30, peak_escalation_candidate_seen_at: d1 - 30 });
      await runAt(db2, d1 + 600, [auth(d1 + 600, 0.934)]);
      expect(readEsc(s2)).toMatchObject({ peak_escalated_at: null, peak_escalation_candidate_at: d1 - 30, peak_escalation_candidate_seen_at: d1 + 570 });
      const d3 = d1 + 1_200;
      await runAt(db2, d3, [auth(d3, 0.934, { priceObservedAt: d1 + 570, priceUpdatedAt: d1 + 570 })]);
      expect(readEsc(s2)).toMatchObject({ peak_escalated_at: null, peak_escalation_candidate_at: d1 - 30, peak_escalation_candidate_seen_at: d1 + 570 });
      await runAt(db2, d3, [auth(d3, 0.934)]);
      expect(readEsc(s2)).toEqual(esc(-1_500, d3 - 30, 660));
    });

    it("clears candidate on wicks, deadband, confirm_required, blind/1h gaps; accumulates slow creep; respects 1500 bps cap", async () => {
      const { sqlite, db } = sqliteFixtures.open();
      const t0 = nowSec();
      seedOpenEvent(sqlite, { started_at: t0 - 35 * D, peak_deviation_bps: -400, peak_escalation_anchor_bps: 400 });
      await runAt(db, t0, [auth(t0, 0.93)]);
      expect(readEsc(sqlite)).toMatchObject({ peak_escalation_candidate_at: t0 - 30 });
      await runAt(db, t0 + 900, [auth(t0 + 900, 0.958)]);
      expect(readEsc(sqlite)).toMatchObject({ peak_escalated_at: null, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: null });
      await runAt(db, t0 + 1_800, [auth(t0 + 1_800, 0.93)]);
      await runAt(db, t0 + 2_700, [auth(t0 + 2_700, 0.9925)]);
      expect(readEsc(sqlite)).toMatchObject({ peak_escalated_at: null, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: null });
      await runAt(db, t0 + 3_600, [auth(t0 + 3_600, 0.93)]);
      await runAt(db, t0 + 4_050, [auth(t0 + 4_050, 0.93, { priceSource: "coingecko", priceConfidence: "low" })]);
      expect(readEsc(sqlite)).toMatchObject({ peak_escalated_at: null, peak_escalation_candidate_at: null });
      await runAt(db, t0 + 4_500, [auth(t0 + 4_500, 0.93)]);
      expect(readEsc(sqlite)).toMatchObject({ peak_escalated_at: null, peak_escalation_candidate_at: t0 + 4_470 });
      await runAt(db, t0 + 5_100, []);
      await runAt(db, t0 + 5_700, [auth(t0 + 5_700, 0.93)]);
      expect(readEsc(sqlite)).toMatchObject({ peak_escalated_at: null, peak_escalation_candidate_at: t0 + 5_670 });
      await runAt(db, t0 + 9_300, [auth(t0 + 9_300, 0.93)]);
      expect(readEsc(sqlite)).toMatchObject({ peak_escalated_at: null, peak_escalation_candidate_at: t0 + 9_270 });

      const { sqlite: sC, db: dbC } = sqliteFixtures.open();
      seedOpenEvent(sC, { started_at: t0 - 31 * D, peak_deviation_bps: -400, peak_price: 0.96 });
      await runAt(dbC, t0, [auth(t0, 0.96)]);
      for (const [d, p] of [[1, 0.95], [2, 0.94]] as const) {
        await runAt(dbC, t0 + d * D, [auth(t0 + d * D, p)]);
        expect(readEsc(sC)).toMatchObject({ peak_escalated_at: null, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: null });
      }
      const d34 = t0 + 3 * D;
      await runAt(dbC, d34, [auth(d34, 0.935)]);
      await runAt(dbC, d34 + 900, [auth(d34 + 900, 0.934)]);
      expect(readEsc(sC)).toEqual(esc(-660, d34 + 870, 660));

      const { sqlite: sCap, db: dbCap } = sqliteFixtures.open();
      seedOpenEvent(sCap, { started_at: t0 - 45 * D, peak_deviation_bps: -8_000, peak_price: 0.2, peak_escalation_anchor_bps: 8_000 });
      await runAt(dbCap, t0, [auth(t0, 0.06)]);
      expect(readEsc(sCap)).toMatchObject({ peak_escalated_at: null, peak_escalation_anchor_bps: 8_000, peak_escalation_candidate_at: null });
      await runAt(dbCap, t0 + 900, [auth(t0 + 900, 0.05)]);
      await runAt(dbCap, t0 + 1_800, [auth(t0 + 1_800, 0.05)]);
      expect(readEsc(sCap)).toEqual(esc(-9_500, t0 + 1_770, 9_500));
    });

    it("rejects confirm_required/DEX ticks, preserves max across duplicate merge & <=6h reopen, and escalates native-domain events", async () => {
      const t0 = nowSec();
      const { sqlite: sN, db: dbN } = sqliteFixtures.open();
      seedOpenEvent(sN, { started_at: t0 - 35 * D, peak_deviation_bps: -300, peak_price: 0.97 });
      seedDexEvidence(sN, 0.9, [{ protocol: "curve", price: 0.9, tvl: 3e6 }, { protocol: "uniswap", price: 0.9, tvl: 2e6 }]);
      await runAt(dbN, t0, [auth(t0, 0.9, { priceSource: "coingecko", priceConfidence: "low" })]);
      expect(readEsc(sN)).toEqual(esc(-1_000, null, null));
      sN.exec("UPDATE depeg_events SET peak_escalation_anchor_bps = 300 WHERE id = 1; DELETE FROM dex_prices;");
      vi.setSystemTime((t0 + 900) * 1000);
      seedDexEvidence(sN, 0.85, [{ protocol: "curve", price: 0.85, tvl: 3e6 }, { protocol: "uniswap", price: 0.85, tvl: 2e6 }]);
      await detectDepegEvents(dbN, [auth(t0 + 900, 0.85, { priceSource: "coingecko", priceConfidence: "single-source" })]);
      expect(readEsc(sN)).toEqual(esc(-1_500, null, 300));

      const { sqlite: sM, db: dbM } = sqliteFixtures.open();
      const escAt = t0 - 3 * D;
      seedOpenEvent(sM, { id: 1, started_at: t0 - 40 * D, peak_deviation_bps: -250, peak_price: 0.975, peak_escalation_anchor_bps: 300, peak_escalated_at: null });
      seedOpenEvent(sM, { id: 2, started_at: t0 - 39 * D, peak_deviation_bps: -900, peak_price: 0.91, peak_escalation_anchor_bps: 600, peak_escalated_at: escAt });
      seedOpenEvent(sM, { id: 10, stablecoin_id: "usdc-circle", symbol: "USDC", started_at: t0 - 40 * D, ended_at: t0 - 3_600, peak_deviation_bps: -500, peak_price: 0.95, peak_escalation_anchor_bps: 500, peak_escalated_at: escAt });
      const prevKey = `ddr2:${"a".repeat(32)}`;
      sM.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, 10, 'observed', ?)").run(prevKey, t0 - 40 * D);
      sM.prepare("INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at) VALUES (?, 'usdc-circle', 'USD', 'below', 10, 10, ?, ?, 500, ?, ?, ?)").run(prevKey, t0 - 40 * D, t0 - 40 * D, "b".repeat(64), t0 - 40 * D, t0 - 40 * D);
      seedOpenEvent(sM, { id: 11, stablecoin_id: "usdc-circle", symbol: "USDC", started_at: t0 - 1_800, ended_at: null, peak_deviation_bps: -250, peak_price: 0.975 });
      await runAt(dbM, t0, [auth(t0, 0.955), auth(t0, 0.975, { id: "usdc-circle", symbol: "USDC" })]);
      expect(readEsc(sM, 1)).toEqual(esc(-900, escAt, 600));
      expect(readEsc(sM, 11)).toEqual(esc(-250, escAt, 500));

      const { sqlite: sB, db: dbB } = sqliteFixtures.open();
      seedOpenEvent(sB, { id: 20, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", started_at: t0 - 35 * D, start_price: 0.98, peak_price: 0.98, peak_deviation_bps: -200, peg_reference: 1, pending_reason: "confirmation-window+native-origin" });
      for (const [offset, nPrice] of [[0, 0.98], [900, 0.95], [1_800, 0.95]] as const) {
        const ts = t0 + offset;
        vi.setSystemTime(ts * 1000);
        const fx = referenceState({ peggedREAL: 0.19 }, ts - 60);
        await persistFxRateState(dbB, fx.rates, fx, ts - 60);
        vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValueOnce(new Map([["brz-transfero", { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: nPrice, updatedAt: ts - 30, derivation: tradedPair }]]));
        await detectDepegEvents(dbB, [auth(ts, 0.18, { id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL" })], { peggedREAL: 0.19 });
      }
      expect(readEsc(sB, 20)).toEqual(esc(-500, t0 + 1_770, 500));
    });
  });
});
