import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./cron-lease";
import { executeAtomicBatch } from "./db";
import { parseJson } from "./json-parse";
import {
  SafetyScoreV9DiffReportSchema,
  SafetyScoreV9ReplayArtifactKindSchema,
  SafetyScoreV9ReplayArtifactSchema,
  SafetyScoreV9ShadowAttemptSchema,
  SafetyScoreV9ShadowDaySchema,
  SafetyScoreV9ShadowEnvelopeSchema,
  computeSafetyScoreV9ShadowEnvelopeDigest,
  type SafetyScoreV9DiffReport,
  type SafetyScoreV9ReplayArtifact,
  type SafetyScoreV9ReplayArtifactKind,
  type SafetyScoreV9ShadowAttempt,
  type SafetyScoreV9ShadowDay,
  type SafetyScoreV9ShadowEnvelope,
} from "./safety-score-v9-shadow";

export const SAFETY_SCORE_V9_SHADOW_CACHE_KEYS = {
  envelope: "report-cards:v9-shadow",
  diff: "report-cards:v9-shadow:diff",
} as const;

export const SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_UNCOMPRESSED_BYTES = 32 * 1_024 * 1_024;
export const SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_STORED_BYTES = 1_900_000;
export const SAFETY_SCORE_V9_SHADOW_CACHE_MAX_BYTES = 1_900_000;
export const SAFETY_SCORE_V9_SHADOW_HISTORY_DEFAULT_LIMIT = 45;
export const SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT = 400;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UnixSecondsSchema = z.number().int().nonnegative();

export const SafetyScoreV9StoredReplayArtifactSchema = z
  .object({
    artifactKey: z.string().min(1),
    kind: SafetyScoreV9ReplayArtifactKindSchema,
    identity: z.string().trim().min(1),
    contentSha256: Sha256Schema,
    encoding: z.literal("gzip-base64"),
    uncompressedBytes: z.number().int().positive(),
    storedBytes: z.number().int().positive(),
    payload: z.string().min(1),
    createdAtSec: UnixSecondsSchema,
    verifiedAtSec: UnixSecondsSchema,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (artifact.artifactKey !== `${artifact.kind}:${artifact.contentSha256}`) {
      ctx.addIssue({
        code: "custom",
        path: ["artifactKey"],
        message: "Replay artifact key must bind its kind and content checksum",
      });
    }
    if (artifact.verifiedAtSec < artifact.createdAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["verifiedAtSec"],
        message: "Replay artifact verification cannot predate creation",
      });
    }
  });
export type SafetyScoreV9StoredReplayArtifact = z.infer<typeof SafetyScoreV9StoredReplayArtifactSchema>;

export class SafetyScoreV9StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScoreV9StoreConflictError";
  }
}

interface ReplayArtifactLimits {
  maxUncompressedBytes?: number;
  maxStoredBytes?: number;
}

interface ReplayArtifactOperationOptions extends ReplayArtifactLimits {
  signal?: AbortSignal;
}

export interface BuildSafetyScoreV9ReplayArtifactInput {
  kind: SafetyScoreV9ReplayArtifactKind;
  identity: string;
  value: unknown;
  createdAtSec: number;
  verifiedAtSec?: number;
}

export interface ParsedSafetyScoreV9ReplayArtifact<T = unknown> {
  value: T;
  canonicalJson: string;
  reference: SafetyScoreV9ReplayArtifact;
}

interface ArtifactRow {
  artifact_key: string;
  artifact_kind: string;
  identity: string;
  content_sha256: string;
  encoding: string;
  uncompressed_bytes: number;
  stored_bytes: number;
  payload: string;
  created_at_sec: number;
  verified_at_sec: number;
}

interface AttemptRow {
  attempt_id: string;
  utc_day: string;
  scheduled_for_sec: number;
  started_at_sec: number | null;
  completed_at_sec: number | null;
  recorded_at_sec: number;
  outcome: string;
  qualifying: number;
  publication_generation_id: string | null;
  base_input_generation_id: string | null;
  fact_set_digest: string | null;
  policy_digest: string | null;
  evaluation_build_digest: string | null;
  producer_capability_digest: string | null;
  envelope_digest: string | null;
  attempt_json: string;
}

interface DayRow {
  utc_day: string;
  canonical_attempt_id: string | null;
  qualifying: number;
  expected_attempt_count: number;
  recorded_attempt_count: number;
  policy_digest: string | null;
  evaluation_build_digest: string | null;
  producer_capability_digest: string | null;
  day_json: string;
  updated_at_sec: number;
}

function resolveLimit(requested: number | undefined, hardMaximum: number, label: string): number {
  if (requested === undefined) return hardMaximum;
  if (!Number.isInteger(requested) || requested <= 0 || requested > hardMaximum) {
    throw new RangeError(`${label} must be a positive integer no greater than ${hardMaximum}`);
  }
  return requested;
}

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
    throw new Error("Malformed Safety Score v9 replay artifact base64 payload");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64(bytes) !== value) {
    throw new Error("Safety Score v9 replay artifact base64 payload is not canonical");
  }
  return bytes;
}

async function gzipBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  throwIfAborted(signal);
  return compressed;
}

async function gunzipBytesBounded(
  compressed: Uint8Array,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        throw new Error(`Safety Score v9 replay artifact exceeds ${maximumBytes} uncompressed bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  throwIfAborted(signal);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function artifactReference(artifact: SafetyScoreV9StoredReplayArtifact): SafetyScoreV9ReplayArtifact {
  return SafetyScoreV9ReplayArtifactSchema.parse({
    kind: artifact.kind,
    identity: artifact.identity,
    artifactRef: artifact.artifactKey,
    contentSha256: artifact.contentSha256,
    byteLength: artifact.uncompressedBytes,
    compression: "gzip",
    verification: {
      status: "verified",
      observedContentSha256: artifact.contentSha256,
      verifiedAtSec: artifact.verifiedAtSec,
    },
  });
}

export async function buildSafetyScoreV9ReplayArtifact(
  input: BuildSafetyScoreV9ReplayArtifactInput,
  options: ReplayArtifactOperationOptions = {},
): Promise<SafetyScoreV9StoredReplayArtifact> {
  throwIfAborted(options.signal);
  const kind = SafetyScoreV9ReplayArtifactKindSchema.parse(input.kind);
  const identity = input.identity.trim();
  if (identity.length === 0) throw new Error("Safety Score v9 replay artifact identity is required");
  const createdAtSec = UnixSecondsSchema.parse(input.createdAtSec);
  const verifiedAtSec = UnixSecondsSchema.parse(input.verifiedAtSec ?? createdAtSec);
  if (verifiedAtSec < createdAtSec) {
    throw new Error("Safety Score v9 replay artifact verification cannot predate creation");
  }
  const maxUncompressedBytes = resolveLimit(
    options.maxUncompressedBytes,
    SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_UNCOMPRESSED_BYTES,
    "Replay artifact uncompressed byte limit",
  );
  const maxStoredBytes = resolveLimit(
    options.maxStoredBytes,
    SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_STORED_BYTES,
    "Replay artifact stored byte limit",
  );
  const canonicalJson = stableJsonStringifyV1(input.value);
  const uncompressed = new TextEncoder().encode(canonicalJson);
  if (uncompressed.byteLength === 0 || uncompressed.byteLength > maxUncompressedBytes) {
    throw new Error(
      `Safety Score v9 ${kind} replay artifact is ${uncompressed.byteLength} uncompressed bytes; maximum is ${maxUncompressedBytes}`,
    );
  }
  const payload = bytesToBase64(await gzipBytes(uncompressed, options.signal));
  const storedBytes = utf8ByteLength(payload);
  if (storedBytes > maxStoredBytes) {
    throw new Error(
      `Safety Score v9 ${kind} replay artifact is ${storedBytes} stored bytes; maximum is ${maxStoredBytes}`,
    );
  }
  const contentSha256 = sha256Hex(canonicalJson);
  return SafetyScoreV9StoredReplayArtifactSchema.parse({
    artifactKey: `${kind}:${contentSha256}`,
    kind,
    identity,
    contentSha256,
    encoding: "gzip-base64",
    uncompressedBytes: uncompressed.byteLength,
    storedBytes,
    payload,
    createdAtSec,
    verifiedAtSec,
  });
}

export async function parseSafetyScoreV9ReplayArtifact<T = unknown>(
  artifactInput: SafetyScoreV9StoredReplayArtifact,
  options: ReplayArtifactOperationOptions & {
    expectedKind?: SafetyScoreV9ReplayArtifactKind;
    expectedIdentity?: string;
  } = {},
): Promise<ParsedSafetyScoreV9ReplayArtifact<T>> {
  throwIfAborted(options.signal);
  const artifact = SafetyScoreV9StoredReplayArtifactSchema.parse(artifactInput);
  if (options.expectedKind !== undefined && artifact.kind !== options.expectedKind) {
    throw new Error(`Expected Safety Score v9 ${options.expectedKind} artifact, received ${artifact.kind}`);
  }
  if (options.expectedIdentity !== undefined && artifact.identity !== options.expectedIdentity) {
    throw new Error("Safety Score v9 replay artifact identity mismatch");
  }
  const maxUncompressedBytes = resolveLimit(
    options.maxUncompressedBytes,
    SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_UNCOMPRESSED_BYTES,
    "Replay artifact uncompressed byte limit",
  );
  const maxStoredBytes = resolveLimit(
    options.maxStoredBytes,
    SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_STORED_BYTES,
    "Replay artifact stored byte limit",
  );
  if (artifact.uncompressedBytes > maxUncompressedBytes) {
    throw new Error(`Safety Score v9 replay artifact exceeds ${maxUncompressedBytes} uncompressed bytes`);
  }
  if (artifact.storedBytes !== utf8ByteLength(artifact.payload) || artifact.storedBytes > maxStoredBytes) {
    throw new Error("Safety Score v9 replay artifact stored byte length is invalid");
  }
  const decompressed = await gunzipBytesBounded(
    base64ToBytes(artifact.payload),
    Math.min(maxUncompressedBytes, artifact.uncompressedBytes),
    options.signal,
  );
  if (decompressed.byteLength !== artifact.uncompressedBytes) {
    throw new Error("Safety Score v9 replay artifact uncompressed byte length mismatch");
  }
  const canonicalJson = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decompressed);
  if (sha256Hex(canonicalJson) !== artifact.contentSha256) {
    throw new Error("Safety Score v9 replay artifact checksum mismatch");
  }
  const parsed = parseJson(canonicalJson);
  if (!parsed.ok) throw new Error(`Malformed Safety Score v9 replay artifact JSON: ${parsed.message}`);
  if (stableJsonStringifyV1(parsed.value) !== canonicalJson) {
    throw new Error("Safety Score v9 replay artifact JSON is not canonical");
  }
  throwIfAborted(options.signal);
  return {
    value: parsed.value as T,
    canonicalJson,
    reference: artifactReference(artifact),
  };
}

function mapArtifactRow(row: ArtifactRow): SafetyScoreV9StoredReplayArtifact {
  return SafetyScoreV9StoredReplayArtifactSchema.parse({
    artifactKey: row.artifact_key,
    kind: row.artifact_kind,
    identity: row.identity,
    contentSha256: row.content_sha256,
    encoding: row.encoding,
    uncompressedBytes: row.uncompressed_bytes,
    storedBytes: row.stored_bytes,
    payload: row.payload,
    createdAtSec: row.created_at_sec,
    verifiedAtSec: row.verified_at_sec,
  });
}

function prepareArtifactInsert(
  db: D1Database,
  artifact: SafetyScoreV9StoredReplayArtifact,
  conflictClause: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO safety_score_v9_artifacts
       (artifact_key, artifact_kind, identity, content_sha256, encoding,
        uncompressed_bytes, stored_bytes, payload, created_at_sec, verified_at_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ${conflictClause}`,
    )
    .bind(
      artifact.artifactKey,
      artifact.kind,
      artifact.identity,
      artifact.contentSha256,
      artifact.encoding,
      artifact.uncompressedBytes,
      artifact.storedBytes,
      artifact.payload,
      artifact.createdAtSec,
      artifact.verifiedAtSec,
    );
}

async function findArtifactConflictRows(
  db: D1Database,
  artifact: SafetyScoreV9StoredReplayArtifact,
  signal?: AbortSignal,
): Promise<SafetyScoreV9StoredReplayArtifact[]> {
  throwIfAborted(signal);
  const rows = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT artifact_key, artifact_kind, identity, content_sha256, encoding,
                  uncompressed_bytes, stored_bytes, payload, created_at_sec, verified_at_sec
           FROM safety_score_v9_artifacts
           WHERE artifact_key = ? OR (artifact_kind = ? AND identity = ?)
           ORDER BY artifact_key`,
        )
        .bind(artifact.artifactKey, artifact.kind, artifact.identity)
        .all<ArtifactRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return (rows.results ?? []).map(mapArtifactRow);
}

async function resolveExistingArtifact(
  rows: readonly SafetyScoreV9StoredReplayArtifact[],
  artifact: SafetyScoreV9StoredReplayArtifact,
  signal?: AbortSignal,
): Promise<SafetyScoreV9StoredReplayArtifact | null> {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new SafetyScoreV9StoreConflictError(
      `Multiple immutable Safety Score v9 artifacts conflict with ${artifact.kind}:${artifact.identity}`,
    );
  }
  const existing = rows[0]!;
  if (
    existing.artifactKey !== artifact.artifactKey ||
    existing.kind !== artifact.kind ||
    existing.identity !== artifact.identity ||
    existing.contentSha256 !== artifact.contentSha256 ||
    existing.uncompressedBytes !== artifact.uncompressedBytes
  ) {
    throw new SafetyScoreV9StoreConflictError(
      `Immutable Safety Score v9 artifact conflict for ${artifact.kind}:${artifact.identity}`,
    );
  }
  await parseSafetyScoreV9ReplayArtifact(existing, {
    expectedKind: artifact.kind,
    expectedIdentity: artifact.identity,
    signal,
  });
  return existing;
}

export async function persistSafetyScoreV9ReplayArtifact(
  db: D1Database,
  artifactInput: SafetyScoreV9StoredReplayArtifact,
  signal?: AbortSignal,
): Promise<SafetyScoreV9StoredReplayArtifact> {
  throwIfAborted(signal);
  const artifact = SafetyScoreV9StoredReplayArtifactSchema.parse(artifactInput);
  await parseSafetyScoreV9ReplayArtifact(artifact, { signal });
  const existing = await resolveExistingArtifact(
    await findArtifactConflictRows(db, artifact, signal),
    artifact,
    signal,
  );
  if (existing) return existing;

  const result = await runWithOverloadRetry(
    () => prepareArtifactInsert(db, artifact, "ON CONFLICT DO NOTHING").run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (Number(result.meta.changes ?? 0) > 0) return artifact;

  const racedExisting = await resolveExistingArtifact(
    await findArtifactConflictRows(db, artifact, signal),
    artifact,
    signal,
  );
  if (!racedExisting) {
    throw new SafetyScoreV9StoreConflictError(
      `Safety Score v9 artifact insert for ${artifact.kind}:${artifact.identity} made no durable change`,
    );
  }
  return racedExisting;
}

export async function loadSafetyScoreV9ReplayArtifact(
  db: D1Database,
  kind: SafetyScoreV9ReplayArtifactKind,
  identity: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9StoredReplayArtifact | null> {
  throwIfAborted(signal);
  const parsedKind = SafetyScoreV9ReplayArtifactKindSchema.parse(kind);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT artifact_key, artifact_kind, identity, content_sha256, encoding,
                  uncompressed_bytes, stored_bytes, payload, created_at_sec, verified_at_sec
           FROM safety_score_v9_artifacts
           WHERE artifact_kind = ? AND identity = ?`,
        )
        .bind(parsedKind, identity)
        .first<ArtifactRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (!row) return null;
  const artifact = mapArtifactRow(row);
  await parseSafetyScoreV9ReplayArtifact(artifact, {
    expectedKind: parsedKind,
    expectedIdentity: identity,
    signal,
  });
  return artifact;
}

function parseCanonicalJson<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  const parsed = parseJson(raw);
  if (!parsed.ok) throw new Error(`Malformed ${label} JSON: ${parsed.message}`);
  const value = schema.parse(parsed.value);
  if (stableJsonStringifyV1(value) !== raw) throw new Error(`${label} JSON is not canonical`);
  return value;
}

function expectedAttemptColumns(attempt: SafetyScoreV9ShadowAttempt) {
  return {
    utcDay: attempt.utcDay,
    scheduledForSec: attempt.scheduledForSec,
    startedAtSec: attempt.startedAtSec,
    completedAtSec: attempt.completedAtSec,
    recordedAtSec: attempt.recordedAtSec,
    outcome: attempt.outcome,
    qualifying: attempt.qualification?.qualifies ? 1 : 0,
    publicationGenerationId: attempt.identity?.publicationGenerationId ?? null,
    baseInputGenerationId: attempt.identity?.baseInputGenerationId ?? null,
    factSetDigest: attempt.identity?.factSetDigest ?? null,
    policyDigest: attempt.identity?.policyDigest ?? null,
    evaluationBuildDigest: attempt.identity?.evaluationBuildDigest ?? null,
    producerCapabilityDigest: attempt.identity?.producerCapabilityDigest ?? null,
    envelopeDigest: attempt.identity?.envelopeDigest ?? null,
  };
}

function prepareAttemptInsert(
  db: D1Database,
  attempt: SafetyScoreV9ShadowAttempt,
  attemptJson: string,
  conflictClause: string,
): D1PreparedStatement {
  const columns = expectedAttemptColumns(attempt);
  return db
    .prepare(
      `INSERT INTO safety_score_v9_shadow_attempts
       (attempt_id, utc_day, scheduled_for_sec, started_at_sec, completed_at_sec,
        recorded_at_sec, outcome, qualifying, publication_generation_id,
        base_input_generation_id, fact_set_digest, policy_digest,
        evaluation_build_digest, producer_capability_digest, envelope_digest, attempt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ${conflictClause}`,
    )
    .bind(
      attempt.attemptId,
      columns.utcDay,
      columns.scheduledForSec,
      columns.startedAtSec,
      columns.completedAtSec,
      columns.recordedAtSec,
      columns.outcome,
      columns.qualifying,
      columns.publicationGenerationId,
      columns.baseInputGenerationId,
      columns.factSetDigest,
      columns.policyDigest,
      columns.evaluationBuildDigest,
      columns.producerCapabilityDigest,
      columns.envelopeDigest,
      attemptJson,
    );
}

function parseAttemptRow(row: AttemptRow): SafetyScoreV9ShadowAttempt {
  const attempt = parseCanonicalJson(row.attempt_json, SafetyScoreV9ShadowAttemptSchema, "Safety Score v9 attempt");
  if (attempt.attemptId !== row.attempt_id) throw new Error("Safety Score v9 attempt row ID mismatch");
  const expected = expectedAttemptColumns(attempt);
  const observed = {
    utcDay: row.utc_day,
    scheduledForSec: row.scheduled_for_sec,
    startedAtSec: row.started_at_sec,
    completedAtSec: row.completed_at_sec,
    recordedAtSec: row.recorded_at_sec,
    outcome: row.outcome,
    qualifying: row.qualifying,
    publicationGenerationId: row.publication_generation_id,
    baseInputGenerationId: row.base_input_generation_id,
    factSetDigest: row.fact_set_digest,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    producerCapabilityDigest: row.producer_capability_digest,
    envelopeDigest: row.envelope_digest,
  };
  if (stableJsonStringifyV1(observed) !== stableJsonStringifyV1(expected)) {
    throw new Error(`Safety Score v9 attempt row projection mismatch for ${attempt.attemptId}`);
  }
  return attempt;
}

async function loadAttemptRow(
  db: D1Database,
  attemptId: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowAttempt | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT attempt_id, utc_day, scheduled_for_sec, started_at_sec, completed_at_sec,
                  recorded_at_sec, outcome, qualifying, publication_generation_id,
                  base_input_generation_id, fact_set_digest, policy_digest,
                  evaluation_build_digest, producer_capability_digest, envelope_digest, attempt_json
           FROM safety_score_v9_shadow_attempts
           WHERE attempt_id = ?`,
        )
        .bind(attemptId)
        .first<AttemptRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ? parseAttemptRow(row) : null;
}

export async function persistSafetyScoreV9ShadowAttempt(
  db: D1Database,
  attemptInput: SafetyScoreV9ShadowAttempt,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowAttempt> {
  throwIfAborted(signal);
  const attempt = SafetyScoreV9ShadowAttemptSchema.parse(attemptInput);
  const attemptJson = stableJsonStringifyV1(attempt);
  const existing = await loadAttemptRow(db, attempt.attemptId, signal);
  if (existing) {
    if (stableJsonStringifyV1(existing) !== attemptJson) {
      throw new SafetyScoreV9StoreConflictError(`Immutable Safety Score v9 attempt conflict for ${attempt.attemptId}`);
    }
    return existing;
  }
  const result = await runWithOverloadRetry(
    () => prepareAttemptInsert(db, attempt, attemptJson, "ON CONFLICT(attempt_id) DO NOTHING").run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (Number(result.meta.changes ?? 0) > 0) return attempt;
  const racedExisting = await loadAttemptRow(db, attempt.attemptId, signal);
  if (!racedExisting || stableJsonStringifyV1(racedExisting) !== attemptJson) {
    throw new SafetyScoreV9StoreConflictError(`Immutable Safety Score v9 attempt conflict for ${attempt.attemptId}`);
  }
  return racedExisting;
}

function canonicalAttemptForDay(day: SafetyScoreV9ShadowDay): SafetyScoreV9ShadowAttempt | null {
  const generationId = day.projection.canonicalQualifyingGenerationId;
  if (generationId === null) return null;
  return (
    day.attempts
      .filter(
        (attempt) =>
          attempt.outcome === "succeeded" &&
          attempt.qualification?.qualifies === true &&
          attempt.identity?.publicationGenerationId === generationId,
      )
      .sort(
        (left, right) =>
          (left.completedAtSec ?? Number.MAX_SAFE_INTEGER) - (right.completedAtSec ?? Number.MAX_SAFE_INTEGER) ||
          left.attemptId.localeCompare(right.attemptId),
      )[0] ?? null
  );
}

function expectedDayColumns(day: SafetyScoreV9ShadowDay) {
  const canonicalAttempt = canonicalAttemptForDay(day);
  return {
    canonicalAttemptId: canonicalAttempt?.attemptId ?? null,
    qualifying: day.projection.qualifies ? 1 : 0,
    expectedAttemptCount: day.projection.expectedScheduledAttemptIds.length,
    recordedAttemptCount: day.attempts.length,
    policyDigest: canonicalAttempt?.identity?.policyDigest ?? null,
    evaluationBuildDigest: canonicalAttempt?.identity?.evaluationBuildDigest ?? null,
    producerCapabilityDigest: canonicalAttempt?.identity?.producerCapabilityDigest ?? null,
  };
}

function parseDayRow(row: DayRow): SafetyScoreV9ShadowDay {
  const day = parseCanonicalJson(row.day_json, SafetyScoreV9ShadowDaySchema, "Safety Score v9 shadow day");
  if (day.utcDay !== row.utc_day) throw new Error("Safety Score v9 shadow day row date mismatch");
  const expected = expectedDayColumns(day);
  const observed = {
    canonicalAttemptId: row.canonical_attempt_id,
    qualifying: row.qualifying,
    expectedAttemptCount: row.expected_attempt_count,
    recordedAttemptCount: row.recorded_attempt_count,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    producerCapabilityDigest: row.producer_capability_digest,
  };
  if (stableJsonStringifyV1(observed) !== stableJsonStringifyV1(expected)) {
    throw new Error(`Safety Score v9 shadow day row projection mismatch for ${day.utcDay}`);
  }
  return day;
}

function serializeCacheValue<T>(value: T, schema: z.ZodType<T>, label: string): string {
  const canonical = stableJsonStringifyV1(schema.parse(value));
  const byteLength = utf8ByteLength(canonical);
  if (byteLength > SAFETY_SCORE_V9_SHADOW_CACHE_MAX_BYTES) {
    throw new Error(`${label} is ${byteLength} bytes; maximum is ${SAFETY_SCORE_V9_SHADOW_CACHE_MAX_BYTES}`);
  }
  return canonical;
}

function validateSuccessfulState(input: {
  artifacts: readonly SafetyScoreV9StoredReplayArtifact[];
  attempt: SafetyScoreV9ShadowAttempt;
  envelope: SafetyScoreV9ShadowEnvelope;
  diff: SafetyScoreV9DiffReport;
}): void {
  const identity = input.attempt.identity;
  if (input.attempt.outcome !== "succeeded" || identity === null) {
    throw new Error("Latest Safety Score v9 state requires a successful shadow attempt");
  }
  if (identity.envelopeDigest !== computeSafetyScoreV9ShadowEnvelopeDigest(input.envelope)) {
    throw new Error("Safety Score v9 attempt and candidate envelope digests do not match");
  }
  if (
    input.diff.v9Identity.publicationGenerationId !== identity.publicationGenerationId ||
    input.diff.v9Identity.baseInputGenerationId !== identity.baseInputGenerationId ||
    input.diff.v9Identity.factSetDigest !== identity.factSetDigest ||
    input.diff.v9Identity.policyDigest !== identity.policyDigest ||
    input.diff.v9Identity.evaluationBuildDigest !== identity.evaluationBuildDigest ||
    input.diff.v9Identity.resultDigest !== identity.resultDigest
  ) {
    throw new Error("Safety Score v9 diff identity does not match its shadow attempt");
  }
  const referencesByKind = new Map(input.envelope.replayArtifacts.map((reference) => [reference.kind, reference]));
  const artifactsByKind = new Map(input.artifacts.map((artifact) => [artifact.kind, artifact]));
  if (
    referencesByKind.size !== SafetyScoreV9ReplayArtifactKindSchema.options.length ||
    artifactsByKind.size !== SafetyScoreV9ReplayArtifactKindSchema.options.length ||
    input.artifacts.length !== artifactsByKind.size
  ) {
    throw new Error("Safety Score v9 successful shadow state requires exactly one artifact of every kind");
  }
  for (const kind of SafetyScoreV9ReplayArtifactKindSchema.options) {
    const artifact = artifactsByKind.get(kind);
    const reference = referencesByKind.get(kind);
    if (!artifact || !reference || stableJsonStringifyV1(artifactReference(artifact)) !== stableJsonStringifyV1(reference)) {
      throw new Error(`Safety Score v9 ${kind} replay artifact does not match the candidate envelope`);
    }
  }
}

export interface PersistSafetyScoreV9ShadowStateInput {
  artifacts?: readonly SafetyScoreV9StoredReplayArtifact[];
  attempt: SafetyScoreV9ShadowAttempt;
  day: SafetyScoreV9ShadowDay;
  envelope?: SafetyScoreV9ShadowEnvelope;
  diff?: SafetyScoreV9DiffReport;
  updatedAtSec?: number;
  signal?: AbortSignal;
}

export async function persistSafetyScoreV9ShadowState(
  db: D1Database,
  input: PersistSafetyScoreV9ShadowStateInput,
): Promise<void> {
  throwIfAborted(input.signal);
  const artifacts = (input.artifacts ?? []).map((artifact) => SafetyScoreV9StoredReplayArtifactSchema.parse(artifact));
  const attempt = SafetyScoreV9ShadowAttemptSchema.parse(input.attempt);
  const day = SafetyScoreV9ShadowDaySchema.parse(input.day);
  const dayAttempt = day.attempts.find((candidate) => candidate.attemptId === attempt.attemptId);
  if (!dayAttempt || stableJsonStringifyV1(dayAttempt) !== stableJsonStringifyV1(attempt)) {
    throw new Error("Safety Score v9 daily history must contain the exact persisted attempt");
  }
  const hasLatest = input.envelope !== undefined || input.diff !== undefined;
  let envelope: SafetyScoreV9ShadowEnvelope | null = null;
  let diff: SafetyScoreV9DiffReport | null = null;
  let envelopeJson: string | null = null;
  let diffJson: string | null = null;
  if (hasLatest) {
    if (input.envelope === undefined || input.diff === undefined) {
      throw new Error("Safety Score v9 latest envelope and diff must be persisted together");
    }
    envelope = SafetyScoreV9ShadowEnvelopeSchema.parse(input.envelope);
    diff = SafetyScoreV9DiffReportSchema.parse(input.diff);
    validateSuccessfulState({ artifacts, attempt, envelope, diff });
    envelopeJson = serializeCacheValue(envelope, SafetyScoreV9ShadowEnvelopeSchema, "Safety Score v9 shadow envelope");
    diffJson = serializeCacheValue(diff, SafetyScoreV9DiffReportSchema, "Safety Score v9 diff report");
  } else if (attempt.outcome === "succeeded") {
    throw new Error("A successful Safety Score v9 shadow attempt must persist its latest envelope and diff");
  }
  for (const artifact of artifacts) {
    await parseSafetyScoreV9ReplayArtifact(artifact, { signal: input.signal });
  }
  const artifactKeys = artifacts.map((artifact) => artifact.artifactKey);
  const artifactIdentities = artifacts.map((artifact) => `${artifact.kind}:${artifact.identity}`);
  if (
    new Set(artifactKeys).size !== artifactKeys.length ||
    new Set(artifactIdentities).size !== artifactIdentities.length
  ) {
    throw new Error("Safety Score v9 state cannot contain duplicate replay artifact keys or identities");
  }
  const updatedAtSec = UnixSecondsSchema.parse(input.updatedAtSec ?? attempt.recordedAtSec);
  const dayJson = stableJsonStringifyV1(day);
  const dayColumns = expectedDayColumns(day);
  const missingArtifacts: SafetyScoreV9StoredReplayArtifact[] = [];
  for (const artifact of artifacts) {
    const existing = await resolveExistingArtifact(
      await findArtifactConflictRows(db, artifact, input.signal),
      artifact,
      input.signal,
    );
    if (!existing) missingArtifacts.push(artifact);
  }
  const attemptJson = stableJsonStringifyV1(attempt);
  const existingAttempt = await loadAttemptRow(db, attempt.attemptId, input.signal);
  if (existingAttempt && stableJsonStringifyV1(existingAttempt) !== attemptJson) {
    throw new SafetyScoreV9StoreConflictError(`Immutable Safety Score v9 attempt conflict for ${attempt.attemptId}`);
  }

  // Missing immutable rows use plain INSERT inside the same transaction. A
  // concurrent writer therefore aborts the whole batch; a retry can then
  // validate and reuse the winner without partially committing latest state.
  const statements: D1PreparedStatement[] = missingArtifacts.map((artifact) =>
    prepareArtifactInsert(db, artifact, ""),
  );
  if (!existingAttempt) statements.push(prepareAttemptInsert(db, attempt, attemptJson, ""));
  statements.push(
    db
      .prepare(
        `INSERT INTO safety_score_v9_shadow_days
         (utc_day, canonical_attempt_id, qualifying, expected_attempt_count, recorded_attempt_count,
          policy_digest, evaluation_build_digest, producer_capability_digest, day_json, updated_at_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(utc_day) DO UPDATE SET
           canonical_attempt_id = excluded.canonical_attempt_id,
           qualifying = excluded.qualifying,
           expected_attempt_count = excluded.expected_attempt_count,
           recorded_attempt_count = excluded.recorded_attempt_count,
           policy_digest = excluded.policy_digest,
           evaluation_build_digest = excluded.evaluation_build_digest,
           producer_capability_digest = excluded.producer_capability_digest,
           day_json = excluded.day_json,
           updated_at_sec = CASE
             WHEN safety_score_v9_shadow_days.updated_at_sec <= excluded.updated_at_sec
               THEN excluded.updated_at_sec
             ELSE -1
           END`,
      )
      .bind(
        day.utcDay,
        dayColumns.canonicalAttemptId,
        dayColumns.qualifying,
        dayColumns.expectedAttemptCount,
        dayColumns.recordedAttemptCount,
        dayColumns.policyDigest,
        dayColumns.evaluationBuildDigest,
        dayColumns.producerCapabilityDigest,
        dayJson,
        updatedAtSec,
      ),
  );
  if (envelopeJson !== null && diffJson !== null) {
    const cacheStatement = db.prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE WHEN cache.updated_at <= excluded.updated_at THEN excluded.value ELSE NULL END,
         updated_at = excluded.updated_at`,
    );
    statements.push(
      cacheStatement.bind(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, envelopeJson, updatedAtSec),
      cacheStatement.bind(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff, diffJson, updatedAtSec),
    );
  }
  await executeAtomicBatch(db, statements, { signal: input.signal });
  throwIfAborted(input.signal);
}

async function loadCanonicalCacheValue<T>(
  db: D1Database,
  key: string,
  schema: z.ZodType<T>,
  label: string,
  signal?: AbortSignal,
): Promise<T | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () => db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (!row) return null;
  if (utf8ByteLength(row.value) > SAFETY_SCORE_V9_SHADOW_CACHE_MAX_BYTES) {
    throw new Error(`${label} exceeds the cache byte limit`);
  }
  return parseCanonicalJson(row.value, schema, label);
}

export async function loadLatestSafetyScoreV9ShadowEnvelope(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowEnvelope | null> {
  return loadCanonicalCacheValue(
    db,
    SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope,
    SafetyScoreV9ShadowEnvelopeSchema,
    "Safety Score v9 shadow envelope",
    signal,
  );
}

export async function loadLatestSafetyScoreV9DiffReport(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9DiffReport | null> {
  return loadCanonicalCacheValue(
    db,
    SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff,
    SafetyScoreV9DiffReportSchema,
    "Safety Score v9 diff report",
    signal,
  );
}

export interface LoadSafetyScoreV9ShadowHistoryOptions {
  fromUtcDay?: string;
  toUtcDay?: string;
  limit?: number;
  signal?: AbortSignal;
}

export async function loadSafetyScoreV9ShadowHistory(
  db: D1Database,
  options: LoadSafetyScoreV9ShadowHistoryOptions = {},
): Promise<SafetyScoreV9ShadowDay[]> {
  throwIfAborted(options.signal);
  const limit = options.limit ?? SAFETY_SCORE_V9_SHADOW_HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT) {
    throw new RangeError(
      `Safety Score v9 shadow history limit must be 1-${SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT}`,
    );
  }
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (options.fromUtcDay !== undefined) {
    conditions.push("utc_day >= ?");
    bindings.push(options.fromUtcDay);
  }
  if (options.toUtcDay !== undefined) {
    conditions.push("utc_day <= ?");
    bindings.push(options.toUtcDay);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT utc_day, canonical_attempt_id, qualifying, expected_attempt_count,
                  recorded_attempt_count, policy_digest, evaluation_build_digest,
                  producer_capability_digest, day_json, updated_at_sec
           FROM safety_score_v9_shadow_days
           ${where}
           ORDER BY utc_day DESC
           LIMIT ?`,
        )
        .bind(...bindings, limit)
        .all<DayRow>(),
    3,
    options.signal,
  );
  throwIfAborted(options.signal);
  return (rows.results ?? []).map(parseDayRow);
}
