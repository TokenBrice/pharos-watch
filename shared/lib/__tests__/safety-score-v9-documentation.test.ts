import { describe, expect, it } from "vitest";
import candidatePolicyAsset from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  classifyV9DocumentationGap,
  documentationGapIds,
  documentationOnlyLimitedPillars,
  isV9DocumentationDatum,
  resolveV9DocumentationControl,
  type V9DocumentationAssetFacts,
  type V9DocumentationPillarWitness,
} from "../safety-score-v9/documentation";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy } from "../safety-score-v9/policy";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import type { V9EvidenceCauseProof } from "../../types/safety-score-v9-causes";
import type { V9MethodologyPolicy } from "../../types/safety-score-v9";
import type {
  V9AssetFactsV3,
  V9DeploymentControlFactV2,
  V9FactGapV3,
  V9TypedFactPath,
} from "../../types/safety-score-v9-facts";
import { compileNativeV3FactSet, coreFixture } from "./safety-score-v9-facts.fixture-support";

const compiled = compileNativeV3FactSet(coreFixture());
const baseFacts = compiled.assets.find((asset) => asset.assetId === "alpha") as V9AssetFactsV3;
const baseControl = baseFacts.controls[0]!;

const CAUSE_C = {
  cause: "C",
  proofOrigin: "typed-review",
  classificationId: "fixture:documentation-gap",
  reviewedAt: "2026-10-03",
  assertion: "researched-nondisclosure",
  rationale: "Fixture issuer nondisclosure.",
  sources: [{
    url: "https://issuer.example/disclosure",
    observedAt: "2026-10-03",
    datumAsOf: null,
    location: "transparency",
    excerpt: "The datum is not published.",
    assertion: "not disclosed",
  }],
  evidenceRefIds: ["evidence:doc"],
} satisfies V9EvidenceCauseProof;

function gap(overrides: {
  gapId: string;
  reasonCode: V9FactGapV3["reasonCode"];
  path?: V9TypedFactPath;
  factorKey?: string | null;
  componentKey?: string;
  observationState?: V9FactGapV3["observationState"];
  causeProof?: V9EvidenceCauseProof;
}): V9FactGapV3 {
  const causeProof = overrides.causeProof ?? { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] as [] };
  const path = overrides.path ?? (overrides.componentKey === undefined
    ? null
    : { kind: "local-component" as const, componentKey: overrides.componentKey });
  if (path === null) throw new Error(`Fixture gap ${overrides.gapId} needs a path or component key`);
  return createV9FactGapV3({
    gapId: overrides.gapId,
    reasonCode: overrides.reasonCode,
    ownerDomain: "control",
    policyRuleId: overrides.gapId,
    observationState: overrides.observationState ?? "missing",
    path,
    message: "Fixture documentation datum.",
    causeProof,
    ...(overrides.componentKey === undefined ? {} : {
      causeScope: {
        pillar: "control",
        componentKey: overrides.componentKey,
        factorKey: overrides.factorKey ?? null,
        routeKey: null,
        exposureId: null,
        requiredDatum: overrides.componentKey,
      },
    }),
  });
}

function control(overrides: {
  controlKey: string;
  economicLossScope: V9DeploymentControlFactV2["economicLossScope"];
  materialSupplyShare: number | null;
  deploymentKey?: string;
}): V9DeploymentControlFactV2 {
  return {
    ...baseControl,
    controlKey: overrides.controlKey,
    deploymentKey: overrides.deploymentKey ?? "ethereum",
    scope: "deployment",
    controlKind: "bridge",
    economicLossScope: overrides.economicLossScope,
    claimImpairment: overrides.economicLossScope === "deployment" ? "bounded" : "none",
    materialSupplyShare: overrides.materialSupplyShare,
  };
}

function asset(overrides: Partial<V9DocumentationAssetFacts> = {}): V9DocumentationAssetFacts {
  return {
    assetId: baseFacts.assetId,
    archetype: baseFacts.archetype,
    controlStatus: baseFacts.controlStatus,
    controls: [],
    gaps: [],
    supply: { ...baseFacts.supply, selectedBridgeRoutes: [], selectedRouteSupplyShare: null,
      unknownRouteSupplyShare: null, unreviewedRouteSupplyShare: null },
    economicControlReview: baseFacts.economicControlReview,
    reserveExposures: [],
    exitRoutes: [],
    ...overrides,
  };
}

function mintReview(overrides: { reconciliation?: string; supervision?: string }) {
  return {
    ...baseFacts.economicControlReview,
    mint: {
      ...baseFacts.economicControlReview.mint,
      ...overrides,
    },
  } as V9DocumentationAssetFacts["economicControlReview"];
}

const POLICY = V9_CANDIDATE_POLICY_V1;

describe("Safety Score v9 documentation classifier", () => {
  it("classifies a custody datum on a 0.5% non-binding control as no-scoring-path, never immaterial-deployment", () => {
    const custody = control({ controlKey: "bridge-meta:fixture", economicLossScope: "deployment", materialSupplyShare: 0.005 });
    const datum = gap({
      gapId: "alpha:gap:control:bridge-meta:fixture:keyCustody",
      reasonCode: "unresolved-control-identity",
      componentKey: "control:bridge-meta:fixture",
      factorKey: "keyCustody",
    });
    const facts = asset({ controls: [custody], gaps: [datum] });
    expect(classifyV9DocumentationGap(POLICY, facts, datum)?.reason).toBe("no-scoring-path");
  });

  it("keeps a null deployment share, a global claim and a reserve claim outside immaterial-deployment", () => {
    const cases: V9DeploymentControlFactV2[] = [
      control({ controlKey: "bridge-meta:null", economicLossScope: "deployment", materialSupplyShare: null }),
      control({ controlKey: "bridge-meta:global", economicLossScope: "global-claim", materialSupplyShare: 0.005 }),
      control({ controlKey: "bridge-meta:reserve", economicLossScope: "reserve-claim", materialSupplyShare: 0.005 }),
    ];
    for (const c of cases) {
      const datum = gap({
        gapId: `alpha:gap:control:${c.controlKey}:incidentState`,
        reasonCode: "unresolved-control-identity",
        componentKey: `control:${c.controlKey}`,
        factorKey: "incidentState",
      });
      expect(classifyV9DocumentationGap(POLICY, asset({ controls: [c], gaps: [datum] }), datum)).toBeNull();
    }
  });

  it("applies the 1% bar strictly: 0.009999 classifies, exactly 0.01 does not", () => {
    const inside = control({ controlKey: "bridge-meta:inside", economicLossScope: "deployment", materialSupplyShare: 0.009999 });
    const atBar = control({ controlKey: "bridge-meta:at-bar", economicLossScope: "deployment", materialSupplyShare: 0.01 });
    const insideGap = gap({
      gapId: "alpha:gap:control:bridge-meta:inside:incidentState",
      reasonCode: "unresolved-control-identity",
      componentKey: "control:bridge-meta:inside",
      factorKey: "incidentState",
    });
    const atBarGap = gap({
      gapId: "alpha:gap:control:bridge-meta:at-bar:incidentState",
      reasonCode: "unresolved-control-identity",
      componentKey: "control:bridge-meta:at-bar",
      factorKey: "incidentState",
    });
    const facts = asset({ controls: [inside, atBar], gaps: [insideGap, atBarGap] });
    const insideClassification = classifyV9DocumentationGap(POLICY, facts, insideGap);
    expect(insideClassification?.reason).toBe("immaterial-deployment");
    expect(insideClassification?.threshold).toEqual({ kind: "known-share-pct", value: 0.01, evidenceKind: "exact" });
    expect(insideClassification?.policyRef).toBe("semantic.evidence.documentation.reasons.immaterial-deployment");
    expect(classifyV9DocumentationGap(POLICY, facts, atBarGap)).toBeNull();
  });

  it("admits a reconciled upper bound below the bar and requires one at or above it", () => {
    const datum = gap({
      gapId: "alpha:gap:control:bridge-meta:bounded:incidentState",
      reasonCode: "unresolved-control-identity",
      componentKey: "control:bridge-meta:bounded",
      factorKey: "incidentState",
    });
    const boundedControl = control({
      controlKey: "bridge-meta:bounded", economicLossScope: "deployment", materialSupplyShare: null,
      deploymentKey: "base",
    });
    const partition = (baseShare: number) => ({
      ...baseFacts.supply,
      selectedBridgeRoutes: [
        { deploymentRouteKey: "base", supplyUsd: baseShare * 1_000_000, supplyShare: baseShare, reviewState: "selected-reviewed" as const },
        { deploymentRouteKey: "ambiguous-chain:alpha:ethereum", supplyUsd: (1 - baseShare) * 1_000_000,
          supplyShare: 1 - baseShare, reviewState: "selected-unresolved" as const },
      ],
      selectedRouteSupplyShare: baseShare,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 1 - baseShare,
    });
    const inside = asset({ controls: [boundedControl], gaps: [datum], supply: partition(0.009) });
    expect(classifyV9DocumentationGap(POLICY, inside, datum)?.threshold)
      .toEqual({ kind: "known-share-pct", value: 0.01, evidenceKind: "upper-bound" });
    const atBar = asset({ controls: [boundedControl], gaps: [datum], supply: partition(0.01) });
    expect(classifyV9DocumentationGap(POLICY, atBar, datum)).toBeNull();
  });

  it("classifies a non-binding access-only control but never a binding deployment control", () => {
    const accessOnly = control({ controlKey: "mint-meta:access", economicLossScope: "access-only", materialSupplyShare: 0 });
    const binding = control({ controlKey: "bridge-meta:dominant", economicLossScope: "deployment", materialSupplyShare: 0.2 });
    const accessGap = gap({
      gapId: "alpha:gap:deployment-control:mint-meta:access",
      reasonCode: "scoped-control-question",
      path: { kind: "deployment-control", deploymentKey: "ethereum", controlKey: "mint-meta:access" },
    });
    const bindingGap = gap({
      gapId: "alpha:gap:deployment-control:bridge-meta:dominant",
      reasonCode: "unresolved-control-identity",
      path: { kind: "deployment-control", deploymentKey: "ethereum", controlKey: "bridge-meta:dominant" },
    });
    const facts = asset({ controls: [accessOnly, binding], gaps: [accessGap, bindingGap] });
    expect(classifyV9DocumentationGap(POLICY, facts, accessGap)?.reason).toBe("immaterial-deployment");
    expect(classifyV9DocumentationGap(POLICY, facts, bindingGap)).toBeNull();
    expect(resolveV9DocumentationControl(facts, accessGap)?.controlKey).toBe("mint-meta:access");
  });

  it("classifies mint reconciliation/supervision only where the mint grade withholds the credit", () => {
    const reconciliation = gap({
      gapId: "alpha:gap:economic-control:mint::reconciliation",
      reasonCode: "missing-mint-authority",
      componentKey: "economic-control:mint",
      factorKey: "reconciliation",
    });
    const supervision = gap({
      gapId: "alpha:gap:economic-control:mint::supervision",
      reasonCode: "missing-mint-authority",
      componentKey: "economic-control:mint",
      factorKey: "supervision",
    });
    const unknown = asset({ gaps: [reconciliation, supervision], economicControlReview: mintReview({ reconciliation: "unknown", supervision: "unknown" }) });
    expect(classifyV9DocumentationGap(POLICY, unknown, reconciliation)?.reason).toBe("unknown-scores-as-no-credit");
    expect(classifyV9DocumentationGap(POLICY, unknown, supervision)?.reason).toBe("unknown-scores-as-no-credit");
    const credited = asset({
      gaps: [reconciliation, supervision],
      economicControlReview: mintReview({ reconciliation: "periodic", supervision: "attestation-only" }),
    });
    expect(classifyV9DocumentationGap(POLICY, credited, reconciliation)).toBeNull();
    expect(classifyV9DocumentationGap(POLICY, credited, supervision)).toBeNull();
  });

  it("classifies a diagnostic datum but vetoes the sole-pillar-gate archetype and pillar-treated rows", () => {
    const access = gap({
      gapId: "alpha:gap:access:transfer",
      reasonCode: "missing-access-review",
      componentKey: "access:transfer",
    });
    const archetype = gap({
      gapId: "alpha:gap:mechanism-risk-review",
      reasonCode: "missing-archetype",
      path: { kind: "methodology", componentKey: "mechanism-risk-review" },
      causeProof: CAUSE_C,
    });
    const pillarTreated = gap({
      gapId: "alpha:gap:route:redemption:output",
      reasonCode: "missing-same-notional-route",
      path: { kind: "optional-exit", routeKey: "redemption" },
      factorKey: "output",
    });
    const facts = asset({ gaps: [access, archetype, pillarTreated] });
    expect(classifyV9DocumentationGap(POLICY, facts, access)?.reason).toBe("unscored-diagnostic");
    expect(classifyV9DocumentationGap(POLICY, facts, archetype)).toBeNull();
    expect(classifyV9DocumentationGap(POLICY, facts, pillarTreated)).toBeNull();
  });

  it("classifies the DEX coverage label only on a non-empty route inventory", () => {
    const coverage = gap({
      gapId: "alpha:gap:exit-portfolio-coverage",
      reasonCode: "incomplete-dex-route-coverage",
      path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
      observationState: "bounded-unknown",
    });
    const withRoutes = asset({ gaps: [coverage], exitRoutes: baseFacts.exitRoutes });
    expect(baseFacts.exitRoutes.length).toBeGreaterThan(0);
    expect(classifyV9DocumentationGap(POLICY, withRoutes, coverage)?.reason).toBe("coverage-label");
    const zeroRoutes = asset({ gaps: [coverage], exitRoutes: [] });
    expect(classifyV9DocumentationGap(POLICY, zeroRoutes, coverage)).toBeNull();
  });

  it("applies the reserve dust bar strictly and only to missing factors", () => {
    const dust = gap({
      gapId: "alpha:gap:reserve:reserve:row:liquidity",
      reasonCode: "material-reserve-slice-unstructured",
      path: { kind: "collateral-exposure", exposureKey: "reserve:row" },
    });
    const exposure = (weight: number) => [{ exposureKey: "reserve:row", weight }];
    const inside = asset({ gaps: [dust], reserveExposures: exposure(0.00009999) });
    const classification = classifyV9DocumentationGap(POLICY, inside, dust);
    expect(classification?.reason).toBe("reserve-dust");
    expect(classification?.threshold).toEqual({ kind: "reserve-book-share", value: 0.0001 });
    expect(classifyV9DocumentationGap(POLICY, asset({ gaps: [dust], reserveExposures: exposure(0.0001) }), dust)).toBeNull();
    expect(classifyV9DocumentationGap(POLICY, asset({ gaps: [dust], reserveExposures: [] }), dust)).toBeNull();
  });

  it("keeps stale/partial reserve dust and non-C/U causes outside the class", () => {
    const partial = gap({
      gapId: "alpha:gap:reserve:reserve:row:liquidity",
      reasonCode: "material-reserve-slice-unstructured",
      path: { kind: "collateral-exposure", exposureKey: "reserve:row" },
      observationState: "bounded-unknown",
    });
    const dust = gap({
      gapId: "alpha:gap:reserve:reserve:row:maturity",
      reasonCode: "material-reserve-slice-unstructured",
      path: { kind: "collateral-exposure", exposureKey: "reserve:row" },
      causeProof: { cause: "D", adverseFactId: "adverse:fixture", evidenceRefIds: ["evidence:doc"] },
    });
    const facts = asset({ gaps: [partial, dust], reserveExposures: [{ exposureKey: "reserve:row", weight: 0.000001 }] });
    expect(classifyV9DocumentationGap(POLICY, facts, partial)).toBeNull();
    expect(classifyV9DocumentationGap(POLICY, facts, dust)).toBeNull();
  });

  it("classifies nothing when the policy block is absent and exposes the same result through both helpers", () => {
    const raw: V9MethodologyPolicy = structuredClone(candidatePolicyAsset);
    delete raw.semantic.evidence.documentation;
    const withoutBlock = loadV9MethodologyPolicy(raw);
    const custody = gap({
      gapId: "alpha:gap:control:bridge-meta:fixture:keyCustody",
      reasonCode: "unresolved-control-identity",
      componentKey: "control:bridge-meta:fixture",
      factorKey: "keyCustody",
    });
    const facts = asset({ controls: [control({ controlKey: "bridge-meta:fixture", economicLossScope: "deployment", materialSupplyShare: 0.5 })], gaps: [custody] });
    expect(classifyV9DocumentationGap(withoutBlock, facts, custody)).toBeNull();
    expect(documentationGapIds(withoutBlock, facts).size).toBe(0);

    const map = documentationGapIds(POLICY, facts);
    expect(map.get(custody.gapId)?.reason).toBe("no-scoring-path");
    expect(isV9DocumentationDatum(POLICY, facts, custody)).toBe(true);
  });
});

describe("Safety Score v9 documentation-only pillar annotation", () => {
  const localGap = gap({
    gapId: "alpha:gap:access:transfer",
    reasonCode: "missing-access-review",
    componentKey: "access:transfer",
  });
  const undocumentable = gap({
    gapId: "alpha:gap:bridge-supply",
    reasonCode: "missing-bridge-routes",
    componentKey: "bridge-materiality:alpha",
  });
  const facts = asset({ gaps: [localGap, undocumentable] });
  const foreign = ["beta:gap:heredoc"];

  function pillars(...entries: Array<[V9DocumentationPillarWitness["pillar"], V9DocumentationPillarWitness["evidenceLevel"], (readonly string[])?]>): V9DocumentationPillarWitness[] {
    return entries.map(([pillar, evidenceLevel, limitingCauseGapIds]) => ({
      pillar, evidenceLevel, ...(limitingCauseGapIds === undefined ? {} : { limitingCauseGapIds }),
    }));
  }

  it("lists a limited pillar whose every witness is documentation, including inherited ids", () => {
    expect(documentationOnlyLimitedPillars({
      envelope: POLICY, asset: facts, foreignDocumentationGapIds: foreign,
      pillars: pillars(["control", "limited", [localGap.gapId]], ["exit", "limited", [...foreign]]),
    })).toEqual(["control", "exit"]);
  });

  it("never lists an empty witness list, a non-limited pillar, one non-documentation witness or an unresolved id", () => {
    expect(documentationOnlyLimitedPillars({
      envelope: POLICY, asset: facts,
      pillars: pillars(
        ["backing", "limited", []],
        ["exit", "adequate", [localGap.gapId]],
        ["control", "limited", [undocumentable.gapId]],
      ),
    })).toEqual([]);
    expect(documentationOnlyLimitedPillars({
      envelope: POLICY, asset: facts, foreignDocumentationGapIds: foreign,
      pillars: pillars(
        ["backing", "limited", [localGap.gapId, "gamma:gap:nowhere"]],
        ["control", "limited", [localGap.gapId, undocumentable.gapId]],
        ["exit", "limited", ["gamma:gap:nowhere"]],
      ),
    })).toEqual([]);
  });
});
