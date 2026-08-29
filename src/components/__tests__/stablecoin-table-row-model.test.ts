import { describe, expect, it } from "vitest";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { PegSummaryCoin } from "@shared/types";

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

function makePegSummaryCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegReference: { valueUsd: 1, source: "median", contributorCount: 5, asOf: 1_700_000_000 },
    pegScore: 95,
    pegPct: 100,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 365,
    methodologyVersion: "test",
    ...overrides,
  };
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
  it("uses the Worker deviation for both display and severity", () => {
    const model = build(1.00496, 50);

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
