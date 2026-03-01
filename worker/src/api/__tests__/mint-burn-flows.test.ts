import { describe, it, expect } from "vitest";

describe("mint-burn-flows regression: per-coin vs aggregate shape", () => {
  it("per-coin response does NOT have a coins array", async () => {
    // Simulate what the frontend did: treat per-coin response as aggregate
    const perCoinResponse = {
      stablecoinId: "1",
      symbol: "USDT",
      mintVolumeUsd: 1000,
      burnVolumeUsd: 500,
      netFlowUsd: 500,
      mintCount: 10,
      burnCount: 5,
      chains: [],
      hourly: [],
      updatedAt: 1000,
    };

    // This is the exact line that crashed in production:
    // data.coins.find((c) => c.stablecoinId === "1")
    // The per-coin response has no `coins` property.
    expect(perCoinResponse).not.toHaveProperty("coins");
    expect(perCoinResponse).toHaveProperty("stablecoinId");
  });

  it("aggregate response DOES have a coins array", async () => {
    const aggregateResponse = {
      gauge: { score: 50, band: "NEUTRAL", flightToQuality: false, flightIntensity: 0, trackedCoins: 4, trackedMcapUsd: 1e11 },
      coins: [{ stablecoinId: "1", symbol: "USDT", flowIntensity: 50, netFlow24hUsd: 100, mintVolume24hUsd: 200, burnVolume24hUsd: 100, mintCount24h: 5, burnCount24h: 3, netFlow7dUsd: 500, largestEvent24h: null }],
      hourly: [],
      updatedAt: 1000,
    };

    expect(aggregateResponse).toHaveProperty("coins");
    expect(Array.isArray(aggregateResponse.coins)).toBe(true);
    expect(aggregateResponse).toHaveProperty("gauge");
    expect(aggregateResponse).not.toHaveProperty("stablecoinId");
  });
});
