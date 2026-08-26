import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinData } from "@shared/types";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildStablecoinDetailViewModel } from "../stablecoin-detail-view-model";
import { makeBuildStablecoinDetailViewModelParams } from "./fixtures/stablecoin-detail-view-model";
import {
  buildMintAuthorityDetailViewModel,
} from "../stablecoin-detail-mint-authority-view-model";
import { buildStablecoinDetailClientCoin } from "../stablecoin-detail-client-coin";

function makeUsdtStablecoin(overrides: Partial<StablecoinData> = {}): StablecoinData {
  return makeStablecoin({
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    circulating: { peggedUSD: 100 },
    ...overrides,
  });
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
                makeUsdtStablecoin(),
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

  it("renders the published V9 mint component instead of a curated recomputation", () => {
    const coin = TRACKED_META_BY_ID.get("steakusdt-steakhouse");
    expect(coin).toBeDefined();

    // 9.1: curated parent metadata no longer changes the mint score — the
    // inheritance blend lived in the retired standalone engine.
    const published = { mint: { score: 70, posture: "partially-bounded-admin" }, caps: [] };
    const withoutRichParent = buildMintAuthorityDetailViewModel(
      buildStablecoinDetailClientCoin(coin!),
      published,
    );
    const withRichParent = buildMintAuthorityDetailViewModel(
      buildStablecoinDetailClientCoin(coin!, { parentById: TRACKED_META_BY_ID }),
      published,
    );

    expect(withoutRichParent.score).toMatchObject({ score: 70, bandLabel: "Governed" });
    expect(withRichParent.score).toEqual(withoutRichParent.score);
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
    expect(viewModel.score).toMatchObject({ score: null, bandLabel: "NR" });
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
    // The custody label is a description of the curated control row; the score
    // and band come from the publication, which this fixture does not carry.
    expect(viewModel.score).toMatchObject({ score: null, bandLabel: "NR" });
  });

  it("keeps the mint-incident callout on the detail card", () => {
    const coin = TRACKED_META_BY_ID.get("usr-resolv");
    expect(coin).toBeDefined();

    const viewModel = buildMintAuthorityDetailViewModel(buildStablecoinDetailClientCoin(coin!));

    // `reviewedAt` is curated data that moves with every mint-authority research
    // wave (it changed in #869), so pin the pass-through contract, not the value.
    expect(viewModel.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
    expect(viewModel.score).toMatchObject({ score: null, bandLabel: "NR" });
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
                makeUsdtStablecoin({
                  circulatingPrevDay: { peggedUSD: 90 },
                  circulatingPrevWeek: { peggedUSD: 80 },
                  circulatingPrevMonth: { peggedUSD: 70 },
                }),
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
                makeUsdtStablecoin(),
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
                makeUsdtStablecoin(),
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
