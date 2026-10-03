import { describe, expect, it } from "vitest";
import { V9FactSetCoreV3Schema } from "../../types/safety-score-v9-facts";
import { buildV9EvidenceGapQueue } from "../safety-score-v9/evidence-gap-queue";
import {
  compileNativeV3FactSet, compileV9FactSetV3, coreFixture, createV9FactGapV3,
  createV9FactStatus, requiredV9Applicability, V9_CANDIDATE_POLICY_V1,
} from "./safety-score-v9-facts.fixture-support";

const cases = [
  { reasonCode: "partial-reserve-review", componentKey: "reserve-residual:unidentified",
    policyRuleId: "v9.backing.reserve-composition" },
  { reasonCode: "unreviewed-reserve-envelope", componentKey: "reserve-bound:unavailable-term",
    policyRuleId: "v9.backing.reserve-bounds" },
] as const;

function queueForGap(row: typeof cases[number], permittedPath: boolean) {
  const { v9FactSetDigest: _digest, ...compiledCore } = compileNativeV3FactSet(coreFixture());
  const core = V9FactSetCoreV3Schema.parse(compiledCore);
  const asset = core.assets[0]!;
  const gapId = `${asset.assetId}:gap:${row.componentKey}`;
  const status = createV9FactStatus({ applicability: requiredV9Applicability(row.policyRuleId),
    observationState: "missing", gapIds: [gapId] });
  asset.gaps.push(createV9FactGapV3({ gapId, reasonCode: row.reasonCode, ownerDomain: "backing",
    policyRuleId: row.policyRuleId, observationState: "missing", responsibility: "unresearched",
    path: permittedPath ? { kind: "local-component", componentKey: row.componentKey }
      : { kind: "methodology", componentKey: row.componentKey },
    message: "The missing reserve datum has not been researched." }));
  asset.reserveStatus = status;
  if (row.reasonCode === "partial-reserve-review") {
    asset.reserveExposures.forEach((exposure) => { exposure.weight *= 0.8; });
    asset.reserveResiduals = [{ residualId: "unidentified", weight: 0.2, status }];
  }
  const factSet = compileV9FactSetV3(core);
  return buildV9EvidenceGapQueue({ factSet, policy: V9_CANDIDATE_POLICY_V1 })
    .entries.find((entry) => entry.gapId === gapId)!;
}

describe("reserve remainder and unavailable-bound policy binding", () => {
  it.each(cases)("routes $reasonCode local evidence work without inventing a holding", (row) => {
    const entry = queueForGap(row, true);
    expect(entry.policyBindingIssues).toEqual([]);
    expect(entry).toMatchObject({ action: "collect-evidence", cause: "U",
      critical: false, treatment: "pillar", responsibility: "unresearched" });
  });

  it.each(cases)("still rejects a methodology path for $reasonCode evidence work", (row) => {
    const entry = queueForGap(row, false);
    expect(entry.policyBindingIssues).toEqual(["path-kind-not-permitted"]);
    expect(entry.action).toBe("reconcile-policy-binding");
  });
});
