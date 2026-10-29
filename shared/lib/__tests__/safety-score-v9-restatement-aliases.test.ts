import { describe, expect, it } from "vitest";
import type { V9EvidenceCauseProof } from "../../types/safety-score-v9-causes";
import { V9_UNRESEARCHED_CAUSE_PROOF } from "../../types/safety-score-v9-causes";
import { CompiledV9FactSetV3Schema } from "../../types/safety-score-v9-facts";
import { countV9EvidenceObligations } from "../../types/safety-score-v9-public-evidence-facts";
import type { V9DependencyEvaluationPlan } from "../safety-score-v9/dependencies";
import type { V9EvaluatedAsset } from "../safety-score-v9/evaluate-set";
import {
  evaluateV9Asset,
  v9DependencyGraphRestatementAliasGapIds,
  v9ExitOutputRestatementAliasGapIds,
  v9ProfileRestatementAliasGapIds,
} from "../safety-score-v9/evaluate-asset";
import { createV9GapIndex } from "../safety-score-v9/gap-index";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import {
  SOURCE_FINGERPRINTS,
  V9_CANDIDATE_POLICY_V1,
  canonicalV9RouteKey,
  compileNativeV3FactSet,
  coreFixture,
  createV9FactStatus,
  fullAsset,
  knownStatus,
  requiredV9Applicability,
} from "./safety-score-v9-facts.fixture-support";

const producerFailedProof: V9EvidenceCauseProof = {
  cause: "A",
  producerState: "producer-failed",
  sourceId: "route-feed",
  sourceGenerationId: "run-1",
  observedAtSec: 1_791_158_400,
  evidenceRefIds: ["failed-route"],
  rejectionCode: "http-502",
};

function exitGap(gapId: string, overrides: {
  reasonCode?: Parameters<typeof createV9FactGapV3>[0]["reasonCode"];
  causeProof?: V9EvidenceCauseProof;
  pathKind?: "local-component" | "optional-exit";
} = {}) {
  return createV9FactGapV3({
    gapId,
    reasonCode: overrides.reasonCode ?? "missing-same-notional-route",
    ownerDomain: "exit",
    policyRuleId: "v9.exit.route-factors",
    observationState: "missing",
    responsibility: "unresearched",
    ...(overrides.causeProof === undefined ? {} : { causeProof: overrides.causeProof }),
    path: overrides.pathKind === "local-component"
      ? { kind: "local-component", componentKey: "exit-routes" }
      : { kind: "optional-exit", routeKey: "dex" },
    message: "A route datum is unavailable.",
  });
}

function dependencyGap(gapId: string, overrides: {
  ownerDomain?: "dependency" | "backing";
  causeProof?: V9EvidenceCauseProof;
} = {}) {
  return createV9FactGapV3({
    gapId,
    reasonCode: "unreviewed-dependency-relationships",
    ownerDomain: overrides.ownerDomain ?? "dependency",
    policyRuleId: "v9.dependencies.effective-set",
    observationState: "bounded-unknown",
    responsibility: "unresearched",
    ...(overrides.causeProof === undefined ? {} : { causeProof: overrides.causeProof }),
    path: { kind: "local-component", componentKey: "effective-dependencies" },
    message: "The effective dependency set is unreviewed.",
  });
}

function countObligations(facts: readonly {
  sourceGapId: string | null;
  causeGapIds: readonly string[];
  critical: boolean;
}[]): { factCount: number; criticalFactCount: number } {
  return countV9EvidenceObligations(
    facts,
    (fact) => fact.sourceGapId,
    (fact) => fact.causeGapIds,
    (fact) => fact.critical,
  );
}

/**
 * Evaluate one real compiled asset through `evaluateV9Asset`/`exitPillar`.
 * `unresolvedColumns` 1 produces one route whose output is unresolved and whose
 * output-factor gap is the only compiled route gap, so the restatement aliases
 * it; 2 adds a second route with a second output gap, which makes the alias
 * ambiguous and therefore declined. Every other input is identical.
 */
function evaluatedExitFixture(phantomOutputGap: boolean) {
  const core = coreFixture();
  const factSet = structuredClone(CompiledV9FactSetV3Schema.parse(compileNativeV3FactSet(core)));
  const asset = factSet.assets.find((row) => row.assetId === "alpha")!;
  const template = asset.exitRoutes[0]!;
  asset.exitRoutes = [];
  asset.exitStatus = knownStatus();
  // Keep non-Exit gaps so the other pillars evaluate; the Exit inventory is
  // rebuilt below from exactly the routes this fixture defines.
  asset.gaps = asset.gaps.filter((gap) => gap.ownerDomain !== "exit");
  const route = (suffix: string) => {
    const routeKey = canonicalV9RouteKey("dex", SOURCE_FINGERPRINTS.dex.generationId, `route:${suffix}`);
    const gap = createV9FactGapV3({
      gapId: `alpha:gap:route:${suffix}:output`,
      reasonCode: "missing-same-notional-route",
      ownerDomain: "exit",
      policyRuleId: "v9.exit.route-factors",
      observationState: "missing",
      responsibility: "unresearched",
      path: { kind: "optional-exit", routeKey },
      message: "The route output is unresolved.",
    });
    asset.gaps.push(gap);
    const outputStatus = createV9FactStatus({
      applicability: requiredV9Applicability("v9.exit.route-output"),
      observationState: "missing",
      // An ambiguous reference (two output gaps, only one compiled) declines
      // the alias without changing any compiled gap or source fact.
      gapIds: phantomOutputGap ? [gap.gapId, `alpha:gap:route:${suffix}:phantom`] : [gap.gapId],
    });
    return {
      ...template,
      routeKey,
      routeId: `route:${suffix}`,
      status: createV9FactStatus({
        applicability: requiredV9Applicability("v9.exit.same-notional-route"),
        observationState: "missing",
        gapIds: [gap.gapId],
      }),
      output: { status: outputStatus, kind: "unknown" as const, assetKeys: [], basketWeights: [], valuation: null },
      factorStatuses: { output: outputStatus },
      capacityCurve: [],
      scoreEligible: false,
    };
  };
  asset.exitRoutes = [route("dex")];
  // Dropping the template routes orphans their evidence references; keep only
  // ids the surviving asset still names.
  const { evidence, ...named } = asset;
  const referenced = new Set<string>();
  const collectStrings = (value: unknown): void => {
    if (typeof value === "string") referenced.add(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(collectStrings);
  };
  collectStrings(named);
  asset.evidence = evidence.filter((reference) => referenced.has(reference.evidenceId));
  return {
    asset,
    evaluated: evaluateV9Asset({
      asset,
      resolved: { assetId: "alpha", basket: [], serial: [], cycleBlocked: false },
      // A lone asset has no dependency edges: only these two plan fields are
      // read on the single-asset evaluation path, so the richer plan identity
      // fields are irrelevant to this fixture.
      dependencyPlan: { serialCycleAssetIds: [], serialBlockedDescendants: [] } as unknown as V9DependencyEvaluationPlan,
      envelope: V9_CANDIDATE_POLICY_V1,
      evaluatedById: new Map(),
      unavailabilityRootsById: new Map(),
      identity: {
        factSetDigest: "a".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
        evaluationBuildDigest: "b".repeat(64),
        asOfSec: 1_000,
        sourceGenerations: {},
      },
      marketRank: 1,
      dependencySignals: [],
    }).evaluatedAsset,
  };
}

function restatement(evaluated: V9EvaluatedAsset) {
  const reasons = evaluated.scoreInput.pillars.exit.reasons.filter(
    (reason) => reason.code === "unresolved-exit-output",
  );
  expect(reasons).toHaveLength(1);
  return reasons[0]!;
}

describe("source-less restatements alias their compiled gap", () => {
  const outputGap = exitGap("fixture:gap:route:dex:output");
  const otherOutputGap = exitGap("fixture:gap:route:payout:output", { pathKind: "local-component" });
  const capacityGap = exitGap("fixture:gap:exit-route:dex:capacity", { reasonCode: "missing-runtime-route-evidence" });
  const censusGap = exitGap("fixture:gap:exit-portfolio-coverage", { reasonCode: "incomplete-dex-route-coverage", pathKind: "local-component" });
  const failedCapacityGap = exitGap("fixture:gap:exit-route:payout:capacity", {
    reasonCode: "missing-runtime-route-evidence",
    causeProof: producerFailedProof,
  });
  const dependencyGapU = dependencyGap("fixture:gap:effective-dependencies");
  const reserveGapU = dependencyGap("fixture:gap:reserve-composition", { ownerDomain: "backing" });

  it("attaches the excluded route's own output gap through the real exit pillar", () => {
    const aliased = evaluatedExitFixture(false);
    const reason = restatement(aliased.evaluated);
    expect(reason.path).toBe("exit:unresolved-exit-output");
    expect(reason.causeGapIds).toEqual(["alpha:gap:route:dex:output"]);
    expect(reason.sourceGapId).toBeUndefined();
    // The same gap is already a source obligation on the card, so the pair
    // counts once instead of twice.
    const facts = aliased.evaluated.trace.unresolvedFacts
      .filter((fact) => fact.responsibility === "unresearched")
      .map((fact) => ({
        sourceGapId: fact.sourceGapId ?? null,
        causeGapIds: fact.causeGapIds ?? [],
        critical: fact.critical,
      }));
    const before = facts.map((fact) =>
      fact.causeGapIds.length === 1 && fact.sourceGapId === null ? { ...fact, causeGapIds: [] } : fact);
    expect(countObligations(before).factCount - countObligations(facts).factCount).toBe(1);
  });

  it("keeps pillar score, evidence level and limiting witnesses identical without the alias", () => {
    const aliased = evaluatedExitFixture(false);
    const unaliased = evaluatedExitFixture(true);
    const aliasedReason = restatement(aliased.evaluated);
    const unaliasedReason = restatement(unaliased.evaluated);
    expect(aliasedReason.causeGapIds).toEqual(["alpha:gap:route:dex:output"]);
    expect(unaliasedReason.causeGapIds).toEqual([]);

    const aliasedPillar = aliased.evaluated.scoreInput.pillars.exit;
    const unaliasedPillar = unaliased.evaluated.scoreInput.pillars.exit;
    expect(aliasedPillar.score).toBe(unaliasedPillar.score);
    expect(aliasedPillar.evidenceLevel).toBe(unaliasedPillar.evidenceLevel);
    expect(aliasedPillar.limitedEvidenceCauses).toEqual(unaliasedPillar.limitedEvidenceCauses);
    expect(aliasedPillar.limitingCauseGapIds).toEqual(unaliasedPillar.limitingCauseGapIds);
    // Only the cause reference differs: code, path, owner, cause and treatment
    // are the same restatement in both arms.
    const { causeGapIds: _aliasedRefs, ...aliasedFields } = aliasedReason;
    const { causeGapIds: _unaliasedRefs, ...unaliasedFields } = unaliasedReason;
    expect(aliasedFields).toEqual(unaliasedFields);
  });

  it("declines the exit-output alias when the excluded routes name different output gaps", () => {
    const asset = {
      exitRoutes: [
        { routeKey: "redemption:dex", factorStatuses: { output: { gapIds: [outputGap.gapId] } } },
        { routeKey: "redemption:payout", factorStatuses: { output: { gapIds: [otherOutputGap.gapId] } } },
      ],
    };
    expect(v9ExitOutputRestatementAliasGapIds(asset, [
      { routeKey: "redemption:dex", exclusionReason: "unresolved-exit-output" as const },
      { routeKey: "redemption:payout", exclusionReason: "unresolved-exit-output" as const },
    ])).toEqual([]);
  });

  it("reuses only the exit status' own unresearched runtime gap for a reviewed profile", () => {
    const gapIndex = createV9GapIndex([outputGap, capacityGap, censusGap, failedCapacityGap]);
    // A producer-caused capacity gap is a different owner; it never becomes
    // the profile restatement's root.
    expect(v9ProfileRestatementAliasGapIds({
      exitStatus: { gapIds: [censusGap.gapId, outputGap.gapId, capacityGap.gapId, failedCapacityGap.gapId] },
    }, "missing-runtime-route-evidence", gapIndex)).toEqual([capacityGap.gapId]);
  });

  it("declines the profile alias when the same-code unresearched gap is ambiguous", () => {
    const gapIndex = createV9GapIndex([capacityGap, censusGap, outputGap]);
    expect(v9ProfileRestatementAliasGapIds({
      exitStatus: { gapIds: [capacityGap.gapId, outputGap.gapId, censusGap.gapId] },
    }, "unresolved-exit-output", gapIndex)).toEqual([]);
  });

  it("reuses a single unresearched dependency gap and never a foreign-owner gap", () => {
    const gapIndex = createV9GapIndex([dependencyGapU, reserveGapU]);
    expect(v9DependencyGraphRestatementAliasGapIds({
      dependencies: { status: { gapIds: [dependencyGapU.gapId] } },
    }, gapIndex)).toEqual([dependencyGapU.gapId]);
    expect(v9DependencyGraphRestatementAliasGapIds({
      dependencies: { status: { gapIds: [reserveGapU.gapId] } },
    }, gapIndex)).toEqual([]);
    expect(v9DependencyGraphRestatementAliasGapIds({
      dependencies: { status: { gapIds: [dependencyGapU.gapId, reserveGapU.gapId] } },
    }, gapIndex)).toEqual([dependencyGapU.gapId]);
    const secondDependencyGapU = dependencyGap("fixture:gap:effective-dependencies-2");
    expect(v9DependencyGraphRestatementAliasGapIds({
      dependencies: { status: { gapIds: [dependencyGapU.gapId, secondDependencyGapU.gapId] } },
    }, createV9GapIndex([dependencyGapU, secondDependencyGapU]))).toEqual([]);
  });

  it("never binds a root outside the compiled gap index", () => {
    const gapIndex = createV9GapIndex([outputGap, capacityGap, dependencyGapU]);
    const undefinedGap = "fixture:gap:missing-from-index";
    expect(v9ProfileRestatementAliasGapIds({ exitStatus: { gapIds: [undefinedGap] } }, "unresolved-exit-output", gapIndex)).toEqual([]);
    expect(v9DependencyGraphRestatementAliasGapIds({ dependencies: { status: { gapIds: [undefinedGap] } } }, gapIndex)).toEqual([]);
    expect(V9_UNRESEARCHED_CAUSE_PROOF.cause).toBe("U");
  });
});
