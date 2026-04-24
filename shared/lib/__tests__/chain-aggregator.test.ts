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
    expect(result.chainAttributedTotalUsd).toBe(750);
    expect(result.unattributedTotalUsd).toBe(0);
  });

  it("computes dominanceShare", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.dominanceShare).toBeCloseTo(550 / 750, 4);
  });

  it("uses all tracked supply for the global total while preserving chain-attributed supply", () => {
    const input = makeInput({
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 700 },
          circulatingPrevDay: { peggedUSD: 680 },
          circulatingPrevWeek: { peggedUSD: 650 },
          circulatingPrevMonth: { peggedUSD: 600 },
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
          circulating: { peggedUSD: 300 },
          circulatingPrevDay: { peggedUSD: 290 },
          circulatingPrevWeek: { peggedUSD: 285 },
          circulatingPrevMonth: { peggedUSD: 260 },
          chainCirculating: {
            ethereum: { current: 250, circulatingPrevDay: 248, circulatingPrevWeek: 240, circulatingPrevMonth: 230 },
          },
        },
      ],
    });

    const result = aggregateChains(input);
    const eth = result.chains.find((c) => c.id === "ethereum")!;

    expect(result.globalTotalUsd).toBe(1000);
    expect(result.chainAttributedTotalUsd).toBe(750);
    expect(result.unattributedTotalUsd).toBe(250);
    expect(result.globalChange7dPct).toBeCloseTo((1000 - 935) / 935, 4);
    expect(eth.dominanceShare).toBeCloseTo(550 / 1000, 4);
  });

  it("includes the top stablecoins per chain by local supply", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;

    expect(eth.topStablecoins).toEqual([
      { id: "usdt-tether", symbol: "USDT", share: 300 / 550, supplyUsd: 300 },
      { id: "usdc-circle", symbol: "USDC", share: 250 / 550, supplyUsd: 250 },
    ]);
  });

  it("computes health score factors", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.healthFactors.concentration).toBeGreaterThan(0);
    expect(eth.healthFactors.quality).toBeGreaterThan(0);
    expect(eth.healthFactors.pegStability).toBeGreaterThan(0);
    expect(eth.healthFactors.chainEnvironment).toBeGreaterThan(0);
    expect(eth.healthScore).toBeGreaterThan(0);
    expect(eth.healthBand).toBeTruthy();
  });

  it("assigns tier 1 chain environment to ethereum", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.healthFactors.chainEnvironment).toBe(100); // tier 1
  });

  it("resolves DL chain names to CHAIN_META IDs", () => {
    const input = makeInput({
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          BSC: { current: 100, circulatingPrevDay: 90, circulatingPrevWeek: 80, circulatingPrevMonth: 70 },
          Ethereum: { current: 200, circulatingPrevDay: 190, circulatingPrevWeek: 180, circulatingPrevMonth: 170 },
        },
      }],
    });
    const result = aggregateChains(input);
    expect(result.chains).toHaveLength(2);
    const bsc = result.chains.find((c) => c.id === "bsc");
    const eth = result.chains.find((c) => c.id === "ethereum");
    expect(bsc).toBeDefined();
    expect(bsc!.totalUsd).toBe(100);
    expect(eth).toBeDefined();
    expect(eth!.totalUsd).toBe(200);
  });

  it("excludes unclassified coins from backing distribution used in health score", () => {
    const input = makeInput({
      peggedAssets: [
        {
          id: "dai-makerdao", symbol: "DAI", price: 1.0, pegType: "peggedUSD",
          chainCirculating: { ethereum: { current: 500, circulatingPrevDay: 500, circulatingPrevWeek: 500, circulatingPrevMonth: 500 } },
        },
        {
          id: "unknown-coin", symbol: "UNK", price: 1.0, pegType: "peggedUSD",
          chainCirculating: { ethereum: { current: 500, circulatingPrevDay: 500, circulatingPrevWeek: 500, circulatingPrevMonth: 500 } },
        },
      ],
      safetyScores: { "dai-makerdao": 60 },
      pegRates: { peggedUSD: 1 },
    });
    const result = aggregateChains(input);
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.healthFactors.backingDiversity).toBe(0);
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
