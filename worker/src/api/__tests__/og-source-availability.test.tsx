import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import satoriStandalone from "satori/standalone";
import { createMockD1Preset, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { PSI_NATIVE_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/depeg-quote-domain";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../../lib/native-peg-quote-cache";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { handleOg } from "../og";
import * as ogRenderer from "../../lib/og-render";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { makeScorecardImageFixture, makeScorecardMetadataFixture } from "@shared/test-utils/social-scorecard";
import { decodeSocialScorecardMetadata, SOCIAL_SCORECARD_METADATA_HEADER } from "@shared/lib/social-scorecard";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { handleScorecardOg } from "../og-scorecard";
import { DepegCard, type DepegCardData } from "../../lib/og-templates/depeg-card";
import type { ReactElement } from "react";
import type { StablecoinData } from "@shared/types/supply";

vi.mock("satori/standalone", () => ({ init: vi.fn(), default: vi.fn(async () => "<svg></svg>") }));

const nativeQuoteFixtures = createLatestSchemaFixtureTracker();
// Wednesday 16:00 UTC: the FX reference market is open, so an EUR fixture reads a
// live deviation instead of a closed-market hold.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_795_017_600 * 1000);
});
afterEach(() => {
  nativeQuoteFixtures.closeAll();
  ogRenderer.resetOgWasmInitializationForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function lastDepegElement() {
  const calls = vi.mocked(satoriStandalone).mock.calls;
  return calls[calls.length - 1][0] as ReactElement<{ data: DepegCardData }>;
}

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

function nativeQuote(value: number, observedAt: number) {
  return JSON.stringify({ value, observedAt, source: "coingecko" });
}

function scorecardMetadata(response: Response) {
  return decodeSocialScorecardMetadata(response.headers.get(SOCIAL_SCORECARD_METADATA_HEADER));
}

describe("depeg OG independent source availability", () => {
  it.each([false, true])("keeps an unavailable new-event count distinct from observed zero; observed=%s", async (observed) => {
    const db = makeDepegDb([
      { match: "COUNT(*) as count", rows: [], first: observed ? { count: 0 } : null },
    ]);
    const response = await handleOg(db, "/api/og/depeg");
    expect(response?.status).toBe(200);
    const element = lastDepegElement();
    expect(element.type).toBe(DepegCard);
    expect(db.getHistory().some(({ sql }) => /stress_signal|stability_index_samples/.test(sql))).toBe(false);
    expect(element.props.data.newToday).toBe(observed ? 0 : null);
    const markup = renderToStaticMarkup(element);
    expect(markup).not.toContain("DEWS DISTRIBUTION");
    expect(markup).toContain(observed ? "0 new today" : "\u2014 new today");
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
    expect((await handleOg(db, "/api/og/depeg"))?.status).toBe(200);
    const element = lastDepegElement();
    expect(element.props.data.activeDepegs).toEqual([
      expect.objectContaining({ symbol: "EURC", deviationBps: expectedBps, peakBps: -500 }),
    ]);
    const markup = renderToStaticMarkup(element);
    if (expectedBps == null) expect(markup).toContain("Current unavailable; peak -500 bps");
    else expect(markup).toContain(`${expectedBps > 0 ? "+" : ""}${expectedBps} bps`);
    if (expectedBps === -200) {
      expect(markup).not.toContain("+1000 bps");
      const observedAt = startAge === 60 ? now - startAge : quoteAt;
      expect(element.props.data.lastUpdated).toContain(new Date(observedAt * 1000).toISOString().slice(0, 16).replace("T", " "));
    }
  });

  it.each([
    ["native-current", 3], ["native-current", 9],
    ["native-start", 3], ["native-start", 9],
    ["usd-quote", 3], ["usd-quote", 9],
    ["usd-market", 3], ["usd-market", 9],
  ] as const)("bounds %s evidence by its own expiry after %ss rendering", async (source, elapsed) => {
    const now = 1_795_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const native = source.startsWith("native");
    const quoteAt = now - (native ? PSI_NATIVE_EVIDENCE_MAX_AGE_SEC : API_FRESHNESS_MAX_AGE_SEC.stablecoins) + 8;
    const marketAt = source === "usd-market" ? now - API_FRESHNESS_MAX_AGE_SEC.stablecoins + 8 : now;
    const db = makeDepegDb([
      marketTable([makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price: 0.98,
        priceObservedAt: source === "usd-market" ? now : quoteAt })], marketAt, { peggedEUR: 1 }),
      { match: "peak_deviation_bps", rows: [{
        stablecoin_id: "eurc-circle", symbol: "EURC", direction: "below", peak_deviation_bps: 500,
        peg_reference: 1, peg_type: "peggedEUR", source: "live", quote_mode: native ? "native-peg" : "usd",
        started_at: source === "native-start" ? quoteAt : now - 86400, start_price: 0.98,
        current_native_quote: source === "native-current" ? nativeQuote(0.98, quoteAt) : null,
      }] },
    ]);
    vi.mocked(satoriStandalone).mockImplementationOnce(async () => {
      clock.mockReturnValue((now + elapsed) * 1000);
      return "<svg></svg>";
    });
    const response = await handleOg(db, "/api/og/v2/depeg");
    expect(response?.status).toBe(elapsed < 8 ? 200 : 503);
    expect(response?.headers.get("Cache-Control")).toBe(elapsed < 8 ? "public, max-age=5, s-maxage=5" : "no-store");
    expect(lastDepegElement().props.data.activeDepegs[0].deviationBps).toBe(-200);
  });

  it.each([
    ["native-peg", false], ["native-peg", true], ["usd", false], ["usd", true],
  ] as const)("holds closed FX reference drift but keeps severe moves in %s quotes; severe=%s", async (quoteMode, severe) => {
    const now = 1_794_758_400; // Sunday 16:00 UTC.
    vi.setSystemTime(now * 1000);
    const native = quoteMode === "native-peg";
    const nativePrice = severe ? 0.75 : 0.98;
    const db = makeDepegDb([
      marketTable([makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price: nativePrice * 1.1,
        priceObservedAt: now - 30 })], now - 30, { peggedEUR: 1.1 }),
      { match: "peak_deviation_bps", rows: [{
        stablecoin_id: "eurc-circle", symbol: "EURC", direction: "below", peak_deviation_bps: 2500,
        peg_reference: 1, peg_type: "peggedEUR", source: "live", quote_mode: quoteMode, started_at: now - 86400,
        current_native_quote: native ? nativeQuote(nativePrice, now - 30) : null,
      }] },
    ]);
    expect((await handleOg(db, "/api/og/v2/depeg"))?.status).toBe(200);
    const element = lastDepegElement();
    expect(element.props.data.activeDepegs[0]).toMatchObject({ deviationBps: severe ? -2500 : null, peakBps: -2500 });
    if (severe) {
      expect(element.props.data.activeDepegs[0].deviationHeld).toBeUndefined();
      expect(renderToStaticMarkup(element)).toContain("-2500 bps");
    } else {
      expect(element.props.data.activeDepegs[0].deviationHeld).toBe(true);
      expect(renderToStaticMarkup(element)).toContain("Reference market closed; peak -2500 bps");
    }
  });

  it.each(["stale", "future"] as const)("withholds a %s USD incident quote while retaining the historical peak", async (fault) => {
    const now = 1_795_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const quoteAt = fault === "future" ? now + 1 : now - API_FRESHNESS_MAX_AGE_SEC.stablecoins - 1;
    const db = makeDepegDb([
      marketTable([makeAsset({ price: 0.98, priceObservedAt: quoteAt })], now),
      { match: "peak_deviation_bps", rows: [{ stablecoin_id: "usdt-tether", symbol: "USDT", direction: "below",
        peg_reference: 1, peg_type: "peggedUSD", peak_deviation_bps: 500, source: "live", started_at: now - 60 }] },
    ]);
    expect((await handleOg(db, "/api/og/v2/depeg"))?.status).toBe(200);
    const element = lastDepegElement();
    expect(element.props.data.activeDepegs[0]).toMatchObject({ deviationBps: null, peakBps: -500 });
    expect(renderToStaticMarkup(element)).toContain("Current unavailable; peak -500 bps");
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
    };
  }
  function mockIndex(source: activeSafetyScoreSource.ActiveSafetyScoreIndex = { kind: "v9", snapshot: snapshot() }) {
    return vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue(source);
  }
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    mockIndex();
    vi.spyOn(ogRenderer, "renderPng").mockResolvedValue(makeScorecardImageFixture());
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders the published hysteresis grade and served methodology, date and full identity", async () => {
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    const metadata = scorecardMetadata(response);
    expect(metadata.subject).toMatchObject({ score: 82, grade: "A" });
    expect(metadata.publication.methodologyVersion).toBe("10.37");
    expect(metadata.publication.publicationGenerationId).toBe(snapshot().safetyScoreIdentity.publicationGenerationId);
    expect(metadata.imageSha256).toBe(sha256HexFromBytes(new Uint8Array(await response.arrayBuffer())));
    const markup = renderToStaticMarkup(vi.mocked(ogRenderer.renderPng).mock.calls[0][0]);
    expect(markup).toContain("Published grade");
    expect(markup).toContain("Methodology v10.37");
    expect(markup).toContain(new Date(metadata.asOfSec * 1000).toISOString().slice(0, 10));
    expect(activeSafetyScoreSource.loadActiveSafetyScoreIndex).toHaveBeenCalledTimes(2);
  });

  it("renders a complete overview with unavailable members disclosed and no aggregate letter", async () => {
    const source = snapshot();
    source.cards.push({ id: "usdt-tether", score: null, grade: null, ratingStatus: "pipeline-gap", partialEvidence: null });
    source.completeness.expectedCount = 2;
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "safety-scores");
    expect(response.status).toBe(200);
    expect(scorecardMetadata(response).subject).toEqual({ kind: "overview", id: "safety-scores", ratedCount: 1, notRatedCount: 0, unavailableCount: 1, totalCount: 2, averageScore: 82 });
    const markup = renderToStaticMarkup(vi.mocked(ogRenderer.renderPng).mock.calls[0][0]);
    expect(markup).toContain("Mean rated score");
    expect(markup).not.toContain("Published grade");
  });

  it("preserves an admitted NR without inventing a score", async () => {
    const source = snapshot();
    source.cards[0] = { id: "usdc-circle", score: null, grade: "NR", ratingStatus: "not-rated", partialEvidence: null };
    mockIndex({ kind: "v9", snapshot: source });
    const response = await handleScorecardOg(db, "usdc-circle");
    expect(response.status).toBe(200);
    expect(scorecardMetadata(response).subject).toMatchObject({ score: null, grade: "NR" });
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

  it.each(["expiry", "observation-expiry", "generation", "hold", "grade"])("re-admits after rendering and refuses %s changes", async (fault) => {
    const initial = snapshot();
    const next = snapshot();
    if (fault === "observation-expiry") initial.asOfSec = next.asOfSec = now - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1;
    if (fault === "generation") next.safetyScoreIdentity = { ...next.safetyScoreIdentity, publicationGenerationId: "next-generation" };
    if (fault === "grade") next.cards[0].grade = "B+";
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
