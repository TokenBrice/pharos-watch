import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { PegSummaryCoin, PegSummaryResponse } from "@shared/types";
import { makePegSummaryCoin as makePegSummaryCoinBase } from "@/test-utils/peg-summary-fixtures";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildStablecoinDetailViewModel } from "../stablecoin-detail-view-model";
import {
  makeBuildStablecoinDetailViewModelParams,
  makeReadyDetailParams,
} from "./fixtures/stablecoin-detail-view-model";
import { buildDetailPegPriceSnapshot, buildDetailStaleQueries } from "../stablecoin-detail-query-view-model";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { deriveDataHealth } from "../data-health";
import { DATA_HEALTH_PRESETS } from "../data-health-config";

function makePegSummaryCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return makePegSummaryCoinBase({
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether",
    ...overrides,
  });
}

describe("stablecoin detail view-model builder", () => {
  it("uses coin-scoped liquidity warnings without hiding stale producer data or legacy advisories", () => {
    const now = Date.now();
    const globalWarning = '199 - "Quality drift: major-tvl-cliff:crvusd-curve"';
    const params = makeBuildStablecoinDetailViewModelParams({ queries: { dexLiquidity: {
      data: { "xsgd-straitsx": makeDexLiquidityData({ warning: null }) },
      dataUpdatedAt: now,
      meta: { updatedAt: now / 1000 - 60, ageSeconds: 60, status: "fresh", warning: globalWarning },
    } } });
    const health = () => {
      const query = buildDetailStaleQueries(params.queries, params.supplemental, "xsgd-straitsx")
        .find((entry) => entry.preset === "dexLiquidity")!;
      return deriveDataHealth({ ...DATA_HEALTH_PRESETS.dexLiquidity, ...query });
    };
    expect(health().state).toBe("fresh");
    params.queries.dexLiquidity.data!["xsgd-straitsx"].warning = globalWarning;
    expect(health().state).toBe("degraded");
    delete params.queries.dexLiquidity.data!["xsgd-straitsx"].warning;
    expect(health().state).toBe("degraded");
    params.queries.dexLiquidity.data!["xsgd-straitsx"].warning = null;
    params.queries.dexLiquidity.meta!.updatedAt = now / 1000 - 13 * 4 * 3600;
    expect(health().state).toBe("stale");
  });
  it.each([
    ["USD", "usdt-tether", "peggedUSD", 1, -200, false],
    ["non-USD", "eurc-circle", "peggedEUR", 1.2, -1000, false],
    ["commodity", "xaut-tether", "peggedGOLD", 3000, 100, false],
    ["unavailable reference", "eurc-circle", "peggedEUR", null, null, true],
    ["unavailable price", "usdc-circle", "peggedUSD", 1, null, false],
    ["NAV", "fpi-frax", "peggedVAR", null, null, false],
  ] as const)("pins the %s Worker peg projection", (
    _label,
    id,
    pegType,
    pegReference,
    currentDeviationBps,
    pegReferenceUnavailable,
  ) => {
    const coin = TRACKED_META_BY_ID.get(id);
    expect(coin).toBeDefined();
    const pegSummaryCoin = makePegSummaryCoin({
      id,
      name: coin!.name,
      symbol: coin!.symbol,
      pegType,
      pegCurrency: coin!.flags.pegCurrency,
      currentDeviationBps,
      pegReference: pegReference == null
        ? null
        : { valueUsd: pegReference, source: "median", contributorCount: 2, asOf: 1_700_000_000 },
      ...(pegReferenceUnavailable ? { pegReferenceUnavailable: true } : {}),
    });
    const snapshot = buildDetailPegPriceSnapshot(
      id,
      coin!,
      { coins: [pegSummaryCoin], summary: null, methodology: {} } as PegSummaryResponse,
    );

    expect(snapshot).toMatchObject({
      pegRef: pegReference,
      deviationBps: currentDeviationBps,
      pegReferenceUnavailable,
    });
  });

  it("uses report-card snapshot freshness instead of the browser fetch timestamp", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: "usdt-tether",
        coin: coin!,
        queries: {
          reportCards: {
            data: {
              cards: [],
              methodology: {},
              dependencyGraph: { nodes: [], edges: [] },
              updatedAt: 1_700_000_000,
            } as never,
            dataUpdatedAt: 1_800_000_000_000,
            meta: { updatedAt: 1_700_000_123, ageSeconds: 0, status: "fresh" },
          },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.reportCardUpdatedAt).toBe(1_700_000_123_000);
  });

  it("projects distinct raw market and peg inputs into the ready hero", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const viewModel = buildStablecoinDetailViewModel(makeReadyDetailParams({
      id: coin.id,
      coin,
      asset: {
        price: 0.98,
        circulating: { peggedUSD: 200 },
        circulatingPrevDay: { peggedUSD: 250 },
        circulatingPrevWeek: { peggedUSD: 100 },
        circulatingPrevMonth: { peggedUSD: 0 },
      },
      queries: {
        pegSummary: { data: { coins: [makePegSummaryCoin({ pegScore: 45, eventCount: 2 })] } as PegSummaryResponse },
        reportCards: { data: { cards: [makeV9Card({ id: coin.id, grade: "B+", score: 79 })] } as never },
      },
    }));
    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;
    expect(viewModel.mcap).toBe(200);
    expect(viewModel.hero.market.safePrevMonth).toBeNull();
    expect(viewModel.hero.market.prevDayTrendClass).toContain("text-red-700");
    expect(viewModel.hero.market.prevWeekTrendClass).toContain("text-green-700");
    expect(viewModel.hero.tertiaryMetrics.find((metric) => metric.key === "peg-score")?.display)
      .toMatchObject({ value: "45", sub: "2 incidents" });
    expect(viewModel.hero.signalRailItems.find((item) => item.key === "safety"))
      .toMatchObject({ primary: "B+", secondary: "79/100" });
  });

  it("builds a ready view model from fetched inputs", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: "usdt-tether",
        coin: coin!,
        asset: {
          circulatingPrevDay: { peggedUSD: 90 },
          circulatingPrevWeek: { peggedUSD: 80 },
          circulatingPrevMonth: { peggedUSD: 70 },
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: null }] },
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
              cards: [
                makeV9Card({ id: "usdt-tether", score: 90, grade: "A" }),
              ],
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

  it("keeps NAV tokens out of peg-distressed verdicts", () => {
    const coin = TRACKED_META_BY_ID.get("mhyper-midas");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: "mhyper-midas",
        coin: coin!,
        asset: { price: 1.1 },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1.1 }] },
          pegSummary: {
            data: {
              summary: {} as never,
              coins: [
                {
                  id: "mhyper-midas",
                  symbol: "mHYPER",
                  pegScore: 35,
                  pegPct: 80,
                  eventCount: 1,
                  currentDeviationBps: 1000,
                  activeDepeg: true,
                  trackingSpanDays: 365,
                },
              ],
            } as never,
            dataUpdatedAt: 1,
          },
          reportCards: {
            data: {
              cards: [makeV9Card({ id: "mhyper-midas", grade: "F", score: 35 })],
              dependencyGraph: { nodes: [], edges: [] },
            } as never,
            dataUpdatedAt: 1,
          },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.isNavToken).toBe(true);
    expect(viewModel.verdict).toEqual({
      archetype: "yield-bearing-hybrid",
      label: "Yield-Bearing Hybrid",
    });
  });

  it("inherits parent mechanism archetypes for variant verdicts", () => {
    const sourceVariant = TRACKED_META_BY_ID.get("autousd-auto-finance");
    expect(sourceVariant).toBeDefined();

    const coin = {
      ...sourceVariant!,
      flags: {
        ...sourceVariant!.flags,
        governance: "centralized" as const,
        yieldBearing: false,
        navToken: false,
      },
    };

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: coin.id,
        coin,
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] },
          reportCards: {
            data: {
              cards: [makeV9Card({ id: coin.id, grade: "B", score: 80 })],
              dependencyGraph: { nodes: [], edges: [] },
            } as never,
            dataUpdatedAt: 1,
          },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(coin.mechanismArchetype).toBeUndefined();
    expect(viewModel.verdict).toEqual({
      archetype: "institutional-default",
      label: "Institutional Default",
    });
  });

  it("wires the selected redemption backstop and stale-query state", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: "usdt-tether",
        coin: coin!,
        queries: {
          redemptionBackstops: {
            data: {
              coins: {
                "usdc-circle": {
                  stablecoinId: "usdc-circle",
                  score: 80,
                  resolutionState: "resolved",
                  routeFamily: "stablecoin-redeem",
                },
                "usdt-tether": {
                  stablecoinId: "usdt-tether",
                  score: null,
                  eventualRedeemabilityScore: 65,
                  resolutionState: "resolved",
                  routeFamily: "offchain-issuer",
                },
              },
              updatedAt: 1_700_000_000,
            } as never,
            dataUpdatedAt: 12_345,
            meta: { updatedAt: 1_700_000_000, ageSeconds: 0, status: "fresh" },
          },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.redemptionBackstop?.stablecoinId).toBe("usdt-tether");
    expect(viewModel.staleQueries.find((query) => query.preset === "redemptionBackstops")).toMatchObject({
      dataUpdatedAt: 12_345,
      hasData: true,
      meta: { updatedAt: 1_700_000_000, status: "fresh" },
    });
  });

  it("keeps the detail page ready when redemption backstop data is missing or errored", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();
    const error = new Error("redemption API unavailable");

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: "usdt-tether",
        coin: coin!,
        queries: {
          redemptionBackstops: {
            data: undefined,
            error,
            dataUpdatedAt: 0,
          },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    expect(viewModel.redemptionBackstop).toBeUndefined();
    expect(viewModel.staleQueries.find((query) => query.preset === "redemptionBackstops")).toMatchObject({
      error,
      hasData: false,
    });
  });

  it("omits intentionally gated queries from the page health banner", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: coin.id,
        coin,
        queries: {
          dexLiquidity: { enabled: false },
          reportCards: { enabled: false },
          redemptionBackstops: { enabled: false },
        },
        supplemental: {
          yieldRankings: { enabled: false },
          stressSignals: { enabled: false },
          flows: { enabled: false },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;
    const presets = viewModel.staleQueries.map((query) => query.preset);
    expect(presets).toContain("stablecoins");
    for (const disabled of ["dexLiquidity", "reportCards", "redemptionBackstops", "yieldRankings", "stressSignals", "mintBurnFlows"]) {
      expect(presets).not.toContain(disabled);
    }
  });

  it("distinguishes optional-source failure from unsupported or valid empty coverage", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const error = new Error("optional feeds unavailable");
    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: coin.id,
        coin,
        queries: {
          dexLiquidity: { data: undefined, error, dataUpdatedAt: 0 },
        },
        supplemental: {
          yieldRankings: { data: undefined, error, dataUpdatedAt: 0 },
          stressSignals: { data: undefined, error, dataUpdatedAt: 0 },
          flows: { data: undefined, error, dataUpdatedAt: 0, enabled: true },
          blacklist: { summary: undefined, error, dataUpdatedAt: 0, enabled: true },
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;
    expect(viewModel.featureStates).toMatchObject({
      liquidity: { status: "unavailable", error },
      yield: { status: "unavailable", error },
      stress: { status: "unavailable", error },
      flows: { status: "unavailable", error },
      blacklist: { status: "unavailable", error },
    });
    expect(viewModel.hasFlows).toBe(true);
    expect(viewModel.hasBlacklist).toBe(true);
    expect(viewModel.staleQueries.map((query) => query.preset)).toEqual(
      expect.arrayContaining(["dexLiquidity", "yieldRankings", "stressSignals", "mintBurnFlows", "blacklist"]),
    );
  });

  it("enables the yield section for non-yield-bearing coins when a live ranking exists", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(coin).toBeDefined();
    expect(coin?.flags.yieldBearing).toBe(false);

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: "usdc-circle",
        coin: coin!,
        asset: {
          circulatingPrevDay: { peggedUSD: 95 },
          circulatingPrevWeek: { peggedUSD: 90 },
          circulatingPrevMonth: { peggedUSD: 85 },
        },
        supplemental: {
          yieldRankingsData: {
            rankings: [
              makeYieldRanking({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }),
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
      makeReadyDetailParams({
        id: "susds-sky",
        coin: variant!,
        asset: {
          price: 1.02,
          circulatingPrevDay: { peggedUSD: 98 },
          circulatingPrevWeek: { peggedUSD: 96 },
          circulatingPrevMonth: { peggedUSD: 92 },
        },
      }),
    );

    expect(variantViewModel.status).toBe("ready");
    if (variantViewModel.status !== "ready") return;
    expect(variantViewModel.variantParent?.id).toBe("usds-sky");
    expect(variantViewModel.isVariant).toBe(true);
    expect(variantViewModel.variantSiblings.map((coin) => coin.id)).toContain("stusds-sky");

    const parentViewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id: "usds-sky",
        coin: parent!,
        asset: {
          circulatingPrevDay: { peggedUSD: 99 },
          circulatingPrevWeek: { peggedUSD: 98 },
          circulatingPrevMonth: { peggedUSD: 97 },
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
      makeReadyDetailParams({
        id: "xaut-tether",
        coin: coin!,
        asset: {
          pegType: "peggedGOLD",
          price: 3_000,
          circulating: { peggedGOLD: 100 },
          circulatingPrevDay: { peggedGOLD: 98 },
          circulatingPrevWeek: { peggedGOLD: 96 },
          circulatingPrevMonth: { peggedGOLD: 92 },
        },
        fxFallbackRates: { peggedGOLD: 3_000 },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 3_000 }] },
        },
        supplemental: {
          yieldRankingsData: {
            rankings: [
              makeYieldRanking({ id: "xaut-tether", symbol: "XAUT", name: "Tether Gold" }),
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

  it.each([
    { label: "inclusive tolerance", points: [[14 * 86400, 2]], price: 3, expected: 50 },
    { label: "outside tolerance", points: [[14 * 86400 + 1, 2]], price: 3, expected: null },
    { label: "closest valid anchor, not first or invalid", points: [[-10 * 86400, 1], [-86400, 2], [0, null], [1, 0]], price: 3, expected: 50 },
    { label: "missing current price", points: [[0, 2]], price: null, expected: null },
    { label: "invalid current price", points: [[0, 2]], price: 0, expected: null },
  ])("selects annual performance for $label", ({ points, price, expected }) => {
    const coin = TRACKED_META_BY_ID.get("zchf-frankencoin")!;
    const nowSec = 1_720_000_000;
    const anchorSec = nowSec - 365 * 86400;
    const viewModel = buildStablecoinDetailViewModel(makeReadyDetailParams({
      id: coin.id,
      coin,
      asset: { price },
      queries: { supplyHistory: { data: points.map(([offset, historicPrice]) => ({
        date: anchorSec + offset!, circulatingUsd: 100, price: historicPrice,
      })) } },
      supplemental: { nowMs: nowSec * 1000 },
    }));
    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;
    expect(viewModel.performanceVsUsd1y).toBe(expected);
  });

  it.each([
    {
      label: "derives 1Y vs USD performance for eligible non-USD pegs",
      id: "zchf-frankencoin",
      pegType: "peggedCHF",
      anchorPrice: 0.98,
      price: 1.12,
      expected: (1.12 / 0.98 - 1) * 100,
    },
    {
      label: "does not derive 1Y vs USD performance for NAV tokens",
      id: "cetes-etherfuse",
      pegType: "peggedMXN",
      anchorPrice: 0.05,
      price: 0.061,
      expected: null,
    },
  ])("$label", ({ id, pegType, anchorPrice, price, expected }) => {
    const coin = TRACKED_META_BY_ID.get(id);
    expect(coin).toBeDefined();

    const nowSec = 1_720_000_000;
    const anchorSec = nowSec - 365 * 24 * 60 * 60;

    const viewModel = buildStablecoinDetailViewModel(
      makeReadyDetailParams({
        id,
        coin: coin!,
        asset: {
          pegType,
          price,
          circulating: { [pegType]: 100 },
          circulatingPrevDay: { [pegType]: 99 },
          circulatingPrevWeek: { [pegType]: 97 },
          circulatingPrevMonth: { [pegType]: 95 },
        },
        fxFallbackRates: { [pegType]: price },
        queries: {
          supplyHistory: {
            data: [
              { date: anchorSec, circulatingUsd: 98, price: anchorPrice },
              { date: nowSec - 7 * 24 * 60 * 60, circulatingUsd: 110, price: anchorPrice * 1.2 },
            ],
          },
        },
        supplemental: {
          nowMs: nowSec * 1000,
        },
      }),
    );

    expect(viewModel.status).toBe("ready");
    if (viewModel.status !== "ready") return;

    if (expected == null) {
      expect(viewModel.performanceVsUsd1y).toBeNull();
      return;
    }
    expect(viewModel.performanceVsUsd1y).toBeCloseTo(expected, 6);
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
