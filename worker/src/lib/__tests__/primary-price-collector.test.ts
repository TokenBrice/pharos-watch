import { describe, it, expect } from "vitest";
import { buildPrimarySourceCandidates, type PrimaryCollectedQuotes } from "../primary-price-collector";

function makeCollected(overrides: Partial<PrimaryCollectedQuotes> = {}): PrimaryCollectedQuotes {
  return {
    cgPrice: null,
    cgObservedAt: null,
    cgObservedAtMode: null,
    cgTickerPrice: null,
    cgTickerObservedAt: null,
    binancePrice: null,
    binanceObservedAt: null,
    krakenPrice: null,
    krakenObservedAt: null,
    bitstampPrice: null,
    bitstampObservedAt: null,
    coinbasePrice: null,
    coinbaseObservedAt: null,
    curvePrice: null,
    curveObservedAt: null,
    curveOraclePrice: null,
    curveOracleObservedAt: null,
    ...overrides,
  };
}

describe("buildPrimarySourceCandidates", () => {
  it("rejects a single promoted DEX protocol when only a soft aggregator agrees", () => {
    const collected = makeCollected({
      cgPrice: 1.0,
      cgObservedAt: 1_700_000_000,
      protocolSources: [
        {
          protocol: "balancer",
          price: 1.0,
          tvl: 500_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
    });

    const { sources, hasPromotedDexProtocolSource } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
    );

    expect(hasPromotedDexProtocolSource).toBe(true);
    expect(sources.some((s) => s.source.endsWith("-dex"))).toBe(false);
    expect(sources.map((s) => s.source)).toEqual(["coingecko"]);
  });

  it("accepts a single promoted DEX protocol when a hard CEX source agrees", () => {
    const collected = makeCollected({
      binancePrice: 1.0,
      binanceObservedAt: 1_700_000_000,
      protocolSources: [
        {
          protocol: "balancer",
          price: 1.0,
          tvl: 500_000,
          updatedAt: 1_700_000_000,
          chain: "ethereum",
        },
      ],
    });

    const { sources, hasPromotedDexProtocolSource } = buildPrimarySourceCandidates(
      { id: "dusd-test", symbol: "DUSD" },
      collected,
    );

    expect(hasPromotedDexProtocolSource).toBe(true);
    expect(sources.some((s) => s.source === "balancer-dex")).toBe(true);
  });
});
