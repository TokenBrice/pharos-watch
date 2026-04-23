import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroCard } from "@/components/stablecoin-detail/hero-card";
import type { DexLiquidityData, PegSummaryCoin, ReportCard, StablecoinData, StablecoinMeta, StressSignalEntry, YieldRanking } from "@shared/types";

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
  MethodologyHint: ({ topic }: { topic: string }) => <span data-testid={`methodology-hint-${topic}`} />,
  MethodologyLabel: ({ children, topic }: { children: React.ReactNode; topic: string }) => (
    <span>
      <span>{children}</span>
      <span data-testid={`methodology-hint-${topic}`} />
    </span>
  ),
}));

const coin: StablecoinMeta = {
  id: "usdc-circle",
  symbol: "USDC",
  name: "USD Coin",
  canBeBlacklisted: true,
  status: "active",
  infrastructures: ["liquity-v2"],
  tags: ["major", "fiat-backed"],
  flags: {
    backing: "rwa-backed",
    governance: "centralized",
    pegCurrency: "USD",
    rwa: true,
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
  totalTvlUsd: 125_000_000,
  totalVolume24hUsd: 250_000_000,
  totalVolume7dUsd: 1_500_000_000,
  poolCount: 24,
  pairCount: 24,
  chainCount: 3,
  protocolTvl: {},
  chainTvl: {},
  topPools: [],
  liquidityScore: 82,
  concentrationHhi: 0.2,
  depthStability: 0.92,
  tvlChange24h: null,
  tvlChange7d: null,
  updatedAt: 1_700_000_000,
  dexPriceUsd: null,
  dexDeviationBps: null,
  priceSourceCount: null,
  priceSourceTvl: null,
  priceSources: null,
  effectiveTvlUsd: 125_000_000,
  avgPoolStress: null,
  weightedBalanceRatio: null,
  organicFraction: null,
  durabilityScore: null,
  coverageClass: "primary",
  coverageConfidence: 1,
  liquidityEvidenceClass: "measured",
  hasMeasuredLiquidityEvidence: true,
  trendworthy: true,
  sourceMix: {},
  balanceMeasuredTvlUsd: 125_000_000,
  organicMeasuredTvlUsd: 125_000_000,
  scoreComponents: {
    tvlDepth: 80,
    volumeActivity: 75,
    poolQuality: 70,
    durability: 85,
    pairDiversity: 78,
  },
};

const reportCardWithInheritedBlacklistRisk: ReportCard = {
  id: "usdc-circle",
  name: "USD Coin",
  symbol: "USDC",
  overallGrade: "B+",
  overallScore: 79,
  baseScore: 79,
  dimensions: {
    pegStability: { grade: "A", score: 95, detail: "ok" },
    liquidity: { grade: "B+", score: 82, detail: "ok" },
    resilience: { grade: "B", score: 70, detail: "ok" },
    decentralization: { grade: "C", score: 55, detail: "ok" },
    dependencyRisk: { grade: "B", score: 73, detail: "ok" },
  },
  ratedDimensions: 5,
  rawInputs: {
    pegScore: 95,
    activeDepeg: true,
    depegEventCount: 2,
    lastEventAt: null,
    liquidityScore: 82,
    effectiveExitScore: 82,
    redemptionBackstopScore: null,
    redemptionRouteFamily: null,
    redemptionModelConfidence: null,
    redemptionUsedForLiquidity: false,
    redemptionImmediateCapacityUsd: null,
    redemptionImmediateCapacityRatio: null,
    concentrationHhi: 0.2,
    bluechipGrade: null,
    canBeBlacklisted: "inherited",
    chainTier: "ethereum",
    deploymentModel: "multi-chain",
    collateralQuality: "mixed",
    custodyModel: "institutional-regulated",
    governanceTier: "centralized",
    governanceQuality: "single-entity",
    dependencies: [],
    navToken: false,
    collateralFromLive: false,
  },
  isDefunct: false,
};

const yieldRanking: YieldRanking = {
  id: "usdc-circle",
  symbol: "USDC",
  name: "USD Coin",
  currentApy: 4.8,
  apy7d: 4.7,
  apy30d: 4.6,
  apyBase: 4.6,
  apyReward: 0,
  yieldSource: "Circle Treasury",
  yieldSourceUrl: "https://example.com/yield",
  yieldType: "nav-appreciation",
  dataSource: "rate-derived",
  sourceTvlUsd: 1_000_000_000,
  pharosYieldScore: 70,
  safetyScore: 79,
  safetyGrade: "B+",
  yieldToRisk: 3.2,
  excessYield: 0.85,
  benchmarkKey: "USD",
  benchmarkLabel: "USD 3M T-Bill",
  benchmarkCurrency: "USD",
  benchmarkRate: 3.75,
  benchmarkRecordDate: "2026-04-21",
  benchmarkIsFallback: false,
  benchmarkFallbackMode: null,
  benchmarkSelectionMode: "native",
  benchmarkIsProxy: false,
  yieldStability: 0.92,
  apyVariance30d: 0.1,
  apyMin30d: 4.4,
  apyMax30d: 4.8,
  warningSignals: [],
  altSources: [],
  provenance: null,
};

const stressSignal: StressSignalEntry = {
  score: 31,
  band: "WATCH",
  signals: {
    supply: { value: 31, available: true },
  },
  computedAt: 1_700_000_000,
  methodologyVersion: "v1",
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
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={-2}
        gaugeDeviationBps={2}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={3}
        liquidityData={liquidityData}
        yieldRanking={yieldRanking}
        stressSignal={stressSignal}
        reportCard={null}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("USD Coin");
    expect(html).toContain("major");
    expect(html).toContain("fiat-backed");
    expect(html).toContain("Infrastructure");
    expect(html).toContain("Liquity v2");
    expect(html).toContain("Bluechip: B");
    expect(html).toContain("peg-gauge:2");
    expect(html).toContain("Report issue");
    expect(html).toContain("Active depeg");
    expect(html).toContain("Liquidity");
    // Task 1.6: "Blacklistable" hero chip is relabelled "Freezable"
    expect(html).toContain("Freezable");
    expect(html).not.toContain(">Blacklistable<");
    // Freezable hint is attached via the methodology-hint trigger.
    expect(html).toContain('data-testid="methodology-hint-freezable"');
    expect(html).toContain("30d Excess");
    expect(html).toContain("+0.85%");
    expect(html).toContain("30d vs USD 3M T-Bill");
    expect(html).not.toContain("1Y vs USD");
    expect(html).toContain("DEWS");
    expect(html).toContain("Watch");
    // Task 1.5: DEWS band is now a Badge with the band's semantic color token,
    // the score keeps mono numeric rendering below/beside the badge.
    expect(html).toContain("31/100");
    // Band-specific methodology hint is rendered next to the DEWS label.
    expect(html).toContain('data-testid="methodology-hint-dewsBand"');
    expect(html).not.toContain("Issuer controls");
    expect(html).toContain("Compare");
  });

  it("prefers resolved report-card blacklist status for inherited-risk coins", () => {
    const inheritedCoin: StablecoinMeta = {
      ...coin,
      id: "usde-ethena",
      name: "Ethena USDe",
      symbol: "USDe",
      canBeBlacklisted: undefined,
      flags: {
        ...coin.flags,
        governance: "centralized-dependent",
      },
    };

    const html = renderToStaticMarkup(
      <HeroCard
        coin={inheritedCoin}
        coinData={{ ...coinData, id: "usde-ethena", name: "Ethena USDe", symbol: "USDe" }}
        logoSrc="/logos/usde.svg"
        isNavToken={false}
        mcap={1_000_000_000}
        supply={1_000_000_000}
        prevDay={995_000_000}
        prevWeek={980_000_000}
        prevMonth={970_000_000}
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={-2}
        gaugeDeviationBps={2}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={3}
        liquidityData={liquidityData}
        yieldRanking={null}
        stressSignal={null}
        reportCard={{ ...reportCardWithInheritedBlacklistRisk, id: "usde-ethena", name: "Ethena USDe", symbol: "USDe" }}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("Freezable");
    expect(html).toContain("Upstream");
    expect(html).not.toContain("No issuer controls");
  });

  it("uses shared no-gap copy when excess yield is unavailable", () => {
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
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={-2}
        gaugeDeviationBps={2}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={3}
        liquidityData={liquidityData}
        yieldRanking={{ ...yieldRanking, excessYield: null }}
        stressSignal={stressSignal}
        reportCard={reportCardWithInheritedBlacklistRisk}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("No 30d benchmark gap");
  });

  it("renders the tracked parent chip for variant detail pages", () => {
    const parentCoin: StablecoinMeta = {
      ...coin,
      id: "usds-sky",
      name: "Sky Dollar",
      symbol: "USDS",
    };

    const variantCoin: StablecoinMeta = {
      ...coin,
      id: "susds-sky",
      name: "Sky Savings USDS",
      symbol: "sUSDS",
      variantOf: "usds-sky",
      variantKind: "savings-passthrough",
      flags: {
        ...coin.flags,
        navToken: true,
      },
    };

    const html = renderToStaticMarkup(
      <HeroCard
        coin={variantCoin}
        coinData={{ ...coinData, id: "susds-sky", name: "Sky Savings USDS", symbol: "sUSDS" }}
        logoSrc="/logos/susds.svg"
        isNavToken
        mcap={1_000_000_000}
        supply={1_000_000_000}
        prevDay={995_000_000}
        prevWeek={980_000_000}
        prevMonth={970_000_000}
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={0}
        gaugeDeviationBps={0}
        pegScoreResult={null}
        recordedDepegEventCount={0}
        liquidityData={liquidityData}
        yieldRanking={yieldRanking}
        stressSignal={stressSignal}
        reportCard={null}
        variantParent={parentCoin}
        variantKind="savings-passthrough"
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("Variant of USDS");
  });

  it("renders 1Y vs USD for eligible non-USD coins when performance is available", () => {
    const nonUsdCoin: StablecoinMeta = {
      ...coin,
      id: "zchf-frankencoin",
      name: "Frankencoin",
      symbol: "ZCHF",
      flags: {
        ...coin.flags,
        pegCurrency: "CHF",
      },
    };

    const nonUsdCoinData: StablecoinData = {
      ...coinData,
      id: "zchf-frankencoin",
      name: "Frankencoin",
      symbol: "ZCHF",
      pegType: "peggedCHF",
      price: 1.12,
      circulating: { peggedCHF: 1_000_000_000 },
      circulatingPrevDay: { peggedCHF: 995_000_000 },
      circulatingPrevWeek: { peggedCHF: 980_000_000 },
      circulatingPrevMonth: { peggedCHF: 970_000_000 },
    };

    const html = renderToStaticMarkup(
      <HeroCard
        coin={nonUsdCoin}
        coinData={nonUsdCoinData}
        logoSrc="/logos/zchf.svg"
        isNavToken={false}
        mcap={1_000_000_000}
        supply={1_000_000_000}
        prevDay={995_000_000}
        prevWeek={980_000_000}
        prevMonth={970_000_000}
        performanceVsUsd1y={12.34}
        pegRef={1.12}
        deviationBps={-2}
        gaugeDeviationBps={2}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={3}
        liquidityData={liquidityData}
        yieldRanking={yieldRanking}
        stressSignal={stressSignal}
        reportCard={null}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("1Y vs USD");
    expect(html).toContain("+12.34%");
  });

  it("renders a limited depeg coverage note for sub-floor off-peg coins", () => {
    const html = renderToStaticMarkup(
      <HeroCard
        coin={coin}
        coinData={{ ...coinData, price: 0.97, circulating: { peggedUSD: 500_000 } }}
        logoSrc="/logos/usdc.svg"
        isNavToken={false}
        mcap={500_000}
        supply={500_000}
        prevDay={495_000}
        prevWeek={490_000}
        prevMonth={480_000}
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={-300}
        gaugeDeviationBps={-300}
        pegScoreResult={{ ...pegScoreResult, activeDepeg: false, depegEventCoverageLimited: true }}
        recordedDepegEventCount={0}
        liquidityData={liquidityData}
        yieldRanking={yieldRanking}
        stressSignal={stressSignal}
        reportCard={reportCardWithInheritedBlacklistRisk}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("Below $1.00M live-event floor. Deviation is shown, but event history may stay empty.");
  });

  it("renders an M0 infrastructure badge for M0-built stablecoins", () => {
    const m0Coin: StablecoinMeta = {
      ...coin,
      id: "usdsc-startale",
      name: "Startale USD",
      symbol: "USDSC",
      infrastructures: ["m0"],
    };

    const html = renderToStaticMarkup(
      <HeroCard
        coin={m0Coin}
        coinData={{ ...coinData, id: "usdsc-startale", name: "Startale USD", symbol: "USDSC" }}
        logoSrc="/logos/usdsc.svg"
        isNavToken={false}
        mcap={4_100_232}
        supply={4_100_232}
        prevDay={4_000_000}
        prevWeek={3_900_000}
        prevMonth={3_500_000}
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={-2}
        gaugeDeviationBps={2}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={0}
        liquidityData={liquidityData}
        yieldRanking={null}
        stressSignal={null}
        reportCard={null}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("Infrastructure");
    expect(html).toContain("M0");
  });

  it("renders multiple infrastructure badges when a coin belongs to more than one", () => {
    const dualCoin: StablecoinMeta = {
      ...coin,
      id: "hypothetical-dual",
      name: "Hypothetical Dual",
      symbol: "HYP",
      infrastructures: ["liquity-v2", "m0"],
    };

    const html = renderToStaticMarkup(
      <HeroCard
        coin={dualCoin}
        coinData={{ ...coinData, id: "hypothetical-dual", name: "Hypothetical Dual", symbol: "HYP" }}
        logoSrc="/logos/hyp.svg"
        isNavToken={false}
        mcap={1_000_000}
        supply={1_000_000}
        prevDay={995_000}
        prevWeek={990_000}
        prevMonth={985_000}
        performanceVsUsd1y={null}
        pegRef={1}
        deviationBps={-2}
        gaugeDeviationBps={2}
        pegScoreResult={pegScoreResult}
        recordedDepegEventCount={0}
        liquidityData={liquidityData}
        yieldRanking={null}
        stressSignal={null}
        reportCard={null}
        onOpenFeedback={() => {}}
      />,
    );

    expect(html).toContain("Liquity v2");
    expect(html).toContain("M0");
  });
});
