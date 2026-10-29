import { base64ToBytes, bytesToBase64 } from "@shared/lib/base64";
import { stableJsonStringifyChunksV1, stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  SafetyScoreV9CurrentCardSchema,
  type SafetyScoreV9CurrentCard,
} from "@shared/types/safety-score-v9-public";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
  SafetyScoreV9PreviousResponseSchema,
  type SafetyScoreV9PreviousResponse,
} from "@shared/types/safety-score-v9-publication-response";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { BaseInputGenerationIdSchema, Sha256Schema } from "@shared/types/safety-schema-primitives";
import { deepFreeze } from "@shared/types/safety-score-v9-immutable";
import { z } from "zod";
import { throwIfAborted } from "../abort";
import { gunzipBytesBounded, gzipCanonicalJson } from "../canonical-json-gzip";
import { sha256Hex, sha256HexFromUtf8Chunks } from "../hash";
import { parseJson } from "../json-parse";
import { decodePublicationDictionary, encodePublicationDictionary, PUBLICATION_DICTIONARY_MAX_READ_PACKED_BYTES, PUBLICATION_DICTIONARY_MAX_WRITE_PACKED_BYTES } from "./publication-dictionary";
import {
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES,
  SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES,
} from "@shared/lib/safety-score-v9-publication-limits";

const PUBLICATION_STORAGE_KIND = "safety-score-v9-publication";
const STORAGE_SCHEMA_VERSION = 1;

// One retained accepted generation for offline scenario replay. Both rows
// advance with the canonical publication batch (or neither does).
export const SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY = "report-cards:v9:accepted-replay:v1";
export const SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY = "report-cards:v9:accepted-replay-base:v1";

export class SafetyScoreV9SchemaCutoverPendingError extends Error {
  readonly code = "publication-schema-cutover-pending";
  constructor(readonly source: "publication" | "health" = "publication", readonly storedUpdatedAt: number | null = null) {
    super(source === "health"
      ? "publication-schema-cutover-pending: stored health schema 1 awaits health schema 2"
      : "publication-schema-cutover-pending: stored schema 6 awaits a schema 7 or 8 publication");
    this.name = "SafetyScoreV9SchemaCutoverPendingError";
  }
}

/**
 * A stored publication admitted during the v7→v8 window. Writers emit schema 8
 * only; the reader also admits the retained schema-7 generation until the next
 * publication re-publishes it in the new shape. Schema 7 carries no
 * `openEvidence`, so consumers must render the block as unavailable, never zero.
 */
export type SafetyScoreV9AdmittedPublication = SafetyScoreV9CurrentResponse | SafetyScoreV9PreviousResponse;

/**
 * Assert the current envelope for callers that read `openEvidence` or write
 * current-only projections. During the v7→v8 window such a caller must fail
 * visibly instead of treating a retained generation as block-bearing.
 */
export function requireCurrentSafetyScoreV9Publication(
  publication: SafetyScoreV9AdmittedPublication,
): SafetyScoreV9CurrentResponse {
  if (publication.schemaVersion !== 8) {
    throw new Error("Safety Score v9 publication is a retained schema 7 generation without openEvidence");
  }
  return publication;
}

const CacheIdentitySchema = z
  .object({
    candidateId: z.string().min(1),
    policyVersion: z.string().min(1),
    publicationGenerationId: z.string().min(1),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    factSetDigest: Sha256Schema,
    policyId: z.string().min(1),
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    resultDigest: Sha256Schema,
  })
  .strict();

const LegacyStorageEnvelopeSchema = z.object({
  storageSchemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
  kind: z.literal(PUBLICATION_STORAGE_KIND),
  encoding: z.literal("gzip-base64"),
  identity: CacheIdentitySchema,
  payloadSha256: Sha256Schema,
  uncompressedBytes: z.number().int().positive(),
  compressedBytes: z.number().int().positive(),
  payload: z.string().min(1),
}).strict();
const DictionaryStorageEnvelopeSchema = LegacyStorageEnvelopeSchema.extend({
  storageSchemaVersion: z.literal(2),
  encoding: z.literal("gzip-json-dictionary-base64-v1"),
  packedBytes: z.number().int().positive().max(PUBLICATION_DICTIONARY_MAX_READ_PACKED_BYTES),
});
const StorageEnvelopeSchema = z.discriminatedUnion("storageSchemaVersion", [
  LegacyStorageEnvelopeSchema, DictionaryStorageEnvelopeSchema,
]);
/** Sharded-envelope payload descriptor; see `publication-chunks.ts`. */
export const SafetyScoreV9PublicationPayloadChunksSchema = z.object({
  count: z.number().int().positive().max(64),
  payloadBytes: z.number().int().positive().max(4 * Math.ceil(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES / 3)),
  payloadSha256: Sha256Schema,
  storedBytes: z.number().int().positive().max(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES),
}).strict();
const metadataLimits = {
  uncompressedBytes: z.number().int().positive().max(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES),
  compressedBytes: z.number().int().positive().max(SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES),
  payloadChunks: SafetyScoreV9PublicationPayloadChunksSchema.optional(),
};
export const SafetyScoreV9StorageMetadataSchema = z.discriminatedUnion("storageSchemaVersion", [
  LegacyStorageEnvelopeSchema.omit({ payload: true }).extend(metadataLimits),
  DictionaryStorageEnvelopeSchema.omit({ payload: true }).extend(metadataLimits),
]);

type CacheIdentity = z.infer<typeof CacheIdentitySchema>;

function publicationIdentity(
  publication: SafetyScoreV9AdmittedPublication,
): CacheIdentity {
  return CacheIdentitySchema.parse({
    candidateId: publication.candidateId,
    policyVersion: publication.policyVersion,
    publicationGenerationId: publication.publicationGenerationId,
    baseInputGenerationId: publication.baseInputGenerationId,
    factSetDigest: publication.factSetDigest,
    policyId: publication.policy.id,
    policyDigest: publication.policy.semanticDigest,
    evaluationBuildDigest: publication.evaluationBuildDigest,
    resultDigest: publication.resultDigest,
  });
}

/**
 * Maps the storage envelope's uncompressed `identity` block to the shared
 * publication-identity contract, mirroring `buildSafetyScoreV9PublicationIdentity`.
 * Lets monitors read the active identity without inflating the compressed
 * publication body (too heavy for polled request paths).
 */
export function publicationIdentityFromStorageEnvelope(
  value: unknown,
): SafetyScoreV9PublicationIdentity | null {
  const parsed = CacheIdentitySchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: parsed.data.policyVersion,
    policyId: parsed.data.policyId,
    policyDigest: parsed.data.policyDigest,
    evaluationBuildDigest: parsed.data.evaluationBuildDigest,
    baseInputGenerationId: parsed.data.baseInputGenerationId,
    publicationGenerationId: parsed.data.publicationGenerationId,
  };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new Error(`Malformed ${label} base64 payload`);
  }
  if (bytesToBase64(bytes) !== value) {
    throw new Error(`${label} base64 payload is not canonical`);
  }
  return bytes;
}

function parsePublicationPayload(
  raw: string,
  label: string,
): SafetyScoreV9AdmittedPublication {
  const parsed = parseJson(raw);
  if (!parsed.ok) throw new Error(`Malformed ${label} JSON: ${parsed.message}`);
  if (stableJsonStringifyV1(parsed.value) !== raw) {
    throw new Error(`${label} JSON is not canonical`);
  }
  return admitPublicationPayload(parsed.value);
}

// Validation must not retain a second cohort when the schema made no changes.
// Compare the schema output, not assumptions about transforms/defaults, so future
// normalizations are still serialized and stripped fields never leak.
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  // Mutable callers retain the old snapshot semantics across async compression.
  if (!Object.isFrozen(left)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]));
}

// JSON decoding loses the producer's shared string storage. Reclaim duplicate
// evidence/identity text as each owned card is admitted, before validating the
// next card. Only primitive strings are shared: decoded objects remain mutable
// and independent, and serializer callers' graphs are never rewritten.
function internPublicationStrings(value: object, strings: Map<string, string>): void {
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const child = record[key];
    if (typeof child === "string") {
      const canonical = strings.get(child);
      if (canonical === undefined) strings.set(child, child);
      else record[key] = canonical;
    } else if (child !== null && typeof child === "object") {
      internPublicationStrings(child, strings);
    }
  }
}

function admitPublicationPayload(value: unknown, reuseUnchangedCards = false): SafetyScoreV9AdmittedPublication {
  const schemaVersion = value !== null && typeof value === "object" && "schemaVersion" in value
    ? value.schemaVersion : "missing";
  if (schemaVersion === 6) throw new SafetyScoreV9SchemaCutoverPendingError();
  if (schemaVersion !== 7 && schemaVersion !== 8) {
    throw new Error(`Unsupported Safety Score publication schema ${String(schemaVersion)}; active reader requires schema 7 or 8 and never infers route identity from legacy keys`);
  }
  const responseSchema = schemaVersion === 7
    ? SafetyScoreV9PreviousResponseSchema
    : SafetyScoreV9CurrentResponseSchema;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !("cards" in value) || !Array.isArray(value.cards)) {
    return responseSchema.parse(value);
  }
  const cards: unknown[] = value.cards;
  // JSON.parse transferred these rows to this decoder. Admit and replace each
  // owned row before moving on, rather than retaining two complete card graphs.
  // The envelope still runs every response refinement, including parent and
  // gap reconciliation; only already-admitted object identities bypass reparsing.
  const admittedCards = new WeakSet<object>();
  const decodedStrings = reuseUnchangedCards ? undefined : new Map<string, string>();
  for (let index = 0; index < cards.length; index++) {
    try {
      const original = cards[index];
      const parsed = SafetyScoreV9CurrentCardSchema.parse(original);
      const admitted = reuseUnchangedCards && original !== null && typeof original === "object" && sameJsonValue(original, parsed)
        ? original : parsed;
      cards[index] = admitted;
      admittedCards.add(admitted);
      if (decodedStrings) internPublicationStrings(parsed, decodedStrings);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new z.ZodError(error.issues.map((issue) => ({ ...issue, path: ["cards", index, ...issue.path] })));
      }
      throw error;
    }
  }
  return responseSchema.safeExtend({
    cards: z.array(z.custom<SafetyScoreV9CurrentCard>((card) =>
      card !== null && typeof card === "object" && admittedCards.has(card))),
  }).parse(value);
}


function compressedStorageCandidate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.storageSchemaVersion !== undefined ||
    candidate.encoding === "gzip-base64" ||
    candidate.kind === PUBLICATION_STORAGE_KIND
  );
}

export async function admitAndSerializeSafetyScoreV9Publication(
  value: SafetyScoreV9CurrentResponse,
  signal?: AbortSignal,
  encoding: "legacy" | "dictionary" = "dictionary",
): Promise<{ publication: Readonly<SafetyScoreV9CurrentResponse>; stored: string }> {
  throwIfAborted(signal);
  const admitted = admitPublicationPayload({ ...value, cards: [...value.cards] }, true);
  // Writers emit only the current envelope; admitting a retained generation is read-only.
  if (admitted.schemaVersion !== 8) throw new Error("Safety Score v9 writers must emit schema 8");
  const publication = deepFreeze(admitted);
  const dictionary = encoding === "dictionary" ? encodePublicationDictionary(publication, signal) : undefined;
  const compressed = await gzipCanonicalJson(dictionary?.chunks ?? stableJsonStringifyChunksV1(publication), {
    label: "Safety Score v9 publication",
    maximumCompressedBytes:
      SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
    maximumUncompressedBytes: dictionary ? PUBLICATION_DICTIONARY_MAX_WRITE_PACKED_BYTES : SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES,
    signal,
  });
  const stored = stableJsonStringifyV1(
    StorageEnvelopeSchema.parse({
      storageSchemaVersion: dictionary ? 2 : STORAGE_SCHEMA_VERSION,
      kind: PUBLICATION_STORAGE_KIND,
      encoding: dictionary ? "gzip-json-dictionary-base64-v1" : "gzip-base64",
      ...(dictionary ? { packedBytes: compressed.uncompressedBytes } : {}),
      identity: publicationIdentity(publication),
      payloadSha256: dictionary?.contentSha256 ?? compressed.contentSha256,
      uncompressedBytes: dictionary?.uncompressedBytes ?? compressed.uncompressedBytes,
      compressedBytes: compressed.compressed.byteLength,
      payload: bytesToBase64(compressed.compressed),
    }),
  );
  const storedBytes = utf8ByteLength(stored);
  if (storedBytes > SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES) {
    throw new Error(
      `Safety Score v9 publication is ${storedBytes} stored bytes; maximum is ${SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_STORED_BYTES}`,
    );
  }
  throwIfAborted(signal);
  return { publication, stored };
}

export async function serializeSafetyScoreV9Publication(
  value: SafetyScoreV9CurrentResponse,
  signal?: AbortSignal,
): Promise<string> {
  return (await admitAndSerializeSafetyScoreV9Publication(value, signal)).stored;
}

/** Explicit encoder for qualification and historical-format fixtures. */
export async function serializeSafetyScoreV9PublicationWithEncoding(
  value: SafetyScoreV9CurrentResponse,
  encoding: "legacy" | "dictionary",
  signal?: AbortSignal,
): Promise<string> {
  return (await admitAndSerializeSafetyScoreV9Publication(value, signal, encoding)).stored;
}

export async function parseSafetyScoreV9Publication(
  storedValue: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9AdmittedPublication> {
  throwIfAborted(signal);
  if (
    utf8ByteLength(storedValue) >
    SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES
  ) {
    throw new Error(
      `Safety Score v9 publication exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_STORED_BYTES} stored bytes`,
    );
  }
  const raw = parseJson(storedValue);
  if (!raw.ok) {
    throw new Error(
      `Malformed Safety Score v9 publication JSON: ${raw.message}`,
    );
  }
  if (!compressedStorageCandidate(raw.value)) {
    return parsePublicationPayload(
      storedValue,
      "Safety Score v9 publication",
    );
  }

  const storage = StorageEnvelopeSchema.parse(raw.value);
  if (stableJsonStringifyV1(storage) !== storedValue) {
    throw new Error(
      "Safety Score v9 publication storage envelope JSON is not canonical",
    );
  }
  if (
    storage.uncompressedBytes >
    SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES
  ) {
    throw new Error(
      `Safety Score v9 publication exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES} uncompressed bytes`,
    );
  }
  if (
    storage.compressedBytes >
    SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES
  ) {
    throw new Error(
      `Safety Score v9 publication exceeds ${SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES} compressed bytes`,
    );
  }
  const compressed = decodeCanonicalBase64(
    storage.payload,
    "Safety Score v9 publication",
  );
  if (compressed.byteLength !== storage.compressedBytes) {
    throw new Error(
      "Safety Score v9 publication compressed byte length mismatch",
    );
  }
  let uncompressed = await gunzipBytesBounded(
    compressed,
    {
      label: "Safety Score v9 publication",
      maximumCompressedBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES,
      maximumUncompressedBytes: storage.storageSchemaVersion === 2 ? PUBLICATION_DICTIONARY_MAX_READ_PACKED_BYTES : SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES,
      expectedUncompressedBytes: storage.storageSchemaVersion === 2 ? storage.packedBytes : storage.uncompressedBytes,
      signal,
    },
  );
  if (storage.storageSchemaVersion === 2) {
    uncompressed = decodePublicationDictionary(uncompressed, storage.uncompressedBytes, signal);
  }
  let canonical: string;
  try {
    canonical = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(uncompressed);
  } catch {
    throw new Error("Safety Score v9 publication payload is not valid UTF-8");
  }
  if ((await sha256Hex(uncompressed)) !== storage.payloadSha256) {
    throw new Error("Safety Score v9 publication checksum mismatch");
  }
  // The digest authenticated the exact producer-written canonical bytes. Drop
  // their decoded string before card admission; the owned parsed graph is enough.
  const payload = parseJson(canonical);
  canonical = "";
  if (!payload.ok) throw new Error(`Malformed Safety Score v9 publication JSON: ${payload.message}`);
  if (storage.storageSchemaVersion === 2 &&
      sha256HexFromUtf8Chunks(stableJsonStringifyChunksV1(payload.value)) !== storage.payloadSha256) {
    throw new Error("Safety Score v9 publication dictionary JSON is not canonical");
  }
  const publication = admitPublicationPayload(payload.value);
  if (
    stableJsonStringifyV1(publicationIdentity(publication)) !==
    stableJsonStringifyV1(storage.identity)
  ) {
    throw new Error("Safety Score v9 publication identity mismatch");
  }
  throwIfAborted(signal);
  return publication;
}
