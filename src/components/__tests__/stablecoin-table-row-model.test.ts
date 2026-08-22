import { describe, expect, it } from "vitest";
import { buildStablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import { makeStablecoin } from "@shared/test-utils/stablecoin";

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

function build(price: number | null) {
  return buildStablecoinTableRowModel({
    coin: makeCoin(price),
    pegRates: {},
    density: "spacious",
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

  it("renders an absent commodity reference as an em dash and skips deviation", () => {
    const model = buildStablecoinTableRowModel({
      coin: makeStablecoin({
        id: "xaut-tether",
        symbol: "XAUT",
        pegType: "peggedGOLD",
        price: 3_000,
        circulating: { peggedGOLD: 1_000_000 },
      }),
      pegRates: {},
      density: "spacious",
      variant: "default",
    });

    expect(model.pegRef).toBeNull();
    expect(model.priceCell).toBe("—");
    expect(model.absPegDeviationBps).toBeNull();
  });
});
