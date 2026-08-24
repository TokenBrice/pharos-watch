import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  makeWorkerSafetyScoreV9Publication,
  makeWorkerV9Card,
  makeWorkerV9Pillars,
} from "../../test-helpers/report-cards-v9";
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

  it("reads an authenticated V5 publication emitted before NR binding caps were suppressed", async () => {
    const cap = {
      kind: "reason:missing-reserve-composition",
      limit: 55,
      source: "evidence" as const,
      reason: "Reserve composition is unavailable.",
      binding: true,
    };
    const publication = makeWorkerSafetyScoreV9Publication({
      cards: [
        makeWorkerV9Card({
          score: null,
          grade: "NR",
          qualityScore: null,
          pegMultiplier: null,
          pegAdjustedScore: null,
          pillars: makeWorkerV9Pillars({ backing: null, exit: null, control: null }),
          caps: [{ ...cap, binding: false }],
          bindingCap: null,
          nrReasons: [{
            code: "missing-reserve-composition",
            field: "pillars.backing",
            message: "Reserve composition is unavailable.",
            origin: "asset",
          }],
          reasonCodes: ["missing-reserve-composition"],
        }),
      ],
    });
    const envelope = JSON.parse(
      await serializeSafetyScoreV9Publication(publication),
    ) as Record<string, unknown>;
    const legacyPublication = JSON.parse(
      gunzipSync(Buffer.from(String(envelope.payload), "base64")).toString("utf8"),
    ) as typeof publication;
    legacyPublication.cards[0]!.caps = [cap];
    legacyPublication.cards[0]!.bindingCap = cap;
    const legacyPayload = stableJsonStringifyV1(legacyPublication);
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

  it("reads an authenticated pre-9.19 compressed publication without per-fact paths", async () => {
    const publication = makeWorkerSafetyScoreV9Publication({
      policyVersion: "9.18",
    });
    const envelope = JSON.parse(
      await serializeSafetyScoreV9Publication(publication),
    ) as Record<string, unknown>;
    const legacyPublication = JSON.parse(
      gunzipSync(Buffer.from(String(envelope.payload), "base64")).toString("utf8"),
    ) as typeof publication;
    for (const card of legacyPublication.cards) {
      delete (card.scoreTrace.evidenceResponsibility as { facts?: unknown }).facts;
      card.scoreTrace.evidenceResponsibility.summaries =
        card.scoreTrace.evidenceResponsibility.summaries.filter(
          (summary) => summary.responsibility !== "published-evidence-expired",
        );
    }
    const legacyPayload = stableJsonStringifyV1(legacyPublication);
    const compressed = gzipSync(Buffer.from(legacyPayload));
    const stored = stableJsonStringifyV1({
      ...envelope,
      payloadSha256: createHash("sha256").update(legacyPayload).digest("hex"),
      uncompressedBytes: Buffer.byteLength(legacyPayload),
      compressedBytes: compressed.byteLength,
      payload: compressed.toString("base64"),
    });

    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(
      legacyPublication,
    );
  });

  it("rejects post-9.19 serialization without per-fact paths", async () => {
    const publication = makeWorkerSafetyScoreV9Publication({
      policyVersion: "9.19",
    });
    delete (publication.cards[0]!.scoreTrace.evidenceResponsibility as {
      facts?: unknown;
    }).facts;

    await expect(
      serializeSafetyScoreV9Publication(publication),
    ).rejects.toThrow(/v9\.19\+ publications require per-fact disclosure paths/);
  });

  it("rejects a malformed retired stressStateDigest", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const stored = stableJsonStringifyV1({
      ...publication,
      cards: publication.cards.map((card) => ({
        ...card,
        stressStateDigest: "not-a-digest",
      })),
    });

    await expect(parseSafetyScoreV9Publication(stored)).rejects.toThrow(
      "Retired Safety Score v9 stress state digest is invalid",
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
