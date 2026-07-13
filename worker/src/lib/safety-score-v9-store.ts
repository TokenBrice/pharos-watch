import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";
import { throwIfAborted } from "./abort";
import { gzipCanonicalJson } from "./canonical-json-gzip";
import { runWithOverloadRetry } from "./cron-lease";
import { executeAtomicBatch } from "./db";
import { sha256Hex } from "./hash";
import { parseJson } from "./json-parse";
import {
  parseSafetyScoreV9DiffReportCacheValue,
  parseSafetyScoreV9ShadowEnvelopeCacheValue,
  serializeSafetyScoreV9DiffReportCacheValue,
  serializeSafetyScoreV9ShadowEnvelopeCacheValue,
} from "./safety-score-v9-cache-codec";
import {
  SafetyScoreV9DiffReportSchema,
  SafetyScoreV9ReplayArtifactKindSchema,
  SafetyScoreV9ReplayArtifactSchema,
  SafetyScoreV9ShadowDailySchema,
  SafetyScoreV9ShadowEnvelopeSchema,
  computeSafetyScoreV9ShadowEnvelopeDigest,
  type SafetyScoreV9DiffReport,
  type SafetyScoreV9ReplayArtifact,
  type SafetyScoreV9ReplayArtifactKind,
  type SafetyScoreV9ShadowDaily,
  type SafetyScoreV9ShadowEnvelope,
} from "./safety-score-v9-shadow";

export const SAFETY_SCORE_V9_SHADOW_CACHE_KEYS = {
  envelope: "report-cards:v9-shadow",
  diff: "report-cards:v9-shadow:diff",
} as const;

export const SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_UNCOMPRESSED_BYTES = 12 * 1_024 * 1_024;
export const SAFETY_SCORE_V9_REPLAY_ARTIFACT_MAX_STORED_BYTES = 1_900_000;
export const SAFETY_SCORE_V9_SHADOW_HISTORY_DEFAULT_LIMIT = 45;
export const SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT = 400;

export {
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_BYTES,
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES,
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_UNCOMPRESSED_BYTES,
} from "./safety-score-v9-cache-codec";

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

declare const SAFETY_SCORE_V9_LOCAL_ARTIFACT_BUNDLE_BRAND: unique symbol;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

interface SafetyScoreV9LocalArtifactBundleData {
  readonly artifacts: readonly SafetyScoreV9StoredReplayArtifact[];
  readonly references: readonly SafetyScoreV9ReplayArtifact[];
}

export interface SafetyScoreV9LocalArtifactBundle {
  readonly [SAFETY_SCORE_V9_LOCAL_ARTIFACT_BUNDLE_BRAND]: true;
}

const LOCAL_ARTIFACT_BUNDLE_ACCESS = (() => {
  const dataByBundle = new WeakMap<object, SafetyScoreV9LocalArtifactBundleData>();

  return Object.freeze({
    create(data: SafetyScoreV9LocalArtifactBundleData): SafetyScoreV9LocalArtifactBundle {
      const bundle = Object.freeze(Object.create(null) as object);
      dataByBundle.set(bundle, data);
      return bundle as SafetyScoreV9LocalArtifactBundle;
    },
    read(bundle: SafetyScoreV9LocalArtifactBundle): SafetyScoreV9LocalArtifactBundleData {
      if (bundle === null || typeof bundle !== "object") {
        throw new Error("Invalid locally built Safety Score v9 artifact bundle");
      }
      const data = dataByBundle.get(bundle);
      if (data === undefined) throw new Error("Invalid locally built Safety Score v9 artifact bundle");
      return data;
    },
  });
})();

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

interface DailyRow {
  utc_day: string;
  updated_at_sec: number;
  successful_attempt_count: number;
  failed_attempt_count: number;
  selected_run_at_sec: number | null;
  publication_generation_id: string | null;
  base_input_generation_id: string | null;
  fact_set_digest: string | null;
  policy_digest: string | null;
  evaluation_build_digest: string | null;
  producer_capability_digest: string | null;
  release_coverage_policy_digest: string | null;
  consumer_threshold_registry_digest: string | null;
  result_digest: string | null;
  diff_report_digest: string | null;
  active_asset_count: number | null;
  rateable_count: number | null;
  nr_count: number | null;
  present_active_count: number | null;
  missing_active_count: number | null;
  unexpected_active_count: number | null;
  duplicate_active_count: number | null;
  grade_nr_transition_count: number | null;
  large_score_movement_count: number | null;
  top_cutoff_movement_count: number | null;
  binding_cap_change_count: number | null;
  downstream_crossing_count: number | null;
  unresolved_review_count: number | null;
  qualifying: number;
  blockers_json: string;
  archive_selection_reasons_json: string;
  latest_error_code: string | null;
  latest_error_message: string | null;
  daily_json: string;
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

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function maximumBytesBeforeBase64(maximumEncodedBytes: number): number {
  return Math.floor(maximumEncodedBytes / 4) * 3;
}

function base64ToBytes(value: string, label = "Safety Score v9 replay artifact"): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`Malformed ${label} base64 payload`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64(bytes) !== value) {
    throw new Error(`${label} base64 payload is not canonical`);
  }
  return bytes;
}

async function gunzipBytesBounded(
  compressed: Uint8Array,
  maximumBytes: number,
  signal?: AbortSignal,
  label = "Safety Score v9 replay artifact",
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const output = new Uint8Array(maximumBytes);
  let byteLength = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        throw new Error(`${label} exceeds ${maximumBytes} uncompressed bytes`);
      }
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
  const compressed = await gzipCanonicalJson(canonicalJson, {
    label: `Safety Score v9 ${kind} replay artifact`,
    maximumCompressedBytes: maximumBytesBeforeBase64(maxStoredBytes),
    maximumUncompressedBytes: maxUncompressedBytes,
    signal: options.signal,
  });
  const storedBytes = 4 * Math.ceil(compressed.compressed.byteLength / 3);
  if (storedBytes > maxStoredBytes) {
    throw new Error(
      `Safety Score v9 ${kind} replay artifact is ${storedBytes} stored bytes; maximum is ${maxStoredBytes}`,
    );
  }
  const payload = bytesToBase64(compressed.compressed);
  const contentSha256 = compressed.contentSha256;
  return SafetyScoreV9StoredReplayArtifactSchema.parse({
    artifactKey: `${kind}:${contentSha256}`,
    kind,
    identity,
    contentSha256,
    encoding: "gzip-base64",
    uncompressedBytes: compressed.uncompressedBytes,
    storedBytes,
    payload,
    createdAtSec,
    verifiedAtSec,
  });
}

function localArtifactBundleData(bundle: SafetyScoreV9LocalArtifactBundle): SafetyScoreV9LocalArtifactBundleData {
  return LOCAL_ARTIFACT_BUNDLE_ACCESS.read(bundle);
}

export async function buildSafetyScoreV9LocalArtifactBundle(
  inputs: readonly BuildSafetyScoreV9ReplayArtifactInput[],
  options: ReplayArtifactOperationOptions = {},
): Promise<SafetyScoreV9LocalArtifactBundle> {
  const artifacts: SafetyScoreV9StoredReplayArtifact[] = [];
  const references: SafetyScoreV9ReplayArtifact[] = [];
  for (const input of inputs) {
    throwIfAborted(options.signal);
    const artifact = deepFreeze(await buildSafetyScoreV9ReplayArtifact(input, options));
    artifacts.push(artifact);
    references.push(deepFreeze(artifactReference(artifact)));
  }
  const data: SafetyScoreV9LocalArtifactBundleData = Object.freeze({
    artifacts: Object.freeze(artifacts),
    references: Object.freeze(references),
  });
  return LOCAL_ARTIFACT_BUNDLE_ACCESS.create(data);
}

export function getSafetyScoreV9LocalArtifactBundleArtifacts(
  bundle: SafetyScoreV9LocalArtifactBundle,
): readonly DeepReadonly<SafetyScoreV9StoredReplayArtifact>[] {
  return localArtifactBundleData(bundle).artifacts;
}

export function getSafetyScoreV9LocalArtifactBundleReferences(
  bundle: SafetyScoreV9LocalArtifactBundle,
): readonly DeepReadonly<SafetyScoreV9ReplayArtifact>[] {
  return localArtifactBundleData(bundle).references;
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
  const canonicalJson = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decompressed);
  if ((await sha256Hex(decompressed)) !== artifact.contentSha256) {
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
  trustExactLocalRepresentation = false,
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
  if (
    trustExactLocalRepresentation &&
    existing.encoding === artifact.encoding &&
    existing.storedBytes === artifact.storedBytes &&
    existing.payload === artifact.payload
  ) {
    return existing;
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

function expectedDailyColumns(daily: SafetyScoreV9ShadowDaily) {
  const selected = daily.selectedRun;
  return {
    updatedAtSec: daily.updatedAtSec,
    successfulAttemptCount: daily.attemptCounts.successful,
    failedAttemptCount: daily.attemptCounts.failed,
    selectedRunAtSec: selected?.selectedAtSec ?? null,
    publicationGenerationId: selected?.identity.publicationGenerationId ?? null,
    baseInputGenerationId: selected?.identity.baseInputGenerationId ?? null,
    factSetDigest: selected?.identity.factSetDigest ?? null,
    policyDigest: selected?.identity.policyDigest ?? null,
    evaluationBuildDigest: selected?.identity.evaluationBuildDigest ?? null,
    producerCapabilityDigest: selected?.identity.producerCapabilityDigest ?? null,
    releaseCoveragePolicyDigest: selected?.identity.releaseCoveragePolicyDigest ?? null,
    consumerThresholdRegistryDigest: selected?.identity.consumerThresholdRegistryDigest ?? null,
    resultDigest: selected?.identity.resultDigest ?? null,
    diffReportDigest: selected?.diffReportDigest ?? null,
    activeAssetCount: selected?.coverage.expectedActiveCount ?? null,
    rateableCount: selected?.coverage.ratedResultCount ?? null,
    nrCount: selected?.coverage.notRatedResultCount ?? null,
    presentActiveCount: selected?.coverage.presentExpectedCount ?? null,
    missingActiveCount: selected?.coverage.missingIds.length ?? null,
    unexpectedActiveCount: selected?.coverage.unexpectedIds.length ?? null,
    duplicateActiveCount: selected?.coverage.duplicateIds.length ?? null,
    gradeNrTransitionCount: selected?.movement.gradeOrNrTransitionCount ?? null,
    largeScoreMovementCount: selected?.movement.largeScoreMovementCount ?? null,
    topCutoffMovementCount: selected?.movement.topCutoffMovementCount ?? null,
    bindingCapChangeCount: selected?.movement.bindingCapChangeCount ?? null,
    downstreamCrossingCount: selected?.movement.downstreamCrossingCount ?? null,
    unresolvedReviewCount: selected?.movement.pendingReviewCount ?? null,
    qualifying: selected?.qualification.qualifies ? 1 : 0,
    blockersJson: stableJsonStringifyV1(selected?.qualification.blockers ?? []),
    archiveSelectionReasonsJson: stableJsonStringifyV1(selected?.archiveSelectionReasons ?? []),
    latestErrorCode: daily.latestError?.code ?? null,
    latestErrorMessage: daily.latestError?.message ?? null,
  };
}

function parseDailyRow(row: DailyRow): SafetyScoreV9ShadowDaily {
  const daily = parseCanonicalJson(row.daily_json, SafetyScoreV9ShadowDailySchema, "Safety Score v9 shadow daily");
  if (daily.utcDay !== row.utc_day) throw new Error("Safety Score v9 shadow daily row date mismatch");
  const expected = expectedDailyColumns(daily);
  const observed = {
    updatedAtSec: row.updated_at_sec,
    successfulAttemptCount: row.successful_attempt_count,
    failedAttemptCount: row.failed_attempt_count,
    selectedRunAtSec: row.selected_run_at_sec,
    publicationGenerationId: row.publication_generation_id,
    baseInputGenerationId: row.base_input_generation_id,
    factSetDigest: row.fact_set_digest,
    policyDigest: row.policy_digest,
    evaluationBuildDigest: row.evaluation_build_digest,
    producerCapabilityDigest: row.producer_capability_digest,
    releaseCoveragePolicyDigest: row.release_coverage_policy_digest,
    consumerThresholdRegistryDigest: row.consumer_threshold_registry_digest,
    resultDigest: row.result_digest,
    diffReportDigest: row.diff_report_digest,
    activeAssetCount: row.active_asset_count,
    rateableCount: row.rateable_count,
    nrCount: row.nr_count,
    presentActiveCount: row.present_active_count,
    missingActiveCount: row.missing_active_count,
    unexpectedActiveCount: row.unexpected_active_count,
    duplicateActiveCount: row.duplicate_active_count,
    gradeNrTransitionCount: row.grade_nr_transition_count,
    largeScoreMovementCount: row.large_score_movement_count,
    topCutoffMovementCount: row.top_cutoff_movement_count,
    bindingCapChangeCount: row.binding_cap_change_count,
    downstreamCrossingCount: row.downstream_crossing_count,
    unresolvedReviewCount: row.unresolved_review_count,
    qualifying: row.qualifying,
    blockersJson: row.blockers_json,
    archiveSelectionReasonsJson: row.archive_selection_reasons_json,
    latestErrorCode: row.latest_error_code,
    latestErrorMessage: row.latest_error_message,
  };
  if (stableJsonStringifyV1(observed) !== stableJsonStringifyV1(expected)) {
    throw new Error(`Safety Score v9 shadow daily row projection mismatch for ${daily.utcDay}`);
  }
  return daily;
}

const SAFETY_SCORE_V9_SHADOW_DAILY_SELECT = `
  utc_day, updated_at_sec, successful_attempt_count, failed_attempt_count, selected_run_at_sec,
  publication_generation_id, base_input_generation_id, fact_set_digest, policy_digest,
  evaluation_build_digest, producer_capability_digest, release_coverage_policy_digest,
  consumer_threshold_registry_digest, result_digest, diff_report_digest,
  active_asset_count, rateable_count, nr_count, present_active_count, missing_active_count,
  unexpected_active_count, duplicate_active_count, grade_nr_transition_count,
  large_score_movement_count, top_cutoff_movement_count, binding_cap_change_count,
  downstream_crossing_count, unresolved_review_count, qualifying, blockers_json,
  archive_selection_reasons_json, latest_error_code, latest_error_message, daily_json
`;

export async function loadSafetyScoreV9ShadowDaily(
  db: D1Database,
  utcDay: string,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowDaily | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(`SELECT ${SAFETY_SCORE_V9_SHADOW_DAILY_SELECT} FROM safety_score_v9_shadow_daily WHERE utc_day = ?`)
        .bind(utcDay)
        .first<DailyRow>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ? parseDailyRow(row) : null;
}

function validateSuccessfulState(input: {
  artifacts: readonly SafetyScoreV9StoredReplayArtifact[];
  daily: SafetyScoreV9ShadowDaily;
  envelope: SafetyScoreV9ShadowEnvelope;
  diff: SafetyScoreV9DiffReport;
}): void {
  const selected = input.daily.selectedRun;
  if (selected === null) throw new Error("Latest Safety Score v9 state requires a selected successful run");
  const identity = selected.identity;
  if (identity.envelopeDigest !== computeSafetyScoreV9ShadowEnvelopeDigest(input.envelope)) {
    throw new Error("Safety Score v9 daily and candidate envelope digests do not match");
  }
  if (
    input.diff.reportDigest !== selected.diffReportDigest ||
    input.diff.v9Identity.publicationGenerationId !== identity.publicationGenerationId ||
    input.diff.v9Identity.baseInputGenerationId !== identity.baseInputGenerationId ||
    input.diff.v9Identity.factSetDigest !== identity.factSetDigest ||
    input.diff.v9Identity.policyDigest !== identity.policyDigest ||
    input.diff.v9Identity.evaluationBuildDigest !== identity.evaluationBuildDigest ||
    input.diff.v9Identity.resultDigest !== identity.resultDigest
  ) {
    throw new Error("Safety Score v9 diff identity does not match its selected daily run");
  }
  const referencesByKind = new Map(input.envelope.replayArtifacts.map((reference) => [reference.kind, reference]));
  const artifactsByKind = new Map(input.artifacts.map((artifact) => [artifact.kind, artifact]));
  const expectedArtifactKeys = [...selected.artifactKeys].sort();
  const storedArtifactKeys = input.artifacts.map((artifact) => artifact.artifactKey).sort();
  const referencedArtifactKeys = input.envelope.replayArtifacts.map((artifact) => artifact.artifactRef).sort();
  if (
    stableJsonStringifyV1(storedArtifactKeys) !== stableJsonStringifyV1(expectedArtifactKeys) ||
    stableJsonStringifyV1(referencedArtifactKeys) !== stableJsonStringifyV1(expectedArtifactKeys)
  ) {
    throw new Error("Safety Score v9 selected replay evidence does not match its daily artifact keys");
  }
  for (const kind of artifactsByKind.keys()) {
    const artifact = artifactsByKind.get(kind);
    const reference = referencesByKind.get(kind);
    if (
      !artifact ||
      !reference ||
      stableJsonStringifyV1(artifactReference(artifact)) !== stableJsonStringifyV1(reference)
    ) {
      throw new Error(`Safety Score v9 ${kind} replay artifact does not match the candidate envelope`);
    }
  }
}

export interface PersistSafetyScoreV9ShadowStateInput {
  artifacts?: readonly SafetyScoreV9StoredReplayArtifact[];
  localArtifactBundle?: SafetyScoreV9LocalArtifactBundle;
  daily: SafetyScoreV9ShadowDaily;
  envelope?: SafetyScoreV9ShadowEnvelope;
  diff?: SafetyScoreV9DiffReport;
  signal?: AbortSignal;
}

export async function persistSafetyScoreV9ShadowState(
  db: D1Database,
  input: PersistSafetyScoreV9ShadowStateInput,
): Promise<void> {
  throwIfAborted(input.signal);
  if (input.localArtifactBundle !== undefined && input.artifacts !== undefined) {
    throw new Error("Safety Score v9 state cannot mix external artifacts with a locally built artifact bundle");
  }
  const localBundle =
    input.localArtifactBundle === undefined ? null : localArtifactBundleData(input.localArtifactBundle);
  const artifacts =
    localBundle?.artifacts ??
    (input.artifacts ?? []).map((artifact) => SafetyScoreV9StoredReplayArtifactSchema.parse(artifact));
  const daily = SafetyScoreV9ShadowDailySchema.parse(input.daily);
  const hasLatest = input.envelope !== undefined || input.diff !== undefined;
  if (localBundle !== null && !hasLatest) {
    throw new Error("A locally built Safety Score v9 artifact bundle requires latest envelope and diff state");
  }
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
    validateSuccessfulState({ artifacts, daily, envelope, diff });
    envelopeJson = await serializeSafetyScoreV9ShadowEnvelopeCacheValue(envelope, input.signal);
    diffJson = await serializeSafetyScoreV9DiffReportCacheValue(diff, input.signal);
  } else if (daily.selectedRun !== null) {
    const existing = await loadSafetyScoreV9ShadowDaily(db, daily.utcDay, input.signal);
    if (existing?.selectedRun === null || existing === null) {
      throw new Error("A newly selected Safety Score v9 daily run must persist its latest envelope and diff");
    }
  }
  if (localBundle === null) {
    for (const artifact of artifacts) {
      await parseSafetyScoreV9ReplayArtifact(artifact, { signal: input.signal });
    }
  }
  const artifactKeys = artifacts.map((artifact) => artifact.artifactKey);
  const artifactIdentities = artifacts.map((artifact) => `${artifact.kind}:${artifact.identity}`);
  if (
    new Set(artifactKeys).size !== artifactKeys.length ||
    new Set(artifactIdentities).size !== artifactIdentities.length
  ) {
    throw new Error("Safety Score v9 state cannot contain duplicate replay artifact keys or identities");
  }
  const dailyJson = stableJsonStringifyV1(daily);
  const dailyColumns = expectedDailyColumns(daily);
  const missingArtifacts: SafetyScoreV9StoredReplayArtifact[] = [];
  for (const artifact of artifacts) {
    const existing = await resolveExistingArtifact(
      await findArtifactConflictRows(db, artifact, input.signal),
      artifact,
      input.signal,
      localBundle !== null,
    );
    if (!existing) missingArtifacts.push(artifact);
  }
  const existingDaily = await loadSafetyScoreV9ShadowDaily(db, daily.utcDay, input.signal);
  if (existingDaily) {
    const oldAttempts = existingDaily.attemptCounts.successful + existingDaily.attemptCounts.failed;
    const newAttempts = daily.attemptCounts.successful + daily.attemptCounts.failed;
    if (newAttempts < oldAttempts || daily.updatedAtSec < existingDaily.updatedAtSec) {
      throw new SafetyScoreV9StoreConflictError(`Stale Safety Score v9 daily update for ${daily.utcDay}`);
    }
    if (
      existingDaily.selectedRun !== null &&
      stableJsonStringifyV1(existingDaily.selectedRun) !== stableJsonStringifyV1(daily.selectedRun)
    ) {
      throw new SafetyScoreV9StoreConflictError(`Selected Safety Score v9 daily run conflict for ${daily.utcDay}`);
    }
  }

  // Missing immutable rows use plain INSERT inside the same transaction. A
  // concurrent writer therefore aborts the whole batch; a retry can then
  // validate and reuse the winner without partially committing latest state.
  const statements: D1PreparedStatement[] = missingArtifacts.map((artifact) => prepareArtifactInsert(db, artifact, ""));
  statements.push(
    db
      .prepare(
        `INSERT INTO safety_score_v9_shadow_daily
         (utc_day, updated_at_sec, successful_attempt_count, failed_attempt_count, selected_run_at_sec,
          publication_generation_id, base_input_generation_id, fact_set_digest, policy_digest,
          evaluation_build_digest, producer_capability_digest, release_coverage_policy_digest,
          consumer_threshold_registry_digest, result_digest, diff_report_digest,
          active_asset_count, rateable_count, nr_count, present_active_count, missing_active_count,
          unexpected_active_count, duplicate_active_count, grade_nr_transition_count,
          large_score_movement_count, top_cutoff_movement_count, binding_cap_change_count,
          downstream_crossing_count, unresolved_review_count, qualifying, blockers_json,
          archive_selection_reasons_json, latest_error_code, latest_error_message, daily_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(utc_day) DO UPDATE SET
           successful_attempt_count = excluded.successful_attempt_count,
           failed_attempt_count = excluded.failed_attempt_count,
           selected_run_at_sec = excluded.selected_run_at_sec,
           publication_generation_id = excluded.publication_generation_id,
           base_input_generation_id = excluded.base_input_generation_id,
           fact_set_digest = excluded.fact_set_digest,
           policy_digest = excluded.policy_digest,
           evaluation_build_digest = excluded.evaluation_build_digest,
           producer_capability_digest = excluded.producer_capability_digest,
           release_coverage_policy_digest = excluded.release_coverage_policy_digest,
           consumer_threshold_registry_digest = excluded.consumer_threshold_registry_digest,
           result_digest = excluded.result_digest,
           diff_report_digest = excluded.diff_report_digest,
           active_asset_count = excluded.active_asset_count,
           rateable_count = excluded.rateable_count,
           nr_count = excluded.nr_count,
           present_active_count = excluded.present_active_count,
           missing_active_count = excluded.missing_active_count,
           unexpected_active_count = excluded.unexpected_active_count,
           duplicate_active_count = excluded.duplicate_active_count,
           grade_nr_transition_count = excluded.grade_nr_transition_count,
           large_score_movement_count = excluded.large_score_movement_count,
           top_cutoff_movement_count = excluded.top_cutoff_movement_count,
           binding_cap_change_count = excluded.binding_cap_change_count,
           downstream_crossing_count = excluded.downstream_crossing_count,
           unresolved_review_count = excluded.unresolved_review_count,
           qualifying = excluded.qualifying,
           blockers_json = excluded.blockers_json,
           archive_selection_reasons_json = excluded.archive_selection_reasons_json,
           latest_error_code = excluded.latest_error_code,
           latest_error_message = excluded.latest_error_message,
           daily_json = CASE
             WHEN (safety_score_v9_shadow_daily.successful_attempt_count + safety_score_v9_shadow_daily.failed_attempt_count
                     < excluded.successful_attempt_count + excluded.failed_attempt_count
                   OR safety_score_v9_shadow_daily.daily_json = excluded.daily_json)
                  AND safety_score_v9_shadow_daily.updated_at_sec <= excluded.updated_at_sec
                  AND (safety_score_v9_shadow_daily.selected_run_at_sec IS NULL
                       OR safety_score_v9_shadow_daily.daily_json = excluded.daily_json)
               THEN excluded.daily_json
             ELSE NULL
           END,
           updated_at_sec = CASE
             WHEN (safety_score_v9_shadow_daily.successful_attempt_count + safety_score_v9_shadow_daily.failed_attempt_count
                     < excluded.successful_attempt_count + excluded.failed_attempt_count
                   OR safety_score_v9_shadow_daily.daily_json = excluded.daily_json)
                  AND safety_score_v9_shadow_daily.updated_at_sec <= excluded.updated_at_sec
               THEN excluded.updated_at_sec
             ELSE -1
           END`,
      )
      .bind(
        daily.utcDay,
        dailyColumns.updatedAtSec,
        dailyColumns.successfulAttemptCount,
        dailyColumns.failedAttemptCount,
        dailyColumns.selectedRunAtSec,
        dailyColumns.publicationGenerationId,
        dailyColumns.baseInputGenerationId,
        dailyColumns.factSetDigest,
        dailyColumns.policyDigest,
        dailyColumns.evaluationBuildDigest,
        dailyColumns.producerCapabilityDigest,
        dailyColumns.releaseCoveragePolicyDigest,
        dailyColumns.consumerThresholdRegistryDigest,
        dailyColumns.resultDigest,
        dailyColumns.diffReportDigest,
        dailyColumns.activeAssetCount,
        dailyColumns.rateableCount,
        dailyColumns.nrCount,
        dailyColumns.presentActiveCount,
        dailyColumns.missingActiveCount,
        dailyColumns.unexpectedActiveCount,
        dailyColumns.duplicateActiveCount,
        dailyColumns.gradeNrTransitionCount,
        dailyColumns.largeScoreMovementCount,
        dailyColumns.topCutoffMovementCount,
        dailyColumns.bindingCapChangeCount,
        dailyColumns.downstreamCrossingCount,
        dailyColumns.unresolvedReviewCount,
        dailyColumns.qualifying,
        dailyColumns.blockersJson,
        dailyColumns.archiveSelectionReasonsJson,
        dailyColumns.latestErrorCode,
        dailyColumns.latestErrorMessage,
        dailyJson,
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
      cacheStatement.bind(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, envelopeJson, daily.updatedAtSec),
      cacheStatement.bind(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff, diffJson, daily.updatedAtSec),
    );
  }
  await executeAtomicBatch(db, statements, { signal: input.signal });
  throwIfAborted(input.signal);
}

async function loadCanonicalCacheValue<T>(
  db: D1Database,
  key: string,
  parse: (storedValue: string, signal?: AbortSignal) => Promise<T>,
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
  return parse(row.value, signal);
}

export async function loadLatestSafetyScoreV9ShadowEnvelope(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9ShadowEnvelope | null> {
  return loadCanonicalCacheValue(
    db,
    SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope,
    parseSafetyScoreV9ShadowEnvelopeCacheValue,
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
    parseSafetyScoreV9DiffReportCacheValue,
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
): Promise<SafetyScoreV9ShadowDaily[]> {
  throwIfAborted(options.signal);
  const limit = options.limit ?? SAFETY_SCORE_V9_SHADOW_HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT) {
    throw new RangeError(`Safety Score v9 shadow history limit must be 1-${SAFETY_SCORE_V9_SHADOW_HISTORY_MAX_LIMIT}`);
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
          `SELECT ${SAFETY_SCORE_V9_SHADOW_DAILY_SELECT}
           FROM safety_score_v9_shadow_daily
           ${where}
           ORDER BY utc_day DESC
           LIMIT ?`,
        )
        .bind(...bindings, limit)
        .all<DailyRow>(),
    3,
    options.signal,
  );
  throwIfAborted(options.signal);
  return (rows.results ?? []).map(parseDailyRow);
}
