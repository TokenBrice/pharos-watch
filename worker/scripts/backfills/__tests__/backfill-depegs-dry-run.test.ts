import { readJsonResponse } from "../../../src/test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeReplayDiagnostics } from "../../../src/api/__tests__/depeg-replay.test-support";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { fetchAuthoritativeHistoricalPriceSeries } from "../../../src/lib/authoritative-price-sources";
import type { PricePoint } from "../../../src/lib/historical-market-prices";
import { backfillCoin } from "../backfill-depegs-replay";
import { handleBackfillDEWS } from "../../../src/api/backfill-dews";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

vi.mock("../../../src/lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({ kind: "missing", reason: "test", payload: null })),
}));

vi.mock("../../../src/lib/authoritative-price-sources", () => ({
  fetchAuthoritativeHistoricalPriceSeries: vi.fn(async () => ({
    matched: false,
    source: null,
    prices: null,
  })),
}));

vi.mock("../../../src/lib/historical-market-prices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/historical-market-prices")>();
  return {
    ...actual,
    fetchMarketBackfillPriceSeries: vi.fn(async () => ({
      prices: [
        { timestamp: 900, price: 1 },
        { timestamp: 1_000, price: 1.02 },
        { timestamp: 2_000, price: 1.03 },
        { timestamp: 3_000, price: 1.0 },
      ],
      diagnostics: makeReplayDiagnostics(3),
    })),
  };
});

vi.mock("../../../src/lib/backfill-fx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/backfill-fx")>();
  return {
    ...actual,
    fetchHistoricalFxRates: vi.fn(async () => ({})),
    fetchHistoricalSecondaryFxRates: vi.fn(async () => ({})),
    fetchHistoricalCommodityPeers: vi.fn(async () => ({})),
  };
});

import { handleBackfillDepegsTrusted } from "../backfill-depegs";
import { fetchMarketBackfillPriceSeries, isAdmittedHistoricalNativeQuote } from "../../../src/lib/historical-market-prices";
import { fetchHistoricalCommodityPeers, fetchHistoricalFxRates, fetchHistoricalSecondaryFxRates } from "../../../src/lib/backfill-fx";

stubCryptoForAuth();

describe("handleBackfillDepegs replay windows", () => {
  beforeEach(() => {
    mockFetch([
      {
        match: "/stablecoin/",
        body: {
          gecko_id: "tether",
          tokens: [{ date: "900", circulating: { peggedUSD: 2_000_000_000 } }],
        },
      },
    ]);
  });
  it.each(["protocol-par", "protocol-redeem"])(
    "distinguishes nominal source-only replay from legacy executable history: %s",
    async (source) => {
      vi.mocked(fetchAuthoritativeHistoricalPriceSeries).mockResolvedValueOnce({
        matched: true,
        source,
        prices: [
          { timestamp: 1_000, price: 1.02 },
          { timestamp: 2_000, price: 1.03 },
          { timestamp: 3_000, price: 1 },
        ],
      });
      const result = await backfillCoin({
        meta: TRACKED_META_BY_ID.get("usdt-tether")!,
        geckoId: "tether",
        getPegRef: () => 1,
        supplyByDate: [{ ts: 1_000, supply: 2_000_000_000 }],
      });
      if (source === "protocol-par") {
        expect(result.events).toBeNull();
        expect(result.sourceKind).toBe("preserve-existing");
      } else {
        expect(result.sourceKind).toBe("authoritative");
        expect(result.events).toEqual([expect.objectContaining({
          direction: "above",
          startedAt: 1_000,
          endedAt: 3_000,
          peakDeviationBps: 300,
        })]);
      }
    },
  );

  it("previews replay-vs-backfill differences without mutating existing rows", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["usdt-tether"],
        rows: [
          {
            id: 1,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "above",
            peak_deviation_bps: 300,
            started_at: 1_000,
            ended_at: 3_000,
            start_price: 1.02,
            peak_price: 1.03,
            recovery_price: 1.0,
            peg_reference: 1,
            peak_peg_reference: 1,
            peak_quote_domain: "usd",
            recovery_peg_reference: 1,
            admitted_coverage_json: '[{"fromSec":1000,"toSec":2000}]',
            source: "backfill",
          },
          {
            id: 2,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -150,
            started_at: 4_000,
            ended_at: null,
            start_price: 0.985,
            peak_price: 0.985,
            recovery_price: null,
            peg_reference: 1,
            source: "live",
          },
        ],
      },
    ]);

    const req = makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether&dry-run=true", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });

    const body = await readJsonResponse(res, 200) as {
      dryRun: boolean;
      coinsProcessed: number;
      recomputedBackfillEvents: number;
      previews: Array<{
        stablecoinId: string;
        replaySource: string;
        exactMatch: boolean | null;
        existingBackfillEventCount: number;
        recomputedBackfillEventCount: number | null;
        existingLiveEventCount: number;
        existingOpenLiveEventCount: number;
      }>;
    };

    expect(body.dryRun).toBe(true);
    expect(body.coinsProcessed).toBe(1);
    expect(body.recomputedBackfillEvents).toBe(1);
    expect(body.previews).toHaveLength(1);
    expect(body.previews[0]).toMatchObject({
      stablecoinId: "usdt-tether",
      replaySource: "market",
      exactMatch: true,
      existingBackfillEventCount: 1,
      recomputedBackfillEventCount: 1,
      existingLiveEventCount: 1,
      existingOpenLiveEventCount: 1,
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO depeg_events"))).toBe(false);
  });

  it("preserves existing rows on an all-absent historical supply replay", async () => {
    mockFetch([{
      match: "/stablecoin/",
      body: { gecko_id: "tether", tokens: [
        { date: "1000", circulating: {} },
        { date: "2000" },
        { date: "3000", circulating: { peggedUSD: "invalid" } },
      ] },
    }]);
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
      VALUES (1, 'usdt-tether', 'USDT', 'peggedUSD', 'above', 300,
       1000, 3000, 1.02, 1.03, 1, 1, 'backfill')`).run();
    const existing = sqlite.prepare("SELECT * FROM depeg_events WHERE id = 1").get();
    const req = makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether", {
      adminKey: "secret", method: "POST",
    });
    const response = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });
    const body = await readJsonResponse(response, 200) as { eventsCreated: number };
    expect(body.eventsCreated).toBe(0);
    expect(sqlite.prepare("SELECT * FROM depeg_events WHERE id = 1").get()).toEqual(existing);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_backfill_runs").get()).toEqual({ count: 0 });
  });

  it("passes a bounded replay window through dry-run backfill previews", async () => {
    const day1 = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);
    const day2 = Math.floor(new Date("2025-01-31T00:00:00Z").getTime() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["usdt-tether"],
        rows: [],
      },
    ]);

    const req = makeApiRequest(`/api/backfill-depegs?stablecoin=usdt-tether&dry-run=true&startDay=${day1}&endDay=${day2}`, {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });

    const body = await readJsonResponse(res, 200) as {
      dryRun: boolean;
      startDay: number | null;
      endDay: number | null;
      contextDays: number | null;
    };
    expect(body.dryRun).toBe(true);
    expect(body.startDay).toBe(day1);
    expect(body.endDay).toBe(day2);
    expect(body.contextDays).toBe(7);

    expect(vi.mocked(fetchMarketBackfillPriceSeries)).toHaveBeenCalledWith(
      expect.anything(),
      "tether",
      expect.objectContaining({
        granularity: "hourly",
        range: {
          startSec: day1 - 7 * 86400,
          endSec: day2 + (8 * 86400) - 1,
        },
      }),
    );
  });

  it("requests native-peg market replay for supported non-USD fiat assets", async () => {
    vi.mocked(fetchHistoricalFxRates).mockResolvedValueOnce({
      EUR: [{ timestamp: 1_000, rate: 1.08 }],
    });
    mockFetch([
      {
        match: "/stablecoin/",
        body: {
          gecko_id: "euro-coin",
          tokens: [{ date: "1000", circulating: { peggedUSD: 2_000_000_000 } }],
        },
      },
    ]);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["eurc-circle"],
        rows: [],
      },
    ]);

    const req = makeApiRequest("/api/backfill-depegs?stablecoin=eurc-circle&dry-run=true", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });
    expect(res.status).toBe(200);

    expect(vi.mocked(fetchMarketBackfillPriceSeries)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "eurc-circle" }),
      "euro-coin",
      expect.objectContaining({
        granularity: "hourly",
        quote: {
          pegCurrency: "EUR",
          useNativePegQuote: true,
          requireExactUnit: true,
        },
      }),
    );
  });

  it.each([
    { unit: "CNY", derivation: { kind: "traded-pair", lineage: { venue: "venue", pair: "AXCNH/CNY" } }, accepted: false },
    { unit: "CNH", derivation: { kind: "unknown", lineage: {} }, accepted: false },
    { unit: "CNH", derivation: { kind: "conversion", lineage: { fxSource: "openExchangeRates" } }, clockOffset: null, accepted: false },
    { unit: "CNH", derivation: { kind: "conversion", lineage: { fxSource: "openExchangeRates" } }, clockOffset: 60, accepted: true },
    { unit: "CNH", derivation: { kind: "conversion", lineage: { fxSource: "openExchangeRates" } }, clockOffset: -60, accepted: false },
    { unit: "CNH", derivation: { kind: "traded-pair", lineage: { venue: "venue", pair: "AXCNH/CNH" } }, accepted: true },
  ] as const)("checks AxCNH lineage ($unit, $derivation.kind) and withholds unsupported native replay", async ({ unit, derivation, accepted, clockOffset }) => {
    const started = Date.parse("2025-06-16T10:00Z") / 1000;
    const prices: PricePoint[] = [1, 1.025, 1.026, 1].map((price, i) => ({
      timestamp: started + i * 3600, price, nativeQuote: { currency: unit,
        derivation: clockOffset == null ? derivation : {
          ...derivation, lineage: { ...derivation.lineage, fxObservedAtSec: started + i * 3600 - clockOffset },
        },
      },
    }));
    expect(prices.every((point) => isAdmittedHistoricalNativeQuote(point, "CNH"))).toBe(accepted);
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      prices, diagnostics: { ...makeReplayDiagnostics(4), quoteMode: "native-peg", quoteCurrency: unit.toLowerCase() },
    });
    const result = await backfillCoin({
      meta: TRACKED_META_BY_ID.get("axcnh-anchorx")!, geckoId: "axcnh", getPegRef: () => null,
      supplyByDate: [{ ts: started, supply: 6e6 }],
    });
    if (accepted) {
      expect(result.events).toMatchObject([{ pegType: "peggedCNH", peakQuoteDomain: "native-peg", peakDeviationBps: 260 }]);
    } else {
      expect(result).toMatchObject({ events: null, degradedReason: "unclocked-native-quote" });
    }
  });

  it.each(["none", "clipped", "open", "midnight-only", "off-peg-predecessor"])("replaces only fully assessed rows in a bounded replay (%s)", async (gap) => {
    const clipped = gap !== "none";
    const day1 = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);
    const day2 = Math.floor(new Date("2025-01-02T00:00:00Z").getTime() / 1000);
    mockFetch([
      {
        match: "/stablecoin/",
        body: {
          gecko_id: "tether",
          tokens: [{ date: String(day1), circulating: { peggedUSD: 2_000_000_000 } }],
        },
      },
    ]);
    const closesAt = gap === "midnight-only" ? day1 + 10 * 3600 : day1 + 4 * 3600;
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      prices: gap === "midnight-only" ? [{ timestamp: day1, price: 1 }, { timestamp: day2, price: 1 }]
        : [1, gap === "off-peg-predecessor" ? 1.2 : 1.02, 1.03, 1.02, 1]
          .map((price, i) => ({ timestamp: day1 + i * 3600, price })),
      diagnostics: makeReplayDiagnostics(5),
    });

    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
      VALUES (?, ?, 'USDT', 'peggedUSD', 'below', -220, ?, ?, 0.98, 0.978, 1, 1, ?)`);
    insert.run(1, "usdt-tether", gap === "midnight-only" ? day1 + 9 * 3600 : day1 + 3600, closesAt, "backfill");
    insert.run(2, "usdt-tether", day2 + 5 * 86_400, day2 + 6 * 86_400, "backfill");
    insert.run(3, "usdt-tether", day1 + 1_800, null, "live");
    insert.run(4, "usdc-circle", day1 + 3_600, day2 + 3_600, "backfill");
    insert.run(5, "usdt-tether", day1 - 86_400, day1 - 1, "backfill");
    if (gap === "clipped" || gap === "open") insert.run(6, "usdt-tether", day1 - 40 * 86_400, gap === "open" ? null : day2, "backfill");

    const req = makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });

    const body = await readJsonResponse(res, 200) as {
      eventsCreated: number;
      errors?: string[] | null;
    };
    expect(body.eventsCreated).toBe(clipped ? 0 : 1);
    expect(body.errors ?? []).toHaveLength(0);

    const oldIds = sqlite.prepare("SELECT id FROM depeg_events WHERE id <= 5 ORDER BY id").all();
    expect(oldIds).toEqual((clipped ? [1, 2, 3, 4, 5] : [2, 3, 4, 5]).map((id) => ({ id })));
    if (clipped) return;
    const last = sqlite.prepare(`SELECT started_at, ended_at, peak_peg_reference, recovery_peg_reference,
      admitted_coverage_json, price_coverage_json, last_trusted_price_at FROM depeg_events WHERE id = 6`).get();
    expect(last).toMatchObject({ started_at: day1 + 3600, ended_at: closesAt, peak_peg_reference: 1, recovery_peg_reference: 1,
      admitted_coverage_json: JSON.stringify([{ fromSec: day1 + 3600, toSec: day1 + 10800 }]),
      price_coverage_json: JSON.stringify({ intervals: [[day1 + 3600, day1 + 10800]],
        atParIntervals: [[closesAt, closesAt]], lastObservationKind: "trusted-at-par" }),
      last_trusted_price_at: closesAt });

  });

  it("deletes overlapping backfill rows when a mutating trusted replay finds zero events", async () => {
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      prices: [
        { timestamp: 1_000, price: 1.0 },
        { timestamp: 2_000, price: 0.999 },
        { timestamp: 3_000, price: 1 },
      ],
      diagnostics: makeReplayDiagnostics(2),
    });
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, ended_at, start_price, peg_reference, source)
      VALUES (1, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -300, 1500, 3000, 0.97, 1, 'backfill')`);
    const req = makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });
    const body = await readJsonResponse(res, 200) as { eventsCreated: number; skipped?: string[] };
    expect(body.eventsCreated).toBe(0);
    expect(body.skipped ?? []).toEqual([]);

    expect(sqlite.prepare("SELECT id FROM depeg_events").all()).toEqual([]);
  });

  it("previews corroborated severe PAXG moves inside a closure", async () => {
    const at = (date: string) => Date.parse(date) / 1000;
    const { db } = fixtures.open();
    const url = makeApiUrl("/api/backfill-depegs?stablecoin=paxg-paxos&dry-run=true");
    for (const [onset, previous, low, sources, eventCount] of [
      ["2026-11-14T14:00Z", "2026-11-13T21:30Z", 2800, ["a", "b", "c"], 1],
      ["2026-11-13T22:05Z", "2026-11-13T21:55Z", 2800, ["a", "b", "c"], 1],
      ["2026-11-14T14:00Z", "2026-11-13T21:30Z", 3880, ["a", "b", "c"], 0],
      ["2026-11-14T14:00Z", "2026-11-13T21:30Z", 2800, ["a", "b", "b"], 0],
    ] as const) {
      const start = at(onset);
      const times = [at(previous), start, start + 1800, start + 3600, at("2026-11-16T12:00Z")];
      const prices = times.map((timestamp, index) => ({ timestamp, price: index === 0 || index === 4 ? 4000 : low }));
      vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({ prices, diagnostics: makeReplayDiagnostics(5) });
      vi.mocked(fetchHistoricalCommodityPeers).mockResolvedValueOnce({ GOLD: sources.map((sourceId, index) => ({
        assetId: `peer-${index}`, sourceId, commodityOunces: 1, prices: times.map((timestamp) => ({ timestamp, price: 4000 })),
      })) });
      mockFetch([{ match: "/stablecoin/", body: { gecko_id: "pax-gold",
        tokens: [{ date: String(times[0]), totalCirculatingUSD: { peggedGOLD: 2e9 } }] } }]);
      const response = await handleBackfillDepegsTrusted({ db, url, coingeckoApiKey: "cg-test-key" });
      expect(await readJsonResponse(response, 200)).toMatchObject({ previews: [{
        addedBackfillEventsSample: eventCount ? [{ startedAt: start, endedAt: times[4], peakDeviationBps: -3000 }] : [],
      }] });
    }
  });

  it("preserves a PAXG incident when hourly quotes straddle the maintenance closure", async () => {
    const at = (clock: string) => Date.parse(`2026-11-17T${clock}Z`) / 1000;
    const prices = ["21:30", "21:45", "23:15"].map((clock) => ({ timestamp: at(clock), price: 4000 }));
    const peers = { GOLD: ["a", "b", "c"].map((assetId) => ({
      assetId, sourceId: assetId, commodityOunces: 1, prices,
    })) };
    vi.mocked(fetchHistoricalCommodityPeers).mockResolvedValueOnce(peers).mockResolvedValueOnce(peers);
    const series = { prices, diagnostics: makeReplayDiagnostics(3) };
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce(series).mockResolvedValueOnce(series);
    mockFetch([{ match: "/stablecoin/", body: { gecko_id: "pax-gold",
      tokens: [{ date: String(at("21:30")), totalCirculatingUSD: { peggedGOLD: 6_000_000 } }] } }]);
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, ended_at, start_price, peg_reference, source)
      VALUES (1, 'paxg-paxos', 'PAXG', 'peggedGOLD', 'below', -300, ?, ?, 3880, 4000, 'backfill')`)
      .run(at("21:40"), at("23:05"));
    const url = makeApiUrl("/api/backfill-depegs?stablecoin=paxg-paxos&startDay=2026-11-17&endDay=2026-11-17");
    const previewUrl = new URL(url);
    previewUrl.searchParams.set("dry-run", "true");
    expect(await readJsonResponse(await handleBackfillDepegsTrusted({ db, url: previewUrl, coingeckoApiKey: "cg-test-key" }), 200))
      .toMatchObject({ previews: [{ degradedReason: "insufficient-boundary-evidence" }] });
    const response = await handleBackfillDepegsTrusted({ db, url, coingeckoApiKey: "cg-test-key" });
    expect(await readJsonResponse(response, 200)).toMatchObject({ eventsCreated: 0, skipped: ["PAXG"] });
    expect(sqlite.prepare("SELECT id FROM depeg_events").all()).toEqual([{ id: 1 }]);
  });

  it("agrees on a retained open live row in preview and apply", async () => {
    const { db, sqlite } = fixtures.open();
    const before = sqlite.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction,
      peak_deviation_bps, started_at, start_price, peg_reference, source)
      VALUES (1, 'usdt-tether', 'USDT', 'peggedUSD', 'above', 200, 800, 1.02, 1, 'live') RETURNING id, started_at`).get();
    const query = "/api/backfill-depegs?stablecoin=usdt-tether&startDay=1970-01-01&endDay=1970-01-01&contextDays=0";
    expect(await readJsonResponse(await handleBackfillDepegsTrusted({ db, url: makeApiUrl(query + "&dry-run=true") }), 200))
      .toMatchObject({ previews: [{ addedBackfillEventCount: 0, existingOpenLiveEventCount: 1 }] });
    expect(await readJsonResponse(await handleBackfillDepegsTrusted({ db, url: makeApiUrl(query) }), 200))
      .toMatchObject({ eventsCreated: 0 });
    expect(sqlite.prepare("SELECT id, started_at FROM depeg_events").all()).toEqual([before]);
  });

  it("inserts a closed daily USDT episode and requires hourly evidence before replacing it", async () => {
    const { db, sqlite } = fixtures.open();
    const day = Date.parse("2026-08-10") / 1000;
    const prices = [1.008, 1.02, 1.03, 1].map((price, i) => ({ timestamp: day + i * 86_400, price }));
    mockFetch([{ match: "/stablecoin/", body: {
      tokens: prices.map(({ timestamp }) => ({ date: String(timestamp), circulating: { peggedUSD: 2e9 } })),
    } }]);
    const series = { prices, diagnostics: { ...makeReplayDiagnostics(prices.length), granularity: "daily" as const } };
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce(series).mockResolvedValueOnce(series);
    const url = makeApiUrl("/api/backfill-depegs?stablecoin=usdt-tether");
    const apply = async () => readJsonResponse(await handleBackfillDepegsTrusted({ db, url }), 200);
    expect(await apply()).toMatchObject({ eventsCreated: 1 });
    const read = () => sqlite.prepare("SELECT id, started_at, ended_at, peak_deviation_bps FROM depeg_events").all();
    const inserted = read();
    expect(inserted).toEqual([{ id: expect.any(Number), started_at: day + 86_400, ended_at: day + 3 * 86_400, peak_deviation_bps: 300 }]);
    expect(await apply()).toMatchObject({ eventsCreated: 0, skipReasons: { "usdt-tether": "insufficient-boundary-evidence" } });
    expect(read()).toEqual(inserted);
  });

  it("keeps monthly FX caches untouched during an AxCNH preview", async () => {
    const { db, sqlite } = fixtures.open();
    const at = Date.parse("2026-08-10") / 1000;
    const year = Object.fromEntries(Array.from({ length: 16 }, (_, i) =>
      [new Date((at - i * 86_400) * 1000).toISOString().slice(0, 10), { cnh: 7.1 }]));
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("fx-history-secondary:2026", JSON.stringify(year), at);
    const read = () => sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
    const before = read();
    const actualFx = await vi.importActual<typeof import("../../../src/lib/backfill-fx")>("../../../src/lib/backfill-fx");
    vi.mocked(fetchHistoricalSecondaryFxRates).mockImplementationOnce(actualFx.fetchHistoricalSecondaryFxRates);
    mockFetch([{ match: "/stablecoin/", body: { tokens: [{ date: String(at), circulating: { peggedCNH: 1e8 } }] } }]);
    const url = makeApiUrl("/api/backfill-depegs?stablecoin=axcnh-anchorx&dry-run=true&startDay=2026-08-10&endDay=2026-08-10&contextDays=0");
    expect(await readJsonResponse(await handleBackfillDepegsTrusted({ db, url }), 200)).toMatchObject({
      recomputedBackfillEvents: 0, skipReasons: { "axcnh-anchorx": "unclocked-cnh-reference" },
    });
    expect(read()).toEqual(before);
  });

  it("retains a measured zero-duration USD crash as a DEWS target", async () => {
    const clock = Date.parse("2025-06-16T10:00Z") / 1000;
    const at = (i: number) => clock + i * 3600;
    mockFetch([{ match: "/stablecoin/", body: { gecko_id: "tether",
      tokens: [{ date: String(clock), circulating: { peggedUSD: 6_000_000 } }] } }]);
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      prices: [1, 0.45, 1].map((price, i) => ({ timestamp: at(i), price })),
      diagnostics: makeReplayDiagnostics(3),
    });
    const { db, sqlite } = fixtures.open();
    const response = await handleBackfillDepegsTrusted({ db, url: makeApiUrl("/api/backfill-depegs?stablecoin=usdt-tether") });
    expect(await readJsonResponse(response, 200)).toMatchObject({ eventsCreated: 1 });
    const row = sqlite.prepare("SELECT admitted_coverage_json, price_coverage_json FROM depeg_events").get()!;
    expect(row.admitted_coverage_json).toBe("[]");
    expect(JSON.parse(String(row.price_coverage_json)).intervals).toEqual([[at(1), at(1)]]);
    const url = makeApiUrl("/api/backfill-dews");
    expect(await readJsonResponse(await handleBackfillDEWS({ db, url }), 200))
      .toMatchObject({ events: [{ startedAt: at(1) }], summary: { totalEvents: 1 } });
    sqlite.exec("UPDATE depeg_events SET disposition = 'repaired'");
    expect(await readJsonResponse(await handleBackfillDEWS({ db, url }), 200))
      .toMatchObject({ events: [], summary: { totalEvents: 0, excludedTargets: { auditIneligible: 1 } } });
  });

  it("rejects delisted commodity assets before requesting median price history", async () => {
    vi.mocked(fetchHistoricalCommodityPeers).mockClear();
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["xnk-kinka"],
        rows: [],
      },
    ]);
    const req = makeApiRequest(
      "/api/backfill-depegs?stablecoin=xnk-kinka&dry-run=true&startDay=2026-05-01&endDay=2026-05-01&contextDays=1",
      {
        adminKey: "secret",
        method: "POST",
      },
    );

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url), coingeckoApiKey: "cg-test-key" });
    expect(await readJsonResponse(res, 404)).toEqual({ error: "Stablecoin not found" });
    expect(fetchHistoricalCommodityPeers).not.toHaveBeenCalled();
  });
});
