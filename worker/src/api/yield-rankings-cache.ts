import type { ReportCard } from "@shared/types/report-cards";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  YieldRankingsResponseSchema,
  type YieldCalculationMode,
  type YieldEvidenceClass,
  type YieldRankChangeAttribution,
  type YieldRankChangeDriver,
  type YieldRanking,
  type YieldRankingsResponse,
  type YieldSafetyReason,
} from "@shared/types/yield";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { assessYieldEvidence } from "@shared/lib/yield-evidence";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import { scoreToGrade } from "@shared/lib/report-card-core";
import { computeRoycoDawnTrancheSafetyScore, isRoycoDawnTrancheSourceRisk } from "@shared/lib/royco-tranche-safety";
import { classifyYieldSourceFreshness, derivePysNullReason } from "../cron/yield-helpers";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import {
  addFreshnessHeaders,
  buildFreshnessMeta,
  buildMethodologyEnvelope,
  createCacheHandler,
  errorResponse,
  jsonResponse,
} from "../lib/api-utils";
import { CACHE_PROFILES, DEFAULT_SAFETY_SCORE } from "../lib/constants";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { loadPublishedReportCardsSnapshot } from "../lib/report-cards-snapshot-cache";

const YIELD_RANKINGS_MAX_AGE_SEC = CRON_INTERVALS["sync-yield-data"];

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function roundDelta(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function buildYieldMethodology(asOf: number) {
  return buildMethodologyEnvelope({
    version: YIELD_METHODOLOGY_VERSION,
    versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    currentVersion: YIELD_METHODOLOGY_VERSION,
    currentVersionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    asOf,
  });
}

function resolveYieldPublicationMetadata(
  payload: YieldRankingsResponse,
  cached: { updatedAt: number },
): YieldRankingsResponse["publication"] {
  if (payload.publication) return payload.publication;

  const generationIds = new Set(
    payload.rankings
      .map((row) => row.publicationGenerationId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  if (generationIds.size !== 1) return payload.publication;

  const updatedAt = finiteNumber(payload.updatedAt) ?? cached.updatedAt;
  return {
    generationId: [...generationIds][0] ?? null,
    updatedAt,
    cutoffAt: updatedAt,
    schemaVersion: 1,
    status: "published",
  };
}

function normalizeYieldRankingsContract(
  payload: YieldRankingsResponse,
  cached: { updatedAt: number },
): YieldRankingsResponse {
  const publication = resolveYieldPublicationMetadata(payload, cached);
  const generationId =
    typeof publication?.generationId === "string" && publication.generationId.length > 0
      ? publication.generationId
      : null;

  return {
    ...payload,
    ...(publication ? { publication } : {}),
    methodology: payload.methodology ?? buildYieldMethodology(finiteNumber(payload.updatedAt) ?? cached.updatedAt),
    rankings: payload.rankings.map((row, index) => ({
      ...row,
      ...(row.publicationGenerationId === undefined && generationId ? { publicationGenerationId: generationId } : {}),
      ...(row.publishedRank === undefined && generationId ? { publishedRank: index + 1 } : {}),
    })),
  };
}

function recomputeYieldScore(row: YieldRanking, safetyInputScore: number, scalingFactor: number): number {
  return computePYS({
    apy30d: row.apy30d,
    safetyScore: safetyInputScore,
    apyVarianceScore: yieldStabilityToApyVarianceScore(row.yieldStability),
    scalingFactor,
    benchmarkRate: row.benchmarkRate ?? null,
    sourceRiskPenalty: row.sourceRisk?.sourceRiskPenalty ?? null,
  });
}

function resolveHydratedEvidenceClass(row: YieldRanking): YieldEvidenceClass {
  if (row.provenance?.evidenceClass) return row.provenance.evidenceClass;
  switch (row.dataSource) {
    case "onchain":
      return "direct-onchain";
    case "protocol-api":
      return row.provenance?.sourceKey.startsWith("protocol-api:vaults-fyi:")
        ? "curated-observation"
        : "direct-first-party";
    case "defillama":
      return "curated-observation";
    case "defillama-auto":
      return "discovered-observation";
    case "rate-derived":
      return "modeled-proxy";
    case "price-derived":
    default:
      return "fallback";
  }
}

function resolveHydratedCalculationMode(row: YieldRanking): YieldCalculationMode {
  if (row.provenance?.calculationMode) return row.provenance.calculationMode;
  if (row.dataSource === "rate-derived") return "benchmark-model";
  if (row.dataSource === "price-derived") return "price-return";
  if (row.dataSource === "onchain") return "direct-read";
  return "market-api";
}

function resolveHydratedSourceFreshness(row: YieldRanking): "fresh" | "stale" | "unknown" {
  if (row.provenance?.sourceFreshness) return row.provenance.sourceFreshness;
  if (row.warningSignals.includes("data-stale")) return "stale";
  if (row.provenance) {
    return classifyYieldSourceFreshness({
      dataSource: row.dataSource,
      sourceKey: row.provenance.sourceKey,
      sourceAgeSeconds: finiteNumber(row.provenance.sourceAgeSeconds),
      comparisonAnchorAgeSeconds: finiteNumber(row.provenance.comparisonAnchorAgeSeconds),
    });
  }
  return "unknown";
}

function resolveHydratedBenchmarkFreshness(row: YieldRanking): "healthy" | "degraded" | "stale" {
  if (row.provenance?.benchmarkFreshness) return row.provenance.benchmarkFreshness;
  if (row.warningSignals.includes("benchmark-stale")) return "stale";
  return row.warningSignals.includes("benchmark-degraded") ? "degraded" : "healthy";
}

function selectRankChangeDriver(params: {
  row: YieldRanking;
  anySafetyHydrationChanged: boolean;
  pysDelta: number | null;
  rankDelta: number;
}): YieldRankChangeDriver {
  if (params.anySafetyHydrationChanged) return "stablecoin-safety";
  if (params.row.provenance?.sourceSwitch) return "source-switch";
  const sourceRiskPenalty = finiteNumber(params.row.sourceRisk?.sourceRiskPenalty);
  if (sourceRiskPenalty != null && sourceRiskPenalty > 1) return "source-risk";
  if (params.row.warningSignals.includes("data-stale")) return "freshness";
  if (finiteNumber(params.row.yieldStability) != null && (params.row.yieldStability ?? 1) < 0.7) {
    return "volatility";
  }
  if (
    finiteNumber(params.row.sourceRisk?.sourceDepthRatio) != null &&
    (params.row.sourceRisk?.sourceDepthRatio ?? 1) < 0.05
  ) {
    return "tvl-depth";
  }
  if (params.row.benchmarkIsFallback === true || params.row.benchmarkFallbackMode) return "benchmark";
  return params.pysDelta == null || params.pysDelta === 0 ? "apy" : "stablecoin-safety";
}

function buildRankChangeAttribution(params: {
  originalRow: YieldRanking;
  hydratedRow: YieldRanking;
  anySafetyHydrationChanged: boolean;
}): YieldRankChangeAttribution | null {
  const previousRank = positiveInteger(params.hydratedRow.publishedRank);
  const liveRank = positiveInteger(params.hydratedRow.liveRank);
  if (previousRank == null || liveRank == null || previousRank === liveRank) {
    return params.originalRow.rankChangeAttribution ?? null;
  }

  const previousPys = finiteNumber(params.originalRow.pharosYieldScore);
  const livePys = finiteNumber(params.hydratedRow.pharosYieldScore);
  const pysDelta = previousPys != null && livePys != null ? roundDelta(livePys - previousPys) : null;
  const rankDelta = previousRank - liveRank;
  const sourceRiskPenalty = finiteNumber(params.hydratedRow.sourceRisk?.sourceRiskPenalty);
  const sourceDepthRatio = finiteNumber(params.hydratedRow.sourceRisk?.sourceDepthRatio);

  const primaryDriver = selectRankChangeDriver({
    row: params.hydratedRow,
    anySafetyHydrationChanged: params.anySafetyHydrationChanged,
    pysDelta,
    rankDelta,
  });

  return {
    previousRank,
    rankDelta,
    previousPys,
    pysDelta,
    primaryDriver,
    driverContributions: {
      apy: primaryDriver === "apy" ? rankDelta : null,
      benchmark: primaryDriver === "benchmark" ? rankDelta : null,
      stablecoinSafety: params.anySafetyHydrationChanged ? (pysDelta ?? 0) : null,
      sourceRisk: sourceRiskPenalty != null && sourceRiskPenalty > 1 ? roundDelta(1 - sourceRiskPenalty) : null,
      sourceSwitch: params.hydratedRow.provenance?.sourceSwitch ? rankDelta : null,
      freshness: params.hydratedRow.warningSignals.includes("data-stale") ? rankDelta : null,
      volatility:
        finiteNumber(params.hydratedRow.yieldStability) != null && (params.hydratedRow.yieldStability ?? 1) < 0.7
          ? rankDelta
          : null,
      tvlDepth: sourceDepthRatio != null && sourceDepthRatio < 0.05 ? rankDelta : null,
    },
  };
}

function hydrateRoycoTrancheSourceRisk(params: {
  sourceRisk: YieldRanking["sourceRisk"];
  underlyingSafetyScore: number;
}): YieldRanking["sourceRisk"] {
  if (!isRoycoDawnTrancheSourceRisk(params.sourceRisk)) return params.sourceRisk;

  const trancheSafety = computeRoycoDawnTrancheSafetyScore({
    underlyingSafetyScore: params.underlyingSafetyScore,
    sourceRisk: params.sourceRisk,
  });
  if (!trancheSafety) return params.sourceRisk;

  return {
    ...params.sourceRisk,
    underlyingSafetyScore: params.underlyingSafetyScore,
    trancheSafetyScore: trancheSafety.score,
    trancheSafetyPenalty: trancheSafety.penalty,
  };
}

function resolveHydratedSafety(params: { row: YieldRanking; card: ReportCard | undefined }): {
  score: number;
  grade: YieldRanking["safetyGrade"];
  sourceRisk: YieldRanking["sourceRisk"];
  provenance: NonNullable<YieldRanking["provenance"]>["safetyProvenance"];
  usedDefaultSafety: boolean;
  reason: YieldSafetyReason | null;
} {
  const underlyingSafetyScore = params.card?.overallScore ?? DEFAULT_SAFETY_SCORE;
  const usedDefaultSafety = params.card?.overallScore == null;

  const hydratedSourceRisk = hydrateRoycoTrancheSourceRisk({
    sourceRisk: params.row.sourceRisk,
    underlyingSafetyScore,
  });

  if (isRoycoDawnTrancheSourceRisk(hydratedSourceRisk)) {
    const trancheSafetyScore = hydratedSourceRisk.trancheSafetyScore;
    if (trancheSafetyScore != null) {
      return {
        score: trancheSafetyScore,
        grade: scoreToGrade(trancheSafetyScore),
        sourceRisk: hydratedSourceRisk,
        provenance: "opportunity-safety",
        usedDefaultSafety,
        reason: usedDefaultSafety ? "underlying-report-card-score-missing" : null,
      };
    }
  }

  return {
    score: underlyingSafetyScore,
    grade: params.card?.overallGrade ?? "NR",
    sourceRisk: hydratedSourceRisk,
    provenance: usedDefaultSafety ? "default-safety" : "live-report-card",
    usedDefaultSafety,
    reason: usedDefaultSafety
      ? "report-card-score-missing"
      : params.card?.overallGrade === "NR"
        ? "report-card-grade-not-rated"
        : null,
  };
}

function hydrateAltSourcesWithLiveSafety(row: YieldRanking, underlyingSafetyScore: number): YieldRanking["altSources"] {
  return row.altSources.map((source) => {
    const sourceRisk = hydrateRoycoTrancheSourceRisk({
      sourceRisk: source.sourceRisk ?? null,
      underlyingSafetyScore,
    });
    return sourceRisk === source.sourceRisk ? source : { ...source, sourceRisk };
  });
}

interface LiveSafetyHydrationSource {
  source: "report-cards:snapshot" | "computed-report-cards";
  publicationGenerationId: string | null;
  methodologyVersion: string | null;
  publishedAt: number | null;
  degradationReasons: string[];
}

function hydrateYieldRankingsWithLiveSafety(
  payload: YieldRankingsResponse,
  cards: ReportCard[],
  source: LiveSafetyHydrationSource,
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  const reportCardById = new Map(cards.filter((card) => !card.isDefunct).map((card) => [card.id, card]));

  const hydratedRows = payload.rankings
    .map((row) => {
      const card = reportCardById.get(row.id);
      const hydratedSafety = resolveHydratedSafety({ row, card });
      const safetyInputScore = hydratedSafety.score;
      const underlyingSafetyScore = card?.overallScore ?? DEFAULT_SAFETY_SCORE;
      const sourceFreshness = resolveHydratedSourceFreshness(row);
      const benchmarkFreshness = resolveHydratedBenchmarkFreshness(row);
      const evidenceClass = resolveHydratedEvidenceClass(row);
      const evidenceAssessment = assessYieldEvidence({
        evidenceClass,
        safetyObserved: !hydratedSafety.usedDefaultSafety && hydratedSafety.grade !== "NR",
        sourceFreshness,
        benchmarkFreshness,
        hasSourceDepth: finiteNumber(hydratedSafety.sourceRisk?.sourceDepthRatio) != null,
        hasVenueRisk:
          hydratedSafety.sourceRisk?.venueRiskTier != null && hydratedSafety.sourceRisk.venueRiskTier !== "unknown",
        hasHistory: (finiteNumber(hydratedSafety.sourceRisk?.observationCount30d) ?? 0) > 1,
        hasYieldDecomposition: row.apyBase != null || row.apyReward != null,
      });
      const evidenceNullReason =
        sourceFreshness === "stale" || row.warningSignals.includes("data-stale")
          ? ("source-stale" as const)
          : sourceFreshness === "unknown"
            ? ("source-freshness-unknown" as const)
            : benchmarkFreshness === "stale" || row.warningSignals.includes("benchmark-stale")
              ? ("benchmark-stale" as const)
              : evidenceAssessment.scoreQualification === "NR"
                ? ("safety-unrated" as const)
                : null;
      const recomputedPharosYieldScore = recomputeYieldScore(row, safetyInputScore, payload.scalingFactor);
      const pharosYieldScore = evidenceNullReason == null ? recomputedPharosYieldScore : null;
      const pysNullReason =
        evidenceNullReason ??
        (recomputedPharosYieldScore > 0
          ? null
          : derivePysNullReason({
              apy30d: row.apy30d,
              safetyScore: safetyInputScore,
              apyVarianceScore: yieldStabilityToApyVarianceScore(row.yieldStability),
              scalingFactor: payload.scalingFactor,
              benchmarkRate: row.benchmarkRate ?? null,
              sourceRiskPenalty: row.sourceRisk?.sourceRiskPenalty ?? null,
            }));

      return {
        originalRow: row,
        safetyChanged: row.safetyScore !== safetyInputScore,
        row: {
          ...row,
          safetyScore: safetyInputScore,
          safetyGrade: hydratedSafety.grade,
          safetyReason: hydratedSafety.reason,
          pharosYieldScore,
          pysNullReason,
          yieldToRisk: 101 - safetyInputScore > 0 ? row.apy30d / (101 - safetyInputScore) : null,
          sourceRisk: hydratedSafety.sourceRisk,
          altSources: hydrateAltSourcesWithLiveSafety(row, underlyingSafetyScore),
          provenance: row.provenance
            ? {
                ...row.provenance,
                usedDefaultSafety: hydratedSafety.usedDefaultSafety,
                safetyProvenance: hydratedSafety.provenance,
                safetyReason: hydratedSafety.reason,
                calculationMode: resolveHydratedCalculationMode(row),
                evidenceClass,
                evidenceCompleteness: evidenceAssessment.evidenceCompleteness,
                scoreQualification: evidenceAssessment.scoreQualification,
                sourceFreshness,
                benchmarkFreshness,
                scoreQualified: evidenceAssessment.scoreQualification !== "NR",
              }
            : null,
        },
      };
    })
    .sort((a, b) => {
      const aScore = finiteNumber(a.row.pharosYieldScore);
      const bScore = finiteNumber(b.row.pharosYieldScore);
      if (aScore != null || bScore != null) {
        if (aScore == null) return 1;
        if (bScore == null) return -1;
        if (aScore !== bScore) return bScore - aScore;
      }
      const apyDiff = b.row.currentApy - a.row.currentApy;
      if (apyDiff !== 0) return apyDiff;
      return a.row.name.localeCompare(b.row.name);
    });

  const anySafetyHydrationChanged = hydratedRows.some((entry) => entry.safetyChanged);
  const rankings = hydratedRows.map((entry, index) => {
    const row = {
      ...entry.row,
      liveRank: index + 1,
    };
    const rankChangeAttribution = buildRankChangeAttribution({
      originalRow: entry.originalRow,
      hydratedRow: row,
      anySafetyHydrationChanged,
    });
    return rankChangeAttribution == null && entry.originalRow.rankChangeAttribution === undefined
      ? row
      : { ...row, rankChangeAttribution };
  });

  const coveredCount = rankings.filter(
    (row) =>
      row.provenance?.safetyProvenance === "live-report-card" ||
      (row.provenance?.safetyProvenance === "opportunity-safety" && row.provenance.usedDefaultSafety !== true),
  ).length;
  const trackedCount = rankings.length;
  const coverageRatio = trackedCount > 0 ? Number((coveredCount / trackedCount).toFixed(4)) : 1;
  const degradationReasons = [
    ...source.degradationReasons,
    ...(coverageRatio < 0.75 ? ["low-row-safety-coverage"] : []),
  ];
  const { degradationReasons: _sourceDegradationReasons, ...liveSafetySource } = source;

  return {
    degradationReasons,
    payload: {
      ...payload,
      methodology:
        payload.methodology ?? buildYieldMethodology(finiteNumber(payload.updatedAt) ?? Math.floor(Date.now() / 1000)),
      ...(degradationReasons.length > 0
        ? {
            warnings: [
              ...(payload.warnings ?? []),
              {
                code: "yield-safety-hydration-degraded",
                message: "Live safety hydration is degraded for public yield rankings.",
                reasons: degradationReasons,
              },
            ],
          }
        : {}),
      rankings,
      provenance: payload.provenance
        ? {
            ...payload.provenance,
            liveSafetyHydration: {
              kind: degradationReasons.length > 0 ? "degraded" : "ok",
              coveredCount,
              trackedCount,
              coverageRatio,
              reason: degradationReasons.length > 0 ? degradationReasons.join(",") : null,
              ...liveSafetySource,
            },
          }
        : payload.provenance,
    },
  };
}

function getReportCardHydrationDegradationReasons(snapshot: {
  updatedAt?: number;
  liquidityStale?: boolean;
  redemptionStale?: boolean;
  inputFreshness?: {
    dexLiquidity?: { stale?: boolean };
    redemptionBackstops?: { stale?: boolean };
  };
}): string[] {
  const reasons: string[] = [];
  if (snapshot.liquidityStale || snapshot.inputFreshness?.dexLiquidity?.stale) {
    reasons.push("dex-liquidity-input-stale");
  }
  if (snapshot.redemptionStale || snapshot.inputFreshness?.redemptionBackstops?.stale) {
    reasons.push("redemption-backstop-input-stale");
  }
  if (
    snapshot.updatedAt != null &&
    Math.floor(Date.now() / 1000) - snapshot.updatedAt > API_FRESHNESS_MAX_AGE_SEC.reportCards
  ) {
    reasons.push("report-card-snapshot-stale");
  }
  return reasons;
}

function buildYieldRankingsResponse(
  payload: YieldRankingsResponse | YieldRankingsSummaryResponse,
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
function createYieldRankingsCacheHandler(
  endpoint: "yield-rankings" | "yield-rankings-summary",
  projection: "detailed" | "summary",
) {
  const project = (payload: YieldRankingsResponse) =>
    projection === "summary" ? projectYieldRankingsSummary(payload) : payload;

  return createCacheHandler(endpoint, "yield-rankings", CACHE_PROFILES.standard, YIELD_RANKINGS_MAX_AGE_SEC, {
    schema: YieldRankingsResponseSchema,
    malformedMessage: "Cached yield-rankings payload is malformed",
    transform: async (payload, { db, cached }) => {
      const validatedPayload = normalizeYieldRankingsContract(payload as YieldRankingsResponse, cached);
      try {
        const publishedSnapshot = await loadPublishedReportCardsSnapshot(db);
        let cards: ReportCard[];
        let hydrationSource: LiveSafetyHydrationSource;
        if (publishedSnapshot.kind === "ok") {
          cards = publishedSnapshot.payload.cards;
          hydrationSource = {
            source: "report-cards:snapshot",
            publicationGenerationId: publishedSnapshot.payload.publication?.generationId ?? null,
            methodologyVersion: publishedSnapshot.payload.publication?.methodologyVersion ?? null,
            publishedAt: publishedSnapshot.payload.updatedAt,
            degradationReasons: getReportCardHydrationDegradationReasons(publishedSnapshot.payload),
          };
        } else {
          const computedSnapshot = await buildReportCardsSnapshot(db);
          cards = computedSnapshot.cards;
          hydrationSource = {
            source: "computed-report-cards",
            publicationGenerationId: null,
            methodologyVersion: null,
            publishedAt: null,
            degradationReasons: getReportCardHydrationDegradationReasons(computedSnapshot),
          };
        }
        if (publishedSnapshot.kind !== "ok") {
          console.warn(
            `[yield-rankings] Published report-card snapshot unavailable; computed fallback reason=${publishedSnapshot.reason}`,
          );
        }
        const hydrated = hydrateYieldRankingsWithLiveSafety(validatedPayload, cards, hydrationSource);
        if (hydrated.degradationReasons.length > 0) {
          return buildYieldRankingsResponse(project(hydrated.payload), cached, hydrated.degradationReasons);
        }
        return project(hydrated.payload);
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
        return buildYieldRankingsResponse(project(degradedPayload), cached, ["live-report-card-hydration-failed"]);
      }
    },
  });
}

const handleDetailedYieldRankings = createYieldRankingsCacheHandler("yield-rankings", "detailed");
const handleSummaryYieldRankings = createYieldRankingsCacheHandler("yield-rankings-summary", "summary");

export async function handleYieldRankings(db: D1Database, url?: URL): Promise<Response> {
  const projectionValues = url?.searchParams.getAll("projection") ?? [];
  if (projectionValues.length === 0) {
    return handleDetailedYieldRankings(db);
  }
  if (projectionValues.length === 1 && projectionValues[0] === "summary") {
    return handleSummaryYieldRankings(db);
  }
  return errorResponse(400, 'Invalid projection parameter: expected "summary"', { noStore: true });
}
