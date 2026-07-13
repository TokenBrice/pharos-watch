import { describe, expect, it } from "vitest";
import {
  SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION,
  SafetyScoreV9AdminResponseSchema,
} from "../safety-score-v9-admin";

describe("Safety Score v9 admin response contract", () => {
  it("accepts the reason-coded unavailable state and rejects undeclared fields", () => {
    expect(
      SafetyScoreV9AdminResponseSchema.parse({
        schemaVersion: SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION,
        status: "unavailable",
        reason: "shadow-envelope-unavailable",
      }),
    ).toEqual({ schemaVersion: 1, status: "unavailable", reason: "shadow-envelope-unavailable" });

    expect(() =>
      SafetyScoreV9AdminResponseSchema.parse({
        schemaVersion: 1,
        status: "unavailable",
        reason: "shadow-envelope-unavailable",
        partialEnvelope: {},
      }),
    ).toThrow();
  });
});
