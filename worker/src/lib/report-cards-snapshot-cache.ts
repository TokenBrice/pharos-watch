import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { z } from "zod";
import {
  parseVersionedSnapshotCache,
  buildVersionedSnapshotCacheValue,
  type VersionedSnapshotCacheLoadResult,
  type VersionedSnapshotCacheOptions,
} from "./versioned-snapshot-cache";
import { buildReportCardPublicationPlan } from "./report-card-publication";
import { getCache, setCache } from "./db-cache";
import { sha256Hex } from "./hash";
import { parseJson } from "./json-parse";

export const REPORT_CARDS_SNAPSHOT_CACHE_KEY = "report-cards:snapshot";
export const REPORT_CARDS_SNAPSHOT_CACHE_GENERATION = 3;
export const REPORT_CARDS_SNAPSHOT_CACHE_MAX_STORED_BYTES = 1_500_000;
export const REPORT_CARDS_SNAPSHOT_CACHE_MAX_UNCOMPRESSED_BYTES = 8_000_000;

const REPORT_CARDS_SNAPSHOT_CACHE_MAX_COMPRESSED_BYTES = 1_100_000;
const REPORT_CARDS_SNAPSHOT_STORAGE_SCHEMA_VERSION = 1;
const REPORT_CARDS_SNAPSHOT_STORAGE_KIND = "report-cards-snapshot";

export type ReportCardsSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch"
  | "identity-missing"
  | "identity-mismatch"
  | "completeness-missing"
  | "completeness-mismatch"
  | "stored-size-exceeded"
  | "uncompressed-size-exceeded"
  | "decompression-failed"
  | "checksum-mismatch";

export type ReportCardsSnapshotCacheLoadResult = VersionedSnapshotCacheLoadResult<
  ReportCardsResponse,
  ReportCardsSnapshotCacheFailureReason
>;

const REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS: VersionedSnapshotCacheOptions<
  ReportCardsResponse,
  ReportCardsSnapshotCacheFailureReason
> = {
  cacheKey: REPORT_CARDS_SNAPSHOT_CACHE_KEY,
  label: "report-cards",
  generation: REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
  methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
  schema: ReportCardsResponseSchema,
  reasons: {
    missingCache: "missing-cache",
    jsonParseFailed: "json-parse-failed",
    invalidPayload: "invalid-payload",
    invalidEnvelope: "invalid-envelope",
    generationMismatch: "generation-mismatch",
    methodologyMismatch: "methodology-mismatch",
  },
  getUpdatedAt: (payload) => payload.updatedAt,
  validatePayload: (payload) => {
    if (payload.methodology.version !== SAFETY_SCORE_METHODOLOGY_VERSION) {
      return {
        reason: "methodology-mismatch",
        message: `Report-cards snapshot methodology ${payload.methodology.version} does not match ${SAFETY_SCORE_METHODOLOGY_VERSION}`,
      };
    }
    if (!payload.publication) {
      return {
        reason: "completeness-missing",
        message: "Report-cards snapshot has no publication completeness manifest",
      };
    }
    const identity = payload.safetyScoreIdentity;
    if (!identity) {
      return {
        reason: "identity-missing",
        message: "Report-cards snapshot has no Safety Score publication identity",
      };
    }
    if (
      identity.model !== "v8" ||
      identity.methodologyVersion !== payload.methodology.version ||
      identity.evaluationBuildDigest !== SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST ||
      identity.publicationGenerationId !== payload.publication.generationId
    ) {
      return {
        reason: "identity-mismatch",
        message: "Report-cards snapshot Safety Score identity does not match its publication",
      };
    }
    try {
      const expected = buildReportCardPublicationPlan(
        payload.cards,
        payload.methodology.version,
        payload.updatedAt,
      ).completeness;
      if (JSON.stringify(payload.publication) !== JSON.stringify(expected)) {
        return {
          reason: "completeness-mismatch",
          message: "Report-cards snapshot publication completeness does not match its card identities",
        };
      }
    } catch (error) {
      return {
        reason: "completeness-mismatch",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return null;
  },
};

const ReportCardsSnapshotStorageEnvelopeSchema = z
  .object({
    storageSchemaVersion: z.literal(REPORT_CARDS_SNAPSHOT_STORAGE_SCHEMA_VERSION),
    kind: z.literal(REPORT_CARDS_SNAPSHOT_STORAGE_KIND),
    encoding: z.literal("gzip-base64"),
    generation: z.number().int(),
    model: z.literal("v8"),
    identitySchemaVersion: z.literal(1),
    methodologyVersion: z.string().min(1),
    evaluationBuildDigest: z.string().regex(/^[a-f0-9]{64}$/),
    baseInputGenerationId: z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/),
    publicationGenerationId: z.string().min(1),
    updatedAt: z.number().int().nonnegative(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    uncompressedBytes: z.number().int().positive(),
    compressedBytes: z.number().int().positive(),
    payload: z.string().min(1),
  })
  .strict();

type ReportCardsSnapshotStorageEnvelope = z.infer<typeof ReportCardsSnapshotStorageEnvelopeSchema>;

class SnapshotUncompressedLimitError extends Error {}

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

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Malformed report-cards snapshot base64 payload");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64(bytes) !== value) {
    throw new Error("Report-cards snapshot base64 payload is not canonical");
  }
  return bytes;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(Uint8Array.from(bytes)).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytesBounded(compressed: Uint8Array, maximumBytes: number): Promise<Uint8Array> {
  const stream = new Response(Uint8Array.from(compressed)).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        throw new SnapshotUncompressedLimitError(`Report-cards snapshot exceeds ${maximumBytes} uncompressed bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function compressedStorageCandidate(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.storageSchemaVersion !== undefined ||
    candidate.kind === REPORT_CARDS_SNAPSHOT_STORAGE_KIND ||
    candidate.encoding === "gzip-base64"
  );
}

function errorResult(
  reason: ReportCardsSnapshotCacheFailureReason,
  updatedAt: number | null,
): ReportCardsSnapshotCacheLoadResult {
  return { kind: "error", reason, updatedAt };
}

function storageIdentityMatchesPayload(
  envelope: ReportCardsSnapshotStorageEnvelope,
  payload: ReportCardsResponse,
): boolean {
  const identity = payload.safetyScoreIdentity;
  return Boolean(
    identity &&
    envelope.model === identity.model &&
    envelope.identitySchemaVersion === identity.schemaVersion &&
    envelope.methodologyVersion === identity.methodologyVersion &&
    envelope.evaluationBuildDigest === identity.evaluationBuildDigest &&
    envelope.baseInputGenerationId === identity.baseInputGenerationId &&
    envelope.publicationGenerationId === identity.publicationGenerationId &&
    envelope.updatedAt === payload.updatedAt,
  );
}

export async function loadPublishedReportCardsSnapshot(db: D1Database): Promise<ReportCardsSnapshotCacheLoadResult> {
  return parsePublishedReportCardsSnapshotCacheValue(await getCache(db, REPORT_CARDS_SNAPSHOT_CACHE_KEY));
}

export async function parsePublishedReportCardsSnapshotCacheValue(
  cached: { value: string; updatedAt: number } | null,
): Promise<ReportCardsSnapshotCacheLoadResult> {
  if (!cached) return errorResult("missing-cache", null);
  const storedBytes = utf8ByteLength(cached.value);

  const decoded = parseJson(cached.value, { onFailure: () => undefined });
  if (!decoded.ok) {
    return parseVersionedSnapshotCache(cached, REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS);
  }
  const raw = decoded.value;
  if (!compressedStorageCandidate(raw)) {
    return parseVersionedSnapshotCache(cached, REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS);
  }
  if (storedBytes > REPORT_CARDS_SNAPSHOT_CACHE_MAX_STORED_BYTES) {
    return errorResult("stored-size-exceeded", cached.updatedAt);
  }

  const envelopeResult = ReportCardsSnapshotStorageEnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) return errorResult("invalid-envelope", cached.updatedAt);
  const envelope = envelopeResult.data;
  if (envelope.generation !== REPORT_CARDS_SNAPSHOT_CACHE_GENERATION) {
    return errorResult("generation-mismatch", cached.updatedAt);
  }
  if (envelope.methodologyVersion !== SAFETY_SCORE_METHODOLOGY_VERSION) {
    return errorResult("methodology-mismatch", cached.updatedAt);
  }
  if (envelope.uncompressedBytes > REPORT_CARDS_SNAPSHOT_CACHE_MAX_UNCOMPRESSED_BYTES) {
    return errorResult("uncompressed-size-exceeded", cached.updatedAt);
  }
  if (envelope.compressedBytes > REPORT_CARDS_SNAPSHOT_CACHE_MAX_COMPRESSED_BYTES) {
    return errorResult("stored-size-exceeded", cached.updatedAt);
  }

  let compressed: Uint8Array;
  let uncompressed: Uint8Array;
  try {
    compressed = base64ToBytes(envelope.payload);
    if (compressed.byteLength !== envelope.compressedBytes) {
      return errorResult("invalid-envelope", cached.updatedAt);
    }
    uncompressed = await gunzipBytesBounded(
      compressed,
      Math.min(envelope.uncompressedBytes, REPORT_CARDS_SNAPSHOT_CACHE_MAX_UNCOMPRESSED_BYTES),
    );
  } catch (error) {
    return errorResult(
      error instanceof SnapshotUncompressedLimitError ? "uncompressed-size-exceeded" : "decompression-failed",
      cached.updatedAt,
    );
  }
  if (uncompressed.byteLength !== envelope.uncompressedBytes) {
    return errorResult("invalid-envelope", cached.updatedAt);
  }
  if ((await sha256Hex(uncompressed)) !== envelope.payloadSha256) {
    return errorResult("checksum-mismatch", cached.updatedAt);
  }

  let innerValue: string;
  try {
    innerValue = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(uncompressed);
  } catch {
    return errorResult("invalid-envelope", cached.updatedAt);
  }
  const parsed = parseVersionedSnapshotCache(
    { value: innerValue, updatedAt: cached.updatedAt },
    REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS,
  );
  if (parsed.kind !== "ok") return parsed;
  if (!storageIdentityMatchesPayload(envelope, parsed.payload)) {
    return errorResult("identity-mismatch", cached.updatedAt);
  }
  return parsed;
}

export async function writePublishedReportCardsSnapshot(db: D1Database, snapshot: ReportCardsResponse): Promise<void> {
  const entry = await buildPublishedReportCardsSnapshotCacheEntry(snapshot);
  await setCache(db, entry.key, entry.value);
}

export async function buildPublishedReportCardsSnapshotCacheEntry(snapshot: ReportCardsResponse): Promise<{
  key: string;
  value: string;
  storedBytes: number;
  uncompressedBytes: number;
}> {
  const innerValue = buildVersionedSnapshotCacheValue(snapshot, REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS);
  const uncompressed = new TextEncoder().encode(innerValue);
  if (uncompressed.byteLength === 0 || uncompressed.byteLength > REPORT_CARDS_SNAPSHOT_CACHE_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      `Report-cards snapshot is ${uncompressed.byteLength} uncompressed bytes; maximum is ${REPORT_CARDS_SNAPSHOT_CACHE_MAX_UNCOMPRESSED_BYTES}`,
    );
  }
  const identity = snapshot.safetyScoreIdentity;
  if (!identity) throw new Error("Report-cards snapshot has no Safety Score publication identity");
  const compressed = await gzipBytes(uncompressed);
  if (compressed.byteLength > REPORT_CARDS_SNAPSHOT_CACHE_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `Report-cards snapshot is ${compressed.byteLength} compressed bytes; maximum is ${REPORT_CARDS_SNAPSHOT_CACHE_MAX_COMPRESSED_BYTES}`,
    );
  }
  const value = JSON.stringify({
    storageSchemaVersion: REPORT_CARDS_SNAPSHOT_STORAGE_SCHEMA_VERSION,
    kind: REPORT_CARDS_SNAPSHOT_STORAGE_KIND,
    encoding: "gzip-base64",
    generation: REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
    model: identity.model,
    identitySchemaVersion: identity.schemaVersion,
    methodologyVersion: identity.methodologyVersion,
    evaluationBuildDigest: identity.evaluationBuildDigest,
    baseInputGenerationId: identity.baseInputGenerationId,
    publicationGenerationId: identity.publicationGenerationId,
    updatedAt: snapshot.updatedAt,
    payloadSha256: await sha256Hex(uncompressed),
    uncompressedBytes: uncompressed.byteLength,
    compressedBytes: compressed.byteLength,
    payload: bytesToBase64(compressed),
  });
  const storedBytes = utf8ByteLength(value);
  if (storedBytes > REPORT_CARDS_SNAPSHOT_CACHE_MAX_STORED_BYTES) {
    throw new Error(
      `Report-cards snapshot cache envelope is ${storedBytes} stored bytes; maximum is ${REPORT_CARDS_SNAPSHOT_CACHE_MAX_STORED_BYTES}`,
    );
  }
  return {
    key: REPORT_CARDS_SNAPSHOT_CACHE_KEY,
    value,
    storedBytes,
    uncompressedBytes: uncompressed.byteLength,
  };
}
