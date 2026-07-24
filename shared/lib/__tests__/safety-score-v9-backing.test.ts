import { describe, expect, it } from "vitest";
import {
  assertV9BackingPolicy,
  createUnavailableV9BackingResult,
  evaluateV9ArchetypeBacking,
  evaluateV9ReserveExposures,
  type V9BackingAssetInput,
} from "../safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type {
  V9AssetFactsV2,
  V9FactGapV2,
  V9FactStatusV2,
  V9ReserveExposureFactV2,
} from "../../types/safety-score-v9-facts";

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
    ...((args.provenance ?? "curated") === "live" ? {} : { evidenceClass: "independent" as const }),
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

function asset(
  reserveExposures: readonly V9ReserveExposureFactV2[],
  gaps: readonly V9FactGapV2[] = [],
): V9BackingAssetInput {
  return {
    assetId: "asset",
    reserveStatus: knownStatus("evidence:reserve-envelope"),
    reserveExposures,
    gaps,
    resolvedUpstreamExposures: [],
  };
}

function unavailableReview(
  gap: V9FactGapV2,
  archetype: V9AssetFactsV2["archetype"] = "fiat-cash",
): Pick<V9AssetFactsV2, "archetype" | "mechanismRiskReview"> {
  return {
    archetype,
    mechanismRiskReview: {
      status: {
        applicability: {
          state: "required",
          policyRuleId: "v9.backing.mechanism-review",
          rationale: null,
          gapId: null,
        },
        observationState: "missing",
        evidenceRefIds: [],
        gapIds: [gap.gapId],
      },
      review: null,
    },
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
        expect.objectContaining({
          kind: "speculative-credit",
          severity: "high",
          responsibility: "measured-adverse",
          ceiling: 59,
          materialShare: 0.2,
        }),
      ]),
    );
  });

  it("does not label the same bounded-unknown reserve classification as measured adverse", () => {
    const unknownCredit = exposure({
      key: "credit",
      weight: 0.2,
      assetClass: "private-credit",
      issuer: "borrower",
    });
    unknownCredit.status = {
      ...unknownCredit.status,
      observationState: "bounded-unknown",
      evidenceRefIds: [],
    };
    const result = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash", weight: 0.8 }),
        unknownCredit,
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.structuralReasons).toContainEqual(
      expect.objectContaining({
        kind: "speculative-credit",
        responsibility: "integration-missing",
      }),
    );
    expect(result.structuralReasons.some((reason) => reason.responsibility === "measured-adverse")).toBe(false);
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
            reasonCodes: ["missing-reserve-composition"],
            failureDomains: [{ kind: "reserve-issuer", key: "parent" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(strong.score! - weak.score!).toBeGreaterThan(8);
    expect(weak.unresolved).toContainEqual(
      expect.objectContaining({
        code: "bounded-unknown-reserve-exposure",
        pathKey: "reserve:upstream",
        treatment: "pillar",
      }),
    );
    expect(weak.unresolved).not.toContainEqual(
      expect.objectContaining({ code: "missing-reserve-composition" }),
    );
  });

  it("does not promote a rateable minority upstream ceiling to the whole basket child", () => {
    const result = evaluateV9ReserveExposures(
      {
        ...asset([
          exposure({ key: "cash", weight: 0.86 }),
          exposure({
            key: "buidl-like",
            weight: 0.14,
            assetClass: "stablecoin",
            trackedAssetId: "buidl-like",
          }),
        ]),
        resolvedUpstreamExposures: [
          {
            exposureKey: "buidl-like",
            upstreamAssetId: "buidl-like",
            score: 50.4,
            evidenceLevel: "limited",
            reasonCodes: ["missing-reserve-composition"],
            failureDomains: [{ kind: "reserve-issuer", key: "buidl-like" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.contributions.find((entry) => entry.componentKey === "reserve:buidl-like")).toMatchObject({
      score: 50.4,
      normalizedWeight: 0.14,
      upstreamAssetId: "buidl-like",
    });
    expect(result.unresolved).toContainEqual({
      code: "bounded-unknown-reserve-exposure",
      pathKey: "reserve:buidl-like",
      gapIds: [],
      treatment: "pillar",
    });
    expect(result.unresolved).not.toContainEqual(
      expect.objectContaining({ code: "missing-reserve-composition" }),
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
        responsibility: "measured-adverse",
        materialShare: 0.4,
      }),
    );
  });

  it("exempts allocated-commodity issuer domains while retaining custodian concentration", () => {
    const separateCustodians = evaluateV9ReserveExposures(
      asset([
        exposure({
          key: "gold-a",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "vault-a",
        }),
        exposure({
          key: "gold-b",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "vault-b",
        }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );
    const sharedCustodian = evaluateV9ReserveExposures(
      asset([
        exposure({
          key: "gold-a",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "shared-vault",
        }),
        exposure({
          key: "gold-b",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "shared-vault",
        }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );
    const ordinaryIssuer = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash-a", weight: 0.5, issuer: "bank", custodian: "bank-vault-a" }),
        exposure({ key: "cash-b", weight: 0.5, issuer: "bank", custodian: "bank-vault-b" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    const separateConcentration = separateCustodians.contributions.find(
      (entry) => entry.componentKey === "reserve:concentration",
    );
    const sharedConcentration = sharedCustodian.contributions.find(
      (entry) => entry.componentKey === "reserve:concentration",
    );
    const ordinaryConcentration = ordinaryIssuer.contributions.find(
      (entry) => entry.componentKey === "reserve:concentration",
    );

    expect(separateConcentration).toMatchObject({ score: 75 });
    expect(separateConcentration?.failureDomains).toEqual(
      expect.arrayContaining([
        { kind: "reserve-custodian", key: "vault-a" },
        { kind: "reserve-custodian", key: "vault-b" },
      ]),
    );
    expect(separateConcentration?.failureDomains).not.toContainEqual({
      kind: "reserve-issuer",
      key: "physical-gold",
    });
    expect(sharedConcentration).toMatchObject({ score: 35 });
    expect(ordinaryConcentration).toMatchObject({ score: 35 });
    expect(separateCustodians.contributions.find((entry) => entry.componentKey === "reserve:gold-a")?.score).toBe(
      93.9,
    );
  });

  it("preserves known reserves while charging an absent mechanism review at authored component weights", () => {
    const gap: V9FactGapV2 = {
      gapId: "gap:mechanism-review",
      reasonCode: "bounded-mechanism-review",
      ownerDomain: "backing",
      policyRuleId: "v9.backing.mechanism-review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-risk-review" },
      message: "No policy-independent mechanism review is present.",
      evidenceRefIds: [],
    };
    const backingAsset = asset(
      ["a", "b", "c", "d"].map((key) => exposure({ key, weight: 0.25 })),
      [gap],
    );
    const reserve = evaluateV9ReserveExposures(backingAsset, V9_CANDIDATE_POLICY_V1);
    const result = createUnavailableV9BackingResult(backingAsset, unavailableReview(gap), V9_CANDIDATE_POLICY_V1);
    const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing;
    const archetypePolicy = policy.archetypes["fiat-cash"];
    const mechanismWeight = 1 - archetypePolicy.reserveWeight;
    const mechanismContributions = result.contributions.filter((entry) => entry.source === "mechanism");

    expect(result).toMatchObject({ rateability: "rateable", pillarCeiling: null });
    expect(result.score).toBeCloseTo(reserve.score! * archetypePolicy.reserveWeight + 35 * mechanismWeight, 12);
    expect(result.score).toBeGreaterThan(35);
    expect(mechanismContributions.map((entry) => entry.componentKey)).toEqual([
      "mechanism:assurance-and-reconciliation",
      "mechanism:claim-and-segregation",
      "mechanism:custody-continuity",
    ]);
    for (const contribution of mechanismContributions) {
      const componentKey = contribution.componentKey.replace("mechanism:", "");
      expect(contribution.score).toBe(policy.boundedUnknownQuality);
      expect(contribution.observationState).toBe("missing");
      expect(contribution.evidenceRefIds).toEqual([]);
      expect(contribution.normalizedWeight * mechanismWeight).toBeCloseTo(
        archetypePolicy.componentWeights[componentKey],
        12,
      );
    }
    expect(result.unresolved).toHaveLength(3);
    expect(result.unresolved).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "bounded-mechanism-review", treatment: "pillar" })]),
    );
  });

  it("keeps unavailable-review integrity and archetype failures NR", () => {
    const integrityGap: V9FactGapV2 = {
      gapId: "gap:integrity",
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "evidence",
      policyRuleId: "v9.backing.mechanism-review",
      observationState: "unsupported",
      path: { kind: "local-component", componentKey: "mechanism-risk-review" },
      message: "The mechanism review design is unsupported.",
      evidenceRefIds: [],
    };
    const archetypeGap: V9FactGapV2 = {
      gapId: "gap:archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "methodology",
      policyRuleId: "v9.backing.mechanism-review",
      observationState: "missing",
      path: { kind: "methodology", componentKey: "mechanism-risk-review" },
      message: "The mechanism archetype is unresolved.",
      evidenceRefIds: [],
    };
    const exposures = [exposure({ key: "cash", weight: 1 })];
    const integrity = createUnavailableV9BackingResult(
      asset(exposures, [integrityGap]),
      unavailableReview(integrityGap),
      V9_CANDIDATE_POLICY_V1,
    );
    const unresolvedArchetype = createUnavailableV9BackingResult(
      asset(exposures, [archetypeGap]),
      unavailableReview(archetypeGap, "unresolved"),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(integrity).toMatchObject({ rateability: "NR", score: null, contributions: [] });
    expect(integrity.unresolved).toContainEqual(expect.objectContaining({ code: "missing-pillar-evidence" }));
    expect(unresolvedArchetype).toMatchObject({ rateability: "NR", score: null, contributions: [] });
    expect(unresolvedArchetype.unresolved).toContainEqual(expect.objectContaining({ code: "missing-archetype" }));
  });

  it("keeps missing serial components NR for ordinary typed-review evaluation", () => {
    const gap: V9FactGapV2 = {
      gapId: "gap:serial-claim",
      reasonCode: "critical-unresolved",
      ownerDomain: "backing",
      policyRuleId: "fiat.claim.required",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "claim-and-segregation" },
      message: "The direct reserve claim is unresolved.",
      evidenceRefIds: [],
    };
    const missingStatus: V9FactStatusV2 = {
      applicability: { state: "required", policyRuleId: "fiat.claim.required", rationale: null, gapId: null },
      observationState: "missing",
      evidenceRefIds: [],
      gapIds: [gap.gapId],
    };
    const strongFact = (key: string) => ({
      status: knownStatus(`mechanism:${key}`),
      quality: "strong" as const,
      failureDomains: [],
    });
    const result = evaluateV9ArchetypeBacking(
      {
        archetype: "fiat-cash",
        asset: asset([exposure({ key: "cash", weight: 1 })], [gap]),
        components: [
          { componentKey: "claim-and-segregation", fact: { status: missingStatus, quality: null, failureDomains: [] } },
          { componentKey: "custody-continuity", fact: strongFact("custody") },
          { componentKey: "assurance-and-reconciliation", fact: strongFact("assurance") },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result).toMatchObject({ rateability: "NR", score: null });
    expect(result.unresolved).toContainEqual(expect.objectContaining({ code: "critical-unresolved", treatment: "NR" }));
  });
});

describe("Safety Score v9 wrapper backing inheritance", () => {
  const backing = V9_CANDIDATE_POLICY_V1.policy.semantic.backing;
  const missingReserveAsset = (
    inherited: NonNullable<V9BackingAssetInput["inheritedStablecoinBacking"]>,
  ): V9BackingAssetInput => ({
    assetId: "wrapper",
    reserveStatus: {
      applicability: { state: "required", policyRuleId: "v9.backing.reserve-composition", rationale: null, gapId: null },
      observationState: "missing",
      evidenceRefIds: [],
      gapIds: ["wrapper:gap:reserve-composition"],
    },
    reserveExposures: [],
    gaps: [],
    resolvedUpstreamExposures: [],
    inheritedStablecoinBacking: inherited,
  });

  it("inherits a pure 1:1 parent's backing pillar without re-pricing the wrapper layer", () => {
    const result = evaluateV9ReserveExposures(
      missingReserveAsset({
        parentAssetId: "parent",
        parentBackingScore: 75,
        weight: 1,
        tier: "pure",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBeCloseTo(75, 6);
    expect(result.rateability).toBe("rateable");
    expect(result.contributions).toContainEqual(
      expect.objectContaining({ componentKey: "reserve:inherited-backing:parent", upstreamAssetId: "parent" }),
    );
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: "partial-reserve-review", treatment: "ceiling" }),
    ]);
  });

  it("does not apply a second backing discount to a staked/vault layer", () => {
    const result = evaluateV9ReserveExposures(
      missingReserveAsset({
        parentAssetId: "parent",
        parentBackingScore: 75,
        weight: 1,
        tier: "wrapped",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBeCloseTo(75, 6);
  });

  it("uses verified live parent backing without rerunning the child archetype", () => {
    const liveAsset: V9BackingAssetInput = {
      ...asset([
        exposure({
          key: "parent",
          weight: 1,
          assetClass: "stablecoin",
          trackedAssetId: "parent",
          issuer: "asset:parent",
          provenance: "live",
        }),
      ]),
      assetId: "wrapper",
      inheritedStablecoinBacking: {
        parentAssetId: "parent",
        parentBackingScore: 82,
        weight: 1,
        tier: "wrapped",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      },
    };
    const failedFact = (key: string) => ({
      status: knownStatus(`mechanism:${key}`),
      quality: "failed" as const,
      failureDomains: [{ kind: "reserve-issuer" as const, key: `child:${key}` }],
    });
    const result = evaluateV9ArchetypeBacking(
      {
        archetype: "fiat-cash",
        asset: liveAsset,
        components: [
          { componentKey: "claim-and-segregation", fact: failedFact("claim") },
          { componentKey: "custody-continuity", fact: failedFact("custody") },
          { componentKey: "assurance-and-reconciliation", fact: failedFact("assurance") },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBe(82);
    expect(result.contributions).toEqual([
      expect.objectContaining({
        componentKey: "reserve:concentration",
        observationState: "known",
        provenance: "live",
      }),
      expect.objectContaining({
        componentKey: "reserve:inherited-backing:parent",
        observationState: "known",
        provenance: "live",
        upstreamAssetId: "parent",
      }),
    ]);
    expect(result.contributions.some((entry) => entry.source === "mechanism")).toBe(false);
    expect(result.unresolved).toEqual([]);
  });

  it("keeps sub-1 residual at the bounded-unknown quality", () => {
    const result = evaluateV9ReserveExposures(
      missingReserveAsset({
        parentAssetId: "parent",
        parentBackingScore: 90,
        weight: 0.99,
        tier: "pure",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBeCloseTo(90 * 0.99 + backing.boundedUnknownQuality * 0.01, 6);
  });

  it("defers to the fail-closed bounded path when a weak parent cannot beat the floor", () => {
    const inherited = {
      parentAssetId: "parent",
      parentBackingScore: 40,
      weight: 1,
      tier: "wrapped" as const,
      failureDomains: [{ kind: "reserve-issuer" as const, key: "asset:parent" }],
    };
    const withInheritance = evaluateV9ReserveExposures(missingReserveAsset(inherited), V9_CANDIDATE_POLICY_V1);
    expect(withInheritance.score).toBeCloseTo(40, 6);
    expect(withInheritance.contributions).toContainEqual(
      expect.objectContaining({ componentKey: "reserve:inherited-backing:parent" }),
    );
    expect(withInheritance.unresolved).toContainEqual(
      expect.objectContaining({ code: "partial-reserve-review" }),
    );
  });
});
