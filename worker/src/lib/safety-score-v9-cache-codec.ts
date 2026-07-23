import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";
import { throwIfAborted } from "./abort";
import { gzipCanonicalJson } from "./canonical-json-gzip";
import { sha256Hex } from "./hash";
import { parseJson } from "./json-parse";
import {
  SafetyScoreV9DiffReportSchema,
  SafetyScoreV9ShadowEnvelopeSchema,
  type SafetyScoreV9DiffReport,
  type SafetyScoreV9ShadowEnvelope,
} from "./safety-score-v9-shadow";

const SAFETY_SCORE_V9_SHADOW_CACHE_MAX_BYTES = 1_900_000;
export const SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES = SAFETY_SCORE_V9_SHADOW_CACHE_MAX_BYTES;
export const SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES = 1_350_000;
const SAFETY_SCORE_V9_SHADOW_CACHE_MAX_UNCOMPRESSED_BYTES = 8_000_000;

const STORAGE_SCHEMA_VERSION = 1;
const STORAGE_KINDS = {
  envelope: "safety-score-v9-shadow-envelope",
  diff: "safety-score-v9-diff-report",
} as const;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const CacheIdentitySchema = z
  .object({
    candidateId: z.string().min(1),
    policyVersion: z.string().min(1),
    publicationGenerationId: z.string().min(1),
    baseInputGenerationId: z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/),
    factSetDigest: Sha256Schema,
    policyId: z.string().min(1),
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    resultDigest: Sha256Schema,
  })
  .strict();

const StorageEnvelopeSchema = z
  .object({
    storageSchemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
    kind: z.enum([STORAGE_KINDS.envelope, STORAGE_KINDS.diff]),
    encoding: z.literal("gzip-base64"),
    identity: CacheIdentitySchema,
    payloadSha256: Sha256Schema,
    uncompressedBytes: z.number().int().positive(),
    compressedBytes: z.number().int().positive(),
    payload: z.string().min(1),
  })
  .strict();

type CacheIdentity = z.infer<typeof CacheIdentitySchema>;
type StorageKind = (typeof STORAGE_KINDS)[keyof typeof STORAGE_KINDS];

interface CacheCodec<T> {
  storageKind: StorageKind;
  schema: z.ZodType<T>;
  identity: (value: T) => CacheIdentity;
}

function envelopeIdentity(value: SafetyScoreV9ShadowEnvelope): CacheIdentity {
  const candidate = value.candidate;
  return CacheIdentitySchema.parse({
    candidateId: candidate.candidateId,
    policyVersion: candidate.policyVersion,
    publicationGenerationId: candidate.publicationGenerationId,
    baseInputGenerationId: candidate.baseInputGenerationId,
    factSetDigest: candidate.factSetDigest,
    policyId: candidate.policy.id,
    policyDigest: candidate.policy.semanticDigest,
    evaluationBuildDigest: candidate.evaluationBuildDigest,
    resultDigest: candidate.resultDigest,
  });
}

const ENVELOPE_CODEC: CacheCodec<SafetyScoreV9ShadowEnvelope> = {
  storageKind: STORAGE_KINDS.envelope,
  schema: SafetyScoreV9ShadowEnvelopeSchema,
  identity: envelopeIdentity,
};

const DIFF_CODEC: CacheCodec<SafetyScoreV9DiffReport> = {
  storageKind: STORAGE_KINDS.diff,
  schema: SafetyScoreV9DiffReportSchema,
  identity: (value) => CacheIdentitySchema.parse(value.v9Identity),
};

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string, label: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`Malformed ${label} base64 payload`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64(bytes) !== value) throw new Error(`${label} base64 payload is not canonical`);
  return bytes;
}

async function gunzipBytesBounded(
  compressed: Uint8Array,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const stream = new Response(Uint8Array.from(compressed)).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const output = new Uint8Array(maximumBytes);
  let byteLength = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} uncompressed bytes`);
      output.set(value, byteLength - value.byteLength);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  throwIfAborted(signal);
  return output.subarray(0, byteLength);
}

function parseCanonicalJson<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  const parsed = parseJson(raw);
  if (!parsed.ok) throw new Error(`Malformed ${label} JSON: ${parsed.message}`);
  const value = schema.parse(parsed.value);
  if (stableJsonStringifyV1(value) !== raw) throw new Error(`${label} JSON is not canonical`);
  return value;
}

function compressedStorageCandidate(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.storageSchemaVersion !== undefined ||
    candidate.encoding === "gzip-base64" ||
    Object.values(STORAGE_KINDS).includes(candidate.kind as StorageKind)
  );
}

async function serializeCacheValue<T>(
  value: T,
  codec: CacheCodec<T>,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const parsed = codec.schema.parse(value);
  const canonical = stableJsonStringifyV1(parsed);
  const compressed = await gzipCanonicalJson(canonical, {
    label,
    maximumCompressedBytes: SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES,
    maximumUncompressedBytes: SAFETY_SCORE_V9_SHADOW_CACHE_MAX_UNCOMPRESSED_BYTES,
    signal,
  });
  if (compressed.compressed.byteLength > SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `${label} is ${compressed.compressed.byteLength} compressed bytes; maximum is ${SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES}`,
    );
  }
  const stored = stableJsonStringifyV1(
    StorageEnvelopeSchema.parse({
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      kind: codec.storageKind,
      encoding: "gzip-base64",
      identity: codec.identity(parsed),
      payloadSha256: compressed.contentSha256,
      uncompressedBytes: compressed.uncompressedBytes,
      compressedBytes: compressed.compressed.byteLength,
      payload: bytesToBase64(compressed.compressed),
    }),
  );
  const storedBytes = utf8ByteLength(stored);
  if (storedBytes > SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES) {
    throw new Error(
      `${label} cache envelope is ${storedBytes} stored bytes; maximum is ${SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES}`,
    );
  }
  throwIfAborted(signal);
  return stored;
}

async function parseCacheValue<T>(
  storedValue: string,
  codec: CacheCodec<T>,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (utf8ByteLength(storedValue) > SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES) {
    throw new Error(`${label} exceeds ${SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES} stored bytes`);
  }
  const raw = parseJson(storedValue);
  if (!raw.ok) throw new Error(`Malformed ${label} JSON: ${raw.message}`);
  if (!compressedStorageCandidate(raw.value)) return parseCanonicalJson(storedValue, codec.schema, label);

  const storage = StorageEnvelopeSchema.parse(raw.value);
  if (stableJsonStringifyV1(storage) !== storedValue) {
    throw new Error(`${label} cache storage envelope JSON is not canonical`);
  }
  if (storage.kind !== codec.storageKind) throw new Error(`${label} cache storage kind mismatch`);
  if (storage.uncompressedBytes > SAFETY_SCORE_V9_SHADOW_CACHE_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`${label} exceeds ${SAFETY_SCORE_V9_SHADOW_CACHE_MAX_UNCOMPRESSED_BYTES} uncompressed bytes`);
  }
  if (storage.compressedBytes > SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES) {
    throw new Error(`${label} exceeds ${SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES} compressed bytes`);
  }
  const compressed = base64ToBytes(storage.payload, `${label} cache`);
  if (compressed.byteLength !== storage.compressedBytes) {
    throw new Error(`${label} cache compressed byte length mismatch`);
  }
  const uncompressed = await gunzipBytesBounded(
    compressed,
    Math.min(storage.uncompressedBytes, SAFETY_SCORE_V9_SHADOW_CACHE_MAX_UNCOMPRESSED_BYTES),
    signal,
    `${label} cache`,
  );
  if (uncompressed.byteLength !== storage.uncompressedBytes) {
    throw new Error(`${label} cache uncompressed byte length mismatch`);
  }
  let canonical: string;
  try {
    canonical = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(uncompressed);
  } catch {
    throw new Error(`${label} cache payload is not valid UTF-8`);
  }
  if ((await sha256Hex(uncompressed)) !== storage.payloadSha256) throw new Error(`${label} cache checksum mismatch`);
  const value = parseCanonicalJson(canonical, codec.schema, label);
  if (stableJsonStringifyV1(codec.identity(value)) !== stableJsonStringifyV1(storage.identity)) {
    throw new Error(`${label} cache identity mismatch`);
  }
  throwIfAborted(signal);
  return value;
}

export function serializeSafetyScoreV9ShadowEnvelopeCacheValue(
  value: SafetyScoreV9ShadowEnvelope,
  signal?: AbortSignal,
): Promise<string> {
  return serializeCacheValue(value, ENVELOPE_CODEC, "Safety Score v9 shadow envelope", signal);
}

export function serializeSafetyScoreV9DiffReportCacheValue(
  value: SafetyScoreV9DiffReport,
  signal?: AbortSignal,
): Promise<string> {
  return serializeCacheValue(value, DIFF_CODEC, "Safety Score v9 diff report", signal);
}

export function parseSafetyScoreV9ShadowEnvelopeCacheValue(
  storedValue: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowEnvelope> {
  return parseCacheValue(storedValue, ENVELOPE_CODEC, "Safety Score v9 shadow envelope", signal);
}

export function parseSafetyScoreV9DiffReportCacheValue(
  storedValue: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9DiffReport> {
  return parseCacheValue(storedValue, DIFF_CODEC, "Safety Score v9 diff report", signal);
}
