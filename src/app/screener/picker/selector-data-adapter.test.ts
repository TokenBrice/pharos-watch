import { describe, expect, it, vi } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import {
  StressSignalsAllResponseSchema,
  YieldRankingsResponseSchema,
} from "@shared/types";
import type {
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCard,
  ReportCardsResponse,
  StablecoinListResponse,
} from "@shared/types";
import { buildSelectorRows, type BuildSelectorRowsArgs } from "./selector-data-adapter";

vi.mock("@shared/lib/stablecoins/client-registry", () => {
  const coins = [
    {
      id: "usdc-usd-coin",
      symbol: "USDC",
      name: "USD Coin",
      protocolSlug: "circle",
      variantOf: undefined,
      status: "active",
      canBeBlacklisted: true,
      mechanismArchetype: "fiat-collateralized",
      flags: {
        pegCurrency: "USD",
        yieldBearing: false,
        governance: "centralized",
      },
    },
    {
      id: "eurc-circle",
      symbol: "EURC",
      name: "EURC",
      protocolSlug: "circle",
      variantOf: undefined,
      status: "active",
      canBeBlacklisted: true,
      mechanismArchetype: "fiat-collateralized",
      flags: {
        pegCurrency: "EUR",
        yieldBearing: false,
        governance: "centralized",
      },
    },
  ];
  return {
    CLIENT_TRACKED_STABLECOINS: coins,
    CLIENT_ACTIVE_META_BY_ID: new Map(coins.map((c) => [c.id, c])),
  };
});

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

function methodology(version: string) {
  return {
    version,
    versionLabel: `v${version}`,
    currentVersion: version,
    currentVersionLabel: `v${version}`,
    changelogPath: "/methodology/test-changelog/",
    asOf: NOW_SEC,
    isCurrent: true,
  };
}

function baseArgs(overrides: Partial<BuildSelectorRowsArgs> = {}): BuildSelectorRowsArgs {
  return {
    stablecoinsData: stablecoinsData(),
    pegData: null,
    reportData: reportData(),
    stressData: null,
    dexData: null,
    yieldData: null,
    bluechipData: null,
    redemptionData: null,
    now: NOW_MS,
    ...overrides,
  };
}

function stablecoinsData(extraAssets: StablecoinListResponse["peggedAssets"] = []): StablecoinListResponse {
  return {
    peggedAssets: [
      {
        id: "usdc-usd-coin",
        name: "USD Coin",
        symbol: "USDC",
        pegType: "peggedUSD",
        pegMechanism: "fiat-backed",
        price: 1,
        priceSource: "test",
        circulating: { peggedUSD: 123_000_000 },
        circulatingPrevDay: {},
        circulatingPrevWeek: {},
        circulatingPrevMonth: {},
        chainCirculating: {},
        chains: ["Ethereum"],
      },
      ...extraAssets,
    ],
  } as StablecoinListResponse;
}

function makeReportCard(cardOverrides: Partial<ReportCard> = {}): ReportCard {
  return {
    id: "usdc-usd-coin",
    name: "USD Coin",
    symbol: "USDC",
    overallGrade: "A",
    overallScore: 91,
    baseScore: 91,
    dimensions: {
      pegStability: { grade: "A", score: 95, detail: "test" },
      liquidity: { grade: "A", score: 88, detail: "test" },
      resilience: { grade: "B+", score: 86, detail: "test" },
      decentralization: { grade: "C", score: 55, detail: "test" },
      dependencyRisk: { grade: "A-", score: 90, detail: "test" },
    },
    ratedDimensions: 5,
    rawInputs: createReportCardRawInputs(),
    isDefunct: false,
    ...cardOverrides,
  } as ReportCard;
}

function reportData(cardOverrides: Partial<ReportCard> = {}): ReportCardsResponse {
  return reportDataWithCards([makeReportCard(cardOverrides)]);
}

function reportDataWithCards(cards: ReportCard[]): ReportCardsResponse {
  return {
    cards,
    methodology: {
      version: "7.4",
      weights: {
        pegStability: 20,
        liquidity: 20,
        resilience: 20,
        decentralization: 20,
        dependencyRisk: 20,
      },
      pegMultiplierExponent: 1,
      thresholds: [],
    },
    dependencyGraph: { edges: [] },
    updatedAt: NOW_SEC,
  } as ReportCardsResponse;
}

describe("buildSelectorRows", () => {
  it("maps PegSummary depeg fields and keeps selected USD supply handling", () => {
    const result = buildSelectorRows(baseArgs({
      pegCurrency: "USD",
      pegData: {
        coins: [
          {
            id: "usdc-usd-coin",
            symbol: "USDC",
            name: "USD Coin",
            pegType: "peggedUSD",
            pegCurrency: "USD",
            governance: "centralized",
            currentDeviationBps: 64,
            pegScore: 82,
            priceObservedAt: NOW_SEC - 42,
            pegPct: 99.36,
            severityScore: 12,
            spreadPenalty: 4,
            eventCount: 3,
            worstDeviationBps: 210,
            activeDepeg: true,
            lastEventAt: NOW_SEC - 3_600,
            trackingSpanDays: 725,
            methodologyVersion: "3.2",
          },
        ],
        summary: null,
        methodology: { version: "3.2" },
      } as PegSummaryResponse,
    }));

    const row = result.rows.get("usdc-usd-coin");
    expect(row).toBeDefined();
    expect(result.rows.has("eurc-circle")).toBe(false);
    expect(row?.supplyUsd).toBe(123_000_000);
    expect(row?.pegScore).toBe(82);
    expect(row?.currentDeviationBps).toBe(64);
    expect(row?.depegEventCount).toBe(3);
    expect(row?.activeDepeg).toBe(true);
    expect(row?.lastEventAt).toBe(NOW_SEC - 3_600);
    expect(row?.trackingSpanDays).toBe(725);
    expect(row?.pegSummaryAgeSec).toBe(42);
    expect(result.methodologyVersions.pegScoreAndDews).toBe("3.2");
  });

  it("includes the selected non-USD universe and hashes that selected peg", () => {
    const eurAsset = {
      id: "eurc-circle",
      name: "EURC",
      symbol: "EURC",
      pegType: "peggedEUR",
      pegMechanism: "fiat-backed",
      price: 1,
      priceSource: "test",
      circulating: { peggedEUR: 45_000_000 },
      circulatingPrevDay: {},
      circulatingPrevWeek: {},
      circulatingPrevMonth: {},
      chainCirculating: {},
      chains: ["Ethereum"],
    };
    const usdHash = buildSelectorRows(baseArgs({ pegCurrency: "USD" })).datasetHash;
    const result = buildSelectorRows(baseArgs({
      pegCurrency: "EUR",
      stablecoinsData: stablecoinsData([eurAsset] as StablecoinListResponse["peggedAssets"]),
      reportData: reportDataWithCards([
        makeReportCard(),
        makeReportCard({
          id: "eurc-circle",
          name: "EURC",
          symbol: "EURC",
          overallScore: 83,
          rawInputs: createReportCardRawInputs({ pegScore: 87 }),
        }),
      ]),
      pegData: {
        coins: [
          {
            id: "eurc-circle",
            symbol: "EURC",
            name: "EURC",
            pegType: "peggedEUR",
            pegCurrency: "EUR",
            governance: "centralized",
            currentDeviationBps: 18,
            pegScore: 87,
            priceObservedAt: NOW_SEC - 24,
            pegPct: 99.82,
            severityScore: 4,
            spreadPenalty: 2,
            eventCount: 1,
            worstDeviationBps: 120,
            activeDepeg: false,
            lastEventAt: NOW_SEC - 7_200,
            trackingSpanDays: 180,
            methodologyVersion: "3.2",
          },
        ],
        summary: null,
        methodology: { version: "3.2" },
      } as PegSummaryResponse,
    }));

    expect(result.rows.has("usdc-usd-coin")).toBe(false);
    expect(result.rows.has("eurc-circle")).toBe(true);
    expect(result.rows.get("eurc-circle")?.pegCurrency).toBe("EUR");
    expect(result.rows.get("eurc-circle")?.supplyUsd).toBe(45_000_000);
    expect(result.datasetHash).not.toBe(usdHash);
  });

  it("uses a SHA-256 dataset hash over decision-affecting fields only", () => {
    const base = buildSelectorRows(baseArgs());
    expect(base.datasetHash).toMatch(/^[0-9a-f]{64}$/);

    const changedDecisionField = buildSelectorRows(baseArgs({
      reportData: reportData({
        rawInputs: createReportCardRawInputs({ effectiveExitScore: 12 }),
      }),
    }));
    expect(changedDecisionField.datasetHash).not.toBe(base.datasetHash);

    const timestampOnlyReport = reportData();
    const timestampOnly = buildSelectorRows(baseArgs({
      reportData: { ...timestampOnlyReport, updatedAt: NOW_SEC + 1_000 },
    }));
    expect(timestampOnly.datasetHash).toBe(base.datasetHash);
  });

  it("includes methodology versions in the dataset hash", () => {
    const base = buildSelectorRows(baseArgs());
    const nextReportData = reportData();
    nextReportData.methodology.version = "safety-next";
    const changedMethodology = buildSelectorRows(baseArgs({
      reportData: nextReportData,
    }));
    expect(changedMethodology.methodologyVersions.safetyScore).toBe("safety-next");
    expect(changedMethodology.datasetHash).not.toBe(base.datasetHash);
  });

  it("maps yield ranking risk, benchmark, provenance, and freshness fields", () => {
    const result = buildSelectorRows(baseArgs({
      yieldData: YieldRankingsResponseSchema.parse({
        rankings: [
          {
            id: "usdc-usd-coin",
            symbol: "USDC",
            name: "USD Coin",
            currentApy: 6.2,
            apy7d: 6.1,
            apy30d: 6,
            apyBase: 5.8,
            apyReward: 0.2,
            yieldSource: "Aave",
            yieldType: "lending-vault",
            dataSource: "defillama",
            sourceTvlUsd: 50_000_000,
            pharosYieldScore: 78,
            safetyScore: 91,
            safetyGrade: "A",
            yieldToRisk: 1.4,
            excessYield: 1.25,
            benchmarkRate: 4.75,
            yieldStability: 92,
            apyVariance30d: 0.8,
            apyMin30d: 5.7,
            apyMax30d: 6.4,
            warningSignals: ["thin-tvl"],
            altSources: [],
            provenance: {
              sourceKey: "aave-v3-usdc",
              sourceObservedAt: NOW_SEC - 90,
              sourceAgeSeconds: 90,
              confidenceTier: "deterministic",
              selectionMethod: "confidence-weighted",
              selectionReason: "best-by-confidence-and-apy",
              sourceSwitch: true,
              previousBestSourceKey: "compound-usdc",
              usedLegacyHistory: false,
              usedDefaultSafety: false,
              benchmarkRate: 4.75,
              benchmarkRecordDate: "2026-05-19",
              benchmarkIsFallback: false,
              benchmarkFallbackMode: null,
              anomalies: [],
            },
            sourceRisk: {
              sourceRiskScore: 22,
              sourceRiskPenalty: 1.5,
              sourceAgeSeconds: 90,
              sourceSwitchCount30d: 2,
              observationCount30d: 28,
              deploymentPlace: "lending-market",
              venueProtocol: "Aave",
              venueChain: "Ethereum",
              venueRiskTier: "medium",
              investabilityFlags: ["manual-review"],
            },
          },
        ],
        riskFreeRate: 4.5,
        scalingFactor: 1,
        medianApy: 5,
        updatedAt: NOW_SEC,
        methodology: methodology("8.1"),
      }),
    }));

    const row = result.rows.get("usdc-usd-coin");
    expect(row?.pharosYieldScore).toBe(78);
    expect(row?.apy30d).toBe(6);
    expect(row?.benchmarkRate).toBe(4.75);
    expect(row?.apyVariance30d).toBe(0.8);
    expect(row?.sourceRiskScore).toBe(22);
    expect(row?.venueRiskTier).toBe("mid");
    expect(row?.warningSignals).toEqual(["thin-tvl"]);
    expect(row?.deploymentPlace).toBe("lending");
    expect(row?.sourceSwitch).toBe(true);
    expect(row?.yieldProtocolSlug).toBe("Aave");
    expect(row?.yieldVenueChain).toBe("Ethereum");
    expect(row?.yieldHistoryDays).toBe(28);
    expect(row?.yieldFreshness).toEqual({ capturedAt: NOW_SEC - 90, ageSeconds: 90 });
    expect(row?.yieldSources?.[0]).toEqual(
      expect.objectContaining({
        sourceKey: "aave-v3-usdc",
        protocol: "Aave",
        chain: "Ethereum",
        yieldType: "lending-vault",
        isPrimary: true,
      }),
    );
    expect(result.methodologyVersions.yieldIntelligence).toBe("8.1");
  });

  it("preserves Yield altSources for engine venue/risk/freshness selection", () => {
    const result = buildSelectorRows(baseArgs({
      yieldData: YieldRankingsResponseSchema.parse({
        rankings: [
          {
            id: "usdc-usd-coin",
            symbol: "USDC",
            name: "USD Coin",
            currentApy: 6.2,
            apy7d: 6.1,
            apy30d: 6,
            apyBase: 5.8,
            apyReward: 0.2,
            yieldSource: "Aave",
            yieldType: "lending-vault",
            dataSource: "defillama",
            sourceTvlUsd: 50_000_000,
            pharosYieldScore: 78,
            safetyScore: 91,
            safetyGrade: "A",
            yieldToRisk: 1.4,
            excessYield: 1.25,
            benchmarkRate: 4.75,
            yieldStability: 92,
            apyVariance30d: 0.8,
            apyMin30d: 5.7,
            apyMax30d: 6.4,
            warningSignals: [],
            altSources: [
              {
                sourceKey: "curve-usdc",
                yieldSource: "Curve",
                yieldType: "lp-receipt",
                currentApy: 5.1,
                apy30d: 5,
                sourceTvlUsd: 30_000_000,
                dataSource: "defillama",
                sourceRisk: {
                  sourceRiskScore: 18,
                  sourceAgeSeconds: 45,
                  observationCount30d: 30,
                  sourceSwitchCount30d: 0,
                  sourceDepthRatio: 0.7,
                  deploymentPlace: "lp-or-dex",
                  venueProtocol: "Curve",
                  venueChain: "Ethereum",
                  venueRiskTier: "low",
                  investabilityFlags: [],
                },
              },
            ],
            provenance: {
              sourceKey: "aave-v3-usdc",
              sourceObservedAt: NOW_SEC - 90,
              sourceAgeSeconds: 90,
              confidenceTier: "deterministic",
              selectionMethod: "confidence-weighted",
              selectionReason: "best-by-confidence-and-apy",
              sourceSwitch: false,
              previousBestSourceKey: null,
              usedLegacyHistory: false,
              usedDefaultSafety: false,
              benchmarkRate: 4.75,
              benchmarkRecordDate: "2026-05-19",
              benchmarkIsFallback: false,
              benchmarkFallbackMode: null,
              anomalies: [],
            },
            sourceRisk: {
              sourceRiskScore: 22,
              sourceAgeSeconds: 90,
              observationCount30d: 28,
              sourceSwitchCount30d: 0,
              sourceDepthRatio: 0.8,
              deploymentPlace: "lending-market",
              venueProtocol: "Aave",
              venueChain: "Ethereum",
              venueRiskTier: "medium",
              investabilityFlags: [],
            },
          },
        ],
        riskFreeRate: 4.5,
        scalingFactor: 1,
        medianApy: 5,
        updatedAt: NOW_SEC,
        methodology: methodology("8.1"),
      }),
    }));

    const sources = result.rows.get("usdc-usd-coin")?.yieldSources ?? [];
    expect(sources.map((source) => source.sourceKey)).toEqual([
      "aave-v3-usdc",
      "curve-usdc",
    ]);
    expect(sources[1]).toEqual(
      expect.objectContaining({
        protocol: "Curve",
        chain: "Ethereum",
        deploymentPlace: "lp",
        venueRiskTier: "low",
        freshness: { capturedAt: NOW_SEC - 45, ageSeconds: 45 },
      }),
    );
  });

  it("uses opportunity-level safety for selected structured tranche yield rows", () => {
    const result = buildSelectorRows(baseArgs({
      yieldData: YieldRankingsResponseSchema.parse({
        rankings: [
          {
            id: "usdc-usd-coin",
            symbol: "USDC",
            name: "USD Coin",
            currentApy: 9,
            apy7d: 8.8,
            apy30d: 8.5,
            apyBase: 8.5,
            apyReward: null,
            yieldSource: "Royco Dawn Senior: USD Coin",
            yieldType: "structured-tranche",
            dataSource: "protocol-api",
            sourceTvlUsd: 1_500_000,
            pharosYieldScore: 62,
            safetyScore: 61,
            safetyGrade: "C+",
            yieldToRisk: 0.2,
            excessYield: 4,
            benchmarkRate: 4.5,
            yieldStability: 0.8,
            apyVariance30d: 0.2,
            apyMin30d: 8,
            apyMax30d: 9,
            warningSignals: [],
            altSources: [],
            provenance: {
              sourceKey: "royco-dawn:1:0xabc:senior",
              sourceObservedAt: NOW_SEC - 90,
              sourceAgeSeconds: 90,
              confidenceTier: "curated",
              selectionMethod: "confidence-weighted",
              selectionReason: "best-by-confidence-and-apy",
              sourceSwitch: false,
              previousBestSourceKey: null,
              usedLegacyHistory: false,
              usedDefaultSafety: false,
              safetyProvenance: "opportunity-safety",
              benchmarkRecordDate: null,
              benchmarkIsFallback: false,
              benchmarkFallbackMode: null,
              anomalies: [],
            },
            sourceRisk: {
              deploymentPlace: "structured-tranche",
              venueProtocol: "royco-dawn",
              venueChain: "ethereum",
              venueRiskTier: "unknown",
              trancheSide: "senior",
              trancheSafetyScore: 61,
              underlyingSafetyScore: 91,
              trancheSafetyPenalty: 30,
            },
          },
        ],
        riskFreeRate: 4.5,
        scalingFactor: 1,
        medianApy: 5,
        updatedAt: NOW_SEC,
        methodology: methodology("8.19"),
      }),
    }));

    const row = result.rows.get("usdc-usd-coin");
    expect(row?.safetyScore).toBe(61);
    expect(row?.safetyGrade).toBe("C+");
    expect(row?.safetyResilienceScore).toBe(86);
  });

  it("prefers Safety-gated report-card effective exit and maps raw inputs", () => {
    const result = buildSelectorRows(baseArgs({
      reportData: reportData({
        rawInputs: createReportCardRawInputs({
          effectiveExitScore: 70,
          liquidityScore: 81,
          concentrationHhi: 0.42,
          collateralQuality: "rwa",
          custodyModel: "institutional-regulated",
          canBeBlacklisted: "inherited",
          bluechipGrade: "B+",
        }),
      }),
      redemptionData: {
        coins: {
          "usdc-usd-coin": {
            stablecoinId: "usdc-usd-coin",
            score: 80,
            effectiveExitScore: 86,
            methodologyVersion: "2.1",
            updatedAt: NOW_SEC,
          },
        },
        methodology: { version: "2.1" },
        updatedAt: NOW_SEC,
      } as RedemptionBackstopsResponse,
      dexData: {
        "usdc-usd-coin": {
          effectiveTvlUsd: 25_000_000,
          liquidityScore: 79,
          concentrationHhi: 0.37,
          chainTvl: { Ethereum: 25_000_000 },
          updatedAt: NOW_SEC - 120,
        },
      } as never,
      stressData: StressSignalsAllResponseSchema.parse({
        signals: {
          "usdc-usd-coin": {
            score: 18,
            band: "low",
            signals: {},
            computedAt: NOW_SEC - 30,
            methodologyVersion: "5.0",
          },
        },
        updatedAt: NOW_SEC - 30,
        methodology: methodology("5.0"),
      }),
    }));

    const row = result.rows.get("usdc-usd-coin");
    expect(row?.effectiveExitScore).toBe(70);
    expect(row?.liquidityScore).toBe(79);
    expect(row?.concentrationHhi).toBe(0.37);
    expect(row?.effectiveTvlUsd).toBe(25_000_000);
    expect(row?.collateralQuality).toBe(50);
    expect(row?.custodyModel).toBe("institutional-regulated");
    expect(row?.canBeBlacklisted).toBe("inherited");
    expect(row?.bluechipGrade).toBe("B+");
    expect(row?.dewsScore).toBe(18);
    expect(row?.dexTvlAgeSec).toBe(120);
    expect(row?.dewsAgeSec).toBe(30);
    expect(result.methodologyVersions.pegScoreAndDews).toBe("5.0");
  });
});
