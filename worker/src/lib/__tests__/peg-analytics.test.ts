import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { loadPegAnalyticsCache, publishPegAnalyticsCache } from "../peg-analytics-cache";
import { loadStablecoinsCache } from "../stablecoins-cache";
import { ensureCanonicalIncidents } from "../depeg-resolver-incident-store";
import { sealPublicFixture, type SqliteD1 } from "./depeg-resolver-ddrv2-store.test-support";
import { classifyOpenIncidentTier } from "@shared/lib/active-depegs";
import { DEPEG_REESCALATION_WINDOW_SEC } from "@shared/lib/depeg-config";
import { MAX_OPEN_DEPEG_EVENTS } from "../depeg-threshold-policy";
import type * as PegScoreModule from "@shared/lib/peg-score";

const sqliteFixtures = createLatestSchemaFixtureTracker();
afterEach(() => sqliteFixtures.closeAll());

const { STABLECOINS_MOCK } = vi.hoisted(() => ({
  STABLECOINS_MOCK: [
    { id: "usdt-tether", symbol: "AAA", name: "AAA Stable", launchDate: "2019-07-19", commodityOunces: undefined, flags: { pegCurrency: "USD", governance: "centralized", navToken: false } },
    { id: "eurc-circle", name: "Euro Coin", symbol: "EURC", flags: { pegCurrency: "EUR", governance: "centralized", navToken: false } },
    { id: "sofid-sofi", symbol: "SOFID", name: "SoFiUSD", launchDate: "2025-12-18", commodityOunces: undefined, flags: { pegCurrency: "USD", governance: "centralized", navToken: false } },
    { id: "usdc-circle", symbol: "NAV", name: "NAV Stable", commodityOunces: undefined, flags: { pegCurrency: "USD", governance: "centralized", navToken: true } },
  ],
}));

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shared/lib/stablecoins/worker-runtime-registry")>(),
  WORKER_ACTIVE_STABLECOINS: STABLECOINS_MOCK,
}));

vi.mock("@shared/lib/peg-score", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/peg-score")>();
  return {
    PEG_SCORE_LOOKBACK_SEC: 126_230_400,
    NULL_PEG_SCORE_RESULT: {
      pegScore: null, pegPct: 100, severityScore: 100, spreadPenalty: 0, eventCount: 0, scoredEventCount: 0,
      excludedEventCount: 0, lowConfidenceEventCount: 0, qualityAdjusted: false, worstDeviationBps: null,
      activeDepeg: false, lastEventAt: null, trackingSpanDays: 0,
    },
    getPegIncidentCoverage: actual.getPegIncidentCoverage,
    computePegScore: vi.fn(() => ({
      pegScore: 91, pegPct: 0.91, severityScore: 9, spreadPenalty: 0, eventCount: 1,
      worstDeviationBps: 35, activeDepeg: false, lastEventAt: null, trackingSpanDays: 120,
    })),
    computeRecentPegStats: vi.fn(() => ({
      windowDays: 90, observedDays: 90, coverageLimited: false, pegPct: 99,
      incidentCount: 1, thresholdCrossingCount: 1, worstDeviationBps: 35,
    })),
    coinTrackingStart: vi.fn(() => 0),
  };
});

vi.mock("@shared/lib/methodology-versions/registry", () => ({ getMethodologyVersionAt: vi.fn(() => "test-methodology") }));
vi.mock("../supply-history-db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../supply-history-db")>(),
  getFirstSeenDates: vi.fn(async () => new Map<string, number>()),
}));

import { derivePegAnalyticsSnapshot } from "../peg-analytics";
import { coinTrackingStart, computePegScore } from "@shared/lib/peg-score";
import { getFirstSeenDates } from "../supply-history-db";

const U = "usdt-tether", E = "eurc-circle", S = "sofid-sofi", C = "usdc-circle", snap = derivePegAnalyticsSnapshot;
const usdAsset = (overrides: Record<string, unknown> = {}) => ({ id: U, symbol: "AAA", name: "AAA Stable", pegType: "peggedUSD", price: 1, circulating: { peggedUSD: 2e6 }, ...overrides }) as never;
const mockAnalyticsDb = (rows: Record<string, unknown>[], match = "depeg_events_with_provenance") => mockD1([
  { match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:peg-analytics:open-incident-escalation", rows: [] }, { match, rows },
]);

function linkIncident(sqlite: DatabaseSync, key: string, coinId: string, ccy: string, firstId: number, currentId: number, firstAt: number, currentAt: number, bucketBps: number, eventIds = [firstId, currentId]) {
  const link = sqlite.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', ?)");
  for (const id of eventIds) link.run(key, id, id === firstId ? firstAt : currentAt);
  sqlite.prepare("INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at) VALUES (?, ?, ?, 'below', ?, ?, ?, ?, ?, ?, ?, ?)").run(key, coinId, ccy, firstId, currentId, firstAt, currentAt, bucketBps, "a".repeat(64), firstAt, currentAt);
}

async function withRealScore(fn: (real: typeof PegScoreModule) => Promise<void>) {
  const real = await vi.importActual<typeof PegScoreModule>("@shared/lib/peg-score");
  await vi.mocked(coinTrackingStart).withImplementation(real.coinTrackingStart, () => vi.mocked(computePegScore).withImplementation(real.computePegScore, () => fn(real)));
}

const coin = (id: string, price: number, extra: Parameters<typeof makeStablecoin>[0] = {}) => makeStablecoin({ id, price, ...extra });

describe("derivePegAnalyticsSnapshot", () => {
  let db: D1Database;
  beforeEach(() => {
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map<string, number>());
    vi.mocked(getFirstSeenDates).mockClear(); vi.mocked(coinTrackingStart).mockClear(); vi.mocked(computePegScore).mockClear();
    db = mockAnalyticsDb([{ stablecoin_id: U, symbol: "AAA", started_at: 1_700_000_000, ended_at: null, direction: "below", peak_deviation_bps: 35, source: "live" }], "depeg_events");
  });

  it("carries raw clock presence through the published cache alias into the Safety peg summary", async () => {
    const at = 1_793_000_000, eur = coin(E, 1.11, { pegType: "peggedEUR", priceUpdatedAt: at, priceObservedAtMode: "upstream" });
    const { priceObservedAt: _clock, ...legacy } = eur, usd = makeStablecoin({ id: U, priceUpdatedAt: at, priceObservedAt: null });
    async function read(currentPeg?: typeof eur.currentPeg) {
      const cache = await loadStablecoinsCache(db, { contract: "published", preloadedCache: { updatedAt: at, value: JSON.stringify({ peggedAssets: [{ ...legacy, currentPeg }, usd], fxFallbackRates: { peggedEUR: 1.1 } }) } });
      if (cache.kind !== "ok") throw new Error(cache.reason);
      expect(cache.payload.peggedAssets[0]?.priceObservedAt).toBe(at); expect(cache.payload.peggedAssets[1]?.priceObservedAt).toBeNull();
      return snap(db, { ...cache.payload, missingPriceObservedAtIds: cache.missingPriceObservedAtIds, methodologyAsOf: cache.updatedAt });
    }
    const unclocked = await read();
    expect(unclocked.pegDataById.get(E)).not.toHaveProperty("priceObservedAt");
    expect(unclocked.pegDataById.get(E)?.currentDeviationBps).toBe(91); expect(unclocked.pegDataById.get(U)?.priceObservedAt).toBeNull();
    const explicit = await read(makeFxCurrentPeg("admitted", 91, at));
    expect(explicit.pegDataById.get(E)).toMatchObject({ currentDeviationBps: null, admittedDeviationBps: null });
    expect(explicit.admittedPegById.has(E)).toBe(false);
  });

  it("withholds an unclocked EUR denominator from analytics and Safety on an admitted generation", async () => {
    const now = Date.parse("2026-11-16T15:00Z") / 1000, asset = coin(E, 1.11, { pegType: "peggedEUR", priceObservedAtMode: "upstream", priceObservedAt: now - 60 });
    const s = await snap(db, { peggedAssets: [asset], fxFallbackRates: { peggedEUR: 1.1 }, fxReferenceObservations: {}, methodologyAsOf: now });
    expect(s.pegDataById.get(E)).toMatchObject({ currentDeviationBps: null, admittedDeviationBps: null });
    expect(s.admittedPegById.get(E)?.admission).toMatchObject({ status: "unavailable", decisionAtSec: s.nowSec, generation: `stablecoins:${now}` });
    const { referenceAdmission, admittedDeviationBps: _dev, ...legacyPeg } = makeFxCurrentPeg("stale-reference", null, now);
    const legacy = await snap(db, { peggedAssets: [{ ...asset, currentPeg: legacyPeg }], fxFallbackRates: { peggedEUR: 1.1 }, methodologyAsOf: now });
    expect(legacy.pegDataById.get(E)?.currentDeviationBps).toBe(91); expect(legacy.admittedPegById.has(E)).toBe(false);
    expect((await snap(db, { peggedAssets: [{ ...asset, currentPeg: { ...legacyPeg, referenceAdmission } }], fxFallbackRates: { peggedEUR: 1.1 }, methodologyAsOf: now })).pegDataById.get(E)).toMatchObject({ currentDeviationBps: null, admittedDeviationBps: null });
  });

  it("publishes the uncapped observation boundary separately from scoring coverage", async () => {
    const first = 1_500_000_000; vi.mocked(getFirstSeenDates).mockResolvedValue(new Map([[U, first]]));
    const s = await snap(db, { peggedAssets: [coin(U, 1)], methodologyAsOf: 1_700_000_000 });
    expect(s.pegDataById.get(U)?.observationStartedAt).toBe(first);
    const { db: cacheDb } = sqliteFixtures.open();
    expect(await publishPegAnalyticsCache(cacheDb, s)).toBe(true);
    expect(await loadPegAnalyticsCache(cacheDb)).toMatchObject({ kind: "ok" });
    const retained = await loadPegAnalyticsCache(cacheDb);
    if (retained.kind === "ok") expect(retained.pegDataById.get(U)?.observationStartedAt).toBe(first);
  });

  it.each(["failed-read", "malformed-row", "pointer-advance"] as const)("keeps canonical analytics coherent on %s", async (scenario) => {
    const { sqlite, db: sqliteDb } = sqliteFixtures.open(), now = Math.floor(Date.now() / 1000), first = now - 86_400, current = now - 3600, key = `ddr2:${"a".repeat(32)}`;
    const ins = sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, peg_reference, source) VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -300, ?, ?, 0.97, 0.97, 1, 'live')");
    ins.run(1, first, current - 300); ins.run(2, current, null);
    sqlite.exec("UPDATE depeg_events SET peak_deviation_bps = -960, peak_price = 0.904 WHERE id = 1");
    linkIncident(sqlite, key, U, "USD", 1, 2, first, current, 300);
    const options = { peggedAssets: [coin(U, 0.97)], methodologyAsOf: now }, accepted = await snap(sqliteDb, options);
    expect(accepted.allEvents).toMatchObject([{ id: 2, startedAt: first, constituentEventCount: 2, peakDeviationBps: -960 }]);
    expect(computePegScore).toHaveBeenCalledWith(accepted.allEvents, expect.any(Number), expect.any(Number), "USD");
    if (scenario === "pointer-advance") {
      ins.run(3, now - 1800, null);
      sqlite.exec(`UPDATE depeg_events SET peak_deviation_bps = -437 WHERE id = 3; INSERT INTO depeg_event_provenance (event_id, source_kind, confidence_tier, audit_verdict, created_at, updated_at) VALUES (1, 'live', 'low', 'confirmed', ${first}, ${first}), (3, 'live', 'high', 'confirmed', ${now}, ${now})`);
      const advance = () => {
        sqlite.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, 3, 'observed', ?)").run(key, now - 1800);
        sqlite.prepare("UPDATE depeg_resolver_incidents SET current_event_id = 3, current_started_at = ?").run(now - 1800);
      };
      const racingDb = createSqliteD1(sqlite, { onAll: (sql) => { if (sql.includes("pharos:depeg-event-projection:active-incidents")) advance(); } });
      const batch = racingDb.batch.bind(racingDb); vi.spyOn(racingDb, "batch").mockImplementation((stmts) => { advance(); return batch(stmts); });
      const raced = await snap(racingDb, options);
      expect(raced.allEvents).toMatchObject([{ id: 3, constituentEventCount: 3, peakDeviationBps: -960, currentFragmentPeakBps: -437, peakConfidenceTier: "low", provenance: { confidenceTier: "high", auditVerdict: "confirmed" } }]);
      const scoring = await vi.importActual<typeof PegScoreModule>("@shared/lib/peg-score");
      expect(scoring.computePegScore(raced.allEvents, first, now, "USD")).toMatchObject({ worstDeviationBps: -960, eventCount: 1, lowConfidenceEventCount: 1, spreadPenalty: 0 });
      const setConf = sqlite.prepare("UPDATE depeg_event_provenance SET confidence_tier = ?, public_json = '{\"confidenceTier\":\"low\"}' WHERE event_id = 1");
      for (const col of [null, "high"]) {
        setConf.run(col); const { allEvents } = await snap(sqliteDb, options);
        expect(allEvents).toMatchObject([{ id: 3, peakDeviationBps: -960, peakConfidenceTier: "low" }]);
        expect(scoring.computePegScore(allEvents, first, now, "USD").lowConfidenceEventCount).toBe(1);
      }
      return;
    }
    expect(await publishPegAnalyticsCache(sqliteDb, accepted)).toBe(true);
    const acceptedCache = await loadPegAnalyticsCache(sqliteDb), prepare = sqliteDb.prepare.bind(sqliteDb);
    if (scenario === "malformed-row") sqlite.exec("UPDATE depeg_events SET start_price = -1 WHERE id = 1");
    else vi.spyOn(sqliteDb, "prepare").mockImplementation((sql) => { if (sql.includes("pharos:depeg-event-projection:active-incidents")) throw new Error("D1 projection timeout"); return prepare(sql); });
    await expect(snap(sqliteDb, options)).rejects.toMatchObject({ reason: scenario === "failed-read" ? "incident-projection-read-failed" : "incident-projection-invalid" });
    expect(await loadPegAnalyticsCache(sqliteDb)).toEqual(acceptedCache);
  });

  it("requires a valid AUDD opening verdict for closed-session legacy admission", async () => {
    const { db: sDb, sqlite } = sqliteFixtures.open();
    const first = Date.UTC(2026, 10, 15, 12) / 1000;
    const current = first + 1800;
    const now = current + 600;
    sqlite.exec(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, peg_reference, source) VALUES
      (1, 'audd-novatti', 'AUDD', 'peggedAUD', 'below', -2600, ${first}, ${current}, 0.5, 0.5, 0.67, 'live'),
      (2, 'audd-novatti', 'AUDD', 'peggedAUD', 'below', -437, ${current}, NULL, 0.64, 0.64, 0.67, 'live');
      INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (1, 'live', 'confirmed', ${first}, ${first});
      DROP TRIGGER trg_depeg_provenance_audit_verdict_update_guard;`);
    linkIncident(sqlite, `ddr2:${"a".repeat(32)}`, "audd-novatti", "AUD", 1, 2, first, current, 2600);
    const update = sqlite.prepare("UPDATE depeg_event_provenance SET audit_verdict = ?, public_json = ? WHERE event_id = 1");
    const scoring = await vi.importActual<typeof PegScoreModule>("@shared/lib/peg-score");
    for (const [verdict, json, count] of [
      ["confirmed", null, 1], ["unknown", null, 0], ["confirmed", '{"auditVerdict":"unknown"}', 0],
      ["confirmed", '{"auditVerdict":"confirmed","auditVerdict":"confirmed"}', 0],
    ] as const) {
      update.run(verdict, json);
      const { allEvents } = await snap(sDb, { peggedAssets: [], methodologyAsOf: now });
      expect(scoring.computePegScore(allEvents, first, now, "AUD").scoredEventCount, `${verdict} ${json}`).toBe(count);
      expect(allEvents).toMatchObject([{ onsetFragmentPeakBps: count ? -2600 : null, peakDeviationBps: count ? -2600 : -437 }]);
    }
  });

  it("builds shared maps, excludes NAV by default, includes NAV as peg-ineligible when requested, and handles provenance", async () => {
    const s = await snap(db, { peggedAssets: [usdAsset({ price: 1.01 })], methodologyAsOf: 1_700_000_000 });
    expect(s.eventsByCoin.has(U)).toBe(true);
    expect(s.pegDataById.has(U)).toBe(true);
    expect(s.pegDataById.has(C)).toBe(false);
    expect(s.pegDataById.get(U)?.currentDeviationBps).toBe(100);
    expect(s.pegDataById.get(U)?.depegEventCoverageLimited).toBe(false);

    const fpDb = mockAnalyticsDb([{ id: 123, stablecoin_id: U, symbol: "AAA", peg_type: "peggedUSD", started_at: 1_700_000_000, ended_at: 1_700_003_600, direction: "below", peak_deviation_bps: -500, source: "live", provenance_audit_verdict: "false_positive", provenance_confidence_tier: "medium" }]);
    const fpSnap = await snap(fpDb, { peggedAssets: [usdAsset()], methodologyAsOf: 1_700_000_000 });
    expect((fpDb as MockD1Database).getHistory().some((e) => e.sql.includes("FROM depeg_events_with_provenance"))).toBe(true);
    expect(fpSnap.allEvents[0]?.provenance?.auditVerdict).toBe("false_positive");
    expect(vi.mocked(computePegScore)).toHaveBeenCalledWith([expect.objectContaining({ provenance: expect.objectContaining({ auditVerdict: "false_positive" }) })], expect.any(Number), expect.any(Number), "USD");

    const navDb = mockAnalyticsDb([{ stablecoin_id: C, symbol: "NAV", started_at: 1_700_000_000, ended_at: null, direction: "above", peak_deviation_bps: 2500, source: "live" }], "depeg_events");
    const navSnap = await snap(navDb, { peggedAssets: [usdAsset({ id: C, symbol: "NAV", name: "NAV Stable", price: 1.25 })], methodologyAsOf: 1_700_000_000, includeNavTokens: true });
    expect(navSnap.pegDataById.get(C)).toMatchObject({ currentDeviationBps: null, pegScore: null, eventCount: 0, worstDeviationBps: null, activeDepeg: false, trackingSpanDays: 0 });
  });

  it.each(["valid", "invalid-reason", "superseded-peak", "different-clock", "old-gap"])("preserves legacy coverage for a %s detector hold", async (shape) => {
    const at = 1_794_730_000;
    const hold = { reason: shape !== "invalid-reason" ? "reference-market-closed" : "quote-unavailable", declaredAtSec: at + 60, lastTrustedAtSec: at, lastTrustedPeakBps: -500 };
    const intervals = [[at - 60, at]];
    const holdDb = mockAnalyticsDb([{
      id: 1, stablecoin_id: "paxg-paxos", peg_type: "peggedGOLD", started_at: at - 60, ended_at: null, source: "live",
      peak_deviation_bps: shape === "superseded-peak" ? -600 : -500, direction: "below",
      price_coverage_json: JSON.stringify({ intervals, referenceHold: hold, lastObservationKind: "blind" }),
      last_trusted_price_at: at + (shape === "different-clock" ? 1 : 0),
      price_coverage_gap_started_at: hold.declaredAtSec + (shape === "old-gap" ? 1 : 0),
    }]);
    const event = (await snap(holdDb, { peggedAssets: [], methodologyAsOf: hold.declaredAtSec })).eventsByCoin.get("paxg-paxos")?.[0];
    expect(event?.priceCoverage?.intervals).toEqual(intervals);
    if (shape === "valid") expect(event).toMatchObject({ referenceHold: hold });
    else expect(event).not.toHaveProperty("referenceHold");
  });

  it.each([
    { ageDays: null, expectedDays: 0, expectedScore: null },
    { ageDays: 120, expectedDays: 120, expectedScore: 100 },
    { ageDays: 3650, expectedDays: 1461, expectedScore: 100 },
  ])("scores $ageDays-day history at the caller clock with NAV admission unchanged", async ({ ageDays, expectedDays, expectedScore }) => {
    const now = 1_900_000_000;
    const day = 86_400;
    const c = STABLECOINS_MOCK[0] as { launchDate?: string };
    const launchDate = c.launchDate;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    delete c.launchDate;
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map(ageDays == null ? [] : [[U, now - ageDays * day]]));
    try {
      await withRealScore(async () => {
        const s = await snap(mockAnalyticsDb([], "depeg_events"), { peggedAssets: [], methodologyAsOf: now - 60, includeNavTokens: true });
        expect(s.nowSec).toBe(now);
        expect(s.pegDataById.get(U)).toMatchObject({
          pegScore: expectedScore, trackingSpanDays: expectedDays, eventCount: 0,
          historyCoverage: ageDays == null ? null : { startedAt: now - expectedDays * day, source: "first-observation", status: "assumed" },
        });
        expect(s.pegDataById.get(C)).toMatchObject({ pegScore: null, trackingSpanDays: 0, historyCoverage: null, recent90d: null });
      });
    } finally { c.launchDate = launchDate; clock.mockRestore(); }
  });

  it("handles first-seen observations, supply/price availability flags, and SOFID nominal/failed reads", async () => {
    const now = 1_700_000_000, snapOf = (peggedAssets: unknown[]) => snap(db, { peggedAssets: peggedAssets as never, methodologyAsOf: now });
    await snapOf([usdAsset({ priceSyncedAt: now + 500, priceUpdatedAt: now + 100 }), usdAsset({ id: "missing-price", symbol: "MISS", price: null, priceSyncedAt: now + 600 })]);
    expect(vi.mocked(getFirstSeenDates)).toHaveBeenCalledWith(db, [{ id: U, observedAtSec: now + 500 }]);
    for (const circulating of [undefined, {}, { peggedUSD: Number.NaN }] as Array<Record<string, number> | undefined>) {
      const m = (await snapOf([usdAsset({ price: 0.9, circulating })])).pegDataById.get(U);
      expect(m?.currentSupplyUnavailable).toBe(true); expect(m?.depegEventCoverageLimited).toBe(false); expect(m?.currentDeviationBps).toBe(-1000);
    }
    const lowCap = (await snapOf([usdAsset({ price: 0.9, circulating: { peggedUSD: 500_000 } })])).pegDataById.get(U);
    expect(lowCap?.currentDeviationBps).toBe(-1000); expect(lowCap?.depegEventCoverageLimited).toBe(true);
    expect(lowCap?.currentSupplyUnavailable).toBeUndefined(); expect(lowCap?.currentPriceUnavailable).toBeUndefined();
    const obsCap = (await snapOf([usdAsset({ price: 0.9, circulating: { peggedUSD: 8e6 } })])).pegDataById.get(U);
    expect(obsCap?.currentSupplyUnavailable).toBeUndefined(); expect(obsCap?.currentDeviationBps).not.toBeNull();
    for (const assets of [[usdAsset({ price: null, circulating: { peggedUSD: 8e6 } })], []]) {
      const missing = (await snapOf(assets)).pegDataById.get(U);
      expect(missing?.currentPriceUnavailable).toBe(true); expect(missing?.currentDeviationBps).toBeNull();
    }
    const sofid = coin(S, 0.999, { symbol: "SOFID", name: "SoFiUSD", pegType: "peggedUSD", circulating: { peggedUSD: 8e6 }, priceSource: "coingecko+kraken", priceConfidence: "high", priceObservedAt: now - 30, priceObservedAtMode: "local_fetch" });
    const ok = (await snapOf([sofid])).pegDataById.get(S);
    expect(ok?.currentPriceUnavailable).toBeUndefined();
    expect(ok).toMatchObject({ currentDeviationBps: -10, priceObservedAt: now - 30, priceSource: "coingecko+kraken" });
    for (const failed of [{ ...sofid, price: null, priceSource: "missing", priceConfidence: null }, { ...sofid, price: 1, priceSource: "protocol-par", priceObservedAt: null, priceObservedAtMode: "nominal_reference" as const }]) {
      expect((await snapOf([failed])).pegDataById.get(S)).toMatchObject({ currentPriceUnavailable: true, currentDeviationBps: null });
    }
  });

  it("anchors peg tracking via audited replay coverage, exact/fuzzy launchDate, and rejects invalid audited dates", async () => {
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map([[U, 1_743_120_000]]));
    await snap(db, { peggedAssets: [usdAsset()], methodologyAsOf: 1_700_000_000 });
    expect(vi.mocked(coinTrackingStart)).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), 1_563_494_400);
    const entry = STABLECOINS_MOCK[0] as typeof STABLECOINS_MOCK[0] & { launchDate?: string; pegScoreCoverage?: { startDate: string } };
    const origLaunch = entry.launchDate, now = Math.floor(Date.UTC(2026, 9, 30) / 1000), clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const real = await vi.importActual<typeof PegScoreModule>("@shared/lib/peg-score");
    entry.launchDate = "2023-06";
    try {
      await vi.mocked(coinTrackingStart).withImplementation(real.coinTrackingStart, async () => {
        const s = await snap(db, { peggedAssets: [coin(U, 1)], methodologyAsOf: now - 60 }), endSec = Date.UTC(2023, 5, 30) / 1000;
        expect(vi.mocked(coinTrackingStart)).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), endSec);
        expect(s.pegDataById.get(U)?.historyCoverage).toMatchObject({ startedAt: endSec, source: "asset-age", status: "assumed" });
      });
    } finally { entry.launchDate = origLaunch; clock.mockRestore(); }
    entry.pegScoreCoverage = { startDate: "2026-06-28" };
    try {
      const audited = await snap(db, { peggedAssets: [usdAsset()], methodologyAsOf: 1_783_000_000 });
      expect(vi.mocked(coinTrackingStart)).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), 1_782_604_800);
      expect(audited.pegDataById.get(U)?.historyCoverage).toMatchObject({ source: "audited-replay", status: "verified" });
      for (const bad of ["2026-02-30", "2025-02-29"]) {
        vi.mocked(coinTrackingStart).mockClear(); entry.pegScoreCoverage = { startDate: bad };
        const fb = await snap(db, { peggedAssets: [coin(U, 1)], methodologyAsOf: 1_783_000_000 });
        expect(fb.pegDataById.get(U)?.historyCoverage).toMatchObject({ source: "asset-age", status: "assumed" });
        expect(vi.mocked(coinTrackingStart)).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), 1_563_494_400);
      }
    } finally { delete entry.pegScoreCoverage; }
  });

  it("emits openIncidents sidecar with linked family max peak_escalated_at, reopen/split/BLOB/indeterminate guards, recentUntil selection, and fallback resilience", async () => {
    const now = 1_800_000_000, d = 86_400, first = now - 45 * d, cur = now - 3600, esc = now - 1800;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const addEvt = (s: DatabaseSync, id: number, c: string, sym: string, bps: number, start: number, end: number | null, escAt: number | null = null) =>
      s.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, peg_reference, source, peak_escalated_at) VALUES (?, ?, ?, 'peggedUSD', 'below', ?, ?, ?, 0.96, 0.96, 1, 'live', ?)").run(id, c, sym, bps, start, end, escAt);
    try {
      await withRealScore(async () => {
        const { sqlite, db: db1 } = sqliteFixtures.open();
        addEvt(sqlite, 11, U, "USDT", -350, first, cur - 300, esc); addEvt(sqlite, 12, U, "USDT", -350, cur, null);
        addEvt(sqlite, 21, S, "SOFID", -350, now - 40 * d, null, now - DEPEG_REESCALATION_WINDOW_SEC + 60);
        addEvt(sqlite, 22, S, "SOFID", -350, now - d, null); addEvt(sqlite, 31, C, "NAV", -350, now - 2 * d, null); addEvt(sqlite, 41, E, "EURC", -350, now - 2 * d, null);
        sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (41, 'live', 'disputed', ?, ?)").run(now - 2 * d, now - 2 * d);
        linkIncident(sqlite, `ddr2:${"b".repeat(32)}`, U, "USD", 11, 12, first, cur, 350);
        const assets1 = [coin(U, 0.965), coin(S, 0.965), coin(C, 1.05)];
        const snap1 = await snap(db1, { peggedAssets: assets1, methodologyAsOf: now, includeNavTokens: true });
        expect(snap1.openIncidents).toEqual({ [U]: { eventId: 12, startedAt: first, escalatedAt: esc }, [S]: { eventId: 21, startedAt: now - 40 * d, escalatedAt: now - DEPEG_REESCALATION_WINDOW_SEC + 60 } });
        expect(snap1.openIncidentCandidates?.[S]).toEqual([{ eventId: 21, startedAt: now - 40 * d, escalatedAt: now - DEPEG_REESCALATION_WINDOW_SEC + 60 }, { eventId: 22, startedAt: now - d, escalatedAt: null }]);
        expect(classifyOpenIncidentTier(snap1.openIncidents?.[S], now)).toBe("escalating");
        for (const k of ["openIncidents", "escalatedAt"]) expect(snap1.pegDataById.get(U)).not.toHaveProperty(k);
        for (const ev of snap1.allEvents) for (const k of ["peakEscalatedAt", "peak_escalated_at"]) expect(ev).not.toHaveProperty(k);
        sqlite.prepare("UPDATE depeg_events SET started_at = ?, peak_escalated_at = NULL WHERE id = 21").run(now - 4 * d);
        expect((await snap(db1, { peggedAssets: assets1, methodologyAsOf: now, includeNavTokens: true })).openIncidents?.[S]).toEqual({ eventId: 21, startedAt: now - 4 * d, escalatedAt: null });
        sqlite.prepare("UPDATE depeg_events SET peak_escalated_at = ? WHERE id = 11").run(now - 899.5);
        expect((await snap(db1, { peggedAssets: assets1, methodologyAsOf: now, includeNavTokens: true })).openIncidents?.[U]).toBeUndefined();
        sqlite.prepare("UPDATE depeg_events SET peak_escalated_at = ? WHERE id = 11").run(esc);

        const { sqlite: s2, db: db2 } = sqliteFixtures.open();
        addEvt(s2, 51, U, "USDT", -400, first, cur - 1800, esc); addEvt(s2, 52, U, "USDT", -300, cur, null);
        addEvt(s2, 55, E, "EURC", -350, first, cur - 1800, null); s2.exec("UPDATE depeg_events SET peak_escalation_anchor_bps = X'FFFF' WHERE id = 55");
        addEvt(s2, 56, E, "EURC", -300, cur, null); addEvt(s2, 61, S, "SOFID", -220, first, null, esc);
        const [sealedInc] = await ensureCanonicalIncidents(db2, [{ eventId: 61, stablecoinId: S, pegCurrency: "USD", direction: "below", startedAt: first, endedAt: null, peakDeviationBps: -220, source: "live", publicTrackedAtFirstSeen: true, registrySnapshot: { id: S, symbol: "SOFID" } }], { nowSec: first + d, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: first - 1, createdBy: "vitest" });
        await sealPublicFixture(Object.assign(db2, { sqlite: s2, close: () => {} }) as SqliteD1, sealedInc!.incidentKey, "prediction", { payload: { eventId: 61, stablecoinId: S, symbol: "SOFID", name: "SoFiUSD", pegCurrency: "USD", direction: "below", startedAt: first, lockTimePeakDeviationBps: -200, eligibleAt: first + d, lockedAt: first + d, eventAgeAtLockSec: d } });
        s2.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 61").run(cur - 1800); addEvt(s2, 62, S, "SOFID", -1_200, cur, null);
        const snap2 = await snap(db2, { peggedAssets: [coin(U, 0.97), coin(S, 0.88), coin(E, 1.07, { pegType: "peggedEUR" })], fxFallbackRates: { peggedEUR: 1.1 }, methodologyAsOf: now, includeNavTokens: true });
        expect(snap2.openIncidents).toEqual({ [E]: { eventId: 56, startedAt: first, escalatedAt: null }, [S]: { eventId: 62, startedAt: cur, escalatedAt: null } });
        addEvt(s2, 54, E, "EURC", -350, first - 20 * d, first - 1800, null);
        expect((await snap(db2, { peggedAssets: [coin(E, 1.07, { pegType: "peggedEUR" })], fxFallbackRates: { peggedEUR: 1.1 }, methodologyAsOf: now, includeNavTokens: true })).openIncidents?.[E]).toBeUndefined();

        const origBatch = db1.batch.bind(db1);
        const batchSpy = vi.spyOn(db1, "batch").mockImplementation((stmts) => stmts.length === 3 ? Promise.reject(new Error("auxiliary escalation metadata failure")) : origBatch(stmts));
        const retried = await snap(db1, { peggedAssets: assets1, methodologyAsOf: now, includeNavTokens: true });
        expect(retried.openIncidents).toBeUndefined(); expect(retried.pegDataById.get(U)?.activeDepeg).toBe(true);
        batchSpy.mockRestore();

        const openRow = { id: 70, stablecoin_id: U, symbol: "USDT", peg_type: "peggedUSD", direction: "below", peak_deviation_bps: -300, started_at: cur, ended_at: null, start_price: 0.97, peak_price: 0.97, peg_reference: 1, source: "live" };
        const truncSnap = await snap(mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:peg-analytics:open-incident-escalation", rows: Array.from({ length: MAX_OPEN_DEPEG_EVENTS + 1 }, (_, i) => ({ id: i + 1, started_at: cur, peak_deviation_bps: -200 })) }, { match: "depeg_events_with_provenance", rows: [openRow] }]), { peggedAssets: [usdAsset({ price: 0.97 })], methodologyAsOf: now });
        expect(truncSnap.openIncidents).toBeUndefined(); expect(truncSnap.pegDataById.get(U)?.activeDepeg).toBe(true);
        expect((await snap(mockAnalyticsDb([openRow]), { peggedAssets: [usdAsset({ price: 0.97 })], methodologyAsOf: now })).openIncidents).toEqual({});
      });
    } finally { clock.mockRestore(); }
  });
});
