import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketHighlights } from "@/components/market-highlights";
import type { StablecoinData } from "@shared/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>logo:{name}</span>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyHint: ({ topic }: { topic: string }) => <span data-testid={`methodology-hint-${topic}`} />,
  MethodologyLabel: ({ children, topic }: { children: ReactNode; topic: string }) => (
    <span>
      <span>{children}</span>
      <span data-testid={`methodology-hint-${topic}`} />
    </span>
  ),
}));

describe("MarketHighlights copy (Task 1.2)", () => {
  it("uses the 'Biggest 7-Day Supply Moves' kicker and the depeg bps hint", () => {
    const data: StablecoinData[] = [];
    const html = renderToStaticMarkup(<MarketHighlights data={data} />);

    // New kicker copy (source case — CSS renders uppercase)
    expect(html).toContain("Biggest 7-Day Supply Moves");
    expect(html).not.toContain("Biggest Supply Changes 7D");

    // MethodologyHint attached to the depeg kicker
    expect(html).toContain('data-testid="methodology-hint-depegBps"');
  });

  it("keeps each highlight module labeled with its own mobile context", () => {
    const html = renderToStaticMarkup(<MarketHighlights data={[]} />);

    expect(html).toContain('aria-labelledby="market-highlights-depegs-title"');
    expect(html).toContain('id="market-highlights-depegs-title"');
    expect(html).toContain("Live price move away from peg");
    expect(html).toContain('aria-labelledby="market-highlights-movers-title"');
    expect(html).toContain('id="market-highlights-movers-title"');
    expect(html).toContain("Largest supply increases and decreases");
  });

  it("labels supply expansion and contraction rows inside the movers module", () => {
    const data: StablecoinData[] = [
      makeStablecoin({
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0.99,
        currentSupply: 1_200_000,
        previousWeekSupply: 1_000_000,
      }),
      makeStablecoin({
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        price: 1.01,
        currentSupply: 8_000_000,
        previousWeekSupply: 10_000_000,
      }),
    ];

    const html = renderToStaticMarkup(<MarketHighlights data={data} />);

    expect(html).toContain("Supply up");
    expect(html).toContain("Supply down");
    expect(html).toContain("Tether (USDT) 7-day supply change: +20.0%");
    expect(html).toContain("USD Coin (USDC) 7-day supply change: -20.0%");
  });
});

function makeStablecoin({
  id,
  name,
  symbol,
  price,
  currentSupply,
  previousWeekSupply,
}: {
  id: string;
  name: string;
  symbol: string;
  price: number;
  currentSupply: number;
  previousWeekSupply: number;
}): StablecoinData {
  return {
    id,
    name,
    symbol,
    geckoId: null,
    pegType: "USD",
    pegMechanism: "fiat-backed",
    price,
    priceSource: "test",
    priceConfidence: "high",
    priceUpdatedAt: null,
    priceObservedAt: null,
    priceObservedAtMode: null,
    priceSyncedAt: null,
    consensusSources: [],
    agreeSources: [],
    circulating: { peggedUSD: currentSupply },
    circulatingPrevDay: {},
    circulatingPrevWeek: { peggedUSD: previousWeekSupply },
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: [],
  } as StablecoinData;
}
