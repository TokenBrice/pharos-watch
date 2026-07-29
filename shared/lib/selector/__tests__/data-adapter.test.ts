import { describe, expect, it } from "vitest";
import { buildSelectorRows } from "../data-adapter";
import type {
  BluechipRatingsMap,
  DexLiquidityMap,
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCardsV9CurrentResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "../../../types";

const NOW = 1_700_000_000_000;

describe("buildSelectorRows", () => {
  it("maps current V9 report-card fields into selector rows", () => {
    const result = buildSelectorRows({
      stablecoinsData: {
        peggedAssets: [
          {
            id: "usdc-circle",
            circulating: { peggedUSD: 32_000_000_000 },
          },
        ],
      } as unknown as StablecoinListResponse,
      pegCurrency: "USD",
      pegData: {
        coins: [
          {
            id: "usdc-circle",
            pegScore: 96,
            currentDeviationBps: 4,
            activeDepeg: false,
            eventCount: 2,
            lastEventAt: 1_690_000_000,
            trackingSpanDays: 2_000,
            priceObservedAt: NOW / 1000,
            priceUpdatedAt: null,
            priceSyncedAt: null,
          },
        ],
        methodology: { version: "peg-v3" },
      } as PegSummaryResponse,
      reportData: {
        methodology: { version: "v9.1" },
        cards: [
          {
            id: "usdc-circle",
            score: 91,
            grade: "A+",
            pillars: {
              backing: { score: 82 },
              exit: { score: 77 },
              control: { score: 64 },
            },
            accessPosture: { freezeExposure: "direct" },
            dependencies: {
              serial: [{ upstreamAssetId: "upstream", score: 70, blocked: false }],
              basket: [],
              cycleBlocked: false,
              reasonCodes: [],
            },
          },
        ],
      } as unknown as ReportCardsV9CurrentResponse,
      stressData: {
        signals: {
          "usdc-circle": { score: 42, computedAt: NOW / 1000 - 60 },
        },
        updatedAt: NOW / 1000,
        methodology: { version: "dews-v3" },
      } as unknown as StressSignalsAllResponse,
      dexData: {
        "usdc-circle": {
          liquidityScore: 88,
          effectiveTvlUsd: 250_000_000,
          concentrationHhi: 0.2,
          chainTvl: { Ethereum: 250_000_000 },
          updatedAt: NOW / 1000,
          dexDeviationBps: 8,
        },
      } as unknown as DexLiquidityMap,
      yieldData: null,
      bluechipData: { "usdc-circle": { grade: "A" } } as unknown as BluechipRatingsMap,
      redemptionData: {
        coins: { "usdc-circle": { effectiveExitScore: 79 } },
        methodology: { version: "redemption-v1" },
        updatedAt: NOW / 1000,
      } as unknown as RedemptionBackstopsResponse,
      now: NOW,
    });

    const row = result.rows.get("usdc-circle");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      safetyScore: 91,
      safetyGrade: "A+",
      safetyResilienceScore: 82,
      safetyLiquidityScore: 77,
      safetyDecentralizationScore: 64,
      safetyDependencyRiskScore: 70,
      pegScore: 96,
      pegStabilityScore: 96,
      dewsScore: 42,
      liquidityScore: 88,
      effectiveExitScore: 79,
      canBeBlacklisted: true,
      collateralQuality: 50,
      custodyModel: "institutional-regulated",
      bluechipGrade: "A",
      currentDeviationBps: 4,
      supplyUsd: 32_000_000_000,
    });
    expect(result.methodologyVersions).toMatchObject({
      safetyScore: "v9.1",
      pegScoreAndDews: "peg-v3+dews-v3",
    });
    expect(result.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
