import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import satoriStandalone from "satori/standalone";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { PSI_NATIVE_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/depeg-quote-domain";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../../lib/native-peg-quote-cache";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { handleOg, resetOgWasmInitializationForTests } from "../og";
import { DepegCard, type DepegCardData } from "../../lib/og-templates/depeg-card";
import { loadStressSignalCurrentRows } from "../../lib/stress-signals-current-rows";
import type { ReactElement } from "react";

vi.mock("satori/standalone", () => ({ init: vi.fn(), default: vi.fn(async () => "<svg></svg>") }));
vi.mock("../../lib/stress-signals-current-rows", () => ({
  loadStressSignalCurrentRows: vi.fn(), loadStressSignalCurrentRowForCoin: vi.fn(),
}));

const nativeQuoteFixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  nativeQuoteFixtures.closeAll();
  resetOgWasmInitializationForTests();
  vi.clearAllMocks();
});

describe("depeg OG independent source availability", () => {
  it.each([false, true])("does not manufacture DEWS zeroes from absent rows; observed=%s", async (observed) => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(loadStressSignalCurrentRows).mockResolvedValue({ results: observed ? [{
      stablecoin_id: "usdt-tether", score: 0, band: "CALM", signals_json: "{}", computed_at: now,
    }] : [] });
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
      { match: "stability_index_samples", rows: [], first: null },
      { match: "peak_deviation_bps", rows: [] },
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "COUNT(*) as count", rows: [], first: observed ? { count: 0 } : null },
    ]);
    const response = await handleOg(db, "/api/og/depeg");
    expect(response?.status).toBe(200);
    const calls = vi.mocked(satoriStandalone).mock.calls;
    const element = calls[calls.length - 1][0] as ReactElement<{ data: DepegCardData }>;
    expect(element.type).toBe(DepegCard);
    expect(element.props.data.dewsDistribution).toEqual(observed ? { danger: 0, alert: 0, warning: 0, watch: 0, normal: 1 } : null);
    expect(element.props.data.newToday).toBe(observed ? 0 : null);
    const markup = renderToStaticMarkup(element);
    if (observed) expect(markup).not.toContain("DEWS source unavailable");
    else expect(markup).toContain("DEWS source unavailable");
  });

  it.each([
    ["native current", "live", "native-peg", "fresh", 86400, 1, -200],
    ["native inferred", "live", null, "fresh", 86400, 1, -200],
    ["native provenance", "backfill", "native-peg", "fresh", 86400, 1, -200],
    ["native start", "live", "native-peg", "missing", 60, 1, -200],
    ["native missing", "live", "native-peg", "missing", 86400, 1, null],
    ["native expired", "live", "native-peg", "expired", 86400, 1, null],
    ["legacy USD reference", "backfill", null, "fresh", 86400, 1.1, 0],
    ["explicit USD provenance", "live", "usd", "fresh", 86400, 1, 1000],
  ] as const)("renders %s in its event domain from joined SQLite evidence", async (_label, source, quoteMode, quoteState, startAge, reference, expectedBps) => {
    const { db, sqlite } = nativeQuoteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(loadStressSignalCurrentRows).mockResolvedValue({ results: [] });
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
      .run(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}101`, JSON.stringify({ value: 0.98, observedAt: quoteAt, source: "coingecko" }), quoteAt);
    expect((await handleOg(db, "/api/og/depeg"))?.status).toBe(200);
    const calls = vi.mocked(satoriStandalone).mock.calls;
    const element = calls[calls.length - 1][0] as ReactElement<{ data: DepegCardData }>;
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
});
