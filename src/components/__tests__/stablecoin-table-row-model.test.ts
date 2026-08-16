import { describe, expect, it } from "vitest";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import type { StablecoinData } from "@shared/types";

function makeCoin(price: number | null): StablecoinData {
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    geckoId: "usd-coin",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price,
    priceSource: "coingecko",
    priceConfidence: "high",
    priceUpdatedAt: null,
    circulating: { peggedUSD: 1_000_000 },
    circulatingPrevDay: { peggedUSD: 1_000_000 },
    circulatingPrevWeek: { peggedUSD: 1_000_000 },
    circulatingPrevMonth: {},
    chainCirculating: {},
    consensusSources: [],
    agreeSources: [],
    supplySource: "defillama",
    chains: ["Ethereum"],
  } as StablecoinData;
}

function build(price: number | null) {
  return buildStablecoinTableRowModel({
    coin: makeCoin(price),
    pegRates: {},
    density: "comfortable",
    variant: "default",
  });
}

describe("buildStablecoinTableRowModel peg deviation", () => {
  it("keeps displayed bps rounded while using raw bps for the color threshold", () => {
    const model = build(1.00496);

    expect(model.absPegDeviationBps).toBe(50);
    expect(model.pegDeviationColorClass).toBe("text-green-700 dark:text-green-400");
  });

  it("does not turn missing or non-finite prices into an on-peg signal", () => {
    for (const price of [null, Number.NaN]) {
      const model = build(price);
      expect(model.absPegDeviationBps).toBeNull();
      expect(model.pegDeviationColorClass).toBe("text-muted-foreground");
    }
  });

  it("preserves a real zero deviation as a numeric signal", () => {
    const model = build(1);

    expect(model.absPegDeviationBps).toBe(0);
    expect(model.pegDeviationColorClass).toBe("text-green-700 dark:text-green-400");
  });
});
