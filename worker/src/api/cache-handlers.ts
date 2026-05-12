import type { ReportCard } from "@shared/types/report-cards";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { UsdsStatusResponse } from "@shared/types";
import { UsdsStatusResponseSchema } from "@shared/types/digest";
import { YieldRankingsResponseSchema, type YieldRanking, type YieldRankingsResponse } from "@shared/types/yield";
import { BluechipRatingsMapSchema, StablecoinListResponseSchema } from "@shared/types/market";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import {
  addFreshnessHeaders,
  buildFreshnessMeta,
  createCacheHandler,
  errorResponse,
  jsonResponse,
} from "../lib/api-utils";
import { CACHE_PROFILES, DEFAULT_SAFETY_SCORE } from "../lib/constants";
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
  {
    schema: StablecoinListResponseSchema,
    malformedMessage: "Cached stablecoins payload is malformed",
  },
);

export const handleStablecoinCharts = createCacheHandler(
  "stablecoin-charts",
  "stablecoin-charts",
  CACHE_PROFILES.standard,
  API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts,
  {
    injectMeta: "never",
    transform: async (payload, { db }) => {
      const normalizedPoints = normalizeStablecoinChartPoints(payload);
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

      return points;
    },
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
  {
    schema: UsdsStatusResponseSchema,
    malformedMessage: "Cached usds-status payload is malformed",
    transform: (payload, { cached }) => {
      const status = payload as UsdsStatusResponse;
      if (status.lastChecked > 0) {
        return status;
      }
      return {
        ...status,
        lastChecked: cached.updatedAt,
      };
    },
  },
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
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  const reportCardById = new Map(cards.filter((card) => !card.isDefunct).map((card) => [card.id, card]));

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
              safetyProvenance:
                card?.overallScore == null ? ("default-safety" as const) : ("live-report-card" as const),
            }
          : null,
      };
    })
    .sort((a, b) => {
      const scoreDiff =
        (b.pharosYieldScore ?? Number.NEGATIVE_INFINITY) - (a.pharosYieldScore ?? Number.NEGATIVE_INFINITY);
      if (scoreDiff !== 0) return scoreDiff;
      const apyDiff = b.currentApy - a.currentApy;
      if (apyDiff !== 0) return apyDiff;
      return a.name.localeCompare(b.name);
    });

  const coveredCount = rankings.filter((row) => row.provenance?.safetyProvenance === "live-report-card").length;
  const trackedCount = rankings.length;
  const coverageRatio = trackedCount > 0 ? Number((coveredCount / trackedCount).toFixed(4)) : 1;
  const degradationReasons = coverageRatio < 0.75 ? ["low-row-safety-coverage"] : [];

  return {
    degradationReasons,
    payload: {
      ...payload,
      ...(degradationReasons.length > 0
        ? {
            warnings: [
              ...(payload.warnings ?? []),
              {
                code: "yield-safety-hydration-degraded",
                message: "Live safety hydration coverage is degraded for public yield rankings.",
                reasons: degradationReasons,
              },
            ],
          }
        : {}),
      rankings,
      provenance: payload.provenance
        ? {
            ...payload.provenance,
            safetySnapshot: {
              ...payload.provenance.safetySnapshot,
              coveredCount,
              trackedCount,
              coverageRatio,
              reason: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
            },
          }
        : payload.provenance,
    },
  };
}

function buildYieldRankingsResponse(
  payload: YieldRankingsResponse,
  cached: { updatedAt: number },
  warningReasons: string[],
): Response {
  const warning =
    warningReasons.length > 0 ? `199 - "Yield safety hydration degraded: ${warningReasons.join(",")}"` : null;
  const headers = addFreshnessHeaders(
    {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
      ...(warning ? { Warning: warning } : {}),
    },
    cached.updatedAt,
    YIELD_RANKINGS_MAX_AGE_SEC,
  );
  if (warning && headers.Warning && !headers.Warning.includes(warning)) {
    headers.Warning = `${headers.Warning}, ${warning}`;
  }
  return jsonResponse(
    {
      ...payload,
      _meta: buildFreshnessMeta(cached.updatedAt, YIELD_RANKINGS_MAX_AGE_SEC),
    },
    headers,
  );
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
    transform: async (payload, { db, cached }) => {
      const validatedPayload = payload as YieldRankingsResponse;
      try {
        const snapshot = await buildReportCardsSnapshot(db);
        const hydrated = hydrateYieldRankingsWithLiveSafety(validatedPayload, snapshot.cards);
        if (hydrated.degradationReasons.length > 0) {
          return buildYieldRankingsResponse(hydrated.payload, cached, hydrated.degradationReasons);
        }
        return hydrated.payload;
      } catch (err) {
        console.warn("[yield-rankings] Live safety hydration failed:", err instanceof Error ? err.message : err);
        const degradedPayload: YieldRankingsResponse = {
          ...validatedPayload,
          warnings: [
            ...(validatedPayload.warnings ?? []),
            {
              code: "yield-safety-hydration-degraded",
              message: "Live safety hydration failed; cached published safety fields were returned.",
              reasons: ["live-report-card-hydration-failed"],
            },
          ],
        };
        return buildYieldRankingsResponse(degradedPayload, cached, ["live-report-card-hydration-failed"]);
      }
    },
  },
);
