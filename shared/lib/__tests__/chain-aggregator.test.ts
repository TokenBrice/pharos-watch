import { describe, it, expect } from "vitest";
import { aggregateChains, type ChainAggregatorInput } from "../chains/aggregator";

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
    updatedAt: 1_752_560_000,
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

  it("pairs 30d deltas only across assets with a previous-month value", () => {
    const result = aggregateChains(makeInput({
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          price: 1,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          circulatingPrevMonth: null,
          chainCirculating: { ethereum: { current: 100 } },
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          price: 1,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 50 },
          circulatingPrevMonth: { peggedUSD: 40 },
          chainCirculating: { ethereum: { current: 50, circulatingPrevMonth: 40 } },
        },
      ],
    }));
    const ethereum = result.chains.find((chain) => chain.id === "ethereum")!;

    expect(result.globalTotalUsd).toBe(150);
    expect(result.globalChange30dPct).toBeCloseTo(0.25);
    expect(ethereum.change30d).toBe(10);
    expect(ethereum.change30dPct).toBeCloseTo(0.25);
  });

  it("publishes the caller's source generation timestamp, never wall-clock time", () => {
    const result = aggregateChains(makeInput({ updatedAt: 1_234_567 }));
    expect(result.updatedAt).toBe(1_234_567);
  });

  it("applies one prev-month rule to chain and per-coin 30d deltas when duplicate labels resolve to one chain", () => {
    const result = aggregateChains(makeInput({
      detailChainId: "ethereum",
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          price: 1,
          pegType: "peggedUSD",
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevMonth: 50 },
            Ethereum: { current: 20 },
          },
        },
      ],
    }));
    const ethereum = result.chains.find((chain) => chain.id === "ethereum")!;
    expect(ethereum.change30d).toBeNull();
    expect(ethereum.change30dPct).toBeNull();
    expect(result.chainDetail?.coins[0]?.change30d).toBeNull();
  });

  it("keeps missing history unknown and pairs only known supply, including explicit zero", () => {
    const input = makeInput({
      detailChainId: "ethereum",
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", price: 1, chainCirculating: { ethereum: { current: 100 } } },
        { id: "usdc-circle", symbol: "USDC", price: 1, chainCirculating: {
          ethereum: { current: 50, circulatingPrevDay: 0, circulatingPrevWeek: 40, circulatingPrevMonth: 25 },
        } },
      ],
    });
    const result = aggregateChains(input);
    expect(result.chains[0]).toMatchObject({
      totalUsd: 150, change24h: 50, change7d: 10, change7dPct: 0.25, change30d: 25, change30dPct: 1,
    });
    expect(result.globalChange7dPct).toBe(0.25);
    expect(result.chainDetail?.coins[0]).toMatchObject({
      change24h: null, change24hPct: null, change7d: null, change7dPct: null, change30d: null, change30dPct: null,
    });
    expect(result.chainDetail?.coins[1]).toMatchObject({ change24h: 50, change7d: 10, change7dPct: 0.25 });

    const unknown = aggregateChains({ ...input, peggedAssets: input.peggedAssets.slice(0, 1) });
    expect(unknown.chains[0]).toMatchObject({
      change24h: null, change24hPct: null, change7d: null, change7dPct: null, change30d: null, change30dPct: null,
    });
    expect(unknown.globalChange24hPct).toBeNull();
    expect(unknown.globalChange7dPct).toBeNull();
    expect(unknown.globalChange30dPct).toBeNull();
  });

  it("never manufactures chain mints or redemptions from unavailable observations; numeric zero still counts", () => {
    const usdc = { id: "usdc-circle", symbol: "USDC", price: 1, chainCirculating: { ethereum: { current: 50, circulatingPrevDay: 50 } } };
    // Empty current (normalized to null): no -100 redemption and no understated chain total posing as observed.
    const emptyCurrent = aggregateChains(makeInput({ peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", price: 1, chainCirculating: { ethereum: { current: null, circulatingPrevDay: 100 } } },
      usdc,
    ] }));
    expect(emptyCurrent.chains.find((chain) => chain.id === "ethereum")).toMatchObject({ totalUsd: 50, change24h: 0, change24hPct: 0 });

    // Empty prevDay (normalized to null): the whole current is not reported as a 24h mint.
    const emptyPrevDay = aggregateChains(makeInput({ peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", price: 1, chainCirculating: { ethereum: { current: 150, circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null } } },
      usdc,
    ] }));
    expect(emptyPrevDay.chains.find((chain) => chain.id === "ethereum")).toMatchObject({ totalUsd: 200, change24h: 0 });

    // An explicit zero current is a genuine redemption.
    const zeroCurrent = aggregateChains(makeInput({ peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", price: 1, chainCirculating: { ethereum: { current: 0, circulatingPrevDay: 100 } } },
      usdc,
    ] }));
    expect(zeroCurrent.chains.find((chain) => chain.id === "ethereum")).toMatchObject({ totalUsd: 50, change24h: -100 });
  });

  it("excludes absent aggregate buckets from global supply while counting an observed zero", () => {
    const result = aggregateChains(makeInput({ peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", price: 1, circulating: {}, circulatingPrevDay: { peggedUSD: 40 },
        chainCirculating: { ethereum: { current: 100 } } },
      { id: "usdc-circle", symbol: "USDC", price: 1, circulating: { peggedUSD: 0 }, circulatingPrevDay: { peggedUSD: 20 },
        chainCirculating: {} },
      { id: "dai-makerdao", symbol: "DAI", price: 1, circulating: { peggedUSD: 60 }, circulatingPrevDay: { peggedUSD: 60 },
        chainCirculating: { ethereum: { current: 60 } } },
    ] }));
    expect(result.globalTotalUsd).toBe(60);
    // Paired 24h: (0 + 60) vs (20 + 60); the absent USDT aggregate neither adds supply nor pairs its prevDay.
    expect(result.globalChange24hPct).toBeCloseTo(-0.25);
  });

  it("pairs global production supply only with assets that have historical anchors", () => {
    const result = aggregateChains(makeInput({ peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100 },
        chainCirculating: { ethereum: { current: 100 } } },
      { id: "usdc-circle", symbol: "USDC", price: 1, circulating: { peggedUSD: 50 },
        circulatingPrevDay: { peggedUSD: 40 }, circulatingPrevWeek: { peggedUSD: 40 },
        circulatingPrevMonth: { peggedUSD: 40 }, chainCirculating: {
          ethereum: { current: 50, circulatingPrevDay: 40, circulatingPrevWeek: 40, circulatingPrevMonth: 40 },
        } },
    ] }));
    expect(result.globalTotalUsd).toBe(150);
    expect(result.globalChange24hPct).toBe(0.25);
    expect(result.globalChange7dPct).toBe(0.25);
    expect(result.globalChange30dPct).toBe(0.25);
  });

  it.each([true, false])("retains fully redeemed rows in paired history (aggregate supply: %s)", (aggregateSupply) => {
    const input = makeInput({ peggedAssets: [
      { id: "usdt-tether", symbol: "USDT", price: 1,
        ...(aggregateSupply ? { circulating: { peggedUSD: 0 },
          circulatingPrevDay: { peggedUSD: 100 }, circulatingPrevWeek: { peggedUSD: 100 },
          circulatingPrevMonth: { peggedUSD: 100 } } : {}),
        chainCirculating: { ethereum: { current: 0, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 } } },
      { id: "usdc-circle", symbol: "USDC", price: 1,
        ...(aggregateSupply ? { circulating: { peggedUSD: 50 },
          circulatingPrevDay: { peggedUSD: 50 }, circulatingPrevWeek: { peggedUSD: 50 },
          circulatingPrevMonth: { peggedUSD: 50 } } : {}),
        chainCirculating: { ethereum: { current: 50, circulatingPrevDay: 50, circulatingPrevWeek: 50, circulatingPrevMonth: 50 } } },
    ] });
    const result = aggregateChains(input);
    expect(result.chains[0]).toMatchObject({ totalUsd: 50, stablecoinCount: 1, change24h: -100, change7d: -100, change30d: -100 });
    expect(result.globalChange24hPct).toBeCloseTo(-100 / 150);
    expect(result.globalChange7dPct).toBeCloseTo(-100 / 150);
    expect(result.globalChange30dPct).toBeCloseTo(-100 / 150);

    // The only paired current supply is now zero, but its history is still known.
    input.peggedAssets[1] = { id: "usdc-circle", symbol: "USDC", price: 1,
      ...(aggregateSupply ? { circulating: { peggedUSD: 50 } } : {}),
      chainCirculating: { ethereum: { current: 50 } } };
    const redeemed = aggregateChains(input);
    expect(redeemed.chains[0]).toMatchObject({ change24h: -100, change24hPct: -1, change7d: -100, change7dPct: -1, change30d: -100, change30dPct: -1 });
    expect(redeemed.globalChange24hPct).toBe(-1);
    expect(redeemed.globalChange7dPct).toBe(-1);
    expect(redeemed.globalChange30dPct).toBe(-1);

    const fullyRedeemed = aggregateChains({ ...input, peggedAssets: input.peggedAssets.slice(0, 1) });
    expect(fullyRedeemed.globalTotalUsd).toBe(0);
    expect(fullyRedeemed.globalChange24hPct).toBe(-1);
    expect(fullyRedeemed.globalChange7dPct).toBe(-1);
    expect(fullyRedeemed.globalChange30dPct).toBe(-1);

    // Explicit zero/zero is covered history, not an unavailable window.
    input.peggedAssets[0] = { id: "usdt-tether", symbol: "USDT", price: 1,
      ...(aggregateSupply ? { circulating: { peggedUSD: 0 }, circulatingPrevDay: { peggedUSD: 0 },
        circulatingPrevWeek: { peggedUSD: 0 }, circulatingPrevMonth: { peggedUSD: 0 } } : {}),
      chainCirculating: { ethereum: { current: 0, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 } } };
    const zero = aggregateChains(input);
    expect(zero.chains[0]).toMatchObject({ change24h: 0, change24hPct: 0, change7d: 0, change7dPct: 0, change30d: 0, change30dPct: 0 });
    expect(zero.globalChange24hPct).toBe(0);
    expect(zero.globalChange7dPct).toBe(0);
    expect(zero.globalChange30dPct).toBe(0);
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
    expect(result.attributionDiscrepancyUsd).toBe(-250);
    expect(result.dominanceGeometryTotalUsd).toBe(1000);
    expect(result.globalChange7dPct).toBeCloseTo((1000 - 935) / 935, 4);
    expect(eth.dominanceShare).toBeCloseTo(550 / 1000, 4);
  });

  it("publishes raw over-attribution as a signed discrepancy instead of capping chain shares", () => {
    const result = aggregateChains(makeInput({
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          price: 1,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 60 },
          chainCirculating: { ethereum: { current: 90 } },
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          price: 1,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 40 },
          chainCirculating: { base: { current: 60 } },
        },
      ],
    }));

    // Canonical global supply stays its own authority; chain rows keep their raw totals.
    expect(result.globalTotalUsd).toBe(100);
    expect(result.chainAttributedTotalUsd).toBe(150);
    expect(result.chainAttributedTotalUsd).toBe(result.chains.reduce((sum, chain) => sum + chain.totalUsd, 0));
    expect(result.attributionDiscrepancyUsd).toBe(50);
    expect(result.unattributedTotalUsd).toBe(0);
    // Shares keep the global denominator (no hidden rescale); geometry names the larger raw total.
    expect(result.chains.find((chain) => chain.id === "ethereum")?.dominanceShare).toBeCloseTo(0.9);
    expect(result.chains.find((chain) => chain.id === "base")?.dominanceShare).toBeCloseTo(0.6);
    expect(result.dominanceGeometryTotalUsd).toBe(150);
    for (const chain of result.chains) {
      expect(chain.totalUsd / result.dominanceGeometryTotalUsd!).toBeLessThanOrEqual(1);
    }
  });

  it("discloses unobserved aggregate and chain supply instead of silently dropping it", () => {
    const result = aggregateChains(makeInput({
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          price: 1,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: { ethereum: { current: 60 }, tron: { current: null } },
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          price: 1,
          pegType: "peggedUSD",
          circulating: {},
          chainCirculating: { ethereum: { current: null }, bsc: { current: 30 } },
        },
      ],
    }));

    expect(result.supplyCoverage).toEqual({
      aggregateUnavailableAssetCount: 1,
      chainUnavailableObservationCount: 2,
      chainIdsWithUnavailableObservations: ["ethereum", "tron"],
    });
    // Tron has no observed row, so it is not published, but it is still named above.
    expect(result.chains.find((chain) => chain.id === "tron")).toBeUndefined();
    expect(result.chains.find((chain) => chain.id === "ethereum")).toMatchObject({
      totalUsd: 60,
      unavailableSupplyObservationCount: 1,
    });
    expect(result.chains.find((chain) => chain.id === "bsc")?.unavailableSupplyObservationCount).toBe(0);
  });

  it("includes the top stablecoins per chain by local supply", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;

    expect(eth.topStablecoins).toEqual([
      { id: "usdt-tether", symbol: "USDT", share: 300 / 550, supplyUsd: 300 },
      { id: "usdc-circle", symbol: "USDC", share: 250 / 550, supplyUsd: 250 },
    ]);
  });

  it("rewards diversified holdings with identical total supply and coin quality", () => {
    const input = makeInput({ safetyScores: { "usdt-tether": 80, "usdc-circle": 80 } });
    for (const coin of input.peggedAssets) coin.price = 1;
    const diversified = aggregateChains(input).chains.find((chain) => chain.id === "ethereum")!;
    input.peggedAssets[0].chainCirculating = { ethereum: { current: 550 } };
    input.peggedAssets[1].chainCirculating = { ethereum: { current: 0 } };
    const concentrated = aggregateChains(input).chains.find((chain) => chain.id === "ethereum")!;
    expect(diversified.totalUsd).toBe(concentrated.totalUsd);
    expect(diversified.healthFactors.concentration).toBe(50);
    expect(concentrated.healthFactors.concentration).toBe(0);
    expect(diversified.healthFactors.quality).toBe(concentrated.healthFactors.quality);
    expect(diversified.healthFactors.pegStability).toBe(concentrated.healthFactors.pegStability);
    expect(diversified.healthScore).toBeGreaterThan(concentrated.healthScore!);
  });

  it("propagates independent safety-score and price deterioration into health", () => {
    const input = makeInput();
    const baseline = aggregateChains(input).chains.find((chain) => chain.id === "ethereum")!;
    const lowerQuality = aggregateChains({
      ...input, safetyScores: { "usdt-tether": 20, "usdc-circle": 30 },
    }).chains.find((chain) => chain.id === "ethereum")!;
    expect(baseline.healthFactors.quality).toBe(81);
    expect(lowerQuality.healthFactors.quality).toBe(25);
    expect(lowerQuality.healthFactors.pegStability).toBe(baseline.healthFactors.pegStability);
    expect(baseline.healthBand).toBe("healthy");
    expect(lowerQuality.healthBand).toBe("mixed");
    expect(lowerQuality.healthScore).toBeLessThan(baseline.healthScore!);
    input.peggedAssets[0].price = 0.9;
    const depegged = aggregateChains(input).chains.find((chain) => chain.id === "ethereum")!;
    expect(depegged.healthFactors.quality).toBe(baseline.healthFactors.quality);
    expect(depegged.healthFactors.pegStability).toBeLessThan(baseline.healthFactors.pegStability!);
    expect(depegged.healthScore).toBeLessThan(baseline.healthScore!);
  });

  it("withholds composite health when rated supply is unavailable", () => {
    const eth = aggregateChains(makeInput({ safetyScores: {} })).chains.find((chain) => chain.id === "ethereum")!;
    expect(eth.healthFactors.quality).toBeNull();
    expect(eth.healthScore).toBeNull();
    expect(eth.healthBand).toBeNull();
  });

  it("excludes non-USD holdings lacking a reference rather than assuming dollar parity", () => {
    const input = makeInput();
    input.peggedAssets[0].pegType = "peggedEUR";
    input.peggedAssets[0].price = 1.2;
    input.peggedAssets[1].price = 1;
    const missing = aggregateChains(input).chains.find((chain) => chain.id === "ethereum")!;
    const referenced = aggregateChains({
      ...input, pegRates: { peggedUSD: 1, peggedEUR: 1 },
    }).chains.find((chain) => chain.id === "ethereum")!;
    expect(missing.healthFactors.pegStability).toBe(100);
    expect(referenced.healthFactors.pegStability).toBe(45);
    expect(missing.healthScore).toBeNull();
    expect(missing.healthBand).toBeNull();
    expect(referenced.healthScore).not.toBeNull();
    // The missing-reference supply stays in the coverage denominator rather than vanishing.
    expect(missing.pegStabilityCoverage).toMatchObject({
      status: "partial",
      observedSupplyUsd: 250,
      eligibleSupplyUsd: 550,
      noPegReferenceSupplyUsd: 300,
      neutralImputedSupplyUsd: 0,
      observedScore: 100,
    });
    expect(referenced.pegStabilityCoverage?.status).toBe("complete");
  });

  it("publishes NR factor and composite when every price is missing", () => {
    const input = makeInput();
    for (const coin of input.peggedAssets) coin.price = null;
    const eth = aggregateChains(input).chains.find((chain) => chain.id === "ethereum")!;
    expect(eth.healthFactors.pegStability).toBeNull();
    expect(eth.healthScore).toBeNull();
    expect(eth.healthBand).toBeNull();
    expect(eth.pegStabilityCoverage).toEqual({
      status: "unavailable",
      observedSupplyUsd: 0,
      eligibleSupplyUsd: 550,
      coverage: 0,
      noUsablePriceSupplyUsd: 550,
      noPegReferenceSupplyUsd: 0,
      neutralImputedSupplyUsd: 0,
      observedScore: null,
    });
  });

  it("assigns tier 1 chain environment to ethereum", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.healthFactors.chainEnvironment).toBe(100); // tier 1
    expect(eth.chainEnvironmentEvidence).toEqual({
      source: "pharos-chain-tier",
      score: 100,
      resilienceTier: 1,
    });
  });

  it("uses L2BEAT chain environment scoring for matched chains", () => {
    const input = makeInput({
      peggedAssets: [
        {
          id: "usdc-circle",
          symbol: "USDC",
          price: 1.0,
          pegType: "peggedUSD",
          chainCirculating: {
            base: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
      safetyScores: { "usdc-circle": 88 },
    });
    const result = aggregateChains(input);
    const base = result.chains.find((c) => c.id === "base")!;
    expect(base.healthFactors.chainEnvironment).toBe(82);
    expect(base.chainEnvironmentEvidence).toMatchObject({
      source: "l2beat",
      projectId: "base",
      stage: "Stage 1",
      stageScore: 80,
      riskScore: 84,
      score: 82,
      snapshot: {
        source: "https://l2beat.com/api/scaling/summary",
        fetchedAt: "2026-06-12",
      },
    });
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
