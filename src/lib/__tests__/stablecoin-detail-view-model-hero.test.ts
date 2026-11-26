import { afterEach, describe, expect, it, vi } from "vitest";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildAllCoinTrackerLinks, buildCoinTrackerLink } from "@/lib/coin-tracker-links";
import { DEFINITIONS } from "@/lib/definitions";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildDetailHero } from "./stablecoin-detail-view-model.test-support";
import { pegScoreColor } from "@/lib/severity-colors";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";

const quietDeviations = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("@/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feature-flags")>();
  return { ...actual, isQuietDeviationsEnabled: () => quietDeviations.value ?? actual.isQuietDeviationsEnabled() };
});

const coinOf = (id: string) => TRACKED_META_BY_ID.get(id)!;
const tile = (hero: ReturnType<typeof buildDetailHero>, key: string) => hero.tertiaryMetrics.find((m) => m.key === key)!.display;
const passport = (hero: ReturnType<typeof buildDetailHero>, key: string) => hero.passportItems.find((i) => i.key === key);
const makeReport = (assuranceMethod: "examination" | "audit") => ({
  periodEnd: "2026-09-30", assuranceMethod, scope: "assets-and-liabilities", liabilityReconciliation: "full",
  reviewer: "test", confidence: "verified", sources: [{ label: "Report", url: "https://example.com/report" }],
});

describe("stablecoin detail hero view-model builder", () => {
  const SAVED = { grade: "A-" as const, score: 81, dewsScore: 17, dewsBand: "WATCH" as const, liquidityScore: 67, asOfMs: Date.UTC(2026, 9, 22, 8) };
  const ALL_PENDING = { reportCard: true, stress: true, liquidity: true, peg: true, yield: true };

  it("shows dated release values or neutral placeholders while pending, and holds in-flight passport slots", () => {
    const coin = coinOf("usdt-tether");
    const pending = buildDetailHero({ coin, pendingReads: ALL_PENDING, savedAssessment: null });
    for (const key of ["dews", "peg-score", "liquidity", "excess-yield"]) expect(tile(pending, key)).toMatchObject({ value: "", pending: true });
    expect(pending.savedGrade).toBeNull();
    expect(pending.signalRailItems.find((i) => i.key === "liquidity")).toMatchObject({ pending: true });

    const saved = buildDetailHero({ coin, pendingReads: ALL_PENDING, savedAssessment: SAVED });
    expect(tile(saved, "dews")).toMatchObject({ value: "Watch", band: "WATCH", sub: "17/100 · as of 2026-10-22" });
    expect(tile(saved, "liquidity")).toMatchObject({ value: "67", sub: "as of 2026-10-22" });
    expect(tile(saved, "peg-score")).toMatchObject({ pending: true });
    expect(saved.savedGrade).toBe(SAVED);
    expect(saved.signalRailItems[0]).toMatchObject({ key: "safety", primary: "A-", secondary: "81/100", note: "as of 2026-10-22" });

    const settled = buildDetailHero({ coin, savedAssessment: SAVED });
    expect([tile(settled, "dews").value, tile(settled, "liquidity").value, settled.savedGrade]).toEqual(["—", "—", null]);
    expect(settled.signalRailItems[0].primary).toBe("—");
    expect(settled.signalRailItems[0].note).toBeUndefined();

    const reads = { peg: true, redemption: true };
    expect(buildDetailHero({ coin, pendingReads: reads }).passportPendingKeys).toEqual(["redeemability", "record"]);
    expect(buildDetailHero({ coin }).passportPendingKeys).toEqual([]);
    expect(buildDetailHero({ coin, isNavToken: true, pendingReads: reads }).passportPendingKeys).toEqual(["redeemability"]);
    expect(buildDetailHero({ coin: { ...coin, status: "frozen" }, pendingReads: reads }).passportPendingKeys).toEqual([]);
    expect(buildDetailHero({ coin, pendingReads: reads, redemptionBackstop: { accessModel: "issuer-api" } as never }).passportPendingKeys).toEqual(["record"]);

    const nav = buildDetailHero({ coin, isNavToken: true, pendingReads: ALL_PENDING, savedAssessment: SAVED });
    expect([tile(nav, "dews").value, tile(nav, "peg-score").value]).toEqual(["—", "—"]);
    expect(nav.passportPendingKeys).toEqual([]);
  });

  it.each([900, null])("keeps native current paired with its checkpoints rather than mixing displayed supply %s", (supply) => {
    const hero = buildDetailHero({ coin: coinOf("usdc-circle"), supply, nativeSupply: { current: 1_100, prevWeek: 1_000, prevMonth: 950 } });
    expect(hero.market.supply).toBe(supply);
    expect(hero.market.supplyTrend).toMatchObject({ current: 1_100, safePrevWeek: 1_000, safePrevMonth: 950, hasPrevMonth: true, prevWeekTrendClass: DIRECTION_TONE_CLASSES.up, prevMonthTrendClass: DIRECTION_TONE_CLASSES.up });
  });

  it("derives hero display metrics, signal rail, passport chips, and case study callout from raw detail inputs", () => {
    const hero = buildDetailHero({
      coin: coinOf("usdc-circle"),
      coinData: { id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD", price: 0.97, circulating: { peggedUSD: 500_000 }, circulatingPrevDay: { peggedUSD: 600_000 }, circulatingPrevWeek: { peggedUSD: 450_000 }, circulatingPrevMonth: { peggedUSD: 0 }, chains: ["ethereum", "base"] } as never,
      isNavToken: false, mcap: 500_000, supply: 500_000, prevDay: 600_000, nativeSupply: { current: 500_000, prevWeek: 450_000, prevMonth: 0 },
      performanceVsUsd1y: 12.34, pegRef: 1, deviationBps: -300, pegReferenceUnavailable: false,
      pegScoreResult: makePegSummaryCoin({ id: "usdc-circle", symbol: "USDC", pegScore: 45, pegPct: 99.4, eventCount: 2, trackingSpanDays: 365, activeDepeg: true, depegEventCoverageLimited: true }),
      liquidityData: { liquidityScore: 28, poolCount: 4 } as never,
      yieldRanking: { excessYield: -0.25, benchmarkLabel: "USD 3M T-Bill", benchmarkCurrency: "USD", benchmarkRecordDate: "2026-04-21", benchmarkIsFallback: false, benchmarkFallbackMode: null, benchmarkSelectionMode: "native", benchmarkIsProxy: false } as never,
      stressSignal: { score: 31, band: "WATCH" } as never,
      reportCard: makeV9Card({ id: "usdc-circle", grade: "B+", score: 79, accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "direct" } }),
      verdict: { archetype: "distressed", label: "Distressed" }, resolvedMechanismArchetype: "fiat-cash",
      mintAuthority: { status: "reviewed", mintPathLabel: "Issuer direct mint", mintPathShortLabel: "Issuer direct" } as never,
      redemptionBackstop: { accessModel: "issuer-api" } as never,
    });

    expect(hero.market.supplyTrend.safePrevMonth).toBeNull();
    expect([hero.market.prevDayTrendClass, hero.market.supplyTrend.prevWeekTrendClass]).toEqual([DIRECTION_TONE_CLASSES.down, DIRECTION_TONE_CLASSES.up]);
    expect(hero.price.limitedDepegCoverageNote).toContain("Below $1.00M live-event floor");
    expect(tile(hero, "peg-score")).toMatchObject({ value: "45", sub: "99.4% at peg" });
    expect(tile(hero, "performance-vs-usd")).toMatchObject({ value: "+12.34%", color: DIRECTION_TONE_CLASSES.up });
    expect(tile(hero, "excess-yield").color).toBe(DIRECTION_TONE_CLASSES.down);
    expect(hero.desktopTertiaryMetrics.map((m) => m.key)).not.toContain("dews");
    expect(hero.signalRailItems.find((i) => i.key === "safety")).toMatchObject({ primary: "B+", secondary: "79/100" });

    expect(passport(hero, "mechanism")).toMatchObject({ value: "Custodial Cash", href: "#mechanism" });
    expect(passport(hero, "freeze")).toMatchObject({ value: "Yes", href: "#blacklist" });
    expect(passport(hero, "chains")).toMatchObject({ value: "2", href: "#contracts" });
    expect(passport(hero, "jurisdiction")?.href).toBe("#jurisdiction");
    expect(passport(hero, "redeemability")).toMatchObject({ value: "Institutional", href: "#redemption", ariaLabel: "Redeemability: Issuer / institutional — jump to redemption route" });
    expect(passport(hero, "minting")).toMatchObject({ value: "Issuer direct", href: "#mint-authority", ariaLabel: "Minting: Issuer direct mint — jump to Mint Authority" });
    expect(passport(hero, "mica")).toMatchObject({ value: "Authorized", href: "#jurisdiction", valueClass: "text-green-700 dark:text-green-400" });
    expect(passport(hero, "genius")?.href).toBe("/compliance/?regime=genius");
    expect(passport(hero, "record")).toBeUndefined();
    expect(hero.caseStudyCallout).toEqual({
      href: "/learn/case-studies/usdc-svb-2023/", title: "USDC and the Silicon Valley Bank weekend",
      outcomeLabel: "Survived", outcomeChipClass: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
    });
  });

  it("keeps incident count in passport Record and marks early peg scores under 30 tracking days", () => {
    const coin = coinOf("usdt-tether");
    const pegFor = (extra: Partial<Parameters<typeof makePegSummaryCoin>[0]>) =>
      buildDetailHero({ coin, pegScoreResult: makePegSummaryCoin({ id: coin.id, symbol: coin.symbol, pegScore: 100, pegPct: 100, eventCount: 0, trackingSpanDays: 365, ...extra }) });

    expect(tile(pegFor({ depegEventCoverageLimited: true }), "peg-score").sub).toBe("100.0% at peg");
    const observed = pegFor({});
    expect(tile(observed, "peg-score").sub).toBe("100.0% at peg");
    expect(passport(observed, "record")?.value).toBe("0 recorded");

    expect(tile(pegFor({ trackingSpanDays: 10 }), "peg-score")).toMatchObject({ value: "100", sub: "Early score · 10d tracked", color: pegScoreColor(100) });
    expect(tile(pegFor({ trackingSpanDays: 29 }), "peg-score").sub).toBe("Early score · 29d tracked");
    expect(tile(pegFor({ trackingSpanDays: 30 }), "peg-score").sub).toBe("100.0% at peg");
  });

  it("derives unavailable peg score, upstream/reviewed FreezeWatch precedence, and attestor/jurisdiction chips", () => {
    const dai = coinOf("dai-makerdao");
    const daiHero = buildDetailHero({
      coin: dai, coinData: { id: "dai-makerdao", name: "Dai", symbol: "DAI", pegType: "peggedUSD", price: 1, circulating: { peggedUSD: 100 }, chains: [] } as never,
      pegScoreResult: makePegSummaryCoin({ id: "dai-makerdao", symbol: "DAI", name: "Dai", pegScore: null, pegPct: 0, eventCount: 0, trackingSpanDays: 3, activeDepeg: false }),
      reportCard: makeV9Card({ id: "dai-makerdao", accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "upstream" } }),
      verdict: { archetype: "uncategorized", label: "Uncategorized" },
      mintAuthority: { status: "reviewed", mintPathLabel: "User-collateralized, governed", mintPathShortLabel: "Governed CDP" } as never,
    });
    expect(tile(daiHero, "peg-score")).toMatchObject({ value: "NR", sub: "3d tracked" });
    expect(passport(daiHero, "freeze")).toMatchObject({ value: "Upstream risk", href: buildCoinTrackerLink("dai-makerdao", "freezewatch", "DAI").href });
    expect(passport(daiHero, "redeemability")).toBeUndefined();
    expect(passport(buildDetailHero({ coin: { ...dai, blacklistabilitySummary: {} as never }, reportCard: makeV9Card({ id: "dai-makerdao" }) }), "freeze")?.href).toBe("#freeze-seizure");

    const lusdHero = buildDetailHero({
      coin: coinOf("lusd-liquity"), coinData: { id: "lusd-liquity", name: "Liquity USD", symbol: "LUSD", pegType: "peggedUSD", price: 1, circulating: { peggedUSD: 100 }, chains: [] } as never,
      reportCard: makeV9Card({ id: "lusd-liquity", accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "possible" } }),
      mintAuthority: { status: "not-reviewed" } as never,
    });
    expect(passport(lusdHero, "freeze")).toMatchObject({ value: "No" });

    const attestedCoin = {
      id: "mock-attested", symbol: "MAT", name: "Mock Attested", collateral: "Cash and T-Bills", pegMechanism: "Fiat redemption",
      jurisdiction: { country: "Switzerland", regulator: "FINMA" }, proofOfReserves: { type: "independent-audit", url: "https://example.com", attestorTier: "big4" },
      contracts: [{ chain: "ethereum", address: "0x1" }], flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD" },
    } as never;
    const matData = (chains: string[]) => ({ id: "mock-attested", name: "Mock Attested", symbol: "MAT", pegType: "peggedUSD", price: 1, circulating: { peggedUSD: 100 }, chains }) as never;
    const attested = buildDetailHero({ coin: attestedCoin, coinData: matData(["ethereum", "base", "solana"]), resolvedMechanismArchetype: "tbill", mintAuthority: { status: "reviewed", mintPathLabel: "Permissioned minter", mintPathShortLabel: "Permissioned" } as never, redemptionBackstop: { accessModel: "permissionless-onchain" } as never });
    expect(passport(attested, "mechanism")).toMatchObject({ value: "Tokenized Treasury", href: "#mechanism" });
    expect(passport(attested, "redeemability")).toMatchObject({ value: "Permissionless", href: "#redemption" });
    expect(passport(attested, "minting")).toMatchObject({ value: "Permissioned", href: "#mint-authority" });
    expect(passport(attested, "attestor")).toMatchObject({ value: "Big-4", href: "#attestation", ariaLabel: "Reserve report: Independent Report; Big-4 attestor — jump to Proof of Reserves" });
    expect(passport(attested, "jurisdiction")).toMatchObject({ value: "Switzerland", href: "#info" });
    expect(passport(attested, "chains")).toMatchObject({ value: "3", href: "#contracts" });
    expect(passport(attested, "chains")).not.toHaveProperty("chip");

    const decentralized = buildDetailHero({ coin: { ...(attestedCoin as object), flags: { backing: "crypto-backed", governance: "decentralized", pegCurrency: "USD" } } as never, coinData: matData(["ethereum"]), resolvedMechanismArchetype: "cdp", mintAuthority: { status: "reviewed", mintPathLabel: "User-collateralized, governed", mintPathShortLabel: "Governed CDP" } as never });
    expect(passport(decentralized, "attestor")).toBeUndefined();
    expect(passport(decentralized, "jurisdiction")?.href).toBe("#info");
  });

  type HeroParams = Parameters<typeof buildDetailHero>[0];
  function buildPassportHero({ coin = {}, pegRecord = null, isNavToken = false, mintAuthority = { status: "not-reviewed" } as HeroParams["mintAuthority"], redemptionBackstop = null }: {
    coin?: Record<string, unknown>; pegRecord?: { eventCount?: number; depegEventCoverageLimited?: boolean } | null;
    isNavToken?: boolean; mintAuthority?: HeroParams["mintAuthority"]; redemptionBackstop?: HeroParams["redemptionBackstop"];
  } = {}) {
    return buildDetailHero({
      coin: { id: "mock-passport", symbol: "MPP", name: "Mock Passport", jurisdiction: { country: "United States" }, contracts: [{ chain: "ethereum", address: "0x1" }], flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD" }, ...coin } as never,
      coinData: { id: "mock-passport", name: "Mock Passport", symbol: "MPP", pegType: "peggedUSD", price: 1, circulating: { peggedUSD: 100 }, chains: ["ethereum"] } as never,
      isNavToken, pegScoreResult: pegRecord ? makePegSummaryCoin({ id: "mock-passport", symbol: "MPP", ...pegRecord }) : null, mintAuthority, redemptionBackstop,
    });
  }

  it.each<{ name: string; input: Parameters<typeof buildPassportHero>[0]; key: string; expected: Record<string, unknown>; unstyled?: boolean }>([
    { name: "reviewed absence of attestor", key: "attestor", input: { coin: { proofOfReserves: { type: "self-reported", url: "https://example.com", attestorTier: "none" } } }, expected: { value: "None", valueClass: "text-red-700 dark:text-red-400", ariaLabel: "Reserve report: Self-Reported PoR; No attestation — jump to Proof of Reserves" } },
    { name: "undisclosed attestor muted", key: "attestor", input: { coin: { proofOfReserves: { type: "self-reported", url: "https://example.com", attestorTier: "undisclosed" } } }, expected: { value: "Not disclosed", valueClass: "text-muted-foreground", ariaLabel: "Reserve report: Self-Reported PoR; Not disclosed — jump to Proof of Reserves" } },
    { name: "reviewed examination + regional tier", key: "attestor", input: { coin: { proofOfReserves: { type: "independent-audit", url: "https://example.com", provider: "Example CPA", attestorTier: "regional", latestReport: makeReport("examination") } } }, expected: { value: "Regional CPA", valueClass: "text-blue-700 dark:text-blue-400", ariaLabel: "Reserve report: Examination; Regional CPA — jump to Proof of Reserves" } },
    { name: "reviewed audit + big4 tier", key: "attestor", input: { coin: { proofOfReserves: { type: "independent-audit", url: "https://example.com", attestorTier: "big4", latestReport: makeReport("audit") } } }, expected: { value: "Big-4", valueClass: "text-emerald-700 dark:text-emerald-400", ariaLabel: "Reserve report: Audit; Big-4 attestor — jump to Proof of Reserves" } },
    { name: "resolved engagement without tier", key: "attestor", input: { coin: { proofOfReserves: { type: "independent-audit", url: "https://example.com", latestReport: makeReport("examination") } } }, expected: { value: "Examination", ariaLabel: "Reserve report: Examination — jump to Proof of Reserves" } },
    { name: "unresolved method without tier", key: "attestor", input: { coin: { proofOfReserves: { type: "independent-audit", url: "https://example.com" } } }, expected: { value: "Independent Report", ariaLabel: "Reserve report: Independent Report — jump to Proof of Reserves" } },
    { name: "pending MiCA visa", key: "mica", input: { coin: { mica: { status: "pending" } } }, expected: { category: "MiCA", value: "Pending", href: "#jurisdiction", valueClass: "text-amber-700 dark:text-amber-400", ariaLabel: "MiCA status: Pending — jump to jurisdiction details" } },
    { name: "frozen MiCA historical", key: "mica", input: { coin: { status: "frozen", mica: { status: "authorized" } } }, expected: { ariaLabel: "Historical MiCA status: Authorized — jump to jurisdiction details" } },
    { name: "GENIUS filing pathway", key: "genius", input: { coin: { genius: { authorizationStatus: "official-application-pending" } } }, expected: { category: "GENIUS", value: "Filing Pending", href: "/compliance/?regime=genius", ariaLabel: `GENIUS Act pathway: Filing Pending (regime effective ${GENIUS_REGIME_STATE.effectiveDate}) — view the Compliance Tracker` } },
    { name: "zero incidents unstyled", key: "record", input: { pegRecord: { eventCount: 0 } }, unstyled: true, expected: { category: "Record", value: "0 recorded", href: "#depeg-history", ariaLabel: "Peg record: no depeg incidents recorded in the score coverage window — jump to Depeg History" } },
    { name: "one incident singular", key: "record", input: { pegRecord: { eventCount: 1 } }, expected: { value: "1 incident", ariaLabel: "Peg record: 1 depeg incident in the score coverage window — jump to Depeg History" } },
    { name: "several incidents unstyled", key: "record", input: { pegRecord: { eventCount: 3 } }, unstyled: true, expected: { value: "3 incidents", ariaLabel: "Peg record: 3 depeg incidents in the score coverage window — jump to Depeg History" } },
  ])("passport fact: $name", ({ input, key, expected, unstyled }) => {
    const item = passport(buildPassportHero(input), key);
    expect(item).toMatchObject(expected);
    if (unstyled) expect(item?.valueClass).toBeUndefined();
  });

  it("omits Chains without contracts and omits absent/inapplicable passport facts", () => {
    const hiveHero = buildDetailHero({ coin: coinOf("hbd-hive") });
    expect(passport(hiveHero, "chains")).toBeUndefined();
    expect(hiveHero.passportItems.every((i) => !/Deployed on 0 chains/.test(i.ariaLabel))).toBe(true);

    for (const [input, key] of [
      [undefined, "mica"],
      [{ coin: { genius: { authorizationStatus: "not-applicable" } } }, "genius"],
      [{ coin: { genius: { authorizationStatus: "unknown" } } }, "genius"],
      [undefined, "genius"],
      [{ pegRecord: { eventCount: 2, depegEventCoverageLimited: true } }, "record"],
      [{ pegRecord: { eventCount: 0 }, isNavToken: true }, "record"],
      [undefined, "record"],
    ] as const) {
      expect(passport(buildPassportHero(input), key)).toBeUndefined();
    }
  });
});

describe("hero trend direction, excess-yield help, and tracker links", () => {
  afterEach(() => { quietDeviations.value = null; });
  const coin = coinOf("usdc-circle");

  it.each([false, true])("mutes rounded zero, tones real moves, and withholds partial/missing baselines (quiet=%s)", (quiet) => {
    quietDeviations.value = quiet;
    const trend = (mcap: number, prevDay: number | null) => buildDetailHero({ coin, mcap, prevDay }).market.prevDayTrendClass;
    expect([trend(100, 100), trend(99.999, 100), trend(100.001, 100), trend(100, null)]).toEqual(Array(4).fill("text-muted-foreground"));
    expect([trend(99, 100), trend(101, 100), trend(0, 100)]).toEqual([DIRECTION_TONE_CLASSES.down, DIRECTION_TONE_CLASSES.up, DIRECTION_TONE_CLASSES.down]);
    expect(trend(100.2, 100)).toBe(quiet ? "text-muted-foreground" : DIRECTION_TONE_CLASSES.up);

    const partial = buildDetailHero({ coin, mcap: 99, prevDay: 100, coinData: { ...buildDetailHero({ coin }).coinData, supplyExcludedChains: ["HyperEVM"] } });
    expect([partial.market.safePrevDay, partial.market.prevDayTrendClass]).toEqual([null, "text-muted-foreground"]);
  });

  it("binds 30d Excess to excess-yield definition, keeps DEFINITIONS clean, and routes tracker hatnotes", () => {
    expect(buildDetailHero({ coin: coinOf("usdt-tether") }).tertiaryMetrics.find((e) => e.key === "excess-yield")).toMatchObject({ label: "30d Excess", methodologyTopic: "excessYield" });
    expect(METHODOLOGY_CONTEXT.excessYield).toMatchObject({ title: "Excess yield", summary: "30-day APY minus its benchmark rate." });

    for (const def of Object.values(DEFINITIONS)) {
      for (const field of [def.label, "term" in def ? def.term : undefined, def.short, "detail" in def ? def.detail : undefined, "long" in def ? def.long : undefined]) {
        if (field) expect(field).not.toMatch(/[\u2012\u2013\u2014\u2015]|\brisk[- ]free\b|\bV(?:9|10)\b/i);
      }
    }

    const usdcLinks = Object.fromEntries(buildAllCoinTrackerLinks("usdc-circle", undefined, "USDC").map((l) => [l.tracker, l.href]));
    expect(usdcLinks).toEqual({
      "stablecoin-profile": "/stablecoin/usdc-circle/", "safety-score": "/stablecoin/usdc-circle/#overview",
      liquidity: "/stablecoin/usdc-circle/#liquidity", "depeg-history": "/stablecoin/usdc-circle/#history",
      yield: "/yield/", flows: "/flows/", freezewatch: "/freezewatch/?stablecoin=USDC", timeline: "/timeline/?coin=usdc-circle",
    });
    expect(new Set(Object.values(usdcLinks)).size).toBe(Object.keys(usdcLinks).length);
    expect(buildCoinTrackerLink("susde-ethena", "yield", "sUSDe").href).toBe("/stablecoin/susde-ethena/yield/");
    expect([
      ["usdf-falcon", "USDf"], ["usdf-astherus", "USDF"], ["usdf-flipcash", "USDF"],
      ["usda-avalon", "USDA"], ["aeur-anchored-coins", "AEUR"], ["dai-makerdao", "DAI"],
    ].map(([id, sym]) => buildCoinTrackerLink(id, "freezewatch", sym).href)).toEqual([
      "/freezewatch/?stablecoin=USDF", "/freezewatch/", "/freezewatch/",
      "/freezewatch/?stablecoin=USDA", "/freezewatch/?stablecoin=AEUR", "/freezewatch/",
    ]);
    expect(passport(buildDetailHero({ coin: { ...coinOf("usdf-astherus"), blacklistabilitySummary: undefined } }), "freeze")?.href).toBe("/freezewatch/");
    expect(passport(buildDetailHero({ coin: { ...coinOf("usda-avalon"), blacklistabilitySummary: undefined } }), "freeze")?.href).toBe("#blacklist");
  });
});
