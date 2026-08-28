import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { handleStablecoinSummary } from "../stablecoin-summary";

function makeStablecoinsCacheValue() {
  return JSON.stringify({
    peggedAssets: [
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        geckoId: "tether",
        pegType: "peggedUSD",
        pegMechanism: "fiat-backed",
        price: 1.0001,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        supplySource: "defillama",
        supplyObservedAt: 1_700_000_000,
        supplyRestored: true,
        circulating: { peggedUSD: 100 },
        circulatingPrevDay: { peggedUSD: 90 },
        circulatingPrevWeek: { peggedUSD: 80 },
        circulatingPrevMonth: { peggedUSD: 70 },
        chainCirculating: {},
        chains: ["Ethereum", "Tron"],
      },
    ],
  });
}

describe("handleStablecoinSummary", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1([{ match: "cache", rows: [] }]);
    const res = await handleStablecoinSummary(db, "usdt-tether");

    expect(await readJsonResponse(res, 503)).toEqual({ error: "Cached stablecoins data is corrupt" });
  });

  it("returns 503 when stablecoins cache is corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [], first: { value: "{", updated_at: now } },
    ]);
    const res = await handleStablecoinSummary(db, "usdt-tether");

    expect(await readJsonResponse(res, 503)).toEqual({ error: "Cached stablecoins data is corrupt" });
  });

  it("returns 503 when stablecoins cache payload is structurally invalid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [], first: { value: JSON.stringify({ peggedAssets: null }), updated_at: now } },
    ]);
    const res = await handleStablecoinSummary(db, "usdt-tether");

    expect(await readJsonResponse(res, 503)).toEqual({ error: "Cached stablecoins data is corrupt" });
  });

  it("returns 404 when stablecoin id is missing in cache payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [], first: { value: makeStablecoinsCacheValue(), updated_at: now } },
    ]);
    const res = await handleStablecoinSummary(db, "999");

    expect(await readJsonResponse(res, 404)).toEqual({ error: "Stablecoin 999 not found" });
  });

  it("returns compact per-coin summary with freshness headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const db = mockD1([
      { match: "cache", rows: [], first: { value: makeStablecoinsCacheValue(), updated_at: now - 42 } },
    ]);
    try {
      const res = await handleStablecoinSummary(db, "usdt-tether");
      const body = await res.json() as {
        id: string;
        symbol: string;
        supplyObservedAt: number | null;
        supplyRestored: boolean;
        supplyUsd: { current: number; change1d: number; change7d: number; change30d: number };
        chainCount: number;
        updatedAt: number;
      };

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60, stale-while-revalidate=300");
      expect(res.headers.get("X-Data-Age")).toBe("42");
      expect(body.id).toBe("usdt-tether");
      expect(body.symbol).toBe("USDT");
      expect(body.supplyObservedAt).toBe(1_700_000_000);
      expect(body.supplyRestored).toBe(true);
      expect(body.supplyUsd.current).toBe(100);
      expect(body.supplyUsd.change1d).toBe(10);
      expect(body.supplyUsd.change7d).toBe(20);
      expect(body.supplyUsd.change30d).toBe(30);
      expect(body.chainCount).toBe(2);
      expect(body.updatedAt).toBe(now - 42);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
