import { createHash, randomUUID } from "node:crypto";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { logWorkerEventArgs } from "../lib/structured-log";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { isYieldSafetyFallbackWithinWindow, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "@shared/lib/yield-safety-fallback";
import {
  YieldRankingsResponseSchema,
  YIELD_BENCHMARK_KEY_CURRENCY,
  type YieldCalculationMode,
  type YieldEvidenceClass,
  type YieldRanking,
  type YieldRankingsResponse,
  type YieldSafetyReason,
  type YieldVenueRiskTier,
} from "@shared/types/yield";
import { computePYSFromComponents, computePysComponents, yieldStabilityToApyVarianceScore, PYS_DEFAULT_SAFETY_SCORE as DEFAULT_SAFETY_SCORE } from "@shared/lib/yield-scoring";
import { assessYieldEvidence } from "@shared/lib/yield-evidence";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import { resolveYieldRowSafety, stripSafetyDerivedSourceRisk } from "@shared/lib/yield-opportunity-risk";
import { classifyYieldSourceAgeTier, classifyYieldSourceFreshness, derivePysNullReasonFromComponents, getRankingStaleThresholdMs, getRankingAgingThresholdMs, getComparisonAnchorStaleThresholdMs, resolveEvidenceNullReason } from "../lib/yield-ranking-helpers";
import {
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
  type YieldBenchmarkFreshness,
} from "@shared/lib/yield-benchmark-freshness";
import {
  buildYieldRankBaseline,
  buildYieldRankChangeAttribution,
  compareYieldRankRows,
} from "../lib/yield-rank-attribution";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { addFreshnessHeaders, buildFreshnessMeta } from "../lib/api-freshness";
import { createCacheHandler } from "../lib/api-cache-read";
import { errorResponse, jsonResponse, jsonResponseWithHeaders } from "../lib/api-response";

import { loadActiveSafetyScoreIndex, type ActiveSafetyScoreIndex, type SafetyScoreGradeSnapshot } from "../lib/safety-score-index";
import { resolveYieldBenchmarkDependencies } from "../lib/yield-config/yield-benchmark-dependencies";
import { readCoinProjectionId } from "../lib/api-coin-projection";
import { readYieldRankingsCoinCache, readYieldCoinCohort, claimYieldCoinCohort, publishYieldCoinCohort, releaseYieldCoinCohort } from "../lib/yield-rankings-coin-cache";
import { getCache } from "../lib/db-cache";
import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "@shared/lib/status-thresholds";
import { YieldCoinCohortSchema, type YieldRankingsCoinResponse } from "@shared/types/yield";

const YIELD_RANKINGS_MAX_AGE_SEC = CRON_INTERVALS["sync-yield-data"];


function hasYieldPublicationContract(payload: YieldRankingsResponse): boolean {
  const publication = payload.publication;
  return (
    publication != null &&
    typeof publication.generationId === "string" &&
    publication.generationId.length > 0 &&
    typeof publication.updatedAt === "number" &&
    Number.isFinite(publication.updatedAt) &&
    typeof publication.cutoffAt === "number" &&
    Number.isFinite(publication.cutoffAt) &&
    publication.schemaVersion === 1 &&
    publication.status === "published"
  );
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
  const freshness = classifyYieldSourceFreshness({
    dataSource: row.dataSource,
    sourceKey: row.provenance?.sourceKey,
    sourceAgeSeconds: finiteNumber(row.provenance?.sourceAgeSeconds),
    comparisonAnchorAgeSeconds: finiteNumber(row.provenance?.comparisonAnchorAgeSeconds),
  });
  // Retain independently degraded product-input evidence; elapsed time can
  // make a source worse, never rehabilitate a rejected observation.
  if (freshness === "stale" || row.provenance?.sourceFreshness === "stale" || row.warningSignals.includes("data-stale")) return "stale";
  return row.provenance?.sourceFreshness === "unknown" ? "unknown" : freshness;
}

function resolveHydratedBenchmarkFreshness(
  row: YieldRanking,
  payload: YieldRankingsResponse,
): "healthy" | "degraded" | "stale" {
  const key = row.benchmarkKey ?? row.provenance?.benchmarkKey;
  const meta = (key ? payload.benchmarks?.[key] : null) ??
    (key != null && payload.provenance?.benchmark.key === key ? payload.provenance.benchmark : null);
  const assessed = meta ? classifyYieldBenchmarkFreshness(meta, {
    recordDate: meta.recordDate,
    maxRecordAgeSec: meta.maxRecordAgeSec ?? (key ? YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key] : undefined),
  }) : null;
  if (assessed === "stale" || row.warningSignals.includes("benchmark-stale")) return "stale";
  if (assessed === "degraded" || row.warningSignals.includes("benchmark-degraded")) return "degraded";
  return assessed ?? row.provenance?.benchmarkFreshness ?? "healthy";
}

/** Advance published evidence once, before choosing either safety branch. */
function ageYieldRankings(payload: YieldRankingsResponse, publishedAt: number): YieldRankingsResponse {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, now - publishedAt);
  const age = (observedAt: number | null | undefined, publishedAge: number | null | undefined) =>
    finiteNumber(observedAt) != null
      ? Math.max(0, now - observedAt!)
      : finiteNumber(publishedAge) != null ? Math.max(0, publishedAge!) + elapsed : null;
  const ageBenchmark = (meta: NonNullable<YieldRankingsResponse["benchmarks"]>["USD"]) => ({
    ...meta,
    ageSeconds: age(meta.fetchedAt, meta.ageSeconds),
  });
  const publishedBenchmarks = payload.benchmarks ?? payload.provenance?.benchmarks;
  const benchmarks = publishedBenchmarks
    ? Object.fromEntries(Object.entries(publishedBenchmarks).map(([key, meta]) => [key, meta ? ageBenchmark(meta) : meta])) as YieldRankingsResponse["benchmarks"]
    : undefined;
  return {
    ...payload,
    benchmarks,
    provenance: payload.provenance ? {
      ...payload.provenance,
      benchmark: ageBenchmark(payload.provenance.benchmark),
      ...(benchmarks ? { benchmarks } : {}),
    } : payload.provenance,
    rankings: payload.rankings.map((row) => {
      const sourceAgeSeconds = row.provenance
        ? age(row.provenance.sourceObservedAt, row.provenance.sourceAgeSeconds)
        : age(null, row.sourceRisk?.sourceAgeSeconds);
      return {
        ...row,
        sourceRisk: row.sourceRisk ? { ...row.sourceRisk, sourceAgeSeconds } : row.sourceRisk,
        altSources: row.altSources.map((source) => ({
          ...source,
          sourceRisk: source.sourceRisk ? {
            ...source.sourceRisk,
            sourceAgeSeconds: age(null, source.sourceRisk.sourceAgeSeconds),
          } : source.sourceRisk,
        })),
        provenance: row.provenance ? {
          ...row.provenance,
          sourceAgeSeconds,
          sourceMaxAgeSeconds: getRankingStaleThresholdMs(row.dataSource, row.provenance.sourceKey) / 1000,
          comparisonAnchorAgeSeconds: age(row.provenance.comparisonAnchorObservedAt, row.provenance.comparisonAnchorAgeSeconds),
        } : row.provenance,
      };
    }),
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

/**
 * C17: one coverage definition for every live-safety state. A row counts as
 * covered only when its safety came from the live report card (or from an
 * opportunity score that did not substitute the default) — the previous
 * fallback-path count of `safetyScore !== null` reported the cached
 * publish-time snapshot as covered.
 */
function countRowSafetyCoverage(rankings: YieldRanking[]): {
  coveredCount: number;
  trackedCount: number;
  coverageRatio: number;
} {
  const coveredCount = rankings.filter(
    (row) =>
      (row.safetyScore != null && row.provenance?.safetyProvenance === "live-report-card") ||
      (row.safetyScore != null && row.provenance?.safetyProvenance === "opportunity-safety" && row.provenance.usedDefaultSafety !== true),
  ).length;
  const trackedCount = rankings.length;
  return {
    coveredCount,
    trackedCount,
    coverageRatio: trackedCount > 0 ? Number((coveredCount / trackedCount).toFixed(4)) : 1,
  };
}

/**
 * A3: publication re-bases a non-USD row's hurdle onto the USD reference only
 * while that entry classifies healthy on its own feed evidence; a degraded or
 * stale reference is published with re-base 0 plus a
 * `reference-benchmark-degraded` warning. The payload publishes the registry
 * entry's own evidence (`recordDate`, `maxRecordAgeSec`), so the read path
 * classifies it exactly as `prepareYieldEvaluation` does — consuming the raw
 * `riskFreeRate` regardless re-scored EUR/GBP/CHF rows ~15 points above the
 * published value.
 */
function resolvePublishedReferenceBenchmark(payload: YieldRankingsResponse): {
  freshness: YieldBenchmarkFreshness;
  usdBenchmarkRate: number | null;
} {
  const meta = payload.benchmarks?.USD ?? null;
  // A payload that publishes no registry entry cannot prove the reference
  // healthy: that is `degraded` (no re-base, rows stay `estimated`), never
  // `stale` — the reference is unverified, not known-unusable.
  const freshness =
    meta == null
      ? "degraded"
      : classifyYieldBenchmarkFreshness(meta, {
          recordDate: meta.recordDate,
          maxRecordAgeSec: meta.maxRecordAgeSec ?? YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD,
        });
  return {
    freshness,
    usdBenchmarkRate:
      freshness === "healthy"
        ? finiteNumber(payload.riskFreeRate) ?? finiteNumber(meta?.rate) ?? null
        : null,
  };
}

function hydrateYieldRankingsWithLiveSafety(
  payload: YieldRankingsResponse,
  scores: ReadonlyMap<string, SafetyScoreGradeSnapshot["cards"][number]>,
  source: LiveSafetyHydrationSource,
  preservePublishedSafety = false,
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  // Reference (USD) risk-free rate the re-based effective yield anchors on (yield v8.43).
  const { usdBenchmarkRate } = resolvePublishedReferenceBenchmark(payload);
  const hydratedRows = payload.rankings
    .map((row) => {
      const currentSafety = preservePublishedSafety ? undefined : scores.get(row.id);
      const pipelineGap = currentSafety?.ratingStatus === "pipeline-gap";
      if (pipelineGap || (currentSafety?.grade === "NR" && currentSafety.score == null)) {
        const reason = pipelineGap ? "safety-snapshot-unavailable" as const : "report-card-grade-not-rated" as const;
        return {
          originalRow: row,
          safetyChanged: false,
          row: {
            ...row,
            safetyScore: null,
            safetyGrade: pipelineGap ? null : "NR" as const,
            safetyReason: reason,
            pharosYieldScore: null,
            pysNullReason: row.pysNullReason ?? "safety-unrated" as const,
            yieldToRisk: null,
            warningSignals: [...new Set([...row.warningSignals, "safety-unrated"])],
            rankChangeAttribution: removeSafetyDerivedRankChangeAttribution(row.rankChangeAttribution),
            sourceRisk: row.sourceRisk ? {
              ...stripSafetyDerivedSourceRisk(row.sourceRisk),
              underlyingSafetyGrade: pipelineGap ? null : "NR",
            } : null,
            altSources: row.altSources.map((alternate) => ({
              ...alternate,
              sourceRisk: alternate.sourceRisk ? {
                ...stripSafetyDerivedSourceRisk(alternate.sourceRisk),
                underlyingSafetyGrade: pipelineGap ? null : "NR",
              } : alternate.sourceRisk,
            })),
            provenance: row.provenance ? {
              ...row.provenance,
              safetyProvenance: pipelineGap ? "safety-snapshot-unavailable" as const : "live-report-card" as const,
              safetyReason: reason,
              safetyScoreIdentity: source.safetyScoreIdentity,
              usedDefaultSafety: false,
              scoreQualification: "NR" as const,
              scoreQualified: false,
            } : null,
          },
        };
      }
      const safety = preservePublishedSafety
        ? row.provenance?.usedDefaultSafety || row.safetyScore == null || row.safetyGrade == null
          ? undefined
          : { score: row.sourceRisk?.underlyingSafetyScore ?? row.safetyScore, grade: row.safetyGrade }
        : currentSafety?.score != null && currentSafety.grade != null
          ? { score: currentSafety.score, grade: currentSafety.grade }
          : undefined;
      const resolvedSafety = resolveHydratedSafety({ row, safety });
      const hydratedSafety = preservePublishedSafety ? {
        ...resolvedSafety,
        score: row.safetyScore ?? DEFAULT_SAFETY_SCORE,
        grade: row.safetyGrade,
        reason: row.safetyReason ?? null,
        sourceRisk: row.sourceRisk,
        provenance: row.provenance?.safetyProvenance,
        usedDefaultSafety: row.provenance?.usedDefaultSafety ?? true,
      } : resolvedSafety;
      const safetyInputScore = hydratedSafety.score;
      const benchmarkFreshness = resolveHydratedBenchmarkFreshness(row, payload);
      const evidenceClass = resolveHydratedEvidenceClass(row);
      const opportunityEvidenceComplete = hydratedSafety.opportunityEvidenceComplete;
      const safetyObserved = hydratedSafety.safetyEvidenceObserved;
      const benchmarkCurrency =
        row.benchmarkCurrency ??
        row.provenance?.benchmarkCurrency ??
        (row.benchmarkKey != null ? YIELD_BENCHMARK_KEY_CURRENCY[row.benchmarkKey] : null) ??
        null;
      const benchmarkDependencies = resolveYieldBenchmarkDependencies({
        stablecoinId: row.id,
        dataSource: row.dataSource,
        benchmarks: payload.benchmarks ?? {},
        benchmarkCurrency,
      });
      const sourceFreshness = benchmarkDependencies.productFreshness === "stale"
        ? "stale" : resolveHydratedSourceFreshness(row);
      const rowReferenceBenchmarkFreshness = benchmarkDependencies.referenceFreshness;
      const referenceBenchmarkDegraded = rowReferenceBenchmarkFreshness !== "healthy";
      const evidenceAssessment = assessYieldEvidence({
        evidenceClass,
        safetyObserved,
        sourceFreshness,
        benchmarkFreshness,
        referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
        hasSourceDepth: finiteNumber(hydratedSafety.sourceRisk?.sourceDepthRatio) != null,
        hasVenueRisk: hydratedSafety.venueRiskTier !== "unknown",
        hasHistory: (finiteNumber(hydratedSafety.sourceRisk?.observationCount30d) ?? 0) > 1,
        hasYieldDecomposition: row.apyBase != null || row.apyReward != null,
        opportunityEvidenceComplete,
      });
      const warningSignals = row.warningSignals.filter((signal) =>
        (signal !== "safety-unrated" || !safetyObserved) &&
        (signal !== "opportunity-evidence-missing" || !opportunityEvidenceComplete) &&
        (signal !== "reference-benchmark-degraded" || referenceBenchmarkDegraded),
      );
      if (!safetyObserved && !warningSignals.includes("safety-unrated")) {
        warningSignals.push("safety-unrated");
      }
      if (!opportunityEvidenceComplete && !warningSignals.includes("opportunity-evidence-missing")) {
        warningSignals.push("opportunity-evidence-missing");
      }
      if (referenceBenchmarkDegraded && !warningSignals.includes("reference-benchmark-degraded")) {
        warningSignals.push("reference-benchmark-degraded");
      }
      if (benchmarkFreshness !== "healthy" && !warningSignals.includes(`benchmark-${benchmarkFreshness}`)) {
        warningSignals.push(`benchmark-${benchmarkFreshness}`);
      }
      const evidenceNullReason = resolveEvidenceNullReason({
        sourceFreshness,
        benchmarkFreshness,
        referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
        opportunityEvidenceComplete,
      });
      // B6: the response emits `hydratedSafety.sourceRisk`, so the score must be
      // computed from that same penalty — a read-path score the emitted evidence
      // cannot reproduce is not auditable.
      const hydratedSourceRiskPenalty = hydratedSafety.sourceRisk?.sourceRiskPenalty ?? null;
      const components = computePysComponents({
        apy30d: row.apy30d,
        safetyScore: safetyInputScore,
        apyVarianceScore: yieldStabilityToApyVarianceScore(row.yieldStability),
        benchmarkRate: row.benchmarkRate ?? null,
        // Same-currency USD benchmarks take no re-base credit (v8.43 B24); the
        // published currency is the write path's `benchmarkMeta.currency ?? key`.
        benchmarkCurrency,
        usdBenchmarkRate,
        sourceRiskPenalty: hydratedSourceRiskPenalty,
      });
      const recomputedPharosYieldScore = computePYSFromComponents(row.apy30d, payload.scalingFactor, components);
      const pysNullReason =
        evidenceNullReason ??
        (preservePublishedSafety && row.safetyScore == null ? "safety-unrated" as const : null) ??
        (recomputedPharosYieldScore > 0
          ? null
          : derivePysNullReasonFromComponents(row.apy30d, payload.scalingFactor, components));
      // B22: the served score is null whenever a reason is published. The UI's NR
      // gate is `pharosYieldScore === null`, so a hard 0 next to a reason renders
      // as a scored row and hides the reason.
      const pharosYieldScore = pysNullReason == null ? recomputedPharosYieldScore : null;
      // B21: second-tier observation-age signals, so a row whose source stopped
      // refreshing is not served as fresh for the whole stale window.
      const sourceAgeTier = classifyYieldSourceAgeTier({
        dataSource: row.dataSource,
        sourceKey: row.provenance?.sourceKey ?? null,
        sourceAgeSeconds: finiteNumber(row.provenance?.sourceAgeSeconds),
      });
      if (sourceAgeTier === "aging" && !warningSignals.includes("aging")) {
        warningSignals.push("aging");
      }
      if (sourceFreshness === "stale" && !warningSignals.includes("data-stale")) {
        warningSignals.push("data-stale");
      }

      return {
        originalRow: row,
        safetyChanged: row.safetyScore !== safetyInputScore,
        row: {
          ...row,
          safetyScore: preservePublishedSafety ? row.safetyScore : safetyInputScore,
          safetyGrade: hydratedSafety.grade,
          safetyReason: hydratedSafety.reason,
          pharosYieldScore,
          pysNullReason,
          warningSignals,
          yieldToRisk: preservePublishedSafety ? row.yieldToRisk
            : 101 - safetyInputScore > 0 ? row.apy30d / (101 - safetyInputScore) : null,
          sourceRisk: hydratedSafety.sourceRisk,
          altSources: preservePublishedSafety ? row.altSources : hydrateAltSourcesWithLiveSafety(row, safety),
          provenance: row.provenance
            ? {
                ...row.provenance,
                usedDefaultSafety: hydratedSafety.usedDefaultSafety,
                safetyProvenance: hydratedSafety.provenance,
                safetyReason: hydratedSafety.reason,
                safetyScoreIdentity: preservePublishedSafety ? row.provenance.safetyScoreIdentity : source.safetyScoreIdentity,
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
    .sort((a, b) => compareYieldRankRows(a.row, b.row));

  // B7: the baseline rank comes from the served comparator over the pre-hydration
  // rows, so tie-group re-sorting (the publisher ranks by PYS alone) is not
  // reported as movement.
  const previousRankById = buildYieldRankBaseline(payload.rankings);
  const methodologyChanged =
    payload.methodology != null && payload.methodology.version !== YIELD_METHODOLOGY_VERSION;
  const rankings = hydratedRows.map((entry, index) => {
    const row = {
      ...entry.row,
      liveRank: index + 1,
    };
    if (methodologyChanged || !(Number.isInteger(entry.originalRow.publishedRank) && (entry.originalRow.publishedRank ?? 0) > 0)) {
      const { rankChangeAttribution: _unavailableAttribution, ...withoutAttribution } = row;
      return withoutAttribution;
    }
    const rankChangeAttribution = buildYieldRankChangeAttribution({
      originalRow: entry.originalRow,
      hydratedRow: row,
      previousRank: previousRankById.get(entry.originalRow.id) ?? null,
      safetyChanged: entry.safetyChanged,
      methodologyChanged,
    });
    return rankChangeAttribution == null && entry.originalRow.rankChangeAttribution === undefined
      ? row
      : { ...row, rankChangeAttribution };
  });
  if (preservePublishedSafety) {
    return { payload: { ...payload, rankings }, degradationReasons: [] };
  }

  const { coveredCount, trackedCount, coverageRatio } = countRowSafetyCoverage(rankings);
  const degradationReasons = [
    ...source.degradationReasons,
    ...(coverageRatio < 0.75 ? ["low-row-safety-coverage"] : []),
  ];
  const { degradationReasons: _sourceDegradationReasons, ...liveSafetySource } = source;

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
  const now = Math.floor(Date.now() / 1000);
  const safetyPublishedAt = finiteNumber(payload.provenance?.safetySnapshot.publishedAt);
  return (
    payload.provenance?.safetySnapshot.safetyScoreIdentity != null &&
    isYieldSafetyFallbackWithinWindow(cached.updatedAt, safetyPublishedAt, now)
  );
}

function markYieldRankingsSafetyStale(
  payload: YieldRankingsResponse,
  reason: "safety-snapshot-unavailable" | "safety-hydration-error" | "safety-identity-missing" | "safety-identity-mismatch",
  source: LiveSafetyHydrationSource,
): YieldRankingsResponse {
  const { coveredCount, trackedCount, coverageRatio } = countRowSafetyCoverage(payload.rankings);
  // C17: the upstream snapshot reason (`active-safety-score:held`, D1 error, ...)
  // is part of why hydration is unavailable; surfacing only the read path's own
  // reason made held, error and missing states indistinguishable.
  const reasons = [...new Set([reason, ...source.degradationReasons])];
  const { degradationReasons: _degradationReasons, ...liveSafetySource } = source;
  return {
    ...payload,
    warnings: [
      ...(payload.warnings ?? []),
      {
        code: "yield-safety-hydration-stale",
        message:
          "Live yield safety hydration is unavailable; serving the last coherent published safety snapshot.",
        reasons,
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
            coverageRatio,
            reason: reasons.join(","),
            ...liveSafetySource,
            safetyScoreIdentity: payload.provenance.safetySnapshot.safetyScoreIdentity,
            publicationGenerationId: payload.provenance.safetySnapshot.publicationGenerationId ?? null,
            methodologyVersion: payload.provenance.safetySnapshot.methodologyVersion ?? null,
            publishedAt: payload.provenance.safetySnapshot.publishedAt ?? null,
          },
        }
      : payload.provenance,
  };
}

function degradeYieldRankingsSafety(
  payload: YieldRankingsResponse,
  reason: "safety-snapshot-unavailable" | "safety-hydration-error" | "safety-identity-missing" | "safety-identity-mismatch",
  source: LiveSafetyHydrationSource,
): YieldRankingsResponse {
  const safetyReason: YieldSafetyReason =
    reason === "safety-hydration-error" ? "safety-snapshot-unavailable" : reason;
  const rankings = payload.rankings.map((row) => ({
    ...row,
    safetyScore: null,
    safetyGrade: null,
    safetyReason,
    pharosYieldScore: null,
    // B37: the row's own reason survived the safety loss (source-stale,
    // benchmark-stale, apy-non-positive, ...) — rewriting it to `safety-unrated`
    // discarded why the score was unusable in the first place.
    pysNullReason:
      row.pysNullReason != null && row.pysNullReason !== "safety-unrated"
        ? row.pysNullReason
        : ("safety-unrated" as const),
    yieldToRisk: null,
    sourceRisk: stripSafetyDerivedSourceRisk(row.sourceRisk),
    altSources: row.altSources.map((alternate) => ({
      ...alternate,
      sourceRisk: stripSafetyDerivedSourceRisk(alternate.sourceRisk),
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
          safetyReason,
          safetyScoreIdentity: source.safetyScoreIdentity,
          scoreQualification: "NR" as const,
          scoreQualified: false,
        }
      : null,
  }));
  const { coveredCount, trackedCount, coverageRatio } = countRowSafetyCoverage(rankings);
  // C17: surface the upstream snapshot reason alongside the read path's own.
  const reasons = [...new Set([reason, ...source.degradationReasons])];
  const { degradationReasons: _degradationReasons, ...liveSafetyHydration } = source;
  return {
    ...payload,
    rankings,
    warnings: [
      ...(payload.warnings ?? []),
      {
        code: "yield-safety-hydration-degraded",
        message: "Yield safety is unavailable because the published compact safety snapshot cannot be used.",
        reasons,
      },
    ],
    provenance: payload.provenance
      ? {
          ...payload.provenance,
          liveSafetyHydration: {
            kind: "degraded" as const,
            coveredCount,
            trackedCount,
            coverageRatio,
            reason: reasons.join(","),
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
  const freshness = buildFreshnessMeta(cached.updatedAt, YIELD_RANKINGS_MAX_AGE_SEC, "yield-data");
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
    freshness,
  );
  if (freshness.status !== "fresh") {
    headers.Warning = `110 - "Yield publication ${freshness.status} (${freshness.ageSeconds}s old, fresh budget ${freshness.freshBudgetSec}s)"`;
    headers["Cache-Control"] = "no-store";
  }
  if (warning && headers.Warning && !headers.Warning.includes(warning)) {
    headers.Warning = `${headers.Warning}, ${warning}`;
  }
  return jsonResponseWithHeaders(
    {
      ...payload,
      _meta: {
        ...freshness,
        reason: freshness.status !== "fresh" ? "yield-publication-age"
          : warningReasons.length > 0 ? warningReasons.join(",") : null,
      },
    },
    headers,
  );
}

function resolveDegradedYieldRankings(
  payload: YieldRankingsResponse,
  cached: { updatedAt: number },
  reason: "safety-snapshot-unavailable" | "safety-hydration-error" | "safety-identity-missing" | "safety-identity-mismatch",
  source: LiveSafetyHydrationSource,
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  const servePublishTime = !source.degradationReasons.some(reason => reason.startsWith("safety-score-index-"))
    && canServePublishTimeSafety(payload, cached);
  const reassessed = hydrateYieldRankingsWithLiveSafety(payload, new Map(), source, true).payload;
  return {
    payload: servePublishTime ? markYieldRankingsSafetyStale(reassessed, reason, source)
      : degradeYieldRankingsSafety(reassessed, reason, source),
    degradationReasons: servePublishTime ? [] : [reason],
  };
}

function hydrateYieldPayload(
  payload: YieldRankingsResponse,
  cached: { updatedAt: number },
  active: ActiveSafetyScoreIndex,
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  const snapshot = active.kind === "error" ? null : active.snapshot;
  const source: LiveSafetyHydrationSource = {
    source: "safety-score-v9-publication",
    safetyScoreIdentity: snapshot?.safetyScoreIdentity ?? null,
    publicationGenerationId: snapshot?.safetyScoreIdentity.publicationGenerationId ?? null,
    methodologyVersion: snapshot?.methodology.version ?? null,
    publishedAt: snapshot?.updatedAt ?? null,
    degradationReasons: active.kind === "v9" ? [] : [active.reason],
  };
  if (active.kind !== "v9" || snapshot == null) {
    return resolveDegradedYieldRankings(payload, cached, "safety-snapshot-unavailable", source);
  }
  if (!hasCompatibleSafetyIdentity(payload, snapshot.safetyScoreIdentity)) {
    const reason = payload.provenance?.safetySnapshot.safetyScoreIdentity == null ? "safety-identity-missing" : "safety-identity-mismatch";
    return resolveDegradedYieldRankings(payload, cached, reason, source);
  }
  return hydrateYieldRankingsWithLiveSafety(payload, new Map(snapshot.cards.map((card) => [card.id, card])), source);
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
  const project = (payload: YieldRankingsResponse) => projection === "summary" ? projectYieldRankingsSummary(payload) : payload;

  return createCacheHandler(endpoint, "yield-rankings", CACHE_PROFILES.standard, YIELD_RANKINGS_MAX_AGE_SEC, {
    schema: YieldRankingsResponseSchema,
    malformedMessage: "Cached yield-rankings payload is malformed",
    transform: async (payload, { db, cached }) => {
      if (!hasYieldPublicationContract(payload as YieldRankingsResponse)) {
        return errorResponse(503, "Cached yield-rankings payload is malformed");
      }
      const validatedPayload = ageYieldRankings(payload as YieldRankingsResponse, cached.updatedAt);
      try {
        const hydrated = hydrateYieldPayload(validatedPayload, cached, await loadActiveSafetyScoreIndex(db));
        return buildYieldRankingsResponse(project(hydrated.payload), cached, hydrated.degradationReasons);
      } catch (err) {
        logWorkerEventArgs("api", "warn", "[yield-rankings] Live safety hydration failed:", err instanceof Error ? err.message : err);
        const degraded = resolveDegradedYieldRankings(validatedPayload, cached, "safety-hydration-error", {
          source: "safety-score-v9-publication", safetyScoreIdentity: null, publicationGenerationId: null,
          methodologyVersion: null, publishedAt: null, degradationReasons: ["safety-hydration-error"],
        });
        return buildYieldRankingsResponse(project(degraded.payload), cached, degraded.degradationReasons);
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

/** Comparator/coverage values are piecewise constant between evidence deadlines.
 * Ages themselves are still advanced from the original publication per coin. */
function yieldCohortValidUntil(payload: YieldRankingsResponse, publishedAt: number, now: number): number {
  let validUntil = Number.MAX_SAFE_INTEGER;
  const boundary = (origin: number | null | undefined, budget: number | null | undefined) => {
    if (origin == null || budget == null || !Number.isFinite(origin)) return;
    const transition = Math.floor(origin + budget) + 1;
    if (transition > now) validUntil = Math.min(validUntil, transition);
  };
  const origin = (observedAt: number | null | undefined, age: number | null | undefined) =>
    finiteNumber(observedAt) ?? (finiteNumber(age) != null ? publishedAt - Math.max(0, age!) : null);
  for (const row of payload.rankings) {
    const source = origin(row.provenance?.sourceObservedAt, row.provenance?.sourceAgeSeconds ?? row.sourceRisk?.sourceAgeSeconds);
    boundary(source, getRankingAgingThresholdMs(row.dataSource, row.provenance?.sourceKey) / 1000);
    boundary(source, getRankingStaleThresholdMs(row.dataSource, row.provenance?.sourceKey) / 1000);
    boundary(origin(row.provenance?.comparisonAnchorObservedAt, row.provenance?.comparisonAnchorAgeSeconds),
      getComparisonAnchorStaleThresholdMs(row.dataSource, row.provenance?.sourceKey) / 1000);
  }
  const entries = { ...payload.provenance?.benchmarks, ...payload.benchmarks };
  if (payload.provenance?.benchmark) {
    const meta = payload.provenance.benchmark;
    boundary(origin(meta.fetchedAt, meta.ageSeconds), YIELD_BENCHMARK_SCORE_TTL_SEC);
    const key = meta.key;
    boundary(meta.recordDate ? Date.parse(`${meta.recordDate}T00:00:00Z`) / 1000 : null,
      meta.maxRecordAgeSec ?? (key ? YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key] : undefined));
  }
  for (const [key, meta] of Object.entries(entries)) {
    if (!meta) continue;
    boundary(origin(meta.fetchedAt, meta.ageSeconds), YIELD_BENCHMARK_SCORE_TTL_SEC);
    const recordAt = meta.recordDate ? Date.parse(`${meta.recordDate}T00:00:00Z`) / 1000 : null;
    boundary(recordAt, meta.maxRecordAgeSec ?? YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key as keyof typeof YIELD_BENCHMARK_RECORD_MAX_AGE_SEC]);
    // Invalid future-dated benchmark records can become admissible as time
    // advances. Do not retain their negative-age assessment across seconds.
    if (recordAt != null && recordAt > now) validUntil = Math.min(validUntil, now + 1);
  }
  boundary(publishedAt, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC);
  boundary(payload.provenance?.safetySnapshot.publishedAt, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC);
  for (const timestamp of [publishedAt, payload.provenance?.safetySnapshot.publishedAt]) {
    if (timestamp != null && Number.isFinite(timestamp) && timestamp > now) {
      validUntil = Math.min(validUntil, Math.ceil(timestamp));
    }
  }
  return validUntil;
}

function yieldCoinUnavailable(reason: string, retry = false): Response {
  return jsonResponse({ error: "Yield coin projection unavailable", reason }, {
    status: 503, noStore: true, ...(retry ? { retryAfterSec: 1 } : {}),
  });
}

export async function handleYieldRankingsCoin(db: D1Database, url: URL): Promise<Response> {
  const id = readCoinProjectionId(url);
  if (id instanceof Response) return id;
  try {
    // Only cold generation/eligibility transitions admit the full comparator
    // population. Other coin URLs validate, age and hydrate their row only.
    const [cached, active] = await Promise.all([readYieldRankingsCoinCache(db, id), loadActiveSafetyScoreIndex(db)]);
    if (!cached) return yieldCoinUnavailable("yield-rankings-unavailable");
    const selected = YieldRankingsResponseSchema.parse(JSON.parse(cached.value));
    if (!hasYieldPublicationContract(selected) || selected.updatedAt !== cached.updatedAt
      || selected.publication?.updatedAt !== cached.updatedAt) {
      return yieldCoinUnavailable("yield-rankings-malformed");
    }
    const signature = createHash("sha256").update(JSON.stringify([
      "yield-coin-cohort-v1", selected.publication, cached.updatedAt, YIELD_METHODOLOGY_VERSION,
      active.kind, active.kind === "error" ? active.reason : [active.snapshot.safetyScoreIdentity, active.snapshot.updatedAt, active.snapshot.publicationHealth],
      active.kind === "held" ? active.reason : null,
    ])).digest("hex");
    let now = Math.floor(Date.now() / 1000);
    let cohort = await readYieldCoinCohort(db, id, signature, now);
    if (cohort === null) {
      const owner = randomUUID();
      if (!await claimYieldCoinCohort(db, signature, owner, now)) {
        cohort = await readYieldCoinCohort(db, id, signature, Math.floor(Date.now() / 1000));
        if (cohort === null) return yieldCoinUnavailable("yield-cohort-preparing", true);
      } else {
        try {
          const fullCache = await getCache(db, "yield-rankings");
          if (!fullCache || fullCache.updatedAt !== cached.updatedAt) {
            return yieldCoinUnavailable("yield-cohort-publication-changed", true);
          }
          const full = YieldRankingsResponseSchema.parse(JSON.parse(fullCache.value));
          if (!hasYieldPublicationContract(full) || JSON.stringify(full.publication) !== JSON.stringify(selected.publication)
            || full.updatedAt !== cached.updatedAt) {
            return yieldCoinUnavailable("yield-rankings-malformed");
          }
          now = Math.floor(Date.now() / 1000);
          const hydrated = hydrateYieldPayload(ageYieldRankings(full, cached.updatedAt), cached, active);
          const aggregate = YieldCoinCohortSchema.parse({
            signature, assessedAt: now, validUntil: yieldCohortValidUntil(full, cached.updatedAt, now),
            totalCount: full.rankings.length, degradationReasons: hydrated.degradationReasons,
            warnings: hydrated.payload.warnings, provenance: hydrated.payload.provenance,
            rankings: hydrated.payload.rankings,
          });
          await publishYieldCoinCohort(db, owner, aggregate);
          cohort = { ...aggregate, rankings: aggregate.rankings.filter((row) => row.id === id) };
        } finally {
          await releaseYieldCoinCohort(db, owner);
        }
      }
    }
    if (cohort.validUntil <= Math.floor(Date.now() / 1000)) {
      return yieldCoinUnavailable("yield-cohort-assessment-expired", true);
    }
    const hydrated = hydrateYieldPayload(ageYieldRankings(selected, cached.updatedAt), cached, active);
    const comparatorRows = cohort.rankings;
    const rankings = hydrated.payload.rankings.map((row) => {
      const comparator = comparatorRows.find((entry) => entry.id === row.id);
      if (!comparator) throw new Error("Yield coin comparator missing");
      const { rankChangeAttribution: _localAttribution, liveRank: _localRank, ...fields } = row;
      return { ...fields, liveRank: comparator.liveRank,
        ...(comparator.rankChangeAttribution !== undefined ? { rankChangeAttribution: comparator.rankChangeAttribution } : {}) };
    });
    const projected: YieldRankingsCoinResponse = {
      ...hydrated.payload, rankings, warnings: cohort.warnings,
      provenance: hydrated.payload.provenance ? {
        ...hydrated.payload.provenance, liveSafetyHydration: cohort.provenance?.liveSafetyHydration,
      } : hydrated.payload.provenance,
      projection: {
        stablecoinId: id, generationId: selected.publication?.generationId ?? null, updatedAt: cached.updatedAt,
        totalCount: cohort.totalCount, unavailableReason: rankings.length > 0 ? null : "row-not-published",
      },
    };
    return buildYieldRankingsResponse(projected, cached, cohort.degradationReasons);
  } catch (err) {
    logWorkerEventArgs("api", "warn", "[yield-rankings-coin] Scoped projection unavailable:", err instanceof Error ? err.message : err);
    return yieldCoinUnavailable("yield-coin-projection-unavailable");
  }
}
