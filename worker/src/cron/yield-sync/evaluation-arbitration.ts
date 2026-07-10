import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { YieldType } from "@shared/types/core";
import type { YieldCalculationMode, YieldEvidenceClass } from "@shared/types/yield";
import { LENDING_PROTOCOL_LABELS } from "../yield-config";
import type { ConfidenceTier, EvaluatedYieldSource } from "./evaluation-types";
import type { ResolvedYield } from "./types";

export type { ConfidenceTier } from "./evaluation-types";

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
}): YieldType {
  const meta = TRACKED_META_BY_ID.get(params.id);
  const yieldConfig = meta?.yieldConfig;
  return (
    params.explicitType ??
    (params.dataSource === "defillama-auto"
      ? "lending-opportunity"
      : (yieldConfig?.yieldType ?? "nav-appreciation"))
  );
}

export function getConfidenceTier(dataSource: string): ConfidenceTier {
  switch (dataSource) {
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

export function getEvidencePriority(evidenceClass: YieldEvidenceClass): number {
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

  return (b.sourceTvlUsd ?? 0) - (a.sourceTvlUsd ?? 0);
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
