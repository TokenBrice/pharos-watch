import { logWorkerEventArgs } from "../lib/structured-log";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "@shared/lib/yield-safety-fallback";
import {
  YieldRankingsResponseSchema,
  type YieldCalculationMode,
  type YieldEvidenceClass,
  type YieldRankChangeAttribution,
  type YieldRankChangeDriver,
  type YieldRanking,
  type YieldRankingsResponse,
  type YieldSafetyReason,
  type YieldVenueRiskTier,
} from "@shared/types/yield";
import { computePYS, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { assessYieldEvidence } from "@shared/lib/yield-evidence";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import { resolveYieldRowSafety } from "@shared/lib/yield-opportunity-risk";
import { classifyYieldSourceFreshness, derivePysNullReason } from "../lib/yield-ranking-helpers";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/yield-methodology";
import { addFreshnessHeaders, buildFreshnessMeta } from "../lib/api-freshness";
import { buildMethodologyEnvelope } from "../lib/api-methodology";
import { createCacheHandler } from "../lib/api-cache-read";
import { errorResponse, jsonResponseWithHeaders } from "../lib/api-response";
import { CACHE_PROFILES, DEFAULT_SAFETY_SCORE } from "../lib/constants";
import { computeSafetyScoresSnapshot } from "../lib/safety-scores";

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

/**
 * Live-safety hydration re-runs the canonical yield safety-resolution ladder
 * (`resolveYieldRowSafety`) against the freshly published report-card scores —
 * the same engine the yield-sync write path runs, so the read path re-bins
 * rather than re-deriving (ADR-19).
 */
function resolveHydratedSafety(params: { row: YieldRanking; safety: { score: number; grade: string } | undefined }): {
  score: number;
  grade: YieldRanking["safetyGrade"];
  sourceRisk: YieldRanking["sourceRisk"];
  provenance: NonNullable<YieldRanking["provenance"]>["safetyProvenance"];
  usedDefaultSafety: boolean;
  reason: YieldSafetyReason | null;
  safetyEvidenceObserved: boolean;
  opportunityEvidenceComplete: boolean;
  venueRiskTier: YieldVenueRiskTier;
} {
  const resolution = resolveYieldRowSafety({
    yieldType: params.row.yieldType,
    underlyingSafety: params.safety,
    defaultSafetyScore: DEFAULT_SAFETY_SCORE,
    sourceRisk: params.row.sourceRisk,
    sourceTvlUsd: params.row.sourceTvlUsd,
    ratedProvenance: "live-report-card",
  });
  return {
    score: resolution.safetyScore,
    grade: resolution.safetyGrade as YieldRanking["safetyGrade"],
    sourceRisk: resolution.sourceRisk,
    provenance: resolution.safetyProvenance,
    usedDefaultSafety: resolution.usedDefaultSafety,
    reason: resolution.safetyReason,
    safetyEvidenceObserved: resolution.safetyEvidenceObserved,
    opportunityEvidenceComplete: resolution.opportunityEvidenceComplete,
    venueRiskTier: resolution.venueRiskTier,
  };
}

function hydrateAltSourcesWithLiveSafety(
  row: YieldRanking,
  safety: { score: number; grade: string } | undefined,
): YieldRanking["altSources"] {
  return row.altSources.map((source) => {
    const { sourceRisk } = resolveYieldRowSafety({
      yieldType: source.yieldType,
      underlyingSafety: safety,
      defaultSafetyScore: DEFAULT_SAFETY_SCORE,
      sourceRisk: source.sourceRisk ?? null,
      sourceTvlUsd: source.sourceTvlUsd,
      ratedProvenance: "live-report-card",
    });
    return sourceRisk === source.sourceRisk ? source : { ...source, sourceRisk };
  });
}

interface LiveSafetyHydrationSource {
  source: "safety-score-v9-publication";
  safetyScoreIdentity: SafetyScorePublicationIdentity | null;
  publicationGenerationId: string | null;
  methodologyVersion: string | null;
  publishedAt: number | null;
  degradationReasons: string[];
}

function hydrateYieldRankingsWithLiveSafety(
  payload: YieldRankingsResponse,
  scores: Map<string, { score: number; grade: string }>,
  source: LiveSafetyHydrationSource,
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  const hydratedRows = payload.rankings
    .map((row) => {
      const safety = scores.get(row.id);
      const hydratedSafety = resolveHydratedSafety({ row, safety });
      const safetyInputScore = hydratedSafety.score;
      const sourceFreshness = resolveHydratedSourceFreshness(row);
      const benchmarkFreshness = resolveHydratedBenchmarkFreshness(row);
      const evidenceClass = resolveHydratedEvidenceClass(row);
      const opportunityEvidenceComplete = hydratedSafety.opportunityEvidenceComplete;
      const safetyObserved = hydratedSafety.safetyEvidenceObserved;
      const evidenceAssessment = assessYieldEvidence({
        evidenceClass,
        safetyObserved,
        sourceFreshness,
        benchmarkFreshness,
        hasSourceDepth: finiteNumber(hydratedSafety.sourceRisk?.sourceDepthRatio) != null,
        hasVenueRisk: hydratedSafety.venueRiskTier !== "unknown",
        hasHistory: (finiteNumber(hydratedSafety.sourceRisk?.observationCount30d) ?? 0) > 1,
        hasYieldDecomposition: row.apyBase != null || row.apyReward != null,
        opportunityEvidenceComplete,
      });
      const warningSignals = row.warningSignals.filter((signal) =>
        (signal !== "safety-unrated" || !safetyObserved) &&
        (signal !== "opportunity-evidence-missing" || !opportunityEvidenceComplete),
      );
      if (!safetyObserved && !warningSignals.includes("safety-unrated")) {
        warningSignals.push("safety-unrated");
      }
      if (!opportunityEvidenceComplete && !warningSignals.includes("opportunity-evidence-missing")) {
        warningSignals.push("opportunity-evidence-missing");
      }
      const evidenceNullReason =
        sourceFreshness === "stale" || warningSignals.includes("data-stale")
          ? ("source-stale" as const)
          : sourceFreshness === "unknown"
            ? ("source-freshness-unknown" as const)
            : benchmarkFreshness === "stale" || warningSignals.includes("benchmark-stale")
              ? ("benchmark-stale" as const)
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
          warningSignals,
          yieldToRisk: 101 - safetyInputScore > 0 ? row.apy30d / (101 - safetyInputScore) : null,
          sourceRisk: hydratedSafety.sourceRisk,
          altSources: hydrateAltSourcesWithLiveSafety(row, safety),
          provenance: row.provenance
            ? {
                ...row.provenance,
                usedDefaultSafety: hydratedSafety.usedDefaultSafety,
                safetyProvenance: hydratedSafety.provenance,
                safetyReason: hydratedSafety.reason,
                safetyScoreIdentity: source.safetyScoreIdentity,
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

function hasCompatibleSafetyIdentity(
  payload: YieldRankingsResponse,
  identity: SafetyScorePublicationIdentity,
): boolean {
  const published = payload.provenance?.safetySnapshot.safetyScoreIdentity;
  return (
    published != null &&
    safetyScorePublicationIdentitiesAreComparable(published, identity)
  );
}

function removeSafetyDerivedSourceRisk(sourceRisk: YieldRanking["sourceRisk"]): YieldRanking["sourceRisk"] {
  if (sourceRisk == null) return sourceRisk;

  const { opportunityRisk: _opportunityRisk, ...independentSourceRisk } = sourceRisk;
  return {
    ...independentSourceRisk,
    underlyingSafetyScore: null,
    trancheSafetyScore: null,
    trancheSafetyPenalty: null,
  };
}

function removeSafetyDerivedRankChangeAttribution(
  attribution: YieldRanking["rankChangeAttribution"],
): YieldRanking["rankChangeAttribution"] {
  if (attribution == null) return attribution;

  return {
    ...attribution,
    previousPys: null,
    pysDelta: null,
    primaryDriver: attribution.primaryDriver === "stablecoin-safety" ? null : attribution.primaryDriver,
    driverContributions: attribution.driverContributions
      ? { ...attribution.driverContributions, stablecoinSafety: null }
      : attribution.driverContributions,
  };
}

/**
 * The cached payload was published under one safety identity, so its own
 * safety-derived values are coherent by construction. When live hydration is
 * unusable, serving them stale (bounded by the stale-coherent window) beats
 * blanking every safety field.
 */
function canServePublishTimeSafety(
  payload: YieldRankingsResponse,
  cached: { updatedAt: number },
): boolean {
  return (
    payload.provenance?.safetySnapshot.safetyScoreIdentity != null &&
    Math.floor(Date.now() / 1000) - cached.updatedAt <= YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC
  );
}

function markYieldRankingsSafetyStale(
  payload: YieldRankingsResponse,
  reason: "safety-snapshot-unavailable" | "safety-identity-missing" | "safety-identity-mismatch",
  source: LiveSafetyHydrationSource,
): YieldRankingsResponse {
  const trackedCount = payload.rankings.length;
  const coveredCount = payload.rankings.filter((row) => row.safetyScore !== null).length;
  const { degradationReasons: _degradationReasons, ...liveSafetySource } = source;
  return {
    ...payload,
    warnings: [
      ...(payload.warnings ?? []),
      {
        code: "yield-safety-hydration-stale",
        message:
          "Live yield safety hydration is unavailable; serving the last coherent published safety snapshot.",
        reasons: [reason],
      },
    ],
    provenance: payload.provenance
      ? {
          ...payload.provenance,
          liveSafetyHydration: {
            kind: "degraded" as const,
            fallback: "publish-time-snapshot" as const,
            coveredCount,
            trackedCount,
            coverageRatio: trackedCount > 0 ? Number((coveredCount / trackedCount).toFixed(4)) : 1,
            reason,
            ...liveSafetySource,
          },
        }
      : payload.provenance,
  };
}

function degradeYieldRankingsSafety(
  payload: YieldRankingsResponse,
  reason: "safety-snapshot-unavailable" | "safety-identity-missing" | "safety-identity-mismatch",
  source: LiveSafetyHydrationSource,
): YieldRankingsResponse {
  const rankings = payload.rankings.map((row) => ({
    ...row,
    safetyScore: null,
    safetyGrade: "NR" as const,
    safetyReason: reason,
    pharosYieldScore: null,
    pysNullReason: "safety-unrated" as const,
    yieldToRisk: null,
    sourceRisk: removeSafetyDerivedSourceRisk(row.sourceRisk),
    altSources: row.altSources.map((alternate) => ({
      ...alternate,
      sourceRisk: removeSafetyDerivedSourceRisk(alternate.sourceRisk),
    })),
    rankChangeAttribution: removeSafetyDerivedRankChangeAttribution(row.rankChangeAttribution),
    warningSignals: row.warningSignals.includes("safety-unrated")
      ? row.warningSignals
      : [...row.warningSignals, "safety-unrated"],
    provenance: row.provenance
      ? {
          ...row.provenance,
          // Source freshness derives from the row itself, not the safety
          // snapshot, so the degraded path still reports it honestly.
          sourceFreshness: resolveHydratedSourceFreshness(row),
          usedDefaultSafety: true,
          safetyProvenance: "safety-snapshot-unavailable" as const,
          safetyReason: reason,
          safetyScoreIdentity: source.safetyScoreIdentity,
          scoreQualification: "NR" as const,
          scoreQualified: false,
        }
      : null,
  }));
  const { degradationReasons: _degradationReasons, ...liveSafetyHydration } = source;
  return {
    ...payload,
    rankings,
    warnings: [
      ...(payload.warnings ?? []),
      {
        code: "yield-safety-hydration-degraded",
        message: "Yield safety is unavailable because the published compact safety snapshot cannot be used.",
        reasons: [reason],
      },
    ],
    provenance: payload.provenance
      ? {
          ...payload.provenance,
          liveSafetyHydration: {
            kind: "degraded" as const,
            coveredCount: 0,
            trackedCount: rankings.length,
            coverageRatio: 0,
            reason,
            ...liveSafetyHydration,
          },
        }
      : payload.provenance,
  };
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
  return jsonResponseWithHeaders(
    {
      ...payload,
      _meta: buildFreshnessMeta(cached.updatedAt, YIELD_RANKINGS_MAX_AGE_SEC),
    },
    headers,
  );
}

/**
 * GET /api/yield-rankings
 * Returns cached yield rankings with values hydrated only from the exact,
 * complete published compact Safety Score snapshot.
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
        const snapshot = await computeSafetyScoresSnapshot(db);
        const hydrationSource: LiveSafetyHydrationSource = {
          source: "safety-score-v9-publication",
          safetyScoreIdentity: snapshot.safetyScoreIdentity,
          publicationGenerationId: snapshot.publicationGenerationId,
          methodologyVersion: snapshot.methodologyVersion,
          publishedAt: snapshot.publishedAt,
          degradationReasons: snapshot.kind === "ok" ? [] : [snapshot.reason ?? "safety-snapshot-unavailable"],
        };
        if (snapshot.kind !== "ok" || snapshot.safetyScoreIdentity == null) {
          const reason = snapshot.safetyScoreIdentity == null && snapshot.kind === "ok"
            ? "safety-identity-missing"
            : "safety-snapshot-unavailable";
          const fallbackPayload = canServePublishTimeSafety(validatedPayload, cached)
            ? markYieldRankingsSafetyStale(validatedPayload, reason, hydrationSource)
            : degradeYieldRankingsSafety(validatedPayload, reason, hydrationSource);
          return buildYieldRankingsResponse(project(fallbackPayload), cached, [reason]);
        }
        if (!hasCompatibleSafetyIdentity(validatedPayload, snapshot.safetyScoreIdentity)) {
          const publishedIdentity = validatedPayload.provenance?.safetySnapshot.safetyScoreIdentity;
          const reason = publishedIdentity == null ? "safety-identity-missing" : "safety-identity-mismatch";
          const fallbackPayload = canServePublishTimeSafety(validatedPayload, cached)
            ? markYieldRankingsSafetyStale(validatedPayload, reason, hydrationSource)
            : degradeYieldRankingsSafety(validatedPayload, reason, hydrationSource);
          return buildYieldRankingsResponse(project(fallbackPayload), cached, [reason]);
        }
        const hydrated = hydrateYieldRankingsWithLiveSafety(validatedPayload, snapshot.scores, hydrationSource);
        if (hydrated.degradationReasons.length > 0) {
          return buildYieldRankingsResponse(project(hydrated.payload), cached, hydrated.degradationReasons);
        }
        return project(hydrated.payload);
      } catch (err) {
        logWorkerEventArgs("api", "warn", "[yield-rankings] Live safety hydration failed:", err instanceof Error ? err.message : err);
        const hydrationSource: LiveSafetyHydrationSource = {
          source: "safety-score-v9-publication",
          safetyScoreIdentity: null,
          publicationGenerationId: null,
          methodologyVersion: null,
          publishedAt: null,
          degradationReasons: ["safety-snapshot-unavailable"],
        };
        const fallbackPayload = canServePublishTimeSafety(validatedPayload, cached)
          ? markYieldRankingsSafetyStale(validatedPayload, "safety-snapshot-unavailable", hydrationSource)
          : degradeYieldRankingsSafety(validatedPayload, "safety-snapshot-unavailable", hydrationSource);
        return buildYieldRankingsResponse(project(fallbackPayload), cached, ["safety-snapshot-unavailable"]);
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
