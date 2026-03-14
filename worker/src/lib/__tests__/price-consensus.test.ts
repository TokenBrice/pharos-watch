import { describe, it, expect } from "vitest";
import { computePriceConsensus, type SourcePrice } from "../price-consensus";

describe("computePriceConsensus", () => {
  it("returns high confidence when 2+ sources agree within threshold", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 1 },
      { source: "defillama", price: 1.0003, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("high");
    expect(result!.price).toBeCloseTo(1.0001, 4);
    expect(result!.source).toContain("coingecko");
  });

  it("returns low confidence when sources diverge", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.01, weight: 1 },
      { source: "defillama", price: 0.98, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("low");
  });

  it("returns single-source when only one source available", () => {
    const sources: SourcePrice[] = [
      { source: "pyth", price: 0.999, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("single-source");
    expect(result!.price).toBe(0.999);
  });

  it("selects price closest to peg reference when diverging", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.05, weight: 1 },
      { source: "pyth", price: 1.001, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.price).toBe(1.001);
    expect(result!.source).toBe("pyth");
  });

  it("uses majority when 3+ sources and 2 agree", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 1 },
      { source: "defillama", price: 1.0002, weight: 1 },
      { source: "pyth", price: 0.97, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("high");
    expect(result!.price).toBeCloseTo(1.0001, 3);
  });

  it("prefers higher-weight source when multiple agree", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 1 },
      { source: "binance", price: 1.0002, weight: 2 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.price).toBe(1.0002);
    expect(result!.source).toContain("binance");
  });

  it("returns null for empty sources", () => {
    const result = computePriceConsensus([], 1.0, 50);
    expect(result).toBeNull();
  });

  it("handles NAV tokens by defaulting to highest-weight source", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.12, weight: 1 },
      { source: "defillama", price: 1.15, weight: 1 },
    ];
    const result = computePriceConsensus(sources, null, 50);
    expect(result!.confidence).toBe("high");
    expect(result!.price).toBe(1.12);
  });
});
