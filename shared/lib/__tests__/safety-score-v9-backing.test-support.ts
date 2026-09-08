import type { V9FactGapV2, V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
import type { V9BackingAssetInput, V9MechanismFactV1 } from "@shared/lib/safety-score-v9/backing";

export const knownStatus = (evidenceId: string, policyRuleId = "backing.required"): V9FactStatusV2 => ({
  applicability: { state: "required", policyRuleId, rationale: null, gapId: null },
  observationState: "known",
  evidenceRefIds: [evidenceId],
  gapIds: [],
});

export function exposure(args: {
  key: string;
  weight: number;
  assetClass?: V9ReserveExposureFactV2["assetClass"];
  trackedAssetId?: string | null;
  issuer?: string | null;
  custodian?: string;
  provenance?: V9ReserveExposureFactV2["provenance"];
  policyRuleId?: string;
}): V9ReserveExposureFactV2 {
  return {
    exposureKey: args.key,
    classificationKey: `class:${args.key}`,
    sourceGenerationId: "reserves:test",
    provenance: args.provenance ?? "curated",
    ...((args.provenance ?? "curated") === "live" ? {} : { evidenceClass: "independent" as const }),
    status: knownStatus(`evidence:${args.key}`, args.policyRuleId),
    name: args.key,
    weight: args.weight,
    trackedAssetId: args.trackedAssetId ?? null,
    assetClass: args.assetClass ?? "cash",
    issuerOrObligorKey: args.issuer ?? null,
    riskFactors: [],
    liquidityHorizon: "immediate",
    maturityDaysMax: null,
    failureDomains: [
      { kind: "reserve-custodian", key: args.custodian ?? `custodian:${args.key}` },
      ...(args.issuer ? [{ kind: "reserve-issuer" as const, key: args.issuer }] : []),
    ],
  };
}

export function asset(
  reserveExposures: readonly V9ReserveExposureFactV2[],
  gaps: readonly V9FactGapV2[] = [],
  reserveStatus = knownStatus("evidence:reserve-envelope"),
): V9BackingAssetInput {
  return { assetId: "asset", reserveStatus, reserveExposures, gaps, resolvedUpstreamExposures: [] };
}

export function missingMechanism(componentKey: string, gapId: string, policyRuleId: string, message: string): {
  gap: V9FactGapV2;
  fact: V9MechanismFactV1;
} {
  return {
    gap: {
      gapId, reasonCode: "critical-unresolved", ownerDomain: "backing", policyRuleId,
      observationState: "missing", path: { kind: "local-component", componentKey }, message, evidenceRefIds: [],
    },
    fact: {
      status: {
        applicability: { state: "required", policyRuleId, rationale: null, gapId: null },
        observationState: "missing", evidenceRefIds: [], gapIds: [gapId],
      },
      quality: null, failureDomains: [],
    },
  };
}
