import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";
import { handleReportCards } from "../../api/report-cards";
import {
  buildReportCardsSnapshot,
  ReportCardsSnapshotUnavailableError,
} from "../report-cards-snapshot";

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

describe("buildReportCardsSnapshot", () => {
  it("throws when stablecoins cache is missing", async () => {
    await expect(buildReportCardsSnapshot(mockD1())).rejects.toBeInstanceOf(
      ReportCardsSnapshotUnavailableError,
    );
  });

  it("returns cards + methodology + dependencyGraph + updatedAt", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    const snapshot = await buildReportCardsSnapshot(db);

    expect(Array.isArray(snapshot.cards)).toBe(true);
    expect(snapshot.cards.length).toBeGreaterThan(0);
    expect(snapshot.methodology).toHaveProperty("version");
    expect(snapshot.methodology).toHaveProperty("weights");
    expect(snapshot.methodology).toHaveProperty("thresholds");
    expect(Array.isArray(snapshot.dependencyGraph.edges)).toBe(true);
    expect(typeof snapshot.updatedAt).toBe("number");
  });

  it("matches /api/report-cards response payload", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    const snapshot = await buildReportCardsSnapshot(db);

    const response = await handleReportCards(db);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual(snapshot);
  });
});
