import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockD1Preset, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { PSI_NATIVE_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/depeg-quote-domain";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../../lib/native-peg-quote-cache";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { handleOg } from "../og";
import type { StablecoinData } from "@shared/types/supply";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import * as ogRenderer from "../../lib/og-render";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { makeScorecardImageFixture, makeScorecardMetadataFixture } from "@shared/test-utils/social-scorecard";
import { decodeSocialScorecardMetadata, SOCIAL_SCORECARD_METADATA_HEADER, SOCIAL_SCORECARD_REASON_HEADER } from "@shared/lib/social-scorecard";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { mockFetch, type MockFetchOutcome } from "@shared/test-utils/mock-fetch";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { handleScorecardOg } from "../og-scorecard";

vi.mock("harfbuzzjs", () => ({ default: {} }));

const USDT = "usdt-tether", USDC = "usdc-circle", EURC = "eurc-circle", DAI = "dai-makerdao", FRAX = "frax-frax";
const META_HDR = SOCIAL_SCORECARD_METADATA_HEADER, MAX_AGE = SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
const STABLE_AGE = API_FRESHNESS_MAX_AGE_SEC.stablecoins;
const nowSec = () => Math.floor(Date.now() / 1000);
const cc = (r?: Response | null) => r?.headers.get("Cache-Control");
const renderPng = () => vi.mocked(ogRenderer.renderPng);
const scorecardMetadata = (r: Response) => decodeSocialScorecardMetadata(r.headers.get(META_HDR));
const logoUrl = `${SITE_ORIGIN}/logos/2-usdc.svg`;
const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>';
const mockLogo = (respond: () => MockFetchOutcome | Response) => mockFetch([{ match: logoUrl, respond }], { requireMatch: true, strictUrl: true });
const drawn = () => JSON.stringify(renderPng().mock.calls[0][0]).replace(/\u00a0/g, " ");

const makeDepegDb = createMockD1Preset([
  { match: "FROM cache WHERE key = ?", rows: [], first: null },
  { match: "pharos:og-depeg:new-today", rows: [] },
  { match: "peak_deviation_bps", rows: [] },
  { match: "ended_at IS NOT NULL", rows: [] },
]);

const marketTable = (assets: StablecoinData[], updatedAt: number, fxFallbackRates?: Record<string, number>, fxReferenceObservations?: Record<string, unknown>): MockTableConfig => ({
  match: "FROM cache WHERE key = ?",
  rows: [{ key: "stablecoins", updated_at: updatedAt, value: JSON.stringify({ peggedAssets: assets, fxFallbackRates, ...(fxReferenceObservations ? { fxReferenceObservations } : {}) }) }],
});

const mkCov = (now: number) => JSON.stringify({ intervals: [[now - 3600, now - 30]], lastObservationKind: "trusted-off-peg" });
const openRow = (id: number, coinId: string, symbol: string, startedAt: number, now: number, overrides: Record<string, unknown> = {}) => ({
  id, stablecoin_id: coinId, symbol, peg_type: "peggedUSD", direction: "below",
  peak_deviation_bps: -500, peg_reference: 1, source: "live", started_at: startedAt, effective_started_at: startedAt,
  peak_escalated_at: null, last_trusted_price_at: now - 30, price_coverage_gap_started_at: null, price_coverage_json: mkCov(now), ...overrides,
});

const incidentTable = (asset: Pick<StablecoinData, "id" | "symbol" | "pegType">, startedAt: number, overrides: Record<string, unknown> = {}): MockTableConfig => ({
  match: "peak_deviation_bps",
  rows: [{ stablecoin_id: asset.id, symbol: asset.symbol, peg_type: asset.pegType, direction: "below", peak_deviation_bps: -500, peg_reference: 1, source: "live", started_at: startedAt, ...overrides }],
});

const briefDb = (asset: StablecoinData, marketAt: number, startedAt: number, opts: { fx?: Record<string, number>; fxObs?: Record<string, unknown>; inc?: Record<string, unknown> } = {}) =>
  makeDepegDb([marketTable([asset], marketAt, opts.fx, opts.fxObs), incidentTable(asset, startedAt, opts.inc)]);

const eurc = (price: number, priceObservedAt: number, extra: Parameters<typeof makeAsset>[0] = {}) =>
  makeAsset({ id: EURC, symbol: "EURC", pegType: "peggedEUR", price, priceObservedAt, ...extra });

type Sqlite = ReturnType<ReturnType<typeof createLatestSchemaFixtureTracker>["open"]>["sqlite"];
const seedCache = (s: Sqlite, peggedAssets: StablecoinData[], now: number, fxFallbackRates: Record<string, number>) =>
  s.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)").run(JSON.stringify({ peggedAssets, fxFallbackRates }), now);

const seedEvent = (s: Sqlite, row: Record<string, unknown>) => {
  const full = { stablecoin_id: EURC, symbol: "EURC", peg_type: "peggedEUR", direction: "below", peak_deviation_bps: -500, start_price: 0.98, peg_reference: 1, ...row };
  const cols = Object.keys(full);
  s.prepare(`INSERT INTO depeg_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(full) as (string | number | null)[]));
};
const seedProv = (s: Sqlite, eventId: number, cols: Record<string, unknown>, at: number) => {
  const full = { event_id: eventId, source_kind: "live", ...cols, created_at: at, updated_at: at };
  const k = Object.keys(full);
  s.prepare(`INSERT INTO depeg_event_provenance (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...(Object.values(full) as (string | number | null)[]));
};
const seedLink = (s: Sqlite, key: string, coin: string, ccy: string, id1: number, id2: number, t1: number, t2: number, bps: number, fp: string) => {
  s.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', ?), (?, ?, 'observed', ?)").run(key, id1, t1, key, id2, t2);
  s.prepare("INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at) VALUES (?, ?, ?, 'below', ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(key, coin, ccy, id1, id2, t1, t2, bps, fp, t1, t2);
};

function nativeQuote(value: number, observedAt: number, kind: "traded-pair" | "conversion" = "traded-pair") {
  const lineage = kind === "traded-pair" ? { venue: "fixture-exchange", pair: "EURC/EUR" } : { fxSource: "fixture-fixing", fxObservedAtSec: observedAt };
  return JSON.stringify({ value, observedAt, source: "coingecko", derivation: { kind, lineage } });
}

describe("dated depeg briefing", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  const briefing = (db: D1Database) => handleOg(db, API_PATHS.ogDepegBriefing());
  async function renderBriefing(db: D1Database) {
    renderPng().mockClear();
    expect((await briefing(db))?.status).toBe(200);
    return drawn();
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_795_017_600 * 1000);
    vi.spyOn(ogRenderer, "renderPng").mockResolvedValue(makeScorecardImageFixture());
    vi.spyOn(ogRenderer, "socialCardMeasurer").mockResolvedValue({ width: (t, _f, sz) => t.length * sz * 0.3 });
  });
  afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["WHERE e.ended_at IS NULL", "WHERE e.ended_at IS NOT NULL"])("rejects failed ledger results for %s", async (marker) => {
    const db = makeDepegDb();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      if (sql.includes(marker)) Object.assign(stmt, { bind: () => stmt, all: async () => ({ success: false, results: [] }) });
      return stmt;
    });
    const res = await briefing(db);
    expect(res?.status).toBe(503);
    expect(await res?.text()).toBe("incident-ledger-unavailable");
    expect(cc(res)).toBe("no-store");
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
  });

  it("counts recoveries in the past day by their admitted observation clock", async () => {
    const { db, sqlite } = fixtures.open();
    const now = nowSec();
    for (const [end, atPar] of [[now - 60, true], [now - 300, false], [now - 86400 + 60, true]] as const) {
      const last = end - 900;
      seedEvent(sqlite, { stablecoin_id: "eurs-stasis", symbol: "EURS", peak_deviation_bps: -300, started_at: last - 900, ended_at: end, start_price: 1.067, peg_reference: 1.1, recovery_price: 1.1, recovery_peg_reference: 1.1, close_reason: "recovered-primary", last_trusted_price_at: last, price_coverage_json: JSON.stringify({ intervals: [[last - 900, last]], atParIntervals: atPar ? [[last, last]] : [] }) });
    }
    expect(await renderBriefing(db)).toContain("1 recovered in 24h");
  });

  it("counts canonical openings and terminal recoveries across incident fragments", async () => {
    const { db, sqlite } = fixtures.open();
    const now = nowSec(), start = now - 26 * 3600, restart = now - 3600;
    for (const [id, started_at] of [[101, start], [102, restart], [103, restart + 1]]) {
      seedEvent(sqlite, { id, stablecoin_id: USDT, symbol: "USDT", peg_type: "peggedUSD", peak_deviation_bps: -300, started_at, start_price: 0.97 });
    }
    seedProv(sqlite, 103, { audit_verdict: "disputed" }, restart);
    const close = sqlite.prepare("UPDATE depeg_events SET ended_at = ?, close_reason = 'recovered-primary', recovery_price = 1 WHERE id = ?");
    close.run(now - 3 * 3600, 101);
    seedLink(sqlite, `ddr2:${"a".repeat(32)}`, USDT, "USD", 101, 102, start, restart, 300, "b".repeat(64));
    const open = await renderBriefing(db);
    for (const t of ["Top 1 of 1 recent", "1 recent · 0 >30d", "0 new in 24h", "0 recovered in 24h"]) expect(open).toContain(t);
    close.run(now - 60, 102);
    const recovered = await renderBriefing(db);
    expect(recovered).toContain("0 new in 24h");
    expect(recovered).toContain("1 recovered in 24h");
  });

  it.each(["currentPriceUnavailable", "pegReferenceUnavailable", "currentDeviationBps"] as const)("honors unavailability from published %s", async (field) => {
    const now = nowSec();
    const asset = makeAsset({ id: USDT, symbol: "USDT", price: 0.98, priceObservedAt: now - 60, currentPeg: {
      currentDeviationBps: field === "currentDeviationBps" ? null : -200,
      currentPriceUnavailable: field === "currentPriceUnavailable", pegReferenceUnavailable: field === "pegReferenceUnavailable",
      pegReference: null, primaryTrust: "unusable", dexPriceCheck: null,
    } });
    const markup = await renderBriefing(briefDb(asset, now, now - 600, { fx: { peggedUSD: 1 } }));
    expect(markup).toContain("Current unavailable");
    expect(markup).toContain("Peak -500 bps");
    expect(markup).not.toContain("-200 bps");
  });

  it("labels a validated peer peak separately from the current benchmark deviation", async () => {
    const { db, sqlite } = fixtures.open();
    const now = FX_REOPEN_QUOTE_AT, start = now - 60;
    vi.setSystemTime(now * 1000);
    seedCache(sqlite, [eurc(1.026, now)], now, { peggedEUR: 1.026 });
    seedEvent(sqlite, { id: 1, started_at: start, start_price: 1.026, peak_price: 1.026, peg_reference: 1.08, peak_peg_reference: 1.08, peak_quote_domain: "usd", source: "live", peer_basis_json: JSON.stringify({ peak: { basis: "peer-relative", observedAt: start, price: 1.026, pegReference: 1.08, bps: -500 } }) });
    const peer = await renderBriefing(db);
    for (const s of ['"0 bps"', '"Peak -500 bps vs peer median"', "Peer median $1.0800 · Lower confidence"]) expect(peer).toContain(s);
    sqlite.prepare("UPDATE depeg_events SET peak_peg_reference = 1.07 WHERE id = 1").run();
    const benchmark = await renderBriefing(db);
    expect(benchmark).toContain('"Peak -500 bps"');
    expect(benchmark).not.toContain("peer median");
  });

  it.each([["EURC", EURC, "peggedEUR", 1.1, true], ["USDT", USDT, "peggedUSD", 1, undefined]] as const)(
    "keeps %s legacy fallback and honors its refusal in a mixed publication",
    async (symbol, id, pegType, ref, legacyFxReference) => {
      const now = FX_REOPEN_QUOTE_AT;
      vi.setSystemTime(now * 1000);
      const asset = makeAsset({ id, symbol, pegType, price: ref * 0.98, priceObservedAt: now, currentPeg: {
        currentDeviationBps: -200, currentPriceUnavailable: false, pegReferenceUnavailable: false, legacyFxReference,
        pegReference: legacyFxReference ? { source: "fx", valueUsd: ref, asOf: now, contributorCount: 0 } : null, primaryTrust: "unusable", dexPriceCheck: null,
      } });
      for (const refused of [false, true]) {
        asset.currentPeg!.pegReferenceUnavailable = refused;
        expect(await renderBriefing(briefDb(asset, now, now - 600, { fx: { peggedEUR: 1.1 }, fxObs: {}, inc: { peg_reference: ref } }))).toContain(refused ? "Current unavailable" : "-200 bps");
      }
    },
  );

  it.each([["stale-reference", null, "Reference not yet updated"], ["admitted", 0, "0 bps"]] as const)(
    "uses the %s USD projection through the published cache",
    async (status, expected, copy) => {
      const now = FX_REOPEN_QUOTE_AT;
      vi.setSystemTime(now * 1000);
      const asset = { ...eurc(1.122, now), currentPeg: makeFxCurrentPeg(status, expected) };
      const markup = await renderBriefing(briefDb(asset, now, now - 60, { fx: { peggedEUR: 1.1 }, inc: { direction: "above", peg_reference: 1.1, peak_deviation_bps: 500 } }));
      expect(markup).toContain(copy);
      expect(markup).toContain("Peak 500 bps");
      expect(markup).not.toContain("+200 bps");
    },
  );

  it.each([false, true])("keeps an unavailable new-event count distinct from observed zero; observed=%s", async (observed) => {
    const db = makeDepegDb();
    if (!observed) {
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const stmt = prepare(sql);
        if (sql.includes("pharos:og-depeg:new-today")) Object.assign(stmt, { bind: () => stmt, all: async () => ({ success: false, results: [] }) });
        return stmt;
      });
    }
    const markup = await renderBriefing(db);
    expect(db.getHistory().some(({ sql }) => /stress_signal|stability_index_samples/.test(sql))).toBe(false);
    expect(markup).not.toContain("DEWS DISTRIBUTION");
    expect(markup).toContain(observed ? "0 new in 24h" : "New in 24h unavailable");
  });

  it.each([
    ["native current", "live", "native-peg", "fresh", 86400, 1, -200], ["native inferred", "live", null, "fresh", 86400, 1, -200],
    ["native provenance", "backfill", "native-peg", "fresh", 86400, 1, -200], ["native start", "live", "native-peg", "missing", 60, 1, -200],
    ["native missing", "live", "native-peg", "missing", 86400, 1, null], ["native expired", "live", "native-peg", "expired", 86400, 1, null],
    ["legacy USD reference", "backfill", null, "fresh", 86400, 1.1, 0], ["explicit USD provenance", "live", "usd", "fresh", 86400, 1, 0],
  ] as const)("renders %s in its event domain from joined SQLite evidence", async (label, source, quoteMode, quoteState, startAge, peg_reference, expectedBps) => {
    const { db, sqlite } = fixtures.open();
    const now = nowSec();
    seedCache(sqlite, [eurc(1.1, now)], now, { peggedEUR: 1.1 });
    seedEvent(sqlite, { id: 101, started_at: now - startAge, peak_price: 0.95, peg_reference, source });
    if (quoteMode != null) seedProv(sqlite, 101, { source_kind: source, quote_mode: quoteMode }, now);
    const quoteAt = quoteState === "expired" ? now - PSI_NATIVE_EVIDENCE_MAX_AGE_SEC : now - 30;
    if (quoteState !== "missing") sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}101`, nativeQuote(0.98, quoteAt), quoteAt);
    const markup = await renderBriefing(db);
    expect(markup).toContain("Peak -500 bps");
    if (label.startsWith("native")) expect(markup).toContain("EURC (native peg)");
    if (expectedBps == null) expect(markup).toContain("Current unavailable");
    else expect(markup).toContain(`${expectedBps > 0 ? "+" : ""}${expectedBps} bps`);
    if (expectedBps === -200) {
      expect(markup).not.toContain("+1000 bps");
      const observedAt = startAge === 60 ? now - startAge : quoteAt;
      expect(markup).toContain(new Date(observedAt * 1000).toISOString().slice(0, 16).replace("T", " "));
    }
  });

  it.each([
    ["native-current", 3], ["native-current", 9], ["native-start", 3], ["native-start", 9],
    ["usd-quote", 3], ["usd-quote", 9], ["usd-market", 3], ["usd-market", 9], ["native-market", 3], ["native-market", 9],
  ] as const)("bounds %s evidence by its own expiry after %ss rendering", async (source, elapsed) => {
    const now = 1_795_000_000, native = source.startsWith("native");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const quoteAt = now - (native ? PSI_NATIVE_EVIDENCE_MAX_AGE_SEC : STABLE_AGE) + 8;
    const marketAt = source.endsWith("-market") ? now - STABLE_AGE + 8 : now;
    const db = briefDb(eurc(0.98, source === "usd-market" ? now : quoteAt), marketAt, source === "native-start" ? quoteAt : now - 86400, {
      fx: { peggedEUR: 1 },
      inc: { peak_deviation_bps: 500, quote_mode: native ? "native-peg" : "usd", start_price: 0.98, current_native_quote: source === "native-market" ? nativeQuote(0.98, now) : source === "native-current" ? nativeQuote(0.98, quoteAt) : null },
    });
    renderPng().mockImplementationOnce(async () => { clock.mockReturnValue((now + elapsed) * 1000); return makeScorecardImageFixture(); });
    const res = await briefing(db);
    expect(res?.status).toBe(elapsed < 8 ? 200 : 503);
    expect(cc(res)).toBe(elapsed < 8 ? "public, max-age=5, s-maxage=5" : "no-store");
    expect(drawn()).toContain("-200 bps");
  });

  it.each([
    ["native-peg", "conversion", 0.98, 30, "Reference market closed"], ["native-peg", "traded-pair", 0.98, 30, "-200 bps"],
    ["native-peg", "traded-pair", 0.75, 30, "-2500 bps"], ["native-peg", "traded-pair", 0.75, 90, "Reference market closed"],
    ["usd", null, 0.98, 30, "Reference market closed"], ["usd", null, 0.75, 30, "-2500 bps"],
  ] as const)("applies closed FX admission for %s with native derivation %s at %s aged %ss", async (quoteMode, derivation, nativePrice, age, copy) => {
    const now = 1_794_758_400; // Sun 16:00 UTC
    vi.setSystemTime(now * 1000);
    const db = briefDb(eurc(nativePrice * 1.1, now - 30), now - 30, now - 60, {
      fx: { peggedEUR: 1.1 }, inc: { peak_deviation_bps: 2500, quote_mode: quoteMode, start_price: 0.98, current_native_quote: derivation ? nativeQuote(nativePrice, now - age, derivation) : null },
    });
    const markup = await renderBriefing(db);
    expect(markup).toContain(`"${copy}"`);
    expect(markup).toContain("Peak -2500 bps");
  });

  it.each(["stale", "future", "explicit-null"] as const)("withholds a %s USD incident quote while retaining the historical peak", async (fault) => {
    const now = 1_795_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const quoteAt = fault === "explicit-null" ? null : fault === "future" ? now + 1 : now - STABLE_AGE - 1;
    const markup = await renderBriefing(briefDb(makeAsset({ price: 0.98, priceObservedAt: quoteAt, priceUpdatedAt: now }), now, now - 60, { inc: { peak_deviation_bps: 500 } }));
    expect(markup).toContain("Current unavailable");
    expect(markup).toContain("Peak -500 bps");
  });

  it("classifies long-running via effective onset while preserving raw fragment started_at for peak basis", async () => {
    const { db, sqlite } = fixtures.open();
    const now = FX_REOPEN_QUOTE_AT, firstStart = now - 40 * 86_400, fragStart = now - 120;
    vi.setSystemTime(now * 1000);
    seedCache(sqlite, [eurc(1.026, now)], now, { peggedEUR: 1.08 });
    seedEvent(sqlite, { id: 201, peak_deviation_bps: -400, started_at: firstStart, ended_at: fragStart - 60, start_price: 1.04, peak_price: 1.04, peg_reference: 1.08, peak_peg_reference: 1.08, peak_quote_domain: "usd", source: "live" });
    seedEvent(sqlite, { id: 202, started_at: fragStart, start_price: 1.026, peak_price: 1.026, peg_reference: 1.08, peak_peg_reference: 1.08, peak_quote_domain: "usd", source: "live", peer_basis_json: JSON.stringify({ peak: { basis: "peer-relative", observedAt: fragStart - 10, price: 1.026, pegReference: 1.08, bps: -500 } }) });
    seedLink(sqlite, `ddr2:${"c".repeat(32)}`, EURC, "EUR", 201, 202, firstStart, fragStart, 400, "d".repeat(64));
    const markup = await renderBriefing(db);
    for (const s of ["0 recent · 1 >30d", "Top 1 of 1 long-running (>30d)", '"Peak -500 bps"']) expect(markup).toContain(s);
    expect(markup).not.toContain("peer median");
  });

  it("ranks recent/escalating ahead of >30d, keeps -50.4 bps material, dedupes duplicate rows, and handles disputed/unlinked reopens", async () => {
    const now = nowSec(), d = 86_400;
    const mk = (id: string, symbol: string, price: number, mcap: number) => makeAsset({ id, symbol, price, priceObservedAt: now - 30, circulating: { peggedUSD: mcap } });
    const assets = [mk(USDT, "USDT", 0.98, 10e6), mk(USDC, "USDC", 0.95, 20e6), mk(DAI, "DAI", 0.7, 50e6), mk(FRAX, "FRAX", 0.999, 90e6)];
    const renderRows = (rows: Record<string, unknown>[], list = assets) =>
      renderBriefing(makeDepegDb([marketTable(list, now, { peggedUSD: 1 }), { match: "peak_deviation_bps", rows }]));

    const recent = await renderRows([openRow(1, USDT, "USDT", now - 2 * d, now, { peak_deviation_bps: -200 }), openRow(2, USDC, "USDC", now - 45 * d, now, { peak_escalated_at: now - d }), openRow(3, DAI, "DAI", now - 50 * d, now, { peak_deviation_bps: -3000 })]);
    expect(recent).toContain("2 recent · 1 >30d");
    expect(recent).toContain("Top 2 of 2 recent");
    expect(recent).not.toContain('"DAI"');
    expect(recent.indexOf('"USDC"')).toBeLessThan(recent.indexOf('"USDT"'));

    const fb = await renderRows([openRow(3, DAI, "DAI", now - 50 * d, now, { peak_deviation_bps: -3000 }), openRow(4, FRAX, "FRAX", now - 40 * d, now, { peak_deviation_bps: -400, last_trusted_price_at: null, price_coverage_json: null })]);
    expect(fb).toContain("0 recent · 2 >30d");
    expect(fb).toContain("Top 2 of 2 long-running (>30d)");
    expect(fb.indexOf('"DAI"')).toBeLessThan(fb.indexOf('"FRAX"'));

    const noCov = { peak_deviation_bps: -200, last_trusted_price_at: null, price_coverage_json: null };
    const rawMat = await renderRows([openRow(8, USDT, "USDT", now - 2 * d, now, noCov), openRow(9, FRAX, "FRAX", now - 2 * d, now, noCov)], [mk(USDT, "USDT", 0.99496, 1e6), mk(FRAX, "FRAX", 0.999, 90e6)]);
    expect(rawMat).toContain('"-50 bps"');
    expect(rawMat).toContain('"Unconfirmed"');
    expect(rawMat.indexOf('"USDT"')).toBeLessThan(rawMat.indexOf('"FRAX"'));

    const dupPair = [openRow(10, FRAX, "FRAX", now - 2 * d, now, { peak_deviation_bps: -300 }), openRow(11, FRAX, "FRAX", now - d, now, { peak_deviation_bps: -400 })];
    const dupOnly = await renderRows(dupPair);
    expect(dupOnly).toContain("2 recent · 0 >30d");
    expect(dupOnly).toContain("Top 1 of 2 recent");
    expect(dupOnly.split('"FRAX"').length - 1).toBe(1);
    const dupRanked = await renderRows([...dupPair, openRow(12, USDT, "USDT", now - 2 * d, now, { peak_deviation_bps: -200 })]);
    expect(dupRanked).toContain("3 recent · 0 >30d");
    expect(dupRanked).toContain("Top 2 of 3 recent");
    expect(dupRanked.indexOf('"USDT"')).toBeLessThan(dupRanked.indexOf('"FRAX"'));

    const future = await renderRows([openRow(5, USDT, "USDT", now + 60, now, { peak_deviation_bps: -200 })]);
    expect(future).toContain("Top 1 of 1 open events");
    expect(future).not.toContain("recent ·");
    const realEsc = await renderRows([openRow(6, USDT, "USDT", now - 40 * d, now, { peak_escalated_at: now - 899.5 })]);
    expect(realEsc).not.toContain("recent ·");
    const closedReal = await renderRows([openRow(7, USDT, "USDT", now - 40 * d, now, { linked_incident_json: JSON.stringify({ firstStartedAt: now - 45 * d, familyStats: { maxAnchorBps: 400, maxEscalatedAt: null, hasInvalidEscalationTs: 1 } }) })]);
    expect(closedReal).not.toContain("recent ·");

    const seedCard = (list: typeof assets) => {
      const { db, sqlite } = fixtures.open();
      seedCache(sqlite, list, now, { peggedUSD: 1 });
      const add = (id: number, coin: string, sym: string, started_at: number, ended_at: number | null, cov: string | null, last: number | null) =>
        seedEvent(sqlite, { id, stablecoin_id: coin, symbol: sym, peg_type: "peggedUSD", peak_deviation_bps: -300, started_at, ended_at, start_price: 0.97, peak_price: 0.97, source: "live", price_coverage_json: cov, last_trusted_price_at: last });
      return { db, sqlite, add };
    };
    const m4 = seedCard([assets[0], assets[3]]), cj = mkCov(now);
    m4.add(301, FRAX, "FRAX", now - 2 * d, null, cj, now - 30);
    m4.add(302, FRAX, "FRAX", now - d, null, cj, now - 30);
    m4.add(303, USDT, "USDT", now - 2 * d, null, cj, now - 30);
    seedProv(m4.sqlite, 302, { audit_verdict: "disputed" }, now - d);
    const m4Out = await renderBriefing(m4.db);
    expect(m4Out).toContain("2 recent · 0 >30d");
    expect(m4Out.indexOf('"USDT"')).toBeLessThan(m4Out.indexOf('"FRAX"'));

    const m8 = seedCard([assets[0]]);
    m8.add(401, USDT, "USDT", now - 40 * d, now - 7_200, null, null);
    m8.add(402, USDT, "USDT", now - 3_600, null, null, null);
    const m8Out = await renderBriefing(m8.db);
    expect(m8Out).toContain("0 recent · 1 >30d");
    expect(m8Out).toContain("Top 1 of 1 long-running (>30d)");
    expect(m8Out).toContain("0 new in 24h");
    m8.sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 402").run(now - 60);
    expect(await renderBriefing(m8.db)).toContain("0 new in 24h");
  });
});

describe("admitted dated scorecard rendering", () => {
  const now = 1_795_000_000, db = {} as D1Database;
  const ogCard = (id = USDC) => handleScorecardOg(db, id);
  const card = (id: string, score: number | null, grade: "A" | "NR" | null, ratingStatus: "rated" | "not-rated" | "pipeline-gap") => ({ id, score, grade, ratingStatus, partialEvidence: null });
  function snapshot(): activeSafetyScoreSource.SafetyScoreGradeSnapshot {
    const m = makeScorecardMetadataFixture(now);
    return {
      lifecycle: "active", safetyScoreIdentity: m.publication, methodology: { version: m.publication.methodologyVersion },
      asOfSec: m.asOfSec, updatedAt: m.publishedAtSec, publicationHealth: makeWorkerReportCardsV9Response({ updatedAt: m.publishedAtSec }).publicationHealth,
      completeness: { expectedCount: 1 }, cards: [card(USDC, 82, "A", "rated")],
      scorecardPillars: { id: USDC, ratings: { backing: { score: 90, grade: "A+" }, control: { score: 0, grade: "F" } } },
    };
  }
  const mockIndex = (src: activeSafetyScoreSource.ActiveSafetyScoreIndex = { kind: "v9", snapshot: snapshot() }) =>
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(src);
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    mockIndex();
    vi.spyOn(ogRenderer, "renderPng").mockResolvedValue(makeScorecardImageFixture());
    vi.spyOn(ogRenderer, "socialCardMeasurer").mockResolvedValue({ width: (t, _f, sz) => t.length * sz * 0.3 });
    mockLogo(() => new Response(logoSvg, { headers: { "Content-Type": "image/svg+xml" } }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("renders the published grade, available pillars, date and registered logo", async () => {
    const res = await ogCard();
    expect(res.status).toBe(200);
    const meta = scorecardMetadata(res);
    expect(meta.subject).toMatchObject({ score: 82, grade: "A", pillars: [{ id: "backing", score: 90, grade: "A+" }, { id: "control", score: 0, grade: "F" }] });
    expect(meta.publication.methodologyVersion).toBe("10.37");
    expect(meta.publication.publicationGenerationId).toBe(snapshot().safetyScoreIdentity.publicationGenerationId);
    expect(meta.imageSha256).toBe(sha256HexFromBytes(new Uint8Array(await res.arrayBuffer())));
    const out = drawn();
    for (const s of ["A", "82", "USDC", "USD Coin", "Backing", "90", "A+", "Economic control", "0", "F", "As of 18 Nov 2026"]) expect(out).toContain(`"${s}"`);
    expect(out).not.toContain('"Exit"');
    expect(out).toContain(`data:image/svg+xml;base64,${btoa(logoSvg)}`);
    expect(out).not.toMatch(/methodology|not live/i);
    expect(fetch).toHaveBeenCalledOnce();
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).toHaveBeenCalledTimes(2);
  });

  it.each<[string, () => MockFetchOutcome | Response]>([
    ["WebP", () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { headers: { "Content-Type": "image/webp" } })],
    ["mislabelled", () => new Response(logoSvg, { headers: { "Content-Type": "image/png" } })],
    ["missing", () => new Response("missing", { status: 404 })], ["unreachable", () => new Error("network down")],
  ])("draws the monogram when the logo is %s", async (_case, respond) => {
    mockLogo(respond);
    expect((await ogCard()).status).toBe(200);
    expect(drawn()).toContain("3px dashed");
    expect(drawn()).not.toMatch(/data:image\/(?:webp|png|svg\+xml;base64)/);
  });

  it("renders a complete overview with unavailable members disclosed and answers not-rated coins with 404", async () => {
    const src = snapshot();
    src.cards.push(card(USDT, null, null, "pipeline-gap"));
    src.completeness.expectedCount = 2;
    mockIndex({ kind: "v9", snapshot: src });
    const ov = await ogCard("safety-scores");
    expect(ov.status).toBe(200);
    expect(scorecardMetadata(ov).subject).toEqual({ kind: "overview", id: "safety-scores", ratedCount: 1, notRatedCount: 0, unavailableCount: 1, totalCount: 2, averageScore: 82 });
    const out = drawn();
    for (const s of ["Safety Scores", "82.0", "Mean rated score", "1 rated · 1 unavailable", "As of 18 Nov 2026"]) expect(out).toContain(`"${s}"`);
    expect(out).not.toMatch(/"children":"[A-F][+-]?"|not rated/);
    expect(fetch).not.toHaveBeenCalled();

    renderPng().mockClear();
    const nrSrc = snapshot();
    nrSrc.cards[0] = card(USDC, null, "NR", "not-rated");
    mockIndex({ kind: "v9", snapshot: nrSrc });
    const nr = await ogCard();
    expect(nr.status).toBe(404);
    expect(nr.headers.get(SOCIAL_SCORECARD_REASON_HEADER)).toBe("not-rated");
    expect(nr.headers.has("Retry-After") || nr.headers.has(META_HDR)).toBe(false);
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
  });

  it.each(["error", "held", "stale", "future", "stale-observation", "future-observation", "quarantined", "missing"])("fails closed before render for %s evidence", async (fault) => {
    const src = snapshot();
    let active: activeSafetyScoreSource.ActiveSafetyScoreIndex = { kind: "v9", snapshot: src };
    if (fault === "error") active = { kind: "error", reason: "missing", detail: "missing", snapshot: null };
    if (fault === "held") active = { kind: "held", reason: "v9-publication-held", detail: "held", snapshot: src };
    if (fault === "stale") src.updatedAt = now - MAX_AGE - 1;
    if (fault === "future") src.updatedAt = now + 1;
    if (fault === "stale-observation") src.asOfSec = now - MAX_AGE;
    if (fault === "future-observation") src.asOfSec = now + 1;
    if (fault === "quarantined") src.cards[0] = card(USDC, null, null, "pipeline-gap");
    if (fault === "missing") src.cards = [];
    mockIndex(active);
    const res = await ogCard();
    expect(res.status).toBe(503);
    expect(cc(res)).toBe("no-store");
    expect(res.headers.has(META_HDR)).toBe(false);
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
  });

  it.each(["expiry", "observation-expiry", "generation", "hold", "grade", "pillar"])("re-admits after rendering and refuses %s changes", async (fault) => {
    const initial = snapshot(), next = snapshot();
    if (fault === "observation-expiry") initial.asOfSec = next.asOfSec = now - MAX_AGE + 1;
    if (fault === "generation") next.safetyScoreIdentity = { ...next.safetyScoreIdentity, publicationGenerationId: "next-generation" };
    if (fault === "grade") next.cards[0].grade = "B+";
    if (fault === "pillar") next.scorecardPillars!.ratings.backing!.score--;
    mockIndex().mockResolvedValueOnce({ kind: "v9", snapshot: initial })
      .mockResolvedValueOnce(fault === "hold" ? { kind: "held", reason: "v9-publication-held", detail: "held", snapshot: next } : { kind: "v9", snapshot: next });
    renderPng().mockImplementation(async () => {
      if (fault === "expiry") vi.setSystemTime((initial.updatedAt + MAX_AGE + 1) * 1000);
      if (fault === "observation-expiry") vi.setSystemTime((now + 2) * 1000);
      return makeScorecardImageFixture();
    });
    const res = await ogCard();
    expect(res.status).toBe(503);
    expect(res.headers.has(META_HDR)).toBe(false);
  });

  it.each(["publication", "observation"] as const)("bounds cache lifetime by the remaining %s budget", async (clock) => {
    const src = snapshot();
    if (clock === "publication") src.updatedAt = now - MAX_AGE + 8;
    src.asOfSec = now - MAX_AGE + 8;
    mockIndex({ kind: "v9", snapshot: src });
    const res = await ogCard();
    expect(res.status).toBe(200);
    expect(cc(res)).toBe("public, max-age=7, s-maxage=7");
  });

  it("rejects unknown subjects and renderer failures without timeless fallback", async () => {
    expect((await ogCard("not-a-stablecoin")).status).toBe(404);
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).not.toHaveBeenCalled();
    renderPng().mockRejectedValue(new Error("Renderer failed"));
    const res = await ogCard();
    expect(res.status).toBe(503);
    expect(cc(res)).toBe("no-store");
  });
});
