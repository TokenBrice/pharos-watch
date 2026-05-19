import { describe, expect, it, vi } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import type {
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCard,
  ReportCardsResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
  YieldRankingsResponse,
} from "@shared/types";
import { buildSelectorRows, type BuildSelectorRowsArgs } from "./selector-data-adapter";

vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_STABLECOINS: [
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
  ],
}));

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

function baseArgs(overrides: Partial<BuildSelectorRowsArgs> = {}): BuildSelectorRowsArgs {
  return {
    stablecoinsData: {
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
      ],
    } as StablecoinListResponse,
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

function reportData(cardOverrides: Partial<ReportCard> = {}): ReportCardsResponse {
  const card = {
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

  return {
    cards: [card],
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
  it("maps PegSummary depeg fields and keeps active USD supply handling", () => {
    const result = buildSelectorRows(baseArgs({
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

  it("maps yield ranking risk, benchmark, provenance, and freshness fields", () => {
    const result = buildSelectorRows(baseArgs({
      yieldData: {
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
            yieldType: "lending",
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
        methodology: { version: "8.1" },
      } as YieldRankingsResponse,
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
    expect(result.methodologyVersions.yieldIntelligence).toBe("8.1");
  });

  it("prefers redemption effective exit and maps report-card raw inputs", () => {
    const result = buildSelectorRows(baseArgs({
      reportData: reportData({
        rawInputs: createReportCardRawInputs({
          effectiveExitScore: 70,
          liquidityScore: 81,
          concentrationHhi: 0.42,
          collateralQuality: "rwa",
          custodyModel: "institutional-regulated",
          canBeBlacklisted: "dilutable",
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
      stressData: {
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
        methodology: { version: "5.0" },
      } as StressSignalsAllResponse,
    }));

    const row = result.rows.get("usdc-usd-coin");
    expect(row?.effectiveExitScore).toBe(86);
    expect(row?.liquidityScore).toBe(79);
    expect(row?.concentrationHhi).toBe(0.37);
    expect(row?.effectiveTvlUsd).toBe(25_000_000);
    expect(row?.collateralQuality).toBe(50);
    expect(row?.custodyModel).toBe("institutional-regulated");
    expect(row?.canBeBlacklisted).toBe("dilutable");
    expect(row?.bluechipGrade).toBe("B+");
    expect(row?.dewsScore).toBe(18);
    expect(row?.dexTvlAgeSec).toBe(120);
    expect(row?.dewsAgeSec).toBe(30);
    expect(result.methodologyVersions.pegScoreAndDews).toBe("5.0");
  });
});
