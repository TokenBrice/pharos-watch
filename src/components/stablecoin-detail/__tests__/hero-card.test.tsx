// @vitest-environment jsdom

import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as toHtml } from "react-dom/server";
import { HeroCard, HeroIdentityHeader } from "@/components/stablecoin-detail/hero-card";
import { HeroPriceMetric, HeroSupplyMetric } from "@/components/stablecoin-detail/hero-card-metrics";
import { deviationColorClass, pegScoreColor } from "@/lib/severity-colors";
import { buildStablecoinDetailHeroViewModel } from "@/lib/stablecoin-detail-view-model";
import { buildSafetyVerdictLine } from "@/lib/stablecoin-detail-hero-metrics";
import { NoticeStack, placeCoinNotices } from "@/components/coin-notice";
import { CLIENT_TRACKED_META_BY_ID as CLIENT_META } from "@shared/lib/stablecoins/client-registry";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import type * as FeatureFlags from "@/lib/feature-flags";
import type { StablecoinData } from "@shared/types/supply";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { CoinNotice } from "@shared/types/stablecoin-meta-primitives";
import type { StressSignalEntry } from "@shared/types/stress";

const hydration = vi.hoisted(() => ({ hydrated: false }));
const clock = vi.hoisted(() => ({ nowMs: null as number | null }));
const pf = vi.hoisted(() => ({ open: false, holdings: [] as Array<{ coinId: string; amount: number }> }));

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => hydration.hydrated }));
vi.mock("@/hooks/use-utc-day-clock", () => ({ useUtcDayNowMs: () => clock.nowMs }));
vi.mock("@/hooks/use-portfolio", async (orig) => {
  const a = await orig<typeof import("@/hooks/use-portfolio")>();
  return { ...a, usePortfolio: (u?: string, r?: boolean) => pf.open ? { initialized: true, holdings: pf.holdings, totalUsd: pf.holdings.reduce((s, i) => s + i.amount, 0), isFromUrl: false, addCoin: vi.fn(), removeCoin: vi.fn(), setAmount: vi.fn(), clearAll: vi.fn(), shareUrl: vi.fn(() => "") } : a.usePortfolio(u, r) };
});
vi.mock("@/components/ui/popover", async (orig) => {
  const a = await orig<typeof import("@/components/ui/popover")>();
  return {
    ...a,
    Popover: (p: React.ComponentProps<typeof a.Popover>) => pf.open ? <div>{p.children}</div> : <a.Popover {...p} />,
    PopoverTrigger: (p: React.ComponentProps<typeof a.PopoverTrigger>) => pf.open ? <>{p.children}</> : <a.PopoverTrigger {...p} />,
    PopoverContent: (p: React.ComponentProps<typeof a.PopoverContent>) => pf.open ? <div>{p.children}</div> : <a.PopoverContent {...p} />,
  };
});
vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());
vi.mock("@/lib/feature-flags", async (orig) => ({ ...(await orig<typeof FeatureFlags>()), isHeroVerdictEnabled: () => true }));
vi.mock("@/components/share-button", () => ({ ShareButton: ({ label }: { label?: string }) => <button type="button">{label ?? "Share"}</button> }));
vi.mock("@/components/stablecoin-logo", () => ({ StablecoinLogo: ({ name, size }: { name: string; size?: number }) => <span data-logo-size={size}>logo:{name}</span> }));
vi.mock("@/components/methodology-hint", () => ({
  MethodologyHint: ({ topic }: { topic: string }) => <span data-testid={`methodology-hint-${topic}`} />,
  MethodologyTriggerButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MethodologyLabel: ({ children, topic }: { children: React.ReactNode; topic: string }) => <span><span>{children}</span><span data-testid={`methodology-hint-${topic}`} /></span>,
}));

const T0 = 1_700_000_000;
const coin: StablecoinMeta = {
  id: "usdc-circle", symbol: "USDC", name: "USD Coin",
  oneLiner: "Circle-issued dollar stablecoin backed by cash and short-duration reserves.",
  status: "active", infrastructures: ["liquity-v2"],
  links: [{ label: "Website", url: "https://www.circle.com/usdc" }, { label: "Twitter", url: "https://x.com/circle" }],
  flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
};
const eurCoin: StablecoinMeta = { ...coin, flags: { ...coin.flags, pegCurrency: "EUR" } };
const coinData = makeStablecoin({
  price: 0.9998, priceSource: "coingecko", priceConfidence: "high", consensusSources: ["coingecko"],
  circulating: { peggedUSD: 1e9 }, circulatingPrevDay: { peggedUSD: 995e6 }, circulatingPrevWeek: { peggedUSD: 980e6 }, circulatingPrevMonth: { peggedUSD: 970e6 }, chains: ["ethereum", "base"],
});
const pegRes = makePegSummaryCoin({ currentDeviationBps: -2, pegPct: 99.4, severityScore: 2, eventCount: 2, worstDeviationBps: -20, activeDepeg: true, lastEventAt: T0, methodologyVersion: "3.2" });
const liqData = makeDexLiquidityData({ totalTvlUsd: 125e6, totalVolume24hUsd: 250e6, poolCount: 24, liquidityScore: 82, updatedAt: T0, coverageClass: "primary", hasMeasuredLiquidityEvidence: true });
const directCard = makeV9Card({ id: "usdc-circle", grade: "B+", score: 79 });
const inheritedCard = makeV9Card({ id: "usdc-circle", grade: "B+", score: 79, accessPosture: { ...directCard.accessPosture, freezeExposure: "upstream" } });
const yieldRank = makeYieldRanking({ currentApy: 4.8, apy7d: 4.7, apy30d: 4.6, excessYield: 0.85, provenance: null });
const stressSig: StressSignalEntry = { score: 31, band: "WATCH", signals: { supply: { value: 31, available: true } }, computedAt: T0, methodologyVersion: "v1" };
const verdict = { archetype: "institutional-default", label: "Institutional Default" } as const;

type HeroPriceProps = Parameters<typeof HeroPriceMetric>[0]["price"];
type HeroParams = Parameters<typeof buildStablecoinDetailHeroViewModel>[0];
type HeroOv = Partial<Omit<HeroParams, "coin" | "coinData">> & {
  coin?: Omit<Partial<StablecoinMeta>, "flags"> & { flags?: Partial<StablecoinMeta["flags"]> };
  coinData?: Partial<Omit<StablecoinData, keyof HeroParams["coinData"]>> & Partial<HeroParams["coinData"]>;
};

const priceState = (ov: Partial<HeroPriceProps> = {}): HeroPriceProps => ({
  pegRef: 1, deviationBps: null, pegReferenceUnavailable: false, referenceNote: null, isNavToken: false, limitedDepegCoverageNote: null, caveat: null, ...ov,
});

const buildHero = (ov: HeroOv = {}) => {
  const { coin: cOv, coinData: cdOv, ...rest } = ov;
  return buildStablecoinDetailHeroViewModel({
    coin: { ...coin, ...cOv, flags: { ...coin.flags, ...cOv?.flags } }, coinData: { ...coinData, ...cdOv },
    logoSrc: "/logos/usdc.svg", isNavToken: false, mcap: 1e9, supply: 1e9, prevDay: 995e6,
    nativeSupply: { current: 1e9, prevWeek: 980e6, prevMonth: 970e6 }, performanceVsUsd1y: null,
    pegRef: 1, deviationBps: -2, pegReferenceUnavailable: false, referenceNote: null,
    pegScoreResult: pegRes, liquidityData: liqData, yieldRanking: yieldRank, stressSignal: stressSig,
    reportCard: directCard, verdict, resolvedMechanismArchetype: null,
    mintAuthority: { status: "not-reviewed" } as HeroParams["mintAuthority"], redemptionBackstop: null, ...rest,
  });
};
const renderHero = (ov: HeroOv = {}) => { const m = buildHero(ov); return toHtml(<><HeroIdentityHeader model={m} onOpenFeedback={() => {}} /><HeroCard model={m} /></>); };
const renderPrice = (variant: "card" | "cell", opts: { coin?: StablecoinMeta; coinData?: Partial<StablecoinData>; price?: Partial<HeroPriceProps> } = {}) =>
  toHtml(<HeroPriceMetric coin={opts.coin ?? coin} coinData={{ ...coinData, ...opts.coinData }} price={priceState(opts.price)} variant={variant} />);
const has = (html: string, ...parts: string[]) => { for (const p of parts) expect(html).toContain(p); };
const lacks = (html: string, ...parts: string[]) => { for (const p of parts) expect(html).not.toContain(p); };

describe("HeroCard", () => {
  it("renders current-relative 7D and 30D supply growth despite a lagged provider history", () => {
    const now = 1_790_793_000;
    const summary = projectStablecoinLiveSummary({
      price: 1, priceSource: "coingecko", currentCirculatingUSD: { peggedUSD: 200 }, currentCirculatingNative: 200, currentSupplyObservedAt: now,
      tokens: [[33, 50], [30, 80], [10, 100], [7, 140], [3, 160]].map(([d, v]) => ({ date: now - d * 86_400, totalCirculating: { peggedUSD: v } })),
    });
    const html = renderHero({ supply: 200, nativeSupply: summary.nativeSupply });
    has(html, "+42.86%", "+150.00%", "7D", "30D");
    lacks(html, "+100.00%");
    lacks(renderHero({ supply: 200, nativeSupply: { current: 200, prevWeek: null, prevMonth: null } }), "+100.00%", "> 30D</span>");
  });

  it("labels restored and partial-coverage market cap neutrally and withholds false zeroes when unavailable", () => {
    const sup = (cd: HeroOv["coinData"]) => renderHero({ coinData: cd });
    const restored = sup({ supplyRestored: true, supplyObservedAt: T0 });
    has(restored, "Supply as of Nov 14");
    lacks(restored, "Stale supply");
    expect(restored).not.toMatch(/text-state-warn[^>]*>Supply as of/);
    has(sup({ supplyRestored: true, supplyObservedAt: null }), "Supply date unavailable");
    lacks(sup({ supplyRestored: false, supplyObservedAt: T0 }), "Supply as of");
    has(sup({ supplyExcludedChains: ["HyperEVM"] }), "Partial supply · excludes HyperEVM");
    lacks(sup({ supplyRestored: false }), "Partial supply");

    const missing = renderHero({ coinData: { circulating: {}, circulatingPrevDay: {} }, mcap: null, supply: null, prevDay: null, nativeSupply: null });
    lacks(missing, "$0.00");
    expect(missing).toMatch(/Market cap<\/p><p[^>]*>—<\/p>/);
    expect(missing).toMatch(/Supply<\/p><p[^>]*>—/);
  });

  it.each([[null, 0, "—"], [null, 3, "—"], [0, 3, "0"], [82, 3, "82"]] as const)(
    "preserves liquidity availability for score %s with %s pools",
    (score, pools, value) => {
      const ov = { liquidityData: { ...liqData, liquidityScore: score, poolCount: pools } };
      const m = buildHero(ov), metric = m.tertiaryMetrics.find((i) => i.key === "liquidity")!;
      expect([metric.display.value, metric.display.sub, m.signalRailItems.find((i) => i.key === "liquidity")?.primary]).toEqual([value, `${pools} pools`, value]);
      if (score === null) expect(metric.display.color).toBe("text-muted-foreground");
      const html = renderHero(ov);
      if (score === null) lacks(html, ">Liq<");
      else { has(html, `${pools} pools`); has(html.split(">Liq<")[1]!, `>${value}<`); }
    },
  );

  it("leaves missing liquidity unavailable and renders plain signal tiles without badges", () => {
    const missing = buildHero({ liquidityData: undefined }).tertiaryMetrics.find((i) => i.key === "liquidity")!;
    expect([missing.display.value, missing.display.sub]).toEqual(["—", undefined]);
    const tiles = renderHero({ liquidityData: { ...liqData, liquidityScore: 20 } }).split("Active depeg")[0]!.split(">DEWS<")[1]!;
    has(tiles, ">Watch<");
    lacks(tiles, 'data-slot="badge"');
  });

  it.each(["low", "fallback"] as const)("shows published deviation for an observed %s quote", (priceConfidence) => {
    const html = renderHero({ coinData: { price: 1.02, priceConfidence }, deviationBps: -50 });
    has(html, ">-50</span> bps");
    lacks(html, "+200");
  });

  it("names closed reference markets unless overridden by NAV status", () => {
    has(renderHero({ referenceNote: "Reference market closed", deviationBps: null }), "Reference market closed");
    has(renderHero({ referenceNote: "Reference market closed", deviationBps: null, isNavToken: true }), "NAV token · no fixed peg");
  });

  it.each(["card", "cell"] as const)("renders %s HeroPriceMetric for unavailable, inherited, frozen, and EUR/USD fallback prices", (variant) => {
    const rp = (o: Parameters<typeof renderPrice>[1]) => renderPrice(variant, o);
    const missing = rp({ coinData: { price: null, priceConfidence: null } });
    expect(missing).toMatch(/>Price<\/p>.*<p[^>]*>N\/A<\/p>/);
    lacks(missing, "$0.0000");

    for (const price of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const html = rp({ coinData: { price, priceConfidence: null }, price: { deviationBps: 1 } });
      has(html, "Observed price unavailable now", "N/A");
      expect(html).not.toMatch(/\+1 BPS/i);
    }
    const frozenCoin: StablecoinMeta = { ...coin, status: "frozen", frozenAt: "2026-06-30" };
    const frozenMissing = rp({ coin: frozenCoin, coinData: { price: null, priceConfidence: null } });
    has(frozenMissing, "Observed price unavailable");
    lacks(frozenMissing, "Observed price unavailable now");

    const caveat = "Price inherited from AUSD";
    const inheritedAtPeg = rp({ price: { deviationBps: -6, caveat } });
    has(inheritedAtPeg, caveat);
    lacks(inheritedAtPeg, deviationColorClass(6));
    has(rp({ price: { deviationBps: -300, caveat } }), deviationColorClass(300));
    has(rp({ coin: frozenCoin, coinData: { price: 0.9997 } }), "Last observed · 2026-06-30");

    const usdFallback = rp({ coin: eurCoin, coinData: { price: 1.117990454919679 }, price: { pegRef: null } });
    has(usdFallback, "Price (USD)", "$1.1180");
    lacks(usdFallback, "Price (EUR)");
    has(rp({ coin: eurCoin, coinData: { price: 1.11 }, price: { pegRef: 1.11, deviationBps: 0 } }), "Price (EUR)", "EUR 1.0000");
  });

  it("renders verification passport, inherited blacklist risk, NAV suppression, non-USD 1Y, limited coverage, and native supply trends", () => {
    const html = renderHero();
    has(html, 'aria-label="Verification passport"', "Mechanism", "RWA-Backed", "Jurisdiction", "Freezable — issuer can freeze, block, or seize balances", 'href="#blacklist"', "Chains", "Read the case study");
    lacks(html, ">Blacklistable<", "Tokenized fund — not a stablecoin");
    expect(html).not.toMatch(/Bluechip/i);

    const navId = { id: "dusd-dialectic", symbol: "DUSD", name: "Dialectic USD" };
    const navHtml = renderHero({
      coin: { ...navId, flags: { backing: "crypto-backed", governance: "centralized-dependent", yieldBearing: true, rwa: false, navToken: true } },
      coinData: { ...navId, price: 1.035 }, isNavToken: true, mcap: 1_035_000, supply: 1_000_000, prevDay: 1_000_000, deviationBps: 350, pegScoreResult: null, stressSignal: null,
      verdict: { archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" },
    });
    has(navHtml, "NAV token · no fixed peg", "USD NAV");
    lacks(navHtml.split("NAV token · no fixed peg")[0]!.slice(-160), "text-green");
    lacks(navHtml, ">DEWS<", ">Peg<", "N/A", "+350", "peg-gauge:350");

    const inhId = { id: "dai-makerdao", name: "Mock Inherited", symbol: "MCK" };
    const inhHtml = renderHero({ coin: { ...inhId, flags: { governance: "centralized-dependent" } }, coinData: inhId, yieldRanking: null, stressSignal: null, reportCard: { ...inheritedCard, id: "dai-makerdao" } });
    has(inhHtml, ">Upstream risk<");
    lacks(inhHtml, "No issuer controls");

    const chfId = { id: "zchf-frankencoin", name: "Frankencoin", symbol: "ZCHF" };
    const chfHtml = renderHero({
      coin: { ...chfId, flags: { pegCurrency: "CHF" } },
      coinData: { ...chfId, pegType: "peggedCHF", price: 1.12, circulating: { peggedCHF: 1e9 }, circulatingPrevDay: { peggedCHF: 995e6 }, circulatingPrevWeek: { peggedCHF: 980e6 }, circulatingPrevMonth: { peggedCHF: 970e6 } },
      performanceVsUsd1y: 12.34, pegRef: 1.12, reportCard: null,
    });
    has(chfHtml, "1Y vs USD", "+12.34%", "Market cap (USD)");
    lacks(chfHtml, "USD-normalized");

    has(renderHero({ coinData: { price: 0.97, circulating: { peggedUSD: 500_000 } }, mcap: 500_000, supply: 500_000, prevDay: 495_000, deviationBps: -300, pegScoreResult: { ...pegRes, activeDepeg: false, depegEventCoverageLimited: true }, reportCard: inheritedCard }), "Below $1.00M live-event floor. Deviation is shown, but event history may stay empty.");

    const goldHtml = renderHero({
      coin: { flags: { pegCurrency: "GOLD" } },
      coinData: { price: 4_140, circulating: { peggedGOLD: 3_345_120_000 }, circulatingPrevWeek: { peggedGOLD: 3_533_600_000 }, circulatingPrevMonth: { peggedGOLD: 2_731_000_000 } },
      mcap: 3_345_120_000, supply: 808_000, prevDay: null, nativeSupply: { current: 808_000, prevWeek: 800_000, prevMonth: 790_000 }, pegRef: 4_140, reportCard: null,
    });
    has(goldHtml, "808.00K", "+1.00%", "+2.28%");
    lacks(goldHtml, "-99.98%");

    const fundMeta = { id: "buidl-blackrock", name: "BlackRock USD Institutional Digital Liquidity Fund", symbol: "BUIDL" };
    has(renderHero({ coin: fundMeta, coinData: fundMeta }), "Tokenized fund — not a stablecoin", "Not counted in stablecoin totals and not Safety-graded");
  });
});

describe("HeroIdentityHeader", () => {
  const renderHdr = (ov: HeroOv = {}, gradeRead?: "settled" | "pending" | "failed") =>
    toHtml(<HeroIdentityHeader model={buildHero(ov)} onOpenFeedback={() => {}} gradeRead={gradeRead} />);

  it("renders verdict separator, holder action bar, yield workbench pill, variant chip, and grade read states", () => {
    const hdr = renderHdr();
    has(hdr.match(/<p class="[^"]*" data-safety-verdict-line="[^"]*">(.*?)<\/p>/)![1]!, ">\u00a0·\u00a0<");
    has(hdr, ">Watch<", ">Portfolio<", ">Alerts<", 'aria-label="More compare options for', 'aria-label="More actions"');
    expect(hdr).toMatch(/<span class="truncate">(vs [^<]+|Compare)<\/span>/);

    has(renderHdr({ coin: CLIENT_META.get("susde-ethena")! }), ">Yield workbench<", 'href="/stablecoin/susde-ethena/yield/"');
    lacks(renderHdr({ coin: CLIENT_META.get("usdc-circle")! }), ">Yield workbench<");
    has(renderHdr({ variantParent: CLIENT_META.get("usde-ethena")!, variantKind: "savings-passthrough" }), "Wraps Ethena USDe");
    has(renderHdr({ reportCard: null }, "failed"), "Grade unavailable");
    has(renderHdr({ reportCard: null }, "pending"), 'aria-label="Loading Safety Score"');
    lacks(renderHdr({ reportCard: null }), "Grade unavailable");
  });

  it("hydrates initialRedeemability without a passport reserve placeholder", () => {
    const html = toHtml(<HeroCard model={buildHero({ pendingReads: { redemption: true }, redemptionBackstop: null })} initialRedeemability={{ key: "redeemability", category: "Redeemability", value: "Issuer API", href: "#redemption", ariaLabel: "Redeemability: Issuer API - jump to redemption route" }} />);
    has(html, "Issuer API");
    lacks(html, 'data-passport-reserve="redeemability"');
  });

  it("stamps snapshot age only after hydration and preserves coin context on Portfolio popover Open link", () => {
    const model = buildHero(), now = Date.parse("2026-10-21T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const stamp = (updatedAtMs: number, daily?: boolean) => toHtml(<HeroIdentityHeader model={model} onOpenFeedback={() => {}} updatedAtMs={updatedAtMs} dailySnapshot={daily} />);
    try {
      const pre = stamp(now - 12 * 60_000);
      expect(pre.match(/Updated —/g)).toHaveLength(1);
      hydration.hydrated = true;
      const post = stamp(now - 12 * 60_000);
      expect(post.match(/Updated 12m ago/g)).toHaveLength(1);
      expect(pre.replaceAll("Updated —", "Updated 12m ago")).toBe(post);
      expect(post).not.toMatch(/amber|text-warning/);
      lacks(stamp(0), "Updated");
      has(stamp(now, true), "Daily snapshot of Oct 21, 2026");

      pf.open = true;
      pf.holdings = [];
      has(renderHdr(), 'href="/portfolio/?coins=usdc-circle"');
      pf.holdings = [{ coinId: "usdt-tether", amount: 5000 }];
      has(renderHdr(), 'href="/portfolio/?p=usdt-tether%3A5000%2Cusdc-circle%3A0"');
      pf.holdings = [{ coinId: "usdc-circle", amount: 10000 }];
      const held = renderHdr();
      has(held, 'href="/portfolio/"', "Follow USDC in Mini App", 'href="https://t.me/PharosWatchBot?startapp=coin_usdc-circle"', "/subscribe dews, depeg, safety USDC");
      expect(held).not.toMatch(/\/portfolio\/\?(coins|p)=/);

      const navStable = renderHdr({ coin: { id: "susde-ethena", name: "Staked USDe", symbol: "sUSDe", flags: { navToken: true, yieldBearing: true } } });
      has(navStable, "/subscribe safety sUSDe");
      lacks(navStable, "/subscribe dews");

      const buidl = renderHdr({ coin: { id: "buidl-blackrock", name: "BUIDL", symbol: "BUIDL", flags: { navToken: false } } });
      has(buidl, "/subscribe dews, depeg BUIDL");
      lacks(buidl, "safety BUIDL");

      const resFund = renderHdr({ coin: { id: "reusd-re-protocol", name: "Re USD", symbol: "reUSD", flags: { navToken: true }, reserveDriftAlertEligible: true } as HeroOv["coin"] });
      has(resFund, "/subscribe reserve reusd-re-protocol", "live reserve-mix drift alerts");
      lacks(resFund, "/subscribe dews");

      lacks(renderHdr({ coin: { id: "usyc-hashnote", name: "USYC", symbol: "USYC", flags: { navToken: true } } }), "/subscribe dews", ">Alerts<");
    } finally {
      pf.open = false;
      pf.holdings = [];
      hydration.hydrated = false;
      vi.restoreAllMocks();
    }
  });
});

describe("HeroSupplyMetric, fourth figure, verdict, notices, and muted readings", () => {
  const ratioMetric = { key: "backing-ratio", label: "Collateralization", value: "209.5%", subValue: "vs debt", colorClass: "text-foreground" };
  const cardWith = (ov: HeroOv = {}, km: React.ComponentProps<typeof HeroCard>["keyMetric"] = ratioMetric) => toHtml(<HeroCard model={buildHero(ov)} keyMetric={km} />);

  it("renders em dashes for unavailable supply deltas and selects the fourth figure by precedence", () => {
    const supplyHtml = toHtml(<HeroSupplyMetric supply={1_000} coinSymbol="USDT" supplyTrend={{ current: 1_000, safePrevWeek: null, safePrevMonth: null, hasPrevMonth: true, prevWeekTrendClass: "text-muted-foreground", prevMonthTrendClass: "text-muted-foreground" }} />);
    has(supplyHtml, "30D");
    expect(supplyHtml.match(/—/g)).toHaveLength(2);

    const mech = cardWith();
    has(mech, "Collateralization", "209.5%");
    lacks(mech, "30d Excess");

    const nonUsd = cardWith({ coin: { flags: { pegCurrency: "CHF" } }, performanceVsUsd1y: -6.2 }, { ...ratioMetric, railTwin: true });
    has(nonUsd, "1Y vs USD");
    lacks(nonUsd, "209.5%");

    const yieldHtml = cardWith({ coin: { flags: { yieldBearing: true } } });
    has(yieldHtml, "30d Excess");
    lacks(yieldHtml, "209.5%");
  });

  it("states the grade's one reason: binding cap, then peg multiplier, else weakest pillar", () => {
    const cap = { kind: "track-record", source: "track-record", binding: true, limit: 84, reason: "Less than two years of known implementation history." };
    const vLine = (ov: Parameters<typeof makeV9Card>[0]) => buildSafetyVerdictLine(makeV9Card(ov));
    expect(vLine({ score: 84, bindingCap: cap as never })).toEqual({ lead: "Capped at 84", detail: "Less than two years of known implementation history" });
    expect(vLine({ score: 26, qualityScore: 52, pegMultiplier: 0.51, pegAdjustedScore: 26 })).toEqual({ lead: "Peg performance", detail: "x0.510 on pillar quality 52/100" });
    expect(vLine({ score: 85, qualityScore: 85, pegMultiplier: 1, pegAdjustedScore: 84.7 })).toEqual({ lead: "Weakest pillar", detail: "Backing 83/100" });
    expect(buildSafetyVerdictLine(null)).toBeNull();
  });

  const n = (type: CoinNotice["type"], title: string, extra: Partial<CoinNotice> = {}): CoinNotice => ({ type, title, message: "M.", ...extra });

  it("renders every notice in one grammar and dates frozen archive figures", () => {
    const notices = [
      n("danger", "L1 halted", { message: "Read https://example.com/a first.", kind: "paused", asOf: "2026-10-30" }),
      n("warning", "Migration", { kind: "deadline", deadline: "2026-11-26" }),
      n("info", "Caveat"),
      n("warning", "Exploit repaid", { kind: "history" }),
      n("info", "Wound down", { kind: "deadline", deadline: "2026-11-01" }),
      n("danger", "Market closed", { kind: "deadline", deadline: "2026-07-15" }),
      n("danger", "Peg broken", { kind: "depeg" }),
    ];
    const markup = toHtml(<NoticeStack notices={notices} />);
    has(markup, "Paused now · Action may be needed", "Updated Oct 30, 2026");
    lacks(markup, "Deadline · Action may be needed");
    expect(markup).toMatch(/data-notice-deadline="2026-11-26"[^>]*>Nov 26, 2026</);
    expect(markup).toMatch(/href="https:\/\/example\.com\/a"[^>]*>More details/);
    expect(markup.split("Caveat")[1]!.split("<details")[0]).not.toMatch(/Action may be needed|Notice</);
    expect(markup).toMatch(/<details[^>]*>.*Past event: Exploit repaid/s);

    const today = Date.parse("2026-11-17T12:00:00Z");
    clock.nowMs = today;
    const clocked = toHtml(<NoticeStack notices={notices} />);
    clock.nowMs = null;
    expect(clocked.match(/Action may be needed/g)).toHaveLength(2);
    expect(clocked).toMatch(/<details[^>]*>.*Deadline passed Jul 15, 2026: Market closed/s);
    const lead = (nowSec?: number) => placeCoinNotices(notices, { liveDepeg: true, nowSec }).critical.map((x) => x.title);
    expect([lead(), lead(today / 1000)]).toEqual([["L1 halted", "Market closed", "Peg broken"], ["L1 halted", "Peg broken"]]);
    expect(toHtml(<NoticeStack archive notices={[notices[0]]} />)).not.toMatch(/Action may be needed|state-danger/);
    expect(toHtml(<NoticeStack notices={[]} />)).toBe("");

    const frozen = renderHero({ coin: { status: "frozen", frozenAt: "2026-04-27" } });
    expect(frozen.match(/Last observed · 2026-04-27/g)?.length).toBeGreaterThanOrEqual(4);
    expect(frozen).not.toMatch(/24H|24h|7D|7d</);
  });

  it("renders chain scope, sources, paused closing dates and prose-safe links, in a deterministic order", () => {
    const sUrl = (i: number) => `https://example.com/s${i}`, src = (i: number) => ({ label: `Source ${i}`, url: sUrl(i) });
    const notices = [
      n("info", "Info caveat", { message: "See (docs https://example.com/a_(b)). Then https://example.com/c, done.", sources: [src(1)] }),
      n("warning", "Late cutoff", { kind: "deadline", deadline: "2027-01-12", chains: ["noble"], asOf: "2026-11-20", sources: [src(1), src(2)] }),
      n("warning", "Standing caveat", { chains: ["noble", "abstract", "sophon"], sources: [src(1), src(2), src(3)] }),
      n("warning", "Exploit repaid", { kind: "history", sources: [src(4)] }),
      n("warning", "Early cutoff", { kind: "deadline", deadline: "2026-12-15", chains: ["abstract"] }),
      n("warning", "Deposits paused", { kind: "paused", deadline: "2026-01-01" }),
      n("warning", "Withdrawals paused", { kind: "paused", deadline: "2027-01-31" }),
    ];
    clock.nowMs = Date.parse("2026-11-26T12:00:00Z");
    try {
      const placed = placeCoinNotices(notices, { nowSec: clock.nowMs / 1000 });
      expect([placed.critical, placed.paused, placed.rest].map((g) => g.map((x) => x.title))).toEqual([
        [], ["Deposits paused", "Withdrawals paused"], ["Early cutoff", "Late cutoff", "Standing caveat", "Info caveat", "Exploit repaid"],
      ]);
      const view = within(render(<NoticeStack notices={[...placed.paused, ...placed.rest]} />).container);
      const callout = (t: string) => within(view.getByText(t).closest("p")!.parentElement!);
      const hrefs = (links: HTMLElement[]) => links.map((l) => l.getAttribute("href"));
      const [info, late, stand] = ["Info caveat", "Late cutoff", "Standing caveat"].map(callout);

      for (const [k, txt] of [["Deposits paused", "Paused now · Action may be needed"], ["Withdrawals paused", "Closes Jan 31, 2027 · in 66 days"], ["Deposits paused", "Closed Jan 1, 2026"], ["Late cutoff", "Noble only"], ["Info caveat", "Source:"]] as const) expect(callout(k).getByText(txt)).toBeTruthy();
      expect(view.queryByText(/Passed/)).toBeNull();
      expect(["Noble", "Abstract"].map((x) => stand.getByText(x))).toHaveLength(2);
      expect(stand.getByTitle("Sophon").textContent).toBe("+1: Sophon");
      const details = info.getAllByRole("link", { name: "More details" });
      expect([hrefs(details), details[0]!.closest("p")!.textContent]).toEqual([["https://example.com/a_(b)", "https://example.com/c"], "See (docs More details). Then More details, done."]);

      const lateFooterEl = late.getByText("Sources:").closest("[data-notice-footer]") as HTMLElement;
      const lateFooter = within(lateFooterEl), lateLinks = lateFooter.getAllByRole("link");
      expect(lateFooter.getByText("Updated Nov 20, 2026")).toBeTruthy();
      expect([hrefs(lateLinks), lateLinks.map((l) => [l.getAttribute("target"), l.getAttribute("rel")])]).toEqual([[sUrl(1), sUrl(2)], [["_blank", "noopener noreferrer"], ["_blank", "noopener noreferrer"]]]);
      lacks(lateFooterEl.textContent!, "·");
      expect(hrefs(info.getAllByRole("link", { name: "Source 1" }))).toEqual([sUrl(1)]);

      const summary = stand.getByText("Sources").closest("summary")!;
      expect([summary.textContent, within(summary).queryAllByRole("link").length]).toEqual(["Sources (3)", 0]);
      expect(hrefs(within(summary.parentElement!).getAllByRole("link", { hidden: true }))).toEqual([sUrl(1), sUrl(2), sUrl(3)]);
      expect(hrefs(within(view.getByText("Past event: Exploit repaid").closest("details")!).getAllByRole("link", { hidden: true }))).toEqual([sUrl(4)]);
    } finally { clock.nowMs = null; }

    const toast = render(<NoticeStack notices={[{ type: "info", title: "", message: "Live data paused." }]} />).container;
    expect(Array.from(toast.querySelectorAll("p"), (p) => p.textContent)).toEqual(["Live data paused."]);
  });

  it("mutes Peg and DEWS readings that cannot read calm", () => {
    const tile = (m: ReturnType<typeof buildHero>, key: string) => m.tertiaryMetrics.find((x) => x.key === key)!.display;
    const rail = (m: ReturnType<typeof buildHero>, key: string) => m.signalRailItems.find((x) => x.key === key);
    const noPrice = (peg?: Partial<typeof pegRes>) => rail(buildHero({ priceUnusable: true, ...(peg ? { pegScoreResult: { ...pegRes, ...peg } } : {}) }), "peg");
    const sup = buildHero({ coinStates: [{ kind: "depeg", deviationBps: -4500, ddrTier: null, ddrMethodologyVersion: null }] });
    expect(tile(sup, "dews")).toMatchObject({ value: "Watch", sub: "Superseded by the live depeg", color: "text-muted-foreground" });
    expect(rail(sup, "dews")?.href).toBe("#depeg-resolver");
    expect(noPrice()).toMatchObject({ primary: "95", secondary: "No usable price", colorClass: "text-muted-foreground" });
    expect(noPrice({ pegScore: 60 })).toMatchObject({ secondary: "No usable price", colorClass: pegScoreColor(60) });
    expect(noPrice({ pegScore: null, currentPriceUnavailable: true })).toMatchObject({ primary: "NR", secondary: "No usable price" });

    const halted = { kind: "critical", notice: { type: "danger", title: "Initia L1 halted" } } as const;
    expect(tile(buildHero({ coinStates: [halted], priceInheritedFrom: "ausd-agora" }), "peg-score").sub).toBe("Price inherited from AUSD");
    expect(tile(buildHero({ priceInheritedFrom: "ausd-agora" }), "peg-score").sub).toBe("99.4% at peg");
    const dews = (signals: StressSignalEntry["signals"]) => tile(buildHero({ stressSignal: { ...stressSig, signals } }), "dews");
    const [on, off] = [{ value: 31, available: true }, { value: 0, available: false }];
    expect(dews({ supply: on, flows: off })).toEqual(dews({ supply: on }));
    expect(dews({ supply: on, flows: off, yield: off })).toMatchObject({ sub: "1 of 3 signals", color: "text-muted-foreground" });
  });
});
