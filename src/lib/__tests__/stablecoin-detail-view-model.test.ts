import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinDetailHeroViewModel, buildStablecoinDetailViewModel } from "../stablecoin-detail-view-model";

type BuildStablecoinDetailViewModelParams = Parameters<typeof buildStablecoinDetailViewModel>[0];

type BuildStablecoinDetailViewModelOverrides = {
  core?: Partial<BuildStablecoinDetailViewModelParams["core"]>;
  queries?: {
    supplyHistory?: Partial<BuildStablecoinDetailViewModelParams["queries"]["supplyHistory"]>;
    stablecoinList?: Partial<BuildStablecoinDetailViewModelParams["queries"]["stablecoinList"]>;
    pegSummary?: Partial<BuildStablecoinDetailViewModelParams["queries"]["pegSummary"]>;
    dexLiquidity?: Partial<BuildStablecoinDetailViewModelParams["queries"]["dexLiquidity"]>;
    reportCards?: Partial<BuildStablecoinDetailViewModelParams["queries"]["reportCards"]>;
    redemptionBackstops?: Partial<BuildStablecoinDetailViewModelParams["queries"]["redemptionBackstops"]>;
  };
  supplemental?: {
    yieldRankingsData?: BuildStablecoinDetailViewModelParams["supplemental"]["yieldRankingsData"];
    stressSignalsData?: BuildStablecoinDetailViewModelParams["supplemental"]["stressSignalsData"];
    flows?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["flows"]>;
    blacklist?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["blacklist"]>;
    reserves?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["reserves"]>;
    nowMs?: number;
  };
};

function makeBuildStablecoinDetailViewModelParams(
  overrides: BuildStablecoinDetailViewModelOverrides,
): BuildStablecoinDetailViewModelParams {
  const coin = overrides.core?.coin ?? TRACKED_META_BY_ID.get("usdt-tether")!;
  const id = overrides.core?.id ?? coin.id;

  return {
    core: {
      id,
      coin,
      summary: null,
      handleRetryAll: () => {},
      ...overrides.core,
    },
    queries: {
      supplyHistory: {
        data: [],
        isLoading: false,
        error: null,
        ...overrides.queries?.supplyHistory,
      },
      stablecoinList: {
        data: { peggedAssets: [] } as never,
        isLoading: false,
        isError: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.queries?.stablecoinList,
      },
      pegSummary: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.pegSummary,
      },
      dexLiquidity: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.dexLiquidity,
      },
      reportCards: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.reportCards,
      },
      redemptionBackstops: {
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        meta: null,
        ...overrides.queries?.redemptionBackstops,
      },
    },
    supplemental: {
      flows: {
        data: undefined,
        isLoading: false,
        ...overrides.supplemental?.flows,
      },
      blacklist: {
        summary: undefined,
        isLoading: false,
        ...overrides.supplemental?.blacklist,
      },
      reserves: {
        live: null,
        error: null,
        ...overrides.supplemental?.reserves,
      },
      yieldRankingsData: overrides.supplemental?.yieldRankingsData,
      stressSignalsData: overrides.supplemental?.stressSignalsData,
      nowMs: overrides.supplemental?.nowMs,
    },
  };
}

describe("stablecoin detail view-model builder", () => {
  it("builds a ready view model from fetched inputs", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "usdt-tether",
          coin: coin!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: null }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "usdt-tether",
                  name: "Tether",
                  symbol: "USDT",
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 100 },
                  circulatingPrevDay: { peggedUSD: 90 },
                  circulatingPrevWeek: { peggedUSD: 80 },
                  circulatingPrevMonth: { peggedUSD: 70 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
          pegSummary: {
            data: {
              summary: {} as never,
              coins: [{ id: "usdt-tether", pegScore: 99 }],
            } as never,
            dataUpdatedAt: 1,
          },
          dexLiquidity: {
            data: {
              "usdt-tether": { liquidityScore: 88 },
            } as never,
            dataUpdatedAt: 1,
          },
          reportCards: {
            data: {
              cards: [{ id: "usdt-tether", overallScore: 90, dimensions: {} }],
              dependencyGraph: { nodes: [], edges: [] },
            } as never,
            dataUpdatedAt: 1,
          },
        },
        supplemental: {
          flows: {
            data: {
              gauge: { score: 0, band: "neutral" },
              coins: [{ stablecoinId: "usdt-tether" }],
              hourly: [],
            } as never,
          },
          nowMs: 1_700_000_000_000,
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.id).toBe("usdt-tether");
    expect(viewModel.mcap).toBe(100);
    expect(viewModel.prevDay).toBe(90);
    expect(viewModel.performanceVsUsd1y).toBeNull();
    expect(viewModel.hasFlows).toBe(true);
    expect(viewModel.pegScoreResult?.pegScore).toBe(99);
    expect(viewModel.hasYieldSection).toBe(false);
  });

  it("wires the selected redemption backstop and stale-query state", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "usdt-tether",
          coin: coin!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "usdt-tether",
                  name: "Tether",
                  symbol: "USDT",
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 100 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
          redemptionBackstops: {
            data: {
              coins: {
                "usdt-tether": {
                  stablecoinId: "usdt-tether",
                  score: null,
                  eventualRedeemabilityScore: 65,
                  effectiveExitScore: 72,
                  resolutionState: "resolved",
                  routeFamily: "offchain-issuer",
                },
              },
              updatedAt: 1_700_000_000,
            } as never,
            dataUpdatedAt: 12_345,
            meta: { source: "test" },
          },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.redemptionBackstop?.stablecoinId).toBe("usdt-tether");
    expect(viewModel.redemptionBackstop?.effectiveExitScore).toBe(72);
    expect(viewModel.staleQueries.find((query) => query.preset === "redemptionBackstops")).toMatchObject({
      dataUpdatedAt: 12_345,
      hasData: true,
      meta: { source: "test" },
    });
  });

  it("enables the yield section for non-yield-bearing coins when a live ranking exists", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(coin).toBeDefined();
    expect(coin?.flags.yieldBearing).toBe(false);

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "usdc-circle",
          coin: coin!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "usdc-circle",
                  name: "USD Coin",
                  symbol: "USDC",
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 100 },
                  circulatingPrevDay: { peggedUSD: 95 },
                  circulatingPrevWeek: { peggedUSD: 90 },
                  circulatingPrevMonth: { peggedUSD: 85 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
        },
        supplemental: {
          yieldRankingsData: {
            rankings: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                name: "USD Coin",
                currentApy: 4.2,
                apy7d: 4.2,
                apy30d: 4.1,
                apyBase: 4.2,
                apyReward: null,
                yieldSource: "Aave v3",
                yieldType: "lending-opportunity",
                dataSource: "defillama-auto",
                sourceTvlUsd: 1_000_000,
                pharosYieldScore: 50,
                safetyScore: 82,
                safetyGrade: "A-",
                yieldToRisk: 0.2,
                excessYield: 0.5,
                yieldStability: 0.9,
                apyVariance30d: 0.1,
                apyMin30d: 3.9,
                apyMax30d: 4.3,
                warningSignals: [],
                altSources: [],
              },
            ],
          } as never,
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.yieldRanking?.id).toBe("usdc-circle");
    expect(viewModel.hasYieldSection).toBe(true);
  });

  it("exposes tracked variant parent and parent-side child variants", () => {
    const variant = TRACKED_META_BY_ID.get("susds-sky");
    const parent = TRACKED_META_BY_ID.get("usds-sky");
    expect(variant).toBeDefined();
    expect(parent).toBeDefined();

    const variantViewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "susds-sky",
          coin: variant!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "susds-sky",
                  name: "Sky Savings USDS",
                  symbol: "sUSDS",
                  pegType: "peggedUSD",
                  price: 1.02,
                  circulating: { peggedUSD: 100 },
                  circulatingPrevDay: { peggedUSD: 98 },
                  circulatingPrevWeek: { peggedUSD: 96 },
                  circulatingPrevMonth: { peggedUSD: 92 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
        },
      }),
    );

    expect(variantViewModel.status).toBe("ready");
    if (variantViewModel.status !== "ready") return;
    expect(variantViewModel.variantParent?.id).toBe("usds-sky");
    expect(variantViewModel.isVariant).toBe(true);
    expect(variantViewModel.variantSiblings.map((coin) => coin.id)).toContain("stusds-sky");

    const parentViewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "usds-sky",
          coin: parent!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "usds-sky",
                  name: "Sky Dollar",
                  symbol: "USDS",
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 100 },
                  circulatingPrevDay: { peggedUSD: 99 },
                  circulatingPrevWeek: { peggedUSD: 98 },
                  circulatingPrevMonth: { peggedUSD: 97 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
        },
      }),
    );

    expect(parentViewModel.status).toBe("ready");
    if (parentViewModel.status !== "ready") return;
    expect(parentViewModel.hasVariants).toBe(true);
    expect(parentViewModel.childVariants.map((coin) => coin.id)).toEqual(["susds-sky", "stusds-sky"]);
  });

  it("enables the yield section for commodity assets when a live ranking exists", () => {
    const coin = TRACKED_META_BY_ID.get("xaut-tether");
    expect(coin).toBeDefined();
    expect(coin?.flags.yieldBearing).toBe(false);
    expect(coin?.flags.pegCurrency).toBe("GOLD");

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "xaut-tether",
          coin: coin!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 3_000 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "xaut-tether",
                  name: "Tether Gold",
                  symbol: "XAUT",
                  pegType: "peggedGOLD",
                  price: 3_000,
                  circulating: { peggedGOLD: 100 },
                  circulatingPrevDay: { peggedGOLD: 98 },
                  circulatingPrevWeek: { peggedGOLD: 96 },
                  circulatingPrevMonth: { peggedGOLD: 92 },
                },
              ],
              fxFallbackRates: { peggedGOLD: 3_000 },
            } as never,
            dataUpdatedAt: 1,
          },
        },
        supplemental: {
          yieldRankingsData: {
            rankings: [
              {
                id: "xaut-tether",
                symbol: "XAUT",
                name: "Tether Gold",
                currentApy: 11,
                apy7d: 11,
                apy30d: 11,
                apyBase: 1,
                apyReward: 10,
                yieldSource: "Yo Protocol",
                yieldType: "lending-opportunity",
                dataSource: "defillama",
                sourceTvlUsd: 3_000_000,
                pharosYieldScore: 48,
                safetyScore: 73,
                safetyGrade: "B",
                yieldToRisk: 0.39,
                excessYield: 7.2,
                yieldStability: 0.98,
                apyVariance30d: 0.2,
                apyMin30d: 10.9,
                apyMax30d: 11.3,
                warningSignals: [],
                altSources: [],
              },
            ],
          } as never,
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.yieldRanking?.id).toBe("xaut-tether");
    expect(viewModel.hasYieldSection).toBe(true);
  });

  it("derives 1Y vs USD performance for eligible non-USD pegs", () => {
    const coin = TRACKED_META_BY_ID.get("zchf-frankencoin");
    expect(coin).toBeDefined();

    const nowSec = 1_720_000_000;
    const anchorSec = nowSec - 365 * 24 * 60 * 60;

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "zchf-frankencoin",
          coin: coin!,
        },
        queries: {
          supplyHistory: {
            data: [
              { date: anchorSec, circulatingUsd: 98, price: 0.98 },
              { date: nowSec - 7 * 24 * 60 * 60, circulatingUsd: 110, price: 1.1 },
            ],
          },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "zchf-frankencoin",
                  name: "Frankencoin",
                  symbol: "ZCHF",
                  pegType: "peggedCHF",
                  price: 1.12,
                  circulating: { peggedCHF: 100 },
                  circulatingPrevDay: { peggedCHF: 99 },
                  circulatingPrevWeek: { peggedCHF: 97 },
                  circulatingPrevMonth: { peggedCHF: 95 },
                },
              ],
              fxFallbackRates: { peggedCHF: 1.12 },
            } as never,
            dataUpdatedAt: 1,
          },
        },
        supplemental: {
          nowMs: nowSec * 1000,
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.performanceVsUsd1y).toBeCloseTo((1.12 / 0.98 - 1) * 100, 6);
  });

  it("does not derive 1Y vs USD performance for NAV tokens", () => {
    const coin = TRACKED_META_BY_ID.get("cetes-etherfuse");
    expect(coin).toBeDefined();

    const nowSec = 1_720_000_000;
    const anchorSec = nowSec - 365 * 24 * 60 * 60;

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "cetes-etherfuse",
          coin: coin!,
        },
        queries: {
          supplyHistory: {
            data: [
              { date: anchorSec, circulatingUsd: 100, price: 0.05 },
              { date: nowSec - 7 * 24 * 60 * 60, circulatingUsd: 120, price: 0.06 },
            ],
          },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "cetes-etherfuse",
                  name: "Etherfuse CETES",
                  symbol: "CETES",
                  pegType: "peggedMXN",
                  price: 0.061,
                  circulating: { peggedMXN: 100 },
                  circulatingPrevDay: { peggedMXN: 99 },
                  circulatingPrevWeek: { peggedMXN: 97 },
                  circulatingPrevMonth: { peggedMXN: 95 },
                },
              ],
              fxFallbackRates: { peggedMXN: 0.061 },
            } as never,
            dataUpdatedAt: 1,
          },
        },
        supplemental: {
          nowMs: nowSec * 1000,
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.performanceVsUsd1y).toBeNull();
  });

  it("returns not-found when the stablecoin is absent from the list payload", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "usdt-tether",
          coin: coin!,
        },
        queries: {
          stablecoinList: {
            data: { peggedAssets: [] } as never,
            dataUpdatedAt: 1,
          },
        },
      }),
    );

    expect(viewModel.status).toBe("not-found");
  });

  it("preserves reserve fetch errors while still falling back to static reserve metadata", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "iusd-infinifi",
          coin: coin!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: null }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "iusd-infinifi",
                  name: "iUSD",
                  symbol: "iUSD",
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 100 },
                  circulatingPrevDay: { peggedUSD: 90 },
                  circulatingPrevWeek: { peggedUSD: 80 },
                  circulatingPrevMonth: { peggedUSD: 70 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
        },
        supplemental: {
          reserves: { error: new Error("reserve api failed") },
          nowMs: 1_700_000_000_000,
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.reserves?.mode).toBe("curated-fallback");
    expect(viewModel.reserveFetchError).toBeInstanceOf(Error);
  });
});

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
      pegScoreResult: {
        id: "usdc-circle",
        symbol: "USDC",
        pegScore: 45,
        pegPct: 99.4,
        eventCount: 2,
        currentBand: "CALM",
        trackingSpanDays: 365,
        activeDepeg: true,
        depegEventCoverageLimited: true,
      },
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
      reportCard: {
        overallGrade: "B+",
        overallScore: 79,
        rawInputs: {
          canBeBlacklisted: true,
          depegEventCount: 3,
        },
      } as never,
      verdict: {
        archetype: "distressed",
        label: "Distressed",
      },
    });

    expect(hero.header.coinName).toBe("USD Coin");
    expect(hero.chainCount).toBe(2);
    expect(hero.market.safePrevMonth).toBeNull();
    expect(hero.market.prevDayTrendClass).toContain("text-red-700");
    expect(hero.market.prevWeekTrendClass).toContain("text-green-700");
    expect(hero.price.limitedDepegCoverageNote).toContain("Below $1.00M live-event floor");

    const pegMetric = hero.tertiaryMetrics.find((metric) => metric.key === "peg-score");
    expect(pegMetric?.display).toMatchObject({
      value: "45",
      sub: "3 recorded · 2 in 4y window",
    });
    expect(pegMetric?.accentClass).toBe("border-l-2 border-l-red-500");

    expect(hero.tertiaryMetrics.find((metric) => metric.key === "performance-vs-usd")?.display.value).toBe("+12.34%");
    expect(hero.desktopTertiaryMetrics.map((metric) => metric.key)).not.toContain("dews");
    expect(hero.signalRailItems.find((item) => item.key === "safety")).toMatchObject({
      primary: "B+",
      secondary: "79/100",
    });
  });

  it("derives unavailable peg score and dilutable source states", () => {
    const coin = TRACKED_META_BY_ID.get("dai-makerdao");
    expect(coin).toBeDefined();

    const hero = buildStablecoinDetailHeroViewModel({
      coin: {
        ...coin!,
        canBeBlacklisted: "dilutable",
        canBeBlacklistedSource: {
          label: "Etherscan contract source",
          url: "https://etherscan.io/address/example#code",
        },
      },
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
      pegScoreResult: {
        id: "dai-makerdao",
        symbol: "DAI",
        pegScore: null,
        pegPct: 0,
        eventCount: 0,
        currentBand: "CALM",
        trackingSpanDays: 3,
        activeDepeg: false,
      },
      liquidityData: undefined,
      yieldRanking: null,
      stressSignal: null,
      reportCard: null,
      verdict: {
        archetype: "uncategorized",
        label: "Uncategorized",
      },
    });

    expect(hero.tertiaryMetrics.find((metric) => metric.key === "peg-score")?.display).toMatchObject({
      value: "NR",
      sub: "3d tracked",
    });
    expect(hero.tertiaryMetrics.find((metric) => metric.key === "blacklistable")?.display).toMatchObject({
      value: "Dilutable",
      methodologyTopic: "freezableDilutable",
      source: {
        label: "Etherscan contract source",
      },
    });
  });
});
