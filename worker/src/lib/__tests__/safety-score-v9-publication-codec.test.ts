import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
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

  it("reads the last V5 publication emitted before stressStateDigest retired", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const envelope = JSON.parse(
      await serializeSafetyScoreV9Publication(publication),
    ) as Record<string, unknown>;
    const priorPayload = JSON.parse(
      gunzipSync(Buffer.from(String(envelope.payload), "base64")).toString("utf8"),
    ) as typeof publication;
    const legacyPayload = stableJsonStringifyV1({
      ...priorPayload,
      cards: priorPayload.cards.map((card) => ({
        ...card,
        stressStateDigest: "a".repeat(64),
      })),
    });
    const compressed = gzipSync(Buffer.from(legacyPayload));
    const stored = stableJsonStringifyV1({
      ...envelope,
      payloadSha256: createHash("sha256").update(legacyPayload).digest("hex"),
      uncompressedBytes: Buffer.byteLength(legacyPayload),
      compressedBytes: compressed.byteLength,
      payload: compressed.toString("base64"),
    });

    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(
      publication,
    );
  });

  it("rejects the retired pre-cutover legacy envelope shapes", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const legacyCandidateWrapper = stableJsonStringifyV1({
      candidate: publication,
      retiredReleaseEvidence: [],
    });

    await expect(
      parseSafetyScoreV9Publication(legacyCandidateWrapper),
    ).rejects.toThrow();

    const stored = await serializeSafetyScoreV9Publication(publication);
    const shadowKindEnvelope = stableJsonStringifyV1({
      ...JSON.parse(stored),
      kind: "safety-score-v9-shadow-envelope",
    });

    await expect(
      parseSafetyScoreV9Publication(shadowKindEnvelope),
    ).rejects.toThrow();
  });
});
