import { describe, expect, it } from "vitest";
import type { V9EvidenceCauseProof } from "../../types/safety-score-v9-causes";
import { V9_UNRESEARCHED_CAUSE_PROOF } from "../../types/safety-score-v9-causes";
import { countV9EvidenceObligations } from "../../types/safety-score-v9-public-evidence-facts";
import {
  v9DependencyGraphRestatementAliasGapIds,
  v9ExitOutputRestatementAliasGapIds,
  v9ProfileRestatementAliasGapIds,
} from "../safety-score-v9/evaluate-asset";
import { createV9GapIndex } from "../safety-score-v9/gap-index";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import { makeV9Pillar } from "./safety-score-v9-score.test-support";

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
}[]): number {
  return countV9EvidenceObligations(
    facts,
    (fact) => fact.sourceGapId,
    (fact) => fact.causeGapIds,
    (fact) => fact.critical,
  ).factCount;
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

  it("reuses the excluded route's own output gap for an unresolved exit output", () => {
    const asset = {
      exitRoutes: [
        { routeKey: "redemption:dex", factorStatuses: { output: { gapIds: [outputGap.gapId] } } },
        { routeKey: "redemption:payout", factorStatuses: { output: { gapIds: [] } } },
      ],
    };
    const traces = [
      { routeKey: "redemption:dex", exclusionReason: "unresolved-exit-output" as const },
      { routeKey: "redemption:payout", exclusionReason: null },
    ];
    expect(v9ExitOutputRestatementAliasGapIds(asset, traces)).toEqual([outputGap.gapId]);
    expect(countObligations([
      { sourceGapId: outputGap.gapId, causeGapIds: [outputGap.gapId], critical: false },
      { sourceGapId: null, causeGapIds: v9ExitOutputRestatementAliasGapIds(asset, traces), critical: false },
    ])).toBe(1);
    expect(countObligations([
      { sourceGapId: outputGap.gapId, causeGapIds: [outputGap.gapId], critical: false },
      { sourceGapId: null, causeGapIds: [], critical: false },
    ])).toBe(2);
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
    expect(countObligations([
      { sourceGapId: capacityGap.gapId, causeGapIds: [capacityGap.gapId], critical: false },
      { sourceGapId: null, causeGapIds: [capacityGap.gapId], critical: false },
    ])).toBe(1);
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

  it("changes only the cause reference on the emitted restatement and no scored field", () => {
    const restatement = {
      code: "unresolved-exit-output" as const,
      path: "exit:unresolved-exit-output",
      message: "The route's stablecoin output is unresolved.",
      responsibility: "unresearched" as const,
      cause: "U" as const,
      critical: false,
      scoringDisposition: "bounded-uncertainty" as const,
      causeGapIds: [] as readonly string[],
    };
    const aliased = { ...restatement, causeGapIds: [outputGap.gapId] as readonly string[] };
    const { causeGapIds: _before, ...restatementFields } = restatement;
    const { causeGapIds: _after, ...aliasedFields } = aliased;
    expect(aliasedFields).toEqual(restatementFields);

    const pillar = makeV9Pillar(50, {
      evidenceLevel: "adequate",
      reasons: [restatement],
    });
    const aliasedPillar = { ...pillar, reasons: [aliased] };
    expect(aliasedPillar.score).toBe(pillar.score);
    expect(aliasedPillar.evidenceLevel).toBe(pillar.evidenceLevel);
    expect(aliasedPillar.limitedEvidenceCauses).toEqual(pillar.limitedEvidenceCauses);
    expect(aliasedPillar.limitingCauseGapIds).toEqual(pillar.limitingCauseGapIds);
    expect(aliasedPillar.causeGapIds).toEqual(pillar.causeGapIds);
    expect(aliasedPillar.aggregationDisposition).toBe(pillar.aggregationDisposition);
  });

  it("never invents a root outside the compiled gap index", () => {
    const gapIndex = createV9GapIndex([outputGap, capacityGap, dependencyGapU]);
    const undefinedGap = "fixture:gap:missing-from-index";
    expect(v9ProfileRestatementAliasGapIds({ exitStatus: { gapIds: [undefinedGap] } }, "unresolved-exit-output", gapIndex)).toEqual([]);
    expect(v9DependencyGraphRestatementAliasGapIds({ dependencies: { status: { gapIds: [undefinedGap] } } }, gapIndex)).toEqual([]);
    expect(V9_UNRESEARCHED_CAUSE_PROOF.cause).toBe("U");
  });
});
