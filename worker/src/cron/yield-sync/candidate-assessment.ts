import type {
  YieldCalculationMode,
  YieldEvidenceClass,
  YieldSafetyProvenance,
  YieldSafetyReason,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import {
  derivePysSourceRiskPenalty,
  PYS_MAX_SOURCE_RISK_PENALTY,
  type PysSourceRiskPenaltyInput,
  PYS_DEFAULT_SAFETY_SCORE as DEFAULT_SAFETY_SCORE,
} from "@shared/lib/yield-scoring";
import { resolveBenchmarkForStablecoin } from "./benchmarks";
import {
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
} from "@shared/lib/yield-benchmark-freshness";
import {
  qualifyYieldEvidence,
  classifyYieldSourceFreshness,
  getComparisonAnchorStaleThresholdMs,
} from "../../lib/yield-ranking-helpers";
import type { ResolvedYield } from "./types";
import { buildHistoryKey, pickHistoryRowsForSource } from "./history-evidence";
import { resolveDependencyConcentration } from "@shared/lib/yield-source-risk-registry";
import { resolveYieldRowSafety } from "@shared/lib/yield-opportunity-risk";
import { resolveYieldBenchmarkDependencies } from "../../lib/yield-config/yield-benchmark-dependencies";
import type {
  ConfidenceTier,
  EvaluatedYieldSource,
  EvaluateYieldSourcesInput,
  PreparedYieldEvaluation,
  ResolvedYieldEntryWithYield,
} from "./evaluation";
import {
  resolveYieldSourceLabel,
  resolveYieldTypeLabel,
  resolveYieldVenueProtocol,
  resolveYieldRewardShare,
} from "./source-risk";
import { resolvePenaltyOrderingFields } from "./candidate-scoring";
import { computeYieldCandidateStatistics } from "./candidate-statistics";

function getConfidenceTier(source: Pick<ResolvedYield, "dataSource" | "yieldType">): ConfidenceTier {
  if (source.yieldType === "lending-opportunity") return "discovered";

  switch (source.dataSource) {
    case "onchain":
    case "rate-derived":
      return "deterministic";
    case "defillama":
    case "protocol-api":
      return "curated";
    case "defillama-auto":
      return "discovered";
    case "price-derived":
    default:
      return "fallback";
  }
}

function resolveCalculationMode(source: ResolvedYield): YieldCalculationMode {
  if (source.dataSource === "rate-derived") return "benchmark-model";
  if (source.dataSource === "price-derived") return "price-return";
  if (source.exchangeRate != null || source.comparisonAnchorObservedAt != null) {
    return "exchange-rate-math";
  }
  if (source.dataSource === "onchain") return "direct-read";
  return "market-api";
}

export function resolveEvidenceClass(source: ResolvedYield): YieldEvidenceClass {
  if (source.yieldType === "lending-opportunity") return "discovered-observation";

  switch (source.dataSource) {
    case "onchain":
      return "direct-onchain";
    case "protocol-api":
      return source.sourceKey.startsWith("protocol-api:vaults-fyi:")
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

const LOW_SOURCE_TVL_USD = 250_000;

function computeSourceDepthRatio(sourceTvlUsd: number | null, supplyUsd: number | null | undefined): number | null {
  if (
    typeof sourceTvlUsd !== "number" ||
    !Number.isFinite(sourceTvlUsd) ||
    sourceTvlUsd < 0 ||
    typeof supplyUsd !== "number" ||
    !Number.isFinite(supplyUsd) ||
    supplyUsd <= 0
  ) {
    return null;
  }
  return sourceTvlUsd / supplyUsd;
}

function computeSourceAgeSeconds(startSec: number, sourceObservedAt: number | null | undefined): number | null {
  if (typeof sourceObservedAt !== "number" || !Number.isFinite(sourceObservedAt) || sourceObservedAt < 0) {
    return null;
  }
  return Math.max(0, Math.trunc(startSec - sourceObservedAt));
}

function isDefiLlamaDataSource(dataSource: string): boolean {
  return dataSource === "defillama" || dataSource === "defillama-auto";
}

function resolveSourceObservedAt(
  source: ResolvedYield,
  dlPoolsMeta: YieldSourceInputMeta | undefined,
): number | null {
  if (typeof source.sourceObservedAt === "number" && Number.isFinite(source.sourceObservedAt)) {
    return source.sourceObservedAt;
  }
  if (isDefiLlamaDataSource(source.dataSource)) {
    return typeof dlPoolsMeta?.updatedAt === "number" && Number.isFinite(dlPoolsMeta.updatedAt)
      ? dlPoolsMeta.updatedAt
      : null;
  }
  return null;
}

function resolveSourceAgeSeconds(
  startSec: number,
  source: ResolvedYield,
  sourceObservedAt: number | null,
  dlPoolsMeta: YieldSourceInputMeta | undefined,
): number | null {
  if (typeof source.sourceObservedAt === "number" && Number.isFinite(source.sourceObservedAt)) {
    return computeSourceAgeSeconds(startSec, sourceObservedAt);
  }
  if (
    isDefiLlamaDataSource(source.dataSource) &&
    typeof dlPoolsMeta?.ageSeconds === "number" &&
    Number.isFinite(dlPoolsMeta.ageSeconds) &&
    dlPoolsMeta.ageSeconds >= 0
  ) {
    return Math.trunc(dlPoolsMeta.ageSeconds);
  }
  return computeSourceAgeSeconds(startSec, sourceObservedAt);
}

export function assessYieldSourceGroup(
  input: EvaluateYieldSourcesInput,
  stablecoinId: string,
  entries: ResolvedYieldEntryWithYield[],
  prepared: PreparedYieldEvaluation,
) {
  const defaultSafetyIds = new Set<string>();
  const previousBestSourceKey = input.prevBestSourceKeyByCoin.get(stablecoinId) ?? null;
  const priorSwitches30d = input.sourceSwitchCount30dByCoin?.get(stablecoinId) ?? 0;
  // Derived penalty inputs per source key, kept so the row that wins can be re-derived
  // with its true 30d count after the arbitration role is known.
  const derivedPenaltyInputByKey = new Map<string, PysSourceRiskPenaltyInput>();

  const provisional = entries.map((entry) => {
    const y = entry.yield;
    const sourceKey = y.sourceKey;
    const yieldSource = resolveYieldSourceLabel({
      id: stablecoinId,
      dataSource: y.dataSource,
      project: y.project,
      explicitSource: y.yieldSource,
    });
    const yieldType = resolveYieldTypeLabel({
      id: stablecoinId,
      dataSource: y.dataSource,
      explicitType: y.yieldType,
    });
    const historySelection = pickHistoryRowsForSource(
      stablecoinId,
      sourceKey,
      y.dataSource,
      input.sourceHistory,
      input.onChainCompatibilityHistoryById,
      input.legacyDeterministicOnChainHistoryById,
      input.legacyHistoryById,
      prepared.resolvedCountByCoin,
    );
    const historyRows = historySelection.rows;
    const { apy7d, apy30d, yieldStability, apyVarianceScore, stdDev30d, apyMin30d, apyMax30d, distinctObservationDays30d } = computeYieldCandidateStatistics(
      y, historyRows, historySelection.usedLegacyHistory, input.startSec, input.sevenDaysAgoSec,
    );

    const safetySnapshotUnavailable = input.safetySnapshotAvailable === false;
    const safety = safetySnapshotUnavailable ? undefined : input.safetyScores.get(stablecoinId);
    if (safety == null) defaultSafetyIds.add(stablecoinId);
    // Canonical safety-resolution ladder (yield v8.33): the same
    // `resolveYieldRowSafety` the read path runs during live-safety hydration.
    // Opportunity-level risk for external opportunities (yield v8.32): the
    // underlying stablecoin's report card is one component, not the score.
    // Royco Dawn tranches keep their bespoke market-health model and publish
    // the same contract; missing critical market evidence produces NR.
    const safetyResolution = resolveYieldRowSafety({
      yieldType,
      underlyingSafety: safety,
      defaultSafetyScore: DEFAULT_SAFETY_SCORE,
      safetySnapshotUnavailable,
      // A8: one venue resolver. The same call feeds the published row
      // (`buildYieldSourceRisk`), so a row can no longer be scored against one
      // venue and labelled with another — explicit venueProtocol, then the
      // variant child-id map, then the DeFiLlama project slug, then the
      // sourceKey route.
      venueProtocolHint: resolveYieldVenueProtocol({
        venueProtocol: y.sourceRisk?.venueProtocol ?? y.venueProtocol ?? null,
        sourceKey: y.sourceKey,
        project: y.project ?? null,
        stablecoinId,
      }),
      sourceRisk: y.sourceRisk ?? null,
      sourceTvlUsd: y.sourceTvlUsd,
      ratedProvenance: "cached-publish",
    });
    const {
      underlyingSafetyGrade,
      usedDefaultSafety,
      venueRiskWeighted: resolvedVenueRiskWeighted,
      venueRiskTier: resolvedVenueRiskTier,
    } = safetyResolution;
    const safetyScore = safetyResolution.safetyScore;
    const safetyGrade = safetyResolution.safetyGrade;
    const safetyProvenance: YieldSafetyProvenance = safetyResolution.safetyProvenance;
    const safetyReason: YieldSafetyReason | null = safetyResolution.safetyReason;
    let sourceRisk = safetyResolution.sourceRisk;
    const benchmarkSelection = resolveBenchmarkForStablecoin({
      stablecoinId,
      benchmarks: input.riskFreeRates,
      benchmarkCurrency: y.benchmarkOverrideKey ?? null,
    });
    const benchmarkMeta = benchmarkSelection.meta;
    const benchmarkRate = benchmarkMeta.rate;
    // B24: the published currency is the benchmark's own, so an alternative USD
    // benchmark (USD_EFFR) is not re-based against the USD T-bill rate.
    const benchmarkCurrency = benchmarkMeta.currency ?? benchmarkSelection.key;
    const excessYield = apy30d - benchmarkRate;
    const prevExchangeRate = input.tier1PrevRates.get(stablecoinId) ?? null;
    const prevTvlUsd = historySelection.usedLegacyHistory
      ? (input.legacyPrevTvlById.get(stablecoinId) ?? null)
      : (input.prevTvlBySource.get(buildHistoryKey(stablecoinId, sourceKey)) ?? null);
    const sourceDepthRatio = computeSourceDepthRatio(y.sourceTvlUsd, input.stablecoinSupplyById?.get(stablecoinId));

    // A9: the penalty input and the published field resolve the reward share
    // through the same helper, so a base-only payload (apyReward null while
    // apyBase already equals the current APY) scores the same zero it publishes.
    const rewardShare = resolveYieldRewardShare({
      apyReward: y.apyReward,
      apyBase: y.apyBase,
      currentApy: y.currentApy,
    });
    const sourceObservedAt = resolveSourceObservedAt(y, input.dlPoolsMeta);
    const sourceAgeSeconds = resolveSourceAgeSeconds(input.startSec, y, sourceObservedAt, input.dlPoolsMeta);
    const comparisonAnchorAgeSeconds = computeSourceAgeSeconds(input.startSec, y.comparisonAnchorObservedAt);
    // Use the same assessment clock as the hurdle and prepared USD re-base;
    // the run's source-observation clock must not give references a second verdict.
    const benchmarkDependencies = resolveYieldBenchmarkDependencies({
      stablecoinId,
      dataSource: y.dataSource,
      benchmarks: input.riskFreeRates,
      benchmarkCurrency,
    });
    const sourceFreshness = benchmarkDependencies.productFreshness === "stale" ? "stale" : classifyYieldSourceFreshness({
      dataSource: y.dataSource,
      sourceKey,
      sourceAgeSeconds,
      comparisonAnchorAgeSeconds,
    });
    // A1: classify the benchmark entry from the feed's own health only. A
    // `fallback-usd` selection is a documented per-row methodology decision
    // (the peg has no native feed), not a degraded feed, so it must not emit
    // `benchmark-degraded` or cap the row at `estimated`.
    // A2: the entry's own observation age is part of that health — the row's
    // benchmark is judged against its key's record bound (USD 5d, CAD 45d, ...).
    const benchmarkFreshness = classifyYieldBenchmarkFreshness(benchmarkMeta, {
      recordDate: benchmarkMeta.recordDate,
      maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[benchmarkSelection.key],
    });
    const rowReferenceBenchmarkFreshness = benchmarkDependencies.referenceFreshness;
    const referenceBenchmarkDegraded = rowReferenceBenchmarkFreshness !== "healthy";
    const calculationMode = resolveCalculationMode(y);
    const evidenceClass = resolveEvidenceClass(y);
    const evidenceAssessment = qualifyYieldEvidence({
      safety: safetyResolution,
      evidenceClass,
      sourceFreshness,
      benchmarkFreshness,
      referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
      sourceDepthRatio,
      observationCount30d: distinctObservationDays30d,
      apyBase: y.apyBase,
      apyReward: y.apyReward,
      warnings: sourceFreshness === "stale" ? ["data-stale"]
        : sourceFreshness === "unknown" ? ["data-freshness-unknown"] : [],
    });
    const { evidenceCompleteness, scoreQualification } = evidenceAssessment;
    const effectiveScoreQualification = safetySnapshotUnavailable ? "NR" : scoreQualification;
    const scoreQualified = effectiveScoreQualification !== "NR";
    // Reviewer-set cross-venue dependency concentration (yield v8.292): resolve by
    // stablecoin id and attach it so it both penalizes PYS and surfaces on the row.
    const dependencyConcentration =
      sourceRisk?.dependencyConcentration ?? resolveDependencyConcentration(stablecoinId);
    if (dependencyConcentration && !sourceRisk?.dependencyConcentration) {
      sourceRisk = { ...(sourceRisk ?? {}), dependencyConcentration };
    }
    const derivedPenaltyInput: PysSourceRiskPenaltyInput = {
      rewardShare,
      sourceDepthRatio,
      sourceAgeSeconds,
      sourceSwitchCount30d: priorSwitches30d,
      observationCount30d: distinctObservationDays30d,
      venueRiskTier: resolvedVenueRiskTier,
      venueRiskWeighted: resolvedVenueRiskWeighted,
      dependencyConcentrationSeverity: dependencyConcentration?.severity ?? null,
    };
    let sourceRiskPenaltyInput = sourceRisk?.sourceRiskPenalty ?? null;
    if (sourceRiskPenaltyInput == null) {
      derivedPenaltyInputByKey.set(sourceKey, derivedPenaltyInput);
      // B3: arbitration basis = pre-run count, no switch term (never saturated).
      // The flat switch margin is applied after rejections are known, so the
      // margin and the 30d count share one still-candidate predicate (B2/F4).
      sourceRiskPenaltyInput = Math.min(
        PYS_MAX_SOURCE_RISK_PENALTY,
        derivePysSourceRiskPenalty(derivedPenaltyInput),
      );
    }
    const { evidenceNullReason } = evidenceAssessment;

    const penaltyDerivedFields = resolvePenaltyOrderingFields({
      apy30d,
      safetyScore,
      apyVarianceScore,
      benchmarkRate,
      benchmarkCurrency,
      // Re-base every row onto the reference (USD) risk-free rate (yield v8.43) so a
      // non-USD peg's inflation/policy-rate compensation is not scored as excess yield.
      // A3: null when the USD reference itself is degraded/stale.
      usdBenchmarkRate: prepared.usdBenchmarkRate,
      sourceRiskPenalty: sourceRiskPenaltyInput,
      safetySnapshotUnavailable,
      evidenceNullReason,
    });
    const yieldToRisk = !safetySnapshotUnavailable && 101 - safetyScore > 0 ? apy30d / (101 - safetyScore) : null;

    const anomalies: string[] = [];
    if (historySelection.usedLegacyHistory) anomalies.push("legacy-history-fallback");
    if (y.sourceTvlUsd != null && y.sourceTvlUsd < LOW_SOURCE_TVL_USD) anomalies.push("low-source-tvl");
    if (historyRows.length > 0 && apy30d > 0 && y.currentApy / apy30d > 2) anomalies.push("source-yield-spike");
    if (historyRows.length > 0 && apy30d > 0.5 && y.currentApy === 0) anomalies.push("source-zero-vs-history");
    const comparisonAnchorStaleThresholdMs = getComparisonAnchorStaleThresholdMs(y.dataSource, sourceKey);
    if (
      comparisonAnchorAgeSeconds != null &&
      comparisonAnchorAgeSeconds * 1000 > comparisonAnchorStaleThresholdMs
    ) {
      anomalies.push("anchor-stale");
    }
    if (sourceFreshness === "stale") anomalies.push("source-stale");
    if (sourceFreshness === "unknown") anomalies.push("source-freshness-unknown");
    if (!usedDefaultSafety && underlyingSafetyGrade === "NR") anomalies.push("safety-unrated");
    if (usedDefaultSafety) anomalies.push("safety-missing");
    if (benchmarkFreshness === "degraded") anomalies.push("benchmark-degraded");
    if (benchmarkFreshness === "stale") anomalies.push("benchmark-stale");

    const freshnessWarnings = evidenceAssessment.warnings;
    if (benchmarkFreshness === "degraded") freshnessWarnings.push("benchmark-degraded");
    if (benchmarkFreshness === "stale") freshnessWarnings.push("benchmark-stale");
    // A3: the row's score is no longer re-based on the USD reference, so say so.
    if (referenceBenchmarkDegraded) freshnessWarnings.push("reference-benchmark-degraded");

    return {
      id: stablecoinId,
      symbol: entry.symbol,
      sourceKey,
      yieldSource,
      yieldType,
      currentApy: y.currentApy,
      apyBase: y.apyBase,
      apyReward: y.apyReward,
      sourcePool: y.sourcePool,
      sourceTvlUsd: y.sourceTvlUsd,
      venueProtocol: y.project ?? null,
      venueChain: y.chain ?? null,
      sourceRisk,
      ...penaltyDerivedFields,
      dataSource: y.dataSource,
      exchangeRate: y.exchangeRate,
      sourceObservedAt,
      comparisonAnchorObservedAt: y.comparisonAnchorObservedAt ?? null,
      apy7d,
      apy30d,
      apyVarianceScore,
      stdDev30d,
      apyMin30d,
      apyMax30d,
      yieldStability,
      safetyScore,
      safetyGrade,
      safetyProvenance,
      safetyReason,
      safetyScoreIdentity: input.safetyScoreIdentity ?? null,
      yieldToRisk,
      excessYield,
      benchmarkKey: benchmarkSelection.key,
      benchmarkLabel: benchmarkMeta.label ?? benchmarkSelection.key,
      benchmarkCurrency: benchmarkMeta.currency ?? benchmarkSelection.key,
      benchmarkRate,
      usdBenchmarkRate: prepared.usdBenchmarkRate,
      benchmarkRecordDate: benchmarkMeta.recordDate,
      benchmarkIsFallback: benchmarkMeta.isFallback,
      benchmarkFallbackMode: benchmarkMeta.fallbackMode,
      benchmarkSelectionMode: benchmarkSelection.selectionMode,
      benchmarkIsProxy: benchmarkMeta.isProxy ?? false,
      benchmarkMeta,
      sourceFreshness,
      benchmarkFreshness,
      calculationMode,
      evidenceClass,
      evidenceCompleteness,
      scoreQualification: effectiveScoreQualification,
      scoreQualified,
      prevExchangeRate,
      prevTvlUsd,
      sourceDepthRatio,
      observationCount30d: distinctObservationDays30d,
      sourceSwitchCount30d: null,
      anomalies,
      warnings: freshnessWarnings,
      confidenceTier: getConfidenceTier(y),
      // Missing opportunity evidence withholds PYS but still leaves the observed APY publishable.
      // A stale benchmark belongs to the PYS-null-reason ladder: it withholds
      // the score, not the fresh observed row.
      rejected: safetySnapshotUnavailable || sourceFreshness !== "fresh",
      usedLegacyHistory: historySelection.usedLegacyHistory,
      usedDefaultSafety,
      previousBestSourceKey,
    } satisfies EvaluatedYieldSource;
  });

  return { provisional, derivedPenaltyInputByKey, defaultSafetyIds, previousBestSourceKey, priorSwitches30d };
}
