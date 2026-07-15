import { describe, expect, it } from "vitest";
import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
import {
  evaluateV9ReserveExposures,
  type V9BackingAssetInput,
  type V9ResolvedUpstreamExposure,
} from "../safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

function knownStatus(evidenceId: string): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: "veritas.required", rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds: [evidenceId],
    gapIds: [],
  };
}

function exposure(args: {
  key: string;
  weight: number;
  trackedAssetId?: string | null;
  custodian?: string;
}): V9ReserveExposureFactV2 {
  return {
    exposureKey: args.key,
    classificationKey: "class:" + args.key,
    sourceGenerationId: "reserves:veritas",
    provenance: "curated",
    status: knownStatus("evidence:" + args.key),
    name: args.key,
    weight: args.weight,
    trackedAssetId: args.trackedAssetId ?? null,
    assetClass: args.trackedAssetId ? "stablecoin" : "cash",
    issuerOrObligorKey: null,
    riskFactors: [],
    liquidityHorizon: "immediate",
    maturityDaysMax: null,
    failureDomains: [{ kind: "reserve-custodian", key: args.custodian ?? "custodian:" + args.key }],
  };
}

function asset(
  reserveExposures: readonly V9ReserveExposureFactV2[],
  resolvedUpstreamExposures: readonly V9ResolvedUpstreamExposure[],
): V9BackingAssetInput {
  return {
    assetId: "veritas-dependency-child",
    reserveStatus: knownStatus("evidence:reserve-envelope"),
    reserveExposures,
    gaps: [],
    resolvedUpstreamExposures,
  };
}

function unavailable(
  exposureKey: string,
  code: "material-dependency-unavailable" | "nonmaterial-dependency-unavailable",
): V9ResolvedUpstreamExposure {
  return {
    exposureKey,
    upstreamAssetId: "upstream",
    score: null,
    evidenceLevel: "insufficient",
    reasonCodes: [code],
    failureDomains: [],
  };
}

// VER-003: the evaluator declares this reason diagnostic, but backing rewrites
// it to pillar treatment and the production projection applies a global cap.
describe.skip("VERITAS finding VER-003: nonmaterial dependency diagnostic becomes a pillar penalty", () => {
  it("preserves diagnostic treatment for a 1% unavailable upstream", () => {
    const result = evaluateV9ReserveExposures(
      asset(
        [
          exposure({ key: "cash", weight: 0.99 }),
          exposure({ key: "upstream", weight: 0.01, trackedAssetId: "upstream" }),
        ],
        [unavailable("upstream", "nonmaterial-dependency-unavailable")],
      ),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.unresolved).toContainEqual(
      expect.objectContaining({
        code: "nonmaterial-dependency-unavailable",
        treatment: "diagnostic",
      }),
    );
  });
});

// VER-004: materiality is assessed per reserve row instead of by the aggregate
// exposure to one upstream, so row splitting removes a structural ceiling.
describe.skip("VERITAS finding VER-004: split rows evade aggregate dependency materiality", () => {
  it("keeps a 12% unavailable upstream material when represented by two 6% rows", () => {
    const single = evaluateV9ReserveExposures(
      asset(
        [
          exposure({ key: "cash", weight: 0.88 }),
          exposure({ key: "upstream", weight: 0.12, trackedAssetId: "upstream", custodian: "upstream" }),
        ],
        [unavailable("upstream", "material-dependency-unavailable")],
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    const split = evaluateV9ReserveExposures(
      asset(
        [
          exposure({ key: "cash", weight: 0.88 }),
          exposure({ key: "upstream-a", weight: 0.06, trackedAssetId: "upstream", custodian: "upstream" }),
          exposure({ key: "upstream-b", weight: 0.06, trackedAssetId: "upstream", custodian: "upstream" }),
        ],
        [
          unavailable("upstream-a", "nonmaterial-dependency-unavailable"),
          unavailable("upstream-b", "nonmaterial-dependency-unavailable"),
        ],
      ),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(single.structuralReasons).toContainEqual(
      expect.objectContaining({ kind: "unsafe-backing", severity: "high", ceiling: 59 }),
    );
    expect(split.structuralReasons).toContainEqual(
      expect.objectContaining({ kind: "unsafe-backing", severity: "high", ceiling: 59 }),
    );
  });
});
