import type { ReportCard } from "@shared/types/report-cards";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { YieldRankingsResponseSchema, type YieldRanking, type YieldRankingsResponse } from "@shared/types/yield";
import { BluechipRatingsMapSchema } from "@shared/types/market";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import {
  addFreshnessHeaders,
  createCacheHandler,
  errorResponse,
  readCachedJsonOr503,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES, DEFAULT_SAFETY_SCORE } from "../lib/constants";
import { getCache } from "../lib/db-cache";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { normalizeStablecoinChartPoints } from "../lib/stablecoin-charts-payload";
import {
  appendOrReplaceCurrentStablecoinChartsPoint,
  buildCurrentStablecoinChartsPoint,
} from "../lib/stablecoin-charts-reconciliation";

export const handleStablecoins = createCacheHandler(
  "stablecoins",
  "stablecoins",
  CACHE_PROFILES.realtime,
  API_FRESHNESS_MAX_AGE_SEC.stablecoins,
);

export const handleStablecoinCharts = withErrorHandler(
  "stablecoin-charts",
  async (db: D1Database): Promise<Response> => {
    const cached = await getCache(db, "stablecoin-charts");
    if (!cached) {
      return errorResponse(503, "Data not yet available");
    }

    const headers = addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    }, cached.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts);

    const parsed = readCachedJsonOr503<unknown>("stablecoin-charts", "stablecoin-charts", cached);
    if (!parsed.ok) {
      return parsed.response;
    }
    const normalizedPoints = normalizeStablecoinChartPoints(parsed.data);
    if (!normalizedPoints) {
      return errorResponse(503, "Cached stablecoin-charts payload is malformed");
    }

    let points = normalizedPoints;

    const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
    if (stablecoinsCache.kind === "ok") {
      const currentPoint = buildCurrentStablecoinChartsPoint(
        stablecoinsCache.payload.peggedAssets,
        stablecoinsCache.updatedAt,
      );
      points = appendOrReplaceCurrentStablecoinChartsPoint(points, currentPoint);
    }

    return new Response(JSON.stringify(points), { headers });
  },
);

export const handleBluechipRatings = createCacheHandler(
  "bluechip-ratings",
  "bluechip-ratings",
  CACHE_PROFILES.slow,
  API_FRESHNESS_MAX_AGE_SEC.bluechip,
  {
    schema: BluechipRatingsMapSchema,
    malformedMessage: "Cached bluechip-ratings payload is malformed",
  },
);

export const handleUsdsStatus = createCacheHandler(
  "usds-status",
  "usds-status",
  CACHE_PROFILES.standard,
  API_FRESHNESS_MAX_AGE_SEC.usdsStatus,
);

const YIELD_RANKINGS_MAX_AGE_SEC = CRON_INTERVALS["sync-yield-data"];

function recomputeYieldScore(row: YieldRanking, safetyInputScore: number, scalingFactor: number): number {
  return computePYS({
    apy30d: row.apy30d,
    safetyScore: safetyInputScore,
    apyVarianceScore: yieldStabilityToApyVarianceScore(row.yieldStability),
    scalingFactor,
    benchmarkRate: row.benchmarkRate ?? null,
  });
}

function hydrateYieldRankingsWithLiveSafety(
  payload: YieldRankingsResponse,
  cards: ReportCard[],
): YieldRankingsResponse {
  const reportCardById = new Map(
    cards
      .filter((card) => !card.isDefunct)
      .map((card) => [card.id, card]),
  );

  const rankings = payload.rankings
    .map((row) => {
      const card = reportCardById.get(row.id);
      const safetyInputScore = card?.overallScore ?? DEFAULT_SAFETY_SCORE;
      const pharosYieldScore = recomputeYieldScore(row, safetyInputScore, payload.scalingFactor);

      return {
        ...row,
        safetyScore: safetyInputScore,
        safetyGrade: card?.overallGrade ?? "NR",
        pharosYieldScore,
        yieldToRisk: 101 - safetyInputScore > 0 ? row.apy30d / (101 - safetyInputScore) : null,
        provenance: row.provenance
          ? {
            ...row.provenance,
            usedDefaultSafety: card?.overallScore == null,
          }
          : null,
      };
    })
    .sort((a, b) => {
      const scoreDiff = (b.pharosYieldScore ?? Number.NEGATIVE_INFINITY) - (a.pharosYieldScore ?? Number.NEGATIVE_INFINITY);
      if (scoreDiff !== 0) return scoreDiff;
      const apyDiff = b.currentApy - a.currentApy;
      if (apyDiff !== 0) return apyDiff;
      return a.name.localeCompare(b.name);
    });

  const activeCards = cards.filter((card) => !card.isDefunct);
  const coveredCount = activeCards.filter((card) => card.overallScore !== null).length;
  const trackedCount = activeCards.length;

  return {
    ...payload,
    rankings,
    provenance: payload.provenance
      ? {
        ...payload.provenance,
        safetySnapshot: {
          ...payload.provenance.safetySnapshot,
          coveredCount,
          trackedCount,
          coverageRatio: trackedCount > 0
            ? Number((coveredCount / trackedCount).toFixed(4))
            : 1,
          reason: null,
        },
      }
      : payload.provenance,
  };
}

/**
 * GET /api/yield-rankings
 * Returns cached yield rankings, with live Safety Score fields hydrated from the
 * current report-card snapshot so the endpoint cannot drift from /api/report-cards.
 */
export const handleYieldRankings = createCacheHandler(
  "yield-rankings",
  "yield-rankings",
  CACHE_PROFILES.standard,
  YIELD_RANKINGS_MAX_AGE_SEC,
  {
    schema: YieldRankingsResponseSchema,
    malformedMessage: "Cached yield-rankings payload is malformed",
    transform: async (payload, { db }) => {
      const validatedPayload = payload as YieldRankingsResponse;
      try {
        const snapshot = await buildReportCardsSnapshot(db);
        return hydrateYieldRankingsWithLiveSafety(validatedPayload, snapshot.cards);
      } catch (err) {
        console.warn("[yield-rankings] Live safety hydration failed:", err instanceof Error ? err.message : err);
        return validatedPayload;
      }
    },
  },
);
