import policyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  compileNativeV3FactSet,
  coreFixture,
  createV9FactGap,
  createV9FactStatus,
  requiredV9Applicability,
  minimalAsset,
} from "@shared/lib/__tests__/safety-score-v9-facts.fixture-support";
import { internV9PublicWitnessTexts } from "@shared/lib/safety-score-v9/public-witness-texts";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import {
  makeReportCardsV9Card,
  makeReportCardsV9Pillars,
} from "@shared/test-utils/report-cards-v9";
import { makeCoin } from "./stablecoin-catalog.test-support";
import { describe, expect, it } from "vitest";
import {
  generateV9MissingDataRegistry,
  classifyV9ScoreProjectionWorkType,
} from "../maintenance/generate-safety-score-v9-missing-data-registry";

const SHARED_EXIT_MESSAGE = "Comparable exit route evidence is missing for the reviewed settlement window of this fixture.";

function generateExitProjectionFixture(
  reasonCodes: readonly ("unproven-settlement-bound" | "unsupported-same-notional-route")[],
  options: { intern?: boolean } = {},
) {
  const assetId = "exit-fixture";
  const core = coreFixture();
  const asset = minimalAsset(assetId);
  const gapId = `${assetId}:gap:exit-portfolio-coverage`;
  asset.gaps = [
    createV9FactGap({
      gapId,
      reasonCode: "incomplete-dex-route-coverage",
      ownerDomain: "exit",
      policyRuleId: "v9.exit.same-notional-route",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
      message: "Reviewed DEX pools do not all carry score-eligible exact route observations.",
      evidenceRefIds: ["evidence:base"],
    }),
  ];
  asset.exitStatus = createV9FactStatus({
    applicability: requiredV9Applicability("v9.exit.same-notional-route"),
    observationState: "bounded-unknown",
    evidenceRefIds: ["evidence:base"],
    gapIds: [gapId],
  });
  const compiledFacts = compileNativeV3FactSet({
    ...core,
    activeAssetIds: [assetId],
    assets: [asset],
  });
  const policy = loadV9MethodologyPolicy(policyAsset);
  const pillars = makeReportCardsV9Pillars({ backing: 80, exit: 80, control: 80 });
  pillars.exit.reasons = reasonCodes.map((code) => ({
    code,
    path: "exit:fixture-route",
    message: options.intern ? SHARED_EXIT_MESSAGE : `${code} fixture`,
  }));
  const plainCard = makeReportCardsV9Card({
    id: assetId,
    pillars,
    reasonCodes: [...reasonCodes].sort(),
  });
  const card = options.intern ? internV9PublicWitnessTexts(plainCard) : plainCard;

  return generateV9MissingDataRegistry({
    replay: {
      pipeline: {
        compiledFacts,
        candidate: {
          model: "v9-critical-path",
          schemaVersion: 7,
          lifecycle: "active",
          candidateId: "safety-score-v9:fixture",
          policyVersion: policy.policy.releaseVersion,
          publicationGenerationId: "report-cards:v9:fixture",
          baseInputGenerationId: compiledFacts.baseInputGenerationId,
          factSetDigest: compiledFacts.v9FactSetDigest,
          resultDigest: "b".repeat(64),
          policy: {
            id: policy.policy.policyId,
            semanticDigest: policy.semanticDigest,
          },
          evaluationBuildDigest: "c".repeat(64),
          sourceGenerations: { fixture: "fixture:g1" },
          asOfSec: compiledFacts.asOfSec,
          publishedAtSec: compiledFacts.asOfSec,
          completeness: {
            expectedCount: 1,
            ratedCount: 1,
            notRatedCount: 0,
            notRatedIds: [],
            pipelineGapCount: 0,
            pipelineGapIds: [],
          },
          foreignCauseGaps: [],
          cards: [card],
        },
      },
    },
    policy: policyAsset,
    catalogEntries: [{
      id: assetId,
      file: `shared/data/stablecoins/coins/${assetId}.json`,
      coin: makeCoin(assetId),
    }],
  });
}

describe("Safety Score v9 missing-data work routing", () => {
  it("associates projection coverage with the exact work type when one stream mixes EXIT work types", () => {
    const registry = generateExitProjectionFixture([
      "unsupported-same-notional-route",
      "unproven-settlement-bound",
    ]);
    const stablecoin = registry.stablecoins[0]!;
    const compiledTaskIds = stablecoin.missingItems
      .filter((item) => item.taskSource === "compiled-fact-gap")
      .map((item) => item.taskId);
    const supplementalTaskIds = stablecoin.missingItems
      .filter((item) => item.taskSource === "score-projection-gap")
      .map((item) => item.taskId);
    const dexProjection = stablecoin.scoreProjectionGaps.find(
      (gap) => gap.reasonCode === "unsupported-same-notional-route",
    );
    const settlementProjection = stablecoin.scoreProjectionGaps.find(
      (gap) => gap.reasonCode === "unproven-settlement-bound",
    );

    // EXIT_DEX_COVERAGE and EXIT_SETTLEMENT_BOUND share the EXIT stream, but the
    // compiled DEX task covers only the DEX projection; the settlement
    // projection is covered by its own supplemental task, never by the DEX task.
    expect(compiledTaskIds).toHaveLength(1);
    expect(supplementalTaskIds).toHaveLength(1);
    expect(dexProjection).toMatchObject({
      workType: "EXIT_DEX_COVERAGE",
      coveredByTaskIds: compiledTaskIds,
      requiresSupplementalTask: false,
    });
    expect(settlementProjection).toMatchObject({
      workType: "EXIT_SETTLEMENT_BOUND",
      coveredByTaskIds: supplementalTaskIds,
      requiresSupplementalTask: true,
    });
    expect(registry.summary.scoreProjectionReasonNeedingSupplementCount).toBe(1);
  });

  it("fails closed when a score projection reason has no typed routing metadata", () => {
    expect(() => classifyV9ScoreProjectionWorkType("unregistered-projection-reason")).toThrow(
      /Missing agent work-type definition/,
    );
  });
});
