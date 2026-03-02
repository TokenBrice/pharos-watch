import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeAsset } from "./helpers/fixtures";
import { handleReportCards } from "../report-cards";

const nowSec = Math.floor(Date.now() / 1000);

function makeReportCardsDb(assets: ReturnType<typeof makeAsset>[] = []) {
  const cacheValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "cache",
      rows: [
        { key: "stablecoins", value: cacheValue, updated_at: nowSec },
        { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
      ],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "dex_liquidity", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "supply_history", rows: [] },
  ]);
}

describe("handleReportCards", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const res = await handleReportCards(db);
    expect(res.status).toBe(503);
  });

  it("returns 200 with cards, methodology, and dependencyGraph", async () => {
    const asset = makeAsset({ id: "1", symbol: "USDT" });
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cards: unknown[];
      methodology: Record<string, unknown>;
      dependencyGraph: { edges: unknown[] };
      updatedAt: number;
    };
    expect(body).toHaveProperty("cards");
    expect(body).toHaveProperty("methodology");
    expect(body).toHaveProperty("dependencyGraph");
    expect(body).toHaveProperty("updatedAt");
    expect(body.methodology).toHaveProperty("version");
    expect(body.methodology).toHaveProperty("weights");
    expect(body.methodology).toHaveProperty("thresholds");
    expect(Array.isArray(body.cards)).toBe(true);
    expect(Array.isArray(body.dependencyGraph.edges)).toBe(true);
  });

  it("includes cards with expected dimensions", async () => {
    const asset = makeAsset({ id: "1", symbol: "USDT" });
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    const body = (await res.json()) as { cards: Array<Record<string, unknown>> };
    // Should have at least one card (tracked stablecoins + dead stablecoins)
    expect(body.cards.length).toBeGreaterThan(0);
    const card = body.cards[0];
    expect(card).toHaveProperty("id");
    expect(card).toHaveProperty("overallGrade");
    expect(card).toHaveProperty("overallScore");
    expect(card).toHaveProperty("dimensions");
  });

  it("includes X-Data-Age header", async () => {
    const asset = makeAsset();
    const db = makeReportCardsDb([asset]);
    const res = await handleReportCards(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
