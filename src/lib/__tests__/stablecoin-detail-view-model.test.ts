import { describe, expect, it } from "vitest";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { PegSummaryCoin } from "@shared/types";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildStablecoinDetailHeroViewModel, buildStablecoinDetailViewModel } from "../stablecoin-detail-view-model";
import {
  buildMintAuthorityDetailViewModel,
  buildStablecoinDetailClientCoin,
} from "../stablecoin-detail-mint-authority-view-model";

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
    yieldRankingsData?: BuildStablecoinDetailViewModelParams["supplemental"]["yieldRankings"]["data"];
    stressSignalsData?: BuildStablecoinDetailViewModelParams["supplemental"]["stressSignals"]["data"];
    yieldRankings?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["yieldRankings"]>;
    stressSignals?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["stressSignals"]>;
    flows?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["flows"]>;
    blacklist?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["blacklist"]>;
    reserves?: Partial<BuildStablecoinDetailViewModelParams["supplemental"]["reserves"]>;
    nowMs?: number;
  };
};

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
        dataUpdatedAt: 0,
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
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        enabled: true,
        ...overrides.supplemental?.flows,
      },
      blacklist: {
        summary: undefined,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        enabled: true,
        ...overrides.supplemental?.blacklist,
      },
      reserves: {
        live: null,
        error: null,
        dataUpdatedAt: 0,
        isLoading: false,
        enabled: true,
        ...overrides.supplemental?.reserves,
      },
      yieldRankings: {
        data: overrides.supplemental?.yieldRankingsData,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.supplemental?.yieldRankings,
      },
      stressSignals: {
        data: overrides.supplemental?.stressSignalsData,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
        meta: null,
        ...overrides.supplemental?.stressSignals,
      },
      nowMs: overrides.supplemental?.nowMs,
    },
  };
}

describe("stablecoin detail view-model builder", () => {
  it("uses report-card snapshot freshness instead of the browser fetch timestamp", () => {
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

  it("uses only compact mint-authority summaries for client detail presentation", () => {
    const fullCoin = TRACKED_META_BY_ID.get("usdc-circle");
    expect(fullCoin?.mintAuthority).toBeDefined();
    const coinWithServerOnlyResearch = {
      ...fullCoin!,
      blacklistabilityReview: { sentinel: true } as never,
      bridgeRouteRisk: { sentinel: true } as never,
      custodyProfile: { sentinel: true } as never,
      dependencyReview: { sentinel: true } as never,
      implementationLaunchDate: "2026-01-01",
      mechanismArchetypeReview: { sentinel: true } as never,
      oracleRisk: { sentinel: true } as never,
      reserveReview: { sentinel: true } as never,
    };
    const clientCoin = buildStablecoinDetailClientCoin(coinWithServerOnlyResearch);

    expect(buildMintAuthorityDetailViewModel(fullCoin!).status).toBe("not-reviewed");
    for (const serverOnlyField of [
      "blacklistabilityReview",
      "bridgeRouteRisk",
      "custodyProfile",
      "dependencyReview",
      "implementationLaunchDate",
      "mechanismArchetypeReview",
      "mintAuthority",
      "oracleRisk",
      "reserveReview",
    ]) {
      expect(serverOnlyField in coinWithServerOnlyResearch).toBe(true);
      expect(serverOnlyField in clientCoin).toBe(false);
    }
    expect(clientCoin.mintAuthoritySummary).toBeDefined();
    expect(buildMintAuthorityDetailViewModel(clientCoin).status).toBe("reviewed");
  });

  it("keeps inherited mint-authority weakest-control labels on detail pages", () => {
    const coin = TRACKED_META_BY_ID.get("steakusdt-steakhouse");
    expect(coin).toBeDefined();

    const withoutRichParent = buildMintAuthorityDetailViewModel(buildStablecoinDetailClientCoin(coin!));
    const withRichParent = buildMintAuthorityDetailViewModel(
      buildStablecoinDetailClientCoin(coin!, { parentById: TRACKED_META_BY_ID }),
    );

    expect(withoutRichParent.score).toMatchObject({
      score: 48,
      weakestControlLabel: null,
    });
    expect(withRichParent.score).toMatchObject({
      score: 48,
      weakestControlLabel: "Ethereum USDT token owner multisig",
    });
  });

  it("projects mint-authority review gaps into the detail view model", () => {
    const viewModel = buildMintAuthorityDetailViewModel({
      mintAuthoritySummary: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "manual-review",
        summary: "Issuer backend can mint after off-chain approval.",
        sourceFreeRationale: "Issuer API roles were described in docs but no contract source is published.",
        unresolvedQuestions: ["Confirm whether the backend signer can be rotated without governance."],
      },
    } as never);

    expect(viewModel).toMatchObject({
      status: "reviewed",
      sourceFreeRationale: "Issuer API roles were described in docs but no contract source is published.",
      unresolvedQuestions: ["Confirm whether the backend signer can be rotated without governance."],
    });
  });

  it("adds explorer links and security setup labels to mint-authority controls", () => {
    const viewModel = buildMintAuthorityDetailViewModel({
      mintAuthoritySummary: {
        mintPath: "permissioned-minter",
        authorityPosture: "bounded-admin",
        confidence: "verified",
        summary: "Minting is controlled by a published Safe.",
        controls: [
          {
            chain: "ethereum",
            address: "0x123400000000000000000000000000000000abcd",
            label: "Issuer Safe",
            role: "minter-admin",
            authorityType: "safe",
            directMintAbility: "can-authorize",
            threshold: 2,
            signerCount: 3,
            modulesOrGuardsStatus: "none-detected",
          },
        ],
      },
    } as never);

    expect(viewModel.controls[0]).toMatchObject({
      locationLabel: "ethereum / 0x123400...00abcd",
      fullLocationLabel: "ethereum / 0x123400000000000000000000000000000000abcd",
      addressUrl: "https://etherscan.io/address/0x123400000000000000000000000000000000abcd",
      securitySetupLabel: "Safe, 2/3 threshold",
      thresholdLabel: "2/3 threshold",
      modulesOrGuardsLabel: "No modules or guards detected",
      custodyLabel: null,
    });
    expect(viewModel.score).toMatchObject({
      score: 54,
      bandLabel: "Managed",
      rawScoreLabel: "54/100",
      weakestControlLabel: "Issuer Safe",
      weakestControlScoreLabel: "55/100",
    });
  });

  it("labels single-key mint authority custody and exposes EOA caps", () => {
    const viewModel = buildMintAuthorityDetailViewModel({
      mintAuthoritySummary: {
        mintPath: "permissioned-minter",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Minting is controlled by a single operator key.",
        controls: [
          {
            chain: "ethereum",
            address: "0x123400000000000000000000000000000000abcd",
            label: "Operator key",
            role: "direct-minter",
            authorityType: "eoa",
            directMintAbility: "direct",
          },
        ],
      },
    } as never);

    expect(viewModel.controls[0]).toMatchObject({
      securitySetupLabel: "Externally owned account",
      custodyLabel: "Single-key address - custody unverifiable",
    });
    expect(viewModel.score).toMatchObject({
      score: 31,
      weakestControlLabel: "Operator key",
      weakestControlCustodyLabel: "Single-key address - custody unverifiable",
      capsApplied: ["EOA cap <= 40"],
    });
  });

  it("applies mint-incident caps from compact client metadata", () => {
    const coin = TRACKED_META_BY_ID.get("usr-resolv");
    expect(coin).toBeDefined();

    const viewModel = buildMintAuthorityDetailViewModel(buildStablecoinDetailClientCoin(coin!));

    expect(viewModel.reviewedAt).toBe("2026-06-11");
    expect(viewModel.mintIncidents).toHaveLength(1);
    expect(viewModel.mintIncidents[0]).toMatchObject({
      date: "2026-03-22",
      summary: expect.stringContaining("80M unbacked USR"),
      sources: expect.arrayContaining([
        expect.objectContaining({
          label: expect.any(String),
          url: expect.stringContaining("https://"),
        }),
      ]),
    });
    expect(viewModel.score).toMatchObject({
      score: 10,
      bandLabel: "Exposed",
      rawScoreLabel: "32/100",
      weakestControlLabel: "Resolv SERVICE_ROLE off-chain minting signer",
      capsApplied: ["Incident cap <= 10"],
    });
  });

  it("dedupes mint-authority sources and sorts incident callouts", () => {
    const viewModel = buildMintAuthorityDetailViewModel({
      id: "dedupe-test",
      mintAuthoritySummary: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Issuer backend can mint through reviewed operator controls.",
        sources: [
          { label: "Review", url: "https://example.com/review" },
          { label: "Review", url: "https://example.com/review" },
          { label: "Docs", url: "https://example.com/docs" },
        ],
        mintIncidents: [
          {
            date: "2024-01-01",
            status: "resolved",
            summary: "Older privileged mint incident.",
            sources: [
              { label: "Postmortem", url: "https://example.com/postmortem" },
              { label: "Postmortem", url: "https://example.com/postmortem" },
            ],
          },
          {
            date: "2025-02-01",
            status: "active",
            summary: "Newer privileged mint incident.",
            sources: [{ label: "Thread", url: "https://example.com/thread" }],
          },
        ],
      },
    } as never);

    expect(viewModel.sources).toEqual([
      { label: "Review", url: "https://example.com/review" },
      { label: "Docs", url: "https://example.com/docs" },
    ]);
    expect(viewModel.mintIncidents.map((incident) => incident.date)).toEqual(["2025-02-01", "2024-01-01"]);
    expect(viewModel.mintIncidents[1]?.sources).toEqual([
      { label: "Postmortem", url: "https://example.com/postmortem" },
    ]);
  });

  it("only exposes Safe modules and guards labels for Safe-like mint authority controls", () => {
    const viewModel = buildMintAuthorityDetailViewModel({
      mintAuthoritySummary: {
        mintPath: "permissioned-minter",
        authorityPosture: "partially-bounded-admin",
        confidence: "manual-review",
        summary: "Minting has a Safe admin and a role-gated contract.",
        controls: [
          {
            chain: "ethereum",
            address: "0x123400000000000000000000000000000000abcd",
            label: "Issuer Safe",
            role: "minter-admin",
            authorityType: "safe",
            directMintAbility: "can-authorize",
            modulesOrGuardsStatus: "none-detected",
          },
          {
            chain: "ethereum",
            address: "0x567800000000000000000000000000000000abcd",
            label: "Minter contract",
            role: "direct-minter",
            authorityType: "contract",
            directMintAbility: "direct",
            modulesOrGuardsStatus: "not-applicable",
          },
          {
            chain: "ethereum",
            address: "0x9abc00000000000000000000000000000000abcd",
            label: "Unresolved admin",
            role: "minter-admin",
            authorityType: "unknown",
            directMintAbility: "can-authorize",
            modulesOrGuardsStatus: "unknown",
          },
        ],
      },
    } as never);

    expect(viewModel.controls.map((control) => control.modulesOrGuardsLabel)).toEqual([
      "No modules or guards detected",
      null,
      "Modules or guards unknown",
    ]);
  });

  it("drops malformed mint-authority runtime fields instead of crashing", () => {
    const controlsAsObject = buildMintAuthorityDetailViewModel({
      mintAuthoritySummary: {
        mintPath: "permissioned-minter",
        authorityPosture: "bounded-admin",
        confidence: "verified",
        summary: "Minting is controlled by a published admin.",
        controls: { label: "not an array" },
      },
    } as never);

    expect(controlsAsObject.status).toBe("reviewed");
    expect(controlsAsObject.controls).toEqual([]);

    const malformedControlFields = buildMintAuthorityDetailViewModel({
      mintAuthoritySummary: {
        mintPath: "permissioned-minter",
        authorityPosture: "bounded-admin",
        confidence: "verified",
        summary: "Minting is controlled by a published admin.",
        controls: [
          {
            chain: { name: "ethereum" },
            address: { value: "0x123400000000000000000000000000000000abcd" },
            label: "Malformed admin",
            role: "minter-admin",
            authorityType: "safe",
            directMintAbility: "can-authorize",
            threshold: "2",
            signerCount: Number.NaN,
            timelockDelaySec: { seconds: 3600 },
            capDescription: ["cap"],
          },
        ],
      },
    } as never);

    expect(malformedControlFields.controls[0]).toMatchObject({
      label: "Malformed admin",
      locationLabel: "No address published",
      fullLocationLabel: "No address published",
      addressUrl: null,
      thresholdLabel: null,
      timelockLabel: null,
      capDescription: null,
    });
  });

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
    expect(viewModel.mintAuthorityDecentralizationDrag).toBeNull();
  });

  it("keeps NAV tokens out of peg-distressed verdicts", () => {
    const coin = TRACKED_META_BY_ID.get("mhyper-midas");
    expect(coin).toBeDefined();

    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: "mhyper-midas",
          coin: coin!,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1.1 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: "mhyper-midas",
                  name: "Midas mHYPER",
                  symbol: "mHYPER",
                  pegType: "peggedUSD",
                  price: 1.1,
                  circulating: { peggedUSD: 100 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
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
      makeBuildStablecoinDetailViewModelParams({
        core: {
          id: coin.id,
          coin,
        },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: coin.id,
                  name: coin.name,
                  symbol: coin.symbol,
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 100 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
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
                "usdc-circle": {
                  stablecoinId: "usdc-circle",
                  score: 80,
                  effectiveExitScore: 80,
                  resolutionState: "resolved",
                  routeFamily: "stablecoin-redeem",
                },
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
            meta: { updatedAt: 1_700_000_000, ageSeconds: 0, status: "fresh" },
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
      meta: { updatedAt: 1_700_000_000, status: "fresh" },
    });
  });

  it("keeps the detail page ready when redemption backstop data is missing or errored", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether");
    expect(coin).toBeDefined();
    const error = new Error("redemption API unavailable");

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

  it("distinguishes optional-source failure from unsupported or valid empty coverage", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const error = new Error("optional feeds unavailable");
    const viewModel = buildStablecoinDetailViewModel(
      makeBuildStablecoinDetailViewModelParams({
        core: { id: coin.id, coin },
        queries: {
          supplyHistory: { data: [{ date: 1_700_000_000, circulatingUsd: 100, price: 1 }] },
          stablecoinList: {
            data: {
              peggedAssets: [
                {
                  id: coin.id,
                  name: coin.name,
                  symbol: coin.symbol,
                  pegType: "peggedUSD",
                  price: 1,
                  circulating: { peggedUSD: 100 },
                },
              ],
              fxFallbackRates: {},
            } as never,
            dataUpdatedAt: 1,
          },
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
      ariaLabel: "Redeemability: Issuer / institutional — jump to Redemption Backstop",
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
    // Undisclosed jurisdiction stays as an honest answer, muted.
    expect(byKey.get("jurisdiction")).toMatchObject({ value: "Not disclosed", href: "#jurisdiction" });
    // No freeze section anywhere -> FreezeWatch coverage page link.
    expect(byKey.get("freeze")).toMatchObject({ value: "No", href: "/freezewatch/?stablecoin=MSP" });
    // No curated contracts -> chains chip falls back to the info card.
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
    expect(byKey.get("jurisdiction")).toMatchObject({ value: "Switzerland", href: "#jurisdiction" });
    expect(byKey.get("chains")).toMatchObject({ value: "3", href: "#contracts", chip: true });

    // A decentralized coin omits the attestor chip and routes jurisdiction
    // to the info card, mirroring the Key Information card's skip logic.
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
      ariaLabel: "Issued: launched September 26, 2018 — jump to Key Information",
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
