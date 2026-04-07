import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { mockFetch } from "./helpers/mock-fetch";

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
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 3,
      },
    })),
  };
});

import { handleBackfillDepegs } from "../backfill-depegs";

stubCryptoForAuth();

describe("handleBackfillDepegs dry-run", () => {
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

    const res = await handleBackfillDepegs(db, makeApiUrl(req.url), true, req);
    expect(res.status).toBe(200);

    const body = await res.json() as {
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
});
