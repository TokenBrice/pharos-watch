import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
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
        priceSource: "defillama+coingecko",
        priceConfidence: "high",
        supplySource: "defillama",
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

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Data not yet available" });
  });

  it("returns 503 when stablecoins cache is corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [], first: { value: "{", updated_at: now } },
    ]);
    const res = await handleStablecoinSummary(db, "usdt-tether");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Cached stablecoins data is corrupt" });
  });

  it("returns 404 when stablecoin id is missing in cache payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [], first: { value: makeStablecoinsCacheValue(), updated_at: now } },
    ]);
    const res = await handleStablecoinSummary(db, "999");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin 999 not found" });
  });

  it("returns compact per-coin summary with freshness headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache", rows: [], first: { value: makeStablecoinsCacheValue(), updated_at: now - 42 } },
    ]);
    const res = await handleStablecoinSummary(db, "usdt-tether");
    const body = await res.json() as {
      id: string;
      symbol: string;
      supplyUsd: { current: number; change1d: number; change7d: number; change30d: number };
      chainCount: number;
      updatedAt: number;
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, max-age=10");
    expect(res.headers.get("X-Data-Age")).toBe("42");
    expect(body.id).toBe("usdt-tether");
    expect(body.symbol).toBe("USDT");
    expect(body.supplyUsd.current).toBe(100);
    expect(body.supplyUsd.change1d).toBe(10);
    expect(body.supplyUsd.change7d).toBe(20);
    expect(body.supplyUsd.change30d).toBe(30);
    expect(body.chainCount).toBe(2);
    expect(body.updatedAt).toBe(now - 42);
  });
});
