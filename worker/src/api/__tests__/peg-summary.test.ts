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
          stablecoin_id: "1",
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
    const asset = makeAsset({ id: "1", symbol: "USDT" });
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coins: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      methodology: Record<string, unknown>;
    };
    expect(body).toHaveProperty("coins");
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("methodology");
    expect(body.summary).toHaveProperty("activeDepegCount");
    expect(body.summary).toHaveProperty("medianDeviationBps");
    expect(body.summary).toHaveProperty("totalTracked");
    if (body.coins.length > 0) {
      expect(body.coins[0]).toHaveProperty("methodologyVersion");
    }
    expect(body.methodology).toHaveProperty("version");
    expect(body.methodology).toHaveProperty("versionLabel");
    expect(body.methodology).toHaveProperty("changelogPath");
  });

  it("includes X-Data-Age header", async () => {
    const asset = makeAsset();
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("keeps dexPriceCheck for data fresh enough for UI display", async () => {
    const asset = makeAsset({ id: "1", symbol: "USDT" });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 1800);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{ id: string; dexPriceCheck?: { agrees: boolean } | null }>;
    };
    const coin = body.coins.find((c) => c.id === "1");
    expect(coin?.dexPriceCheck).toBeTruthy();
  });

  it("hides dexPriceCheck when data is too stale for UI display", async () => {
    const asset = makeAsset({ id: "1", symbol: "USDT" });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 7200);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{ id: string; dexPriceCheck?: { agrees: boolean } | null }>;
    };
    const coin = body.coins.find((c) => c.id === "1");
    expect(coin?.dexPriceCheck).toBeUndefined();
  });
});
