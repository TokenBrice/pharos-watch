// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { resolvePriceTransparencySourceStatus } from "@/components/stablecoin-detail/price-transparency-status";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types/supply";

function makeCoinData(priceSource = "coingecko", overrides: Partial<StablecoinData> = {}): StablecoinData {
  const freshSec = Math.floor(Date.now() / 1000) - 60;
  return makeStablecoin({
    id: "test-coin", name: "Test Coin", symbol: "TEST", priceSource, priceConfidence: "high",
    priceUpdatedAt: freshSec, priceObservedAt: freshSec, priceObservedAtMode: "upstream", priceSyncedAt: freshSec,
    chains: ["ethereum"], ...overrides,
  });
}

type CardProps = React.ComponentProps<typeof PriceTransparencyCard>;
const cardEl = (props: Partial<CardProps> = {}) => (
  <PriceTransparencyCard coinData={makeCoinData()} consensusSources={["coingecko"]} agreeSources={["coingecko"]} dexPriceCheck={null} {...props} />
);
const renderCard = (props: Partial<CardProps> = {}) => render(cardEl(props));

afterEach(() => vi.restoreAllMocks());

describe("resolveSourceStatus", () => {
  it("returns 'no-data' when source is in neither", () => {
    expect(resolvePriceTransparencySourceStatus("redstone", ["binance"], ["binance", "coingecko"], false)).toBe("no-data");
  });

  it("returns 'not-applicable' for protocol-redeem coins", () => {
    expect(resolvePriceTransparencySourceStatus("binance", ["binance"], ["binance"], true)).toBe("not-applicable");
  });
});

describe("PriceTransparencyCard", () => {
  it.each([false, true])("hydrates saved price timestamps against a later clock without mismatches (compact=%s)", async (compact) => {
    const savedAt = Date.parse("2026-10-10T12:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(savedAt);
    const element = cardEl({ compact });
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

  it("binds the in-flow title to current-price help, not the historical Peg Score", () => {
    renderCard();
    const triggers = screen.getAllByRole("button", { name: "Explain Price Transparency" });
    expect(triggers.length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Explain Peg Score" })).toBeNull();
    act(() => { triggers[triggers.length - 1].click(); });
    expect(screen.getByText("The current USD price with its confidence, candidate source depth and, where available, a DEX check.")).toBeTruthy();
    expect(screen.queryByText(/time-at-peg/)).toBeNull();
  });

  it("points the evidence footer at the pricing methodology, not the Peg Score", () => {
    renderCard();
    const methodology = screen.getAllByRole("link", { name: "View methodology" });
    expect(methodology.some((link) => /^\/methodology\/?#pricing-pipeline-methodology$/.test(link.getAttribute("href") ?? ""))).toBe(true);
    expect(methodology.some((link) => /pegscore/.test(link.getAttribute("href") ?? ""))).toBe(false);
  });

  it("keeps the compact title plain", () => {
    renderCard({ compact: true });
    expect(screen.queryByRole("button", { name: "Explain Price Transparency" })).toBeNull();
  });

  it.each([false, true])("names the USD basis for a non-USD peg in compact=%s", (compact) => {
    renderCard({ coinData: makeCoinData("coingecko", { pegType: "peggedEUR", price: 1.1187 }), compact });
    expect(screen.getAllByText(/USD 1\.1187/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$1\.1187/)).toBeNull();
  });

  it.each([false, true])("separates nominal par from observations in compact=%s", (compact) => {
    renderCard({
      coinData: makeCoinData("protocol-par", {
        priceObservedAtMode: "nominal_reference",
        nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" },
      }),
      compact,
    });
    expect(screen.getByText("N/A")).toBeTruthy();
    expect(screen.getByText("Observed price unavailable now")).toBeTruthy();
    expect(screen.getByText(/Nominal par reference:.*1\.0000/)).toBeTruthy();
    expect(screen.queryByText(/^high$/i)).toBeNull();
    expect(screen.queryByText(/Updated|1m|1 min/)).toBeNull();
    expect(screen.queryByText("Protocol Redemption")).toBeNull();
    expect(screen.queryByText("Used")).toBeNull();
  });

  it("retains an observed discount alongside the separate nominal reference", () => {
    renderCard({
      coinData: makeCoinData("coingecko", {
        price: 0.95,
        nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" },
      }),
    });
    expect(screen.getByText("$0.9500")).toBeTruthy();
    expect(screen.getByText("High confidence")).toBeTruthy();
    expect(screen.getByText(/Nominal par reference:.*1\.0000/)).toBeTruthy();
  });

  it("surfaces Kraken, Bitstamp, and Jupiter with display labels and statuses", () => {
    renderCard({
      coinData: makeCoinData("coingecko+kraken+bitstamp+jupiter"),
      consensusSources: ["coingecko", "kraken", "bitstamp", "jupiter"],
      agreeSources: ["coingecko", "kraken", "bitstamp"],
    });
    expect(screen.getByText("Set by 3 agreeing sources")).toBeTruthy();
    expect(screen.getByText("4 sources checked")).toBeTruthy();
    expect(screen.queryByText(/3\+\/3/)).toBeNull();
    const used = screen.getByRole("list", { name: "Used for price" });
    expect(within(used).getByText("Kraken")).toBeTruthy();
    expect(within(used).getByText("Bitstamp")).toBeTruthy();
    const checked = screen.getByRole("list", { name: "Also checked" });
    expect(within(checked).getByText("Jupiter")).toBeTruthy();
    expect(within(checked).queryByText("Kraken")).toBeNull();
    expect(screen.getByText(/other tracked sources? had no feed for this coin\./)).toBeTruthy();
  });

  it("names the source-depth shortfall against the three-source target", () => {
    renderCard({ coinData: makeCoinData("coingecko+kraken"), consensusSources: ["coingecko", "kraken"], agreeSources: ["coingecko", "kraken"] });
    expect(screen.getByText("2 of 3 target sources")).toBeTruthy();
  });

  it.each([false, true])("reads a non-dollar peg in its own unit with USD beside it (compact=%s)", (compact) => {
    renderCard({
      coinData: makeCoinData("coingecko", { pegType: "peggedCHF", price: 1.189 }),
      dexPriceCheck: { agrees: true, dexPrice: 1.1866, dexDeviationBps: -20, sourcePools: 5, sourceTvl: 3_390_000, observedAtSec: Date.parse("2026-11-13T19:00:00Z") / 1000 },
      pegCurrency: "CHF", pegRef: 1.19, compact,
    });
    expect(screen.getByText("CHF 0.9992")).toBeTruthy();
    expect(screen.getByText("USD 1.1890")).toBeTruthy();
    expect(screen.getByText("CHF 0.9971")).toBeTruthy();
  });

  it.each([
    { pegCurrency: "GOLD", expected: "$3,844.03" },
    { pegCurrency: undefined, expected: "USD 3,844.03" },
  ])("groups thousands and keeps cents for large prices ($expected)", ({ pegCurrency, expected }) => {
    renderCard({ coinData: makeCoinData("coingecko", { pegType: "peggedGOLD", price: 3844.0331 }), pegCurrency, pegRef: 3850, compact: true });
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText(/3844\.0331/)).toBeNull();
  });

  it("renders compact rail layout with summary, DEX check, and source sections", () => {
    const { container } = renderCard({
      coinData: makeCoinData("coingecko+kraken+uniswap-v3-dex"),
      consensusSources: ["coingecko", "kraken", "uniswap-v3-dex"],
      agreeSources: ["coingecko", "kraken"],
      dexPriceCheck: { agrees: true, dexPrice: 0.9992, dexDeviationBps: 8.1, sourcePools: 12, sourceTvl: 22_320_000 },
      compact: true,
    });
    expect(screen.getByRole("heading", { name: "Price Transparency" })).toBeTruthy();
    expect(screen.getByText("$1.0000")).toBeTruthy();
    expect(screen.getByText("High confidence")).toBeTruthy();
    expect(screen.getByText("4 sources checked")).toBeTruthy();
    expect(screen.getByText("DEX check")).toBeTruthy();
    expect(screen.getByText("Agrees")).toBeTruthy();
    expect(screen.getByText("DEX price is within 0.5% of the primary price.")).toBeTruthy();
    expect(screen.getByText("$0.9992")).toBeTruthy();
    expect(screen.getByText(/12 DEX price sources/)).toBeTruthy();
    expect(screen.getByText("0.08% from reference")).toBeTruthy();
    expect(screen.getByText("CoinGecko")).toBeTruthy();
    expect(screen.getByText("Kraken")).toBeTruthy();
    expect(screen.getByText("Uniswap V3")).toBeTruthy();
    expect(container.querySelector('img[src*="coingecko.png"]')).toBeTruthy();
    expect(container.querySelector('img[src*="kraken.png"]')).toBeTruthy();
    expect(container.querySelector('img[src*="uniswap-v3.png"]')).toBeTruthy();
  });

  describe("DEX check verdict", () => {
    it.each([
      ["2026-10-30T20:50:00Z", "2026-10-30T21:05:00Z", "Reference market closed"],
      ["2026-10-30T21:05:00Z", "2026-10-30T20:50:00Z", /from reference/],
      ["2026-10-30T20:50:00Z", null, /from reference/],
    ] as const)("uses the DEX observation clock (%s primary, %s DEX)", (primary, dex, expected) => {
      renderCard({
        coinData: makeCoinData("coingecko", { pegType: "peggedGOLD", price: 3500, priceObservedAt: Date.parse(primary) / 1000 }),
        dexPriceCheck: { agrees: false, dexPrice: 3430, dexDeviationBps: -200, sourcePools: 3, sourceTvl: 8_000_000, observedAtSec: dex == null ? undefined : Date.parse(dex) / 1000 },
      });
      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.getByText("Disagrees")).toBeTruthy();
    });

    it.each([
      { compact: false, sourcePools: 1 }, { compact: true, sourcePools: 1 },
      { compact: false, sourcePools: 2 }, { compact: true, sourcePools: 2 },
    ])("labels price observations and retains genuine TVL (compact=$compact, count=$sourcePools)", ({ compact, sourcePools }) => {
      renderCard({ dexPriceCheck: { agrees: true, dexPrice: 1, dexDeviationBps: 0, sourcePools, sourceTvl: 2_500_000 }, compact });
      const summary = screen.getByText(`${sourcePools} DEX price ${sourcePools === 1 ? "source" : "sources"}`, { exact: false }).parentElement!;
      expect(summary.textContent).toContain("TVL");
      expect(summary.textContent).toContain("2.5");
      expect(screen.queryByText(/\b\d+ pools?\b/)).toBeNull();
    });

    const navCheck = { agrees: true, dexPrice: 1.2513, dexDeviationBps: -1, sourcePools: 9, sourceTvl: 40_000_000 };

    it.each([
      { compact: false, agrees: true }, { compact: true, agrees: true },
      { compact: false, agrees: false }, { compact: true, agrees: false },
    ])("renders exactly the published verdict (compact=$compact, agrees=$agrees)", ({ compact, agrees }) => {
      renderCard({ coinData: makeCoinData("coingecko", { price: 1.2514 }), dexPriceCheck: { ...navCheck, agrees }, compact });
      expect(screen.queryByText("Agrees") !== null).toBe(agrees);
      expect(screen.queryByText("Disagrees") !== null).toBe(!agrees);
      expect(screen.getByText(/0\.5% of the primary price|primary price by more than 0\.5%/)).toBeTruthy();
      expect(screen.getByText("$1.2513")).toBeTruthy();
    });

    it.each([
      { label: "no published check", coinData: makeCoinData(), check: null },
      { label: "an unobserved price", coinData: makeCoinData("protocol-par", { priceObservedAtMode: "nominal_reference" }), check: navCheck },
    ])("shows no agree/disagree verdict with $label", ({ coinData, check }) => {
      renderCard({ coinData, dexPriceCheck: check });
      expect(screen.queryByText("Agrees")).toBeNull();
      expect(screen.queryByText("Disagrees")).toBeNull();
    });
  });
});
