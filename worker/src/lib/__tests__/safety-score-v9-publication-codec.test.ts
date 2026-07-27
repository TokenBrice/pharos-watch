import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { describe, expect, it } from "vitest";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import {
  parseSafetyScoreV9Publication,
  serializeSafetyScoreV9Publication,
} from "../safety-score-v9-publication-codec";

describe("Safety Score V9 publication codec", () => {
  it("round-trips the canonical compressed publication", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const stored = await serializeSafetyScoreV9Publication(publication);

    expect(JSON.parse(stored)).toMatchObject({
      storageSchemaVersion: 1,
      kind: "safety-score-v9-publication",
      encoding: "gzip-base64",
    });
    await expect(
      parseSafetyScoreV9Publication(stored),
    ).resolves.toEqual(publication);
  });

  it("projects the one-release legacy envelope to its accepted publication", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const legacy = stableJsonStringifyV1({
      candidate: publication,
      retiredReleaseEvidence: [],
    });

    await expect(
      parseSafetyScoreV9Publication(legacy),
    ).resolves.toEqual(publication);
  });
});
