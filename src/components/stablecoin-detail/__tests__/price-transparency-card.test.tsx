// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import type { StablecoinData } from "@shared/types";

// resolveSourceStatus is not exported, so we test the logic inline
type SourceStatus = "used" | "available" | "no-data" | "not-applicable";

function resolveSourceStatus(
  sourceKey: string,
  agreeSources: string[],
  consensusSources: string[],
  isProtocolRedeem: boolean,
): SourceStatus {
  if (isProtocolRedeem) return "not-applicable";
  if (agreeSources.includes(sourceKey)) return "used";
  if (consensusSources.includes(sourceKey)) return "available";
  return "no-data";
}

function makeCoinData(priceSource: string): StablecoinData {
  return {
    id: "test-coin",
    name: "Test Coin",
    symbol: "TEST",
    geckoId: null,
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource,
    priceConfidence: "high",
    priceUpdatedAt: Math.floor(Date.now() / 1000) - 60,
    consensusSources: [],
    agreeSources: [],
    supplySource: undefined,
    circulating: { peggedUSD: 1_000_000 },
    circulatingPrevDay: {},
    circulatingPrevWeek: {},
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: ["ethereum"],
  };
}

describe("resolveSourceStatus", () => {
  it("returns 'used' when source is in agreeSources", () => {
    expect(resolveSourceStatus("binance", ["binance", "coingecko"], ["binance", "coingecko", "pyth"], false)).toBe("used");
  });

  it("returns 'available' when source is in consensusSources but not agreeSources", () => {
    expect(resolveSourceStatus("pyth", ["binance", "coingecko"], ["binance", "coingecko", "pyth"], false)).toBe("available");
  });

  it("returns 'no-data' when source is in neither", () => {
    expect(resolveSourceStatus("redstone", ["binance"], ["binance", "coingecko"], false)).toBe("no-data");
  });

  it("returns 'not-applicable' for protocol-redeem coins", () => {
    expect(resolveSourceStatus("binance", ["binance"], ["binance"], true)).toBe("not-applicable");
  });
});

describe("PriceTransparencyCard", () => {
  it("surfaces Kraken, Bitstamp, and Jupiter with display labels and statuses", () => {
    render(
      <PriceTransparencyCard
        coinData={makeCoinData("coingecko+kraken+bitstamp+jupiter")}
        consensusSources={["coingecko", "kraken", "bitstamp", "jupiter"]}
        agreeSources={["coingecko", "kraken", "bitstamp"]}
        dexPriceCheck={null}
      />,
    );

    // Check summary shows correct counts
    expect(screen.getByText("3 used")).toBeTruthy();
    expect(screen.getByText("1 available")).toBeTruthy();

    // Check used sources are displayed with "Used" badges
    const krakenRow = screen.getByText("Kraken").closest("div");
    expect(krakenRow).not.toBeNull();
    expect(within(krakenRow as HTMLElement).getByText("Used")).toBeTruthy();

    const bitstampRow = screen.getByText("Bitstamp").closest("div");
    expect(bitstampRow).not.toBeNull();
    expect(within(bitstampRow as HTMLElement).getByText("Used")).toBeTruthy();

    // Check available source is displayed with "Available" badge
    const jupiterRow = screen.getByText("Jupiter").closest("div");
    expect(jupiterRow).not.toBeNull();
    expect(within(jupiterRow as HTMLElement).getByText("Available")).toBeTruthy();
  });

  it("shows current price and confidence", () => {
    render(
      <PriceTransparencyCard
        coinData={makeCoinData("coingecko")}
        consensusSources={["coingecko"]}
        agreeSources={["coingecko"]}
        dexPriceCheck={null}
      />,
    );

    // Check price is displayed (appears twice in component, so check at least one exists)
    expect(screen.getAllByText("$1.0000").length).toBeGreaterThanOrEqual(1);
    
    // Check confidence badge (appears in summary and DEX check)
    expect(screen.getAllByText("high").length).toBeGreaterThanOrEqual(1);
  });
});
