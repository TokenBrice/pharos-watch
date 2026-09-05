import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroCard, HeroDesktopIdentityToolbar } from "@/components/stablecoin-detail/hero-card";
import { HeroPriceCard } from "@/components/stablecoin-detail/hero-card-metrics";
import { buildStablecoinDetailHeroViewModel } from "@/lib/stablecoin-detail-view-model";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type {
  DexLiquidityData,
  PegSummaryCoin,
  StablecoinData,
  StablecoinMeta,
  StressSignalEntry,
  YieldRanking,
} from "@shared/types";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/components/bluechip-header-badge", () => ({
  BluechipHeaderBadge: ({ stablecoinId }: { stablecoinId: string }) => <span>Bluechip: B ({stablecoinId})</span>,
}));

vi.mock("@/components/share-button", () => ({
  ShareButton: ({ label }: { label?: string }) => <button type="button">{label ?? "Share"}</button>,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name, size }: { name: string; size?: number }) => <span data-logo-size={size}>logo:{name}</span>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyHint: ({ topic }: { topic: string }) => <span data-testid={`methodology-hint-${topic}`} />,
  MethodologyTriggerButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
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
  oneLiner: "Circle-issued dollar stablecoin backed by cash and short-duration reserves.",
  status: "active",
  infrastructures: ["liquity-v2"],
  tags: ["major", "fiat-backed"],
  links: [
    { label: "Website", url: "https://www.circle.com/usdc" },
    { label: "Twitter", url: "https://x.com/circle" },
  ],
  flags: {
    backing: "rwa-backed",
    governance: "centralized",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: true,
    navToken: false,
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
  priceObservedAt: 1_700_000_000,
  priceObservedAtMode: "upstream",
  priceSyncedAt: 1_700_000_000,
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
  name: "USD Coin",
  pegType: "peggedUSD",
  pegCurrency: "USD",
  governance: "centralized",
  currentDeviationBps: -2,
  pegScore: 95,
  pegPct: 99.4,
  severityScore: 2,
  spreadPenalty: 0,
  eventCount: 2,
  worstDeviationBps: -20,
  trackingSpanDays: 365,
  activeDepeg: true,
  lastEventAt: 1_700_000_000,
  methodologyVersion: "3.2",
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
  lockedLiquidityPct: null,
  methodologyVersion: "test",
};

const reportCardWithInheritedBlacklistRisk = makeV9Card({
  id: "usdc-circle",
  grade: "B+",
  score: 79,
  accessPosture: {
    ...makeV9Card().accessPosture,
    freezeExposure: "upstream",
  },
});
const reportCardWithDirectBlacklistRisk = makeV9Card({
  id: "usdc-circle",
  grade: "B+",
  score: 79,
});

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

const verdict = {
  archetype: "institutional-default",
  label: "Institutional Default",
} as const;

type HeroBuilderParams = Parameters<typeof buildStablecoinDetailHeroViewModel>[0];

const NOT_REVIEWED_MINT_AUTHORITY = { status: "not-reviewed" } as HeroBuilderParams["mintAuthority"];

type HeroCoinOverrides = Omit<Partial<StablecoinMeta>, "flags"> & {
  flags?: Partial<StablecoinMeta["flags"]>;
};

type HeroBuilderOverrides = Partial<Omit<HeroBuilderParams, "coin" | "coinData">> & {
  coin?: HeroCoinOverrides;
  coinData?: Partial<StablecoinData>;
};

function makeHeroProps(overrides: HeroBuilderOverrides = {}): HeroBuilderParams {
  const { coin: coinOverrides, coinData: coinDataOverrides, ...rest } = overrides;

  return {
    coin: {
      ...coin,
      ...coinOverrides,
      flags: { ...coin.flags, ...coinOverrides?.flags },
    },
    coinData: { ...coinData, ...coinDataOverrides },
    logoSrc: "/logos/usdc.svg",
    isNavToken: false,
    mcap: 1_000_000_000,
    supply: 1_000_000_000,
    prevDay: 995_000_000,
    prevWeek: 980_000_000,
    prevMonth: 970_000_000,
    performanceVsUsd1y: null,
    pegRef: 1,
    deviationBps: -2,
    gaugeDeviationBps: 2,
    pegReferenceUnavailable: false,
    pegScoreResult,
    liquidityData,
    yieldRanking,
    stressSignal,
    reportCard: reportCardWithDirectBlacklistRisk,
    verdict,
    resolvedMechanismArchetype: null,
    mintAuthority: NOT_REVIEWED_MINT_AUTHORITY,
    redemptionBackstop: null,
    ...rest,
  };
}

function HeroCardUnderTest({ onOpenFeedback, ...overrides }: HeroBuilderOverrides & { onOpenFeedback: () => void }) {
  const model = buildStablecoinDetailHeroViewModel(makeHeroProps(overrides));
  // The detail page renders the identity toolbar above the content/rail grid
  // and the card inside it; render both here to keep covering the pair.
  return (
    <>
      <HeroDesktopIdentityToolbar model={model} onOpenFeedback={onOpenFeedback} />
      <HeroCard model={model} onOpenFeedback={onOpenFeedback} />
    </>
  );
}

function renderHero(overrides: HeroBuilderOverrides = {}): string {
  return renderToStaticMarkup(<HeroCardUnderTest {...overrides} onOpenFeedback={() => {}} />);
}

describe("HeroCard", () => {
  it("renders the existing unavailable placeholder when live price is null", () => {
    const html = renderToStaticMarkup(
      <HeroPriceCard
        coin={coin}
        coinData={{ ...coinData, price: null, priceConfidence: null }}
        price={{
          pegRef: 1,
          deviationBps: null,
          gaugeDeviationBps: 0,
          pegReferenceUnavailable: false,
          isNavToken: false,
          limitedDepegCoverageNote: null,
        }}
      />,
    );

    expect(html).toMatch(/>Price<\/p><p[^>]*>N\/A<\/p>/);
    expect(html).not.toContain("$0.0000");
  });

  it("renders shared identity, price, and metric content across responsive layouts", () => {
    const html = renderHero();

    expect(html).toContain("USD Coin");
    expect(html).toContain('data-logo-size="56"');
    expect(html).toMatch(/logo:USD Coin<\/span><span[^>]*>USDC<\/span><h2[^>]*>USD Coin<\/h2>/);
    expect(html).toContain("Circle-issued dollar stablecoin backed by cash and short-duration reserves.");
    expect(html).toContain('href="https://www.circle.com/usdc"');
    expect(html).toContain('aria-label="Website"');
    expect(html).toContain('href="https://x.com/circle"');
    expect(html).toContain('aria-label="Twitter"');
    expect(html).toContain("major");
    expect(html).toContain("fiat-backed");
    expect(html).toContain("Infrastructure");
    expect(html).toContain("Liquity v2");
    expect(html).toContain("Bluechip: B");
  });

  it("renders the prepared hero metric contract across responsive layouts", () => {
    const html = renderHero();

    // The mobile-only peg gauge and freeze-summary chip were dropped: the hero
    // renders the same vocabulary at every breakpoint.
    expect(html).not.toContain("peg-gauge:");
    expect(html).toContain("Report issue");
    expect(html).toContain("Active depeg");
    expect(html).toContain("USD-Pegged");
    expect(html).toContain("RWA-Backed");
    expect(html).toContain("Centralized");
    expect(html).toContain("Liq");
    expect(html).toContain("30d Excess");
    expect(html).toContain("+0.85%");
    expect(html).toContain("30D VS USD 3M T-BILL");
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

  it("renders the verification passport contract across responsive layouts", () => {
    const html = renderHero();

    // Passport strip: the five verification facts as anchor-jump chips.
    expect(html).toContain('aria-label="Verification passport"');
    expect(html).toContain("Mechanism");
    expect(html).toContain("RWA-Backed"); // archetype fallback when unresolved
    expect(html).toContain("Jurisdiction");
    expect(html).toContain("Freezable — issuer can freeze, block, or seize balances");
    expect(html).toContain('href="#blacklist"'); // USDC is blacklist-tracked
    expect(html).toContain("Chains");
    expect(html).not.toContain(">Blacklistable<");
  });

  it("does not render NAV appreciation as a fixed-dollar peg deviation", () => {
    const html = renderHero({
      coin: {
        id: "dusd-dialectic",
        symbol: "DUSD",
        name: "Dialectic USD",
        flags: {
          backing: "crypto-backed",
          governance: "centralized-dependent",
          yieldBearing: true,
          rwa: false,
          navToken: true,
        },
      },
      coinData: { id: "dusd-dialectic", symbol: "DUSD", name: "Dialectic USD", price: 1.035 },
      logoSrc: "/logos/dusd.svg",
      isNavToken: true,
      mcap: 1_035_000,
      supply: 1_000_000,
      prevDay: 1_000_000,
      prevWeek: 1_000_000,
      prevMonth: 1_000_000,
      deviationBps: 350,
      gaugeDeviationBps: 350,
      pegScoreResult: null,
      verdict: { archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" },
    });

    expect(html).toContain("NAV token — no fixed peg");
    expect(html).toContain("USD NAV");
    expect(html).not.toContain("+350 bps");
    expect(html).not.toContain("+350 BPS");
    expect(html).not.toContain("peg-gauge:350");
  });

  it("keeps the subject case study callout docked inside the hero card", () => {
    const html = renderHero({ reportCard: null });

    expect(html).toContain('href="/learn/case-studies/usdc-svb-2023/"');
    expect(html).toContain("Read the case study: USDC and the Silicon Valley Bank weekend");
    expect(html).toContain("Survived");
    expect(html).toContain("sm:justify-between");
    expect(html).not.toContain("-mb-4");
  });

  it("uses the reviewed registry blacklist status for inherited-risk coins", () => {
    const html = renderHero({
      coin: {
        id: "dai-makerdao",
        name: "Mock Inherited",
        symbol: "MCK",
        flags: { governance: "centralized-dependent" },
      },
      coinData: { id: "dai-makerdao", name: "Mock Inherited", symbol: "MCK" },
      logoSrc: "/logos/mock.svg",
      yieldRanking: null,
      stressSignal: null,
      reportCard: { ...reportCardWithInheritedBlacklistRisk, id: "dai-makerdao" },
    });

    expect(html).toContain("Centralized-Dependent");
    expect(html).toContain("Upstream freeze — freezing is inherited from an upstream issuer or collateral asset");
    expect(html).toContain(">Upstream<");
    expect(html).not.toContain("No issuer controls");
  });

  it("uses shared no-gap copy when excess yield is unavailable", () => {
    const html = renderHero({
      yieldRanking: { ...yieldRanking, excessYield: null },
      reportCard: reportCardWithInheritedBlacklistRisk,
    });

    expect(html).toContain("NO 30D BENCHMARK GAP");
  });

  it("renders the tracked parent chip for variant detail pages", () => {
    const parentCoin = CLIENT_TRACKED_META_BY_ID.get("usds-sky");
    expect(parentCoin).toBeDefined();

    const html = renderHero({
      coin: {
        id: "susds-sky",
        name: "Sky Savings USDS",
        symbol: "sUSDS",
        variantOf: "usds-sky",
        variantKind: "savings-passthrough",
        flags: { navToken: true },
      },
      coinData: { id: "susds-sky", name: "Sky Savings USDS", symbol: "sUSDS" },
      logoSrc: "/logos/susds.svg",
      isNavToken: true,
      deviationBps: 0,
      gaugeDeviationBps: 0,
      pegScoreResult: null,
      reportCard: null,
      variantParent: parentCoin!,
      variantKind: "savings-passthrough",
    });

    expect(html).toContain("Wraps USDS");
  });

  it("renders 1Y vs USD for eligible non-USD coins when performance is available", () => {
    const html = renderHero({
      coin: {
        id: "zchf-frankencoin",
        name: "Frankencoin",
        symbol: "ZCHF",
        flags: { pegCurrency: "CHF" },
      },
      coinData: {
        id: "zchf-frankencoin",
        name: "Frankencoin",
        symbol: "ZCHF",
        pegType: "peggedCHF",
        price: 1.12,
        circulating: { peggedCHF: 1_000_000_000 },
        circulatingPrevDay: { peggedCHF: 995_000_000 },
        circulatingPrevWeek: { peggedCHF: 980_000_000 },
        circulatingPrevMonth: { peggedCHF: 970_000_000 },
      },
      logoSrc: "/logos/zchf.svg",
      performanceVsUsd1y: 12.34,
      pegRef: 1.12,
      reportCard: null,
    });

    expect(html).toContain("1Y vs USD");
    expect(html).toContain("+12.34%");
  });

  it("renders a limited depeg coverage note for sub-floor off-peg coins", () => {
    const html = renderHero({
      coinData: { price: 0.97, circulating: { peggedUSD: 500_000 } },
      mcap: 500_000,
      supply: 500_000,
      prevDay: 495_000,
      prevWeek: 490_000,
      prevMonth: 480_000,
      deviationBps: -300,
      gaugeDeviationBps: -300,
      pegScoreResult: { ...pegScoreResult, activeDepeg: false, depegEventCoverageLimited: true },
      reportCard: reportCardWithInheritedBlacklistRisk,
    });

    expect(html).toContain("Below $1.00M live-event floor. Deviation is shown, but event history may stay empty.");
  });

  it("renders an M0 infrastructure badge for M0-built stablecoins", () => {
    const html = renderHero({
      coin: { id: "usdsc-startale", name: "Startale USD", symbol: "USDSC", infrastructures: ["m0"] },
      coinData: { id: "usdsc-startale", name: "Startale USD", symbol: "USDSC" },
      logoSrc: "/logos/usdsc.svg",
      mcap: 4_100_232,
      supply: 4_100_232,
      prevDay: 4_000_000,
      prevWeek: 3_900_000,
      prevMonth: 3_500_000,
      yieldRanking: null,
      stressSignal: null,
      reportCard: null,
    });

    expect(html).toContain("Infrastructure");
    expect(html).toContain("M0");
  });

  it("renders multiple infrastructure badges when a coin belongs to more than one", () => {
    const html = renderHero({
      coin: {
        id: "hypothetical-dual",
        name: "Hypothetical Dual",
        symbol: "HYP",
        infrastructures: ["liquity-v2", "m0"],
      },
      coinData: { id: "hypothetical-dual", name: "Hypothetical Dual", symbol: "HYP" },
      logoSrc: "/logos/hyp.svg",
      mcap: 1_000_000,
      supply: 1_000_000,
      prevDay: 995_000,
      prevWeek: 990_000,
      prevMonth: 985_000,
      yieldRanking: null,
      stressSignal: null,
      reportCard: null,
    });

    expect(html).toContain("Liquity v2");
    expect(html).toContain("M0");
  });
});
