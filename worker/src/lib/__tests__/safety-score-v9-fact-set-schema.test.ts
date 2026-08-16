import { describe, expect, it } from "vitest";
import { RejectionSchema } from "../safety-score-v9-fact-set-schema";

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
