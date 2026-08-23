import { readJsonResponse } from "./api-request-response.test-support";
import { describe, expect, it, vi } from "vitest";
import type { YieldRankingsResponse } from "@shared/types/yield";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const computeSafetyScoresSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/safety-scores", () => ({
  computeSafetyScoresSnapshot: computeSafetyScoresSnapshotMock,
}));

import { handleYieldRankings } from "../cache-handlers";

function cachedYieldRankings(updatedAt: number): YieldRankingsResponse {
  const safetyDerivedSourceRisk = {
    sourceRiskScore: 72,
    sourceRiskPenalty: 1.1,
    underlyingSafetyScore: 80,
    trancheSafetyScore: 74,
    trancheSafetyPenalty: 6,
    opportunityRisk: {
      opportunityClass: "lending" as const,
      underlyingSafetyScore: 80,
      opportunitySafetyScore: 75,
      opportunitySafetyPenalty: 5,
      venueReviewed: true,
      missingCriticalEvidence: [],
    },
  };

  return {
    rankings: [
      {
        id: "risk-row",
        symbol: "RISK",
        name: "Risk Row",
        currentApy: 6.2,
        apy7d: 6.1,
        apy30d: 6,
        apyBase: 6,
        apyReward: null,
        yieldSource: "Reviewed lending market",
        yieldType: "lending-opportunity",
        dataSource: "protocol-api",
        sourceTvlUsd: 10_000_000,
        pharosYieldScore: 42,
        safetyScore: 75,
        safetyGrade: "B+",
        yieldToRisk: 0.23,
        excessYield: 1.5,
        yieldStability: 0.9,
        apyVariance30d: 0.2,
        apyMin30d: 5.8,
        apyMax30d: 6.3,
        warningSignals: [],
        sourceRisk: safetyDerivedSourceRisk,
        rankChangeAttribution: {
          previousPys: 42,
          pysDelta: -3,
          primaryDriver: "stablecoin-safety",
          driverContributions: {
            stablecoinSafety: -3,
            apy: 1,
          },
        },
        altSources: [
          {
            sourceKey: "alternate-risk-row",
            yieldSource: "Alternate reviewed market",
            yieldType: "lending-opportunity",
            currentApy: 5.9,
            apy30d: 5.8,
            sourceTvlUsd: 8_000_000,
            dataSource: "protocol-api",
            sourceRisk: safetyDerivedSourceRisk,
          },
        ],
        provenance: null,
      },
    ],
    riskFreeRate: 4.5,
    scalingFactor: 8,
    medianApy: 4.8,
    updatedAt,
    provenance: null,
  };
}

describe("VERITAS-II finding: degraded yield rows retain nested safety numbers", () => {
  it("removes every selected and alternate-source safety derivative when compact safety is unavailable", async () => {
    const updatedAt = Math.floor(Date.now() / 1_000) - 30;
    const payload = cachedYieldRankings(updatedAt);
    const db = mockD1([
      {
        match: "cache",
        rows: [{ key: "yield-rankings", value: JSON.stringify(payload), updated_at: updatedAt }],
        first: { key: "yield-rankings", value: JSON.stringify(payload), updated_at: updatedAt },
      },
    ]);
    computeSafetyScoresSnapshotMock.mockResolvedValueOnce({
      kind: "degraded",
      mode: "map",
      coveredCount: 0,
      trackedCount: 1,
      coverageRatio: 0,
      reason: "safety-score-v9-publication:missing-cache",
      scores: new Map(),
      source: "safety-score-v9-publication",
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    });

    const response = await handleYieldRankings(db);
    const body = (await readJsonResponse(response, 200)) as YieldRankingsResponse;
    const row = body.rankings[0]!;
    const selectedRisk = row.sourceRisk;
    const alternateRisk = row.altSources[0]?.sourceRisk;

    expect(row).toMatchObject({
      safetyScore: null,
      safetyGrade: "NR",
      safetyReason: "safety-snapshot-unavailable",
      pharosYieldScore: null,
      pysNullReason: "safety-unrated",
      yieldToRisk: null,
    });
    expect(selectedRisk?.underlyingSafetyScore ?? null).toBeNull();
    expect(selectedRisk?.trancheSafetyScore ?? null).toBeNull();
    expect(selectedRisk?.trancheSafetyPenalty ?? null).toBeNull();
    expect(selectedRisk?.opportunityRisk ?? null).toBeNull();
    expect(selectedRisk?.opportunityRisk?.underlyingSafetyScore ?? null).toBeNull();
    expect(selectedRisk?.opportunityRisk?.opportunitySafetyScore ?? null).toBeNull();
    expect(selectedRisk?.opportunityRisk?.opportunitySafetyPenalty ?? null).toBeNull();
    expect(alternateRisk?.underlyingSafetyScore ?? null).toBeNull();
    expect(alternateRisk?.trancheSafetyScore ?? null).toBeNull();
    expect(alternateRisk?.trancheSafetyPenalty ?? null).toBeNull();
    expect(alternateRisk?.opportunityRisk ?? null).toBeNull();
    expect(alternateRisk?.opportunityRisk?.underlyingSafetyScore ?? null).toBeNull();
    expect(alternateRisk?.opportunityRisk?.opportunitySafetyScore ?? null).toBeNull();
    expect(alternateRisk?.opportunityRisk?.opportunitySafetyPenalty ?? null).toBeNull();
    expect(row.rankChangeAttribution).toMatchObject({
      previousPys: null,
      pysDelta: null,
      primaryDriver: null,
      driverContributions: { stablecoinSafety: null, apy: 1 },
    });
  });
});
