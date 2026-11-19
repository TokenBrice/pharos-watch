import { createHash, randomUUID } from "node:crypto";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { logWorkerEvent, logWorkerEventArgs } from "../lib/structured-log";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { safetyScorePublicationIdentitiesAreComparable, safetyScorePublicationIdentitiesShareScoringContract } from "@shared/lib/safety-score-publication";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { isYieldSafetyFallbackWithinWindow, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "@shared/lib/yield-safety-fallback";
import {
  YieldRankingsResponseSchema,
  YIELD_BENCHMARK_KEY_CURRENCY,
  YIELD_BENCHMARK_KEY_VALUES,
  type YieldCalculationMode,
  type YieldEvidenceClass,
  type YieldRanking,
  type YieldRankingsResponse,
  type YieldSafetyReason,
} from "@shared/types/yield";
import { yieldStabilityToApyVarianceScore, PYS_DEFAULT_SAFETY_SCORE as DEFAULT_SAFETY_SCORE } from "@shared/lib/yield-scoring";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import { resolveYieldRowSafety, stripSafetyDerivedSourceRisk } from "@shared/lib/yield-opportunity-risk";
import { classifyYieldSourceAgeTier, qualifyYieldEvidence, scoreYieldPys, getRankingStaleThresholdMs, getRankingAgingThresholdMs, getComparisonAnchorStaleThresholdMs, resolveEvidenceNullReason, type YieldSourceAgeTier } from "../lib/yield-ranking-helpers";
import {
  benchmarkRecordObservedAtSeconds,
  classifyYieldBenchmarkFreshness,
  getYieldBenchmarkComparisonApy,
  getYieldBenchmarkRecordMaxAgeSeconds,
  hasYieldBenchmarkUnitMismatch,
  isYieldBenchmarkFixingEffective,
  type YieldBenchmarkFreshness,
} from "@shared/lib/yield-benchmark-freshness";
import { getUsycNavReportWindow, OPTIONAL_YIELD_SOURCES, USYC_NAV_FUTURE_SKEW_SEC } from "@shared/lib/yield-source-cadence";
import {
  buildYieldRankBaseline,
  buildYieldRankChangeAttribution,
  compareYieldRankRows,
} from "../lib/yield-rank-attribution";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { addFreshnessHeaders, buildFreshnessMeta } from "../lib/api-freshness";
import { createCacheHandler } from "../lib/api-cache-read";
import { errorResponse, jsonResponse, jsonResponseWithHeaders } from "../lib/api-response";
import { sleep } from "../lib/abort";

import { loadActiveSafetyScoreIndex, type ActiveSafetyScoreIndex, type SafetyScoreGradeSnapshot } from "../lib/safety-score-index";
import { resolveYieldBenchmarkDependencies } from "../lib/yield-config/yield-benchmark-dependencies";
import { readCoinProjectionId } from "../lib/api-coin-projection";
import { readYieldRankingsCache, readYieldRankingsCoinCache, readYieldCoinCohort, readYieldCoinCohortLease, claimYieldCoinCohort, publishYieldCoinCohort, releaseYieldCoinCohort } from "../lib/yield-rankings-coin-cache";
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

function resolveHydratedSourceFreshness(row: YieldRanking, ageTier: YieldSourceAgeTier): "fresh" | "stale" | "unknown" {
  const anchorAge = finiteNumber(row.provenance?.comparisonAnchorAgeSeconds);
  const staleAnchor = anchorAge != null && anchorAge * 1000 > getComparisonAnchorStaleThresholdMs(row.dataSource, row.provenance?.sourceKey);
  // Retain independently degraded product-input evidence; elapsed time can
  // make a source worse, never rehabilitate a rejected observation.
  if (staleAnchor || ageTier === "stale" || row.provenance?.sourceFreshness === "stale" || row.warningSignals.includes("data-stale")) return "stale";
  return ageTier === "unknown" || row.provenance?.sourceFreshness === "unknown" ? "unknown" : "fresh";
}

function resolvePublishedBenchmarks(payload: YieldRankingsResponse) {
  const legacy = payload.provenance?.benchmark;
  return payload.benchmarks ?? payload.provenance?.benchmarks ?? (legacy ? { [legacy.key ?? "USD"]: legacy } : {});
}

function resolveHydratedBenchmarkFreshness(
  row: YieldRanking,
  benchmarks: ReturnType<typeof resolvePublishedBenchmarks>,
  now: number,
): "healthy" | "degraded" | "stale" {
  const key = row.benchmarkKey ?? row.provenance?.benchmarkKey;
  const meta = key ? benchmarks[key] : null;
  const assessed = meta && key ? classifyYieldBenchmarkFreshness({ ...meta, key }, {
    recordDate: meta.recordDate,
    maxRecordAgeSec: getYieldBenchmarkRecordMaxAgeSeconds(key, meta.recordDate, meta.maxRecordAgeSec),
    nowSec: now,
  }) : null;
  if (assessed === "stale" || row.warningSignals.includes("benchmark-stale")) return "stale";
  if (assessed === "degraded" || row.warningSignals.includes("benchmark-degraded")) return "degraded";
  return assessed ?? row.provenance?.benchmarkFreshness ?? "healthy";
}

function usycObservationAt(provenance: YieldRanking["provenance"], publishedAt: number): number | null {
  if (provenance?.sourceObservedAt !== undefined) return provenance.sourceObservedAt;
  const age = finiteNumber(provenance?.sourceAgeSeconds);
  return age != null && age >= 0 ? publishedAt - age : null;
}

/** Advance published evidence once, before choosing either safety branch. */
function ageYieldRankings(payload: YieldRankingsResponse, publishedAt: number, now = Math.floor(Date.now() / 1000)): YieldRankingsResponse {
  const elapsed = Math.max(0, now - publishedAt);
  const age = (observedAt: number | null | undefined, publishedAge: number | null | undefined) =>
    finiteNumber(observedAt) != null
      ? Math.max(0, now - observedAt!)
      : finiteNumber(publishedAge) != null ? Math.max(0, publishedAge!) + elapsed : null;
  const ageBenchmark = (meta: NonNullable<YieldRankingsResponse["benchmarks"]>["USD"]) => ({
    ...meta,
    ageSeconds: meta.fetchedAt == null ? age(undefined, meta.ageSeconds) : now - meta.fetchedAt,
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
      dlPools: {
        ...payload.provenance.dlPools,
        ageSeconds: age(payload.provenance.dlPools.updatedAt, null),
      },
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
          ...(row.provenance.sourceKey === OPTIONAL_YIELD_SOURCES.hashnote.sourceKey
            ? { sourceObservedAt: usycObservationAt(row.provenance, publishedAt) } : {}),
          sourceAgeSeconds,
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
function resolveHydratedSafety(params: { row: YieldRanking; safety: { score: number; grade: string } | undefined }) {
  return resolveYieldRowSafety({
    yieldType: params.row.yieldType,
    underlyingSafety: params.safety,
    defaultSafetyScore: DEFAULT_SAFETY_SCORE,
    sourceRisk: params.row.sourceRisk,
    sourceTvlUsd: params.row.sourceTvlUsd,
    ratedProvenance: "live-report-card",
  });
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
function resolvePublishedReferenceBenchmark(payload: YieldRankingsResponse, now: number): {
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
          maxRecordAgeSec: getYieldBenchmarkRecordMaxAgeSeconds("USD", meta.recordDate, meta.maxRecordAgeSec),
          nowSec: now,
        });
  return {
    freshness,
    usdBenchmarkRate:
      freshness === "healthy"
        ? finiteNumber(payload.riskFreeRate) ?? (meta ? getYieldBenchmarkComparisonApy({ ...meta, key: "USD" }) : null)
        : null,
  };
}

function hydrateYieldRankingsWithLiveSafety(
  payload: YieldRankingsResponse,
  scores: ReadonlyMap<string, SafetyScoreGradeSnapshot["cards"][number]>,
  source: LiveSafetyHydrationSource,
  now: number,
  preservePublishedSafety = false,
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  // Reference (USD) risk-free rate the re-based effective yield anchors on (yield v8.43).
  const { usdBenchmarkRate } = resolvePublishedReferenceBenchmark(payload, now);
  const benchmarks = resolvePublishedBenchmarks(payload);
  const hydratedRows = payload.rankings
    .map((publishedRow) => {
      const benchmarkUnitMismatch = hasYieldBenchmarkUnitMismatch(publishedRow);
      const row = benchmarkUnitMismatch ? {
        ...publishedRow,
        excessYield: null,
        benchmarkKey: undefined, benchmarkLabel: undefined, benchmarkCurrency: undefined, benchmarkRate: undefined,
        benchmarkRecordDate: null, benchmarkIsFallback: false, benchmarkFallbackMode: null,
        benchmarkSelectionMode: undefined, benchmarkIsProxy: undefined,
        warningSignals: [...new Set([...publishedRow.warningSignals.filter((signal) =>
          signal !== "benchmark-stale" && signal !== "benchmark-degraded" && signal !== "reference-benchmark-degraded"),
          "benchmark-unit-mismatch"])],
        provenance: publishedRow.provenance ? {
          ...publishedRow.provenance,
          benchmarkKey: undefined, benchmarkLabel: undefined, benchmarkCurrency: undefined, benchmarkRate: undefined,
          benchmarkRecordDate: null, benchmarkIsFallback: false, benchmarkFallbackMode: null,
          benchmarkSelectionMode: undefined, benchmarkIsProxy: undefined, benchmarkFreshness: undefined,
        } : publishedRow.provenance,
      } : publishedRow;
      const benchmarkFreshness = benchmarkUnitMismatch ? "stale" : resolveHydratedBenchmarkFreshness(row, benchmarks, now);
      const evidenceClass = resolveHydratedEvidenceClass(row);
      const benchmarkCurrency =
        row.benchmarkCurrency ??
        row.provenance?.benchmarkCurrency ??
        (row.benchmarkKey != null ? YIELD_BENCHMARK_KEY_CURRENCY[row.benchmarkKey] : null) ??
        null;
      const benchmarkDependencies = resolveYieldBenchmarkDependencies({
        stablecoinId: row.id,
        dataSource: row.dataSource,
        sourceKey: row.provenance?.sourceKey,
        benchmarks: row.dataSource === "rate-derived" ? benchmarks : payload.benchmarks ?? {},
        benchmarkCurrency,
        nowSec: now,
      });
      const { productKey, productMeta, productFreshness } = benchmarkDependencies;
      const sourceKey = row.provenance?.sourceKey;
      const sourceObservedAt = row.provenance?.sourceObservedAt;
      const isUsycNav = sourceKey === OPTIONAL_YIELD_SOURCES.hashnote.sourceKey;
      const sourceAgeTier = classifyYieldSourceAgeTier({
        dataSource: row.dataSource, sourceKey, sourceObservedAt, nowSec: now,
        sourceAgeSeconds: finiteNumber(row.provenance?.sourceAgeSeconds),
        productFreshness: productKey == null ? undefined : productFreshness,
      });
      const sourceFreshness = resolveHydratedSourceFreshness(row, sourceAgeTier);
      const usycWindow = isUsycNav ? getUsycNavReportWindow(sourceObservedAt) : null;
      const sourceMaxAgeSeconds = isUsycNav
        ? usycWindow && sourceObservedAt != null ? usycWindow.staleAfterSec - sourceObservedAt : null
        : productKey != null
          ? productMeta && getYieldBenchmarkRecordMaxAgeSeconds(productKey, productMeta.recordDate, productMeta.maxRecordAgeSec)
          : getRankingStaleThresholdMs(row.dataSource, sourceKey) / 1000;
      const rowReferenceBenchmarkFreshness = benchmarkDependencies.referenceFreshness;
      const referenceBenchmarkDegraded = !benchmarkUnitMismatch && rowReferenceBenchmarkFreshness !== "healthy";
      const independentWarnings = row.warningSignals.filter((signal) => {
        if (signal === "reference-benchmark-degraded") return referenceBenchmarkDegraded;
        if (signal === "aging" && (isUsycNav || productKey != null)) return sourceAgeTier === "aging";
        return true;
      });
      if (referenceBenchmarkDegraded && !independentWarnings.includes("reference-benchmark-degraded")) {
        independentWarnings.push("reference-benchmark-degraded");
      }
      if (!benchmarkUnitMismatch && benchmarkFreshness !== "healthy" && !independentWarnings.includes(`benchmark-${benchmarkFreshness}`)) {
        independentWarnings.push(`benchmark-${benchmarkFreshness}`);
      }
      // B21: second-tier observation-age signals, so a row whose source stopped
      // refreshing is not served as fresh for the whole stale window.
      if (sourceAgeTier === "aging" && !independentWarnings.includes("aging")) {
        independentWarnings.push("aging");
      }
      if (sourceFreshness === "stale" && !independentWarnings.includes("data-stale")) {
        independentWarnings.push("data-stale");
      }
      const currentSafety = preservePublishedSafety ? undefined : scores.get(row.id);
      const pipelineGap = currentSafety?.ratingStatus === "pipeline-gap";
      if (pipelineGap || (currentSafety?.grade === "NR" && currentSafety.score == null)) {
        const reason = pipelineGap ? "safety-snapshot-unavailable" as const : "report-card-grade-not-rated" as const;
        return {
          originalRow: publishedRow,
          // A row published with a rating lost it when live hydration returned
          // pipeline-gap/NR, so its movement is not an APY change. A row already
          // published as NR did not change.
          safetyChanged: row.safetyScore !== null && row.safetyGrade !== "NR",
          row: {
            ...row,
            safetyScore: null,
            safetyGrade: pipelineGap ? null : "NR" as const,
            safetyReason: reason,
            pharosYieldScore: null,
            pysNullReason: benchmarkUnitMismatch ? "missing-inputs" as const : resolveEvidenceNullReason({
              sourceFreshness, benchmarkFreshness, referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
              opportunityEvidenceComplete: true,
            }) ?? row.pysNullReason ?? "safety-unrated" as const,
            yieldToRisk: null,
            warningSignals: [...new Set([...independentWarnings, "safety-unrated"])],
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
              calculationMode: resolveHydratedCalculationMode(row),
              evidenceClass,
              sourceFreshness,
              sourceMaxAgeSeconds,
              benchmarkFreshness: benchmarkUnitMismatch ? undefined : benchmarkFreshness,
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
        safetyScore: row.safetyScore ?? DEFAULT_SAFETY_SCORE,
        safetyGrade: row.safetyGrade,
        safetyReason: row.safetyReason ?? null,
        sourceRisk: row.sourceRisk,
        safetyProvenance: row.provenance?.safetyProvenance,
        usedDefaultSafety: row.provenance?.usedDefaultSafety ?? true,
      } : resolvedSafety;
      const safetyInputScore = hydratedSafety.safetyScore;
      const evidenceAssessment = qualifyYieldEvidence({
        safety: hydratedSafety,
        evidenceClass,
        sourceFreshness,
        benchmarkFreshness,
        referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
        sourceDepthRatio: finiteNumber(hydratedSafety.sourceRisk?.sourceDepthRatio),
        observationCount30d: finiteNumber(hydratedSafety.sourceRisk?.observationCount30d),
        apyBase: row.apyBase,
        apyReward: row.apyReward,
        warnings: independentWarnings,
      });
      // Score from the emitted penalty so the served evidence remains replayable.
      const { pharosYieldScore, pysNullReason } = scoreYieldPys({
        apy30d: row.apy30d,
        safetyScore: safetyInputScore,
        apyVarianceScore: yieldStabilityToApyVarianceScore(row.yieldStability),
        scalingFactor: payload.scalingFactor,
        benchmarkRate: row.benchmarkRate ?? null,
        benchmarkCurrency,
        usdBenchmarkRate,
        sourceRiskPenalty: hydratedSafety.sourceRisk?.sourceRiskPenalty ?? null,
        nullReason: benchmarkUnitMismatch ? "missing-inputs" : evidenceAssessment.evidenceNullReason ??
          (preservePublishedSafety && row.safetyScore == null ? "safety-unrated" : null),
      });

      return {
        originalRow: publishedRow,
        safetyChanged: row.safetyScore !== safetyInputScore,
        row: {
          ...row,
          safetyScore: preservePublishedSafety ? row.safetyScore : safetyInputScore,
          safetyGrade: hydratedSafety.safetyGrade as YieldRanking["safetyGrade"],
          safetyReason: hydratedSafety.safetyReason,
          pharosYieldScore,
          pysNullReason,
          warningSignals: evidenceAssessment.warnings,
          yieldToRisk: preservePublishedSafety ? row.yieldToRisk
            : 101 - safetyInputScore > 0 ? row.apy30d / (101 - safetyInputScore) : null,
          sourceRisk: hydratedSafety.sourceRisk,
          altSources: preservePublishedSafety ? row.altSources : hydrateAltSourcesWithLiveSafety(row, safety),
          provenance: row.provenance
            ? {
                ...row.provenance,
                usedDefaultSafety: hydratedSafety.usedDefaultSafety,
                safetyProvenance: hydratedSafety.safetyProvenance,
                safetyReason: hydratedSafety.safetyReason,
                safetyScoreIdentity: preservePublishedSafety ? row.provenance.safetyScoreIdentity : source.safetyScoreIdentity,
                calculationMode: resolveHydratedCalculationMode(row),
                evidenceClass,
                evidenceCompleteness: evidenceAssessment.evidenceCompleteness,
                scoreQualification: evidenceAssessment.scoreQualification,
                sourceFreshness,
                sourceMaxAgeSeconds,
                benchmarkFreshness: benchmarkUnitMismatch ? undefined : benchmarkFreshness,
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
    safetyScorePublicationIdentitiesShareScoringContract(published, identity)
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
  now: number,
): boolean {
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
  now: number,
): { payload: YieldRankingsResponse; degradationReasons: string[] } {
  const servePublishTime = !source.degradationReasons.some(reason => reason.startsWith("safety-score-index-"))
    && canServePublishTimeSafety(payload, cached, now);
  const reassessed = hydrateYieldRankingsWithLiveSafety(payload, new Map(), source, now, true).payload;
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
  now: number,
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
    return resolveDegradedYieldRankings(payload, cached, "safety-snapshot-unavailable", source, now);
  }
  if (!isYieldSafetyFallbackWithinWindow(now, snapshot.updatedAt, now)) {
    source.degradationReasons.push("safety-publication-clock-out-of-budget");
    return resolveDegradedYieldRankings(payload, cached, "safety-snapshot-unavailable", source, now);
  }
  if (!hasCompatibleSafetyIdentity(payload, snapshot.safetyScoreIdentity)) {
    const reason = payload.provenance?.safetySnapshot.safetyScoreIdentity == null ? "safety-identity-missing" : "safety-identity-mismatch";
    return resolveDegradedYieldRankings(payload, cached, reason, source, now);
  }
  return hydrateYieldRankingsWithLiveSafety(payload, new Map(snapshot.cards.map((card) => [card.id, card])), source, now);
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
    readCache: readYieldRankingsCache,
    schema: YieldRankingsResponseSchema,
    malformedMessage: "Cached yield-rankings payload is malformed",
    transform: async (payload, { db, cached }) => {
      const published = payload as YieldRankingsResponse;
      if (!hasYieldPublicationContract(published)) {
        return errorResponse(503, "Cached yield-rankings payload is malformed");
      }
      let now = Math.floor(Date.now() / 1000);
      try {
        const active = await loadActiveSafetyScoreIndex(db);
        now = Math.floor(Date.now() / 1000);
        const hydrated = hydrateYieldPayload(ageYieldRankings(published, cached.updatedAt, now), cached, active, now);
        return buildYieldRankingsResponse(project(hydrated.payload), cached, hydrated.degradationReasons);
      } catch (err) {
        logWorkerEventArgs("api", "warn", "[yield-rankings] Live safety hydration failed:", err instanceof Error ? err.message : err);
        const degraded = resolveDegradedYieldRankings(ageYieldRankings(published, cached.updatedAt, now), cached, "safety-hydration-error", {
          source: "safety-score-v9-publication", safetyScoreIdentity: null, publicationGenerationId: null,
          methodologyVersion: null, publishedAt: null, degradationReasons: ["safety-hydration-error"],
        }, now);
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
function yieldCohortValidUntil(payload: YieldRankingsResponse, publishedAt: number, now: number, active: ActiveSafetyScoreIndex): number {
  let validUntil = Number.MAX_SAFE_INTEGER;
  const transitionAt = (at: number) => {
    if (at > now) validUntil = Math.min(validUntil, at);
  };
  const boundary = (origin: number | null | undefined, budget: number | null | undefined) => {
    if (origin == null || budget == null || !Number.isFinite(origin)) return;
    transitionAt(Math.floor(origin + budget) + 1);
  };
  const origin = (observedAt: number | null | undefined, age: number | null | undefined) =>
    finiteNumber(observedAt) ?? (finiteNumber(age) != null ? publishedAt - Math.max(0, age!) : null);
  const benchmarks = resolvePublishedBenchmarks(payload);
  for (const row of payload.rankings) {
    const sourceKey = row.provenance?.sourceKey;
    if (sourceKey === OPTIONAL_YIELD_SOURCES.hashnote.sourceKey) {
      const observedAt = usycObservationAt(row.provenance, publishedAt);
      const window = getUsycNavReportWindow(observedAt);
      if (window && observedAt != null) {
        transitionAt(observedAt - USYC_NAV_FUTURE_SKEW_SEC);
        transitionAt(window.expectedAtSec);
        transitionAt(window.staleAfterSec + 1);
      }
    } else {
      const productKey = row.dataSource === "rate-derived" ? resolveYieldBenchmarkDependencies({
        stablecoinId: row.id, dataSource: row.dataSource, sourceKey, benchmarks, benchmarkCurrency: null, nowSec: now,
      }).productKey : null;
      // The exact product's fixing and fetch deadlines are handled with the registry below.
      if (productKey == null) {
        const source = origin(row.provenance?.sourceObservedAt, row.provenance?.sourceAgeSeconds ?? row.sourceRisk?.sourceAgeSeconds);
        boundary(source, getRankingAgingThresholdMs(row.dataSource, sourceKey) / 1000);
        boundary(source, getRankingStaleThresholdMs(row.dataSource, sourceKey) / 1000);
      }
    }
    boundary(origin(row.provenance?.comparisonAnchorObservedAt, row.provenance?.comparisonAnchorAgeSeconds),
      getComparisonAnchorStaleThresholdMs(row.dataSource, sourceKey) / 1000);
  }
  for (const key of YIELD_BENCHMARK_KEY_VALUES) {
    const meta = benchmarks[key];
    if (!meta) continue;
    boundary(origin(meta.fetchedAt, meta.ageSeconds), YIELD_BENCHMARK_SCORE_TTL_SEC);
    if (meta.fetchedAt != null) transitionAt(Math.ceil(meta.fetchedAt));
    const recordAt = benchmarkRecordObservedAtSeconds(meta.recordDate);
    boundary(recordAt, getYieldBenchmarkRecordMaxAgeSeconds(key, meta.recordDate, meta.maxRecordAgeSec));
    // Invalid future-dated benchmark records can become admissible as time
    // advances. Do not retain their negative-age assessment across seconds.
    if (recordAt != null && (recordAt > now || (key === "MXN" && !isYieldBenchmarkFixingEffective(key, meta.recordDate, now)))) {
      transitionAt(now + 1);
    }
  }
  boundary(publishedAt, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC);
  boundary(payload.provenance?.safetySnapshot.publishedAt, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC);
  const liveSafetyPublishedAt = active.kind === "error" ? null : active.snapshot.updatedAt;
  boundary(liveSafetyPublishedAt, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC);
  for (const timestamp of [publishedAt, payload.provenance?.safetySnapshot.publishedAt, liveSafetyPublishedAt]) {
    if (timestamp != null && Number.isFinite(timestamp)) transitionAt(Math.ceil(timestamp));
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
      "yield-coin-cohort-v2", selected.publication, cached.updatedAt, YIELD_METHODOLOGY_VERSION,
      active.kind, active.kind === "error" ? active.reason : [active.snapshot.safetyScoreIdentity, active.snapshot.updatedAt, active.snapshot.publicationHealth],
      active.kind === "held" ? active.reason : null,
    ])).digest("hex");
    let now = Math.floor(Date.now() / 1000);
    let cohort = await readYieldCoinCohort(db, id, signature, now);
    if (cohort === null) {
      const owner = randomUUID();
      const claim = await claimYieldCoinCohort(db, signature, owner, now);
      if (claim === null) {
        cohort = await readYieldCoinCohort(db, id, signature, Math.floor(Date.now() / 1000));
        if (cohort === null) {
          const fallbackNow = Math.floor(Date.now() / 1000);
          const previous = await readYieldCoinCohort(db, id, null, fallbackNow);
          const previousSafetyIdentity = previous?.provenance?.liveSafetyHydration?.safetyScoreIdentity;
          if (active.kind === "v9"
            && selected.rankings.some(row => row.id === id)
            && previous?.rankings.some(row => row.id === id)
            && previous?.yieldMethodologyVersion === YIELD_METHODOLOGY_VERSION
            && isYieldSafetyFallbackWithinWindow(fallbackNow, active.snapshot.updatedAt, fallbackNow)
            && previousSafetyIdentity != null
            && safetyScorePublicationIdentitiesAreComparable(previousSafetyIdentity, active.snapshot.safetyScoreIdentity)
            && (!previous?.rankings.some(row => row.safetyScore != null)
              || active.snapshot.cards.some(card => card.id === id && card.ratingStatus !== "pipeline-gap"
                && card.score != null && card.grade !== "NR"))) {
            cohort = previous;
          }
        }
        if (cohort === null) {
          // The claimant may be a fast builder that publishes within its lease.
          // Wait twice (250 ms, then 500 ms), re-reading only this coin's scoped
          // derivative under the invocation's exact signature each time. The
          // wait is bounded so stalled or abandoned leases stay retryable.
          for (const waitMs of [250, 500]) {
            await sleep(waitMs);
            cohort = await readYieldCoinCohort(db, id, signature, Math.floor(Date.now() / 1000));
            if (cohort !== null) break;
          }
        }
        if (cohort === null) {
          // Diagnostic-only lease read: the exhaustion reason and holder are
          // durable in logs, and a failed read never changes the 503.
          let lease: { signature: string; owner: string; leaseUntil: number } | null = null;
          try {
            lease = await readYieldCoinCohortLease(db);
          } catch {
            // Owner and deadline stay unknown.
          }
          logWorkerEvent({
            scope: "api",
            level: "warn",
            event: "yield-cohort-preparing",
            route: "yield-rankings-coin",
            status: 503,
            message: "Yield coin cohort preparation still in progress",
            metadata: {
              stablecoinId: id,
              reason: "yield-cohort-preparing",
              signaturePrefix: signature.slice(0, 12),
              // The single lease row may belong to another signature's build.
              ...(lease ? {
                leaseSignaturePrefix: lease.signature.slice(0, 12),
                leaseOwner: lease.owner,
                leaseUntil: lease.leaseUntil,
              } : {}),
            },
          });
          return yieldCoinUnavailable("yield-cohort-preparing", true);
        }
      } else {
        const buildStartedAt = Date.now();
        logWorkerEvent({
          scope: "api",
          level: "info",
          event: "yield-cohort-lease-claimed",
          route: "yield-rankings-coin",
          message: "Claimed yield coin cohort preparation lease",
          metadata: { stablecoinId: id, signaturePrefix: signature.slice(0, 12), leaseOwner: owner, leaseUntil: claim.leaseUntil },
        });
        try {
          const fullCache = await readYieldRankingsCache(db);
          if (!fullCache || fullCache.updatedAt !== cached.updatedAt) {
            return yieldCoinUnavailable("yield-cohort-publication-changed", true);
          }
          const full = YieldRankingsResponseSchema.parse(JSON.parse(fullCache.value));
          if (!hasYieldPublicationContract(full) || JSON.stringify(full.publication) !== JSON.stringify(selected.publication)
            || full.updatedAt !== cached.updatedAt) {
            return yieldCoinUnavailable("yield-rankings-malformed");
          }
          now = Math.floor(Date.now() / 1000);
          const hydrated = hydrateYieldPayload(ageYieldRankings(full, cached.updatedAt, now), cached, active, now);
          const aggregate = YieldCoinCohortSchema.parse({
            ...hydrated.payload,
            yieldMethodologyVersion: YIELD_METHODOLOGY_VERSION,
            signature, assessedAt: now, validUntil: yieldCohortValidUntil(full, cached.updatedAt, now, active),
            totalCount: full.rankings.length, degradationReasons: hydrated.degradationReasons,
          });
          await publishYieldCoinCohort(db, owner, aggregate);
          cohort = { ...aggregate, rankings: aggregate.rankings.filter((row) => row.id === id) };
          logWorkerEvent({
            scope: "api", level: "info", event: "yield-cohort-built", route: "yield-rankings-coin",
            message: "Published yield coin cohort assessment",
            metadata: { stablecoinId: id, signaturePrefix: signature.slice(0, 12), leaseOwner: owner,
              durationMs: Date.now() - buildStartedAt },
          });
        } finally {
          await releaseYieldCoinCohort(db, owner);
        }
      }
    }
    if (!hasYieldPublicationContract(cohort) || cohort.publication.updatedAt !== cohort.updatedAt) {
      return yieldCoinUnavailable("yield-rankings-malformed");
    }
    if (cohort.validUntil <= Math.floor(Date.now() / 1000)) {
      return yieldCoinUnavailable("yield-cohort-assessment-expired", true);
    }
    const previousAssessment = cohort.signature !== signature;
    now = Math.floor(Date.now() / 1000);
    const payload = previousAssessment
      ? YieldRankingsResponseSchema.parse(ageYieldRankings(cohort, cohort.assessedAt, now))
      : hydrateYieldPayload(ageYieldRankings(selected, cached.updatedAt, now), cached, active, now).payload;
    const comparatorRows = cohort.rankings;
    const rankings = payload.rankings.map((row) => {
      const comparator = comparatorRows.find((entry) => entry.id === row.id);
      if (!comparator) throw new Error("Yield coin comparator missing");
      const { rankChangeAttribution: _localAttribution, liveRank: _localRank, ...fields } = row;
      return { ...fields, liveRank: comparator.liveRank,
        ...(comparator.rankChangeAttribution !== undefined ? { rankChangeAttribution: comparator.rankChangeAttribution } : {}) };
    });
    const projected: YieldRankingsCoinResponse = {
      ...payload, rankings, warnings: cohort.warnings,
      provenance: payload.provenance ? {
        ...payload.provenance, liveSafetyHydration: cohort.provenance?.liveSafetyHydration,
      } : payload.provenance,
      projection: {
        stablecoinId: id, generationId: payload.publication?.generationId ?? null, updatedAt: payload.updatedAt,
        totalCount: cohort.totalCount, unavailableReason: rankings.length > 0 ? null : "row-not-published",
      },
    };
    const response = buildYieldRankingsResponse(projected, { updatedAt: payload.updatedAt }, cohort.degradationReasons);
    if (previousAssessment) {
      response.headers.set("Cache-Control", "no-store");
      response.headers.append("Warning", `199 - "Yield cohort rebuilding; signature=${cohort.signature}; assessedAt=${cohort.assessedAt}; validUntil=${cohort.validUntil}"`);
    }
    return response;
  } catch (err) {
    logWorkerEventArgs("api", "warn", "[yield-rankings-coin] Scoped projection unavailable:", err instanceof Error ? err.message : err);
    return yieldCoinUnavailable("yield-coin-projection-unavailable");
  }
}
