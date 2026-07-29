import { describe, expect, it } from "vitest";
import type {
  SafetyScoreV8PublicationIdentity,
  SafetyScoreV9PublicationIdentity,
} from "../../types/safety-score-publication";
import {
  type SafetyScorePublicationIdentityContract,
  safetyScorePublicationIdentitiesAreComparable,
  safetyScorePublicationIdentitiesMatch,
} from "../safety-score-publication";

const digest = (character: string) => character.repeat(64);

function v8Identity(
  overrides: Partial<SafetyScoreV8PublicationIdentity> = {},
): SafetyScoreV8PublicationIdentity {
  return {
    model: "v8",
    schemaVersion: 1,
    methodologyVersion: "8.17",
    evaluationBuildDigest: digest("a"),
    baseInputGenerationId: `report-cards-input:v1:${digest("b")}`,
    publicationGenerationId: "report-cards:8.17:100",
    ...overrides,
  };
}

function v9Identity(
  overrides: Partial<SafetyScoreV9PublicationIdentity> = {},
): SafetyScoreV9PublicationIdentity {
  return {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "9.0",
    policyId: "safety-score-v9",
    policyDigest: digest("c"),
    evaluationBuildDigest: digest("d"),
    baseInputGenerationId: `report-cards-input:v1:${digest("e")}`,
    publicationGenerationId: "report-cards:v9:100",
    ...overrides,
  };
}

describe("Safety Score publication identity comparisons", () => {
  it("requires an exact V8 publication identity match", () => {
    const identity = v8Identity() satisfies SafetyScorePublicationIdentityContract;

    expect(safetyScorePublicationIdentitiesMatch(identity, { ...identity })).toBe(true);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v8Identity({ baseInputGenerationId: `report-cards-input:v1:${digest("f")}` }),
      ),
    ).toBe(false);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v8Identity({ publicationGenerationId: "report-cards:8.17:101" }),
      ),
    ).toBe(false);
  });

  it("allows organic V8 generations only within the same evaluator series", () => {
    const identity = v8Identity();

    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v8Identity({
          baseInputGenerationId: `report-cards-input:v1:${digest("f")}`,
          publicationGenerationId: "report-cards:8.17:101",
        }),
      ),
    ).toBe(true);
    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v8Identity({ evaluationBuildDigest: digest("f") }),
      ),
    ).toBe(false);
  });

  it("binds V9 matches and organic comparisons to the policy identity", () => {
    const identity = v9Identity() satisfies SafetyScorePublicationIdentityContract;

    expect(safetyScorePublicationIdentitiesMatch(identity, { ...identity })).toBe(true);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v9Identity({ publicationGenerationId: "report-cards:v9:101" }),
      ),
    ).toBe(false);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v9Identity({ policyDigest: digest("f") }),
      ),
    ).toBe(false);
    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v9Identity({
          baseInputGenerationId: `report-cards-input:v1:${digest("f")}`,
          publicationGenerationId: "report-cards:v9:101",
        }),
      ),
    ).toBe(true);
    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v9Identity({ policyId: "safety-score-v9-other-policy" }),
      ),
    ).toBe(false);
  });

  it("never compares identities across model boundaries", () => {
    expect(safetyScorePublicationIdentitiesMatch(v8Identity(), v9Identity())).toBe(false);
    expect(safetyScorePublicationIdentitiesAreComparable(v8Identity(), v9Identity())).toBe(false);
  });
});
