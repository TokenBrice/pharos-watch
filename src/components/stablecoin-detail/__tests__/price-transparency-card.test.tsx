// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { resolvePriceTransparencySourceStatus } from "@/components/stablecoin-detail/price-transparency-status";
import type { StablecoinData } from "@shared/types";

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

afterEach(() => {
  cleanup();
});

describe("resolveSourceStatus", () => {
  it("returns 'used' when source is in agreeSources", () => {
    expect(
      resolvePriceTransparencySourceStatus(
        "binance",
        ["binance", "coingecko"],
        ["binance", "coingecko", "pyth"],
        false,
      ),
    ).toBe("used");
  });

  it("returns 'available' when source is in consensusSources but not agreeSources", () => {
    expect(
      resolvePriceTransparencySourceStatus("pyth", ["binance", "coingecko"], ["binance", "coingecko", "pyth"], false),
    ).toBe("available");
  });

  it("returns 'no-data' when source is in neither", () => {
    expect(resolvePriceTransparencySourceStatus("redstone", ["binance"], ["binance", "coingecko"], false)).toBe(
      "no-data",
    );
  });

  it("returns 'not-applicable' for protocol-redeem coins", () => {
    expect(resolvePriceTransparencySourceStatus("binance", ["binance"], ["binance"], true)).toBe("not-applicable");
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
    expect(screen.getByText("Sources 3+/3")).toBeTruthy();

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
    expect(screen.getByText("Sources 1/3")).toBeTruthy();
  });

  it("renders compact rail layout with summary, DEX check, and source sections", () => {
    const { container } = render(
      <PriceTransparencyCard
        coinData={makeCoinData("coingecko+kraken+uniswap-v3-dex")}
        consensusSources={["coingecko", "kraken", "uniswap-v3-dex"]}
        agreeSources={["coingecko", "kraken"]}
        dexPriceCheck={{
          agrees: true,
          dexPrice: 0.9992,
          dexDeviationBps: 8.1,
          sourcePools: 12,
          sourceTvl: 22_320_000,
        }}
        compact
      />,
    );

    expect(screen.getByRole("heading", { name: "Price Transparency" })).toBeTruthy();
    expect(screen.getByText("$1.0000")).toBeTruthy();
    expect(screen.getByText(/HIGH/)).toBeTruthy();
    expect(screen.getByText(/Sources 3\+\/3/)).toBeTruthy();
    expect(screen.getByText("DEX Check")).toBeTruthy();
    expect(screen.getByText("Agrees")).toBeTruthy();
    expect(screen.getByText("$0.9992")).toBeTruthy();
    expect(screen.getByText(/12 pools/i)).toBeTruthy();
    expect(screen.getByText("CoinGecko")).toBeTruthy();
    expect(screen.getByText("Kraken")).toBeTruthy();
    expect(screen.getByText("Uniswap V3")).toBeTruthy();
    expect(container.querySelector('img[src*="coingecko.png"]')).toBeTruthy();
    expect(container.querySelector('img[src*="kraken.png"]')).toBeTruthy();
    expect(container.querySelector('img[src*="uniswap-v3.png"]')).toBeTruthy();
  });
});
