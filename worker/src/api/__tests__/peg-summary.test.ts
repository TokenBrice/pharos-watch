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
    const body = (await res.json()) as { coins: unknown[]; summary: Record<string, unknown> };
    expect(body).toHaveProperty("coins");
    expect(body).toHaveProperty("summary");
    expect(body.summary).toHaveProperty("activeDepegCount");
    expect(body.summary).toHaveProperty("medianDeviationBps");
    expect(body.summary).toHaveProperty("totalTracked");
  });

  it("includes X-Data-Age header", async () => {
    const asset = makeAsset();
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
