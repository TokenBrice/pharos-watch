import type { StablecoinFlags, YieldConfig, YieldType } from "../types/core";
import type { YieldSourceRisk } from "../types/yield";

export type ReportCardYieldRiskNoOpReason =
  | "not-yield-bearing"
  | "external-lending-opportunity"
  | "external-structured-tranche"
  | "missing-yield-config"
  | "missing-source-risk"
  | "source-risk-unconsumed";

export interface ReportCardYieldRiskAdjustment {
  appliesToBaseScore: false;
  scoreModifier: null;
  resilienceCap: null;
  dependencyRiskCap: null;
  reason: ReportCardYieldRiskNoOpReason;
}

export interface ResolveReportCardYieldRiskAdjustmentInput {
  flags: Pick<StablecoinFlags, "yieldBearing" | "navToken">;
  yieldConfig?: Pick<YieldConfig, "yieldType"> | null;
  yieldType?: YieldType | null;
  sourceRisk?: YieldSourceRisk | null;
}

function noOp(reason: ReportCardYieldRiskNoOpReason): ReportCardYieldRiskAdjustment {
  return {
    appliesToBaseScore: false,
    scoreModifier: null,
    resilienceCap: null,
    dependencyRiskCap: null,
    reason,
  };
}

function resolveYieldType(input: ResolveReportCardYieldRiskAdjustmentInput): YieldType | null {
  return input.yieldType ?? input.yieldConfig?.yieldType ?? null;
}

export function resolveReportCardYieldRiskAdjustment(
  input: ResolveReportCardYieldRiskAdjustmentInput,
): ReportCardYieldRiskAdjustment {
  const yieldType = resolveYieldType(input);

  if (yieldType === "lending-opportunity") {
    return noOp("external-lending-opportunity");
  }
  if (yieldType === "structured-tranche") {
    return noOp("external-structured-tranche");
  }

  if (!input.flags.yieldBearing && !input.flags.navToken) {
    return noOp("not-yield-bearing");
  }

  if (yieldType == null) {
    return noOp("missing-yield-config");
  }

  if (input.sourceRisk == null) {
    return noOp("missing-source-risk");
  }

  // Source-risk payloads are normalized here before they can affect Safety
  // Score. Until the report-card methodology defines sourced caps/haircuts,
  // native holder-yield, wrapper, and NAV cases are explicit no-ops.
  return noOp("source-risk-unconsumed");
}
