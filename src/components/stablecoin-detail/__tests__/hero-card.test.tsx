import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroCard } from "@/components/stablecoin-detail/hero-card";
import type { DexLiquidityData, PegSummaryCoin, StablecoinData, StablecoinMeta } from "@shared/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/bluechip-header-badge", () => ({
  BluechipHeaderBadge: ({ stablecoinId }: { stablecoinId: string }) => <span>Bluechip: B ({stablecoinId})</span>,
}));

vi.mock("@/components/peg-gauge", () => ({
  PegGauge: ({ deviationBps }: { deviationBps: number }) => <span>peg-gauge:{deviationBps}</span>,
}));

vi.mock("@/components/share-button", () => ({
  ShareButton: ({ label }: { label?: string }) => <button type="button">{label ?? "Share"}</button>,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>logo:{name}</span>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const coin: StablecoinMeta = {
  id: "usdc-circle",
  symbol: "USDC",
  name: "USD Coin",
  status: "live",
  hidden: false,
  peggedAsset: "usd",
  tags: ["major", "fiat-backed"],
  flags: {
    backing: "fiat-backed",
    governance: "centralized",
    pegCurrency: "USD",
  },
};

const coinData: StablecoinData = {
  id: "usdc-circle",
  name: "USD Coin",
  symbol: "USDC",
  geckoId: "usd-coin",
  pegType: "peggedUSD",
  pegMechanism: "fiat-backed",
  price: 0.9998,
  priceSource: "coingecko",
  priceConfidence: "high",
  consensusSources: ["coingecko"],
  agreeSources: ["coingecko"],
  priceUpdatedAt: 1_700_000_000,
  supplySource: "defillama",
  circulating: { peggedUSD: 1_000_000_000 },
  circulatingPrevDay: { peggedUSD: 995_000_000 },
  circulatingPrevWeek: { peggedUSD: 980_000_000 },
  circulatingPrevMonth: { peggedUSD: 970_000_000 },
  chainCirculating: {},
  chains: ["ethereum", "base"],
};

const pegScoreResult: PegSummaryCoin = {
  id: "usdc-circle",
  symbol: "USDC",
  pegScore: 95,
  pegPct: 99.4,
  eventCount: 2,
  currentBand: "CALM",
  trackingSpanDays: 365,
  activeDepeg: true,
};

const liquidityData: DexLiquidityData = {
  stablecoin: "usdc-circle",
  symbol: "USDC",
  liquidityScore: 82,
  totalTvlUsd: 125_000_000,
  poolCount: 24,
  chainCount: 3,
  dexCount: 8,
  volume24hUsd: 250_000_000,
  volume7dUsd: 1_500_000_000,
  topPools: [],
  chainBreakdown: [],
  protocolBreakdown: [],
  dexPrices: [],
  concentrationHhi: 0.2,
  largestPoolShare: 0.15,
  depthStability: 0.92,
  marketDepthShare: 0.8,
  scoreComponents: {
    size: 80,
    distribution: 75,
    organicity: 70,
    durability: 85,
  },
  updatedAt: 1_700_000_000,
};

describe("HeroCard", () => {
  it("renders shared identity, price, and metric content across responsive layouts", () => {
    const html = renderToStaticMarkup(
      <HeroCard
        coin={coin}
        coinData={coinData}
        logoSrc="/logos/usdc.svg"
        isNavToken={false}
        mcap={1_000_000_000}
        supply={1_000_000_000}
        prevDay={995_000_000}
        prevWeek={980_000_000}
        prevMonth={970_000_000}
        prev90d={950_000_000}
        pegRef={1}
        deviationBps={-2}
        gaugeDeviationBps={2}
        usesFallbackPegRate={false}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={3}
        pegScoreBorderClass="border-cyan-500/20"
        liquidityData={liquidityData}
        liqBorderClass="border-emerald-500/20"
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("USD Coin");
    expect(html).toContain("major");
    expect(html).toContain("fiat-backed");
    expect(html).toContain("Bluechip: B");
    expect(html).toContain("peg-gauge:2");
    expect(html).toContain("Report data issue");
    expect(html).toContain("Active depeg");
    expect(html).toContain("90d");
    expect(html).toContain("Liquidity");
    expect(html).toContain("Compare");
  });
});
