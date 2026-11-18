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

// Node's harfbuzzjs is a promise that vitest's module interop cannot await; the measurer is stubbed below.
vi.mock("harfbuzzjs", () => ({ default: {} }));

function scorecardMetadata(response: Response) {
  return decodeSocialScorecardMetadata(response.headers.get(SOCIAL_SCORECARD_METADATA_HEADER));
}

const logoUrl = `${SITE_ORIGIN}/logos/2-usdc.svg`;
const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>';
const mockLogo = (respond: () => MockFetchOutcome | Response) => mockFetch([{ match: logoUrl, respond }], { requireMatch: true, strictUrl: true });
/** The element handed to the renderer, as searchable JSON (no-break spaces read as spaces). */
const drawn = () => JSON.stringify(vi.mocked(ogRenderer.renderPng).mock.calls[0][0]).replace(/\u00a0/g, " ");

const makeDepegDb = createMockD1Preset([
  { match: "FROM cache WHERE key = ?", rows: [], first: null },
  { match: "peak_deviation_bps", rows: [] },
  { match: "ended_at IS NOT NULL", rows: [] },
  { match: "COUNT(*) as count", first: { count: 0 }, rows: [] },
]);

function marketTable(assets: StablecoinData[], updatedAt: number, fxFallbackRates?: Record<string, number>): MockTableConfig {
  return {
    match: "FROM cache WHERE key = ?",
    rows: [{ key: "stablecoins", updated_at: updatedAt, value: JSON.stringify({ peggedAssets: assets, fxFallbackRates }) }],
  };
}

function incidentTable(asset: Pick<StablecoinData, "id" | "symbol" | "pegType">, startedAt: number, overrides: Record<string, unknown> = {}): MockTableConfig {
  return { match: "peak_deviation_bps", rows: [{
    stablecoin_id: asset.id, symbol: asset.symbol, peg_type: asset.pegType, direction: "below",
    peak_deviation_bps: -500, peg_reference: 1, source: "live", started_at: startedAt, ...overrides,
  }] };
}

function nativeQuote(value: number, observedAt: number, kind: "traded-pair" | "conversion" = "traded-pair") {
  const lineage = kind === "traded-pair"
    ? { venue: "fixture-exchange", pair: "EURC/EUR" }
    : { fxSource: "fixture-fixing", fxObservedAtSec: observedAt };
  return JSON.stringify({ value, observedAt, source: "coingecko", derivation: { kind, lineage } });
}

describe("dated depeg briefing", () => {
  const nativeQuoteFixtures = createLatestSchemaFixtureTracker();
  const briefing = (db: D1Database) => handleOg(db, API_PATHS.ogDepegBriefing());
  async function renderBriefing(db: D1Database) {
    expect((await briefing(db))?.status).toBe(200);
    return drawn();
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_795_017_600 * 1000);
    vi.spyOn(ogRenderer, "renderPng").mockResolvedValue(makeScorecardImageFixture());
    vi.spyOn(ogRenderer, "socialCardMeasurer").mockResolvedValue({ width: (text, _face, size) => text.length * size * 0.3 });
  });
  afterEach(() => { nativeQuoteFixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["WHERE e.ended_at IS NULL", "WHERE e.ended_at IS NOT NULL"])("rejects failed ledger results for %s", async marker => {
    const db = makeDepegDb();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes(marker)) Object.assign(statement, {
        bind: () => statement, all: async () => ({ success: false, results: [] }),
      });
      return statement;
    });
    const response = await briefing(db);
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe("incident-ledger-unavailable");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
  });

  it("counts recoveries in the past day by their admitted observation clock", async () => {
    const { db, sqlite } = nativeQuoteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peg_reference,
       recovery_price, recovery_peg_reference, close_reason, last_trusted_price_at, price_coverage_json)
      VALUES ('eurs-stasis', 'EURS', 'peggedEUR', 'below', -300, ?, ?, 1.067, 1.1, 1.1, 1.1, 'recovered-primary', ?, ?)`);
    for (const [end, atPar] of [[now - 60, true], [now - 300, false], [now - 86400 + 60, true]] as const) {
      const last = end - 900;
      insert.run(last - 900, end, last, JSON.stringify({ intervals: [[last - 900, last]], atParIntervals: atPar ? [[last, last]] : [] }));
    }
    expect(await renderBriefing(db)).toContain("1 recovered in 24h");
  });

  it("counts canonical openings and terminal recoveries across incident fragments", async () => {
    const { db, sqlite } = nativeQuoteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const start = now - 26 * 3600;
    const restart = now - 3600;
    const key = `ddr2:${"a".repeat(32)}`;
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
      VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -300, ?, 0.97, 1)`);
    insert.run(101, start);
    insert.run(102, restart);
    insert.run(103, restart + 1);
    sqlite.prepare(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, audit_verdict, created_at, updated_at)
      VALUES (103, 'live', 'disputed', ?, ?)`).run(restart, restart);
    sqlite.prepare("UPDATE depeg_events SET ended_at = ?, close_reason = 'recovered-primary', recovery_price = 1 WHERE id = 101").run(now - 3 * 3600);
    sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at)
      VALUES (?, 101, 'observed', ?), (?, 102, 'observed', ?)`).run(key, start, key, restart);
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents (incident_key, stablecoin_id, peg_currency, direction, first_event_id,
      current_event_id, first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, 'usdt-tether', 'USD', 'below', 101, 102, ?, ?, 300, ?, ?, ?)`).run(key, start, restart, "b".repeat(64), start, restart);
    const open = await renderBriefing(db);
    expect(open).toContain("Top 1 of 1 open incidents");
    expect(open).toContain("0 new in 24h");
    expect(open).toContain("0 recovered in 24h");

    sqlite.prepare("UPDATE depeg_events SET ended_at = ?, close_reason = 'recovered-primary', recovery_price = 1 WHERE id = 102").run(now - 60);
    vi.mocked(ogRenderer.renderPng).mockClear();
    const recovered = await renderBriefing(db);
    expect(recovered).toContain("0 new in 24h");
    expect(recovered).toContain("1 recovered in 24h");
  });

  it.each(["currentPriceUnavailable", "pegReferenceUnavailable", "currentDeviationBps"] as const)("honors unavailability from published %s", async (field) => {
    const now = Math.floor(Date.now() / 1000);
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98, priceObservedAt: now - 60, currentPeg: {
      currentDeviationBps: field === "currentDeviationBps" ? null : -200,
      currentPriceUnavailable: field === "currentPriceUnavailable",
      pegReferenceUnavailable: field === "pegReferenceUnavailable",
      pegReference: null, primaryTrust: "unusable", dexPriceCheck: null,
    } });
    const db = makeDepegDb([
      marketTable([asset], now, { peggedUSD: 1 }),
      incidentTable(asset, now - 600),
    ]);
    const markup = await renderBriefing(db);
    expect(markup).toContain("Current unavailable");
    expect(markup).toContain("Peak -500 bps");
    expect(markup).not.toContain("-200 bps");
  });

  it("labels a validated peer peak separately from the current benchmark deviation", async () => {
    const { db, sqlite } = nativeQuoteFixtures.open();
    const now = FX_REOPEN_QUOTE_AT;
    vi.setSystemTime(now * 1000);
    const start = now - 60;
    const asset = makeAsset({ id: "eurc-circle", symbol: "EURC", pegType: "peggedEUR", price: 1.026, priceObservedAt: now });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(JSON.stringify({ peggedAssets: [asset], fxFallbackRates: { peggedEUR: 1.026 } }), now);
    sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price,
       peg_reference, peak_peg_reference, peak_quote_domain, peer_basis_json, source)
      VALUES (1, 'eurc-circle', 'EURC', 'peggedEUR', 'below', -500, ?, 1.026, 1.026, 1.08, 1.08, 'usd', ?, 'live')`)
      .run(start, JSON.stringify({ peak: { basis: "peer-relative", observedAt: start, price: 1.026, pegReference: 1.08, bps: -500 } }));
    const peer = await renderBriefing(db);
    expect(peer).toContain('"0 bps"');
    expect(peer).toContain('"Peak -500 bps vs peer median"');
    expect(peer).toContain('Peer median $1.0800 · Lower confidence');

    sqlite.prepare("UPDATE depeg_events SET peak_peg_reference = 1.07 WHERE id = 1").run();
    vi.mocked(ogRenderer.renderPng).mockClear();
    const benchmark = await renderBriefing(db);
    expect(benchmark).toContain('"Peak -500 bps"');
    expect(benchmark).not.toContain("peer median");
  });

  it.each([
    ["EURC", "eurc-circle", "peggedEUR", 1.1, true],
    ["USDT", "usdt-tether", "peggedUSD", 1, undefined],
  ] as const)("keeps %s legacy fallback and honors its refusal in a mixed publication", async (symbol, id, pegType, reference, legacyFxReference) => {
    const now = FX_REOPEN_QUOTE_AT;
    vi.setSystemTime(now * 1000);
    const asset = makeAsset({ id, symbol, pegType, price: reference * 0.98, priceObservedAt: now,
      currentPeg: { currentDeviationBps: -200, currentPriceUnavailable: false, pegReferenceUnavailable: false,
        legacyFxReference, pegReference: legacyFxReference ? { source: "fx", valueUsd: reference, asOf: now, contributorCount: 0 } : null,
        primaryTrust: "unusable", dexPriceCheck: null } });
    for (const refused of [false, true]) {
      asset.currentPeg!.pegReferenceUnavailable = refused;
      const db = makeDepegDb([
        { match: "FROM cache WHERE key = ?", rows: [{ key: "stablecoins", updated_at: now, value: JSON.stringify({
          peggedAssets: [asset], fxFallbackRates: { peggedEUR: 1.1 }, fxReferenceObservations: {},
        }) }] },
        incidentTable(asset, now - 600, { peg_reference: reference }),
      ]);
      vi.mocked(ogRenderer.renderPng).mockClear();
      expect(await renderBriefing(db)).toContain(refused ? "Current unavailable" : "-200 bps");
    }
  });

  it.each([["stale-reference", null, "Reference not yet updated"], ["admitted", 0, "0 bps"]] as const)(
    "uses the %s USD projection through the published cache",
    async (status, expected, copy) => {
      const now = FX_REOPEN_QUOTE_AT;
      vi.setSystemTime(now * 1000);
      const asset = {
        ...makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price: 1.122, priceObservedAt: now }),
        currentPeg: makeFxCurrentPeg(status, expected),
      };
      const db = makeDepegDb([
        marketTable([asset], now, { peggedEUR: 1.1 }),
        incidentTable(asset, now - 60, { symbol: "EURC", direction: "above", peg_reference: 1.1, peak_deviation_bps: 500 }),
      ]);
      const markup = await renderBriefing(db);
      expect(markup).toContain(copy);
      expect(markup).toContain("Peak 500 bps");
      expect(markup).not.toContain("+200 bps");
    },
  );

  it.each([false, true])("keeps an unavailable new-event count distinct from observed zero; observed=%s", async (observed) => {
    const db = makeDepegDb([
      { match: "COUNT(*) as count", rows: [], first: observed ? { count: 0 } : null },
    ]);
    const markup = await renderBriefing(db);
    expect(db.getHistory().some(({ sql }) => /stress_signal|stability_index_samples/.test(sql))).toBe(false);
    expect(markup).not.toContain("DEWS DISTRIBUTION");
    expect(markup).toContain(observed ? "0 new in 24h" : "New in 24h unavailable");
  });

  it.each([
    ["native current", "live", "native-peg", "fresh", 86400, 1, -200],
    ["native inferred", "live", null, "fresh", 86400, 1, -200],
    ["native provenance", "backfill", "native-peg", "fresh", 86400, 1, -200],
    ["native start", "live", "native-peg", "missing", 60, 1, -200],
    ["native missing", "live", "native-peg", "missing", 86400, 1, null],
    ["native expired", "live", "native-peg", "expired", 86400, 1, null],
    ["legacy USD reference", "backfill", null, "fresh", 86400, 1.1, 0],
    ["explicit USD provenance", "live", "usd", "fresh", 86400, 1, 0], // today's EUR reference, not the stored 1
  ] as const)("renders %s in its event domain from joined SQLite evidence", async (_label, source, quoteMode, quoteState, startAge, reference, expectedBps) => {
    const { db, sqlite } = nativeQuoteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const asset = makeAsset({ id: "eurc-circle", symbol: "EURC", pegType: "peggedEUR", price: 1.1, priceObservedAt: now });
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)")
      .run(JSON.stringify({ peggedAssets: [asset], fxFallbackRates: { peggedEUR: 1.1 } }), now);
    sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
      VALUES (101, 'eurc-circle', 'EURC', 'peggedEUR', 'below', -500, ?, 0.98, 0.95, ?, ?)`)
      .run(now - startAge, reference, source);
    if (quoteMode != null) sqlite.prepare(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, quote_mode, created_at, updated_at) VALUES (101, ?, ?, ?, ?)`)
      .run(source, quoteMode, now, now);
    const quoteAt = quoteState === "expired" ? now - PSI_NATIVE_EVIDENCE_MAX_AGE_SEC : now - 30;
    if (quoteState !== "missing") sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}101`, nativeQuote(0.98, quoteAt), quoteAt);
    const markup = await renderBriefing(db);
    expect(markup).toContain("Peak -500 bps");
    if (_label.startsWith("native")) expect(markup).toContain("EURC (native peg)");
    if (expectedBps == null) expect(markup).toContain("Current unavailable");
    else expect(markup).toContain(`${expectedBps > 0 ? "+" : ""}${expectedBps} bps`);
    if (expectedBps === -200) {
      expect(markup).not.toContain("+1000 bps");
      const observedAt = startAge === 60 ? now - startAge : quoteAt;
      expect(markup).toContain(new Date(observedAt * 1000).toISOString().slice(0, 16).replace("T", " "));
    }
  });

  it.each([
    ["native-current", 3], ["native-current", 9],
    ["native-start", 3], ["native-start", 9],
    ["usd-quote", 3], ["usd-quote", 9],
    ["usd-market", 3], ["usd-market", 9],
    ["native-market", 3], ["native-market", 9],
  ] as const)("bounds %s evidence by its own expiry after %ss rendering", async (source, elapsed) => {
    const now = 1_795_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const native = source.startsWith("native");
    const quoteAt = now - (native ? PSI_NATIVE_EVIDENCE_MAX_AGE_SEC : API_FRESHNESS_MAX_AGE_SEC.stablecoins) + 8;
    const marketAt = source.endsWith("-market") ? now - API_FRESHNESS_MAX_AGE_SEC.stablecoins + 8 : now;
    const asset = makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price: 0.98,
      priceObservedAt: source === "usd-market" ? now : quoteAt });
    const db = makeDepegDb([
      marketTable([asset], marketAt, { peggedEUR: 1 }),
      incidentTable(asset, source === "native-start" ? quoteAt : now - 86400, {
        symbol: "EURC", peak_deviation_bps: 500, quote_mode: native ? "native-peg" : "usd", start_price: 0.98,
        current_native_quote: source === "native-market" ? nativeQuote(0.98, now)
          : source === "native-current" ? nativeQuote(0.98, quoteAt) : null,
      }),
    ]);
    vi.mocked(ogRenderer.renderPng).mockImplementationOnce(async () => {
      clock.mockReturnValue((now + elapsed) * 1000);
      return makeScorecardImageFixture();
    });
    const response = await briefing(db);
    expect(response?.status).toBe(elapsed < 8 ? 200 : 503);
    expect(response?.headers.get("Cache-Control")).toBe(elapsed < 8 ? "public, max-age=5, s-maxage=5" : "no-store");
    expect(drawn()).toContain("-200 bps");
  });

  it.each([
    ["native-peg", "conversion", 0.98, 30, "Reference market closed"],
    ["native-peg", "traded-pair", 0.98, 30, "-200 bps"],
    ["native-peg", "traded-pair", 0.75, 30, "-2500 bps"],
    ["native-peg", "traded-pair", 0.75, 90, "Reference market closed"],
    ["usd", null, 0.98, 30, "Reference market closed"],
    ["usd", null, 0.75, 30, "-2500 bps"],
  ] as const)("applies closed FX admission for %s with native derivation %s at %s aged %ss", async (quoteMode, derivation, nativePrice, age, copy) => {
    const now = 1_794_758_400; // Sunday 16:00 UTC.
    vi.setSystemTime(now * 1000);
    const asset = makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price: nativePrice * 1.1, priceObservedAt: now - 30 });
    const db = makeDepegDb([
      marketTable([asset], now - 30, { peggedEUR: 1.1 }),
      incidentTable(asset, now - 60, {
        symbol: "EURC", peak_deviation_bps: 2500, quote_mode: quoteMode, start_price: 0.98,
        current_native_quote: derivation ? nativeQuote(nativePrice, now - age, derivation) : null,
      }),
    ]);
    const markup = await renderBriefing(db);
    expect(markup).toContain(`"${copy}"`);
    expect(markup).toContain("Peak -2500 bps");
  });

  it.each(["stale", "future", "explicit-null"] as const)("withholds a %s USD incident quote while retaining the historical peak", async (fault) => {
    const now = 1_795_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const quoteAt = fault === "explicit-null" ? null : fault === "future" ? now + 1 : now - API_FRESHNESS_MAX_AGE_SEC.stablecoins - 1;
    const asset = makeAsset({ price: 0.98, priceObservedAt: quoteAt, priceUpdatedAt: now });
    const db = makeDepegDb([
      marketTable([asset], now),
      incidentTable(asset, now - 60, { peak_deviation_bps: 500 }),
    ]);
    const markup = await renderBriefing(db);
    expect(markup).toContain("Current unavailable");
    expect(markup).toContain("Peak -500 bps");
  });
});

describe("admitted dated scorecard rendering", () => {
  const now = 1_795_000_000;
  const db = {} as D1Database;
  function snapshot(): activeSafetyScoreSource.SafetyScoreGradeSnapshot {
    const metadata = makeScorecardMetadataFixture(now);
    return {
      lifecycle: "active", safetyScoreIdentity: metadata.publication,
      methodology: { version: metadata.publication.methodologyVersion },
      asOfSec: metadata.asOfSec, updatedAt: metadata.publishedAtSec,
      publicationHealth: makeWorkerReportCardsV9Response({ updatedAt: metadata.publishedAtSec }).publicationHealth,
      completeness: { expectedCount: 1 },
      cards: [{ id: "usdc-circle", score: 82, grade: "A", ratingStatus: "rated", partialEvidence: null }],
      scorecardPillars: { id: "usdc-circle", ratings: { backing: { score: 90, grade: "A+" }, control: { score: 0, grade: "F" } } },
    };
  }
  function mockIndex(source: activeSafetyScoreSource.ActiveSafetyScoreIndex = { kind: "v9", snapshot: snapshot() }) {
    return vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(source);
  }
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    mockIndex();
    vi.spyOn(ogRenderer, "renderPng").mockResolvedValue(makeScorecardImageFixture());
    vi.spyOn(ogRenderer, "socialCardMeasurer").mockResolvedValue({ width: (text, _face, size) => text.length * size * 0.3 });
    mockLogo(() => new Response(logoSvg, { headers: { "Content-Type": "image/svg+xml" } }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("renders the published grade, available pillars, date and registered logo", async () => {
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    const metadata = scorecardMetadata(response);
    expect(metadata.subject).toMatchObject({ score: 82, grade: "A", pillars: [
      { id: "backing", score: 90, grade: "A+" }, { id: "control", score: 0, grade: "F" },
    ] });
    expect(metadata.publication.methodologyVersion).toBe("10.37");
    expect(metadata.publication.publicationGenerationId).toBe(snapshot().safetyScoreIdentity.publicationGenerationId);
    expect(metadata.imageSha256).toBe(sha256HexFromBytes(new Uint8Array(await response.arrayBuffer())));
    const card = drawn();
    for (const shown of ["A", "82", "USDC", "USD Coin", "Backing", "90", "A+", "Economic control", "0", "F", "As of 18 Nov 2026"]) expect(card).toContain(`"${shown}"`);
    expect(card).not.toContain('"Exit"');
    expect(card).toContain(`data:image/svg+xml;base64,${btoa(logoSvg)}`);
    expect(card).not.toMatch(/methodology|not live/i);
    expect(fetch).toHaveBeenCalledOnce();
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).toHaveBeenCalledTimes(2);
  });

  it.each<[string, () => MockFetchOutcome | Response]>([
    ["WebP", () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { headers: { "Content-Type": "image/webp" } })],
    ["mislabelled", () => new Response(logoSvg, { headers: { "Content-Type": "image/png" } })],
    ["missing", () => new Response("missing", { status: 404 })],
    ["unreachable", () => new Error("network down")],
  ])("draws the monogram when the logo is %s", async (_case, respond) => {
    mockLogo(respond);
    expect((await handleScorecardOg(db, "usdc-circle")).status).toBe(200);
    expect(drawn()).toContain("3px dashed");
    expect(drawn()).not.toMatch(/data:image\/(?:webp|png|svg\+xml;base64)/);
  });

  it("renders a complete overview with unavailable members disclosed and no aggregate letter", async () => {
    const source = snapshot();
    source.cards.push({ id: "usdt-tether", score: null, grade: null, ratingStatus: "pipeline-gap", partialEvidence: null });
    source.completeness.expectedCount = 2;
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "safety-scores");
    expect(response.status).toBe(200);
    expect(scorecardMetadata(response).subject).toEqual({ kind: "overview", id: "safety-scores", ratedCount: 1, notRatedCount: 0, unavailableCount: 1, totalCount: 2, averageScore: 82 });
    const card = drawn();
    for (const shown of ["Safety Scores", "82.0", "Mean rated score", "1 rated · 1 unavailable", "As of 18 Nov 2026"]) expect(card).toContain(`"${shown}"`);
    expect(card).not.toMatch(/"children":"[A-F][+-]?"|not rated/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers a not-rated coin with a machine-readable reason instead of dating a grade it lacks", async () => {
    const source = snapshot();
    source.cards[0] = { id: "usdc-circle", score: null, grade: "NR", ratingStatus: "not-rated", partialEvidence: null };
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(404);
    expect(response.headers.get(SOCIAL_SCORECARD_REASON_HEADER)).toBe("not-rated");
    expect(response.headers.has("Retry-After") || response.headers.has(SOCIAL_SCORECARD_METADATA_HEADER)).toBe(false);
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
  });

  it.each(["error", "held", "stale", "future", "stale-observation", "future-observation", "quarantined", "missing"])("fails closed before render for %s evidence", async (fault) => {
    const source = snapshot();
    let active: activeSafetyScoreSource.ActiveSafetyScoreIndex = { kind: "v9", snapshot: source };
    if (fault === "error") active = { kind: "error", reason: "missing", detail: "missing", snapshot: null };
    if (fault === "held") active = { kind: "held", reason: "v9-publication-held", detail: "held", snapshot: source };
    if (fault === "stale") source.updatedAt = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1;
    if (fault === "future") source.updatedAt = now + 1;
    if (fault === "stale-observation") source.asOfSec = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
    if (fault === "future-observation") source.asOfSec = now + 1;
    if (fault === "quarantined") source.cards[0] = { id: "usdc-circle", score: null, grade: null, ratingStatus: "pipeline-gap", partialEvidence: null };
    if (fault === "missing") source.cards = [];
    mockIndex(active);
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has(SOCIAL_SCORECARD_METADATA_HEADER)).toBe(false);
    expect(ogRenderer.renderPng).not.toHaveBeenCalled();
  });

  it.each(["expiry", "observation-expiry", "generation", "hold", "grade", "pillar"])("re-admits after rendering and refuses %s changes", async (fault) => {
    const initial = snapshot();
    const next = snapshot();
    if (fault === "observation-expiry") initial.asOfSec = next.asOfSec = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1;
    if (fault === "generation") next.safetyScoreIdentity = { ...next.safetyScoreIdentity, publicationGenerationId: "next-generation" };
    if (fault === "grade") next.cards[0].grade = "B+";
    if (fault === "pillar") next.scorecardPillars!.ratings.backing!.score--;
    mockIndex().mockResolvedValueOnce({ kind: "v9", snapshot: initial })
      .mockResolvedValueOnce(fault === "hold" ? { kind: "held", reason: "v9-publication-held", detail: "held", snapshot: next } : { kind: "v9", snapshot: next });
    vi.mocked(ogRenderer.renderPng).mockImplementation(async () => {
      if (fault === "expiry") vi.setSystemTime((initial.updatedAt + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1) * 1000);
      if (fault === "observation-expiry") vi.setSystemTime((now + 2) * 1000);
      return makeScorecardImageFixture();
    });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(503);
    expect(response.headers.has(SOCIAL_SCORECARD_METADATA_HEADER)).toBe(false);
  });

  it.each(["publication", "observation"] as const)("bounds cache lifetime by the remaining %s budget", async (clock) => {
    const source = snapshot();
    if (clock === "publication") source.updatedAt = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 8;
    source.asOfSec = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 8;
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=7, s-maxage=7");
  });

  it("rejects unknown subjects and renderer failures without timeless fallback", async () => {
    expect((await handleScorecardOg(db, "not-a-stablecoin")).status).toBe(404);
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).not.toHaveBeenCalled();
    vi.mocked(ogRenderer.renderPng).mockRejectedValue(new Error("Renderer failed"));
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
