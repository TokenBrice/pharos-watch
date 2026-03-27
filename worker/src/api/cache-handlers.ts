import type { ReportCard } from "@shared/types/report-cards";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { YieldRankingsResponseSchema, type YieldRanking, type YieldRankingsResponse } from "@shared/types/yield";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import {
  addFreshnessHeaders,
  buildFreshnessMeta,
  createCacheHandler,
  errorResponse,
  jsonResponse,
  readCachedJsonOr503,
  validatePayloadWithSchema,
  withErrorHandler,
} from "../lib/api-utils";
import { CACHE_PROFILES, DEFAULT_SAFETY_SCORE } from "../lib/constants";
import { getCache } from "../lib/db-cache";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";

export const handleStablecoins = createCacheHandler("stablecoins", "stablecoins", CACHE_PROFILES.realtime, 600);

export const handleStablecoinCharts = createCacheHandler("stablecoin-charts", "stablecoin-charts", CACHE_PROFILES.standard, 3600);

export const handleBluechipRatings = createCacheHandler("bluechip-ratings", "bluechip-ratings", CACHE_PROFILES.slow, 43200);

export const handleUsdsStatus = createCacheHandler("usds-status", "usds-status", CACHE_PROFILES.standard, DAY_SECONDS);

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
export const handleYieldRankings = withErrorHandler(
  "yield-rankings",
  async (db: D1Database): Promise<Response> => {
    const cached = await getCache(db, "yield-rankings");
    if (!cached) {
      return errorResponse(503, "Data not yet available");
    }

    const headers = addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    }, cached.updatedAt, YIELD_RANKINGS_MAX_AGE_SEC);

    const parsed = readCachedJsonOr503<unknown>("yield-rankings", "yield-rankings", cached);
    if (!parsed.ok) {
      return parsed.response;
    }

    let body = parsed.data;
    const validation = validatePayloadWithSchema(
      YieldRankingsResponseSchema,
      parsed.data,
      "yield-rankings:cache-read",
    );

    if (validation.ok) {
      try {
        const snapshot = await buildReportCardsSnapshot(db);
        body = hydrateYieldRankingsWithLiveSafety(validation.data, snapshot.cards);
      } catch (err) {
        console.warn("[yield-rankings] Live safety hydration failed:", err instanceof Error ? err.message : err);
        body = validation.data;
      }
    }

    if (body && typeof body === "object" && !Array.isArray(body)) {
      (body as Record<string, unknown>)._meta = buildFreshnessMeta(cached.updatedAt, YIELD_RANKINGS_MAX_AGE_SEC);
      return jsonResponse(body, headers);
    }

    return new Response(cached.value, { headers });
  },
);
