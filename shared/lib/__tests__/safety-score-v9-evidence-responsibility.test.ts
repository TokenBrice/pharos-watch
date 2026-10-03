import { describe, expect, it } from "vitest";
import type { V9EvidenceCauseProof, V9EvidenceCauseScope } from "../../types/safety-score-v9-causes";
import { V9_UNRESEARCHED_CAUSE_PROOF } from "../../types/safety-score-v9-causes";
import { createV9GapIndex, projectGapReasons } from "../safety-score-v9/gap-index";
import { canonicalizeV9PublicReasons, createV9FactGapV3, type V9PublicReason } from "../safety-score-v9/reasons";
import { resolveV9ReasonTreatment, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const scope: V9EvidenceCauseScope = {
  pillar: "exit", componentKey: "execution", factorKey: "observationConfidence", routeKey: "dex",
  exposureId: null, requiredDatum: "current execution quote",
};
const failedProducerProof: V9EvidenceCauseProof = {
  cause: "A", producerState: "producer-failed", sourceId: "dex", sourceGenerationId: "run-1",
  observedAtSec: 1_791_158_400, evidenceRefIds: ["failed-quote"], rejectionCode: "http-502",
};
function gap(gapId: string, causeProof: V9EvidenceCauseProof = V9_UNRESEARCHED_CAUSE_PROOF) {
  return createV9FactGapV3({
    gapId, reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit", policyRuleId: "exit:execution",
    observationState: "missing", path: { kind: "optional-exit", routeKey: "dex" },
    message: "A current quote is unavailable.", responsibility: "issuer-undisclosed", causeProof, causeScope: scope,
  });
}
function publicReason(sourceGapId: string, causeGapIds: string[], path = "exit:dex"): V9PublicReason {
  return { code: "missing-runtime-route-evidence", path, message: "A current quote is unavailable.",
    sourceGapId, cause: "U", causeGapIds, causeProof: V9_UNRESEARCHED_CAUSE_PROOF, responsibility: "unresearched" };
}

describe("cause-aware responsibility and atomic reason identity", () => {
  it("does not turn a legacy issuer label into researched issuer nondisclosure", () => {
    const unresolved = gap("unreviewed-quote");
    expect(unresolved.causeProof).toEqual(V9_UNRESEARCHED_CAUSE_PROOF);
    expect(unresolved.responsibility).toBe("unresearched");
    const treatment = resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, unresolved.reasonCode, unresolved.causeProof.cause);
    expect(treatment.scoringDisposition).toBe("bounded-uncertainty");
    expect(treatment.critical).toBe(false);
    expect(treatment.ceiling).toBeNull();
  });

  it("uses producer proof rather than a conflicting caller-supplied issuer label", () => {
    const failed = gap("failed-quote-gap", failedProducerProof);
    expect(failed.responsibility).toBe("producer-failed");
    const treatment = resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, failed.reasonCode, failed.causeProof.cause);
    expect(treatment.scoringDisposition).toBe("excluded-pipeline");
    expect(treatment.ceiling).toBeNull();
    expect(treatment.critical).toBe(false);
  });

  it("rejects incompatible proofs before duplicate gap IDs can erase their cause", () => {
    expect(() => createV9GapIndex([gap("same-gap"), gap("same-gap", failedProducerProof)])).toThrow();
    expect(() => createV9GapIndex([gap("same-gap"), { ...gap("same-gap"), causeScope: { ...scope, routeKey: "other" } }])).toThrow();
  });

  it("rejects incompatible proofs before public or source-gap deduplication", () => {
    const original = publicReason("same-gap", ["same-gap"]);
    const contradictory: V9PublicReason = { ...original, cause: "A", causeProof: failedProducerProof, responsibility: "producer-failed" };
    expect(() => canonicalizeV9PublicReasons([original, contradictory])).toThrow();
    expect(() => canonicalizeV9PublicReasons([original, { ...contradictory, path: "exit:other" }], { dedupeSourceGapIds: true })).toThrow();
  });

  it("merges every causal reference when compatible public identities collapse", () => {
    const merged = canonicalizeV9PublicReasons([
      publicReason("gap-a", ["gap-a"]), publicReason("gap-b", ["gap-b", "gap-c"]),
    ]);
    expect(merged).toEqual([expect.objectContaining({ causeGapIds: ["gap-a", "gap-b", "gap-c"] })]);
  });

  it("counts one source gap once without losing secondary composite references", () => {
    const merged = canonicalizeV9PublicReasons([
      publicReason("shared-gap", ["shared-gap"], "exit:a"),
      publicReason("shared-gap", ["secondary-gap", "shared-gap"], "exit:b"),
    ], { dedupeSourceGapIds: true });
    expect(merged).toEqual([expect.objectContaining({ sourceGapId: "shared-gap", causeGapIds: ["secondary-gap", "shared-gap"] })]);
  });

  it("keeps independent atomic gaps with different public scopes distinct", () => {
    const reasons = canonicalizeV9PublicReasons([
      publicReason("gap-a", ["gap-a"], "exit:a"), publicReason("gap-b", ["gap-b"], "exit:b"),
    ], { dedupeSourceGapIds: true });
    expect(reasons.map((reason) => reason.sourceGapId)).toEqual(["gap-a", "gap-b"]);
  });

  it("projects each atom with its controlling cause and excludes only the proven producer failure", () => {
    const projected = projectGapReasons({
      index: createV9GapIndex([gap("failed", failedProducerProof), gap("unreviewed")]),
      gapIds: ["failed", "unreviewed"], path: "exit:dex", fallbackCode: "missing-runtime-route-evidence",
      treatmentFor: (code, cause) => resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, code, cause).scoringDisposition,
    });
    expect(projected.map(({ cause, causeGapIds, responsibility, treatment }) => ({ cause, causeGapIds, responsibility, treatment }))).toEqual([
      { cause: "A", causeGapIds: ["failed"], responsibility: "producer-failed", treatment: "excluded-pipeline" },
      { cause: "U", causeGapIds: ["unreviewed"], responsibility: "unresearched", treatment: "bounded-uncertainty" },
    ]);
  });

  it("treats an unresolved fallback as U rather than a label-authorized pipeline outage", () => {
    const projected = projectGapReasons({
      index: createV9GapIndex([]), gapIds: ["not-in-cohort"], path: "exit:dex", fallbackCode: "unsupported-same-notional-route",
      treatmentFor: (code, cause) => resolveV9ReasonTreatment(V9_CANDIDATE_POLICY_V1, code, cause),
    });
    expect(projected[0]).toMatchObject({ cause: "U", responsibility: "unresearched", causeGapIds: ["not-in-cohort"] });
    expect(projected[0]!.treatment.scoringDisposition).toBe("bounded-uncertainty");
    expect(projected[0]!.treatment.critical).toBe(false);
  });
});
