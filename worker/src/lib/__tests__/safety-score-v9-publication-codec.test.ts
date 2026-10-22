import { bytesToBase64 } from "@shared/lib/base64";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES,
} from "@shared/lib/safety-score-v9-publication-limits";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deepFreeze } from "@shared/types/safety-score-v9-immutable";
import {
  makeWorkerSafetyScoreV9Publication,
} from "../../test-helpers/report-cards-v9";
import {
  admitAndSerializeSafetyScoreV9Publication,
  parseSafetyScoreV9Publication,
  publicationIdentityFromStorageEnvelope,
  SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES,
  SafetyScoreV9StorageMetadataSchema,
  serializeSafetyScoreV9Publication,
} from "../safety-score-v9/publication-codec";

async function authenticatedPayload(
  publication: SafetyScoreV9CurrentResponse,
  mutate: (payload: SafetyScoreV9CurrentResponse) => unknown,
) {
  const envelope = JSON.parse(await serializeSafetyScoreV9Publication(publication));
  return authenticatedBytes(envelope, Buffer.from(stableJsonStringifyV1(mutate(structuredClone(publication)))));
}

function authenticatedBytes(envelope: Record<string, unknown>, payload: Buffer) {
  const compressed = gzipSync(payload);
  return stableJsonStringifyV1({
    ...envelope,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
    uncompressedBytes: payload.byteLength,
    compressedBytes: compressed.byteLength,
    payload: bytesToBase64(new Uint8Array(compressed)),
  });
}

function compressionBudgetPublication(entropyBytes: number): SafetyScoreV9CurrentResponse {
  const publication = makeWorkerSafetyScoreV9Publication();
  // Deterministic high-entropy content exercises real gzip and admission.
  const entropy = Buffer.alloc(entropyBytes);
  let state = 0x12345678;
  for (let index = 0; index < entropy.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    entropy[index] = state >>> 24;
  }
  publication.sourceGenerations.compressedBudgetFixture = entropy.toString("base64");
  return publication;
}

describe("Safety Score V9 publication codec", () => {
  it("encodes the same canonical envelope while reusing only frozen schema-equal cards", async () => {
    const publication = deepFreeze(makeWorkerSafetyScoreV9Publication());
    const { publication: admitted, stored } = await admitAndSerializeSafetyScoreV9Publication(publication);
    expect(admitted.cards[0]).toBe(publication.cards[0]);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.cards)).toBe(true);
    const envelope = JSON.parse(stored);
    const raw = Buffer.from(stableJsonStringifyV1(publication));
    expect(envelope.payloadSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(envelope.payload).toBe(bytesToBase64(gzipSync(raw)));
  });

  it("snapshots mutable callers before compression and leaves their graph unfrozen", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const original = structuredClone(publication);
    const pending = admitAndSerializeSafetyScoreV9Publication(publication);
    publication.cards[0]!.sharedBookId = "mutated-during-compression";
    publication.sourceGenerations.registry = "mutated-registry";
    const { publication: admitted, stored } = await pending;
    expect(admitted).toEqual(original);
    expect(Object.isFrozen(admitted.cards[0]!.scoreTrace)).toBe(true);
    expect(Object.isFrozen(publication)).toBe(false);
    expect(Object.isFrozen(publication.cards[0])).toBe(false);
    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(original);
  });

  it("validates each producer card without mutating the caller-owned cohort", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const original = structuredClone(publication);
    const cards = publication.cards;
    const card = cards[0];
    await serializeSafetyScoreV9Publication(publication);
    expect(publication).toEqual(original);
    expect(publication.cards).toBe(cards);
    expect(publication.cards[0]).toBe(card);
    publication.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = -1;
    await expect(serializeSafetyScoreV9Publication(publication)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ["cards", 0, "scoreTrace", "evidenceResponsibility", "totalFactCount"] })]),
    });
  });

  it.each(["compressed", "canonical"] as const)("preserves independent mutable cards when decoding repeated strings (%s)", async (encoding) => {
    const first = makeWorkerSafetyScoreV9Publication().cards[0]!;
    first.sharedBookId = "Repeated évidence \u{10400} \u0000 \"text\"";
    const second = structuredClone(first);
    second.id = "usdt-tether";
    const publication = makeWorkerSafetyScoreV9Publication({ cards: [first, second] });
    const canonical = stableJsonStringifyV1(publication);
    const stored = encoding === "compressed" ? await serializeSafetyScoreV9Publication(publication) : canonical;
    const decoded = await parseSafetyScoreV9Publication(stored);
    expect(stableJsonStringifyV1(decoded)).toBe(canonical);
    expect(decoded.cards[0]!.sharedBookId).toBe(decoded.cards[1]!.sharedBookId);
    expect(decoded.cards[0]!.scoreTrace.evidenceResponsibility).not.toBe(decoded.cards[1]!.scoreTrace.evidenceResponsibility);
    decoded.cards[0]!.sharedBookId = "changed";
    decoded.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount += 1;
    expect(decoded.cards[1]).toEqual(second);
    expect(publication.cards).toEqual([first, second]);
  });

  it("rejects digest and valid identity tampering independently", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const stored = await serializeSafetyScoreV9Publication(publication);
    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(publication);
    const envelope = JSON.parse(stored);
    await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({
      ...envelope, payloadSha256: "f".repeat(64),
    }))).rejects.toThrow(/checksum mismatch/);
    await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({
      ...envelope, identity: { ...envelope.identity, publicationGenerationId: "another-publication" },
    }))).rejects.toThrow(/identity mismatch/);
  });

  it("rejects independent compressed and inflated length corruption", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication()));
    for (const [changes, error] of [
      [{ compressedBytes: envelope.compressedBytes + 1 }, /compressed byte length mismatch/],
      [{ uncompressedBytes: envelope.uncompressedBytes + 1 }, /payload length mismatch/],
      [{ uncompressedBytes: envelope.uncompressedBytes - 1 }, /exceeds its declared uncompressed byte length/],
    ] as const) {
      await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({ ...envelope, ...changes }))).rejects.toThrow(error);
    }
  });

  it("enforces declared size limits at the exact boundary and one byte beyond", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication()));
    for (const [field, limit, mismatch, exceeded] of [
      ["compressedBytes", SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES, /compressed byte length mismatch/, `exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES} compressed bytes`],
      ["uncompressedBytes", SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES, /payload length mismatch/, `exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES} uncompressed bytes`],
    ] as const) {
      await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({ ...envelope, [field]: limit }))).rejects.toThrow(mismatch);
      await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({ ...envelope, [field]: limit + 1 }))).rejects.toThrow(exceeded);
    }
    await expect(parseSafetyScoreV9Publication(" ".repeat(1_900_000))).rejects.toThrow(/Malformed.*JSON/);
    await expect(parseSafetyScoreV9Publication(" ".repeat(1_900_001))).rejects.toThrow(/exceeds 1900000 stored bytes/);
  });

  it("fits a maximum compressed payload and real codec envelope within stored and D1 limits", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication()));
    // Base64 expansion depends only on byte length, not gzip contents. Keep the
    // real codec's identity/fields and maximize both declared size digit counts.
    const payload = bytesToBase64(new Uint8Array(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES));
    const maximumEnvelope = {
      ...envelope,
      compressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES,
      uncompressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES,
      payload,
    };
    const { payload: _payload, ...metadata } = maximumEnvelope;
    expect(SafetyScoreV9StorageMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(SafetyScoreV9StorageMetadataSchema.safeParse({
      ...metadata, compressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES + 1,
    }).success).toBe(false);
    const base64Bytes = Math.ceil(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES / 3) * 4;
    expect(Buffer.byteLength(payload, "utf8")).toBe(base64Bytes);
    const storedBytes = Buffer.byteLength(stableJsonStringifyV1(maximumEnvelope), "utf8");
    const envelopeOverheadBytes = storedBytes - base64Bytes;
    expect(envelopeOverheadBytes).toBeGreaterThan(0);
    expect(storedBytes).toBeLessThanOrEqual(SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES);
    expect(storedBytes).toBeLessThanOrEqual(2_000_000);
  });

  it("reads a real compressed publication between 1.36 MB and the expanded read ceiling", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication()));
    const publication = compressionBudgetPublication(1_360_000);
    const stored = authenticatedBytes(envelope, Buffer.from(stableJsonStringifyV1(publication)));
    const { compressedBytes } = JSON.parse(stored);
    expect(compressedBytes).toBeGreaterThanOrEqual(1_360_000);
    expect(compressedBytes).toBeLessThanOrEqual(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES);
    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(publication);
  });

  it("rejects real gzip output above the independent writer ceiling", async () => {
    const publication = compressionBudgetPublication(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES);
    const raw = Buffer.from(stableJsonStringifyV1(publication));
    expect(gzipSync(raw).byteLength).toBeGreaterThan(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES);
    await expect(admitAndSerializeSafetyScoreV9Publication(publication)).rejects.toThrow(
      `compressed byte limit; maximum is ${SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES}`,
    );
  });

  it("round-trips the raw byte ceiling and rejects one additional byte on write", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.sourceGenerations.byteBudgetFixture = "";
    const initialBytes = Buffer.byteLength(stableJsonStringifyV1(publication), "utf8");
    publication.sourceGenerations.byteBudgetFixture = "x".repeat(9_200_000 - initialBytes);
    const stored = await serializeSafetyScoreV9Publication(publication);
    expect(JSON.parse(stored).uncompressedBytes).toBe(9_200_000);
    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(publication);
    publication.sourceGenerations.byteBudgetFixture += "x";
    await expect(serializeSafetyScoreV9Publication(publication)).rejects.toThrow(/uncompressed byte limit; maximum is 9200000/);
  });

  it("rejects invalid UTF-8 with authenticated transport metadata", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication()));
    const stored = authenticatedBytes(envelope, Buffer.from([0xc3, 0x28]));
    await expect(parseSafetyScoreV9Publication(stored)).rejects.toThrow(/not valid UTF-8/);
  });

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
    const stored = await authenticatedPayload(publication, (payload) => {
      payload.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = -1;
      return payload;
    });

    await expect(parseSafetyScoreV9Publication(stored)).rejects.toThrow(/totalFactCount/);
    await expect(parseSafetyScoreV9Publication(stored)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ["cards", 0, "scoreTrace", "evidenceResponsibility", "totalFactCount"] })]),
    });
  });

  it("keeps card witness admission and complete envelope reconciliation on incremental decode", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const invalidWitness = await authenticatedPayload(publication, (payload) => {
      payload.cards[0]!.witnessTexts = ["unused witness"];
      return payload;
    });
    await expect(parseSafetyScoreV9Publication(invalidWitness)).rejects.toMatchObject({
      issues: [{ path: ["cards", 0, "witnessTexts"] }],
    });
    const invalidEnvelope = await authenticatedPayload(publication, (payload) => {
      payload.completeness.expectedCount++;
      return payload;
    });
    await expect(parseSafetyScoreV9Publication(invalidEnvelope)).rejects.toThrow(/count|completeness/i);
  });

  it("fails closed explicitly for authenticated schema 6 until typed-identity cutover", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const stored = await authenticatedPayload(publication, (payload) => ({ ...payload, schemaVersion: 6 }));
    await expect(parseSafetyScoreV9Publication(stored)).rejects.toMatchObject({ code: "publication-schema-cutover-pending" });
  });

  it.each([4, 8])("refuses unknown authenticated publication schema %s", async (schemaVersion) => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const stored = await authenticatedPayload(publication, (payload) => ({ ...payload, schemaVersion }));
    await expect(parseSafetyScoreV9Publication(stored)).rejects.toThrow(`Unsupported Safety Score publication schema ${schemaVersion}`);
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
    ).rejects.toThrow();
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

    await expect(parseSafetyScoreV9Publication(stored)).rejects.toThrow();
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
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(publication).reverse()));
    expect(JSON.parse(reordered)).toEqual(publication);
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
