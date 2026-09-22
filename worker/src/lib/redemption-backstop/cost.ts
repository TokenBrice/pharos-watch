import { resolveFeeConfidence, resolveFeeModelKind } from "@shared/lib/redemption-backstop-confidence";
import { resolveRedemptionCostBpsAtNotional } from "@shared/lib/redemption-backstop-configs/shared";
import type { RedemptionBackstopConfig, RedemptionCostModel } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves/store";
import {
  readRedemptionBackstopLiveMetadata,
  type RedemptionBackstopLiveMetadata,
} from "./live-metadata";
import { resolveRedemptionDocs } from "@shared/lib/redemption-backstop-docs";

export interface ResolvedRedemptionCost {
  score: number;
  feeBps: number | null;
  feeDescription?: string;
  feeConfidence: RedemptionBackstopEntry["feeConfidence"];
  feeModelKind: RedemptionBackstopEntry["feeModelKind"];
  costScenarioScores?: RedemptionBackstopEntry["costScenarioScores"];
  notes: string[];
}

export interface RedemptionStaticFields {
  accessScore: number;
  settlementScore: number;
  executionCertaintyScore: number;
  outputAssetQualityScore: number;
  costScore: number;
  feeBps: number | null;
  feeDescription?: string;
  feeConfidence: RedemptionBackstopEntry["feeConfidence"];
  feeModelKind: RedemptionBackstopEntry["feeModelKind"];
  costScenarioScores?: RedemptionBackstopEntry["costScenarioScores"];
  docs?: RedemptionBackstopEntry["docs"];
  queueEnabled: boolean;
  notes: string[];
}

const REDEMPTION_FEE_SCORE_BREAKPOINTS = [
  { maxFeeBps: 10, score: 100 },
  { maxFeeBps: 50, score: 80 },
  { maxFeeBps: 100, score: 60 },
] as const;

const REDEMPTION_FEE_SCORE_HIGH_FEE_FALLBACK = 40;
const COST_SCENARIO_SIZES_USD = {
  retail: 1_000,
  activeUser: 10_000,
  institutional: 1_000_000,
} as const;

export function resolveBoundedFeeScore(feeBps: number): number {
  for (const { maxFeeBps, score } of REDEMPTION_FEE_SCORE_BREAKPOINTS) {
    if (feeBps <= maxFeeBps) return score;
  }
  return REDEMPTION_FEE_SCORE_HIGH_FEE_FALLBACK;
}


export function resolveCostScenarioScores(
  costModel: RedemptionCostModel,
  fallbackFeeBps: number | null,
): NonNullable<RedemptionBackstopEntry["costScenarioScores"]> | undefined {
  const costs = {
    retail: resolveRedemptionCostBpsAtNotional(costModel, COST_SCENARIO_SIZES_USD.retail, fallbackFeeBps),
    activeUser: resolveRedemptionCostBpsAtNotional(costModel, COST_SCENARIO_SIZES_USD.activeUser, fallbackFeeBps),
    institutional: resolveRedemptionCostBpsAtNotional(
      costModel,
      COST_SCENARIO_SIZES_USD.institutional,
      fallbackFeeBps,
    ),
  };
  if (Object.values(costs).every((costBps) => costBps == null)) return undefined;
  return {
    retail: costs.retail == null ? null : resolveBoundedFeeScore(costs.retail),
    activeUser: costs.activeUser == null ? null : resolveBoundedFeeScore(costs.activeUser),
    institutional: costs.institutional == null ? null : resolveBoundedFeeScore(costs.institutional),
  };
}


function resolveRedemptionCost(
  stablecoinId: string,
  costModel: RedemptionCostModel,
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
  now = Math.floor(Date.now() / 1000),
  liveMetadata?: RedemptionBackstopLiveMetadata,
): ResolvedRedemptionCost {
  const feeConfidence = resolveFeeConfidence(costModel);
  const feeModelKind = resolveFeeModelKind(costModel);
  const buildCost = (fields: {
    score: number;
    feeBps: number | null;
    costScenarioScores: ResolvedRedemptionCost["costScenarioScores"];
    notes: string[];
    feeDescription?: string;
  }): ResolvedRedemptionCost => ({
    score: fields.score,
    feeBps: fields.feeBps,
    feeConfidence,
    feeModelKind,
    costScenarioScores: fields.costScenarioScores,
    ...(fields.feeDescription ?? costModel.feeDescription
      ? { feeDescription: fields.feeDescription ?? costModel.feeDescription }
      : {}),
    notes: fields.notes,
  });
  const resolvedLiveMetadata =
    liveMetadata ?? readRedemptionBackstopLiveMetadata(stablecoinId, reserveSnapshotMetadata, now);

  if (
    resolvedLiveMetadata.canUseFee &&
    resolvedLiveMetadata.redemptionFeeBps != null &&
    costModel.kind === "dynamic-or-unclear" &&
    feeConfidence === "formula"
  ) {
    const feeBps = Math.max(0, Math.round(resolvedLiveMetadata.redemptionFeeBps));
    return buildCost({
      score: resolveBoundedFeeScore(feeBps),
      feeBps,
      costScenarioScores: resolveCostScenarioScores(costModel, feeBps),
      feeDescription: `Fresh live redemption fee telemetry: ${feeBps} bps.`,
      notes: [],
    });
  }

  if (resolvedLiveMetadata.canUseFee && resolvedLiveMetadata.redemptionFeeBps != null && costModel.kind === "fee-bps") {
    const feeBps = Math.max(0, Math.round(resolvedLiveMetadata.redemptionFeeBps));
    return buildCost({
      score: resolveBoundedFeeScore(feeBps),
      feeBps,
      costScenarioScores: resolveCostScenarioScores(costModel, feeBps),
      feeDescription: `Fresh live redemption fee telemetry: ${feeBps} bps.`,
      notes:
        feeBps !== Math.max(0, costModel.feeBps)
          ? ["Using fresh live redemption fee telemetry in place of the reviewed fallback bound"]
          : [],
    });
  }

  if (costModel.kind === "dynamic-or-unclear") {
    const scenarioScores = resolveCostScenarioScores(costModel, null);
    const score =
      scenarioScores?.activeUser ??
      (costModel.feeDescription && costModel.confidence !== "undisclosed-reviewed" ? 60 : 40);
    return buildCost({
      score,
      feeBps: null,
      costScenarioScores: scenarioScores,
      notes:
        feeConfidence === "formula" && resolvedLiveMetadata.updatedAt != null && resolvedLiveMetadata.feeReason
          ? [resolvedLiveMetadata.feeReason]
          : [],
    });
  }

  const feeBps = Math.max(0, costModel.feeBps);
  const costScenarioScores = resolveCostScenarioScores(costModel, feeBps);
  return buildCost({
    score: costScenarioScores?.activeUser ?? resolveBoundedFeeScore(feeBps),
    feeBps,
    costScenarioScores,
    notes: [],
  });
}

export function resolveRedemptionStaticFields(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  scores: {
    accessScore: number;
    settlementScore: number;
    executionCertaintyScore: number;
    outputAssetQualityScore: number;
  },
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
  now = Math.floor(Date.now() / 1000),
  liveMetadata?: RedemptionBackstopLiveMetadata,
): RedemptionStaticFields {
  const {
    score: costScore,
    feeBps,
    feeDescription,
    feeConfidence,
    feeModelKind,
    costScenarioScores,
    notes,
  } = resolveRedemptionCost(stablecoinId, config.costModel, reserveSnapshotMetadata, now, liveMetadata);

  return {
    ...scores,
    costScore,
    feeBps,
    feeDescription,
    feeConfidence,
    feeModelKind,
    costScenarioScores,
    docs: resolveRedemptionDocs(stablecoinId, config),
    queueEnabled: config.routeFamily === "queue-redeem" || config.settlementModel === "queued",
    notes,
  };
}
