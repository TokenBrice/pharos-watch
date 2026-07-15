import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput, type ReportCardsFixedInputDraft } from "../report-cards-fixed-input";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import miniCapture from "./fixtures/safety-score-v9-rateable-mini-capture.json";

const ASSET_ID = "usdc-circle";

function freshDraft(): ReportCardsFixedInputDraft {
  return structuredClone(miniCapture.draft) as unknown as ReportCardsFixedInputDraft;
}

function compileAsset(draft: ReportCardsFixedInputDraft) {
  const fixedInput = createReportCardsFixedInput(draft);
  const extension = buildSafetyScoreV9BaselineExtension(fixedInput);
  const factSet = compileSafetyScoreV9FactSetFromFixedInput(fixedInput, extension);
  return {
    asset: factSet.assets.find((candidate) => candidate.assetId === ASSET_ID)!,
    evaluated: evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1).assets.find(
      (candidate) => candidate.assetId === ASSET_ID,
    )!,
  };
}

describe.skip("VERITAS-II finding stale known-empty DEX coverage is treated as current", () => {
  it("retains the DEX observation time and bounds a stale empty surface", () => {
    const draft = freshDraft();
    const observedAtSec = draft.clockSec - 100_000;
    draft.dexGenerationId = `dex-liquidity-${observedAtSec}`;
    draft.liquidityStale = true;
    draft.inputFreshness.dexLiquidity = {
      updatedAt: observedAtSec,
      ageSeconds: draft.clockSec - observedAtSec,
      stale: true,
    };
    for (const row of Object.values(draft.dexLiqMap)) row.updatedAt = observedAtSec;

    const dex = draft.dexLiqMap[ASSET_ID]!;
    dex.exitRouteObservations = [];
    dex.exitRouteObservationCoverage = {
      status: "populated",
      capabilityMatrixVersion: "veritas-ii-known-empty-v1",
      retainedPoolCount: 0,
      observationCount: 0,
      scoreEligibleObservationCount: 0,
      scoreEligiblePoolCount: 0,
      unsupportedPoolCount: 0,
      evidenceCounts: {},
      unsupportedReasons: {},
    };
    delete draft.redemptionBackstopMap[ASSET_ID];

    const { asset, evaluated } = compileAsset(draft);
    const evidence = asset.evidence.find((reference) =>
      asset.exitStatus.evidenceRefIds.includes(reference.evidenceId),
    )!;

    expect(evidence.observedAtSec).toBe(observedAtSec);
    expect(evidence.freshness.state).toBe("stale");
    expect(asset.exitStatus.observationState).toBe("stale");
    expect(evaluated.exit.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
  });
});

describe.skip("VERITAS-II finding a diagnostic redemption route completes unknown DEX coverage", () => {
  it("keeps an unknown zero-pool surface bounded when only a score-ineligible route exists", () => {
    const draft = freshDraft();
    const dex = draft.dexLiqMap[ASSET_ID]!;
    dex.exitRouteObservations = [];
    dex.exitRouteObservationCoverage = {
      status: "unknown",
      capabilityMatrixVersion: "veritas-ii-unknown-surface-v1",
      retainedPoolCount: 0,
      observationCount: 0,
      scoreEligibleObservationCount: 0,
      scoreEligiblePoolCount: 0,
      unsupportedPoolCount: 0,
      evidenceCounts: {},
      unsupportedReasons: {},
    };

    const { asset, evaluated } = compileAsset(draft);

    expect(asset.exitRoutes).toHaveLength(1);
    expect(asset.exitRoutes[0]!.scoreEligible).toBe(false);
    expect(asset.exitStatus.observationState).toBe("bounded-unknown");
    expect(evaluated.exit.score).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore);
    expect(evaluated.exit.reasons).toContain("missing-same-notional-route");
    expect(evaluated.exit.reasons).not.toContain("no-viable-exit-path");
  });
});
