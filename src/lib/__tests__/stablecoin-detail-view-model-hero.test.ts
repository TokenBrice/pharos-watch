import { afterEach, describe, expect, it, vi } from "vitest";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildCoinTrackerLink } from "@/lib/coin-tracker-links";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildDetailHero } from "./stablecoin-detail-view-model.test-support";
import { DIRECTION_TONE_CLASSES } from "@shared/lib/classification";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";

const quietDeviations = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("@/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feature-flags")>();
  return { ...actual, isQuietDeviationsEnabled: () => quietDeviations.value ?? actual.isQuietDeviationsEnabled() };
});

describe("stablecoin detail hero view-model builder", () => {
  const SAVED = {
    grade: "A-" as const, score: 81, dewsScore: 17, dewsBand: "WATCH" as const, liquidityScore: 67,
    asOfMs: Date.UTC(2026, 9, 22, 8),
  };
  const ALL_PENDING = { reportCard: true, stress: true, liquidity: true, peg: true, yield: true };

  it("shows dated release values or neutral placeholders while live reads are pending, never unavailable", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const pending = buildDetailHero({ coin, pendingReads: ALL_PENDING, savedAssessment: null });
    const tile = (hero: typeof pending, key: string) => hero.tertiaryMetrics.find((metric) => metric.key === key)!.display;
    for (const key of ["dews", "peg-score", "liquidity", "excess-yield"]) {
      expect(tile(pending, key)).toMatchObject({ value: "", pending: true });
    }
    expect(pending.savedGrade).toBeNull();
    expect(pending.signalRailItems.find((item) => item.key === "liquidity")).toMatchObject({ pending: true });

    const saved = buildDetailHero({ coin, pendingReads: ALL_PENDING, savedAssessment: SAVED });
    expect(tile(saved, "dews")).toMatchObject({ value: "Watch", band: "WATCH", sub: "17/100 · as of 2026-10-22" });
    expect(tile(saved, "liquidity")).toMatchObject({ value: "67", sub: "as of 2026-10-22" });
    expect(tile(saved, "peg-score")).toMatchObject({ pending: true });
    expect(saved.savedGrade).toBe(SAVED);
    expect(saved.signalRailItems[0]).toMatchObject({ key: "safety", primary: "A-", secondary: "81/100", note: "as of 2026-10-22" });

    // Settled reads keep their own verdicts; a saved value never stands in for them.
    const settled = buildDetailHero({ coin, savedAssessment: SAVED });
    expect(tile(settled, "dews")).toMatchObject({ value: "—" });
    expect(tile(settled, "liquidity")).toMatchObject({ value: "—" });
    expect(settled.savedGrade).toBeNull();
    expect(settled.signalRailItems[0]).toMatchObject({ primary: "—" });
    expect(settled.signalRailItems[0]?.note).toBeUndefined();
  });

  it("keeps NAV tokens and frozen archives out of the pending peg and DEWS reads", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const nav = buildDetailHero({ coin, isNavToken: true, pendingReads: ALL_PENDING, savedAssessment: SAVED });
    expect(nav.tertiaryMetrics.find((metric) => metric.key === "dews")!.display).toMatchObject({ value: "—" });
    expect(nav.tertiaryMetrics.find((metric) => metric.key === "peg-score")!.display).toMatchObject({ value: "NAV" });
  });

  it.each([900, null])("keeps native current paired with its checkpoints rather than mixing displayed supply %s", (supply) => {
    const hero = buildDetailHero({
      coin: TRACKED_META_BY_ID.get("usdc-circle")!,
      supply,
      nativeSupply: { current: 1_100, prevWeek: 1_000, prevMonth: 950 },
    });

    expect(hero.market.supply).toBe(supply);
    expect(hero.market.supplyTrend).toMatchObject({
      current: 1_100,
      safePrevWeek: 1_000,
      safePrevMonth: 950,
      hasPrevMonth: true,
    });
    expect(hero.market.supplyTrend.prevWeekTrendClass).toContain("text-green-700");
    expect(hero.market.supplyTrend.prevMonthTrendClass).toContain("text-green-700");
  });

  it("derives hero display metrics and signal rail from raw detail inputs", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(coin).toBeDefined();

    const hero = buildDetailHero({
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
      nativeSupply: { current: 500_000, prevWeek: 450_000, prevMonth: 0 },
      performanceVsUsd1y: 12.34,
      pegRef: 1,
      deviationBps: -300,
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

    expect(hero.market.supplyTrend.safePrevMonth).toBeNull();
    expect(hero.market.prevDayTrendClass).toContain("text-red-700");
    expect(hero.market.supplyTrend.prevWeekTrendClass).toContain("text-green-700");
    expect(hero.price.limitedDepegCoverageNote).toContain("Below $1.00M live-event floor");

    const pegMetric = hero.tertiaryMetrics.find((metric) => metric.key === "peg-score");
    expect(pegMetric?.display).toMatchObject({
      value: "45",
      // Coverage-limited history: no incident count is published, so the
      // sub-line falls back to the at-peg reading.
      sub: "99.4% at peg",
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

  it("does not publish a zero incident count for coverage-limited peg evidence", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const pegDisplay = (hero: ReturnType<typeof buildDetailHero>) =>
      hero.tertiaryMetrics.find((metric) => metric.key === "peg-score")!.display;

    const limited = buildDetailHero({
      coin,
      pegScoreResult: makePegSummaryCoin({
        id: coin.id, symbol: coin.symbol, pegScore: 100, pegPct: 100,
        eventCount: 0, trackingSpanDays: 365, depegEventCoverageLimited: true,
      }),
    });
    expect(pegDisplay(limited).sub).toBe("100.0% at peg");
    expect(pegDisplay(limited).sub).not.toContain("incidents");

    const observed = buildDetailHero({
      coin,
      pegScoreResult: makePegSummaryCoin({
        id: coin.id, symbol: coin.symbol, pegScore: 100, pegPct: 100, eventCount: 0, trackingSpanDays: 365,
      }),
    });
    expect(pegDisplay(observed).sub).toBe("0 incidents");
  });

  it("marks a numeric peg score under 30 tracking days as early, never as amber", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const pegDisplay = (trackingSpanDays: number) =>
      buildDetailHero({
        coin,
        pegScoreResult: makePegSummaryCoin({
          id: coin.id, symbol: coin.symbol, pegScore: 100, pegPct: 100, eventCount: 0, trackingSpanDays,
        }),
      }).tertiaryMetrics.find((metric) => metric.key === "peg-score")!.display;

    expect(pegDisplay(10)).toMatchObject({
      value: "100",
      sub: "Early score · 10d tracked",
      color: "text-muted-foreground",
    });
    expect(pegDisplay(10).sub).not.toContain("incidents");
    expect(pegDisplay(29).sub).toBe("Early score · 29d tracked");
    expect(pegDisplay(30).sub).toBe("0 incidents");
  });

  it("derives unavailable peg score and upstream freeze states", () => {
    const coin = TRACKED_META_BY_ID.get("dai-makerdao");
    expect(coin).toBeDefined();

    const hero = buildDetailHero({
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
      mintAuthority: {
        status: "reviewed",
        mintPathLabel: "User-collateralized, governed",
        mintPathShortLabel: "Governed CDP",
      } as never,
    });

    expect(hero.tertiaryMetrics.find((metric) => metric.key === "peg-score")?.display).toMatchObject({
      value: "NR",
      sub: "3d tracked",
    });
    // DAI has no reviewed Freeze & seizure card and is not blacklist-tracked,
    // so the chip leaves for the FreezeWatch coverage page — never the
    // mint-authority section.
    expect(hero.passportItems.find((item) => item.key === "freeze")).toMatchObject({
      value: "Upstream",
      href: buildCoinTrackerLink("dai-makerdao", "freezewatch", "DAI").href,
    });
    const reviewedFreezeHero = buildDetailHero({
      coin: { ...coin!, blacklistabilitySummary: {} as never },
      reportCard: makeV9Card({ id: "dai-makerdao" }),
    });
    expect(reviewedFreezeHero.passportItems.find((item) => item.key === "freeze")?.href).toBe("#freeze-seizure");
    // No redemption backstop record -> the redeemability entry is omitted.
    expect(hero.passportItems.some((item) => item.key === "redeemability")).toBe(false);
  });

  it("uses reviewed FreezeWatch status before stale V9 freeze exposure in the hero passport", () => {
    const coin = TRACKED_META_BY_ID.get("lusd-liquity");
    expect(coin).toBeDefined();

    const hero = buildDetailHero({
      coin: coin!,
      coinData: {
        id: "lusd-liquity",
        name: "Liquity USD",
        symbol: "LUSD",
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 100 },
        chains: [],
      } as never,
      reportCard: makeV9Card({
        id: "lusd-liquity",
        accessPosture: {
          ...makeV9Card().accessPosture,
          freezeExposure: "possible",
        },
      }),
      mintAuthority: {
        status: "not-reviewed",
      } as never,
    });

    expect(hero.passportItems.find((item) => item.key === "freeze")).toMatchObject({
      value: "No",
    });
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

    const hero = buildDetailHero({
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
    expect(byKey.get("attestor")).toMatchObject({
      value: "Big-4",
      href: "#attestation",
      ariaLabel: "Reserve report: Independent Report; Big-4 attestor — jump to Proof of Reserves",
    });
    // No curated MiCA/GENIUS profile on this fixture, so jurisdiction has no
    // Regulatory standing module to target.
    expect(byKey.get("jurisdiction")).toMatchObject({ value: "Switzerland", href: "#info" });
    expect(byKey.get("chains")).toMatchObject({ value: "3", href: "#contracts", chip: true });

    // A decentralized coin omits the attestor chip (it publishes no reserve
    // attestation) and routes jurisdiction to the overview section.
    const decentralizedHero = buildDetailHero({
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
      resolvedMechanismArchetype: "cdp",
      mintAuthority: {
        status: "reviewed",
        mintPathLabel: "User-collateralized, governed",
        mintPathShortLabel: "Governed CDP",
      } as never,
    });

    const decentralizedByKey = new Map(decentralizedHero.passportItems.map((item) => [item.key, item]));
    expect(decentralizedByKey.has("attestor")).toBe(false);
    expect(decentralizedByKey.get("jurisdiction")?.href).toBe("#info");
  });

  type HeroBuilderParams = Parameters<typeof buildDetailHero>[0];

  // Shared scaffold for the attestor / MiCA / GENIUS / Record passport cases:
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
    return buildDetailHero({
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
      pegScoreResult: pegRecord ? makePegSummaryCoin({ id: "mock-passport", symbol: "MPP", ...pegRecord }) : null,
      mintAuthority,
      redemptionBackstop,
    });
  }

  it.each<{
    name: string;
    input: Parameters<typeof buildPassportHero>[0];
    key: string;
    expected: Record<string, unknown>;
    unstyled?: boolean;
  }>([
    {
      name: "distinguishes a reviewed absence of an attestor", key: "attestor",
      input: { coin: { proofOfReserves: { type: "self-reported", url: "https://example.com", attestorTier: "none" } } },
      expected: {
        value: "None", valueClass: "text-red-700 dark:text-red-400",
        ariaLabel: "Reserve report: Self-Reported PoR; No attestation — jump to Proof of Reserves",
      },
    },
    {
      name: "keeps an undisclosed attestor muted rather than claiming None", key: "attestor",
      input: { coin: { proofOfReserves: { type: "self-reported", url: "https://example.com", attestorTier: "undisclosed" } } },
      expected: {
        value: "Not disclosed", valueClass: "text-muted-foreground",
        ariaLabel: "Reserve report: Self-Reported PoR; Not disclosed — jump to Proof of Reserves",
      },
    },
    {
      name: "names the reviewed examination beside the tier in the accessible name", key: "attestor",
      input: {
        coin: {
          proofOfReserves: {
            type: "independent-audit", url: "https://example.com", provider: "Example CPA", attestorTier: "regional",
            latestReport: {
              periodEnd: "2026-09-30", assuranceMethod: "examination", scope: "assets-and-liabilities",
              liabilityReconciliation: "full", reviewer: "test", confidence: "verified",
              sources: [{ label: "Report", url: "https://example.com/report" }],
            },
          },
        },
      },
      expected: {
        value: "Regional CPA", valueClass: "text-blue-700 dark:text-blue-400",
        ariaLabel: "Reserve report: Examination; Regional CPA — jump to Proof of Reserves",
      },
    },
    {
      name: "names a reviewed audit engagement", key: "attestor",
      input: {
        coin: {
          proofOfReserves: {
            type: "independent-audit", url: "https://example.com", attestorTier: "big4",
            latestReport: {
              periodEnd: "2026-09-30", assuranceMethod: "audit", scope: "assets-and-liabilities",
              liabilityReconciliation: "full", reviewer: "test", confidence: "verified",
              sources: [{ label: "Report", url: "https://example.com/report" }],
            },
          },
        },
      },
      expected: {
        value: "Big-4", valueClass: "text-emerald-700 dark:text-emerald-400",
        ariaLabel: "Reserve report: Audit; Big-4 attestor — jump to Proof of Reserves",
      },
    },
    {
      name: "uses the resolved engagement as the value without a tier", key: "attestor",
      input: {
        coin: {
          proofOfReserves: {
            type: "independent-audit", url: "https://example.com",
            latestReport: {
              periodEnd: "2026-09-30", assuranceMethod: "examination", scope: "assets-and-liabilities",
              liabilityReconciliation: "full", reviewer: "test", confidence: "verified",
              sources: [{ label: "Report", url: "https://example.com/report" }],
            },
          },
        },
      },
      expected: {
        value: "Examination",
        ariaLabel: "Reserve report: Examination — jump to Proof of Reserves",
      },
    },
    {
      name: "does not assert an audit for an unresolved method without a tier", key: "attestor",
      input: { coin: { proofOfReserves: { type: "independent-audit", url: "https://example.com" } } },
      expected: {
        value: "Independent Report",
        ariaLabel: "Reserve report: Independent Report — jump to Proof of Reserves",
      },
    },
    {
      name: "builds the pending MiCA visa", key: "mica",
      input: { coin: { mica: { status: "pending" } } },
      expected: {
        category: "MiCA", value: "Pending", href: "#jurisdiction",
        valueClass: "text-amber-700 dark:text-amber-400",
        ariaLabel: "MiCA status: Pending — jump to jurisdiction details",
      },
    },
    {
      name: "builds the GENIUS filing pathway", key: "genius",
      input: { coin: { genius: { authorizationStatus: "official-application-pending" } } },
      expected: {
        category: "GENIUS", value: "Filing Pending", href: "/compliance/?regime=genius",
        ariaLabel: `GENIUS Act pathway: Filing Pending (regime effective ${GENIUS_REGIME_STATE.effectiveDate}) — view the Compliance Tracker`,
      },
    },
    {
      name: "records zero incidents without an alarm tone", key: "record",
      input: { pegRecord: { eventCount: 0 } }, unstyled: true,
      expected: {
        category: "Record", value: "0 recorded", href: "#depeg-history",
        ariaLabel: "Peg record: no depeg incidents recorded in the score coverage window — jump to Depeg History",
      },
    },
    {
      name: "records one incident with singular copy", key: "record",
      input: { pegRecord: { eventCount: 1 } },
      expected: {
        value: "1 incident",
        ariaLabel: "Peg record: 1 depeg incident in the score coverage window — jump to Depeg History",
      },
    },
    {
      name: "records several incidents without an alarm tone", key: "record",
      input: { pegRecord: { eventCount: 3 } }, unstyled: true,
      expected: {
        value: "3 incidents",
        ariaLabel: "Peg record: 3 depeg incidents in the score coverage window — jump to Depeg History",
      },
    },
  ])("$name", ({ input, key, expected, unstyled }) => {
    const item = buildPassportHero(input).passportItems.find((item) => item.key === key);
    expect(item).toMatchObject(expected);
    if (unstyled) expect(item?.valueClass).toBeUndefined();
  });

  it("omits the Chains fact for a coin with no curated contract record", () => {
    const coin = TRACKED_META_BY_ID.get("hbd-hive")!;
    expect(coin.contracts).toBeUndefined();

    const hero = buildDetailHero({ coin });

    expect(hero.passportItems.some((item) => item.key === "chains")).toBe(false);
    expect(hero.passportItems.every((item) => !/Deployed on 0 chains/.test(item.ariaLabel))).toBe(true);
  });

  it("frames frozen MiCA authorization as historical", () => {
    const frozenMica = buildPassportHero({
      coin: { status: "frozen", mica: { status: "authorized" } },
    }).passportItems.find((item) => item.key === "mica");
    expect(frozenMica?.ariaLabel).toBe("Historical MiCA status: Authorized — jump to jurisdiction details");
  });

  it.each<{ name: string; input: Parameters<typeof buildPassportHero>[0]; key: string }>([
    { name: "absent MiCA profile", input: undefined, key: "mica" },
    { name: "not-applicable GENIUS pathway", input: { coin: { genius: { authorizationStatus: "not-applicable" } } }, key: "genius" },
    { name: "unknown GENIUS pathway", input: { coin: { genius: { authorizationStatus: "unknown" } } }, key: "genius" },
    { name: "absent GENIUS profile", input: undefined, key: "genius" },
    { name: "coverage-limited peg record", input: { pegRecord: { eventCount: 2, depegEventCoverageLimited: true } }, key: "record" },
    { name: "NAV-token peg record", input: { pegRecord: { eventCount: 0 }, isNavToken: true }, key: "record" },
    { name: "missing peg summary", input: undefined, key: "record" },
  ])("omits $name instead of claiming a passport fact", ({ input, key }) => {
    expect(buildPassportHero(input).passportItems.some((item) => item.key === key)).toBe(false);
  });

});

describe("hero trend direction follows the printed percentage", () => {
  afterEach(() => { quietDeviations.value = null; });
  const coin = TRACKED_META_BY_ID.get("usdc-circle")!;

  it.each([false, true])("keeps rounded zero neutral and real moves directional (quiet=%s)", (quiet) => {
    quietDeviations.value = quiet;
    const trend = (mcap: number, prevDay: number) => buildDetailHero({ coin, mcap, prevDay }).market.prevDayTrendClass;
    expect(trend(100, 100)).toBe("text-muted-foreground");
    expect(trend(99.999, 100)).toBe("text-muted-foreground");
    expect(trend(100.001, 100)).toBe("text-muted-foreground");
    expect(trend(99, 100)).toBe(DIRECTION_TONE_CLASSES.down);
    expect(trend(101, 100)).toBe(DIRECTION_TONE_CLASSES.up);
    expect(trend(0, 100)).toBe(DIRECTION_TONE_CLASSES.down);
    // Within the quiet threshold only the flag decides; outside it the sign does.
    expect(trend(100.2, 100)).toBe(quiet ? "text-muted-foreground" : DIRECTION_TONE_CLASSES.up);
  });

  it("withholds the 24h change when current supply is partial", () => {
    const base = buildDetailHero({ coin }).coinData;
    const hero = buildDetailHero({ coin, mcap: 99, prevDay: 100, coinData: { ...base, supplyExcludedChains: ["HyperEVM"] } });
    expect(hero.market.safePrevDay).toBeNull();
    expect(hero.market.prevDayTrendClass).toBe("text-muted-foreground");
  });

  it("stays muted without a previous value", () => {
    expect(buildDetailHero({ coin, mcap: 100, prevDay: null }).market.prevDayTrendClass).toBe("text-muted-foreground");
  });
});

describe("excess-yield tile help", () => {
  it("binds the 30d Excess tile to the excess-yield definition, not PYS, keeping its label", () => {
    const hero = buildDetailHero({ coin: TRACKED_META_BY_ID.get("usdt-tether")! });
    const metric = hero.tertiaryMetrics.find((entry) => entry.key === "excess-yield")!;
    expect(metric).toMatchObject({ label: "30d Excess", methodologyTopic: "excessYield" });
    expect(METHODOLOGY_CONTEXT.excessYield).toMatchObject({
      title: "Excess yield",
      summary: "30-day average APY minus its benchmark rate.",
    });
  });
});
