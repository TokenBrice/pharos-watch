// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { resolvePriceTransparencySourceStatus } from "@/components/stablecoin-detail/price-transparency-status";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types";

function makeCoinData(priceSource: string): StablecoinData {
  const freshSec = Math.floor(Date.now() / 1000) - 60;
  return makeStablecoin({
    id: "test-coin",
    name: "Test Coin",
    symbol: "TEST",
    priceSource,
    priceConfidence: "high",
    // Freshness copy reads every price timestamp, so all four stay explicit.
    priceUpdatedAt: freshSec,
    priceObservedAt: freshSec,
    priceObservedAtMode: "upstream",
    priceSyncedAt: freshSec,
    chains: ["ethereum"],
  });
}

afterEach(() => vi.restoreAllMocks());


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
  it.each([false, true])("hydrates saved price timestamps against a later clock without mismatches (compact=%s)", async (compact) => {
    const savedAt = Date.parse("2026-10-10T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(savedAt);
    const element = <PriceTransparencyCard
      coinData={makeCoinData("coingecko")}
      consensusSources={["coingecko"]}
      agreeSources={["coingecko"]}
      dexPriceCheck={null}
      compact={compact}
    />;
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    now.mockReturnValue(savedAt + 3600_000);
    const errors: unknown[] = [];
    const root = hydrateRoot(container, element, { onRecoverableError: (error) => errors.push(error) });
    try {
      await waitFor(() => expect(container.textContent).toContain("1h"));
      expect(errors).toEqual([]);
    } finally {
      await act(() => root.unmount());
    }
  });

  it.each([false, true])("separates nominal par from observations in compact=%s", (compact) => {
    render(
      <PriceTransparencyCard
        coinData={{
          ...makeCoinData("protocol-par"),
          priceObservedAtMode: "nominal_reference",
          nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" },
        }}
        consensusSources={["coingecko"]}
        agreeSources={["coingecko"]}
        dexPriceCheck={null}
        compact={compact}
      />,
    );
    expect(screen.getByText("N/A")).toBeTruthy();
    expect(screen.getByText(/Nominal par reference:.*1\.0000/)).toBeTruthy();
    expect(screen.queryByText(/^high$/i)).toBeNull();
    expect(screen.queryByText(/Updated|1m|1 min/)).toBeNull();
    expect(screen.queryByText("Protocol Redemption")).toBeNull();
    expect(screen.queryByText("Used")).toBeNull();
  });

  it("retains an observed discount alongside the separate nominal reference", () => {
    render(
      <PriceTransparencyCard
        coinData={{
          ...makeCoinData("coingecko"),
          price: 0.95,
          nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" },
        }}
        consensusSources={["coingecko"]}
        agreeSources={["coingecko"]}
        dexPriceCheck={null}
      />,
    );
    expect(screen.getByText("$0.9500")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText(/Nominal par reference:.*1\.0000/)).toBeTruthy();
  });

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
    expect(screen.getByText(/12 price sources/i)).toBeTruthy();
    expect(screen.getByText("CoinGecko")).toBeTruthy();
    expect(screen.getByText("Kraken")).toBeTruthy();
    expect(screen.getByText("Uniswap V3")).toBeTruthy();
    expect(container.querySelector('img[src*="coingecko.png"]')).toBeTruthy();
    expect(container.querySelector('img[src*="kraken.png"]')).toBeTruthy();
    expect(container.querySelector('img[src*="uniswap-v3.png"]')).toBeTruthy();
  });

  describe("DEX check verdict", () => {
    it.each([
      { compact: false, sourcePools: 1 },
      { compact: true, sourcePools: 1 },
      { compact: false, sourcePools: 2 },
      { compact: true, sourcePools: 2 },
    ])("labels price observations and retains genuine TVL (compact=$compact, count=$sourcePools)", ({ compact, sourcePools }) => {
      render(
        <PriceTransparencyCard
          coinData={makeCoinData("coingecko")}
          consensusSources={["coingecko"]}
          agreeSources={["coingecko"]}
          dexPriceCheck={{ agrees: true, dexPrice: 1, dexDeviationBps: 0, sourcePools, sourceTvl: 2_500_000 }}
          compact={compact}
        />,
      );
      const sourceLabel = `${sourcePools} price ${sourcePools === 1 ? "source" : "sources"}`;
      const summary = screen.getByText(sourceLabel, { exact: false });
      expect(summary.textContent).toContain("TVL");
      expect(summary.textContent).toContain("2.5");
      expect(screen.queryByText(/\b\d+ pools?\b/)).toBeNull();
    });

    // A yield-bearing NAV token: the payload's deviation is measured against
    // the token's own reference price, so a matching print agrees.
    const navCheck = { agrees: true, dexPrice: 1.2513, dexDeviationBps: -1, sourcePools: 9, sourceTvl: 40_000_000 };

    it.each([
      { compact: false, agrees: true },
      { compact: true, agrees: true },
      { compact: false, agrees: false },
      { compact: true, agrees: false },
    ])("renders exactly the published verdict (compact=$compact, agrees=$agrees)", ({ compact, agrees }) => {
      render(
        <PriceTransparencyCard
          coinData={{ ...makeCoinData("coingecko"), price: 1.2514 }}
          consensusSources={["coingecko"]}
          agreeSources={["coingecko"]}
          dexPriceCheck={{ ...navCheck, agrees }}
          compact={compact}
        />,
      );
      expect(screen.queryByText("Agrees") !== null).toBe(agrees);
      expect(screen.queryByText("Disagrees") !== null).toBe(!agrees);
      expect(screen.getByText("$1.2513")).toBeTruthy();
    });

    it.each([
      { label: "no published check", coinData: makeCoinData("coingecko"), check: null },
      {
        label: "an unobserved price",
        coinData: { ...makeCoinData("protocol-par"), priceObservedAtMode: "nominal_reference" as const },
        check: navCheck,
      },
    ])("shows no agree/disagree verdict with $label", ({ coinData, check }) => {
      render(
        <PriceTransparencyCard
          coinData={coinData}
          consensusSources={["coingecko"]}
          agreeSources={["coingecko"]}
          dexPriceCheck={check}
        />,
      );
      expect(screen.queryByText("Agrees")).toBeNull();
      expect(screen.queryByText("Disagrees")).toBeNull();
    });
  });
});
