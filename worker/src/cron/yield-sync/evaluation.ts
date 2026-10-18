import type {
  YieldType,
} from "@shared/types/core";
import type {
  YieldBenchmarkKey,
  YieldBenchmarkSelectionMode,
  YieldCalculationMode,
  YieldEvidenceClass,
  YieldPysNullReason,
  YieldSafetyProvenance,
  YieldSafetyReason,
  YieldScoreQualification,
  YieldSourceRisk,
  YieldDeploymentPlace,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import {
  type PysSourceRiskPenaltyReason,
  computePYSFromComponents,
  computePysComponents,
  derivePysSourceRiskPenalty,
  PYS_MAX_SOURCE_RISK_PENALTY,
  type PysSourceRiskPenaltyInput,
  computePysRewardShare,
  computeSourceRiskScoreFromPenalty,
  PYS_DEFAULT_SAFETY_SCORE as DEFAULT_SAFETY_SCORE,
  yieldStabilityToApyVarianceScore,
} from "@shared/lib/yield-scoring";
import {
  type ParsedYieldBenchmarkMeta,
  resolveBenchmarkForStablecoin,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";
import {
  type YieldBenchmarkFreshness,
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
} from "@shared/lib/yield-benchmark-freshness";
import {
  type YieldSourceFreshness,
  derivePysNullReasonFromComponents,
  resolveEvidenceNullReason,
  classifyYieldSourceFreshness,
  getComparisonAnchorStaleThresholdMs,
} from "../../lib/yield-ranking-helpers";
import type {
  SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import {
  TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/registry";
import {
  LENDING_PROTOCOL_LABELS,
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
} from "../../lib/yield-config/yield-config";
import type {
  ResolvedYield,
  ResolvedYieldEntry,
} from "./types";
import {
  PYS_SCALING_FACTOR,
} from "../../lib/constants";
import {
  isRealSourceSwitch,
} from "../../lib/yield-history-ownership-handoffs";
import {
  countSourceSwitchesWithTail,
  type YieldHistorySnapshotRow,
  buildHistoryKey,
  pickHistoryRowsForSource,
} from "./history";
import {
  resolveReviewedYieldRiskConfig,
  venueRiskTierOf,
  venueRiskWeightedOf,
  YIELD_VARIANT_CHILD_VENUE_PROTOCOLS,
  resolveDependencyConcentration,
} from "@shared/lib/yield-source-risk-registry";
import {
  numberValue as finiteNumber,
} from "@shared/lib/type-guards";
import {
  resolveYieldSourceKeyRoute,
} from "./family-registry";
import {
  weightedMedian,
} from "@shared/lib/stats";
import {
  assessYieldEvidence,
} from "@shared/lib/yield-evidence";
import {
  resolveYieldRowSafety,
} from "@shared/lib/yield-opportunity-risk";
import {
  DAY_SECONDS,
} from "@shared/lib/time-constants";
import {
  isOnChainBootstrapYieldSeed,
} from "../../lib/yield-utils";
import {
  computeYieldStability,
  detectWarningSignals,
} from "../yield-helpers";
import {
  throwIfAborted,
  yieldToEventLoop as defaultYieldToEventLoop,
} from "../../lib/abort";
import {
  resolveYieldBenchmarkDependencies,
} from "../../lib/yield-config/yield-benchmark-dependencies";

export type ConfidenceTier = "deterministic" | "curated" | "discovered" | "fallback";

export interface EvaluatedYieldSource {
  id: string;
  symbol: string;
  sourceKey: string;
  yieldSource: string;
  yieldType: YieldType;
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  venueProtocol?: string | null;
  venueChain?: string | null;
  sourceRisk: YieldSourceRisk | null;
  sourceRiskPenalty: number;
  sourceRiskPenaltyReason: PysSourceRiskPenaltyReason;
  sourceRiskPenaltyProvided: boolean;
  sourceRiskAdjustedUtility: number;
  dataSource: string;
  exchangeRate: number | null;
  sourceObservedAt: number | null;
  comparisonAnchorObservedAt: number | null;
  apy7d: number;
  apy30d: number;
  apyVarianceScore: number | null;
  stdDev30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
  yieldStability: number | null;
  safetyScore: number;
  safetyGrade: string;
  safetyProvenance: YieldSafetyProvenance;
  safetyReason: YieldSafetyReason | null;
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
  yieldToRisk: number | null;
  excessYield: number;
  benchmarkKey: YieldBenchmarkKey;
  benchmarkLabel: string;
  benchmarkCurrency: string;
  benchmarkRate: number;
  /**
   * Reference (USD) risk-free rate the row's hurdle was re-based onto, retained
   * so the publish-time audit snapshot can replay the score (yield v8.43, B4).
   * Null when the reference rate was unavailable.
   */
  usdBenchmarkRate: number | null;
  /** `usdBenchmarkRate - benchmarkRate` as scored; 0 when no re-base applied. */
  hurdleRebase: number;
  benchmarkRecordDate: string | null;
  benchmarkIsFallback: boolean;
  benchmarkFallbackMode: string | null;
  benchmarkSelectionMode: YieldBenchmarkSelectionMode;
  benchmarkIsProxy: boolean;
  benchmarkMeta: ParsedYieldBenchmarkMeta;
  pharosYieldScore: number | null;
  pysNullReason: YieldPysNullReason | null;
  sourceFreshness: YieldSourceFreshness;
  benchmarkFreshness: YieldBenchmarkFreshness;
  calculationMode: YieldCalculationMode;
  evidenceClass: YieldEvidenceClass;
  evidenceCompleteness: number;
  scoreQualification: YieldScoreQualification;
  scoreQualified: boolean;
  prevExchangeRate: number | null;
  prevTvlUsd: number | null;
  sourceDepthRatio: number | null;
  observationCount30d: number | null;
  sourceSwitchCount30d: number | null;
  anomalies: string[];
  warnings: string[];
  confidenceTier: ConfidenceTier;
  rejected: boolean;
  usedLegacyHistory: boolean;
  usedDefaultSafety: boolean;
  previousBestSourceKey: string | null;
}

export function resolveYieldSourceLabel(params: {
  id: string;
  dataSource: string;
  project?: string;
  explicitSource?: string;
}): string {
  const meta = TRACKED_META_BY_ID.get(params.id);
  const yieldConfig = meta?.yieldConfig;
  return (
    params.explicitSource ??
    (params.dataSource === "defillama-auto" && params.project
      ? (LENDING_PROTOCOL_LABELS[params.project] ??
        params.project.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
      : (yieldConfig?.yieldSource ?? "Unknown"))
  );
}

export function resolveYieldTypeLabel(params: {
  id: string;
  dataSource: string;
  explicitType?: YieldType;
  pool?: { symbol: string; chain?: string | null };
}): YieldType {
  const meta = TRACKED_META_BY_ID.get(params.id);
  const yieldConfig = meta?.yieldConfig;
  // A pool's symbol and deposit addresses do not establish receipt ownership.
  // Native holder typing requires a curated source or an explicit type.
  return (
    params.explicitType ??
    (params.dataSource === "defillama-auto"
      ? "lending-opportunity"
      : (yieldConfig?.yieldType ?? "nav-appreciation"))
  );
}

export function getConfidenceTier(source: Pick<ResolvedYield, "dataSource" | "yieldType">): ConfidenceTier {
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

export function getConfidencePriority(tier: ConfidenceTier): number {
  switch (tier) {
    case "deterministic":
      return 4;
    case "curated":
      return 3;
    case "discovered":
      return 2;
    case "fallback":
    default:
      return 1;
  }
}

export function resolveCalculationMode(source: ResolvedYield): YieldCalculationMode {
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

function getEvidencePriority(evidenceClass: YieldEvidenceClass): number {
  switch (evidenceClass) {
    case "direct-first-party":
    case "direct-onchain":
      return 6;
    case "curated-observation":
      return 5;
    case "discovered-observation":
      return 4;
    case "modeled-proxy":
      return 2;
    case "fallback":
    default:
      return 1;
  }
}

export function relativeDivergence(a: number, b: number): number {
  const maxValue = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / maxValue;
}

export function compareCandidates(a: EvaluatedYieldSource, b: EvaluatedYieldSource): number {
  if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;

  const aHasPositiveApy = a.currentApy > 0;
  const bHasPositiveApy = b.currentApy > 0;
  if (aHasPositiveApy !== bHasPositiveApy) return aHasPositiveApy ? -1 : 1;

  const aFixedYield = a.yieldType === "fixed-yield";
  const bFixedYield = b.yieldType === "fixed-yield";
  if (aFixedYield !== bFixedYield) return aFixedYield ? 1 : -1;

  const evidenceDiff = getEvidencePriority(b.evidenceClass) - getEvidencePriority(a.evidenceClass);
  if (evidenceDiff !== 0) return evidenceDiff;

  const confidenceDiff = getConfidencePriority(b.confidenceTier) - getConfidencePriority(a.confidenceTier);
  if (confidenceDiff !== 0) return confidenceDiff;

  if (a.sourceRiskPenaltyProvided || b.sourceRiskPenaltyProvided) {
    const utilityDiff = b.sourceRiskAdjustedUtility - a.sourceRiskAdjustedUtility;
    if (utilityDiff !== 0) return utilityDiff;
  }

  if (a.currentApy !== b.currentApy) return b.currentApy - a.currentApy;

  const tvlDiff = (b.sourceTvlUsd ?? 0) - (a.sourceTvlUsd ?? 0);
  if (tvlDiff !== 0) return tvlDiff;

  // B30: fully-tied distinct candidates must not be decided by provider array
  // order; the source key is the last, stable discriminator (and never 0 for two
  // distinct keys, so the arbitration is antisymmetric).
  return a.sourceKey.localeCompare(b.sourceKey);
}

export function buildSelectionReason(source: EvaluatedYieldSource, rejectedPeers: number): string {
  if (source.rejected) {
    return "Selected as the least-bad remaining source after arbitration penalties";
  }

  const confidenceLabel =
    source.evidenceClass === "modeled-proxy"
      ? "modeled proxy"
      : source.confidenceTier === "deterministic"
      ? "deterministic"
      : source.confidenceTier === "curated"
        ? "curated canonical"
        : source.confidenceTier === "discovered"
          ? "discovered opportunity"
          : "fallback-derived";

  if (source.usedLegacyHistory) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration using legacy history carry-forward`;
  }

  if (rejectedPeers > 0) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration after rejecting ${rejectedPeers} conflicting candidate${rejectedPeers > 1 ? "s" : ""}`;
  }

  return `${confidenceLabel} source selected by confidence-weighted arbitration`;
}

interface PenaltyFieldsInput {
  apy30d: number;
  safetyScore: number;
  apyVarianceScore: number | null;
  benchmarkRate: number;
  benchmarkCurrency: string;
  usdBenchmarkRate: number | null;
  sourceRiskPenalty: number;
  safetySnapshotUnavailable: boolean;
  evidenceNullReason: YieldPysNullReason | null;
}

type PenaltyDerivedFields = Pick<
  EvaluatedYieldSource,
  | "sourceRiskPenalty"
  | "sourceRiskPenaltyReason"
  | "sourceRiskPenaltyProvided"
  | "sourceRiskAdjustedUtility"
  | "hurdleRebase"
  | "pharosYieldScore"
  | "pysNullReason"
>;


/** Ordering needs utility and penalty provenance, but not a PYS value. */
export function resolvePenaltyOrderingFields(params: PenaltyFieldsInput): PenaltyDerivedFields {
  const components = computePysComponents(params);
  return {
    sourceRiskPenalty: components.sourceRiskPenalty,
    sourceRiskPenaltyReason: components.sourceRiskPenaltyReason,
    sourceRiskPenaltyProvided: components.sourceRiskPenaltyProvided,
    sourceRiskAdjustedUtility: components.rowUtility,
    hurdleRebase: components.hurdleRebase,
    pharosYieldScore: null,
    pysNullReason: params.safetySnapshotUnavailable
      ? "safety-unrated"
      : params.evidenceNullReason,
  };
}

/** Full score computation is reserved for the final published candidate shape. */
export function resolvePenaltyDerivedFields(params: PenaltyFieldsInput): PenaltyDerivedFields {
  const components = computePysComponents(params);
  const computedPharosYieldScore = computePYSFromComponents(params.apy30d, PYS_SCALING_FACTOR, components);
  // One ladder decides both fields: a published reason always means no score,
  // while a legitimately rounded-zero score keeps a null reason.
  const pysNullReason = params.safetySnapshotUnavailable
    ? "safety-unrated"
    : params.evidenceNullReason
      ?? derivePysNullReasonFromComponents(params.apy30d, PYS_SCALING_FACTOR, components);
  return {
    sourceRiskPenalty: components.sourceRiskPenalty,
    sourceRiskPenaltyReason: components.sourceRiskPenaltyReason,
    sourceRiskPenaltyProvided: components.sourceRiskPenaltyProvided,
    sourceRiskAdjustedUtility: components.rowUtility,
    hurdleRebase: components.hurdleRebase,
    pharosYieldScore: pysNullReason == null && Number.isFinite(computedPharosYieldScore)
      ? computedPharosYieldScore
      : null,
    pysNullReason,
  };
}

const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;
const PYS_SWITCH_ARBITRATION_MARGIN = 0.1;

export interface YieldSourceGroupSelectionResult {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKey: string;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
}

export function selectYieldSourceGroup(params: {
  stablecoinId: string;
  provisional: EvaluatedYieldSource[];
  previousBestSourceKey: string | null;
  priorSwitches30d: number;
  derivedPenaltyInputByKey: Map<string, PysSourceRiskPenaltyInput>;
  bestRowsByCoin?: Map<string, YieldHistorySnapshotRow[]>;
  safetySnapshotUnavailable: boolean;
  referenceBenchmarkFreshness: YieldBenchmarkFreshness;
  usdBenchmarkRate: number | null;
}): YieldSourceGroupSelectionResult | null {
  let canonicalReference: EvaluatedYieldSource | undefined;
  for (const candidate of params.provisional) {
    if (candidate.rejected || candidate.confidenceTier === "discovered") continue;
    if (!canonicalReference || compareCandidates(candidate, canonicalReference) < 0) {
      canonicalReference = candidate;
    }
  }

  let divergenceFlags = 0;
  const candidates = params.provisional.map((candidate) => {
    const anomalies = [...candidate.anomalies];
    let rejected = candidate.rejected;

    if (
      canonicalReference &&
      canonicalReference.sourceKey !== candidate.sourceKey &&
      getConfidencePriority(candidate.confidenceTier) < getConfidencePriority(canonicalReference.confidenceTier)
    ) {
      const divergence = relativeDivergence(candidate.currentApy, canonicalReference.currentApy);
      if (
        canonicalReference.currentApy > 0 &&
        candidate.currentApy > 0 &&
        divergence > CROSS_SOURCE_DIVERGENCE_THRESHOLD
      ) {
        anomalies.push("diverges-from-canonical");
        divergenceFlags++;
        if (candidate.dataSource === "defillama-auto" || candidate.dataSource === "price-derived") {
          rejected = true;
        }
      }
    }

    if (
      canonicalReference &&
      canonicalReference.currentApy === 0 &&
      candidate.currentApy > 1 &&
      canonicalReference.sourceKey !== candidate.sourceKey &&
      getConfidencePriority(canonicalReference.confidenceTier) > getConfidencePriority(candidate.confidenceTier)
    ) {
      anomalies.push("canonical-zero-vs-positive");
    }
    if (anomalies.includes("source-zero-vs-history")) rejected = true;
    return { ...candidate, anomalies, rejected };
  });

  const previousWinnerStillCandidate =
    params.previousBestSourceKey != null &&
    candidates.some(
      (candidate) => candidate.sourceKey === params.previousBestSourceKey && !candidate.rejected,
    );
  const arbitratedCandidates = !previousWinnerStillCandidate
    ? candidates
    : candidates.map((candidate) => {
        const derivedPenaltyInput = params.derivedPenaltyInputByKey.get(candidate.sourceKey);
        if (
          derivedPenaltyInput == null ||
          !isRealSourceSwitch(params.previousBestSourceKey, candidate.sourceKey)
        ) {
          return candidate;
        }
        return {
          ...candidate,
          ...resolvePenaltyOrderingFields({
            apy30d: candidate.apy30d,
            safetyScore: candidate.safetyScore,
            apyVarianceScore: candidate.apyVarianceScore,
            benchmarkRate: candidate.benchmarkRate,
            benchmarkCurrency: candidate.benchmarkCurrency,
            usdBenchmarkRate: params.usdBenchmarkRate,
            sourceRiskPenalty: Math.min(
              PYS_MAX_SOURCE_RISK_PENALTY,
              candidate.sourceRiskPenalty + PYS_SWITCH_ARBITRATION_MARGIN,
            ),
            safetySnapshotUnavailable: params.safetySnapshotUnavailable,
            evidenceNullReason: resolveEvidenceNullReason({
              sourceFreshness: candidate.sourceFreshness,
              // The evaluator emits this warning exactly when opportunity evidence is incomplete.
              opportunityEvidenceComplete: !candidate.warnings.includes("opportunity-evidence-missing"),
              benchmarkFreshness: candidate.benchmarkFreshness,
              referenceBenchmarkFreshness:
                candidate.benchmarkCurrency === "USD" ? "healthy" : params.referenceBenchmarkFreshness,
            }),
          }),
        };
      });

  const sortedCandidates = [...arbitratedCandidates].sort(compareCandidates);
  // Curated venue ownership outranks discovery of the same instrument/type,
  // including an incumbent's switch margin. Keep discovered rows as alternatives.
  const explicitPools = EXPLICIT_YIELD_SOURCE_POOL_MAP[params.stablecoinId] ?? [];
  const curatedTypes = new Set(sortedCandidates
    .filter((candidate) => !candidate.rejected && explicitPools.some((config) =>
      config.poolId === candidate.sourceKey && config.yieldType === candidate.yieldType,
    ))
    .map((candidate) => candidate.yieldType));
  const winner = sortedCandidates.find((candidate) =>
    !candidate.rejected
    && !(candidate.dataSource === "defillama-auto" && curatedTypes.has(candidate.yieldType)
      && !explicitPools.some((config) => config.poolId === candidate.sourceKey)),
  ) ?? sortedCandidates[0];
  if (!winner) return null;

  const winnerWouldChangeSource = isRealSourceSwitch(params.previousBestSourceKey, winner.sourceKey);
  const sourceSwitchCount30d = params.bestRowsByCoin != null
    ? countSourceSwitchesWithTail(params.bestRowsByCoin.get(params.stablecoinId) ?? [], winner.sourceKey)
    : winnerWouldChangeSource && previousWinnerStillCandidate
      ? params.priorSwitches30d + 1
      : params.priorSwitches30d;
  const sourceSwitches = sourceSwitchCount30d > params.priorSwitches30d ? 1 : 0;

  const evaluatedSources = candidates.map((candidate) => {
    const isBest = candidate.sourceKey === winner.sourceKey;
    const publishedSwitchCount = isBest ? sourceSwitchCount30d : null;
    const derivedPenaltyInput = params.derivedPenaltyInputByKey.get(candidate.sourceKey);
    return {
      ...candidate,
      ...resolvePenaltyDerivedFields({
        apy30d: candidate.apy30d,
        safetyScore: candidate.safetyScore,
        apyVarianceScore: candidate.apyVarianceScore,
        benchmarkRate: candidate.benchmarkRate,
        benchmarkCurrency: candidate.benchmarkCurrency,
        usdBenchmarkRate: params.usdBenchmarkRate,
        sourceRiskPenalty: derivedPenaltyInput
          ? derivePysSourceRiskPenalty({
              ...derivedPenaltyInput,
              sourceSwitchCount30d: publishedSwitchCount,
            })
          : candidate.sourceRiskPenalty,
        safetySnapshotUnavailable: params.safetySnapshotUnavailable,
        evidenceNullReason: resolveEvidenceNullReason({
          sourceFreshness: candidate.sourceFreshness,
          opportunityEvidenceComplete: !candidate.warnings.includes("opportunity-evidence-missing"),
          benchmarkFreshness: candidate.benchmarkFreshness,
          referenceBenchmarkFreshness:
            candidate.benchmarkCurrency === "USD" ? "healthy" : params.referenceBenchmarkFreshness,
        }),
      }),
      sourceSwitchCount30d: publishedSwitchCount,
      anomalies:
        isBest && winnerWouldChangeSource && !previousWinnerStillCandidate
          ? [...candidate.anomalies, "previous-source-transiently-missing"]
          : candidate.anomalies,
    };
  });

  return {
    evaluatedSources,
    bestSourceKey: winner.sourceKey,
    rowsRejected: sortedCandidates.filter((candidate) => candidate.rejected).length,
    divergenceFlags,
    sourceSwitches,
  };
}

export { resolveDependencyConcentration } from "@shared/lib/yield-source-risk-registry";

/**
 * Derivation methods are a property of the row's calculation lane, not a venue.
 * A stored `sourceRisk.venueProtocol` from an earlier publication must not
 * re-enter the published payload as if it named an operator (A8).
 */
const DERIVATION_LANE_TOKENS: Readonly<Record<string, true>> = {
  "price-derived": true,
  "rate-derived": true,
};

/**
 * The single venue resolver (A8), used by both the scoring path
 * (`evaluation.ts`) and the publisher (`buildYieldSourceRisk`) so a row can no
 * longer be scored against one venue and labelled with another.
 *
 * Order: explicit `venueProtocol` → DeFiLlama project slug → `sourceKey`
 * route → tracked variant child-id fallback. Returns `null` when no venue is known —
 * never the row's derivation method.
 */
export function resolveYieldVenueProtocol(input: {
  venueProtocol?: string | null;
  sourceKey: string;
  project?: string | null;
  stablecoinId?: string | null;
}): string | null {
  const candidates = [
    input.venueProtocol,
    input.project,
    resolveYieldSourceKeyRoute(input.sourceKey)?.venueProtocol,
    input.stablecoinId ? YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[input.stablecoinId] : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed && DERIVATION_LANE_TOKENS[trimmed] !== true) return trimmed;
  }
  return null;
}

/**
 * The one reward-share resolution (A9) shared by the penalty input and the
 * published field. `computePysRewardShare` returns `null` whenever the payload
 * omits `apyReward`, but a base-only payload — `apyBase` finite and already
 * equal to the current APY — proves the reward share is zero rather than
 * unknown. A value stored by an earlier publication is never reused, so the
 * published evidence always reproduces the penalty that was actually scored.
 */
export function resolveYieldRewardShare(params: {
  apyReward: number | null | undefined;
  apyBase: number | null | undefined;
  currentApy: number | null | undefined;
}): number | null {
  const derived = computePysRewardShare(params.apyReward, params.currentApy);
  if (derived != null) return derived;
  if (
    params.apyReward == null &&
    params.apyBase != null &&
    params.currentApy != null &&
    params.apyBase >= params.currentApy - 1e-9
  ) {
    return 0;
  }
  return null;
}

function inferDeploymentPlace(source: EvaluatedYieldSource): YieldDeploymentPlace | null {
  if (source.dataSource === "rate-derived") return "rate-derived";
  if (source.dataSource === "price-derived") return "price-derived";
  if (source.yieldType === "lp-receipt") return "lp-or-dex";
  if (source.yieldType === "structured-tranche") return "structured-tranche";
  if (source.yieldType === "fixed-yield") return "lending-market";
  if (source.yieldType === "lending-opportunity") return "lending-market";
  if (source.yieldType === "lending-vault") return "strategy-vault";
  if (source.yieldType === "nav-appreciation" || source.yieldType === "rebase") return "native-wrapper";
  if (source.yieldType === "governance-set" || source.yieldType === "fee-sharing") return "issuer-savings";
  return null;
}

function inferVenueChain(sourceKey: string): string | null {
  const route = resolveYieldSourceKeyRoute(sourceKey);
  if (!route || route.chainSegmentIndex == null) return null;
  return sourceKey.split(":")[route.chainSegmentIndex] ?? null;
}

function optionalSourceRiskFields(existing: YieldSourceRisk): Partial<YieldSourceRisk> {
  return {
    ...(existing.trancheSide !== undefined ? { trancheSide: existing.trancheSide } : {}),
    ...(existing.trancheSafetyScore !== undefined ? { trancheSafetyScore: existing.trancheSafetyScore } : {}),
    ...(existing.trancheSafetyPenalty !== undefined ? { trancheSafetyPenalty: existing.trancheSafetyPenalty } : {}),
    ...(existing.underlyingSafetyScore !== undefined ? { underlyingSafetyScore: existing.underlyingSafetyScore } : {}),
    ...(existing.opportunityRisk !== undefined ? { opportunityRisk: existing.opportunityRisk } : {}),
    ...(existing.marketCoverageRatio !== undefined ? { marketCoverageRatio: existing.marketCoverageRatio } : {}),
    ...(existing.marketMinCoverageRatio !== undefined ? { marketMinCoverageRatio: existing.marketMinCoverageRatio } : {}),
    ...(existing.marketUtilizationRatio !== undefined ? { marketUtilizationRatio: existing.marketUtilizationRatio } : {}),
    ...(existing.marketUtilizationLimitRatio !== undefined ? { marketUtilizationLimitRatio: existing.marketUtilizationLimitRatio } : {}),
    ...(existing.marketDrawdownRatio !== undefined ? { marketDrawdownRatio: existing.marketDrawdownRatio } : {}),
    ...(existing.marketTotalDrawdowns !== undefined ? { marketTotalDrawdowns: existing.marketTotalDrawdowns } : {}),
    ...(existing.marketStatus !== undefined ? { marketStatus: existing.marketStatus } : {}),
    ...(existing.marketTvlUsd !== undefined ? { marketTvlUsd: existing.marketTvlUsd } : {}),
    ...(existing.trancheTvlUsd !== undefined ? { trancheTvlUsd: existing.trancheTvlUsd } : {}),
    ...(existing.trancheShareTokenAddress !== undefined ? { trancheShareTokenAddress: existing.trancheShareTokenAddress } : {}),
    ...(existing.trancheDepositTokenAddress !== undefined ? { trancheDepositTokenAddress: existing.trancheDepositTokenAddress } : {}),
    ...(existing.withdrawalDelaySeconds !== undefined ? { withdrawalDelaySeconds: existing.withdrawalDelaySeconds } : {}),
    ...(existing.kycRequired !== undefined ? { kycRequired: existing.kycRequired } : {}),
    ...(existing.accessRestricted !== undefined ? { accessRestricted: existing.accessRestricted } : {}),
  };
}

export function buildYieldSourceRisk(params: {
  source: EvaluatedYieldSource;
  provenance: Record<string, unknown> | null;
  isBest: boolean;
}): YieldSourceRisk {
  const existing = params.source.sourceRisk ?? {};
  const sourceAgeSeconds = finiteNumber(params.provenance?.sourceAgeSeconds);
  // A8: the publisher resolves the venue through the same resolver the scoring
  // path uses, so the published label and the scored tier can no longer diverge.
  const venueProtocol = resolveYieldVenueProtocol({
    venueProtocol: existing.venueProtocol ?? params.source.venueProtocol,
    sourceKey: params.source.sourceKey,
    stablecoinId: params.source.id,
  });
  const reviewedConfig = resolveReviewedYieldRiskConfig(venueProtocol);
  const reviewedWeighted = reviewedConfig ? venueRiskWeightedOf(reviewedConfig) : null;
  const reviewedTier = reviewedConfig ? venueRiskTierOf(reviewedConfig) : "unknown";

  return {
    sourceRiskScore:
      existing.sourceRiskScore ?? computeSourceRiskScoreFromPenalty(params.source.sourceRiskPenalty),
    sourceRiskPenalty: params.source.sourceRiskPenalty,
    sourceDepthRatio: params.source.sourceDepthRatio ?? existing.sourceDepthRatio ?? null,
    // A9: re-derived every publication. A base-only payload proves the reward
    // share is zero; an earlier publication's stored value is never reused.
    rewardShare: resolveYieldRewardShare(params.source),
    sourceAgeSeconds:
      sourceAgeSeconds == null
        ? (existing.sourceAgeSeconds ?? null)
        : Math.trunc(sourceAgeSeconds),
    observationCount30d: params.source.observationCount30d ?? existing.observationCount30d ?? null,
    sourceSwitchCount30d: params.isBest ? params.source.sourceSwitchCount30d : null,
    deploymentPlace: existing.deploymentPlace ?? inferDeploymentPlace(params.source),
    venueProtocol,
    venueChain: existing.venueChain ?? params.source.venueChain ?? inferVenueChain(params.source.sourceKey),
    venueRiskTier: existing.venueRiskTier ?? reviewedTier,
    venueRiskScores: existing.venueRiskScores ?? reviewedConfig?.scores ?? null,
    venueRiskWeighted: existing.venueRiskWeighted ?? reviewedWeighted,
    venueRiskConfidence: existing.venueRiskConfidence ?? reviewedConfig?.confidence ?? null,
    ...(existing.dependencyConcentration
      ? { dependencyConcentration: existing.dependencyConcentration }
      : {}),
    ...optionalSourceRiskFields(existing),
    investabilityFlags: existing.investabilityFlags ?? [],
  };
}

export function computeTvlWeightedMedianApy(
  rows: Array<{ apy_30d: number; source_tvl_usd: number | null }>,
): number | null {
  const validRows = rows.filter(
    (row) => row.source_tvl_usd != null && Number.isFinite(row.source_tvl_usd)
      && row.source_tvl_usd > 0 && Number.isFinite(row.apy_30d) && row.apy_30d > 0,
  );
  if (validRows.length === 0) return null;

  return weightedMedian(
    validRows.map((row) => ({ value: row.apy_30d, weight: row.source_tvl_usd! })),
  );
}

const LOW_SOURCE_TVL_USD = 250_000;

function isResolvedYieldEntryWithYield(
  entry: ResolvedYieldEntry,
): entry is ResolvedYieldEntry & { yield: ResolvedYield } {
  return entry.yield != null;
}

export interface EvaluateYieldSourcesInput {
  resolved: ResolvedYieldEntry[];
  startSec: number;
  sevenDaysAgoSec: number;
  safetyScores: Map<string, { score: number; grade: string }>;
  /** False only when the exact published compact safety snapshot is unavailable. */
  safetySnapshotAvailable?: boolean;
  safetyScoreIdentity?: SafetyScorePublicationIdentity | null;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  tier1PrevRates: Map<string, number | null>;
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>;
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  prevTvlBySource: Map<string, number | null>;
  legacyPrevTvlById: Map<string, number | null>;
  prevBestSourceKeyByCoin: Map<string, string>;
  sourceSwitchCount30dByCoin?: Map<string, number>;
  /**
   * Selected-source history rows per coin (B2/F5). When present, the published
   * `sourceSwitchCount30d` is recounted with this run's winner appended as the
   * newest publication; absent callers fall back to `sourceSwitchCount30dByCoin`
   * plus the incumbent-still-candidate increment.
   */
  bestRowsByCoin?: Map<string, YieldHistorySnapshotRow[]>;
  stablecoinSupplyById?: Map<string, number>;
  dlPoolsMeta?: YieldSourceInputMeta;
}

export interface EvaluateYieldSourcesResult {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  defaultSafetyIds: Set<string>;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
  medianApy: number | null;
}

export interface EvaluateYieldSourcesProgress {
  phase: "coin-evaluation" | "warning-finalization";
  coinsDone: number;
  coinsTotal: number;
  evaluatedSources: number;
  bestSourceCoins: number;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
}

export interface EvaluateYieldSourcesCooperativeOptions {
  signal?: AbortSignal;
  yieldEveryCoins?: number;
  yieldToEventLoop?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: EvaluateYieldSourcesProgress) => void | Promise<void>;
}

type ResolvedYieldEntryWithYield = ResolvedYieldEntry & { yield: ResolvedYield };

interface PreparedYieldEvaluation {
  resolvedWithYield: ResolvedYieldEntryWithYield[];
  resolvedCountByCoin: Map<string, number>;
  resolvedByCoin: Map<string, ResolvedYieldEntryWithYield[]>;
  /** USD reference freshness for the run (A3), classified once per publication. */
  referenceBenchmarkFreshness: YieldBenchmarkFreshness;
  /** Reference rate handed to the v8.43 re-base; null when that entry is not healthy. */
  usdBenchmarkRate: number | null;
}

interface YieldEvaluationAccumulator {
  bestSourceKeyByCoin: Map<string, string>;
  evaluatedSources: EvaluatedYieldSource[];
  defaultSafetyIds: Set<string>;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
}

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


function prepareYieldEvaluation(input: EvaluateYieldSourcesInput): PreparedYieldEvaluation {
  const resolvedWithYield = input.resolved.filter(isResolvedYieldEntryWithYield);
  const resolvedCountByCoin = new Map<string, number>();
  for (const entry of resolvedWithYield) {
    resolvedCountByCoin.set(entry.id, (resolvedCountByCoin.get(entry.id) ?? 0) + 1);
  }

  const resolvedByCoin = new Map<string, typeof resolvedWithYield>();
  for (const entry of resolvedWithYield) {
    const list = resolvedByCoin.get(entry.id) ?? [];
    list.push(entry);
    resolvedByCoin.set(entry.id, list);
  }

  // A3: `riskFreeRates.USD` is non-nullable even when it is a retained or
  // hardcoded fallback, so the v8.43 re-base used to consume a substituted or
  // stale constant without any row-level signal. Classify it once per run and
  // re-base only on a healthy reference; otherwise rows with a non-USD benchmark
  // publish `estimated`/NR plus a `reference-benchmark-degraded` warning.
  // A2: the entry's own observation age is part of its health — a frozen or
  // rewound upstream keeps returning a fresh fetch carrying an old CSV, so a
  // fetch-age-only classification would re-base rows onto a retained constant.
  const referenceBenchmarkFreshness = classifyYieldBenchmarkFreshness(input.riskFreeRates.USD, {
    recordDate: input.riskFreeRates.USD.recordDate,
    maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD,
  });
  const usdBenchmarkRate =
    referenceBenchmarkFreshness === "healthy" && Number.isFinite(input.riskFreeRates.USD.rate)
      ? input.riskFreeRates.USD.rate
      : null;

  return {
    resolvedWithYield,
    resolvedCountByCoin,
    resolvedByCoin,
    referenceBenchmarkFreshness,
    usdBenchmarkRate,
  };
}

function createEvaluationAccumulator(): YieldEvaluationAccumulator {
  return {
    bestSourceKeyByCoin: new Map<string, string>(),
    evaluatedSources: [],
    defaultSafetyIds: new Set<string>(),
    rowsRejected: 0,
    divergenceFlags: 0,
    sourceSwitches: 0,
  };
}

function evaluateYieldSourceGroup(
  input: EvaluateYieldSourcesInput,
  stablecoinId: string,
  entries: ResolvedYieldEntryWithYield[],
  prepared: PreparedYieldEvaluation,
  accumulator: YieldEvaluationAccumulator,
): void {
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
    // B26 — `isOnChainBootstrapYieldSeed` is lane-agnostic: the Tier-1 `onchain`
    // lane and the `protocol-api` NAV oracles (Ondo, Midas) both write the
    // anchor-without-yield seed shape, so a seed row must stay out of
    // apy7d/apy30d and the variance samples regardless of which lane recorded it.
    const historyRowsForStats = historyRows.filter((row) => !isOnChainBootstrapYieldSeed(row)
      && !(sourceKey === "protocol-api:zys-zephyr-protocol" && !historySelection.usedLegacyHistory && y.sourceObservedAt != null
        && row.recorded_at === y.sourceObservedAt));
    const samples: number[] = [];
    const apy7dSamples: number[] = [];
    for (const row of historyRowsForStats) {
      if (!Number.isFinite(row.apy)) continue;
      samples.push(row.apy);
      if (row.recorded_at >= input.sevenDaysAgoSec) {
        apy7dSamples.push(row.apy);
      }
    }
    samples.push(y.currentApy);
    apy7dSamples.push(y.currentApy);

    const apy7d = apy7dSamples.reduce((sum, value) => sum + value, 0) / apy7dSamples.length;
    const apy30d = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    // B5: score the same variance the read path re-derives from the 2-dp rounded
    // `yieldStability` (computeYieldStability rounds), so the served PYS cannot
    // diverge from the published one and emit a phantom ±1 `pysDelta`.
    const yieldStability = computeYieldStability(samples);
    const apyVarianceScore = yieldStabilityToApyVarianceScore(yieldStability);
    const stdDev30d =
      samples.length >= 2
        ? Math.sqrt(samples.reduce((sum, value) => sum + (value - apy30d) ** 2, 0) / samples.length)
        : null;
    const apyMin30d = samples.length > 0 ? samples.reduce((min, value) => Math.min(min, value), Infinity) : null;
    const apyMax30d = samples.length > 0 ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : null;

    const safetySnapshotUnavailable = input.safetySnapshotAvailable === false;
    const safety = safetySnapshotUnavailable ? undefined : input.safetyScores.get(stablecoinId);
    if (safety == null) accumulator.defaultSafetyIds.add(stablecoinId);
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
      safetyEvidenceObserved,
      opportunityEvidenceComplete,
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
    const distinctObservationDays30d = historySelection.usedLegacyHistory
      ? null
      : new Set([
          ...historyRowsForStats.map((row) => Math.floor(row.recorded_at / DAY_SECONDS)),
          Math.floor((sourceKey === "protocol-api:zys-zephyr-protocol" && y.sourceObservedAt != null
            ? y.sourceObservedAt : input.startSec) / DAY_SECONDS),
        ]).size;
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
    const evidenceAssessment = assessYieldEvidence({
      evidenceClass,
      safetyObserved: safetyEvidenceObserved,
      sourceFreshness,
      benchmarkFreshness,
      referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
      hasSourceDepth: sourceDepthRatio != null,
      hasVenueRisk: resolvedVenueRiskTier !== "unknown",
      // Distinct observation days, not raw row count: the read path can only see
      // the published `observationCount30d`, so both sides test the same fact
      // (legacy-history rows publish null and stay unqualified).
      hasHistory: (distinctObservationDays30d ?? 0) > 1,
      hasYieldDecomposition: y.apyBase != null || y.apyReward != null,
      opportunityEvidenceComplete,
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
    const evidenceNullReason = resolveEvidenceNullReason({
      sourceFreshness,
      benchmarkFreshness,
      referenceBenchmarkFreshness: rowReferenceBenchmarkFreshness,
      opportunityEvidenceComplete,
    });

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

    const freshnessWarnings: string[] = [];
    if (sourceFreshness === "stale") freshnessWarnings.push("data-stale");
    if (sourceFreshness === "unknown") freshnessWarnings.push("data-freshness-unknown");
    if (!safetyEvidenceObserved) freshnessWarnings.push("safety-unrated");
    if (!opportunityEvidenceComplete) freshnessWarnings.push("opportunity-evidence-missing");
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
      rejected: safetySnapshotUnavailable || sourceFreshness !== "fresh"
        || benchmarkFreshness === "stale" || rowReferenceBenchmarkFreshness === "stale",
      usedLegacyHistory: historySelection.usedLegacyHistory,
      usedDefaultSafety,
      previousBestSourceKey,
    } satisfies EvaluatedYieldSource;
  });

  const selection = selectYieldSourceGroup({
    stablecoinId,
    provisional,
    previousBestSourceKey,
    priorSwitches30d,
    derivedPenaltyInputByKey,
    bestRowsByCoin: input.bestRowsByCoin,
    safetySnapshotUnavailable: input.safetySnapshotAvailable === false,
    referenceBenchmarkFreshness: prepared.referenceBenchmarkFreshness,
    usdBenchmarkRate: prepared.usdBenchmarkRate,
  });
  if (!selection) return;

  accumulator.bestSourceKeyByCoin.set(stablecoinId, selection.bestSourceKey);
  accumulator.rowsRejected += selection.rowsRejected;
  accumulator.divergenceFlags += selection.divergenceFlags;
  accumulator.sourceSwitches += selection.sourceSwitches;
  accumulator.evaluatedSources.push(...selection.evaluatedSources);
}

function finalizeYieldEvaluation(accumulator: YieldEvaluationAccumulator): EvaluateYieldSourcesResult {
  const bestRows = accumulator.evaluatedSources.filter((source) =>
    accumulator.bestSourceKeyByCoin.get(source.id) === source.sourceKey && !source.rejected,
  );
  const medianApy = computeTvlWeightedMedianApy(
    bestRows.map((row) => ({
      apy_30d: row.apy30d,
      source_tvl_usd: row.sourceTvlUsd,
    })),
  );
  for (const source of accumulator.evaluatedSources) {
    source.warnings = [...new Set([...source.warnings, ...detectWarningSignals({
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      apyReward: source.apyReward,
      medianApy,
      sourceTvlUsd: source.sourceTvlUsd,
      prevTvlUsd: source.prevTvlUsd,
    })])];
  }

  return {
    evaluatedSources: accumulator.evaluatedSources,
    bestSourceKeyByCoin: accumulator.bestSourceKeyByCoin,
    defaultSafetyIds: accumulator.defaultSafetyIds,
    rowsRejected: accumulator.rowsRejected,
    divergenceFlags: accumulator.divergenceFlags,
    sourceSwitches: accumulator.sourceSwitches,
    medianApy,
  };
}

export function evaluateYieldSources(input: EvaluateYieldSourcesInput): EvaluateYieldSourcesResult {
  return evaluateYieldSourcesCooperative(input, { synchronous: true });
}

export function evaluateYieldSourcesCooperative(
  input: EvaluateYieldSourcesInput,
  options: EvaluateYieldSourcesCooperativeOptions & { synchronous: true },
): EvaluateYieldSourcesResult;
export function evaluateYieldSourcesCooperative(
  input: EvaluateYieldSourcesInput,
  options?: EvaluateYieldSourcesCooperativeOptions,
): Promise<EvaluateYieldSourcesResult>;
export function evaluateYieldSourcesCooperative(
  input: EvaluateYieldSourcesInput,
  options: EvaluateYieldSourcesCooperativeOptions & { synchronous?: boolean } = {},
): EvaluateYieldSourcesResult | Promise<EvaluateYieldSourcesResult> {
  const prepared = prepareYieldEvaluation(input);
  const accumulator = createEvaluationAccumulator();
  const groups = [...prepared.resolvedByCoin.entries()];

  if (options.synchronous) {
    for (const [stablecoinId, entries] of groups) {
      evaluateYieldSourceGroup(input, stablecoinId, entries, prepared, accumulator);
    }
    return finalizeYieldEvaluation(accumulator);
  }

  return (async () => {
    const yieldEveryCoins = Math.max(1, options.yieldEveryCoins ?? 10);
    const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;

    const reportProgress = async (phase: EvaluateYieldSourcesProgress["phase"], coinsDone: number) => {
      await options.onProgress?.({
        phase,
        coinsDone,
        coinsTotal: groups.length,
        evaluatedSources: accumulator.evaluatedSources.length,
        bestSourceCoins: accumulator.bestSourceKeyByCoin.size,
        rowsRejected: accumulator.rowsRejected,
        divergenceFlags: accumulator.divergenceFlags,
        sourceSwitches: accumulator.sourceSwitches,
      });
    };

    await reportProgress("coin-evaluation", 0);

    for (const [index, [stablecoinId, entries]] of groups.entries()) {
      throwIfAborted(options.signal);
      evaluateYieldSourceGroup(input, stablecoinId, entries, prepared, accumulator);
      const coinsDone = index + 1;
      if (coinsDone === groups.length || coinsDone % yieldEveryCoins === 0) {
        await reportProgress("coin-evaluation", coinsDone);
        await yieldToEventLoop(options.signal);
      }
    }

    throwIfAborted(options.signal);
    const result = finalizeYieldEvaluation(accumulator);
    await reportProgress("warning-finalization", groups.length);
    await yieldToEventLoop(options.signal);
    return result;
  })();
}
