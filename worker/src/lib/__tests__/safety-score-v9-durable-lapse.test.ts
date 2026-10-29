import { describe, expect, it, vi } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { MintAuthorityProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import { SCOPE_CONTROLLER } from "@shared/lib/__tests__/safety-score-v9-control-scope.test-support";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import {
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9FixedInput,
} from "../../test-helpers/v9-fixed-input";
import { cappedMinterMeta, metaMap } from "./safety-score-v9-fact-set.test-support";
import candidatePolicyAsset from "../../../../shared/data/safety-score-v9/methodology-policy-candidate-v1.json";

const CLOCK_SEC = Date.parse("2027-02-01T00:00:00.000Z") / 1_000;
const LAPSED_REVIEWED_AT = "2026-10-01";
const LAPSED_REVIEWED_AT_SEC = Date.parse(`${LAPSED_REVIEWED_AT}T00:00:00.000Z`) / 1_000;
const FRESH_REVIEWED_AT = "2027-01-20";

function compileWithQuestion(reviewedAt: string | null) {
  const fixed = makeV9FixedInput({ clockSec: CLOCK_SEC });
  const metadata = cappedMinterMeta();
  // The whole-profile review stays current; only the scoped question lapses.
  metadata.mintAuthority!.review.reviewedAt = "2027-01-25";
  if (reviewedAt !== null) {
    metadata.mintAuthority!.review.scopedQuestions = [{
      controlRef: SCOPE_CONTROLLER,
      subject: "key-custody-independence",
      question: "Which entity protects this exact signer key and its independent approval policy?",
      reviewedAt,
      reviewer: "Fixture reviewer",
    }];
  }
  metadata.mintAuthority = MintAuthorityProfileSchema.parse(metadata.mintAuthority);
  const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(metadata) });
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
  const asset = compiled.assets[0]!;
  const control = asset.controls.find((row) => row.authority?.authorityKey === SCOPE_CONTROLLER)!;
  return { evaluated: evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!, asset, control };
}

describe("Safety Score v9 durable custody lapse (documentation class)", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("retains a lapsed custody question as a stale factor gap with its original review date", () => {
    const { asset, control } = compileWithQuestion(LAPSED_REVIEWED_AT);
    expect(control.scopedQuestionFresh).toBeUndefined();
    expect(control.scopedQuestionSubject).toBe("key-custody-independence");
    const factor = control.factorStatuses?.keyCustody;
    expect(factor?.observationState).toBe("stale");
    const gap = asset.gaps.find((row) => row.gapId === factor?.gapIds[0])!;
    expect(gap).toMatchObject({
      observationState: "stale",
      reasonCode: "unresolved-control-identity",
      causeScope: { factorKey: "keyCustody", requiredDatum: "keyCustody" },
    });
    // The gap identity replaces the fresh missing datum in place; the authored
    // review date survives as evidence observation, never re-dated to the clock.
    expect(gap.gapId).toBe(`alpha:gap:control:${control.controlKey}:keyCustody`);
    const reviewed = asset.evidence.filter((row) => gap.evidenceRefIds.includes(row.evidenceId))
      .find((row) => row.sourceId === "stablecoin-meta.mint-authority.scoped-question")!;
    expect(reviewed).toMatchObject({
      observedAtSec: LAPSED_REVIEWED_AT_SEC,
      freshness: { state: "stale" },
    });
    expect(gap.message).toContain(LAPSED_REVIEWED_AT);
  });

  it("keeps a fresh custody question on today's bounded path", () => {
    const { control } = compileWithQuestion(FRESH_REVIEWED_AT);
    expect(control.scopedQuestionFresh).toBe(true);
    expect(control.factorStatuses?.keyCustody?.observationState).toBe("missing");
  });

  it("changes no control score, evidence level or final grade versus no question and a fresh question", () => {
    const base = compileWithQuestion(null);
    const fresh = compileWithQuestion(FRESH_REVIEWED_AT);
    const lapsed = compileWithQuestion(LAPSED_REVIEWED_AT);
    for (const pillar of ["backing", "exit", "control"] as const) {
      expect(lapsed.evaluated.scoreInput.pillars[pillar].evidenceLevel)
        .toBe(base.evaluated.scoreInput.pillars[pillar].evidenceLevel);
      expect(lapsed.evaluated.scoreInput.pillars[pillar].evidenceLevel)
        .toBe(fresh.evaluated.scoreInput.pillars[pillar].evidenceLevel);
    }
    expect(lapsed.evaluated.control.score).toBe(base.evaluated.control.score);
    expect(lapsed.evaluated.trace.finalScore).toBe(base.evaluated.trace.finalScore);
    expect(lapsed.evaluated.trace.finalGrade).toBe(base.evaluated.trace.finalGrade);
  });

  it("drops the lapsed question exactly like today when the policy retention switch is off", async () => {
    const policy = structuredClone(candidatePolicyAsset);
    const documentation = policy.semantic.evidence.documentation!;
    documentation.retainExpiredScopedQuestions = false;
    documentation.reasons.find((entry) => entry.reason === "no-scoring-path")!.retention = "recompute-per-capture";
    vi.resetModules();
    vi.doMock("../../../../shared/data/safety-score-v9/methodology-policy-candidate-v1.json", () => ({ default: policy }));
    try {
      // Dynamic imports are the point of this test: the mocked policy must be
      // applied before these modules (and their policy envelope) are created.
      const { buildSafetyScoreV9BaselineExtension: build } = await import("../safety-score-v9/extension");
      const { compileSafetyScoreV9FactSetFromFixedInput: compile } = await import("../safety-score-v9/fact-set");
      const fixed = makeV9FixedInput({ clockSec: CLOCK_SEC });
      const metadata = cappedMinterMeta();
      metadata.mintAuthority!.review.reviewedAt = "2027-01-25";
      metadata.mintAuthority!.review.scopedQuestions = [{
        controlRef: SCOPE_CONTROLLER,
        subject: "key-custody-independence",
        question: "Which entity protects this exact signer key and its independent approval policy?",
        reviewedAt: LAPSED_REVIEWED_AT,
        reviewer: "Fixture reviewer",
      }];
      metadata.mintAuthority = MintAuthorityProfileSchema.parse(metadata.mintAuthority);
      const extension = build(fixed, { metaById: metaMap(metadata) });
      const asset = compile(fixed, extension).assets[0]!;
      const control = asset.controls.find((row) => row.authority?.authorityKey === SCOPE_CONTROLLER)!;
      // Today's behavior: the lapsed question leaves no marker and no datum.
      expect(control.scopedQuestionSubject).toBeUndefined();
      expect(control.factorStatuses?.keyCustody).toBeUndefined();
      expect(asset.gaps.some((gap) => gap.causeScope?.factorKey === "keyCustody")).toBe(false);
    } finally {
      vi.doUnmock("../../../../shared/data/safety-score-v9/methodology-policy-candidate-v1.json");
      vi.resetModules();
    }
  });
});
