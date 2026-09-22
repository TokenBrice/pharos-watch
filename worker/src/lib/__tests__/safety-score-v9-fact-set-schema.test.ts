import { describe, expect, it } from "vitest";
import { RejectionSchema, SafetyScoreV9FactSetExtensionV2Schema } from "../safety-score-v9/fact-set-schema";
import { makeV9Extension } from "../../test-helpers/v9-fixed-input";

describe("Safety Score V9 fact-set input primitives", () => {
  it("rejects surrounding whitespace instead of normalizing identity-bearing text", () => {
    expect(
      RejectionSchema.safeParse({
        code: " producer-failed ",
        reason: "Canonical evidence reason",
        rejectedAtSec: 1_783_891_200,
      }).success,
    ).toBe(false);
  });

  it("accepts already-canonical identity-bearing text without transformation", () => {
    const value = {
      code: "producer-failed",
      reason: "Canonical evidence reason",
      rejectedAtSec: 1_783_891_200,
    };
    expect(RejectionSchema.parse(value)).toEqual(value);
  });
});

describe("Safety Score V9 fact-set refinement rejections", () => {
  it("rejects researchEvidence.observedAtSec later than compiledAtSec", () => {
    const extension = makeV9Extension();
    extension.assets[0]!.researchEvidence = [{
      evidenceKey: "future-observation",
      sourceId: "fixture.future-observation",
      observedAtSec: extension.compiledAtSec + 1,
      publishedAtSec: null,
      url: "https://example.com/future-observation",
      contentSha256: "a".repeat(64),
      confidence: "verified",
      maxAgeSec: 86_400,
    }];

    expect(() => SafetyScoreV9FactSetExtensionV2Schema.parse(extension)).toThrow(
      "Research evidence observation cannot be later than the extension clock",
    );
  });
});
