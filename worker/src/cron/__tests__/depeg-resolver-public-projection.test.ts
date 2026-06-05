import { describe, expect, it } from "vitest";
import { normalizeErratumRecord } from "../depeg-resolver/public-projection";

describe("depeg-resolver public projection", () => {
  it("normalizes erratum rows from storage", () => {
    expect(normalizeErratumRecord({
      id: 99,
      public_prediction_id: 7,
      incident_key: "usdc-circle:42:below",
      event_id: 42,
      assessment_id: 70,
      reason: "event_identity_error",
      created_at: 1_779_984_600,
      operator_note: "Source event was repaired after first publication",
      row_hash_before: "a".repeat(64),
      replacement_assessment_id: 71,
      replacement_row_hash: "b".repeat(64),
      created_by: "operator",
    })).toEqual({
      id: 99,
      state: "invalidated",
      publicPredictionId: 7,
      incidentKey: "usdc-circle:42:below",
      eventId: 42,
      assessmentId: 70,
      reason: "event_identity_error",
      createdAt: 1_779_984_600,
      operatorNote: "Source event was repaired after first publication",
      rowHashBefore: "a".repeat(64),
      replacementAssessmentId: 71,
      replacementRowHash: "b".repeat(64),
      createdBy: "operator",
    });
  });

  it("drops malformed erratum rows", () => {
    expect(normalizeErratumRecord({
      id: 99,
      public_prediction_id: 7,
      incident_key: "usdc-circle:42:below",
      event_id: 42,
      assessment_id: 70,
      reason: "unknown_reason",
      created_at: 1_779_984_600,
      operator_note: "bad reason",
      created_by: "operator",
    })).toBeNull();
  });
});
