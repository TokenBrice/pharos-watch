import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketHighlights } from "@/components/market-highlights";
import { makeStablecoin as makeStablecoinFixture } from "@/test/fixtures/safety-scores";
import type { PegSummaryCoin, StablecoinData } from "@shared/types";

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
  MethodologyTriggerButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
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
    const html = renderToStaticMarkup(<MarketHighlights data={data} pegScores={new Map()} />);

    // New kicker copy (source case — CSS renders uppercase)
    expect(html).toContain("Biggest 7-Day Supply Moves");
    expect(html).not.toContain("Biggest Supply Changes 7D");

    // MethodologyHint attached to the depeg kicker
    expect(html).toContain('data-testid="methodology-hint-depegBps"');
  });

  it("keeps each highlight module labeled with its own mobile context", () => {
    const html = renderToStaticMarkup(<MarketHighlights data={[]} pegScores={new Map()} />);

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

    const html = renderToStaticMarkup(<MarketHighlights data={data} pegScores={new Map()} />);

    expect(html).toContain("Supply up");
    expect(html).toContain("Supply down");
    expect(html).toContain("Tether (USDT) 7-day supply change: +20.0%");
    expect(html).toContain("USD Coin (USDC) 7-day supply change: -20.0%");
  });

  it("only shows confirmed active depegs in the biggest depegs module", () => {
    const data: StablecoinData[] = [
      makeStablecoin({
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0.5081,
        currentSupply: 10_000_000,
        previousWeekSupply: 10_000_000,
      }),
      makeStablecoin({
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        price: 0.97,
        currentSupply: 10_000_000,
        previousWeekSupply: 10_000_000,
      }),
    ];
    const pegScores = new Map<string, PegSummaryCoin>([
      [
        "usdt-tether",
        makePegSummaryCoin({ id: "usdt-tether", symbol: "USDT", activeDepeg: false, currentDeviationBps: -4919 }),
      ],
      [
        "usdc-circle",
        makePegSummaryCoin({ id: "usdc-circle", symbol: "USDC", activeDepeg: true, currentDeviationBps: -300 }),
      ],
    ]);

    const html = renderToStaticMarkup(<MarketHighlights data={data} pegScores={pegScores} />);

    expect(html).toContain("USD Coin (USDC) price deviation: -300 bps from peg");
    expect(html).not.toContain("Tether (USDT) price deviation: -4919 bps from peg");
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
  return makeStablecoinFixture({
    id,
    name,
    symbol,
    pegType: "USD",
    price,
    priceConfidence: "high",
    circulating: { peggedUSD: currentSupply },
    circulatingPrevWeek: { peggedUSD: previousWeekSupply },
  });
}

function makePegSummaryCoin(overrides: Partial<PegSummaryCoin>): PegSummaryCoin {
  return {
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 100,
    pegPct: 100,
    severityScore: 100,
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
