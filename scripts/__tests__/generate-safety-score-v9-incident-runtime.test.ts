import { describe, expect, it } from "vitest";
import source from "../../shared/data/safety-score-v9/incident-reviews-v1.json";
import generated from "../../shared/data/safety-score-v9/incident-runtime-v1.generated.json";
import { buildIncidentRuntime } from "../build-data/generate-safety-score-v9-incident-runtime";
import { projectNegativeIncidentReview } from "../lib/safety-score-v9-incident-runtime";

describe("incident runtime projection", () => {
  it("is current", () => {
    expect(buildIncidentRuntime(source)).toEqual(generated);
  });
  it("fails closed on missing research surfaces and future observations", () => {
    expect(() => projectNegativeIncidentReview({ ...source.negativeReviews[0], searchedSurfaces: [] })).toThrow();
    expect(() => projectNegativeIncidentReview({ ...source.negativeReviews[0], windowEndSec: Number.MAX_SAFE_INTEGER })).toThrow();
  });
});
