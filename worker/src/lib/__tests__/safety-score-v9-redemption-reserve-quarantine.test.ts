import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { captureRedemptionReserveQuarantine } from "../safety-score-v9/redemption-reserve-quarantine";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const ASSET = "usdc-circle";

function compile(quarantined: boolean) {
  const original = makeV9FixedInput({ assetId: ASSET, clockSec: Date.UTC(2026, 6, 13) / 1000 });
  const quarantine = captureRedemptionReserveQuarantine({
    assetId: ASSET, redemptionGenerationId: original.redemptionGenerationId,
    routeFamily: getRedemptionBackstopConfig(ASSET)!.routeFamily, reason: "freshness-unverified", clockSec: original.clockSec,
  });
  const fixed = normalizeFixedInput({
    ...original, baseInputGenerationId: undefined,
    ...(quarantined ? { pipelineGapByAssetId: { [ASSET]: [quarantine] } } : {}),
  });
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
    assetId: ASSET, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint,
  }));
  return { compiled, quarantine };
}

describe("redemption rows quarantined for inadmissible consumed reserve evidence", () => {
  it("keeps a producer-failed redemption rail instead of reading the withheld row as an absent route", () => {
    expect(compile(false).compiled.assets[0]!.exitRoutes.some((route) => route.lane === "redemption")).toBe(false);

    const { compiled, quarantine } = compile(true);
    const asset = compiled.assets[0]!;
    const route = asset.exitRoutes.find((candidate) => candidate.lane === "redemption")!;
    expect(route).toMatchObject({ coverageClass: "diagnostic", scoreEligible: false, capacityCurve: [] });
    expect(route.status.observationState).toBe("missing");
    const gap = asset.gaps.find((candidate) => route.factorStatuses.capacity!.gapIds.includes(candidate.gapId))!;
    expect(gap).toMatchObject({
      responsibility: "producer-failed",
      causeProof: { cause: "A", producerState: "producer-failed", rejectionCode: "redemption-reserve-input-freshness-unverified" },
    });
    expect(asset.evidence.find((row) => row.evidenceId === quarantine.evidence.evidenceId)).toEqual(quarantine.evidence);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.exit.causeGapIds).toContain(gap.gapId);
  });
});
