import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroCard, HeroIdentityHeader } from "@/components/stablecoin-detail/hero-card";
import { HeroPriceMetric } from "@/components/stablecoin-detail/hero-card-metrics";
import { buildStablecoinDetailHeroViewModel } from "@/lib/stablecoin-detail-view-model";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import type * as FeatureFlags from "@/lib/feature-flags";
import type {
  DexLiquidityData,
  PegSummaryCoin,
  StablecoinData,
  StablecoinMeta,
  StressSignalEntry,
  YieldRanking,
} from "@shared/types";

const hydration = vi.hoisted(() => ({ hydrated: false }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => hydration.hydrated }));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  isHeroVerdictEnabled: () => true,
}));

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
    nativeSupply: { current: 1_000_000_000, prevWeek: 980_000_000, prevMonth: 970_000_000 },
    performanceVsUsd1y: null,
    pegRef: 1,
    deviationBps: -2,
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
      <HeroIdentityHeader model={model} onOpenFeedback={onOpenFeedback} />
      <HeroCard model={model} />
    </>
  );
}

function renderHero(overrides: HeroBuilderOverrides = {}): string {
  return renderToStaticMarkup(<HeroCardUnderTest {...overrides} onOpenFeedback={() => {}} />);
}

describe("HeroCard", () => {
  it("renders current-relative 7D and 30D supply growth despite a lagged provider history", () => {
    const now = 1_790_793_000;
    const day = 86_400;
    const summary = projectStablecoinLiveSummary({
      price: 1, priceSource: "coingecko", currentCirculatingUSD: { peggedUSD: 200 }, currentSupplyObservedAt: now,
      tokens: [
        { date: now - 33 * day, totalCirculating: { peggedUSD: 50 } },
        { date: now - 30 * day, totalCirculating: { peggedUSD: 80 } },
        { date: now - 10 * day, totalCirculating: { peggedUSD: 100 } },
        { date: now - 7 * day, totalCirculating: { peggedUSD: 140 } },
        { date: now - 3 * day, totalCirculating: { peggedUSD: 160 } },
      ],
    });
    const html = renderHero({ supply: 200, nativeSupply: summary.nativeSupply });
    expect(html).toContain("+42.86%");
    expect(html).toContain("+150.00%");
    expect(html).not.toContain("+100.00%");
    expect(html).toContain("7D");
    expect(html).toContain("30D");
    const unavailable = renderHero({ supply: 200, nativeSupply: { current: 200, prevWeek: null, prevMonth: null } });
    expect(unavailable).not.toContain("+100.00%");
    expect(unavailable).not.toContain('> 30D</span>');
  });
  it("labels restored market cap with its original supply observation date", () => {
    const html = renderHero({ coinData: { supplyRestored: true, supplyObservedAt: 1_700_000_000 } });
    expect(html).toContain("Stale supply · as of Nov 14");
    expect(renderHero({ coinData: { supplyRestored: false, supplyObservedAt: 1_700_000_000 } }))
      .not.toContain("Stale supply");
  });

  it("labels partial-coverage market cap with the excluded chains", () => {
    expect(renderHero({ coinData: { supplyExcludedChains: ["HyperEVM"] } }))
      .toContain("Partial supply · excludes HyperEVM");
    expect(renderHero({ coinData: { supplyRestored: false } })).not.toContain("Partial supply");
  });

  it("renders unavailable market cap and supply without a false zero in static markup", () => {
    const html = renderHero({
      coinData: { circulating: {}, circulatingPrevDay: {} },
      mcap: null,
      supply: null,
      prevDay: null,
      nativeSupply: null,
    });
    expect(html).not.toContain("$0.00");
    expect(html).toMatch(/Market cap<\/p><p[^>]*>—<\/p>/);
    expect(html).toMatch(/Supply<\/p><p[^>]*>—/);
  });

  it.each([
    { score: null, pools: 0, value: "—" },
    { score: null, pools: 3, value: "—" },
    { score: 0, pools: 3, value: "0" },
    { score: 82, pools: 3, value: "82" },
  ])("preserves liquidity availability for score $score with $pools pools", ({ score, pools, value }) => {
    const overrides = { liquidityData: { ...liquidityData, liquidityScore: score, poolCount: pools } };
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps(overrides));
    const metric = model.tertiaryMetrics.find((item) => item.key === "liquidity")!;
    expect(metric.display.value).toBe(value);
    expect(metric.display.sub).toBe(`${pools} pools`);
    expect(model.signalRailItems.find((item) => item.key === "liquidity")?.primary).toBe(value);
    if (score === null) {
      expect(metric.accentClass).toBeUndefined();
      expect(metric.display.color).toBe("text-muted-foreground");
    }
    const html = renderHero(overrides);
    expect(html).toContain(`${pools} pools`);
    expect(html.split(">Liq<")[1]).toContain(`>${value}<`);
  });

  it("leaves missing liquidity unavailable without a measured score accent", () => {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps({ liquidityData: undefined }));
    const metric = model.tertiaryMetrics.find((item) => item.key === "liquidity")!;
    expect(metric.display.value).toBe("—");
    expect(metric.display.sub).toBeUndefined();
    expect(metric.accentClass).toBeUndefined();
  });

  it("renders the existing unavailable placeholder when live price is null", () => {
    const html = renderToStaticMarkup(
      <HeroPriceMetric
        coin={coin}
        coinData={{ ...coinData, price: null, priceConfidence: null }}
        price={{
          pegRef: 1,
          deviationBps: null,
          pegReferenceUnavailable: false,
          isNavToken: false,
          limitedDepegCoverageNote: null,
        }}
        variant="card"
      />,
    );

    expect(html).toMatch(/>Price<\/p><p[^>]*>N\/A<\/p>/);
    expect(html).not.toContain("$0.0000");
  });

  it("uses the published deviation when the live price snapshot disagrees", () => {
    const html = renderHero({
      coinData: { price: 1.02 },
      deviationBps: -50,
    });

    expect(html).toContain(">-50</span> bps");
    expect(html).not.toContain("+200");
  });

  it.each(["card", "cell"] as const)("withholds the %s peg deviation when its observed price is unusable", (variant) => {
    for (const price of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const html = renderToStaticMarkup(<HeroPriceMetric
        coin={coin}
        coinData={{ ...coinData, price, priceConfidence: null }}
        price={{ pegRef: 1, deviationBps: 1, pegReferenceUnavailable: false, isNavToken: false, limitedDepegCoverageNote: null }}
        variant={variant}
      />);
      expect(html).toMatch(/Observed price unavailable/i);
      expect(html).not.toMatch(/\+1 BPS/i);
      expect(html).toContain("N/A");
    }
  });

  it.each(["card", "cell"] as const)("labels a frozen archive's %s price as its last observation, not a live peg reading", (variant) => {
    const html = renderToStaticMarkup(<HeroPriceMetric
      coin={{ ...coin, status: "frozen", frozenAt: "2026-06-30" }}
      coinData={{ ...coinData, price: 0.9997 }}
      price={{ pegRef: 1, deviationBps: null, pegReferenceUnavailable: false, isNavToken: false, limitedDepegCoverageNote: null }}
      variant={variant}
    />);
    expect(html).toContain("Last observed · 2026-06-30");
  });

  it("renders the active-depeg chip when the peg summary flags one", () => {
    const html = renderHero();

    expect(html).toContain("Active depeg");
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
      deviationBps: 350,
      pegScoreResult: null,
      verdict: { archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" },
    });

    expect(html).toContain("NAV token — no fixed peg");
    expect(html).toContain("USD NAV");
    expect(html).not.toContain("+350 bps");
    expect(html).not.toContain("+350");
    expect(html).not.toContain("peg-gauge:350");
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

    expect(html).toContain(">Upstream<");
    expect(html).not.toContain("No issuer controls");
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
      deviationBps: -300,
      pegScoreResult: { ...pegScoreResult, activeDepeg: false, depegEventCoverageLimited: true },
      reportCard: reportCardWithInheritedBlacklistRisk,
    });

    expect(html).toContain("Below $1.00M live-event floor. Deviation is shown, but event history may stay empty.");
  });

  it("derives Supply trends from native token counts, never from USD market-cap history", () => {
    // XAUT shape: ~808K tokens priced near $4,140. A USD market-cap anchor would render -99.98%.
    const html = renderHero({
      coin: { flags: { pegCurrency: "GOLD" } },
      coinData: {
        price: 4_140,
        circulating: { peggedGOLD: 3_345_120_000 },
        circulatingPrevWeek: { peggedGOLD: 3_533_600_000 },
        circulatingPrevMonth: { peggedGOLD: 2_731_000_000 },
      },
      mcap: 3_345_120_000,
      supply: 808_000,
      prevDay: null,
      nativeSupply: { current: 808_000, prevWeek: 800_000, prevMonth: 790_000 },
      pegRef: 4_140,
      reportCard: null,
    });

    expect(html).toContain("808.00K");
    expect(html).toContain("+1.00%");
    expect(html).toContain("+2.28%");
    expect(html).not.toContain("-99.98%");
  });

});

describe("HeroIdentityHeader", () => {
  function renderHeader(overrides: HeroBuilderOverrides = {}, gradeRead?: "settled" | "pending" | "failed"): string {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps(overrides));
    return renderToStaticMarkup(<HeroIdentityHeader model={model} onOpenFeedback={() => {}} gradeRead={gradeRead} />);
  }

  it("passes the report-card read to the mobile grade", () => {
    expect(renderHeader({ reportCard: null }, "failed")).toContain("Grade unavailable");
    expect(renderHeader({ reportCard: null }, "pending")).toContain('aria-label="Loading Safety Score"');
    expect(renderHeader({ reportCard: null })).not.toContain("Grade unavailable");
  });

  it("stamps the snapshot age neutrally, only once the reader clock is known", () => {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps());
    const now = Date.parse("2026-10-21T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const render = (updatedAtMs: number) =>
      renderToStaticMarkup(<HeroIdentityHeader model={model} onOpenFeedback={() => {}} updatedAtMs={updatedAtMs} />);
    try {
      const prerender = render(now - 12 * 60_000);
      expect(prerender.match(/Updated —/g)).toHaveLength(2);
      hydration.hydrated = true;
      const markup = render(now - 12 * 60_000);
      // One stamp per breakpoint: closing the action row below lg, bottom-right at lg+.
      expect(markup.match(/Updated 12m ago/g)).toHaveLength(2);
      expect(prerender.replaceAll("Updated —", "Updated 12m ago")).toBe(markup);
      expect(markup).not.toMatch(/amber|text-warning/);
      expect(render(0)).not.toContain("Updated");
    } finally {
      hydration.hydrated = false;
      vi.restoreAllMocks();
    }
  });
});
