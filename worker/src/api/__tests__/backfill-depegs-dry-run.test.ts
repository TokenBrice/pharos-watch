import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { mockFetch } from "@shared/test-utils/mock-fetch";

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({ kind: "missing", reason: "test", payload: null })),
}));

vi.mock("../../lib/authoritative-price-sources", () => ({
  fetchAuthoritativeHistoricalPriceSeries: vi.fn(async () => ({
    matched: false,
    source: null,
    prices: null,
  })),
}));

vi.mock("../backfill-price-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../backfill-price-sources")>();
  return {
    ...actual,
    fetchMarketBackfillPriceSeries: vi.fn(async () => ({
      prices: [
        { timestamp: 1_000, price: 1.02 },
        { timestamp: 2_000, price: 1.03 },
        { timestamp: 3_000, price: 1.0 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 3,
      },
    })),
  };
});

vi.mock("../../lib/backfill-fx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/backfill-fx")>();
  return {
    ...actual,
    fetchHistoricalFxRates: vi.fn(async () => ({})),
    fetchHistoricalSecondaryFxRates: vi.fn(async () => ({})),
    buildCommodityMedianSeriesFromCg: vi.fn(async () => ({})),
  };
});

import { handleBackfillDepegsTrusted } from "../backfill-depegs";
import { fetchMarketBackfillPriceSeries } from "../backfill-price-sources";
import { buildCommodityMedianSeriesFromCg } from "../../lib/backfill-fx";

stubCryptoForAuth();

describe("handleBackfillDepegs replay windows", () => {
  beforeEach(() => {
    mockFetch([
      {
        match: "/stablecoin/",
        body: {
          gecko_id: "tether",
          tokens: [{ date: "1000", circulating: { peggedUSD: 2_000_000_000 } }],
        },
      },
    ]);
  });

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

  it("previews stale-row removal when a trusted replay finds zero events", async () => {
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      prices: [
        { timestamp: 1_000, price: 1.0 },
        { timestamp: 2_000, price: 0.999 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 2,
      },
    });
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["usdt-tether"],
        rows: [
          {
            id: 10,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -250,
            started_at: 1_000,
            ended_at: 2_000,
            start_price: 0.975,
            peak_price: 0.975,
            recovery_price: 1,
            peg_reference: 1,
            source: "backfill",
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
      recomputedBackfillEvents: number;
      previews: Array<{
        recomputedBackfillEventCount: number | null;
        removedBackfillEventCount: number;
        removedBackfillEventIdsSample: number[];
      }>;
    };

    expect(body.recomputedBackfillEvents).toBe(0);
    expect(body.previews[0]).toMatchObject({
      recomputedBackfillEventCount: 0,
      removedBackfillEventCount: 1,
      removedBackfillEventIdsSample: [10],
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(false);
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

  it("supports configurable replay context for bounded dry-run previews", async () => {
    const day1 = Math.floor(new Date("2025-02-01T00:00:00Z").getTime() / 1000);
    const day2 = Math.floor(new Date("2025-02-28T00:00:00Z").getTime() / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at",
        matchBinds: ["usdt-tether"],
        rows: [],
      },
    ]);

    const req = makeApiRequest(`/api/backfill-depegs?stablecoin=usdt-tether&dry-run=true&startDay=${day1}&endDay=${day2}&contextDays=30`, {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });

    const body = await readJsonResponse(res, 200) as {
      contextDays: number | null;
    };
    expect(body.contextDays).toBe(30);

    expect(vi.mocked(fetchMarketBackfillPriceSeries)).toHaveBeenCalledWith(
      expect.anything(),
      "tether",
      expect.objectContaining({
        range: {
          startSec: day1 - 30 * 86400,
          endSec: day2 + (31 * 86400) - 1,
        },
      }),
    );
  });

  it("requests native-peg market replay for supported non-USD fiat assets", async () => {
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
        granularity: "daily",
        quote: {
          pegCurrency: "EUR",
          useNativePegQuote: true,
        },
      }),
    );
  });

  it("replaces only overlapping backfill rows when mutating a bounded replay window", async () => {
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
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      prices: [
        { timestamp: day1 + 3_600, price: 1.02 },
        { timestamp: day1 + 7_200, price: 1.03 },
        { timestamp: day2 + 3_600, price: 1.0 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 3,
      },
    });

    const db = mockD1([
      { match: "FROM depeg_events e", rows: [] },
      { match: "INSERT INTO depeg_backfill_runs", rows: [] },
      { match: "DELETE FROM depeg_events", rows: [] },
      { match: "INSERT INTO depeg_events", rows: [] },
      { match: "INSERT OR REPLACE INTO depeg_event_provenance", rows: [] },
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
            started_at: day1 + 3_600,
            ended_at: day2 + 3_600,
            start_price: 1.02,
            peak_price: 1.03,
            recovery_price: 1.0,
            peg_reference: 1,
            source: "backfill",
          },
          {
            id: 2,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -220,
            started_at: day2 + (5 * 86_400),
            ended_at: day2 + (6 * 86_400),
            start_price: 0.98,
            peak_price: 0.978,
            recovery_price: 1.0,
            peg_reference: 1,
            source: "backfill",
          },
          {
            id: 3,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -150,
            started_at: day1 + 1_800,
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

    const req = makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether&startDay=2025-01-01&endDay=2025-01-02", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });

    const body = await readJsonResponse(res, 200) as {
      eventsCreated: number;
      errors?: string[] | null;
    };
    expect(body.eventsCreated).toBe(1);
    expect(body.errors ?? []).toHaveLength(0);

    const history = db.getHistory();
    const deleteEntry = history.find((entry) => entry.sql.includes("DELETE FROM depeg_events"));
    expect(deleteEntry).toMatchObject({
      binds: ["usdt-tether", day1, day2 + 86_400 - 1],
    });
    expect(deleteEntry?.sql).toContain("COALESCE(ended_at, started_at) >= ?");
    expect(deleteEntry?.sql).toContain("started_at <= ?");

    const inserts = history.filter((entry) => entry.sql.includes("INSERT INTO depeg_events"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.binds.slice(0, 2)).toEqual(["usdt-tether", "USDT"]);
  });

  it("deletes overlapping backfill rows when a mutating trusted replay finds zero events", async () => {
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      prices: [
        { timestamp: 1_000, price: 1.0 },
        { timestamp: 2_000, price: 0.999 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 2,
      },
    });
    const db = mockD1([
      { match: "FROM depeg_events e", rows: [] },
      { match: "FROM depeg_events WHERE stablecoin_id = ? ORDER BY started_at", rows: [] },
      { match: "DELETE FROM depeg_events", rows: [] },
      { match: "INSERT INTO depeg_backfill_runs", rows: [] },
    ]);
    const req = makeApiRequest("/api/backfill-depegs?stablecoin=usdt-tether", {
      adminKey: "secret",
      method: "POST",
    });

    const res = await handleBackfillDepegsTrusted({ db, url: makeApiUrl(req.url) });
    const body = await readJsonResponse(res, 200) as { eventsCreated: number; skipped?: string[] };
    expect(body.eventsCreated).toBe(0);
    expect(body.skipped ?? []).toEqual([]);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM depeg_events"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO depeg_events"))).toBe(false);
  });

  it("rejects delisted commodity assets before requesting median price history", async () => {
    vi.mocked(buildCommodityMedianSeriesFromCg).mockClear();
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
    expect(buildCommodityMedianSeriesFromCg).not.toHaveBeenCalled();
  });
});
