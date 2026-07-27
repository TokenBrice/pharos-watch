import { describe, expect, it } from "vitest";
import {
  buildSafetyScoreV9InputIdentity,
  safetyScoreV9InputIdentitiesMatch,
} from "../safety-score-v9-input-identity";

const input = {
  methodologyVersion: "9.0",
  baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
  publicationGenerationId: "report-cards:9.0:1785168000",
};

describe("Safety Score V9 input identity", () => {
  it("builds the compatible fixed-input identity", () => {
    expect(buildSafetyScoreV9InputIdentity(input)).toMatchObject({
      model: "v8",
      schemaVersion: 1,
      methodologyVersion: "9.0",
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.publicationGenerationId,
    });
  });

  it("requires every persisted identity field to match", () => {
    const identity = buildSafetyScoreV9InputIdentity(input);

    expect(safetyScoreV9InputIdentitiesMatch(identity, identity)).toBe(true);
    expect(
      safetyScoreV9InputIdentitiesMatch(identity, {
        ...identity,
        publicationGenerationId: "report-cards:9.0:1785168060",
      }),
    ).toBe(false);
  });
});
