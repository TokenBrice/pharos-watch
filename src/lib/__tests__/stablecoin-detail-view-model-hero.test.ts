import { describe, expect, it } from "vitest";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { PegSummaryCoin } from "@shared/types";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildStablecoinDetailHeroViewModel } from "../stablecoin-detail-view-model";

function makePegSummaryCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: 95,
    pegPct: 99.9,
    severityScore: 0,
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

describe("stablecoin detail hero view-model builder", () => {
  it("derives hero display metrics and signal rail from raw detail inputs", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(coin).toBeDefined();

    const hero = buildStablecoinDetailHeroViewModel({
      coin: coin!,
      coinData: {
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        pegType: "peggedUSD",
        price: 0.97,
        circulating: { peggedUSD: 500_000 },
        circulatingPrevDay: { peggedUSD: 600_000 },
        circulatingPrevWeek: { peggedUSD: 450_000 },
        circulatingPrevMonth: { peggedUSD: 0 },
        chains: ["ethereum", "base"],
      } as never,
      isNavToken: false,
      mcap: 500_000,
      supply: 500_000,
      prevDay: 600_000,
      prevWeek: 450_000,
      prevMonth: 0,
      performanceVsUsd1y: 12.34,
      pegRef: 1,
      deviationBps: -300,
      gaugeDeviationBps: -300,
      pegReferenceUnavailable: false,
      pegScoreResult: makePegSummaryCoin({
        id: "usdc-circle",
        symbol: "USDC",
        pegScore: 45,
        pegPct: 99.4,
        eventCount: 2,
        trackingSpanDays: 365,
        activeDepeg: true,
        depegEventCoverageLimited: true,
      }),
      liquidityData: {
        liquidityScore: 28,
        poolCount: 4,
      } as never,
      yieldRanking: {
        excessYield: -0.25,
        benchmarkLabel: "USD 3M T-Bill",
        benchmarkCurrency: "USD",
        benchmarkRecordDate: "2026-04-21",
        benchmarkIsFallback: false,
        benchmarkFallbackMode: null,
        benchmarkSelectionMode: "native",
        benchmarkIsProxy: false,
      } as never,
      stressSignal: {
        score: 31,
        band: "WATCH",
      } as never,
      reportCard: makeV9Card({
        id: "usdc-circle",
        grade: "B+",
        score: 79,
        accessPosture: {
          ...makeV9Card().accessPosture,
          freezeExposure: "direct",
        },
      }),
      verdict: {
        archetype: "distressed",
        label: "Distressed",
      },
      resolvedMechanismArchetype: "fiat-cash",
      mintAuthority: {
        status: "reviewed",
        mintPathLabel: "Issuer direct mint",
        mintPathShortLabel: "Issuer direct",
      } as never,
      redemptionBackstop: { accessModel: "issuer-api" } as never,
    });

    expect(hero.market.safePrevMonth).toBeNull();
    expect(hero.market.prevDayTrendClass).toContain("text-red-700");
    expect(hero.market.prevWeekTrendClass).toContain("text-green-700");
    expect(hero.price.limitedDepegCoverageNote).toContain("Below $1.00M live-event floor");

    const pegMetric = hero.tertiaryMetrics.find((metric) => metric.key === "peg-score");
    expect(pegMetric?.display).toMatchObject({
      value: "45",
      sub: "2 incidents",
    });
    expect(pegMetric?.accentClass).toBe("border-l-2 border-l-red-500");

    expect(hero.tertiaryMetrics.find((metric) => metric.key === "performance-vs-usd")?.display.value).toBe("+12.34%");
    expect(hero.desktopTertiaryMetrics.map((metric) => metric.key)).not.toContain("dews");
    expect(hero.signalRailItems.find((item) => item.key === "safety")).toMatchObject({
      primary: "B+",
      secondary: "79/100",
    });

    expect(hero.passportItems.find((item) => item.key === "mechanism")).toMatchObject({
      value: "Custodial Cash",
      href: "#mechanism",
    });
    // USDC is blacklist-tracked, so the freeze chip prefers the live tracker.
    expect(hero.passportItems.find((item) => item.key === "freeze")).toMatchObject({
      value: "Yes",
      href: "#blacklist",
    });
    expect(hero.passportItems.find((item) => item.key === "chains")).toMatchObject({
      value: "2",
      href: "#contracts",
    });
    expect(hero.passportItems.find((item) => item.key === "jurisdiction")?.href).toBe("#jurisdiction");
    // Passport-short projections carry the value; the aria keeps the full label.
    expect(hero.passportItems.find((item) => item.key === "redeemability")).toMatchObject({
      value: "Institutional",
      href: "#redemption",
      ariaLabel: "Redeemability: Issuer / institutional — jump to redemption route",
    });
    expect(hero.passportItems.find((item) => item.key === "minting")).toMatchObject({
      value: "Issuer direct",
      href: "#mint-authority",
      ariaLabel: "Minting: Issuer direct mint — jump to Mint Authority",
    });
    // USDC carries MiCA + GENIUS regulatory visas in the registry data.
    expect(hero.passportItems.find((item) => item.key === "mica")).toMatchObject({
      value: "Authorized",
      href: "#jurisdiction",
      valueClass: "text-green-700 dark:text-green-400",
    });
    expect(hero.passportItems.find((item) => item.key === "genius")?.href).toBe("/compliance/?regime=genius");
    // Coverage-limited peg summary -> no Record field (can't honestly claim one).
    expect(hero.passportItems.some((item) => item.key === "record")).toBe(false);

    // USDC is the subject of the SVB case study -> dossier callout populated.
    expect(hero.caseStudyCallout).toEqual({
      href: "/learn/case-studies/usdc-svb-2023/",
      title: "USDC and the Silicon Valley Bank weekend",
      outcomeLabel: "Survived",
      outcomeChipClass: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
    });
  });

  it("derives unavailable peg score and upstream freeze states", () => {
    const coin = TRACKED_META_BY_ID.get("dai-makerdao");
    expect(coin).toBeDefined();

    const hero = buildStablecoinDetailHeroViewModel({
      coin: coin!,
      coinData: {
        id: "dai-makerdao",
        name: "Dai",
        symbol: "DAI",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        chains: [],
      } as never,
      isNavToken: false,
      mcap: 100,
      supply: 100,
      prevDay: null,
      prevWeek: null,
      prevMonth: null,
      performanceVsUsd1y: null,
      pegRef: 1,
      deviationBps: 0,
      gaugeDeviationBps: 0,
      pegReferenceUnavailable: false,
      pegScoreResult: makePegSummaryCoin({
        id: "dai-makerdao",
        symbol: "DAI",
        name: "Dai",
        pegScore: null,
        pegPct: 0,
        eventCount: 0,
        trackingSpanDays: 3,
        activeDepeg: false,
      }),
      liquidityData: undefined,
      yieldRanking: null,
      stressSignal: null,
      reportCard: makeV9Card({
        id: "dai-makerdao",
        accessPosture: {
          ...makeV9Card().accessPosture,
          freezeExposure: "upstream",
        },
      }),
      verdict: {
        archetype: "uncategorized",
        label: "Uncategorized",
      },
      resolvedMechanismArchetype: null,
      mintAuthority: {
        status: "reviewed",
        mintPathLabel: "User-collateralized, governed",
        mintPathShortLabel: "Governed CDP",
      } as never,
      redemptionBackstop: null,
    });

    expect(hero.tertiaryMetrics.find((metric) => metric.key === "peg-score")?.display).toMatchObject({
      value: "NR",
      sub: "3d tracked",
    });
    // DAI is not blacklist-tracked, so the upstream-freeze chip targets the
    // mint-authority evidence section instead.
    expect(hero.passportItems.find((item) => item.key === "freeze")).toMatchObject({
      value: "Upstream",
      href: "#mint-authority",
    });
    // No redemption backstop record -> the redeemability entry is omitted.
    expect(hero.passportItems.some((item) => item.key === "redeemability")).toBe(false);
  });

  it("uses reviewed FreezeWatch status before stale V9 freeze exposure in the hero passport", () => {
    const coin = TRACKED_META_BY_ID.get("lisusd-lista");
    expect(coin).toBeDefined();

    const hero = buildStablecoinDetailHeroViewModel({
      coin: coin!,
      coinData: {
        id: "lisusd-lista",
        name: "Lista USD",
        symbol: "LISUSD",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        chains: [],
      } as never,
      isNavToken: false,
      mcap: 100,
      supply: 100,
      prevDay: null,
      prevWeek: null,
      prevMonth: null,
      performanceVsUsd1y: null,
      pegRef: 1,
      deviationBps: 0,
      gaugeDeviationBps: 0,
      pegReferenceUnavailable: false,
      pegScoreResult: null,
      liquidityData: undefined,
      yieldRanking: null,
      stressSignal: null,
      reportCard: makeV9Card({
        id: "lisusd-lista",
        accessPosture: {
          ...makeV9Card().accessPosture,
          freezeExposure: "possible",
        },
      }),
      verdict: {
        archetype: "uncategorized",
        label: "Uncategorized",
      },
      resolvedMechanismArchetype: null,
      mintAuthority: {
        status: "not-reviewed",
      } as never,
      redemptionBackstop: null,
    });

    expect(hero.passportItems.find((item) => item.key === "freeze")).toMatchObject({
      value: "No",
    });
  });

  it("builds passport chips with honest fallbacks for sparse coins", () => {
    const sparseCoin = {
      id: "mock-sparse",
      symbol: "MSP",
      name: "Mock Sparse",
      flags: {
        backing: "rwa-backed",
        governance: "centralized",
        pegCurrency: "USD",
      },
    } as never;

    const hero = buildStablecoinDetailHeroViewModel({
      coin: sparseCoin,
      coinData: {
        id: "mock-sparse",
        name: "Mock Sparse",
        symbol: "MSP",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        chains: [],
      } as never,
      isNavToken: false,
      mcap: 100,
      supply: 100,
      prevDay: null,
      prevWeek: null,
      prevMonth: null,
      performanceVsUsd1y: null,
      pegRef: 1,
      deviationBps: 0,
      gaugeDeviationBps: 0,
      pegReferenceUnavailable: false,
      pegScoreResult: null,
      liquidityData: undefined,
      yieldRanking: null,
      stressSignal: null,
      reportCard: null,
      verdict: { archetype: "uncategorized", label: "Uncategorized" },
      resolvedMechanismArchetype: null,
      mintAuthority: { status: "not-reviewed" } as never,
      redemptionBackstop: null,
    });

    const byKey = new Map(hero.passportItems.map((item) => [item.key, item]));
    // No archetype -> backing badge label; no description blocks -> #info.
    expect(byKey.get("mechanism")).toMatchObject({ value: "RWA-Backed", href: "#info" });
    // No proof of reserves -> attestor chip omitted entirely.
    expect(byKey.has("attestor")).toBe(false);
    // Undisclosed jurisdiction stays as an honest answer, muted; with no
    // reviewed regime there is no Regulatory standing module to jump to.
    expect(byKey.get("jurisdiction")).toMatchObject({ value: "Not disclosed", href: "#info" });
    // No freeze section anywhere -> FreezeWatch coverage page link.
    expect(byKey.get("freeze")).toMatchObject({ value: "No", href: "/freezewatch/?stablecoin=MSP" });
    // No curated contracts -> chains chip falls back to the overview section.
    expect(byKey.get("chains")).toMatchObject({ value: "0", href: "#info" });
    // Unreviewed mint authority / missing backstop -> both entries omitted.
    expect(byKey.has("minting")).toBe(false);
    expect(byKey.has("redeemability")).toBe(false);
  });

  it("builds attestor and jurisdiction passport chips from coin metadata", () => {
    const attestedCoin = {
      id: "mock-attested",
      symbol: "MAT",
      name: "Mock Attested",
      collateral: "Cash and T-Bills",
      pegMechanism: "Fiat redemption",
      jurisdiction: { country: "Switzerland", regulator: "FINMA" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com", attestorTier: "big4" },
      contracts: [{ chain: "ethereum", address: "0x1" }],
      flags: {
        backing: "rwa-backed",
        governance: "centralized",
        pegCurrency: "USD",
      },
    } as never;

    const hero = buildStablecoinDetailHeroViewModel({
      coin: attestedCoin,
      coinData: {
        id: "mock-attested",
        name: "Mock Attested",
        symbol: "MAT",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        chains: ["ethereum", "base", "solana"],
      } as never,
      isNavToken: false,
      mcap: 100,
      supply: 100,
      prevDay: null,
      prevWeek: null,
      prevMonth: null,
      performanceVsUsd1y: null,
      pegRef: 1,
      deviationBps: 0,
      gaugeDeviationBps: 0,
      pegReferenceUnavailable: false,
      pegScoreResult: null,
      liquidityData: undefined,
      yieldRanking: null,
      stressSignal: null,
      reportCard: null,
      verdict: { archetype: "uncategorized", label: "Uncategorized" },
      resolvedMechanismArchetype: "tbill",
      mintAuthority: {
        status: "reviewed",
        mintPathLabel: "Permissioned minter",
        mintPathShortLabel: "Permissioned",
      } as never,
      redemptionBackstop: { accessModel: "permissionless-onchain" } as never,
    });

    const byKey = new Map(hero.passportItems.map((item) => [item.key, item]));
    expect(byKey.get("mechanism")).toMatchObject({ value: "Tokenized Treasury", href: "#mechanism" });
    expect(byKey.get("redeemability")).toMatchObject({
      value: "Permissionless",
      href: "#redemption",
    });
    expect(byKey.get("minting")).toMatchObject({ value: "Permissioned", href: "#mint-authority" });
    // Passport-short attestor tier (Figma coin template); the aria-label keeps the full label.
    expect(byKey.get("attestor")).toMatchObject({ value: "Big-4", href: "#attestation" });
    // No curated MiCA/GENIUS profile on this fixture, so jurisdiction has no
    // Regulatory standing module to target.
    expect(byKey.get("jurisdiction")).toMatchObject({ value: "Switzerland", href: "#info" });
    expect(byKey.get("chains")).toMatchObject({ value: "3", href: "#contracts", chip: true });

    // A decentralized coin omits the attestor chip (it publishes no reserve
    // attestation) and routes jurisdiction to the overview section.
    const decentralizedHero = buildStablecoinDetailHeroViewModel({
      coin: {
        ...(attestedCoin as object),
        flags: { backing: "crypto-backed", governance: "decentralized", pegCurrency: "USD" },
      } as never,
      coinData: {
        id: "mock-attested",
        name: "Mock Attested",
        symbol: "MAT",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        chains: ["ethereum"],
      } as never,
      isNavToken: false,
      mcap: 100,
      supply: 100,
      prevDay: null,
      prevWeek: null,
      prevMonth: null,
      performanceVsUsd1y: null,
      pegRef: 1,
      deviationBps: 0,
      gaugeDeviationBps: 0,
      pegReferenceUnavailable: false,
      pegScoreResult: null,
      liquidityData: undefined,
      yieldRanking: null,
      stressSignal: null,
      reportCard: null,
      verdict: { archetype: "uncategorized", label: "Uncategorized" },
      resolvedMechanismArchetype: "cdp",
      mintAuthority: {
        status: "reviewed",
        mintPathLabel: "User-collateralized, governed",
        mintPathShortLabel: "Governed CDP",
      } as never,
      redemptionBackstop: null,
    });

    const decentralizedByKey = new Map(decentralizedHero.passportItems.map((item) => [item.key, item]));
    expect(decentralizedByKey.has("attestor")).toBe(false);
    expect(decentralizedByKey.get("jurisdiction")?.href).toBe("#info");
  });

  type HeroBuilderParams = Parameters<typeof buildStablecoinDetailHeroViewModel>[0];

  // Shared scaffold for the Issued / MiCA / GENIUS / Record passport cases:
  // a plain centralized mock coin with every conditional dataset absent unless
  // a case opts in.
  function buildPassportHero({
    coin = {},
    pegRecord = null,
    isNavToken = false,
    mintAuthority = { status: "not-reviewed" } as HeroBuilderParams["mintAuthority"],
    redemptionBackstop = null,
  }: {
    coin?: Record<string, unknown>;
    pegRecord?: { eventCount?: number; depegEventCoverageLimited?: boolean } | null;
    isNavToken?: boolean;
    mintAuthority?: HeroBuilderParams["mintAuthority"];
    redemptionBackstop?: HeroBuilderParams["redemptionBackstop"];
  } = {}) {
    const basePegScoreResult = {
      id: "mock-passport",
      symbol: "MPP",
      pegScore: 95,
      pegPct: 99.95,
      eventCount: 0,
      trackingSpanDays: 365,
      activeDepeg: false,
    };
    return buildStablecoinDetailHeroViewModel({
      coin: {
        id: "mock-passport",
        symbol: "MPP",
        name: "Mock Passport",
        jurisdiction: { country: "United States" },
        contracts: [{ chain: "ethereum", address: "0x1" }],
        flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD" },
        ...coin,
      } as never,
      coinData: {
        id: "mock-passport",
        name: "Mock Passport",
        symbol: "MPP",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        chains: ["ethereum"],
      } as never,
      isNavToken,
      mcap: 100,
      supply: 100,
      prevDay: null,
      prevWeek: null,
      prevMonth: null,
      performanceVsUsd1y: null,
      pegRef: 1,
      deviationBps: 0,
      gaugeDeviationBps: 0,
      pegReferenceUnavailable: false,
      pegScoreResult: pegRecord ? ({ ...basePegScoreResult, ...pegRecord } as never) : null,
      liquidityData: undefined,
      yieldRanking: null,
      stressSignal: null,
      reportCard: null,
      verdict: { archetype: "uncategorized", label: "Uncategorized" },
      resolvedMechanismArchetype: null,
      mintAuthority,
      redemptionBackstop,
    });
  }

  it("omits the case-study callout for a coin that is no study's subject", () => {
    expect(buildPassportHero().caseStudyCallout).toBeNull();
  });

  it("adds the Issued field only for loose-valid launch dates", () => {
    expect(
      buildPassportHero({ coin: { launchDate: "2018-09-26" } }).passportItems.find((item) => item.key === "issued"),
    ).toMatchObject({
      category: "Issued",
      value: "2018",
      href: "#info",
      ariaLabel: "Issued: launched September 26, 2018 — jump to the coin overview",
    });

    // Absent or malformed dates omit the field instead of faking it — the
    // launchDate population sweep fills the dataset coin-by-coin.
    expect(buildPassportHero().passportItems.some((item) => item.key === "issued")).toBe(false);
    for (const malformed of ["2018", "2018-9-26", "2018-13-45", "September 26, 2018"]) {
      expect(
        buildPassportHero({ coin: { launchDate: malformed } }).passportItems.some((item) => item.key === "issued"),
      ).toBe(false);
    }
  });

  it("points the Jurisdiction field at the Regulatory standing module once a regime is reviewed", () => {
    // `#jurisdiction` is owned by that module's below-xl fold (rail twin at
    // xl+), so the link only renders a target when a regime profile exists.
    expect(
      buildPassportHero({ coin: { mica: { status: "authorized" } } }).passportItems.find(
        (item) => item.key === "jurisdiction",
      )?.href,
    ).toBe("#jurisdiction");
    expect(
      buildPassportHero().passportItems.find((item) => item.key === "jurisdiction")?.href,
    ).toBe("#info");
  });

  it("builds the MiCA visa field with historical framing for frozen assets", () => {
    expect(
      buildPassportHero({ coin: { mica: { status: "pending" } } }).passportItems.find((item) => item.key === "mica"),
    ).toMatchObject({
      category: "MiCA",
      value: "Pending",
      href: "#jurisdiction",
      valueClass: "text-amber-700 dark:text-amber-400",
      ariaLabel: "MiCA status: Pending — jump to jurisdiction details",
    });

    const frozenMica = buildPassportHero({
      coin: { status: "frozen", mica: { status: "authorized" } },
    }).passportItems.find((item) => item.key === "mica");
    expect(frozenMica?.ariaLabel).toBe("Historical MiCA status: Authorized — jump to jurisdiction details");

    expect(buildPassportHero().passportItems.some((item) => item.key === "mica")).toBe(false);
  });

  it("builds the GENIUS pathway field and omits noise statuses", () => {
    expect(
      buildPassportHero({
        coin: { genius: { authorizationStatus: "official-application-pending" } },
      }).passportItems.find((item) => item.key === "genius"),
    ).toMatchObject({
      category: "GENIUS",
      value: "Filing Pending",
      href: "/compliance/?regime=genius",
      ariaLabel: `GENIUS Act pathway: Filing Pending (regime effective ${GENIUS_REGIME_STATE.effectiveDate}) — view the Compliance Tracker`,
    });

    // not-applicable / unknown statuses are noise words, not passport facts.
    for (const excluded of ["not-applicable", "unknown"]) {
      expect(
        buildPassportHero({ coin: { genius: { authorizationStatus: excluded } } }).passportItems.some(
          (item) => item.key === "genius",
        ),
      ).toBe(false);
    }
    expect(buildPassportHero().passportItems.some((item) => item.key === "genius")).toBe(false);
  });

  it("builds the peg Record field with honest omissions", () => {
    const zeroRecorded = buildPassportHero({ pegRecord: { eventCount: 0 } }).passportItems.find(
      (item) => item.key === "record",
    );
    expect(zeroRecorded).toMatchObject({
      category: "Record",
      value: "0 recorded",
      href: "#depeg-history",
      ariaLabel: "Peg record: no depeg incidents recorded in the score coverage window — jump to Depeg History",
    });
    expect(zeroRecorded?.valueClass).toBeUndefined();

    expect(
      buildPassportHero({ pegRecord: { eventCount: 1 } }).passportItems.find((item) => item.key === "record"),
    ).toMatchObject({
      value: "1 incident",
      ariaLabel: "Peg record: 1 depeg incident in the score coverage window — jump to Depeg History",
    });
    // History, not an alarm: a non-zero count keeps the default foreground tone.
    const several = buildPassportHero({ pegRecord: { eventCount: 3 } }).passportItems.find(
      (item) => item.key === "record",
    );
    expect(several).toMatchObject({
      value: "3 incidents",
      ariaLabel: "Peg record: 3 depeg incidents in the score coverage window — jump to Depeg History",
    });
    expect(several?.valueClass).toBeUndefined();

    // Limited coverage, NAV tokens, and missing peg summaries omit the field.
    expect(
      buildPassportHero({ pegRecord: { eventCount: 2, depegEventCoverageLimited: true } }).passportItems.some(
        (item) => item.key === "record",
      ),
    ).toBe(false);
    expect(
      buildPassportHero({ pegRecord: { eventCount: 0 }, isNavToken: true }).passportItems.some(
        (item) => item.key === "record",
      ),
    ).toBe(false);
    expect(buildPassportHero().passportItems.some((item) => item.key === "record")).toBe(false);
  });

  it("orders the max-field passport set per the document contract", () => {
    const hero = buildPassportHero({
      coin: {
        collateral: "Cash and T-Bills",
        pegMechanism: "Issuer redemption at par",
        proofOfReserves: { type: "attestation", url: "https://example.com", attestorTier: "big4" },
        launchDate: "2018-09-26",
        mica: { status: "authorized" },
        genius: { authorizationStatus: "issuer-announced-intent" },
      },
      pegRecord: { eventCount: 0 },
      mintAuthority: {
        status: "reviewed",
        mintPathLabel: "Issuer direct mint",
        mintPathShortLabel: "Issuer direct",
      } as HeroBuilderParams["mintAuthority"],
      redemptionBackstop: { accessModel: "issuer-api" } as HeroBuilderParams["redemptionBackstop"],
    });

    // Two scan clusters: how the token works, then who stands behind it.
    expect(hero.passportItems.map((item) => item.key)).toEqual([
      "mechanism",
      "redeemability",
      "minting",
      "freeze",
      "record",
      "chains",
      "jurisdiction",
      "mica",
      "genius",
      "attestor",
      "issued",
    ]);
  });
});

