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
    expect(result!.price).toBeCloseTo(1.0002, 6);
    expect(result!.selectedSource).toBe("coingecko");
    expect(result!.source).toContain("coingecko");
  });

  it("uses the midpoint median for even-sized agreement clusters", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 0.999, weight: 2 },
      { source: "pyth", price: 1.001, weight: 2 },
    ];

    const result = computePriceConsensus(sources, 1.0, 50);

    expect(result!.confidence).toBe("high");
    expect(result!.price).toBe(1.0);
  });

  it("returns low confidence when sources diverge", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.01, weight: 1 },
      { source: "defillama", price: 0.98, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("low");
  });

  it("chooses trust tier before peg proximity for divergent fixed-peg sources", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.001, weight: 2 },
      { source: "binance", price: 0.985, weight: 2 },
    ];

    const result = computePriceConsensus(sources, 1.0, 50);

    expect(result!.confidence).toBe("low");
    expect(result!.source).toBe("binance");
    expect(result!.price).toBe(0.985);
  });

  it("returns single-source when only one source available", () => {
    const sources: SourcePrice[] = [{ source: "pyth", price: 0.999, weight: 1 }];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("single-source");
    expect(result!.price).toBe(0.999);
  });

  it("collapses repeated deployment quotes from one provider before consensus", () => {
    const sources: SourcePrice[] = [
      { source: "alchemy-address", price: 0.999, weight: 1, observedAt: 1_700_000_000 },
      { source: "alchemy-address", price: 1.0, weight: 1, observedAt: 1_700_000_010 },
      { source: "alchemy-address", price: 1.001, weight: 1, observedAt: 1_700_000_020 },
    ];

    const result = computePriceConsensus(sources, 1.0, 50);

    expect(result).toMatchObject({
      price: 1,
      source: "alchemy-address",
      confidence: "single-source",
      agreeSources: ["alchemy-address"],
      allPrices: { "alchemy-address": 1 },
      observedAt: 1_700_000_000,
    });
  });

  it("does not let repeated provider deployments outweigh an independent source", () => {
    const sources: SourcePrice[] = [
      { source: "alchemy-address", price: 0.998, weight: 1 },
      { source: "alchemy-address", price: 0.999, weight: 1 },
      { source: "alchemy-address", price: 1.0, weight: 1 },
      { source: "coingecko", price: 1.002, weight: 2 },
    ];

    const result = computePriceConsensus(sources, 1.0, 50);

    expect(result).toMatchObject({
      price: 1.0005,
      confidence: "high",
    });
    expect(result?.agreeSources.sort()).toEqual(["alchemy-address", "coingecko"]);
  });

  it("treats CoinGecko list and ticker quotes as one independent family", () => {
    const result = computePriceConsensus(
      [
        { source: "coingecko", price: 1.0002, weight: 2 },
        { source: "cg-ticker", price: 0.9999, weight: 2 },
      ],
      1.0,
      50,
    );

    expect(result).toMatchObject({
      price: 0.9999,
      source: "cg-ticker",
      selectedSource: "cg-ticker",
      confidence: "single-source",
      agreeSources: ["cg-ticker"],
    });
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

  it("requires fully pairwise agreement instead of chaining through a middle source", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0, weight: 3 },
      { source: "defillama", price: 1.004, weight: 1 },
      { source: "pyth", price: 1.008, weight: 2 },
    ];

    const result = computePriceConsensus(sources, 1.0, 50);

    expect(result!.confidence).toBe("high");
    expect(result!.source).toBe("coingecko+defillama");
    expect(result!.agreeSources).toEqual(expect.arrayContaining(["coingecko", "defillama"]));
    expect(result!.agreeSources).not.toContain("pyth");
    expect(result!.disagreeSources).toContain("pyth");
    expect(result!.price).toBe(1.002);
    expect(result!.selectedSource).toBe("coingecko");
  });

  it("breaks equal-size cluster ties by total cluster weight before peg proximity", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0, weight: 1 },
      { source: "defillama", price: 1.0002, weight: 1 },
      { source: "curve", price: 0.994, weight: 3 },
      { source: "pyth", price: 0.9942, weight: 3 },
    ];

    const result = computePriceConsensus(sources, 1.0, 50);

    expect(result!.confidence).toBe("high");
    expect(result!.source).toBe("curve+pyth");
    expect(result!.price).toBe(0.9941);
  });

  it("prefers hard-tier cluster over equal-size-equal-weight soft cluster", () => {
    // Two clusters of exactly size 2 and total weight 3 each:
    //   soft: coingecko(w=2)+defillama-list(w=1)  at 1.000
    //   hard: pyth(w=2)+binance(w=1)              at 0.992
    // Equal size AND equal weight → tiebreak: hard tier wins.
    const softA: SourcePrice = { source: "coingecko", price: 1.0, weight: 2 };
    const softB: SourcePrice = { source: "defillama-list", price: 1.0, weight: 1 };
    const hardA: SourcePrice = { source: "pyth", price: 0.992, weight: 2 };
    const hardB: SourcePrice = { source: "binance", price: 0.992, weight: 1 };
    const consensus = computePriceConsensus([softA, softB, hardA, hardB], 1.0, 50, { mode: "fixed" });
    expect(consensus!.agreeSources.sort()).toEqual(["binance", "pyth"]);
    expect(consensus!.agreeSources).not.toContain("coingecko");
    expect(consensus!.agreeSources).not.toContain("defillama-list");
    expect(consensus!.price).toBeCloseTo(0.992, 5);
  });

  it("prefers higher-weight source when multiple agree", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 1 },
      { source: "binance", price: 1.0002, weight: 2 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.price).toBe(1.00015);
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
    // Equal weight — tie broken by proximity to cluster median (1.135)
    expect(result!.price).toBeCloseTo(1.135, 6);
  });

  it("keeps fixed-peg clustering rules even when peg reference is temporarily unavailable", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0, weight: 2 },
      { source: "defillama", price: 1.008, weight: 1 },
    ];

    const result = computePriceConsensus(sources, null, 50, { mode: "fixed" });

    expect(result!.confidence).toBe("low");
    expect(result!.source).toBe("coingecko");
    expect(result!.price).toBe(1.0);
  });

  it("breaks weight tie by choosing source closest to peg reference", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.003, weight: 2 },
      { source: "binance", price: 1.001, weight: 2 },
      { source: "defillama", price: 1.002, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("high");
    // Binance (1.001) is closer to peg 1.0 than CoinGecko (1.003), same weight
    expect(result!.price).toBe(1.002);
    expect(result!.selectedSource).toBe("binance");
  });

  it("breaks weight tie for NAV tokens by choosing source closest to cluster median", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.12, weight: 2 },
      { source: "binance", price: 1.1, weight: 2 },
      { source: "defillama", price: 1.11, weight: 1 },
    ];
    const result = computePriceConsensus(sources, null, 50);
    expect(result!.confidence).toBe("high");
    expect(result!.price).toBe(1.11);
    expect(["coingecko", "binance"]).toContain(result!.selectedSource);
  });

  it("agrees at exactly 50bps boundary (inclusive)", () => {
    // 1.0000 and 1.0050 are exactly 50bps apart: |1.0050-1.0000|/1.0025 * 10000 ≈ 49.9 bps
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0, weight: 1 },
      { source: "defillama", price: 1.005, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("high");
  });

  it("includes all agree sources in the source label", () => {
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0001, weight: 2 },
      { source: "binance", price: 1.0002, weight: 2 },
      { source: "pyth", price: 1.0001, weight: 2 },
      { source: "redstone", price: 1.0003, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    // All 4 sources agree within 50 bps — label should include all
    expect(result!.source).toContain("coingecko");
    expect(result!.source).toContain("binance");
    expect(result!.source).toContain("pyth");
    expect(result!.source).toContain("redstone");
    expect(result!.source).not.toContain("more");
  });

  it("disagrees just beyond 50bps boundary", () => {
    // 1.0000 and 1.0060 are ~60bps apart — should disagree
    const sources: SourcePrice[] = [
      { source: "coingecko", price: 1.0, weight: 1 },
      { source: "defillama", price: 1.006, weight: 1 },
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result!.confidence).toBe("low");
  });
});
