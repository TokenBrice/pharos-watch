import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldRankingsSummaryResponseSchema } from "@shared/types/yield-summary";
import type { YieldRankingsResponse } from "@shared/types/yield";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/lib/__tests__/yield-ranking-fixtures";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const loadPublishedReportCardsSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/report-cards-snapshot-cache", () => ({
  loadPublishedReportCardsSnapshot: loadPublishedReportCardsSnapshotMock,
}));

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: vi.fn(),
}));

import { handleYieldRankings } from "../cache-handlers";

const UPDATED_AT = 1_783_632_600;

function makePayload(): YieldRankingsResponse {
  return {
    rankings: [
      makeYieldRanking({
        altSources: [makeAltYieldSource()],
        provenance: makeYieldProvenance({
          calculationMode: "market-api",
          evidenceClass: "direct-first-party",
          evidenceCompleteness: 0.92,
          scoreQualification: "rated",
        }),
        sourceRisk: {
          sourceRiskScore: 22,
          sourceRiskPenalty: 1.11,
          sourceDepthRatio: 0.008,
          rewardShare: 0.2,
          sourceAgeSeconds: 900,
          observationCount30d: 720,
          sourceSwitchCount30d: 1,
          venueProtocol: "Detail-only protocol",
          venueChain: "Ethereum",
          venueRiskTier: "medium",
          venueRiskWeighted: 2.3,
          venueRiskConfidence: "verified",
          investabilityFlags: ["detail-only-flag"],
        },
        decisionLedger: {
          selectedReasonCode: "curated-over-discovered",
          sourceSwitch: false,
          rejectedCount: 1,
          alternatives: [
            {
              sourceKey: "alt-source",
              yieldSource: "Aave V3 USDC",
              apy30dDelta: -0.2,
              rejectionReasonCode: "lower-confidence",
            },
          ],
        },
      }),
    ],
    riskFreeRate: 4.25,
    benchmarks: {
      USD: {
        key: "USD",
        label: "USD 3M T-Bill",
        currency: "USD",
        rate: 4.25,
        recordDate: "2026-07-09",
        fetchedAt: UPDATED_AT,
        ageSeconds: 300,
        source: "fred-dgs3mo",
        isFallback: false,
        fallbackMode: null,
        isProxy: false,
      },
    },
    scalingFactor: 8,
    medianApy: 5,
    updatedAt: UPDATED_AT,
  };
}

function makeCacheDb(payload: YieldRankingsResponse): D1Database {
  const value = JSON.stringify(payload);
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "yield-rankings", value, updated_at: UPDATED_AT }],
      first: { key: "yield-rankings", value, updated_at: UPDATED_AT },
    },
  ]);
}

describe("handleYieldRankings summary projection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((UPDATED_AT + 60) * 1_000));
    loadPublishedReportCardsSnapshotMock.mockReset();
    loadPublishedReportCardsSnapshotMock.mockResolvedValue({
      kind: "ok",
      payload: {
        cards: [
          {
            id: "usdc-circle",
            symbol: "USDC",
            overallGrade: "A",
            overallScore: 80,
            isDefunct: false,
          },
        ],
        updatedAt: UPDATED_AT,
        publication: {
          generationId: "report-cards-current",
          methodologyVersion: "current",
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the compact contract only for projection=summary", async () => {
    const response = await handleYieldRankings(
      makeCacheDb(makePayload()),
      new URL("https://api.pharos.watch/api/yield-rankings?projection=summary"),
    );
    const body = YieldRankingsSummaryResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=300");
    expect(body).toMatchObject({
      projection: "summary",
      rankings: [
        {
          id: "usdc-circle",
          alternateSourceCount: 1,
          decisionReasonCode: "curated-over-discovered",
          provenance: {
            sourceKey: "selected-source",
            calculationMode: "market-api",
            evidenceClass: "direct-first-party",
          },
        },
      ],
      _meta: { updatedAt: UPDATED_AT, ageSeconds: 60, status: "fresh" },
    });
    expect(body.rankings[0]).not.toHaveProperty("altSources");
    expect(body.rankings[0]).not.toHaveProperty("decisionLedger");
    expect(body.rankings[0].sourceRisk).not.toHaveProperty("venueProtocol");
    expect(body.rankings[0].sourceRisk).not.toHaveProperty("investabilityFlags");
  });

  it("preserves the detailed default response", async () => {
    const response = await handleYieldRankings(
      makeCacheDb(makePayload()),
      new URL("https://api.pharos.watch/api/yield-rankings"),
    );
    const body = (await response.json()) as YieldRankingsResponse;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("projection");
    expect(body.rankings[0].altSources).toHaveLength(1);
    expect(body.rankings[0].decisionLedger?.alternatives).toHaveLength(1);
    expect(body.rankings[0].sourceRisk?.venueProtocol).toBe("Detail-only protocol");
  });

  it("rejects unknown, blank, and repeated projection values without reading cache", async () => {
    for (const search of ["?projection=full", "?projection=", "?projection=summary&projection=summary"]) {
      const response = await handleYieldRankings(
        mockD1(),
        new URL(`https://api.pharos.watch/api/yield-rankings${search}`),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: 'Invalid projection parameter: expected "summary"',
      });
    }
  });
});
