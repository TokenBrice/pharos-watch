import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeAsset } from "./helpers/fixtures";
import { handlePegSummary } from "../peg-summary";

const nowSec = Math.floor(Date.now() / 1000);

function makePegSummaryDb(assets: ReturnType<typeof makeAsset>[] = []) {
  const cacheValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "depeg_events", rows: [] },
    { match: "dex_prices", rows: [] },
    { match: "supply_history", rows: [] },
  ]);
}

function makePegSummaryDbWithDexPrice(
  assets: ReturnType<typeof makeAsset>[],
  updatedAt: number,
) {
  const cacheValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "depeg_events", rows: [] },
    {
      match: "dex_prices",
      rows: [
        {
          stablecoin_id: "usdt-tether",
          dex_price_usd: 1.0002,
          deviation_from_primary_bps: 2,
          source_pool_count: 4,
          source_total_tvl: 10_000_000,
          updated_at: updatedAt,
        },
      ],
    },
    { match: "supply_history", rows: [] },
  ]);
}

describe("handlePegSummary", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const res = await handlePegSummary(db);
    expect(res.status).toBe(503);
  });

  it("returns 200 with coins and summary", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coins: Array<{ id: string; methodologyVersion: string }>;
      summary: {
        activeDepegCount: number;
        medianDeviationBps: number;
        totalTracked: number;
        worstCurrent: { id: string; symbol: string; bps: number } | null;
      };
      methodology: {
        version: string;
        versionLabel: string;
        changelogPath: string;
      };
    };
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body.summary.activeDepegCount).toBe(0);
    expect(body.summary.medianDeviationBps).toBe(0);
    expect(body.summary.totalTracked).toBe(body.coins.length);
    expect(body.summary.worstCurrent).toEqual({ id: "usdt-tether", symbol: "USDT", bps: 0 });
    expect(body.coins.some((coin) => coin.id === "usdt-tether")).toBe(true);
    expect(body.coins[0].methodologyVersion).toBe(body.methodology.version);
    expect(body.methodology.versionLabel.length).toBeGreaterThan(0);
    expect(body.methodology.changelogPath).toBe("/methodology/depeg-changelog/");
  });

  it("includes X-Data-Age header", async () => {
    const asset = makeAsset();
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("keeps dexPriceCheck for data fresh enough for UI display", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 1800);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        dexPriceCheck?: {
          dexPrice: number;
          dexDeviationBps: number;
          agrees: boolean;
          sourcePools: number;
          sourceTvl: number;
        } | null;
      }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin?.dexPriceCheck).toEqual({
      dexPrice: 1.0002,
      dexDeviationBps: 2,
      agrees: true,
      sourcePools: 4,
      sourceTvl: 10_000_000,
    });
  });

  it("hides dexPriceCheck when data is too stale for UI display", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 7200);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{ id: string; dexPriceCheck?: { agrees: boolean } | null }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin?.dexPriceCheck).toBeUndefined();
  });

  it("keeps dexPriceCheck even when the primary price is temporarily missing", async () => {
    const asset = makeAsset({
      id: "usdt-tether",
      symbol: "USDT",
      price: null,
    });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 1800);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        dexPriceCheck?: {
          dexPrice: number;
          dexDeviationBps: number;
          agrees: boolean;
          sourcePools: number;
          sourceTvl: number;
        } | null;
      }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin?.dexPriceCheck).toEqual({
      dexPrice: 1.0002,
      dexDeviationBps: 2,
      agrees: true,
      sourcePools: 4,
      sourceTvl: 10_000_000,
    });
  });
});
