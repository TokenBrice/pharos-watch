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
  publicationIdentityFromStorageEnvelope,
  serializeSafetyScoreV9Publication,
} from "../safety-score-v9/publication-codec";

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

  it("rejects invalid evidence inside a compressed publication with a valid payload digest", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(publication));
    publication.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = -1;
    const payload = stableJsonStringifyV1(publication);
    const compressed = gzipSync(Buffer.from(payload));
    const stored = stableJsonStringifyV1({
      ...envelope,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      uncompressedBytes: Buffer.byteLength(payload),
      compressedBytes: compressed.byteLength,
      payload: Buffer.from(compressed).toString("base64"),
    });

    await expect(parseSafetyScoreV9Publication(stored)).rejects.toThrow(/totalFactCount/);
  });

  it("reads the last V5 publication emitted before stressStateDigest retired", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const envelope = JSON.parse(
      await serializeSafetyScoreV9Publication(publication),
    ) as Record<string, unknown>;
    const priorPayload = JSON.parse(
      Buffer.from(gunzipSync(Buffer.from(String(envelope.payload), "base64"))).toString("utf8"),
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
      payload: Buffer.from(compressed).toString("base64"),
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
      Buffer.from(gunzipSync(Buffer.from(String(envelope.payload), "base64"))).toString("utf8"),
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
      payload: Buffer.from(compressed).toString("base64"),
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
      Buffer.from(gunzipSync(Buffer.from(String(envelope.payload), "base64"))).toString("utf8"),
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
      payload: Buffer.from(compressed).toString("base64"),
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

  it("reads a stored publication that has per-fact paths but predates the sixth owner", async () => {
    // The exact shape that took production down on the 9.4 release: written by
    // a post-9.19 Worker, so `facts` is present, but by a pre-9.4 one, so the
    // sixth responsibility owner is absent. Keying compatibility on `facts`
    // alone rejected it and the canonical publication became unreadable.
    const publication = makeWorkerSafetyScoreV9Publication({
      policyVersion: "9.35",
    });
    const envelope = JSON.parse(
      await serializeSafetyScoreV9Publication(publication),
    ) as Record<string, unknown>;
    const storedPublication = JSON.parse(
      Buffer.from(gunzipSync(Buffer.from(String(envelope.payload), "base64"))).toString("utf8"),
    ) as typeof publication;
    for (const card of storedPublication.cards) {
      card.scoreTrace.evidenceResponsibility.summaries =
        card.scoreTrace.evidenceResponsibility.summaries.filter(
          (summary) => summary.responsibility !== "published-evidence-expired",
        );
      card.scoreTrace.evidenceResponsibility.totalFactCount =
        card.scoreTrace.evidenceResponsibility.summaries.reduce(
          (sum, summary) => sum + summary.factCount,
          0,
        );
    }
    expect(storedPublication.cards[0]!.scoreTrace.evidenceResponsibility.facts).toBeDefined();
    const payload = stableJsonStringifyV1(storedPublication);
    const compressed = gzipSync(Buffer.from(payload));
    const stored = stableJsonStringifyV1({
      ...envelope,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      uncompressedBytes: Buffer.byteLength(payload),
      compressedBytes: compressed.byteLength,
      payload: Buffer.from(compressed).toString("base64"),
    });

    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(
      storedPublication,
    );
  });

  it("rejects post-9.4 serialization that omits an evidence responsibility owner", async () => {
    const publication = makeWorkerSafetyScoreV9Publication({
      policyVersion: "9.4",
    });
    publication.cards[0]!.scoreTrace.evidenceResponsibility.summaries =
      publication.cards[0]!.scoreTrace.evidenceResponsibility.summaries.filter(
        (summary) => summary.responsibility !== "published-evidence-expired",
      );

    await expect(
      serializeSafetyScoreV9Publication(publication),
    ).rejects.toThrow(/v9\.4\+ publications require every evidence responsibility owner/);
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

  it("rejects malformed and non-canonical stored JSON before decoding", async () => {
    await expect(parseSafetyScoreV9Publication("{not json")).rejects.toThrow(
      /Malformed Safety Score v9 publication JSON/,
    );
    const publication = makeWorkerSafetyScoreV9Publication();
    // Uncompressed payload with reordered keys is valid JSON but not the
    // canonical serialization the store authenticates.
    const reordered = JSON.stringify(JSON.parse(stableJsonStringifyV1(publication)), Object.keys(publication).reverse());
    await expect(parseSafetyScoreV9Publication(reordered)).rejects.toThrow(/not canonical/);
  });

  it("projects the storage envelope identity without inflating the body", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const stored = JSON.parse(await serializeSafetyScoreV9Publication(publication)) as { identity: unknown };

    expect(publicationIdentityFromStorageEnvelope(stored.identity)).toEqual({
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: publication.policyVersion,
      policyId: publication.policy.id,
      policyDigest: publication.policy.semanticDigest,
      evaluationBuildDigest: publication.evaluationBuildDigest,
      baseInputGenerationId: publication.baseInputGenerationId,
      publicationGenerationId: publication.publicationGenerationId,
    });
    expect(publicationIdentityFromStorageEnvelope({ policyId: "only" })).toBeNull();
    expect(publicationIdentityFromStorageEnvelope(null)).toBeNull();
  });
});
