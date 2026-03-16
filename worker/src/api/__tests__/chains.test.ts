import { describe, it, expect, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

// Mock stablecoins to avoid importing full metadata tree
vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map([
    ["usdt-tether", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["usdc-circle", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["dai-makerdao", { flags: { backing: "crypto-backed" }, commodityOunces: undefined }],
  ]),
  TRACKED_STABLECOINS: [],
}));

import { handleChains } from "../chains";

function freshCache(payload: unknown, ageSeconds = 60) {
  return {
    match: "cache",
    matchBinds: ["stablecoins"],
    rows: [],
    first: {
      key: "stablecoins",
      value: JSON.stringify(payload),
      updated_at: Math.floor(Date.now() / 1000) - ageSeconds,
    },
  };
}

function reportCardCache(scores: Record<string, { score: number; grade: string }>) {
  return {
    match: "cache",
    matchBinds: ["report_card_cache"],
    rows: [],
    first: {
      key: "report_card_cache",
      value: JSON.stringify({
        scores,
        updatedAt: Math.floor(Date.now() / 1000) - 60,
      }),
      updated_at: Math.floor(Date.now() / 1000) - 60,
    },
  };
}

describe("handleChains", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const response = await handleChains(db);
    expect(response.status).toBe(503);
  });

  it("returns chains sorted by totalUsd", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
          circulating: { peggedUSD: 500 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 290, circulatingPrevWeek: 280, circulatingPrevMonth: 250 },
            bsc: { current: 200, circulatingPrevDay: 200, circulatingPrevWeek: 200, circulatingPrevMonth: 200 },
          },
        },
        {
          id: "usdc-circle", symbol: "USDC", name: "USD Coin", price: 0.999, pegType: "peggedUSD",
          circulating: { peggedUSD: 300 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 300, circulatingPrevWeek: 300, circulatingPrevMonth: 300 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" }, "usdc-circle": { score: 88, grade: "A" } }),
    ]);

    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = await response.json() as { chains: Array<{ id: string; totalUsd: number; healthScore: number | null }> };
    expect(body.chains[0].id).toBe("ethereum");
    expect(body.chains[0].totalUsd).toBe(600);
    expect(body.chains[0].healthScore).toBeTypeOf("number");
  });

  it("returns null healthScore when report card cache is missing", async () => {
    const payload = {
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
        },
      }],
    };

    const db = mockD1([freshCache(payload)]);
    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = await response.json() as { chains: Array<{ healthScore: number | null }> };
    // No report card cache → quality null → healthScore null
    expect(body.chains[0].healthScore).toBeNull();
  });
});
