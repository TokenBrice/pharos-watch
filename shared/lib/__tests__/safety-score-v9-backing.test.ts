import { describe, expect, it } from "vitest";
import {
  assertV9BackingPolicy,
  evaluateV9ReserveExposures,
  type V9BackingAssetInput,
} from "../safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "../../types/safety-score-v9-facts";

const knownStatus = (evidenceId: string): V9FactStatusV2 => ({
  applicability: { state: "required", policyRuleId: "backing.required", rationale: null, gapId: null },
  observationState: "known",
  evidenceRefIds: [evidenceId],
  gapIds: [],
});

function exposure(args: {
  key: string;
  weight: number;
  assetClass?: V9ReserveExposureFactV2["assetClass"];
  trackedAssetId?: string | null;
  issuer?: string | null;
  custodian?: string;
  provenance?: V9ReserveExposureFactV2["provenance"];
}): V9ReserveExposureFactV2 {
  return {
    exposureKey: args.key,
    classificationKey: `class:${args.key}`,
    sourceGenerationId: "reserves:test",
    provenance: args.provenance ?? "curated",
    status: knownStatus(`evidence:${args.key}`),
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

function asset(reserveExposures: readonly V9ReserveExposureFactV2[]): V9BackingAssetInput {
  return {
    assetId: "asset",
    reserveStatus: knownStatus("evidence:reserve-envelope"),
    reserveExposures,
    gaps: [],
    resolvedUpstreamExposures: [],
  };
}

describe("Safety Score v9 backing exposure primitives", () => {
  it("validates the explicit candidate policy", () => {
    expect(() => assertV9BackingPolicy(V9_CANDIDATE_POLICY_V1)).not.toThrow();
    expect(V9_CANDIDATE_POLICY_V1.semanticDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("weights an ordinary weak slice proportionally without making it a global minimum", () => {
    const strong = evaluateV9ReserveExposures(
      asset([exposure({ key: "cash", weight: 0.99 }), exposure({ key: "small", weight: 0.01 })]),
      V9_CANDIDATE_POLICY_V1,
    );
    const weak = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash", weight: 0.99 }),
        exposure({ key: "small", weight: 0.01, assetClass: "private-credit" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(strong.score).not.toBeNull();
    expect(weak.score).not.toBeNull();
    expect(strong.score! - weak.score!).toBeGreaterThan(0);
    expect(strong.score! - weak.score!).toBeLessThan(2);
    expect(weak.structuralReasons).toEqual([]);
  });

  it("emits a structural ceiling for material speculative credit", () => {
    const result = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash", weight: 0.8 }),
        exposure({ key: "credit", weight: 0.2, assetClass: "private-credit", issuer: "borrower" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.structuralReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "speculative-credit", severity: "high", ceiling: 59, materialShare: 0.2 }),
      ]),
    );
  });

  it("uses the injected upstream result as an exposure-bounded loss", () => {
    const input = asset([
      exposure({ key: "cash", weight: 0.8 }),
      exposure({ key: "upstream", weight: 0.2, assetClass: "stablecoin", trackedAssetId: "parent" }),
    ]);
    const strong = evaluateV9ReserveExposures(
      {
        ...input,
        resolvedUpstreamExposures: [
          {
            exposureKey: "upstream",
            upstreamAssetId: "parent",
            score: 90,
            evidenceLevel: "strong",
            reasonCodes: [],
            failureDomains: [{ kind: "reserve-issuer", key: "parent" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const weak = evaluateV9ReserveExposures(
      {
        ...input,
        resolvedUpstreamExposures: [
          {
            exposureKey: "upstream",
            upstreamAssetId: "parent",
            score: 20,
            evidenceLevel: "limited",
            reasonCodes: ["material-dependency-unavailable"],
            failureDomains: [{ kind: "reserve-issuer", key: "parent" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(strong.score! - weak.score!).toBeGreaterThan(8);
    expect(weak.unresolved).toContainEqual(
      expect.objectContaining({
        code: "material-dependency-unavailable",
        pathKey: "reserve:upstream",
      }),
    );
  });

  it("is order invariant while retaining provenance in the trace", () => {
    const left = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "b", weight: 0.5, provenance: "live" }),
        exposure({ key: "a", weight: 0.5, provenance: "curated" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );
    const right = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "a", weight: 0.5, provenance: "curated" }),
        exposure({ key: "b", weight: 0.5, provenance: "live" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(right).toEqual(left);
    expect(left.contributions.find((entry) => entry.componentKey === "reserve:b")?.provenance).toBe("live");
  });

  it("does not consume an authored legacy reserve risk field", () => {
    const base = exposure({ key: "cash", weight: 1 });
    const low = { ...base, risk: "very-low" } as unknown as V9ReserveExposureFactV2;
    const high = { ...base, risk: "very-high" } as unknown as V9ReserveExposureFactV2;

    expect(evaluateV9ReserveExposures(asset([low]), V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluateV9ReserveExposures(asset([high]), V9_CANDIDATE_POLICY_V1),
    );
  });

  it("identifies a reviewed common-mode concentration across separate exposures", () => {
    const result = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "a", weight: 0.2, custodian: "shared" }),
        exposure({ key: "b", weight: 0.2, custodian: "shared" }),
        exposure({ key: "c", weight: 0.3 }),
        exposure({ key: "d", weight: 0.3 }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.structuralReasons).toContainEqual(
      expect.objectContaining({
        kind: "unsafe-backing",
        severity: "moderate",
        materialShare: 0.4,
      }),
    );
  });
});
