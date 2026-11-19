import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroCard, HeroIdentityHeader } from "@/components/stablecoin-detail/hero-card";
import { HeroPriceMetric, HeroSupplyMetric } from "@/components/stablecoin-detail/hero-card-metrics";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import { buildStablecoinDetailHeroViewModel } from "@/lib/stablecoin-detail-view-model";
import { buildSafetyVerdictLine } from "@/lib/stablecoin-detail-hero-metrics";
import { NoticeStack, placeCoinNotices } from "@/components/coin-notice";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import type * as FeatureFlags from "@/lib/feature-flags";
import type { DexLiquidityData } from "@shared/types/dex-liquidity";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinData } from "@shared/types/supply";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { StressSignalEntry } from "@shared/types/stress";
import type { YieldRanking } from "@shared/types/yield";

const hydration = vi.hoisted(() => ({ hydrated: false }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => hydration.hydrated }));
const clock = vi.hoisted(() => ({ nowMs: null as number | null }));
vi.mock("@/hooks/use-utc-day-clock", () => ({ useUtcDayNowMs: () => clock.nowMs }));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  isHeroVerdictEnabled: () => true,
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

type HeroPriceProps = Parameters<typeof HeroPriceMetric>[0]["price"];

const priceState = (overrides: Partial<HeroPriceProps> = {}): HeroPriceProps => ({
  pegRef: 1, deviationBps: null, pegReferenceUnavailable: false, referenceNote: null,
  isNavToken: false, limitedDepegCoverageNote: null, caveat: null, ...overrides,
});

const eurCoin: StablecoinMeta = { ...coin, flags: { ...coin.flags, pegCurrency: "EUR" } };

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
  coinData?: Partial<Omit<StablecoinData, keyof HeroBuilderParams["coinData"]>> & Partial<HeroBuilderParams["coinData"]>;
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
    referenceNote: null,
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
      price: 1, priceSource: "coingecko", currentCirculatingUSD: { peggedUSD: 200 },
      currentCirculatingNative: 200, currentSupplyObservedAt: now,
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
  it("labels restored market cap neutrally with its original supply observation date", () => {
    const html = renderHero({ coinData: { supplyRestored: true, supplyObservedAt: 1_700_000_000 } });
    expect(html).toContain("Supply as of Nov 14");
    expect(html).not.toContain("Stale supply");
    expect(html).not.toMatch(/text-state-warn[^>]*>Supply as of/);
    expect(renderHero({ coinData: { supplyRestored: true, supplyObservedAt: null } })).toContain("Supply date unavailable");
    expect(renderHero({ coinData: { supplyRestored: false, supplyObservedAt: 1_700_000_000 } }))
      .not.toContain("Supply as of");
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
    if (score === null) expect(metric.display.color).toBe("text-muted-foreground");
    const html = renderHero(overrides);
    // A tile without a score is left out, never shown as a dash.
    if (score === null) {
      expect(html).not.toContain(">Liq<");
    } else {
      expect(html).toContain(`${pools} pools`);
      expect(html.split(">Liq<")[1]).toContain(`>${value}<`);
    }
  });

  it("leaves missing liquidity unavailable", () => {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps({ liquidityData: undefined }));
    const metric = model.tertiaryMetrics.find((item) => item.key === "liquidity")!;
    expect(metric.display.value).toBe("—");
    expect(metric.display.sub).toBeUndefined();
  });

  it("prints every signal tile's figure one way: no pill, no severity stripe, tone only for risk", () => {
    const html = renderHero({ liquidityData: { ...liquidityData, liquidityScore: 20 } });
    const tiles = html.split("Active depeg")[0]!.split(">DEWS<")[1]!;
    // The DEWS band is a word in its band tone at figure size, like Peg and Liq.
    expect(tiles).toMatch(/class="text-lg font-bold leading-tight pharos-numeric [^"]*">Watch</);
    expect(tiles).not.toContain('data-slot="badge"');
    expect(html).not.toMatch(/border-l-(2|\[3px\])/);
    // Three signals sit three across, on the market row's thirds.
    expect(html).toContain('class="mt-2.5 grid gap-2.5 sm:mt-3 sm:gap-3 grid-cols-3"');
    expect(html).toContain('class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3"');
  });

  it("lays four signal tiles two by two on a phone and on the market row's quarters from sm", () => {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps());
    const keyMetric = { key: "backing-ratio", label: "Collateralization", value: "209.5%", subValue: "vs debt", colorClass: "text-foreground", railTwin: true };
    const html = renderToStaticMarkup(<HeroCard model={model} keyMetric={keyMetric} />);
    expect(html).toContain('class="mt-2.5 grid gap-2.5 sm:mt-3 sm:gap-3 grid-cols-2 sm:grid-cols-4"');
    expect(html).toContain('class="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3"');
    // Supply spans two quarters, so both rows share their column edges.
    expect(html).toContain('class="col-span-2 min-w-0 pharos-inset px-3 py-2.5"');
    // The xl rail carries the ratio, so the cell hides there.
    expect(html).toContain("lg:grid-cols-4 xl:grid-cols-3");
    expect(html).toMatch(/class="min-h-\[8\.25rem\][^"]*xl:hidden"/);
  });

  it("renders the existing unavailable placeholder when live price is null", () => {
    const html = renderToStaticMarkup(
      <HeroPriceMetric
        coin={coin}
        coinData={{ ...coinData, price: null, priceConfidence: null }}
        price={priceState()}
        variant="card"
      />,
    );

    expect(html).toMatch(/>Price<\/p><p[^>]*>N\/A<\/p>/);
    expect(html).not.toContain("$0.0000");
  });

  it.each(["low", "fallback"] as const)("shows published deviation for an observed %s quote", (priceConfidence) => {
    const html = renderHero({
      coinData: { price: 1.02, priceConfidence },
      deviationBps: -50,
    });

    expect(html).toContain(">-50</span> bps");
    expect(html).not.toContain("+200");
  });

  it("names the closed reference market instead of a held deviation", () => {
    const html = renderHero({ referenceNote: "Reference market closed", deviationBps: null });
    expect(html).toContain("Reference market closed");
    // A missing peg state outranks the closure: a NAV token keeps its own label.
    expect(renderHero({ referenceNote: "Reference market closed", deviationBps: null, isNavToken: true })).toContain("NAV token — no fixed peg");
  });

  it.each(["card", "cell"] as const)("withholds the %s peg deviation when its observed price is unusable", (variant) => {
    for (const price of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const html = renderToStaticMarkup(<HeroPriceMetric
        coin={coin}
        coinData={{ ...coinData, price, priceConfidence: null }}
        price={priceState({ deviationBps: 1 })}
        variant={variant}
      />);
      expect(html).toMatch(/Observed price unavailable/i);
      expect(html).not.toMatch(/\+1 BPS/i);
      expect(html).toContain("N/A");
    }
  });

  it.each(["card", "cell"] as const)("qualifies an inherited %s price: the caveat calms only an at-peg tone", (variant) => {
    const html = (deviationBps: number) =>
      renderToStaticMarkup(<HeroPriceMetric coin={coin} coinData={coinData} price={priceState({ deviationBps, caveat: "Price inherited from AUSD" })} variant={variant} />);
    expect(html(-6)).toContain("Price inherited from AUSD");
    expect(html(-6)).not.toContain(deviationColorClass(6));
    expect(html(-300)).toContain(deviationColorClass(300));
  });

  it.each(["card", "cell"] as const)("labels a frozen archive's %s price as its last observation, not a live peg reading", (variant) => {
    const html = renderToStaticMarkup(<HeroPriceMetric
      coin={{ ...coin, status: "frozen", frozenAt: "2026-06-30" }}
      coinData={{ ...coinData, price: 0.9997 }}
      price={priceState()}
      variant={variant}
    />);
    expect(html).toContain("Last observed · 2026-06-30");
  });

  it.each(["card", "cell"] as const)("labels the %s USD fallback price as USD, not the peg currency", (variant) => {
    const html = renderToStaticMarkup(<HeroPriceMetric
      coin={eurCoin}
      coinData={{ ...coinData, price: 1.117990454919679 }}
      price={priceState({ pegRef: null })}
      variant={variant}
    />);

    expect(html).toContain("Price (USD)");
    expect(html).toContain("$1.1180");
    expect(html).not.toContain("Price (EUR)");
  });

  it.each(["card", "cell"] as const)("keeps the %s native-unit label when a reference is usable", (variant) => {
    const html = renderToStaticMarkup(<HeroPriceMetric
      coin={eurCoin}
      coinData={{ ...coinData, price: 1.11 }}
      price={priceState({ pegRef: 1.11, deviationBps: 0 })}
      variant={variant}
    />);

    expect(html).toContain("Price (EUR)");
    expect(html).toContain("EUR 1.0000");
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
      // DEWS does not score NAV tokens.
      stressSignal: null,
      verdict: { archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" },
    });

    expect(html).toContain("NAV token — no fixed peg");
    // No peg, so no tone: the line is neutral context, not a green "healthy" reading.
    expect(html.split("NAV token — no fixed peg")[0]!.slice(-160)).not.toContain("text-green");
    // No DEWS or Peg reading applies: those tiles are left out, not filled with N/A.
    expect(html).not.toContain(">DEWS<");
    expect(html).not.toContain(">Peg<");
    expect(html).not.toContain("N/A");
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

    expect(html).toContain(">Upstream risk<");
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
    // The cap's unit sits in its label, so its delta lines up with its neighbours'.
    expect(html).toContain("Market cap (USD)");
    expect(html).not.toContain("USD-normalized");
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

  it("keeps the verdict separator off any line end and the actions on one row", () => {
    const header = renderHeader();
    const verdictLine = header.match(/<p class="([^"]*)" data-safety-verdict-line="[^"]*">(.*?)<\/p>/)!;
    expect(verdictLine[1]).not.toContain("flex");
    expect(verdictLine[2]).toContain(">\u00a0·\u00a0<");
    expect(header).not.toContain("flex-wrap items-center gap-2");
    // Only the compare label gives way on a narrow row.
    expect(header).toMatch(/<span class="truncate">(vs [^<]+|Compare)<\/span>/);
    expect(header).toContain("[&amp;&gt;[aria-haspopup=menu]]:shadow-none");
  });

  it("gives the variant chip its own row below sm", () => {
    const header = renderHeader({ variantParent: CLIENT_TRACKED_META_BY_ID.get("usde-ethena")!, variantKind: "savings-passthrough" });
    expect(header).toMatch(/<div class="hidden min-w-0 sm:flex"><a[^>]*>.*?Wraps Ethena USDe/);
    expect(header).toMatch(/<div class="sm:hidden"><a[^>]*class="[^"]*text-2xs[^"]*"[^>]*>.*?Wraps Ethena USDe/);
  });

  it("passes the report-card read to the mobile grade", () => {
    expect(renderHeader({ reportCard: null }, "failed")).toContain("Grade unavailable");
    expect(renderHeader({ reportCard: null }, "pending")).toContain('aria-label="Loading Safety Score"');
    expect(renderHeader({ reportCard: null })).not.toContain("Grade unavailable");
  });

  it("stamps the snapshot age neutrally, only once the reader clock is known", () => {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps());
    const now = Date.parse("2026-10-21T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const render = (updatedAtMs: number, daily?: boolean) =>
      renderToStaticMarkup(<HeroIdentityHeader model={model} onOpenFeedback={() => {}} updatedAtMs={updatedAtMs} dailySnapshot={daily} />);
    try {
      const prerender = render(now - 12 * 60_000);
      expect(prerender.match(/Updated —/g)).toHaveLength(1);
      hydration.hydrated = true;
      const markup = render(now - 12 * 60_000);
      // One stamp under the action row at every width.
      expect(markup.match(/Updated 12m ago/g)).toHaveLength(1);
      expect(prerender.replaceAll("Updated —", "Updated 12m ago")).toBe(markup);
      expect(markup).not.toMatch(/amber|text-warning/);
      expect(render(0)).not.toContain("Updated");
      expect(render(now, true)).toContain("Daily snapshot of Oct 21, 2026");
    } finally {
      hydration.hydrated = false;
      vi.restoreAllMocks();
    }
  });
});

describe("HeroSupplyMetric", () => {
  it("renders an em dash when historical supply deltas are unavailable", () => {
    const markup = renderToStaticMarkup(
      <HeroSupplyMetric
        supply={1_000}
        coinSymbol="USDT"
        supplyTrend={{
          current: 1_000,
          safePrevWeek: null,
          safePrevMonth: null,
          hasPrevMonth: true,
          prevWeekTrendClass: "text-muted-foreground",
          prevMonthTrendClass: "text-muted-foreground",
        }}
      />,
    );

    expect(markup).toContain("30D");
    expect(markup.match(/—/g)).toHaveLength(2);
  });
});

describe("hero verdict, fourth figure and holder alerts", () => {
  const ratioMetric = { key: "backing-ratio", label: "Collateralization", value: "209.5%", subValue: "vs debt", colorClass: "text-foreground" };

  it("gives a coin without native yield its mechanism figure, never a third-party 30d Excess", () => {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps());
    const markup = renderToStaticMarkup(<HeroCard model={model} keyMetric={ratioMetric} />);
    expect(markup).toContain("Collateralization");
    expect(markup).toContain("209.5%");
    expect(markup).not.toContain("30d Excess");
  });

  it("keeps the native yield-vs-T-bill figure for a yield-bearing coin", () => {
    const model = buildStablecoinDetailHeroViewModel(makeHeroProps({ coin: { flags: { yieldBearing: true } } }));
    const markup = renderToStaticMarkup(<HeroCard model={model} keyMetric={ratioMetric} />);
    expect(markup).toContain("30d Excess");
    expect(markup).not.toContain("209.5%");
  });

  it("shows no external rating beside the Pharos grade", () => {
    expect(renderHero()).not.toMatch(/Bluechip/i);
  });

  it("states the grade's one reason: binding cap, then peg multiplier, else weakest pillar", () => {
    const cap = { kind: "track-record", source: "track-record", binding: true, limit: 84, reason: "Less than two years of known implementation history." };
    expect(buildSafetyVerdictLine(makeV9Card({ score: 84, bindingCap: cap as never })))
      .toEqual({ lead: "Capped at 84", detail: "Less than two years of known implementation history" });
    expect(buildSafetyVerdictLine(makeV9Card({ score: 26, qualityScore: 52, pegMultiplier: 0.51, pegAdjustedScore: 26 })))
      .toEqual({ lead: "Peg performance", detail: "x0.510 on pillar quality 52/100" });
    expect(buildSafetyVerdictLine(makeV9Card({ score: 85, qualityScore: 85, pegMultiplier: 1, pegAdjustedScore: 84.7 })))
      .toEqual({ lead: "Weakest pillar", detail: "Backing 83/100" });
    expect(buildSafetyVerdictLine(null)).toBeNull();
  });

  it("renders every notice in one grammar", () => {
    const notices = [
      { type: "danger", title: "L1 halted", message: "Read https://example.com/a first.", kind: "paused", asOf: "2026-10-30" },
      { type: "warning", title: "Migration", message: "M.", kind: "deadline", deadline: "2026-11-26" },
      { type: "info", title: "Caveat", message: "M." },
      { type: "warning", title: "Exploit repaid", message: "M.", kind: "history" },
      { type: "info", title: "Wound down", message: "M.", kind: "deadline", deadline: "2026-11-01" },
      { type: "danger", title: "Market closed", message: "M.", kind: "deadline", deadline: "2026-07-15" },
      { type: "danger", title: "Peg broken", message: "M.", kind: "depeg" },
    ] as const;
    const markup = renderToStaticMarkup(<NoticeStack notices={notices} />);
    expect(markup).toContain("Paused now · Action may be needed");
    // Without the reader's clock a deadline names its date and asks nothing.
    expect(markup).not.toContain("Deadline · Action may be needed");
    expect(markup).toMatch(/data-notice-deadline="2026-11-26"[^>]*>Nov 26, 2026</);
    expect(markup).toContain("Updated Oct 30, 2026");
    expect(markup).toMatch(/href="https:\/\/example.com\/a"[^>]*>More details/);
    // A caveat has no kicker; history is a calm fold.
    expect(markup.split("Caveat")[1]!.split("<details")[0]).not.toMatch(/Action may be needed|Notice</);
    expect(markup).toMatch(/<details[^>]*>.*Past event: Exploit repaid/s);
    expect(markup).not.toMatch(/border-l-|max-w-/);
    // With the clock only a deadline ahead asks to act, and a spent one folds out of the lead.
    const today = Date.parse("2026-11-17T12:00:00Z");
    clock.nowMs = today;
    const clocked = renderToStaticMarkup(<NoticeStack notices={notices} />);
    clock.nowMs = null;
    expect(clocked.match(/Action may be needed/g)).toHaveLength(2);
    expect(clocked).toMatch(/<details[^>]*>.*Deadline passed Jul 15, 2026: Market closed/s);
    const lead = (nowSec?: number) => placeCoinNotices(notices, { liveDepeg: true, nowSec }).critical.map((notice) => notice.title);
    expect([lead(), lead(today / 1000)]).toEqual([["L1 halted", "Market closed", "Peg broken"], ["L1 halted", "Peg broken"]]);
    expect(renderToStaticMarkup(<NoticeStack archive notices={[notices[0]]} />)).not.toMatch(/Action may be needed|state-danger/);
    expect(renderToStaticMarkup(<NoticeStack notices={[]} />)).toBe("");
  });

  it("mutes Peg and DEWS readings that cannot read calm", () => {
    const hero = (overrides: HeroBuilderOverrides) => buildStablecoinDetailHeroViewModel(makeHeroProps(overrides));
    const tile = (model: ReturnType<typeof hero>, key: string) => model.tertiaryMetrics.find((metric) => metric.key === key)!.display;
    const rail = (model: ReturnType<typeof hero>, key: string) => model.signalRailItems.find((item) => item.key === key);
    const superseded = hero({ coinStates: [{ kind: "depeg", deviationBps: -4500, ddrTier: null, ddrMethodologyVersion: null }] });
    expect(tile(superseded, "dews")).toMatchObject({ value: "Watch", sub: "Superseded by the live depeg", color: "text-muted-foreground" });
    expect(rail(superseded, "dews")?.href).toBe("#depeg-resolver");
    // A weak score keeps its tone; a withheld one reads NR.
    expect(rail(hero({ priceUnusable: true }), "peg")).toMatchObject({ primary: "95", secondary: "No usable price", colorClass: "text-muted-foreground" });
    expect(rail(hero({ priceUnusable: true, pegScoreResult: { ...pegScoreResult, pegScore: 60 } }), "peg")).toMatchObject({ secondary: "No usable price", colorClass: pegScoreColor(60) });
    expect(rail(hero({ priceUnusable: true, pegScoreResult: { ...pegScoreResult, pegScore: null, currentPriceUnavailable: true } }), "peg"))
      .toMatchObject({ primary: "NR", secondary: "No usable price" });
    // An inherited quote counts only against a closed exit; DEWS from under half its signals is no all-clear.
    const halted = { kind: "critical", notice: { type: "danger", title: "Initia L1 halted" } } as const;
    expect(tile(hero({ coinStates: [halted], priceInheritedFrom: "ausd-agora" }), "peg-score").sub).toBe("Price inherited from AUSD");
    expect(tile(hero({ priceInheritedFrom: "ausd-agora" }), "peg-score").sub).toBe("99.4% at peg");
    const dews = (signals: StressSignalEntry["signals"]) => tile(hero({ stressSignal: { ...stressSignal, signals } }), "dews");
    const [on, off] = [{ value: 31, available: true }, { value: 0, available: false }];
    expect(dews({ supply: on, flows: off })).toEqual(dews({ supply: on }));
    expect(dews({ supply: on, flows: off, yield: off })).toMatchObject({ sub: "1 of 3 signals", color: "text-muted-foreground" });
  });

  it("dates a frozen archive's figures instead of printing live-looking deltas", () => {
    const html = renderHero({ coin: { status: "frozen", frozenAt: "2026-04-27" } });
    expect(html.match(/Last observed · 2026-04-27/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toMatch(/24H|24h|7D|7d</);
  });

  it("keeps the case-study callout on one row at every width", () => {
    const html = renderHero();
    const callout = html.match(/<a[^>]*Read the case study[^>]*>/)![0].match(/class="([^"]*)"/)![1];
    expect(callout).toContain("flex items-center");
    expect(callout).not.toContain("flex-col");
    expect(html).toMatch(/class="line-clamp-2 min-w-0 [^"]*sm:line-clamp-1">[^<]+<\/span>/);
  });
});
