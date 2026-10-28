import { describe, expect, it } from "vitest";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";

function makeCoin(price: number | null) {
  return makeStablecoin({
    geckoId: "usd-coin",
    price,
    priceSource: "coingecko",
    priceConfidence: "high",
    circulating: { peggedUSD: 1_000_000 },
    circulatingPrevDay: { peggedUSD: 1_000_000 },
    circulatingPrevWeek: { peggedUSD: 1_000_000 },
    supplySource: "defillama",
    chains: ["Ethereum"],
  });
}

function build(price: number | null, currentDeviationBps: number | null) {
  const pegSummaryCoin = makePegSummaryCoin({ currentDeviationBps });
  return buildStablecoinTableRowModel({
    coin: makeCoin(price),
    pegScores: new Map([[pegSummaryCoin.id, pegSummaryCoin]]),
    density: "spacious",
    variant: "default",
  });
}

describe("buildStablecoinTableRowModel peg deviation", () => {
  it("does not display nominal price or a cached on-peg signal as an observation", () => {
    const coin = makeStablecoin({
      id: "usdc-circle",
      price: 1,
      priceSource: "protocol-par",
      priceObservedAtMode: "nominal_reference",
      priceConfidence: "high",
    });
    const model = buildStablecoinTableRowModel({
      coin,
      pegScores: new Map([[coin.id, makePegSummaryCoin({
        id: coin.id,
        currentDeviationBps: 0,
        pegReference: { valueUsd: 1, source: "median", contributorCount: 2, asOf: 1_700_000_000 },
      })]]),
      density: "spacious",
      variant: "default",
    });
    expect(model.priceCell).toBe("—");
    expect(model.pegDeviationBps).toBeNull();
    expect(model.absPegDeviationBps).toBeNull();
  });

  it("uses the Worker deviation for both display and severity", () => {
    const model = build(1.02, -50);

    expect(model.pegDeviationBps).toBe(-50);
    expect(model.absPegDeviationBps).toBe(50);
    expect(model.pegDeviationColorClass).toBe("text-amber-700 dark:text-amber-400");
  });

  it("does not turn a Worker-unavailable deviation into an on-peg signal", () => {
    for (const price of [null, Number.NaN]) {
      const model = build(price, null);
      expect(model.absPegDeviationBps).toBeNull();
      expect(model.pegDeviationColorClass).toBe("text-muted-foreground");
    }
  });

  it("preserves a real zero deviation as a numeric signal", () => {
    const model = build(1.2, 0);

    expect(model.absPegDeviationBps).toBe(0);
    expect(model.pegDeviationColorClass).toBe("text-green-700 dark:text-green-400");
  });

  it("renders an absent commodity reference as an em dash and skips deviation", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({
        id: "xaut-tether",
        symbol: "XAUT",
        pegType: "peggedGOLD",
        price: 3_000,
        circulating: { peggedGOLD: 1_000_000 },
      }),
      pegScores: new Map([["xaut-tether", makePegSummaryCoin({
        id: "xaut-tether",
        symbol: "XAUT",
        name: "Tether Gold",
        pegType: "peggedGOLD",
        pegCurrency: "GOLD",
        currentDeviationBps: null,
        pegReference: null,
        pegReferenceUnavailable: true,
      })]]),
      density: "spacious",
      variant: "default",
    });

    expect(model.pegRef).toBeNull();
    expect(model.priceCell).toBe("—");
    expect(model.absPegDeviationBps).toBeNull();
  });

  it.each([
    ["USD", "usdc-circle", "peggedUSD", 0.98, 1, -200, 200],
    ["non-USD", "eurc-circle", "peggedEUR", 1.08, 1.2, -1000, 1000],
    ["commodity", "xaut-tether", "peggedGOLD", 3030, 3000, 100, 100],
    ["unavailable reference", "eurc-circle", "peggedEUR", 1.08, null, null, null],
    ["unavailable price", "usdc-circle", "peggedUSD", null, 1, null, null],
    ["NAV", "fpi-frax", "peggedVAR", 1.2, null, null, null],
  ] as const)("pins the %s peg-summary projection", (
    _label,
    id,
    pegType,
    price,
    pegReference,
    currentDeviationBps,
    expectedAbsDeviationBps,
  ) => {
    const pegSummaryCoin = makePegSummaryCoin({
      id,
      pegType,
      currentDeviationBps,
      pegReference: pegReference == null
        ? null
        : { valueUsd: pegReference, source: "median", contributorCount: 2, asOf: 1_700_000_000 },
      ...(pegReference == null && pegType !== "peggedVAR" ? { pegReferenceUnavailable: true } : {}),
    });
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({ id, pegType, price }),
      pegScores: new Map([[id, pegSummaryCoin]]),
      density: "spacious",
      variant: "default",
    });

    expect(model.pegRef).toBe(pegReference);
    expect(model.absPegDeviationBps).toBe(expectedAbsDeviationBps);
  });
});

describe("buildStablecoinTableRowModel NAV price", () => {
  const observed = { priceSource: "coingecko", priceConfidence: "high" } as const;
  const eurPeer = makePegSummaryCoin({
    id: "eurc-circle",
    pegType: "peggedEUR",
    pegCurrency: "EUR",
    pegReference: { valueUsd: 1.1, source: "median", contributorCount: 3, asOf: 1_700_000_000 },
  });

  it("shows a USD NAV token's observed price without a peg reference", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({ id: "susds-sky", price: 1.0834, ...observed }),
      pegScores: new Map([["susds-sky", makePegSummaryCoin({ id: "susds-sky", pegReference: null })]]),
      density: "spacious",
      variant: "default",
    });
    expect(model.pegRef).toBeNull();
    expect(model.priceCell).toBe("$1.0834");
  });

  it("converts a non-USD NAV token's price with a peer's currency reference", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({ id: "eutbl-spiko", pegType: "peggedEUR", price: 1.21, ...observed }),
      pegScores: new Map([[eurPeer.id, eurPeer]]),
      density: "spacious",
      variant: "default",
    });
    expect(model.priceCell).toBe("€1.1000");
  });

  it("falls back to the USD price when no peer published a currency reference", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({ id: "eutbl-spiko", pegType: "peggedEUR", price: 1.21, ...observed }),
      pegScores: new Map(),
      density: "spacious",
      variant: "default",
    });
    expect(model.priceCell).toBe("$1.2100");
  });

  it("keeps an unobserved NAV price unavailable", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({ id: "susds-sky", price: null, ...observed }),
      density: "spacious",
      variant: "default",
    });
    expect(model.priceCell).toBe("N/A");
  });
});

describe("buildStablecoinTableRowModel supply changes", () => {
  it.each([true, undefined])("withholds partial-chain changes and incompatible sparkline (explicit partial=%s)", (partialCoverage) => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({
        circulating: { peggedUSD: 50 },
        circulatingPrevDay: { peggedUSD: 100 },
        circulatingPrevWeek: { peggedUSD: 100 },
        supplyChainGuard: {
          reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage,
          chains: [{ chainId: "ethereum", chainLabel: "Ethereum", listCurrentUsd: 0,
            baselineUsd: 50, baselineObservedAt: 1_792_700_000, baselineSource: "state", resolution: "unavailable" }],
        },
      }),
      density: "spacious",
      variant: "default",
    });
    expect(model.circulating).toBe(50);
    expect(model.change24h).toBeNull();
    expect(model.change7d).toBeNull();
    expect(model.supplySparklineValues).toEqual([]);
  });

  it("retains complete coverage and a measured zero change", () => {
    const model = buildStablecoinTableRowModel({ coin: makeCoin(1), density: "spacious", variant: "default" });
    expect(model.change24h).toBe(0);
    expect(model.change7d).toBe(0);
    expect(model.supplySparklineValues).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });

  it("keeps changes null when previous supply is unavailable", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({
        circulating: { peggedUSD: 1_000_000 },
        circulatingPrevDay: undefined,
        circulatingPrevWeek: undefined,
      }),
      density: "spacious",
      variant: "default",
    });

    expect(model.change24h).toBeNull();
    expect(model.change7d).toBeNull();
  });

  it("preserves absent current supply without a contraction or invented sparkline zero", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({
        circulating: {},
        circulatingPrevDay: { peggedUSD: 100 },
        circulatingPrevWeek: { peggedUSD: 100 },
      }),
      density: "spacious",
      variant: "default",
    });
    expect(model.circulating).toBeNull();
    expect(model.change24h).toBeNull();
    expect(model.change7d).toBeNull();
    expect(model.supplySparklineValues).toEqual([100, 100, null]);
  });

  it("keeps a gap for absent middle history while retaining the weekly change", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({
        circulating: { peggedUSD: 50 },
        circulatingPrevDay: {},
        circulatingPrevWeek: { peggedUSD: 40 },
      }),
      density: "spacious",
      variant: "default",
    });
    expect(model.change24h).toBeNull();
    expect(model.change7d).toBe(25);
    expect(model.supplySparklineValues).toEqual([40, null, 50]);
  });

  it("retains observed zero supply and a real full contraction", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({
        circulating: { peggedUSD: 0 },
        circulatingPrevDay: { peggedUSD: 100 },
        circulatingPrevWeek: { peggedUSD: 100 },
      }),
      density: "spacious",
      variant: "default",
    });
    expect(model.circulating).toBe(0);
    expect(model.change24h).toBe(-100);
    expect(model.change7d).toBe(-100);
    expect(model.supplySparklineValues).toEqual([100, 100, 0]);
  });
});
