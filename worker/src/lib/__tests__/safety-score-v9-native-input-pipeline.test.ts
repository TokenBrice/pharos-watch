import { describe, expect, it } from "vitest";
import {
  createNativeSafetyScoreV9FullRegistryInput,
  createSafetyScoreV9FullRegistryInput,
} from "./fixtures/safety-score-v9-full-registry-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";

// Double the 30s budget the other full-pipeline V9 suites use. Those run one
// full-registry compile+evaluate pass per test; the equivalence test below runs
// two (legacy and native) in a single test, and under the v8 instrumentation in
// `coverage:critical` that doubled work measured 40.3s on a CI runner. The
// uninstrumented lane is comfortably inside 30s, so this budget covers the
// coverage lane rather than a real slowdown.
const V9_EVALUATION_TEST_TIMEOUT_MS = 60_000;

function cardsById(candidate: { cards: readonly { id: string; grade: string; score: number | null }[] }) {
  return new Map(candidate.cards.map((card) => [card.id, { grade: card.grade, score: card.score }]));
}

describe("native v4 input through the V9 candidate pipeline", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("compiles, evaluates, and projects a full publication end to end", () => {
    const input = createNativeSafetyScoreV9FullRegistryInput();

    const pipeline = buildSafetyScoreV9Candidate({
      fixedInput: input,
      publishedAtSec: input.clockSec,
    });

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
      // Snapshot value at FULL_REGISTRY_CLOCK_SEC, which the fixture derives from
      // the newest curated review date + 24h. Re-pin when curation advances the
      // clock onto a different shock-coverage measurement: the 2026-08-31
      // curation batch moved the clock to 2026-09-01T00:00:00Z and this ratio
      // with it, from 0.235898946423.
      // Re-pinned 2026-09-01: bd-basedollar's blacklistability review was
      // re-derived with a current reviewedAt, which feeds the evidence-age term.
      stressLiquidationCoverageRatio: 0.190902714164,
    });
  });

  it("scores the native projection identically to the exact input it projects from", () => {
    const legacy = createSafetyScoreV9FullRegistryInput();
    const native = createNativeSafetyScoreV9FullRegistryInput();

    const legacyCandidate = buildSafetyScoreV9Candidate({
      fixedInput: legacy,
      publishedAtSec: legacy.clockSec,
    }).candidate;
    const nativeCandidate = buildSafetyScoreV9Candidate({
      fixedInput: native,
      publishedAtSec: native.clockSec,
    }).candidate;

    // Dropping bluechip, blacklist, drift, the non-current chain buckets, and
    // the V8 DEX row fields must not move a single grade or score.
    expect(cardsById(nativeCandidate)).toEqual(cardsById(legacyCandidate));
  });
});
