import {
  getYieldHistorySampleAt,
} from "@shared/lib/yield-source-history";
import {
  YIELD_METHODOLOGY_VERSION,
} from "@shared/lib/methodology-versions/constants";
import {
  YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION,
} from "@shared/types/yield";
import { type EvaluatedYieldSource } from "./evaluation";
import type {
  ResolvedYieldEntry,
} from "./types";
import {
  PYS_SCALING_FACTOR,
} from "../../lib/yield-config/policy";
import {
  type YieldCoinPublicationView,
  classifyDecisionRetention,
  serializeBoundedDecisionAlternatives,
} from "./publication-decisions";

export function buildYieldStorageRows(input: {
  evaluatedSources: EvaluatedYieldSource[];
  anchorOnlySources?: ResolvedYieldEntry[];
  publicationViews: Map<string, YieldCoinPublicationView>;
  startSec: number;
  generationId: string;
}) {
  const yieldDataRows: Array<Record<string, unknown>> = [];
  const historyRows: Array<Record<string, unknown>> = [];
  const decisionRows: Array<Record<string, unknown>> = [];
  const decisionAlternativeRows: Array<Record<string, unknown>> = [];

  // Seeds share the publication's existing atomic CAS fence but are not current
  // yield rows, selected sources, decision evidence or measured coverage.
  for (const entry of input.anchorOnlySources ?? []) {
    const seed = entry.yield;
    if (seed?.observationKind !== "anchor-only") continue;
    historyRows.push({
      stablecoin_id: entry.id,
      source_key: seed.sourceKey,
      observation_kind: "anchor-only",
      recorded_at: input.startSec,
      source_observed_at: seed.sourceObservedAt ?? null,
      is_best: 0,
      apy: 0,
      apy_base: null,
      apy_reward: null,
      exchange_rate: seed.exchangeRate,
      source_tvl_usd: seed.sourceTvlUsd,
      data_source: seed.dataSource,
      warning_signals: null,
      yield_source: seed.yieldSource ?? null,
      yield_type: seed.yieldType ?? null,
      publication_generation_id: input.generationId,
      publication_state: "published",
      pys_at_publish: null,
      safety_at_publish: null,
      variance_at_publish: null,
      pys_inputs_at_publish: null,
    });
  }

  for (const source of input.evaluatedSources) {
    // The publication views are the sole owner of the selection decision; the
    // is-best flag must agree with the frozen view, not a re-read map.
    const view = input.publicationViews.get(source.id);
    const isBest = view != null && view.selected.sourceKey === source.sourceKey ? 1 : 0;
    const warningSignals = [...source.warnings];
    const warningSignalsJson = warningSignals.length > 0 ? JSON.stringify(warningSignals) : null;
    const safeVariance30d = source.stdDev30d != null && Number.isFinite(source.stdDev30d) ? source.stdDev30d : null;
    const safeStability =
      source.yieldStability != null && Number.isFinite(source.yieldStability) ? source.yieldStability : null;
    const safePharosYieldScore =
      source.pharosYieldScore != null && Number.isFinite(source.pharosYieldScore) ? source.pharosYieldScore : null;
    const safetySnapshotUnavailable = source.safetyProvenance === "safety-snapshot-unavailable";
    const safeSafetyScore =
      !safetySnapshotUnavailable && source.safetyScore != null && Number.isFinite(source.safetyScore)
        ? source.safetyScore
        : null;

    yieldDataRows.push({
      stablecoin_id: source.id,
      source_key: source.sourceKey,
      symbol: source.symbol,
      current_apy: source.currentApy,
      apy_base: source.apyBase,
      apy_reward: source.apyReward,
      apy_7d: source.apy7d,
      apy_30d: source.apy30d,
      yield_source: source.yieldSource,
      yield_type: source.yieldType,
      source_pool: source.sourcePool,
      source_tvl_usd: source.sourceTvlUsd,
      data_source: source.dataSource,
      safety_score: safeSafetyScore,
      safety_grade: source.safetyGrade,
      pharos_yield_score: safePharosYieldScore,
      yield_to_risk: source.yieldToRisk,
      excess_yield: source.excessYield,
      yield_stability: safeStability,
      apy_variance_30d: safeVariance30d,
      apy_min_30d: source.apyMin30d,
      apy_max_30d: source.apyMax30d,
      exchange_rate: source.exchangeRate,
      exchange_rate_prev: source.prevExchangeRate,
      warning_signals: warningSignalsJson,
      is_best: isBest,
      updated_at: input.startSec,
      publication_generation_id: input.generationId,
      publication_state: "published",
    });

    historyRows.push({
      stablecoin_id: source.id,
      source_key: source.sourceKey,
      recorded_at: getYieldHistorySampleAt(source.sourceKey, source.sourceObservedAt, input.startSec),
      source_observed_at: source.sourceObservedAt,
      is_best: isBest,
      apy: source.currentApy,
      apy_base: source.apyBase,
      apy_reward: source.apyReward,
      exchange_rate: source.exchangeRate,
      source_tvl_usd: source.sourceTvlUsd,
      data_source: source.dataSource,
      warning_signals: warningSignalsJson,
      yield_source: source.yieldSource,
      yield_type: source.yieldType,
      publication_generation_id: input.generationId,
      publication_state: "published",
      pys_at_publish: safePharosYieldScore,
      safety_at_publish: safeSafetyScore,
      variance_at_publish: safeVariance30d,
      pys_inputs_at_publish: safetySnapshotUnavailable
        ? null
        : JSON.stringify({
            schemaVersion: YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION,
            methodologyVersion: YIELD_METHODOLOGY_VERSION,
            apy30d: source.apy30d,
            safetyScore: source.safetyScore,
            varianceScore: source.apyVarianceScore,
            benchmarkRate: source.benchmarkRate,
            sourceRiskPenalty: source.sourceRiskPenalty,
            scalingFactor: PYS_SCALING_FACTOR,
            scoreQualification: source.scoreQualification,
            benchmarkKey: source.benchmarkKey,
            evidenceClass: source.evidenceClass,
            // The v8.43 hurdle re-base is unrecoverable from the rest of the
            // snapshot: the governing USD rate lives only in the payload's
            // `riskFreeRate`, so a replay without it drifts on every non-USD row.
            ...(source.usdBenchmarkRate != null && Number.isFinite(source.usdBenchmarkRate)
              ? { usdBenchmarkRate: source.usdBenchmarkRate }
              : {}),
            ...(Number.isFinite(source.hurdleRebase) ? { hurdleRebase: source.hurdleRebase } : {}),
          }),
    });

    if (view != null && isBest === 1) {
      const retention = classifyDecisionRetention({
        sourceSwitch: view.sourceSwitch,
        source,
        candidates: view.candidates,
      });
      decisionRows.push({
        generation_id: input.generationId,
        stablecoin_id: source.id,
        selected_source_key: source.sourceKey,
        selected_confidence_tier: source.confidenceTier,
        selected_data_source: source.dataSource,
        selected_apy_30d: source.apy30d,
        selected_score: source.pharosYieldScore,
        selected_reason: view.selectedReason,
        previous_best_source_key: view.previousBestSourceKey,
        source_switch: view.sourceSwitch ? 1 : 0,
        rejected_count: view.rejectedCount,
        alternatives_json: serializeBoundedDecisionAlternatives(source, view.candidates),
        created_at: input.startSec,
        retention_reason: retention.retentionReason,
        trend_fingerprint: retention.trendFingerprint,
      });

      for (const alternative of view.decisionLedger.alternatives) {
        decisionAlternativeRows.push({
          generation_id: input.generationId,
          stablecoin_id: source.id,
          alt_source_key: alternative.sourceKey,
          alt_yield_source: alternative.yieldSource,
          alt_apy30d_delta: Number.isFinite(alternative.apy30dDelta) ? alternative.apy30dDelta : null,
          rejection_reason_code: alternative.rejectionReasonCode,
          recorded_at: input.startSec,
        });
      }
    }
  }

  return { yieldDataRows, historyRows, decisionRows, decisionAlternativeRows };
}
