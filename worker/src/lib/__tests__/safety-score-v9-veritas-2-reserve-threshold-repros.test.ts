import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
import { describe, expect, it } from "vitest";
import {
  evaluateV9ReserveExposures,
  type V9BackingAssetInput,
  type V9ResolvedUpstreamExposure,
} from "@shared/lib/safety-score-v9/backing";
import { scoreV9Input } from "@shared/lib/safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";

function knownStatus(evidenceId: string): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: "veritas-ii.required", rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds: [evidenceId],
    gapIds: [],
  };
}

function reserveExposure(args: {
  key: string;
  weight: number;
  assetClass: V9ReserveExposureFactV2["assetClass"];
  issuer: string;
  trackedAssetId?: string | null;
}): V9ReserveExposureFactV2 {
  return {
    exposureKey: args.key,
    classificationKey: `class:${args.key}`,
    sourceGenerationId: "reserves:veritas-ii",
    provenance: "live",
    status: knownStatus(`evidence:${args.key}`),
    name: args.key,
    weight: args.weight,
    trackedAssetId: args.trackedAssetId ?? null,
    assetClass: args.assetClass,
    issuerOrObligorKey: args.issuer,
    riskFactors: [],
    liquidityHorizon: "immediate",
    maturityDaysMax: args.assetClass === "cash" ? 0 : null,
    failureDomains: [{ kind: "reserve-issuer", key: args.issuer }],
  };
}

function reserveAsset(
  reserveExposures: readonly V9ReserveExposureFactV2[],
  resolvedUpstreamExposures: readonly V9ResolvedUpstreamExposure[] = [],
): V9BackingAssetInput {
  return {
    assetId: "veritas-ii-credit",
    reserveStatus: knownStatus("evidence:reserve-envelope"),
    reserveExposures,
    gaps: [],
    resolvedUpstreamExposures,
  };
}

function scoreBacking(result: ReturnType<typeof evaluateV9ReserveExposures>) {
  const evidenceLevel = result.unresolved.some((reason) => reason.treatment !== "diagnostic")
    ? ("limited" as const)
    : ("strong" as const);
  return scoreV9Input(
    {
      assetId: "veritas-ii-credit",
      pillars: { backing: result.score, exit: 95, control: 95 },
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel,
      trackRecordMonths: 48,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralSignals: result.structuralReasons.map((reason) => ({
        kind: reason.kind,
        severity: reason.severity,
        reason: `${reason.kind} at ${reason.pathKey}`,
        ...(reason.materialShare === null ? {} : { materialSharePct: reason.materialShare * 100 }),
        failureDomainKeys: reason.failureDomains.map((domain) => `${domain.kind}:${domain.key}`),
        evidence: [],
      })),
      unresolved: result.unresolved.map((reason) => ({
        code: reason.code,
        reason: `${reason.code} at ${reason.pathKey}`,
        critical: false,
      })),
    },
    V9_CANDIDATE_POLICY_V1,
  );
}

describe("VERITAS-II finding named rows evade same-issuer speculative-credit materiality", () => {
  it("keeps a 12% private-credit issuer material after it is split into three 4% rows", () => {
    const direct = evaluateV9ReserveExposures(
      reserveAsset([
        reserveExposure({ key: "cash", weight: 0.88, assetClass: "cash", issuer: "issuer:cash" }),
        reserveExposure({ key: "credit", weight: 0.12, assetClass: "private-credit", issuer: "issuer:borrower" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );
    const split = evaluateV9ReserveExposures(
      reserveAsset([
        reserveExposure({ key: "cash", weight: 0.88, assetClass: "cash", issuer: "issuer:cash" }),
        ...["a", "b", "c"].map((suffix) =>
          reserveExposure({
            key: `credit-${suffix}`,
            weight: 0.04,
            assetClass: "private-credit",
            issuer: "issuer:borrower",
          }),
        ),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(scoreBacking(direct)).toMatchObject({ finalScore: 59, finalGrade: "C" });
    expect(split.score).toBe(direct.score);
    expect(split.structuralReasons).toContainEqual(
      expect.objectContaining({ kind: "speculative-credit", severity: "high", materialShare: 0.12, ceiling: 59 }),
    );
    expect(scoreBacking(split).finalScore).toBeLessThanOrEqual(scoreBacking(direct).finalScore!);
  });
});

describe("VERITAS-II finding exact threshold disagrees on dependency treatment and structural cap", () => {
  it("classifies an exact 10% unavailable upstream consistently across projection and backing", () => {
    const weights = [0.001, 0.009, 0.09];
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeLessThan(0.1);
    const tracked = weights.map((weight, index) =>
      reserveExposure({
        key: `upstream-${index}`,
        weight,
        assetClass: "stablecoin",
        issuer: "issuer:upstream",
        trackedAssetId: "shared-upstream",
      }),
    );
    const result = evaluateV9ReserveExposures(
      reserveAsset(
        [reserveExposure({ key: "cash", weight: 0.9, assetClass: "cash", issuer: "issuer:cash" }), ...tracked],
        tracked.map((exposure) => ({
          exposureKey: exposure.exposureKey,
          upstreamAssetId: "shared-upstream",
          score: null,
          evidenceLevel: "insufficient",
          reasonCodes: ["nonmaterial-dependency-unavailable"],
          failureDomains: [],
        })),
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    const trace = scoreBacking(result);

    expect(result.structuralReasons).toContainEqual(
      expect.objectContaining({ kind: "unsafe-backing", severity: "high", ceiling: 59 }),
    );
    expect(result.unresolved).toContainEqual(
      expect.objectContaining({ code: "material-dependency-unavailable", treatment: "ceiling" }),
    );
    expect(trace.finalScore).toBe(59);
    expect(trace.finalGrade).toBe("C");
    expect(trace.caps).toContainEqual(expect.objectContaining({ source: "evidence", limit: 69 }));
  });
});
