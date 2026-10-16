import { describe, expect, it } from "vitest";
import source from "../../shared/data/safety-score-v9/incident-reviews-v1.json";
import { projectNegativeIncidentReview } from "../lib/safety-score-v9-incident-runtime";

describe("incident runtime projection", () => {
  it("fails closed on missing research surfaces and future observations", () => {
    expect(() => projectNegativeIncidentReview({ ...source.negativeReviews[0], searchedSurfaces: [] })).toThrow();
    expect(() => projectNegativeIncidentReview({ ...source.negativeReviews[0], windowEndSec: Number.MAX_SAFE_INTEGER })).toThrow();
  });
});
