import { describe, it, expect } from "vitest";
import { filterDiscoveryCandidates } from "../discovery-scan";

describe("filterDiscoveryCandidates", () => {
  const TRACKED_GECKO_IDS = new Set(["tether", "usd-coin", "dai"]);

  it("filters out already-tracked coins by geckoId", () => {
    const cgCoins = [
      { id: "tether", name: "Tether", symbol: "USDT", market_cap: 100_000_000_000 },
      { id: "new-stable", name: "NewStable", symbol: "NST", market_cap: 10_000_000 },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(1);
    expect(result[0].geckoId).toBe("new-stable");
  });

  it("filters out coins below market cap threshold", () => {
    const cgCoins = [
      { id: "tiny-stable", name: "TinyStable", symbol: "TS", market_cap: 1_000_000 },
      { id: "big-stable", name: "BigStable", symbol: "BS", market_cap: 50_000_000 },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(1);
    expect(result[0].geckoId).toBe("big-stable");
  });

  it("filters out coins with null market cap", () => {
    const cgCoins = [
      { id: "no-mcap", name: "NoMcap", symbol: "NM", market_cap: null },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(0);
  });

  it("returns empty when all coins are tracked", () => {
    const cgCoins = [
      { id: "tether", name: "Tether", symbol: "USDT", market_cap: 100_000_000_000 },
      { id: "usd-coin", name: "USD Coin", symbol: "USDC", market_cap: 50_000_000_000 },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(0);
  });
});
