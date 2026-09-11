import { beforeAll, describe, expect, it } from "vitest";
import {
  createNativeSafetyScoreV9FullRegistryInput,
  createSafetyScoreV9FullRegistryInput,
} from "./fixtures/safety-score-v9-full-registry-input";
import { buildSafetyScoreV9Candidate, type SafetyScoreV9CandidatePipelineResult } from "../safety-score-v9/candidate";

// The shared setup evaluates both capture lanes. Preserve the coverage budget
// for two full-registry compile/evaluate passes without repeating the native pass.
const V9_EVALUATION_TEST_TIMEOUT_MS = 60_000;

function cardsById(candidate: { cards: readonly { id: string; grade: string; score: number | null }[] }) {
  return new Map(candidate.cards.map((card) => [card.id, { grade: card.grade, score: card.score }]));
}

describe("native v4 input through the V9 candidate pipeline", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  const input = createNativeSafetyScoreV9FullRegistryInput();
  const legacy = createSafetyScoreV9FullRegistryInput();
  let pipeline: Readonly<SafetyScoreV9CandidatePipelineResult>;
  let legacyCandidate: SafetyScoreV9CandidatePipelineResult["candidate"];
  beforeAll(() => {
    pipeline = buildSafetyScoreV9Candidate({ fixedInput: input, publishedAtSec: input.clockSec });
    legacyCandidate = buildSafetyScoreV9Candidate({ fixedInput: legacy, publishedAtSec: legacy.clockSec }).candidate;
  }, V9_EVALUATION_TEST_TIMEOUT_MS);

  it("compiles, evaluates, and projects a full publication end to end", () => {

    expect(pipeline.compiledFacts.assets.length).toBe(input.activeAssetIds.length);
    expect(pipeline.candidate.cards.length).toBe(input.activeAssetIds.length);
    // The published id format is a namespace shared with the retained v3 lane.
    expect(pipeline.compiledFacts.baseInputGenerationId).toMatch(/^report-cards-input:v1:[a-f0-9]{64}$/);
    expect(pipeline.compiledFacts.baseInputGenerationId).toBe(input.baseInputGenerationId);
    expect(pipeline.compilerFactSchemaIdentity.fixedInputSchemaVersion).toBe(4);
    expect(pipeline.producerCapabilityIdentity.inputContractVersions.fixedInput).toBe(4);

    const baseDollarCard = pipeline.candidate.cards.find((card) => card.id === "bd-basedollar");
    const baseDollarFacts = pipeline.compiledFacts.assets.find((asset) => asset.assetId === "bd-basedollar");
    expect(baseDollarCard?.grade).not.toBe("NR");
    expect(baseDollarCard?.score).not.toBeNull();
    expect(baseDollarFacts?.gaps.map((gap) => gap.reasonCode)).not.toContain("missing-mechanism-review");
    expect(baseDollarFacts?.gaps.map((gap) => gap.reasonCode)).not.toContain("missing-oracle-review");
    expect(baseDollarFacts?.mechanismRiskReview.status.observationState).toBe("known");
    expect(baseDollarFacts?.controlStatus.observationState).toBe("known");
    expect(baseDollarFacts?.cdpStressCoverage).toMatchObject({
      complete: true,
      exactReplayPassed: true,
    });
    expect(baseDollarFacts?.cdpStressCoverage?.stressLiquidationCoverageRatio).toBeGreaterThan(0);
    expect(baseDollarFacts?.cdpStressCoverage?.stressLiquidationCoverageRatio).toBeLessThan(1);
  });

  it("scores the native projection identically to the exact input it projects from", () => {

    // Dropping bluechip, blacklist, drift, the non-current chain buckets, and
    // the V8 DEX row fields must not move a single grade or score.
    expect(cardsById(pipeline.candidate)).toEqual(cardsById(legacyCandidate));
  });
});
