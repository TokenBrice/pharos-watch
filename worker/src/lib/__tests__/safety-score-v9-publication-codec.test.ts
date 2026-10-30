import { bytesToBase64 } from "@shared/lib/base64";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES,
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
  requireCurrentSafetyScoreV9Publication,
  publicationIdentityFromStorageEnvelope,
  SafetyScoreV9StorageMetadataSchema,
  serializeSafetyScoreV9Publication,
  serializeSafetyScoreV9PublicationWithEncoding,
} from "../safety-score-v9/publication-codec";
import {
  decodePublicationDictionary, encodePublicationDictionary,
  PUBLICATION_DICTIONARY_MAX_ENTRIES, PUBLICATION_DICTIONARY_MAX_ENTRY_BYTES, PUBLICATION_DICTIONARY_MAX_READ_PACKED_BYTES,
  PUBLICATION_DICTIONARY_MAX_TABLE_BYTES,
} from "../safety-score-v9/publication-dictionary";
import { shardSafetyScoreV9PublicationStoredValue, reassembleSafetyScoreV9PublicationStoredValue,
  SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES } from "../safety-score-v9/publication-chunks";

async function authenticatedPayload(
  publication: SafetyScoreV9CurrentResponse,
  mutate: (payload: SafetyScoreV9CurrentResponse) => unknown,
) {
  const envelope = JSON.parse(await serializeSafetyScoreV9Publication(publication));
  return authenticatedBytes(envelope, Buffer.from(stableJsonStringifyV1(mutate(structuredClone(publication)))));
}

function authenticatedBytes(envelope: Record<string, unknown>, payload: Buffer) {
  const compressed = gzipSync(payload);
  const { packedBytes: _packedBytes, ...legacyEnvelope } = envelope;
  return stableJsonStringifyV1({
    ...legacyEnvelope, storageSchemaVersion: 1, encoding: "gzip-base64",
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
  it("reads optional local authority exposure through canonical and compressed storage", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const exposure = { worstQuality: 60, coveredShare: 0.99,
      slices: [{ deploymentLabel: "Ethereum vault", share: 0.99, quality: 60 }], moreCount: 0 };
    publication.cards[0]!.localAuthorityExposure = exposure;
    for (const stored of [stableJsonStringifyV1(publication), await serializeSafetyScoreV9Publication(publication)]) {
      expect((await parseSafetyScoreV9Publication(stored)).cards[0]!.localAuthorityExposure).toEqual(exposure);
    }
  });
  it("emits dictionary storage while retaining byte-identical legacy decoding", async () => {
    const first = makeWorkerSafetyScoreV9Publication().cards[0]!;
    first.sharedBookId = "Repeated long evidence identité \\u0000 \"quoted\" \u{10400}".repeat(4);
    const second = structuredClone(first);
    second.id = "usdt-tether";
    const publication = makeWorkerSafetyScoreV9Publication({ cards: [first, second] });
    publication.sourceGenerations.marker = "\u00000";
    const canonical = Buffer.from(stableJsonStringifyV1(publication));
    const legacy = await serializeSafetyScoreV9PublicationWithEncoding(publication, "legacy");
    const dictionary = await serializeSafetyScoreV9PublicationWithEncoding(publication, "dictionary");
    expect(await serializeSafetyScoreV9Publication(publication)).toBe(dictionary);
    const old = JSON.parse(legacy), packed = JSON.parse(dictionary);
    expect(packed).toMatchObject({
      storageSchemaVersion: 2, encoding: "gzip-json-dictionary-base64-v1",
      payloadSha256: old.payloadSha256, uncompressedBytes: canonical.byteLength,
    });
    expect(packed.packedBytes).toBeLessThan(canonical.byteLength);
    const { payload: _payload, ...metadata } = packed;
    expect(SafetyScoreV9StorageMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(SafetyScoreV9StorageMetadataSchema.safeParse({ ...metadata, storageSchemaVersion: 1 }).success).toBe(false);
    expect(SafetyScoreV9StorageMetadataSchema.safeParse({ ...metadata, packedBytes: undefined }).success).toBe(false);
    expect(SafetyScoreV9StorageMetadataSchema.safeParse({ ...metadata, packedBytes: PUBLICATION_DICTIONARY_MAX_READ_PACKED_BYTES + 1 }).success).toBe(false);
    const decoded = await parseSafetyScoreV9Publication(dictionary);
    expect(Buffer.from(stableJsonStringifyV1(decoded))).toEqual(canonical);
    expect(decoded.cards[0]).not.toBe(decoded.cards[1]);
    await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({
      ...packed, payloadSha256: "f".repeat(64),
    }))).rejects.toThrow(/checksum mismatch/);
    await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({
      ...packed, packedBytes: packed.packedBytes - 1,
    }))).rejects.toThrow(/declared uncompressed byte length/);
    const noncanonical = Buffer.from(JSON.stringify(publication));
    const transport = gzipSync(Buffer.concat([Buffer.from("[]\n"), noncanonical]));
    await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({
      ...packed, payload: bytesToBase64(transport), compressedBytes: transport.length,
      packedBytes: noncanonical.length + 3, uncompressedBytes: noncanonical.length,
      payloadSha256: createHash("sha256").update(noncanonical).digest("hex"),
    }))).rejects.toThrow(/not canonical/);
  });

  it("restores a synthetic card set exactly, including escaped markers, keys and token boundaries", () => {
    const repeated = "Long shared évidence \u{10400} \"quoted\" \u0000 \\".repeat(200);
    const value = {
      cards: Array.from({ length: 16 }, (_, index) => ({ id: index, a: repeated, b: repeated })),
      ["\u00000"]: ["\u00000", "\u0000\u00001", ["@s", 0], "\u0000x"],
      huge: "x".repeat(70_000), escaped: ["\u0000".repeat(8), "\u0000".repeat(8)],
    };
    const encoded = encodePublicationDictionary(value);
    const canonical = Buffer.from(stableJsonStringifyV1(value));
    const packed = [...encoded.chunks].join("");
    expect(canonical.byteLength).toBeGreaterThan(64 * 1_024);
    const decoded = Buffer.from(decodePublicationDictionary(Buffer.from(packed), canonical.byteLength));
    expect(Buffer.compare(decoded, canonical)).toBe(0);
    expect(encoded.contentSha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(Buffer.byteLength(packed)).toBeLessThan(canonical.byteLength / 2);
  });

  it("rejects nested non-string table entries before canonical traversal", () => {
    const nested = `${"[".repeat(5_000)}0${"]".repeat(5_000)}`;
    expect(() => decodePublicationDictionary(Buffer.from(`[${nested}]\n{}`), 2))
      .toThrow("Invalid publication dictionary entry");
  });

  it.each([
    ["not-a-table", 2],
    ["{}\n{}", 2],
    ['[1]\n{}', 2],
    [`${JSON.stringify(["x".repeat(32), "x".repeat(32)])}\n{}`, 2],
    [`${JSON.stringify(["x".repeat(PUBLICATION_DICTIONARY_MAX_ENTRY_BYTES)])}\n{}`, 2],
    [`${JSON.stringify(Array(PUBLICATION_DICTIONARY_MAX_ENTRIES + 1).fill("x".repeat(32)))}\n{}`, 2],
    [`${" ".repeat(PUBLICATION_DICTIONARY_MAX_TABLE_BYTES + 1)}\n{}`, 2],
    ['[]\n\u00000\u0000', 3],
    ['[]\n\u0000-1\u0000', 3],
    ['[]\n\u000001\u0000', 3],
    ['[]\n\u00000', 3],
    ['[]\n\u0000\u0000', 3],
    ['[ ]\n{}', 2],
    [`${JSON.stringify(["x".repeat(32)])}\n[\u00000\u0000,\u00000\u0000]`, 4],
    ['[]\n{}', 1],
    ['[]\n{}', 3],
    ['[]\n"unterminated', 20],
    ['[]\n{}', SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES + 1],
  ])("rejects hostile dictionary %s", (packed, length) => {
    expect(() => decodePublicationDictionary(Buffer.from(String(packed)), Number(length))).toThrow();
  });
  it("encodes the same canonical envelope while reusing only frozen schema-equal cards", async () => {
    const publication = deepFreeze(makeWorkerSafetyScoreV9Publication());
    const { publication: admitted, stored } = await admitAndSerializeSafetyScoreV9Publication(publication, undefined, "legacy");
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
    const envelope = JSON.parse(await serializeSafetyScoreV9PublicationWithEncoding(makeWorkerSafetyScoreV9Publication(), "legacy"));
    for (const [changes, error] of [
      [{ compressedBytes: envelope.compressedBytes + 1 }, /compressed byte length mismatch/],
      [{ uncompressedBytes: envelope.uncompressedBytes + 1 }, /payload length mismatch/],
      [{ uncompressedBytes: envelope.uncompressedBytes - 1 }, /exceeds its declared uncompressed byte length/],
    ] as const) {
      await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({ ...envelope, ...changes }))).rejects.toThrow(error);
    }
  });

  it("enforces declared size limits at the exact boundary and one byte beyond", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9PublicationWithEncoding(makeWorkerSafetyScoreV9Publication(), "legacy"));
    for (const [field, limit, mismatch, exceeded] of [
      ["compressedBytes", SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES, /compressed byte length mismatch/, `exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES} compressed bytes`],
      ["uncompressedBytes", SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES, /payload length mismatch/, `exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES} uncompressed bytes`],
    ] as const) {
      await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({ ...envelope, [field]: limit }))).rejects.toThrow(mismatch);
      await expect(parseSafetyScoreV9Publication(stableJsonStringifyV1({ ...envelope, [field]: limit + 1 }))).rejects.toThrow(exceeded);
    }
    await expect(parseSafetyScoreV9Publication(" ".repeat(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES))).rejects.toThrow(/Malformed.*JSON/);
    await expect(parseSafetyScoreV9Publication(" ".repeat(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES + 1))).rejects.toThrow(`exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES} stored bytes`);
  });

  it("fits a maximum read payload within stored admission and bounded chunk rows", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication()));
    // Base64 expansion depends only on byte length, not gzip contents. Keep the
    // real codec's identity/fields and maximize both declared size digit counts.
    const payload = bytesToBase64(new Uint8Array(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES));
    const maximumEnvelope = {
      ...envelope,
      compressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES,
      uncompressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES,
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
    expect(storedBytes).toBeLessThanOrEqual(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES);
    const stored = stableJsonStringifyV1(maximumEnvelope);
    const sharded = shardSafetyScoreV9PublicationStoredValue(stored);
    expect(Buffer.byteLength(sharded.envelope)).toBeLessThanOrEqual(SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES);
    expect(sharded.chunks.every(chunk => Buffer.byteLength(chunk.value) <= SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES)).toBe(true);
    expect(reassembleSafetyScoreV9PublicationStoredValue(sharded.envelope, sharded.chunks)).toBe(stored);
    expect(() => reassembleSafetyScoreV9PublicationStoredValue(stableJsonStringifyV1({
      ...JSON.parse(sharded.envelope), payloadChunks: { ...JSON.parse(sharded.envelope).payloadChunks,
        storedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES + 1 },
    }), sharded.chunks)).toThrow();
  });

  it("reads real gzip near the independent reader ceiling", async () => {
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(makeWorkerSafetyScoreV9Publication()));
    const entropyBytes = Math.floor(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES * 0.97);
    const publication = compressionBudgetPublication(entropyBytes);
    const stored = authenticatedBytes(envelope, Buffer.from(stableJsonStringifyV1(publication)));
    const { compressedBytes } = JSON.parse(stored);
    expect(compressedBytes).toBeGreaterThanOrEqual(entropyBytes);
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

  it.each(["legacy", "dictionary"] as const)("round-trips the raw byte ceiling and rejects one additional byte on write (%s)", async encoding => {
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.sourceGenerations.byteBudgetFixture = "";
    const initialBytes = Buffer.byteLength(stableJsonStringifyV1(publication), "utf8");
    publication.sourceGenerations.byteBudgetFixture = "x".repeat(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES - initialBytes);
    const stored = await serializeSafetyScoreV9PublicationWithEncoding(publication, encoding);
    expect(JSON.parse(stored).uncompressedBytes).toBe(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES);
    await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(publication);
    publication.sourceGenerations.byteBudgetFixture += "x";
    await expect(serializeSafetyScoreV9PublicationWithEncoding(publication, encoding)).rejects.toThrow(`uncompressed byte limit; maximum is ${SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES}`);
  });

  it.each([
    ["legacy", 0], ["legacy", 1], ["dictionary", 0], ["dictionary", 1],
  ] as const)("checks authenticated bytes at the raw reader ceiling (%s, +%i byte)", async (encoding, extraBytes) => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const envelope = JSON.parse(await serializeSafetyScoreV9Publication(publication));
    publication.sourceGenerations.byteBudgetFixture = "";
    publication.sourceGenerations.byteBudgetFixture = "x".repeat(
      SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES + extraBytes - Buffer.byteLength(stableJsonStringifyV1(publication)));
    const raw = Buffer.from(stableJsonStringifyV1(publication));
    expect(raw.byteLength).toBe(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES + extraBytes);
    let stored = authenticatedBytes(envelope, raw);
    if (encoding === "dictionary") {
      const packed = Buffer.concat([Buffer.from("[]\n"), raw]);
      const compressed = gzipSync(packed);
      stored = stableJsonStringifyV1({ ...JSON.parse(stored), storageSchemaVersion: 2,
        encoding: "gzip-json-dictionary-base64-v1", packedBytes: packed.byteLength,
        compressedBytes: compressed.byteLength, payload: bytesToBase64(compressed) });
    }
    const { payload: _payload, ...metadata } = JSON.parse(stored);
    expect(SafetyScoreV9StorageMetadataSchema.safeParse(metadata).success).toBe(extraBytes === 0);
    if (extraBytes === 0) await expect(parseSafetyScoreV9Publication(stored)).resolves.toEqual(publication);
    else await expect(parseSafetyScoreV9Publication(stored)).rejects.toThrow(
      `exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES} uncompressed bytes`,
    );
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
      storageSchemaVersion: 2,
      kind: "safety-score-v9-publication",
      encoding: "gzip-json-dictionary-base64-v1",
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

  it("holds publishing until the retained schema-7 generation is re-published in the new shape", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const { openEvidence: _currentBlock, ...previous } = publication;
    const stored = await authenticatedPayload(publication, () => ({ ...previous, schemaVersion: 7 }));
    const admitted = await parseSafetyScoreV9Publication(stored);
    expect(admitted.schemaVersion).toBe(7);
    // The reader keeps serving the retained generation; the writer refuses to
    // re-emit it, so the next publication is the one that completes the cutover.
    await expect(serializeSafetyScoreV9Publication(
      { ...previous, schemaVersion: 7 } as unknown as SafetyScoreV9CurrentResponse,
    )).rejects.toThrow("must emit schema 8");
    await expect(serializeSafetyScoreV9Publication(publication)).resolves.toContain("gzip");
  });

  it("admits the retained schema-7 generation without inventing an open-evidence block", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    const { openEvidence: _currentBlock, ...previous } = publication;
    const stored = await authenticatedPayload(publication, () => ({ ...previous, schemaVersion: 7 }));
    const admitted = await parseSafetyScoreV9Publication(stored);
    expect(admitted.schemaVersion).toBe(7);
    expect(admitted).not.toHaveProperty("openEvidence");
    expect(() => requireCurrentSafetyScoreV9Publication(admitted)).toThrow(/schema 7/);
  });

  it.each([4, 9])("refuses unknown authenticated publication schema %s", async (schemaVersion) => {
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
