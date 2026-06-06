import type {
  AltYieldSource,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldPublicDecisionLedger,
  YieldPublicationMetadata,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types/yield";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { PYS_SCALING_FACTOR } from "../../lib/constants";
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";
import { COMPARISON_ANCHOR_STALE_THRESHOLD_MS, getRankingStaleThresholdMs } from "../yield-helpers";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { compareCandidates } from "./evaluation-arbitration";
import { buildPublicDecisionLedger } from "./decision-public";
import { buildYieldMethodology } from "./publication-methodology";
import { buildYieldSourceRisk } from "./source-risk";

function evaluatedSourceToRanking(
  source: EvaluatedYieldSource,
  provenance: Record<string, unknown> | null,
  publicationGenerationId?: string | null,
  publishedRank?: number,
  decisionLedger?: YieldPublicDecisionLedger | null,
) {
  const meta = TRACKED_META_BY_ID.get(source.id);
  return {
    id: source.id,
    symbol: source.symbol,
    name: meta?.name ?? source.symbol,
    currentApy: source.currentApy,
    apy7d: source.apy7d,
    apy30d: source.apy30d,
    apyBase: source.apyBase,
    apyReward: source.apyReward,
    yieldSource: source.yieldSource,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId: source.id,
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    }),
    yieldType: source.yieldType,
    dataSource: source.dataSource,
    sourceTvlUsd: source.sourceTvlUsd,
    pharosYieldScore: source.pharosYieldScore,
    pysNullReason: source.pysNullReason,
    safetyScore: source.safetyScore,
    safetyGrade: source.safetyGrade,
    yieldToRisk: source.yieldToRisk,
    excessYield: source.excessYield,
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    benchmarkRate: source.benchmarkRate,
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    yieldStability: source.yieldStability,
    apyVariance30d: source.stdDev30d,
    apyMin30d: source.apyMin30d,
    apyMax30d: source.apyMax30d,
    warningSignals: [...source.warnings],
    altSources: [] as AltYieldSource[],
    sourceRisk: buildYieldSourceRisk({ source, provenance, isBest: true }),
    ...(publicationGenerationId ? { publicationGenerationId } : {}),
    ...(publishedRank ? { publishedRank } : {}),
    ...(decisionLedger ? { decisionLedger } : {}),
    provenance: provenance
      ? {
          ...provenance,
          safetyProvenance: source.safetyProvenance,
        }
      : null,
  };
}

export function resolveApy30dDeltaFromPrevious(input: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  previousBestSourceKey: string | null;
}): number | null {
  if (
    input.previousBestSourceKey == null ||
    input.previousBestSourceKey === "legacy-best" ||
    input.previousBestSourceKey === input.selected.sourceKey
  ) {
    return null;
  }

  const previous = input.candidates.find(
    (candidate) => candidate.sourceKey === input.previousBestSourceKey,
  );
  if (!previous || !Number.isFinite(previous.apy30d) || !Number.isFinite(input.selected.apy30d)) {
    return null;
  }
  return input.selected.apy30d - previous.apy30d;
}

export function buildYieldRankingsPayloadFromEvaluatedSources(
  input: {
    evaluatedSources: EvaluatedYieldSource[];
    bestSourceKeyByCoin: Map<string, string>;
    rankingProvenanceByKey: Map<string, Record<string, unknown>>;
    riskFreeRate: number;
    riskFreeRateMeta: YieldBenchmarkMeta;
    riskFreeRateRegistry?: YieldBenchmarkRegistry;
    dlPoolsMeta: YieldSourceInputMeta;
    safetySnapshot: YieldSafetySnapshotMeta;
    medianApy: number;
    startSec: number;
    publication?: YieldPublicationMetadata | null;
  },
) {
  const bestRows = input.evaluatedSources
    .filter((source) => input.bestSourceKeyByCoin.get(source.id) === source.sourceKey)
    .sort((a, b) => b.pharosYieldScore - a.pharosYieldScore);

  const altSourcesByCoin = new Map<string, AltYieldSource[]>();
  for (const source of input.evaluatedSources) {
    if (input.bestSourceKeyByCoin.get(source.id) === source.sourceKey) continue;

    const alts = altSourcesByCoin.get(source.id) ?? [];
    const existingIdx = alts.findIndex((a) => a.sourceKey === source.sourceKey);
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const alt: AltYieldSource = {
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
      yieldSourceUrl: resolveYieldSourceUrl({
        stablecoinId: source.id,
        sourceKey: source.sourceKey,
        yieldSource: source.yieldSource,
      }),
      yieldType: source.yieldType as AltYieldSource["yieldType"],
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      sourceTvlUsd: source.sourceTvlUsd,
      dataSource: source.dataSource,
      sourceRisk: buildYieldSourceRisk({ source, provenance, isBest: false }),
    };
    if (existingIdx >= 0) {
      if ((source.currentApy ?? 0) > (alts[existingIdx].currentApy ?? 0)) {
        alts[existingIdx] = alt;
      }
    } else {
      alts.push(alt);
    }
    altSourcesByCoin.set(source.id, alts);
  }

  const publicationGenerationId = input.publication?.generationId ?? null;
  const rankings = bestRows.map((source, index) => {
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const candidates = input.evaluatedSources
      .filter((candidate) => candidate.id === source.id)
      .sort(compareCandidates);
    const rejectedCount = candidates.filter((candidate) => candidate.rejected).length;
    const previousBestSourceKey =
      source.previousBestSourceKey != null && source.previousBestSourceKey !== "legacy-best"
        ? source.previousBestSourceKey
        : null;
    const sourceSwitch =
      previousBestSourceKey != null && previousBestSourceKey !== source.sourceKey;
    const apy30dDeltaFromPrevious = resolveApy30dDeltaFromPrevious({
      selected: source,
      candidates,
      previousBestSourceKey,
    });
    const decisionLedger = buildPublicDecisionLedger({
      selected: source,
      candidates,
      rejectedCount,
      previousBestSourceKey,
      sourceSwitch,
      apy30dDeltaFromPrevious,
    });
    const ranking = evaluatedSourceToRanking(
      source,
      provenance,
      publicationGenerationId,
      index + 1,
      decisionLedger,
    );
    ranking.altSources = altSourcesByCoin.get(source.id) ?? [];

    const sourceObservedAt =
      provenance != null && typeof provenance.sourceObservedAt === "number"
        ? provenance.sourceObservedAt
        : input.startSec;
    const updatedAtMs = sourceObservedAt * 1000;
    const staleThresholdMs = getRankingStaleThresholdMs(source.dataSource, source.sourceKey);
    const comparisonAnchorAgeSeconds =
      provenance != null && typeof provenance.comparisonAnchorAgeSeconds === "number"
        ? provenance.comparisonAnchorAgeSeconds
        : null;
    const staleComparisonAnchor =
      comparisonAnchorAgeSeconds != null &&
      comparisonAnchorAgeSeconds * 1000 > COMPARISON_ANCHOR_STALE_THRESHOLD_MS;
    if ((updatedAtMs > 0 && updatedAtMs < Date.now() - staleThresholdMs) || staleComparisonAnchor) {
      if (!ranking.warningSignals.includes("data-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
      }
    }

    return ranking;
  });

  return {
    rankings,
    riskFreeRate: input.riskFreeRate,
    benchmarks: input.riskFreeRateRegistry,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: input.medianApy,
    updatedAt: input.startSec,
    methodology: buildYieldMethodology(input.startSec),
    ...(input.publication ? { publication: input.publication } : {}),
    provenance: {
      selectionMethod: "confidence-weighted" as const,
      benchmark: input.riskFreeRateMeta,
      benchmarks: input.riskFreeRateRegistry,
      dlPools: input.dlPoolsMeta,
      safetySnapshot: input.safetySnapshot,
    },
  };
}
