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
const clock = vi.hoisted(() => ({ nowMs: null as number | null }));
const portfolioFixture = vi.hoisted(() => ({ forceOpen: false, holdings: [] as Array<{ coinId: string; amount: number }> }));

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => hydration.hydrated }));
vi.mock("@/hooks/use-utc-day-clock", () => ({ useUtcDayNowMs: () => clock.nowMs }));
vi.mock("@/hooks/use-portfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-portfolio")>();
  return {
    ...actual,
    usePortfolio: (initialUrlParam?: string, urlReady?: boolean) => portfolioFixture.forceOpen
      ? { initialized: true, holdings: portfolioFixture.holdings, totalUsd: portfolioFixture.holdings.reduce((s, i) => s + i.amount, 0), isFromUrl: false, addCoin: vi.fn(), removeCoin: vi.fn(), setAmount: vi.fn(), clearAll: vi.fn(), shareUrl: vi.fn(() => "") }
      : actual.usePortfolio(initialUrlParam, urlReady),
  };
});
vi.mock("@/components/ui/popover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/popover")>();
  return {
    ...actual,
    Popover: (p: React.ComponentProps<typeof actual.Popover>) => portfolioFixture.forceOpen ? <div>{p.children}</div> : <actual.Popover {...p} />,
    PopoverTrigger: (p: React.ComponentProps<typeof actual.PopoverTrigger>) => portfolioFixture.forceOpen ? <>{p.children}</> : <actual.PopoverTrigger {...p} />,
    PopoverContent: (p: React.ComponentProps<typeof actual.PopoverContent>) => portfolioFixture.forceOpen ? <div>{p.children}</div> : <actual.PopoverContent {...p} />,
  };
});
vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());
vi.mock("@/lib/feature-flags", async (importOriginal) => ({ ...(await importOriginal<typeof FeatureFlags>()), isHeroVerdictEnabled: () => true }));
vi.mock("@/components/share-button", () => ({ ShareButton: ({ label }: { label?: string }) => <button type="button">{label ?? "Share"}</button> }));
vi.mock("@/components/stablecoin-logo", () => ({ StablecoinLogo: ({ name, size }: { name: string; size?: number }) => <span data-logo-size={size}>logo:{name}</span> }));
vi.mock("@/components/methodology-hint", () => ({
  MethodologyHint: ({ topic }: { topic: string }) => <span data-testid={`methodology-hint-${topic}`} />,
  MethodologyTriggerButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MethodologyLabel: ({ children, topic }: { children: React.ReactNode; topic: string }) => <span><span>{children}</span><span data-testid={`methodology-hint-${topic}`} /></span>,
}));

const coin: StablecoinMeta = {
  id: "usdc-circle", symbol: "USDC", name: "USD Coin",
  oneLiner: "Circle-issued dollar stablecoin backed by cash and short-duration reserves.",
  status: "active", infrastructures: ["liquity-v2"],
  links: [{ label: "Website", url: "https://www.circle.com/usdc" }, { label: "Twitter", url: "https://x.com/circle" }],
  flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
};
const eurCoin: StablecoinMeta = { ...coin, flags: { ...coin.flags, pegCurrency: "EUR" } };
const coinData: StablecoinData = {
  id: "usdc-circle", name: "USD Coin", symbol: "USDC", geckoId: "usd-coin", pegType: "peggedUSD", pegMechanism: "fiat-backed", listingClass: "core-stablecoin",
  price: 0.9998, priceSource: "coingecko", priceConfidence: "high", consensusSources: ["coingecko"], agreeSources: ["coingecko"],
  priceUpdatedAt: 1_700_000_000, priceObservedAt: 1_700_000_000, priceObservedAtMode: "upstream", priceSyncedAt: 1_700_000_000,
  supplySource: "defillama", circulating: { peggedUSD: 1_000_000_000 }, circulatingPrevDay: { peggedUSD: 995_000_000 },
  circulatingPrevWeek: { peggedUSD: 980_000_000 }, circulatingPrevMonth: { peggedUSD: 970_000_000 }, chainCirculating: {}, chains: ["ethereum", "base"],
};
const pegScoreResult: PegSummaryCoin = {
  id: "usdc-circle", symbol: "USDC", name: "USD Coin", pegType: "peggedUSD", pegCurrency: "USD", governance: "centralized",
  currentDeviationBps: -2, pegScore: 95, pegPct: 99.4, severityScore: 2, spreadPenalty: 0, eventCount: 2,
  worstDeviationBps: -20, trackingSpanDays: 365, activeDepeg: true, lastEventAt: 1_700_000_000, methodologyVersion: "3.2",
};
const liquidityData: DexLiquidityData = {
  totalTvlUsd: 125_000_000, totalVolume24hUsd: 250_000_000, totalVolume7dUsd: 1_500_000_000,
  poolCount: 24, pairCount: 24, chainCount: 3, protocolTvl: {}, chainTvl: {}, topPools: [],
  liquidityScore: 82, concentrationHhi: 0.2, depthStability: 0.92, tvlChange24h: null, tvlChange7d: null,
  updatedAt: 1_700_000_000, dexPriceUsd: null, dexDeviationBps: null, priceSourceCount: null, priceSourceTvl: null,
  priceSources: null, effectiveTvlUsd: 125_000_000, avgPoolStress: null, weightedBalanceRatio: null,
  organicFraction: null, durabilityScore: null, coverageClass: "primary", coverageConfidence: 1,
  liquidityEvidenceClass: "measured", hasMeasuredLiquidityEvidence: true, trendworthy: true, sourceMix: {},
  balanceMeasuredTvlUsd: 125_000_000, organicMeasuredTvlUsd: 125_000_000,
  scoreComponents: { tvlDepth: 80, volumeActivity: 75, poolQuality: 70, durability: 85, pairDiversity: 78 },
  lockedLiquidityPct: null, methodologyVersion: "test",
};
const reportCardWithInheritedBlacklistRisk = makeV9Card({ id: "usdc-circle", grade: "B+", score: 79, accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "upstream" } });
const reportCardWithDirectBlacklistRisk = makeV9Card({ id: "usdc-circle", grade: "B+", score: 79 });
const yieldRanking: YieldRanking = {
  id: "usdc-circle", symbol: "USDC", name: "USD Coin", currentApy: 4.8, apy7d: 4.7, apy30d: 4.6, apyBase: 4.6, apyReward: 0,
  yieldSource: "Circle Treasury", yieldSourceUrl: "https://example.com/yield", yieldType: "nav-appreciation", dataSource: "rate-derived",
  sourceTvlUsd: 1_000_000_000, pharosYieldScore: 70, safetyScore: 79, safetyGrade: "B+", yieldToRisk: 3.2, excessYield: 0.85,
  benchmarkKey: "USD", benchmarkLabel: "USD 3M T-Bill", benchmarkCurrency: "USD", benchmarkRate: 3.75, benchmarkRecordDate: "2026-04-21",
  benchmarkIsFallback: false, benchmarkFallbackMode: null, benchmarkSelectionMode: "native", benchmarkIsProxy: false,
  yieldStability: 0.92, apyVariance30d: 0.1, apyMin30d: 4.4, apyMax30d: 4.8, warningSignals: [], altSources: [], provenance: null,
};
const stressSignal: StressSignalEntry = { score: 31, band: "WATCH", signals: { supply: { value: 31, available: true } }, computedAt: 1_700_000_000, methodologyVersion: "v1" };
const verdict = { archetype: "institutional-default", label: "Institutional Default" } as const;

type HeroPriceProps = Parameters<typeof HeroPriceMetric>[0]["price"];
type HeroBuilderParams = Parameters<typeof buildStablecoinDetailHeroViewModel>[0];
type HeroBuilderOverrides = Partial<Omit<HeroBuilderParams, "coin" | "coinData">> & {
  coin?: Omit<Partial<StablecoinMeta>, "flags"> & { flags?: Partial<StablecoinMeta["flags"]> };
  coinData?: Partial<Omit<StablecoinData, keyof HeroBuilderParams["coinData"]>> & Partial<HeroBuilderParams["coinData"]>;
};

const priceState = (overrides: Partial<HeroPriceProps> = {}): HeroPriceProps => ({
  pegRef: 1, deviationBps: null, pegReferenceUnavailable: false, referenceNote: null, isNavToken: false, limitedDepegCoverageNote: null, caveat: null, ...overrides,
});

function makeHeroProps(overrides: HeroBuilderOverrides = {}): HeroBuilderParams {
  const { coin: coinOv, coinData: cdOv, ...rest } = overrides;
  return {
    coin: { ...coin, ...coinOv, flags: { ...coin.flags, ...coinOv?.flags } },
    coinData: { ...coinData, ...cdOv }, logoSrc: "/logos/usdc.svg", isNavToken: false,
    mcap: 1_000_000_000, supply: 1_000_000_000, prevDay: 995_000_000,
    nativeSupply: { current: 1_000_000_000, prevWeek: 980_000_000, prevMonth: 970_000_000 },
    performanceVsUsd1y: null, pegRef: 1, deviationBps: -2, pegReferenceUnavailable: false, referenceNote: null,
    pegScoreResult, liquidityData, yieldRanking, stressSignal, reportCard: reportCardWithDirectBlacklistRisk,
    verdict, resolvedMechanismArchetype: null, mintAuthority: { status: "not-reviewed" } as HeroBuilderParams["mintAuthority"],
    redemptionBackstop: null, ...rest,
  };
}

const buildHero = (overrides: HeroBuilderOverrides = {}) => buildStablecoinDetailHeroViewModel(makeHeroProps(overrides));
const renderHero = (overrides: HeroBuilderOverrides = {}) => {
  const model = buildHero(overrides);
  return renderToStaticMarkup(<><HeroIdentityHeader model={model} onOpenFeedback={() => {}} /><HeroCard model={model} /></>);
};
const renderPriceMetric = (
  variant: "card" | "cell",
  opts: { coin?: StablecoinMeta; coinData?: Partial<StablecoinData>; price?: Partial<HeroPriceProps> } = {},
) => renderToStaticMarkup(
  <HeroPriceMetric coin={opts.coin ?? coin} coinData={{ ...coinData, ...opts.coinData }} price={priceState(opts.price)} variant={variant} />,
);

describe("HeroCard", () => {
  it("renders current-relative 7D and 30D supply growth despite a lagged provider history", () => {
    const now = 1_790_793_000, day = 86_400;
    const summary = projectStablecoinLiveSummary({
      price: 1, priceSource: "coingecko", currentCirculatingUSD: { peggedUSD: 200 }, currentCirculatingNative: 200, currentSupplyObservedAt: now,
      tokens: [[33, 50], [30, 80], [10, 100], [7, 140], [3, 160]].map(([d, v]) => ({ date: now - d * day, totalCirculating: { peggedUSD: v } })),
    });
    const html = renderHero({ supply: 200, nativeSupply: summary.nativeSupply });
    expect(html).toContain("+42.86%");
    expect(html).toContain("+150.00%");
    expect(html).not.toContain("+100.00%");
    expect(html).toContain("7D");
    expect(html).toContain("30D");
    const unavailable = renderHero({ supply: 200, nativeSupply: { current: 200, prevWeek: null, prevMonth: null } });
    expect(unavailable).not.toContain("+100.00%");
    expect(unavailable).not.toContain("> 30D</span>");
  });

  it("labels restored and partial-coverage market cap neutrally and withholds false zeroes when unavailable", () => {
    const restored = renderHero({ coinData: { supplyRestored: true, supplyObservedAt: 1_700_000_000 } });
    expect(restored).toContain("Supply as of Nov 14");
    expect(restored).not.toContain("Stale supply");
    expect(restored).not.toMatch(/text-state-warn[^>]*>Supply as of/);
    expect(renderHero({ coinData: { supplyRestored: true, supplyObservedAt: null } })).toContain("Supply date unavailable");
    expect(renderHero({ coinData: { supplyRestored: false, supplyObservedAt: 1_700_000_000 } })).not.toContain("Supply as of");
    expect(renderHero({ coinData: { supplyExcludedChains: ["HyperEVM"] } })).toContain("Partial supply · excludes HyperEVM");
    expect(renderHero({ coinData: { supplyRestored: false } })).not.toContain("Partial supply");

    const missing = renderHero({ coinData: { circulating: {}, circulatingPrevDay: {} }, mcap: null, supply: null, prevDay: null, nativeSupply: null });
    expect(missing).not.toContain("$0.00");
    expect(missing).toMatch(/Market cap<\/p><p[^>]*>—<\/p>/);
    expect(missing).toMatch(/Supply<\/p><p[^>]*>—/);
  });

  it.each([
    { score: null, pools: 0, value: "—" },
    { score: null, pools: 3, value: "—" },
    { score: 0, pools: 3, value: "0" },
    { score: 82, pools: 3, value: "82" },
  ])("preserves liquidity availability for score $score with $pools pools", ({ score, pools, value }) => {
    const overrides = { liquidityData: { ...liquidityData, liquidityScore: score, poolCount: pools } };
    const model = buildHero(overrides);
    const metric = model.tertiaryMetrics.find((item) => item.key === "liquidity")!;
    expect([metric.display.value, metric.display.sub]).toEqual([value, `${pools} pools`]);
    expect(model.signalRailItems.find((item) => item.key === "liquidity")?.primary).toBe(value);
    if (score === null) expect(metric.display.color).toBe("text-muted-foreground");
    const html = renderHero(overrides);
    if (score === null) expect(html).not.toContain(">Liq<");
    else {
      expect(html).toContain(`${pools} pools`);
      expect(html.split(">Liq<")[1]).toContain(`>${value}<`);
    }
  });

  it("leaves missing liquidity unavailable and renders plain signal tiles without badges", () => {
    const missing = buildHero({ liquidityData: undefined }).tertiaryMetrics.find((i) => i.key === "liquidity")!;
    expect([missing.display.value, missing.display.sub]).toEqual(["—", undefined]);

    const tiles = renderHero({ liquidityData: { ...liquidityData, liquidityScore: 20 } }).split("Active depeg")[0]!.split(">DEWS<")[1]!;
    expect(tiles).toContain(">Watch<");
    expect(tiles).not.toContain('data-slot="badge"');
  });

  it.each(["low", "fallback"] as const)("shows published deviation for an observed %s quote", (priceConfidence) => {
    const html = renderHero({ coinData: { price: 1.02, priceConfidence }, deviationBps: -50 });
    expect(html).toContain(">-50</span> bps");
    expect(html).not.toContain("+200");
  });

  it("names closed reference markets unless overridden by NAV status", () => {
    expect(renderHero({ referenceNote: "Reference market closed", deviationBps: null })).toContain("Reference market closed");
    expect(renderHero({ referenceNote: "Reference market closed", deviationBps: null, isNavToken: true })).toContain("NAV token · no fixed peg");
  });

  it.each(["card", "cell"] as const)("renders %s HeroPriceMetric for unavailable, inherited, frozen, and EUR/USD fallback prices", (variant) => {
    expect(renderPriceMetric(variant, { coinData: { price: null, priceConfidence: null } })).toMatch(/>Price<\/p>.*<p[^>]*>N\/A<\/p>/);
    expect(renderPriceMetric(variant, { coinData: { price: null, priceConfidence: null } })).not.toContain("$0.0000");

    for (const price of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const html = renderPriceMetric(variant, { coinData: { price, priceConfidence: null }, price: { deviationBps: 1 } });
      expect(html).toContain("Observed price unavailable now");
      expect(html).not.toMatch(/\+1 BPS/i);
      expect(html).toContain("N/A");
    }
    const frozenMissing = renderPriceMetric(variant, { coin: { ...coin, status: "frozen", frozenAt: "2026-06-30" }, coinData: { price: null, priceConfidence: null } });
    expect(frozenMissing).toContain("Observed price unavailable");
    expect(frozenMissing).not.toContain("Observed price unavailable now");

    const inheritedAtPeg = renderPriceMetric(variant, { price: { deviationBps: -6, caveat: "Price inherited from AUSD" } });
    expect(inheritedAtPeg).toContain("Price inherited from AUSD");
    expect(inheritedAtPeg).not.toContain(deviationColorClass(6));
    expect(renderPriceMetric(variant, { price: { deviationBps: -300, caveat: "Price inherited from AUSD" } })).toContain(deviationColorClass(300));

    expect(renderPriceMetric(variant, { coin: { ...coin, status: "frozen", frozenAt: "2026-06-30" }, coinData: { price: 0.9997 } })).toContain("Last observed · 2026-06-30");

    const usdFallback = renderPriceMetric(variant, { coin: eurCoin, coinData: { price: 1.117990454919679 }, price: { pegRef: null } });
    expect(usdFallback).toContain("Price (USD)");
    expect(usdFallback).toContain("$1.1180");
    expect(usdFallback).not.toContain("Price (EUR)");

    const nativeEur = renderPriceMetric(variant, { coin: eurCoin, coinData: { price: 1.11 }, price: { pegRef: 1.11, deviationBps: 0 } });
    expect(nativeEur).toContain("Price (EUR)");
    expect(nativeEur).toContain("EUR 1.0000");
  });

  it("renders verification passport, inherited blacklist risk, NAV suppression, non-USD 1Y, limited coverage, and native supply trends", () => {
    const html = renderHero();
    for (const expected of ['aria-label="Verification passport"', "Mechanism", "RWA-Backed", "Jurisdiction", "Freezable — issuer can freeze, block, or seize balances", 'href="#blacklist"', "Chains", "Read the case study"]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain(">Blacklistable<");
    expect(html).not.toMatch(/Bluechip/i);

    const navHtml = renderHero({
      coin: { id: "dusd-dialectic", symbol: "DUSD", name: "Dialectic USD", flags: { backing: "crypto-backed", governance: "centralized-dependent", yieldBearing: true, rwa: false, navToken: true } },
      coinData: { id: "dusd-dialectic", symbol: "DUSD", name: "Dialectic USD", price: 1.035 },
      isNavToken: true, mcap: 1_035_000, supply: 1_000_000, prevDay: 1_000_000, deviationBps: 350, pegScoreResult: null, stressSignal: null,
      verdict: { archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" },
    });
    expect(navHtml).toContain("NAV token · no fixed peg");
    expect(navHtml.split("NAV token · no fixed peg")[0]!.slice(-160)).not.toContain("text-green");
    expect(navHtml).toContain("USD NAV");
    for (const forbidden of [">DEWS<", ">Peg<", "N/A", "+350", "peg-gauge:350"]) expect(navHtml).not.toContain(forbidden);

    const inheritedHtml = renderHero({
      coin: { id: "dai-makerdao", name: "Mock Inherited", symbol: "MCK", flags: { governance: "centralized-dependent" } },
      coinData: { id: "dai-makerdao", name: "Mock Inherited", symbol: "MCK" }, yieldRanking: null, stressSignal: null,
      reportCard: { ...reportCardWithInheritedBlacklistRisk, id: "dai-makerdao" },
    });
    expect(inheritedHtml).toContain(">Upstream risk<");
    expect(inheritedHtml).not.toContain("No issuer controls");

    const chfHtml = renderHero({
      coin: { id: "zchf-frankencoin", name: "Frankencoin", symbol: "ZCHF", flags: { pegCurrency: "CHF" } },
      coinData: { id: "zchf-frankencoin", name: "Frankencoin", symbol: "ZCHF", pegType: "peggedCHF", price: 1.12, circulating: { peggedCHF: 1e9 }, circulatingPrevDay: { peggedCHF: 995e6 }, circulatingPrevWeek: { peggedCHF: 980e6 }, circulatingPrevMonth: { peggedCHF: 970e6 } },
      performanceVsUsd1y: 12.34, pegRef: 1.12, reportCard: null,
    });
    expect(chfHtml).toContain("1Y vs USD");
    expect(chfHtml).toContain("+12.34%");
    expect(chfHtml).toContain("Market cap (USD)");
    expect(chfHtml).not.toContain("USD-normalized");

    expect(renderHero({ coinData: { price: 0.97, circulating: { peggedUSD: 500_000 } }, mcap: 500_000, supply: 500_000, prevDay: 495_000, deviationBps: -300, pegScoreResult: { ...pegScoreResult, activeDepeg: false, depegEventCoverageLimited: true }, reportCard: reportCardWithInheritedBlacklistRisk }))
      .toContain("Below $1.00M live-event floor. Deviation is shown, but event history may stay empty.");

    const goldHtml = renderHero({
      coin: { flags: { pegCurrency: "GOLD" } },
      coinData: { price: 4_140, circulating: { peggedGOLD: 3_345_120_000 }, circulatingPrevWeek: { peggedGOLD: 3_533_600_000 }, circulatingPrevMonth: { peggedGOLD: 2_731_000_000 } },
      mcap: 3_345_120_000, supply: 808_000, prevDay: null, nativeSupply: { current: 808_000, prevWeek: 800_000, prevMonth: 790_000 }, pegRef: 4_140, reportCard: null,
    });
    expect(goldHtml).toContain("808.00K");
    expect(goldHtml).toContain("+1.00%");
    expect(goldHtml).toContain("+2.28%");
    expect(goldHtml).not.toContain("-99.98%");

    const fundHtml = renderHero({
      coin: { id: "buidl-blackrock", name: "BlackRock USD Institutional Digital Liquidity Fund", symbol: "BUIDL" },
      coinData: { id: "buidl-blackrock", name: "BlackRock USD Institutional Digital Liquidity Fund", symbol: "BUIDL" },
    });
    expect(fundHtml).toContain("Tokenized fund — not a stablecoin");
    expect(fundHtml).toContain("Not counted in stablecoin totals and not Safety-graded");
    expect(html).not.toContain("Tokenized fund — not a stablecoin");
  });
});

describe("HeroIdentityHeader", () => {
  const renderHeader = (overrides: HeroBuilderOverrides = {}, gradeRead?: "settled" | "pending" | "failed") =>
    renderToStaticMarkup(<HeroIdentityHeader model={buildHero(overrides)} onOpenFeedback={() => {}} gradeRead={gradeRead} />);

  it("renders verdict separator, holder action bar, yield workbench pill, variant chip, and grade read states", () => {
    const header = renderHeader();
    expect(header.match(/<p class="[^"]*" data-safety-verdict-line="[^"]*">(.*?)<\/p>/)![1]).toContain(">\u00a0·\u00a0<");
    for (const s of [">Watch<", ">Portfolio<", ">Alerts<", 'aria-label="More compare options for', 'aria-label="More actions"']) expect(header).toContain(s);
    expect(header).toMatch(/<span class="truncate">(vs [^<]+|Compare)<\/span>/);

    const yieldHeader = renderHeader({ coin: CLIENT_TRACKED_META_BY_ID.get("susde-ethena")! });
    expect(yieldHeader).toContain(">Yield workbench<");
    expect(yieldHeader).toContain('href="/stablecoin/susde-ethena/yield/"');
    expect(renderHeader({ coin: CLIENT_TRACKED_META_BY_ID.get("usdc-circle")! })).not.toContain(">Yield workbench<");

    expect(renderHeader({ variantParent: CLIENT_TRACKED_META_BY_ID.get("usde-ethena")!, variantKind: "savings-passthrough" })).toContain("Wraps Ethena USDe");
    expect(renderHeader({ reportCard: null }, "failed")).toContain("Grade unavailable");
    expect(renderHeader({ reportCard: null }, "pending")).toContain('aria-label="Loading Safety Score"');
    expect(renderHeader({ reportCard: null })).not.toContain("Grade unavailable");
  });

  it("hydrates initialRedeemability without a passport reserve placeholder", () => {
    const model = buildHero({ pendingReads: { redemption: true }, redemptionBackstop: null });
    const html = renderToStaticMarkup(<HeroCard model={model} initialRedeemability={{ key: "redeemability", category: "Redeemability", value: "Issuer API", href: "#redemption", ariaLabel: "Redeemability: Issuer API - jump to redemption route" }} />);
    expect(html).toContain("Issuer API");
    expect(html).not.toContain('data-passport-reserve="redeemability"');
  });

  it("stamps snapshot age only after hydration and preserves coin context on Portfolio popover Open link", () => {
    const model = buildHero();
    const now = Date.parse("2026-10-21T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const renderStamp = (updatedAtMs: number, daily?: boolean) =>
      renderToStaticMarkup(<HeroIdentityHeader model={model} onOpenFeedback={() => {}} updatedAtMs={updatedAtMs} dailySnapshot={daily} />);
    try {
      const prerender = renderStamp(now - 12 * 60_000);
      expect(prerender.match(/Updated —/g)).toHaveLength(1);
      hydration.hydrated = true;
      const markup = renderStamp(now - 12 * 60_000);
      expect(markup.match(/Updated 12m ago/g)).toHaveLength(1);
      expect(prerender.replaceAll("Updated —", "Updated 12m ago")).toBe(markup);
      expect(markup).not.toMatch(/amber|text-warning/);
      expect(renderStamp(0)).not.toContain("Updated");
      expect(renderStamp(now, true)).toContain("Daily snapshot of Oct 21, 2026");

      portfolioFixture.forceOpen = true;
      portfolioFixture.holdings = [];
      expect(renderHeader()).toContain('href="/portfolio/?coins=usdc-circle"');
      portfolioFixture.holdings = [{ coinId: "usdt-tether", amount: 5000 }];
      expect(renderHeader()).toContain('href="/portfolio/?p=usdt-tether%3A5000%2Cusdc-circle%3A0"');
      portfolioFixture.holdings = [{ coinId: "usdc-circle", amount: 10000 }];
      const heldHeader = renderHeader();
      expect(heldHeader).toContain('href="/portfolio/"');
      expect(heldHeader).not.toMatch(/\/portfolio\/\?(coins|p)=/);
      expect(heldHeader).toContain("/subscribe dews, depeg, safety usdc-circle");

      const navStable = renderHeader({ coin: { id: "susde-ethena", name: "Staked USDe", symbol: "sUSDe", flags: { navToken: true, yieldBearing: true } } });
      expect(navStable).toContain("/subscribe safety susde-ethena");
      expect(navStable).not.toContain("/subscribe dews");

      const buidlFund = renderHeader({ coin: { id: "buidl-blackrock", name: "BUIDL", symbol: "BUIDL", flags: { navToken: false } } });
      expect(buidlFund).toContain("/subscribe dews, depeg buidl-blackrock");
      expect(buidlFund).not.toContain("safety buidl-blackrock");

      const reserveFund = renderHeader({
        coin: { id: "reusd-re-protocol", name: "Re USD", symbol: "reUSD", flags: { navToken: true }, reserveDriftAlertEligible: true } as HeroBuilderOverrides["coin"],
      });
      expect(reserveFund).toContain("/subscribe reserve reusd-re-protocol");
      expect(reserveFund).toContain("live reserve-mix drift alerts");
      expect(reserveFund).not.toContain("/subscribe dews");

      const navFundNoAlerts = renderHeader({ coin: { id: "usyc-hashnote", name: "USYC", symbol: "USYC", flags: { navToken: true } } });
      expect(navFundNoAlerts).not.toContain("/subscribe dews");
      expect(navFundNoAlerts).not.toContain(">Alerts<");
    } finally {
      portfolioFixture.forceOpen = false;
      portfolioFixture.holdings = [];
      hydration.hydrated = false;
      vi.restoreAllMocks();
    }
  });
});

describe("HeroSupplyMetric, fourth figure, verdict, notices, and muted readings", () => {
  const ratioMetric = { key: "backing-ratio", label: "Collateralization", value: "209.5%", subValue: "vs debt", colorClass: "text-foreground" };

  it("renders em dashes for unavailable supply deltas and selects the fourth figure by precedence", () => {
    const supplyMarkup = renderToStaticMarkup(<HeroSupplyMetric supply={1_000} coinSymbol="USDT" supplyTrend={{ current: 1_000, safePrevWeek: null, safePrevMonth: null, hasPrevMonth: true, prevWeekTrendClass: "text-muted-foreground", prevMonthTrendClass: "text-muted-foreground" }} />);
    expect(supplyMarkup).toContain("30D");
    expect(supplyMarkup.match(/—/g)).toHaveLength(2);

    const mechHtml = renderToStaticMarkup(<HeroCard model={buildHero()} keyMetric={ratioMetric} />);
    expect(mechHtml).toContain("Collateralization");
    expect(mechHtml).toContain("209.5%");
    expect(mechHtml).not.toContain("30d Excess");

    const nonUsdHtml = renderToStaticMarkup(<HeroCard model={buildHero({ coin: { flags: { pegCurrency: "CHF" } }, performanceVsUsd1y: -6.2 })} keyMetric={{ ...ratioMetric, railTwin: true }} />);
    expect(nonUsdHtml).toContain("1Y vs USD");
    expect(nonUsdHtml).not.toContain("209.5%");

    const yieldHtml = renderToStaticMarkup(<HeroCard model={buildHero({ coin: { flags: { yieldBearing: true } } })} keyMetric={ratioMetric} />);
    expect(yieldHtml).toContain("30d Excess");
    expect(yieldHtml).not.toContain("209.5%");
  });

  it("states the grade's one reason: binding cap, then peg multiplier, else weakest pillar", () => {
    const cap = { kind: "track-record", source: "track-record", binding: true, limit: 84, reason: "Less than two years of known implementation history." };
    expect(buildSafetyVerdictLine(makeV9Card({ score: 84, bindingCap: cap as never }))).toEqual({ lead: "Capped at 84", detail: "Less than two years of known implementation history" });
    expect(buildSafetyVerdictLine(makeV9Card({ score: 26, qualityScore: 52, pegMultiplier: 0.51, pegAdjustedScore: 26 }))).toEqual({ lead: "Peg performance", detail: "x0.510 on pillar quality 52/100" });
    expect(buildSafetyVerdictLine(makeV9Card({ score: 85, qualityScore: 85, pegMultiplier: 1, pegAdjustedScore: 84.7 }))).toEqual({ lead: "Weakest pillar", detail: "Backing 83/100" });
    expect(buildSafetyVerdictLine(null)).toBeNull();
  });

  it("renders every notice in one grammar and dates frozen archive figures", () => {
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
    expect(markup).not.toContain("Deadline · Action may be needed");
    expect(markup).toMatch(/data-notice-deadline="2026-11-26"[^>]*>Nov 26, 2026</);
    expect(markup).toContain("Updated Oct 30, 2026");
    expect(markup).toMatch(/href="https:\/\/example.com\/a"[^>]*>More details/);
    expect(markup.split("Caveat")[1]!.split("<details")[0]).not.toMatch(/Action may be needed|Notice</);
    expect(markup).toMatch(/<details[^>]*>.*Past event: Exploit repaid/s);

    const today = Date.parse("2026-11-17T12:00:00Z");
    clock.nowMs = today;
    const clocked = renderToStaticMarkup(<NoticeStack notices={notices} />);
    clock.nowMs = null;
    expect(clocked.match(/Action may be needed/g)).toHaveLength(2);
    expect(clocked).toMatch(/<details[^>]*>.*Deadline passed Jul 15, 2026: Market closed/s);
    const lead = (nowSec?: number) => placeCoinNotices(notices, { liveDepeg: true, nowSec }).critical.map((n) => n.title);
    expect([lead(), lead(today / 1000)]).toEqual([["L1 halted", "Market closed", "Peg broken"], ["L1 halted", "Peg broken"]]);
    expect(renderToStaticMarkup(<NoticeStack archive notices={[notices[0]]} />)).not.toMatch(/Action may be needed|state-danger/);
    expect(renderToStaticMarkup(<NoticeStack notices={[]} />)).toBe("");

    const frozen = renderHero({ coin: { status: "frozen", frozenAt: "2026-04-27" } });
    expect(frozen.match(/Last observed · 2026-04-27/g)?.length).toBeGreaterThanOrEqual(4);
    expect(frozen).not.toMatch(/24H|24h|7D|7d</);
  });

  it("mutes Peg and DEWS readings that cannot read calm", () => {
    const tile = (model: ReturnType<typeof buildHero>, key: string) => model.tertiaryMetrics.find((m) => m.key === key)!.display;
    const rail = (model: ReturnType<typeof buildHero>, key: string) => model.signalRailItems.find((i) => i.key === key);
    const superseded = buildHero({ coinStates: [{ kind: "depeg", deviationBps: -4500, ddrTier: null, ddrMethodologyVersion: null }] });
    expect(tile(superseded, "dews")).toMatchObject({ value: "Watch", sub: "Superseded by the live depeg", color: "text-muted-foreground" });
    expect(rail(superseded, "dews")?.href).toBe("#depeg-resolver");
    expect(rail(buildHero({ priceUnusable: true }), "peg")).toMatchObject({ primary: "95", secondary: "No usable price", colorClass: "text-muted-foreground" });
    expect(rail(buildHero({ priceUnusable: true, pegScoreResult: { ...pegScoreResult, pegScore: 60 } }), "peg")).toMatchObject({ secondary: "No usable price", colorClass: pegScoreColor(60) });
    expect(rail(buildHero({ priceUnusable: true, pegScoreResult: { ...pegScoreResult, pegScore: null, currentPriceUnavailable: true } }), "peg")).toMatchObject({ primary: "NR", secondary: "No usable price" });

    const halted = { kind: "critical", notice: { type: "danger", title: "Initia L1 halted" } } as const;
    expect(tile(buildHero({ coinStates: [halted], priceInheritedFrom: "ausd-agora" }), "peg-score").sub).toBe("Price inherited from AUSD");
    expect(tile(buildHero({ priceInheritedFrom: "ausd-agora" }), "peg-score").sub).toBe("99.4% at peg");
    const dews = (signals: StressSignalEntry["signals"]) => tile(buildHero({ stressSignal: { ...stressSignal, signals } }), "dews");
    const [on, off] = [{ value: 31, available: true }, { value: 0, available: false }];
    expect(dews({ supply: on, flows: off })).toEqual(dews({ supply: on }));
    expect(dews({ supply: on, flows: off, yield: off })).toMatchObject({ sub: "1 of 3 signals", color: "text-muted-foreground" });
  });
});
