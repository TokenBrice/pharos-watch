import {
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "@shared/lib/redemption-backstop-confidence";
import type {
  RedemptionBackstopConfig,
  RedemptionCostModel,
} from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { ReserveSnapshotMetadataRecord } from "./live-reserves-store";
import { readRedemptionBackstopLiveMetadata } from "./redemption-backstop-live-metadata";
import { resolveRedemptionDocs } from "./redemption-backstop-docs";

export interface ResolvedRedemptionCost {
  score: number;
  feeBps: number | null;
  feeDescription?: string;
  feeConfidence: RedemptionBackstopEntry["feeConfidence"];
  feeModelKind: RedemptionBackstopEntry["feeModelKind"];
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
  docs?: RedemptionBackstopEntry["docs"];
  queueEnabled: boolean;
  notes: string[];
}

export function resolveBoundedFeeScore(feeBps: number): number {
  if (feeBps <= 10) return 100;
  if (feeBps <= 50) return 80;
  if (feeBps <= 100) return 60;
  return 40;
}

function resolveRedemptionCost(
  stablecoinId: string,
  costModel: RedemptionCostModel,
  reserveSnapshotMetadata?: ReserveSnapshotMetadataRecord | null,
  now = Math.floor(Date.now() / 1000),
): ResolvedRedemptionCost {
  const feeConfidence = resolveFeeConfidence(costModel);
  const feeModelKind = resolveFeeModelKind(costModel);
  const liveMetadata = readRedemptionBackstopLiveMetadata(stablecoinId, reserveSnapshotMetadata, now);

  if (
    liveMetadata.canUseFee
    && liveMetadata.redemptionFeeBps != null
    && costModel.kind === "dynamic-or-unclear"
    && feeConfidence === "formula"
  ) {
    const feeBps = Math.max(0, Math.round(liveMetadata.redemptionFeeBps));
    return {
      score: resolveBoundedFeeScore(feeBps),
      feeBps,
      feeConfidence,
      feeModelKind,
      ...(costModel.feeDescription ? { feeDescription: costModel.feeDescription } : {}),
      notes: [],
    };
  }

  if (liveMetadata.canUseFee && liveMetadata.redemptionFeeBps != null && costModel.kind === "fee-bps") {
    const feeBps = Math.max(0, Math.round(liveMetadata.redemptionFeeBps));
    return {
      score: resolveBoundedFeeScore(feeBps),
      feeBps,
      feeConfidence,
      feeModelKind,
      ...(costModel.feeDescription ? { feeDescription: costModel.feeDescription } : {}),
      notes:
        feeBps !== Math.max(0, costModel.feeBps)
          ? ["Using fresh live redemption fee telemetry in place of the reviewed fallback bound"]
          : [],
    };
  }

  if (costModel.kind === "dynamic-or-unclear") {
    const score = costModel.feeDescription && costModel.confidence !== "undisclosed-reviewed" ? 60 : 40;
    return {
      score,
      feeBps: null,
      feeConfidence,
      feeModelKind,
      ...(costModel.feeDescription ? { feeDescription: costModel.feeDescription } : {}),
      notes:
        feeConfidence === "formula" && liveMetadata.updatedAt != null && liveMetadata.feeReason
          ? [liveMetadata.feeReason]
          : [],
    };
  }

  const feeBps = Math.max(0, costModel.feeBps);
  return {
    score: resolveBoundedFeeScore(feeBps),
    feeBps,
    feeConfidence,
    feeModelKind,
    ...(costModel.feeDescription ? { feeDescription: costModel.feeDescription } : {}),
    notes: [],
  };
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
): RedemptionStaticFields {
  const {
    score: costScore,
    feeBps,
    feeDescription,
    feeConfidence,
    feeModelKind,
    notes,
  } = resolveRedemptionCost(stablecoinId, config.costModel, reserveSnapshotMetadata, now);

  return {
    ...scores,
    costScore,
    feeBps,
    feeDescription,
    feeConfidence,
    feeModelKind,
    docs: resolveRedemptionDocs(stablecoinId, config),
    queueEnabled: config.routeFamily === "queue-redeem" || config.settlementModel === "queued",
    notes,
  };
}
