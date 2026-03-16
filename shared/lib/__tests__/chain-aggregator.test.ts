import { describe, it, expect } from "vitest";
import { aggregateChains, type ChainAggregatorInput } from "../chain-aggregator";

function makeInput(overrides: Partial<ChainAggregatorInput> = {}): ChainAggregatorInput {
  return {
    peggedAssets: [
      {
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 300, circulatingPrevDay: 295, circulatingPrevWeek: 280, circulatingPrevMonth: 250 },
          bsc: { current: 200, circulatingPrevDay: 200, circulatingPrevWeek: 200, circulatingPrevMonth: 200 },
        },
      },
      {
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        price: 0.999,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 250, circulatingPrevDay: 248, circulatingPrevWeek: 240, circulatingPrevMonth: 230 },
        },
      },
    ],
    safetyScores: { "usdt-tether": 75, "usdc-circle": 88 },
    pegRates: { peggedUSD: 1 },
    ...overrides,
  };
}

describe("aggregateChains", () => {
  it("aggregates chain totals and computes deltas", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum");
    expect(eth).toBeDefined();
    expect(eth!.totalUsd).toBe(550); // 300 + 250
    expect(eth!.stablecoinCount).toBe(2);
    expect(eth!.change24h).toBeCloseTo(7); // (300-295) + (250-248) = 5+2
  });

  it("sorts by totalUsd descending", () => {
    const result = aggregateChains(makeInput());
    expect(result.chains[0].id).toBe("ethereum");
    expect(result.chains[1].id).toBe("bsc");
  });

  it("excludes chains with zero total supply", () => {
    const input = makeInput({
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          bsc: { current: 0, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
        },
      }],
    });
    const result = aggregateChains(input);
    expect(result.chains.find((c) => c.id === "bsc")).toBeUndefined();
  });

  it("skips chains not in CHAIN_META", () => {
    const input = makeInput({
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 50, circulatingPrevDay: 50, circulatingPrevWeek: 50, circulatingPrevMonth: 50 },
          "unknown-chain-xyz": { current: 50, circulatingPrevDay: 50, circulatingPrevWeek: 50, circulatingPrevMonth: 50 },
        },
      }],
    });
    const result = aggregateChains(input);
    expect(result.chains.find((c) => c.id === "unknown-chain-xyz")).toBeUndefined();
  });

  it("computes globalTotalUsd across all chains", () => {
    const result = aggregateChains(makeInput());
    expect(result.globalTotalUsd).toBe(750); // 550 + 200
  });

  it("computes dominanceShare", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.dominanceShare).toBeCloseTo(550 / 750, 4);
  });

  it("computes health score factors", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.healthFactors.concentration).toBeGreaterThan(0);
    expect(eth.healthFactors.quality).toBeGreaterThan(0);
    expect(eth.healthFactors.pegStability).toBeGreaterThan(0);
    expect(eth.healthScore).toBeGreaterThan(0);
    expect(eth.healthBand).toBeTruthy();
  });

  it("deduplicates alias chains (hyperliquid)", () => {
    const input = makeInput({
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          hyperliquid: { current: 60, circulatingPrevDay: 60, circulatingPrevWeek: 60, circulatingPrevMonth: 60 },
          "hyperliquid-l1": { current: 40, circulatingPrevDay: 40, circulatingPrevWeek: 40, circulatingPrevMonth: 40 },
        },
      }],
    });
    const result = aggregateChains(input);
    const hl = result.chains.filter((c) => c.name === "Hyperliquid L1");
    expect(hl).toHaveLength(1);
    expect(hl[0].totalUsd).toBe(100);
  });
});
