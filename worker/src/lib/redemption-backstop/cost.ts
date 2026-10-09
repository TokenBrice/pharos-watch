import { resolveFeeConfidence, resolveFeeModelKind } from "@shared/lib/redemption-backstop-confidence";
import { resolveRedemptionCostBpsAtNotional, resolveRedemptionPercentageFeeBps } from "@shared/lib/redemption-backstop-configs/shared";
import type { RedemptionBackstopConfig, RedemptionCostModel } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves/store";
import {
  readRedemptionBackstopLiveMetadata,
  type RedemptionBackstopLiveMetadata,
} from "./live-metadata";
import { resolveRedemptionDocs } from "@shared/lib/redemption-backstop-docs";
import { resolveRedemptionFiatUsdRate, type RedemptionFiatReferenceContext } from "@shared/lib/redemption-fiat-reference";

export interface ResolvedRedemptionCost {
  selectedLiveFee?: boolean;
  score: number;
  feeBps: number | null;
  feeDescription?: string;
  feeConfidence: RedemptionBackstopEntry["feeConfidence"];
  feeModelKind: RedemptionBackstopEntry["feeModelKind"];
  costScenarioScores?: RedemptionBackstopEntry["costScenarioScores"];
  notes: string[];
}

export interface RedemptionStaticFields {
  selectedLiveFee?: boolean;
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
  fiatReferences?: RedemptionFiatReferenceContext,
): NonNullable<RedemptionBackstopEntry["costScenarioScores"]> | undefined {
  const costs = {
    retail: resolveRedemptionCostBpsAtNotional(costModel, COST_SCENARIO_SIZES_USD.retail, fallbackFeeBps, fiatReferences),
    activeUser: resolveRedemptionCostBpsAtNotional(costModel, COST_SCENARIO_SIZES_USD.activeUser, fallbackFeeBps, fiatReferences),
    institutional: resolveRedemptionCostBpsAtNotional(
      costModel,
      COST_SCENARIO_SIZES_USD.institutional,
      fallbackFeeBps,
      fiatReferences,
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
  fiatReferences?: RedemptionFiatReferenceContext,
): ResolvedRedemptionCost {
  const feeConfidence = resolveFeeConfidence(costModel);
  const feeModelKind = resolveFeeModelKind(costModel);
  const buildCost = (fields: {
    score: number;
    feeBps: number | null;
    costScenarioScores: ResolvedRedemptionCost["costScenarioScores"];
    notes: string[];
    feeDescription?: string;
    selectedLiveFee?: boolean;
  }): ResolvedRedemptionCost => ({
    score: fields.score,
    selectedLiveFee: fields.selectedLiveFee,
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

  if (costModel.feeComponents) {
    const costScenarioScores = resolveCostScenarioScores(costModel, null, fiatReferences);
    const notes: string[] = [];
    if (!costScenarioScores) {
      if (resolveRedemptionPercentageFeeBps(costModel) === null) {
        notes.push("redemption-cost-percentage-ceiling-absent");
      } else if (costModel.feeComponents.some((component) =>
        resolveRedemptionFiatUsdRate(component.currency, fiatReferences) === null)) {
        notes.push("redemption-cost-fiat-reference-unavailable");
      }
    }
    return buildCost({
      score: costScenarioScores?.activeUser ?? 40,
      // Request-specific components are never a reusable percentage telemetry value.
      feeBps: null,
      costScenarioScores,
      notes,
    });
  }

  if (
    resolvedLiveMetadata.canUseFee &&
    resolvedLiveMetadata.redemptionFeeBps != null &&
    costModel.kind === "dynamic-or-unclear" &&
    feeConfidence === "formula"
  ) {
    const feeBps = Math.max(0, Math.round(resolvedLiveMetadata.redemptionFeeBps));
    return buildCost({
      selectedLiveFee: true,
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
      selectedLiveFee: true,
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
  fiatReferences?: RedemptionFiatReferenceContext,
): RedemptionStaticFields {
  const {
    score: costScore,
    selectedLiveFee,
    feeBps,
    feeDescription,
    feeConfidence,
    feeModelKind,
    costScenarioScores,
    notes,
  } = resolveRedemptionCost(stablecoinId, config.costModel, reserveSnapshotMetadata, now, liveMetadata, fiatReferences);

  return {
    ...scores,
    costScore,
    selectedLiveFee,
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
