import { DDR_HASH_DOMAINS, stableJsonHashV1, stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { attachDdrPublicRowHash, computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";
import { isRecord } from "@shared/lib/type-guards";
import { executeAtomicBatch, runChunkedInRead } from "./db";
import { gunzipTextBounded, gzipCanonicalJson } from "./canonical-json-gzip";
import {
  bindDdrAssessmentInsert,
  ddrAssessmentInsertSql,
  type DdrAssessmentCheckpoint,
} from "./depeg-resolver-assessment-store";
import type { DdrIncidentDirection, DdrLockHealthStatus, DdrLockTrigger } from "./depeg-resolver-incident-store";
import {
  DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL,
  DDR_LOCK_METADATA_COLUMNS_SQL,
  DDR_LOCK_METADATA_PLACEHOLDERS_SQL,
  DDR_LOCK_STATE_INSERT_COLUMNS_SQL,
  assertHash,
  assertLockMetadata,
  assertNonEmpty,
  assertNonNegativeInteger,
  assertPositiveInteger,
  bindLockMetadata,
  lockAuditInsertValuesSql,
  lockStateOnConflictUpdateSql,
  lockStateInsertValuesSql,
} from "./depeg-resolver-store-validators";

export type DdrPublicPredictionOutcomeKind = "prediction" | "no_call";
const DDR_PUBLICATION_MAX_COMPRESSED_BYTES = 1_350_000;
const DDR_PUBLICATION_MAX_UNCOMPRESSED_BYTES = 8_000_000;
export type DdrPublicPredictionLockTiming = "on_time" | "late_confirmation" | "late_freeze" | "deferred";

export interface DdrPublicAssessmentSealInput {
  incidentKey: string;
  eventId: number;
  stablecoinId: string;
  symbol: string;
  name: string;
  pegCurrency: string;
  governance: string;
  direction: DdrIncidentDirection;
  startedAt: number;
  assessedAt: number;
  eventAgeSec: number;
  methodologyVersion: string;
  methodologyVersionLabel: string;
  resolutionRubricVersion: string;
  durationModelVersion: string;
  incidentGroupingVersion: string;
  supportRulesVersion: string;
  resolutionTier: string;
  durationSuppressed: boolean;
  durationSuppressedReason?: string | null;
  medianRemainingSec?: number | null;
  iqrLowRemainingSec?: number | null;
  iqrHighRemainingSec?: number | null;
  stratum?: string | null;
  horizons?: unknown[];
  factors?: unknown[];
  sealedPayload: unknown;
  rowHash: string;
  predictionPolicyVersion: string;
  policyDelaySec: number;
  eligibleAt: number;
  lockedAt: number;
  eventAgeAtLockSec: number;
  lockTiming: DdrPublicPredictionLockTiming;
  createdAt: number;
  runId?: string | null;
  healthStatus?: DdrLockHealthStatus;
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
}

export interface DdrSealedPublicPrediction {
  id: number;
  publicPredictionId: number;
  incidentKey: string;
  eventId: number;
  assessmentId: number;
  outcomeKind: DdrPublicPredictionOutcomeKind;
  predictionPolicyVersion: string;
  predictionMethodologyVersion: string;
  predictionMethodologyVersionLabel: string;
  resolutionRubricVersion: string;
  durationModelVersion: string;
  incidentGroupingVersion: string;
  supportRulesVersion: string;
  policyDelaySec: number;
  eligibleAt: number;
  lockedAt: number;
  eventAgeAtLockSec: number;
  lockTiming: DdrPublicPredictionLockTiming;
  lockTrigger: DdrLockTrigger | null;
  forecastReadinessScore: number | null;
  forecastReadinessVersion: string | null;
  readinessThreshold: number | null;
  backstopAt: number | null;
  backstopDelaySec: number | null;
  sealedPayloadJson: string;
  sealedPayload: Record<string, unknown>;
  rowHash: string;
  createdAt: number;
}

export interface LoadSealedPublicPredictionsFilters {
  publicPredictionIds?: number[];
  incidentKeys?: string[];
  eventIds?: number[];
  predictionPolicyVersion?: string;
  includeUnpublished?: boolean;
}

export interface WritePublicationManifestInput {
  snapshotToken?: string;
  snapshotGeneration: number;
  publishedAt: number;
  createdAt?: number;
  validatorVersion?: string;
  runId?: string;
  snapshotKind?: string;
  activeIncidentKeys?: string[];
  basePayload: unknown;
  publicPredictionIds?: number[];
  publicPredictionRowHashes?: Record<string, string> | Record<number, string>;
  basePayloadHash?: string;
  publicPredictionIdsHash?: string;
}

export interface DdrPublicationManifest {
  snapshotToken: string;
  snapshotKind: "ddr_public";
  snapshotSequence: number;
  snapshotGeneration: number;
  publishedAt: number;
  basePayloadHash: string;
  publicPredictionIdsHash: string;
  publicPredictionIds: number[];
  firstPublishedPublicPredictionIds: number[];
  publicPredictionRowHashes: Record<string, string>;
  basePayloadJson: string;
  baseRowCount: number;
  publicPredictionCount: number;
  createdAt: number;
  finalizedAt: number;
  validatorVersion: string;
}

export interface DdrFirstPublicationMembership {
  publicPredictionId: number;
  incidentKey: string;
  snapshotToken: string;
  snapshotSequence: number;
  snapshotGeneration: number;
  publishedAt: number;
  finalizedAt: number;
  firstPublished: boolean;
}

interface SealedPublicPredictionRow {
  id: number;
  incident_key: string;
  event_id: number;
  assessment_id: number;
  outcome_kind: DdrPublicPredictionOutcomeKind;
  prediction_policy_version: string;
  prediction_methodology_version: string;
  prediction_methodology_version_label: string;
  resolution_rubric_version: string;
  duration_model_version: string;
  incident_grouping_version: string;
  support_rules_version: string;
  policy_delay_sec: number;
  eligible_at: number;
  locked_at: number;
  event_age_at_lock_sec: number;
  lock_timing: DdrPublicPredictionLockTiming;
  lock_trigger: DdrLockTrigger | null;
  forecast_readiness_score: number | null;
  forecast_readiness_version: string | null;
  readiness_threshold: number | null;
  backstop_at: number | null;
  backstop_delay_sec: number | null;
  sealed_payload_json: string;
  row_hash: string;
  created_at: number;
}

interface PublicationManifestRow {
  snapshot_token: string;
  snapshot_kind: "ddr_public";
  snapshot_sequence: number;
  snapshot_generation: number;
  published_at: number;
  base_payload_hash: string;
  public_prediction_ids_hash: string;
  public_prediction_ids_json: string;
  public_prediction_row_hashes_json: string;
  base_payload_json: string;
  base_row_count: number;
  public_prediction_count: number;
  created_at: number;
  finalized_at: number;
  validator_version: string;
}

interface CompressedPublicationManifestRow extends Omit<PublicationManifestRow, "base_payload_json"> {
  base_payload_gzip: ArrayBuffer | Uint8Array;
  base_payload_bytes: number;
  compressed_payload_bytes: number;
}

interface FirstPublicationMembershipRow {
  public_prediction_id: number;
  incident_key: string;
  snapshot_token: string;
  snapshot_sequence: number;
  snapshot_generation: number;
  published_at: number;
  finalized_at: number;
}

function jsonString(value: unknown, name: string): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  return text;
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  const parsed = parseJson(value, name);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parsePositiveIntegerArrayJson(value: string, name: string): number[] {
  const parsed = parseJson(value, name);
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return parsed.map((id) => {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`${name} must contain positive integers`);
    }
    return id;
  });
}

function parseStringRecordJson(value: string, name: string): Record<string, string> {
  const parsed = parseJsonObject(value, name);
  for (const [key, recordValue] of Object.entries(parsed)) {
    if (typeof recordValue !== "string") {
      throw new Error(`${name}.${key} must be a string`);
    }
  }
  return parsed as Record<string, string>;
}

function mapSealedPublicPrediction(row: SealedPublicPredictionRow): DdrSealedPublicPrediction {
  return {
    id: row.id,
    publicPredictionId: row.id,
    incidentKey: row.incident_key,
    eventId: row.event_id,
    assessmentId: row.assessment_id,
    outcomeKind: row.outcome_kind,
    predictionPolicyVersion: row.prediction_policy_version,
    predictionMethodologyVersion: row.prediction_methodology_version,
    predictionMethodologyVersionLabel: row.prediction_methodology_version_label,
    resolutionRubricVersion: row.resolution_rubric_version,
    durationModelVersion: row.duration_model_version,
    incidentGroupingVersion: row.incident_grouping_version,
    supportRulesVersion: row.support_rules_version,
    policyDelaySec: row.policy_delay_sec,
    eligibleAt: row.eligible_at,
    lockedAt: row.locked_at,
    eventAgeAtLockSec: row.event_age_at_lock_sec,
    lockTiming: row.lock_timing,
    lockTrigger: row.lock_trigger ?? null,
    forecastReadinessScore: row.forecast_readiness_score ?? null,
    forecastReadinessVersion: row.forecast_readiness_version ?? null,
    readinessThreshold: row.readiness_threshold ?? null,
    backstopAt: row.backstop_at ?? null,
    backstopDelaySec: row.backstop_delay_sec ?? null,
    sealedPayloadJson: row.sealed_payload_json,
    sealedPayload: parseJsonObject(row.sealed_payload_json, "sealedPayloadJson"),
    rowHash: row.row_hash,
    createdAt: row.created_at,
  };
}

function mapPublicationManifest(row: PublicationManifestRow): DdrPublicationManifest {
  return {
    snapshotToken: row.snapshot_token,
    snapshotKind: row.snapshot_kind,
    snapshotSequence: row.snapshot_sequence,
    snapshotGeneration: row.snapshot_generation,
    publishedAt: row.published_at,
    basePayloadHash: row.base_payload_hash,
    publicPredictionIdsHash: row.public_prediction_ids_hash,
    publicPredictionIds: parsePositiveIntegerArrayJson(row.public_prediction_ids_json, "publicPredictionIdsJson"),
    firstPublishedPublicPredictionIds: [],
    publicPredictionRowHashes: parseStringRecordJson(
      row.public_prediction_row_hashes_json,
      "publicPredictionRowHashesJson",
    ),
    basePayloadJson: row.base_payload_json,
    baseRowCount: row.base_row_count,
    publicPredictionCount: row.public_prediction_count,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
    validatorVersion: row.validator_version,
  };
}

function bytesFromBlob(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function mapCompressedPublicationManifest(
  row: CompressedPublicationManifestRow,
): Promise<DdrPublicationManifest> {
  const compressed = bytesFromBlob(row.base_payload_gzip);
  if (compressed.byteLength !== row.compressed_payload_bytes) {
    throw new Error(`Compressed publication manifest ${row.snapshot_token} compressed payload length mismatch`);
  }
  const basePayloadJson = await gunzipTextBounded(compressed, {
    label: `Compressed publication manifest ${row.snapshot_token}`,
    maximumCompressedBytes: DDR_PUBLICATION_MAX_COMPRESSED_BYTES,
    maximumUncompressedBytes: DDR_PUBLICATION_MAX_UNCOMPRESSED_BYTES,
    expectedUncompressedBytes: row.base_payload_bytes,
  });
  parseJsonObject(basePayloadJson, "basePayloadJson");
  return mapPublicationManifest({ ...row, base_payload_json: basePayloadJson });
}

function basePayloadObject(input: unknown): Record<string, unknown> {
  const payload = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("basePayload must be a JSON object");
  }
  return payload as Record<string, unknown>;
}

function publicPredictionIdsFromPayload(payload: Record<string, unknown>): number[] {
  const meta = payload._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const ids = (meta as Record<string, unknown>).publicPredictionIds;
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => {
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error("basePayload _meta.publicPredictionIds must be positive integers");
    return id;
  });
}

function rowHashesFromPayload(payload: Record<string, unknown>): Record<string, string> {
  const meta = payload._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const hashes = (meta as Record<string, unknown>).publicPredictionRowHashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) return {};
  return Object.fromEntries(
    Object.entries(hashes as Record<string, unknown>).map(([id, hash]) => {
      if (typeof hash !== "string")
        throw new Error("basePayload _meta.publicPredictionRowHashes values must be hashes");
      assertHash(hash, `publicPredictionRowHashes[${id}]`);
      return [id, hash];
    }),
  );
}

function normalizeIdSet(ids: number[]): number[] {
  const normalized = [...new Set(ids)];
  for (const id of normalized) assertPositiveInteger(id, "publicPredictionId");
  return normalized.sort((left, right) => left - right);
}

function normalizeRowHashes(rowHashes: Record<string, string> | Record<number, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rowHashes)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([id, hash]) => {
        assertPositiveInteger(Number(id), "publicPredictionRowHash id");
        assertHash(hash, `publicPredictionRowHashes[${id}]`);
        return [String(Number(id)), hash];
      }),
  );
}

function assertMatchingIdAndHashSets(ids: number[], rowHashes: Record<string, string>): void {
  const hashIds = Object.keys(rowHashes)
    .map(Number)
    .sort((left, right) => left - right);
  if (JSON.stringify(ids) !== JSON.stringify(hashIds)) {
    throw new Error("public prediction id set and row-hash map keys must match");
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function publicPredictionIdFromPayloadRow(row: unknown): number | null {
  const record = recordValue(row);
  const prediction = recordValue(record?.prediction);
  const id = prediction?.publicPredictionId;
  if (id == null) return null;
  if (typeof id !== "number") throw new Error("basePayload row prediction.publicPredictionId must be a number");
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("basePayload row prediction.publicPredictionId must be positive integer");
  return id;
}

function publicPredictionRowHashFromPayloadRow(row: unknown): string | null {
  const record = recordValue(row);
  const prediction = recordValue(record?.prediction);
  const rowHash = prediction?.rowHash;
  if (rowHash == null) return null;
  if (typeof rowHash !== "string") throw new Error("basePayload row prediction.rowHash must be a string");
  assertHash(rowHash, "basePayload row prediction.rowHash");
  return rowHash;
}

async function insertPublicPredictionAssessment(
  db: D1Database,
  input: DdrPublicAssessmentSealInput,
  payloadJson: string,
): Promise<D1PreparedStatement> {
  const checkpoint: DdrAssessmentCheckpoint = "public_prediction";
  return bindDdrAssessmentInsert(db.prepare(ddrAssessmentInsertSql("INSERT INTO")), {
    eventId: input.eventId,
    stablecoinId: input.stablecoinId,
    symbol: input.symbol,
    name: input.name,
    pegCurrency: input.pegCurrency,
    governance: input.governance,
    direction: input.direction,
    startedAt: input.startedAt,
    assessedAt: input.assessedAt,
    eventAgeSec: input.eventAgeSec,
    checkpoint,
    methodologyVersion: input.methodologyVersion,
    methodologyVersionLabel: input.methodologyVersionLabel,
    resolutionRubricVersion: input.resolutionRubricVersion,
    durationModelVersion: input.durationModelVersion,
    incidentGroupingVersion: input.incidentGroupingVersion,
    supportRulesVersion: input.supportRulesVersion,
    resolutionTier: input.resolutionTier,
    durationSuppressed: input.durationSuppressed ? 1 : 0,
    durationSuppressedReason: input.durationSuppressedReason ?? null,
    medianRemainingSec: input.medianRemainingSec ?? null,
    iqrLowRemainingSec: input.iqrLowRemainingSec ?? null,
    iqrHighRemainingSec: input.iqrHighRemainingSec ?? null,
    stratum: input.stratum ?? null,
    horizonsJson: JSON.stringify(input.horizons ?? []),
    factorsJson: JSON.stringify(input.factors ?? []),
    rowJson: payloadJson,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function lockStateStatement(
  db: D1Database,
  input: DdrPublicAssessmentSealInput,
  state: "frozen" | "no_call",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_resolver_prediction_lock_state
       (${DDR_LOCK_STATE_INSERT_COLUMNS_SQL})
       VALUES (${lockStateInsertValuesSql("0", "NULL", "?")})
       ${lockStateOnConflictUpdateSql({
         incrementDeferralCount: false,
         preserveDeferralReason: true,
         preserveMetadata: false,
         lastStateSql: "excluded.last_state",
       })}`,
    )
    .bind(
      input.incidentKey,
      input.eventId,
      input.predictionPolicyVersion,
      input.eligibleAt,
      input.lockedAt,
      input.lockedAt,
      state,
      input.createdAt,
      input.createdAt,
      ...bindLockMetadata(input),
    );
}

function sealedPredictionStatement(
  db: D1Database,
  input: DdrPublicAssessmentSealInput,
  outcomeKind: DdrPublicPredictionOutcomeKind,
  payloadJson: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_resolver_public_predictions
       (incident_key, event_id, assessment_id, outcome_kind, prediction_policy_version,
        prediction_methodology_version, prediction_methodology_version_label,
        resolution_rubric_version, duration_model_version, incident_grouping_version,
        support_rules_version, policy_delay_sec, eligible_at, locked_at,
        event_age_at_lock_sec, lock_timing, sealed_payload_json, row_hash, created_at,
        ${DDR_LOCK_METADATA_COLUMNS_SQL})
       SELECT ?, a.event_id, a.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${DDR_LOCK_METADATA_PLACEHOLDERS_SQL}
       FROM depeg_resolver_assessments a
       WHERE a.event_id = ?
         AND a.checkpoint = 'public_prediction'
         AND a.methodology_version = ?
         AND a.assessed_at = ?`,
    )
    .bind(
      input.incidentKey,
      outcomeKind,
      input.predictionPolicyVersion,
      input.methodologyVersion,
      input.methodologyVersionLabel,
      input.resolutionRubricVersion,
      input.durationModelVersion,
      input.incidentGroupingVersion,
      input.supportRulesVersion,
      input.policyDelaySec,
      input.eligibleAt,
      input.lockedAt,
      input.eventAgeAtLockSec,
      input.lockTiming,
      payloadJson,
      input.rowHash,
      input.createdAt,
      ...bindLockMetadata(input),
      input.eventId,
      input.methodologyVersion,
      input.assessedAt,
    );
}

function lockAuditStatement(
  db: D1Database,
  input: DdrPublicAssessmentSealInput,
  action: "locked_prediction" | "locked_no_call",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_resolver_lock_opportunity_audit
       (${DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL})
       VALUES (${lockAuditInsertValuesSql("NULL", "NULL", "NULL")})`,
    )
    .bind(
      input.incidentKey,
      input.eventId,
      input.runId ?? null,
      input.lockedAt,
      input.eligibleAt,
      input.healthStatus ?? "healthy",
      action,
      input.createdAt,
      ...bindLockMetadata(input),
    );
}

async function sealPublicOutcome(
  db: D1Database,
  input: DdrPublicAssessmentSealInput,
  outcomeKind: DdrPublicPredictionOutcomeKind,
): Promise<DdrSealedPublicPrediction> {
  assertNonEmpty(input.incidentKey, "incidentKey");
  assertPositiveInteger(input.eventId, "eventId");
  assertPositiveInteger(input.startedAt, "startedAt");
  assertPositiveInteger(input.assessedAt, "assessedAt");
  assertNonNegativeInteger(input.eventAgeSec, "eventAgeSec");
  assertPositiveInteger(input.createdAt, "createdAt");
  assertPositiveInteger(input.policyDelaySec, "policyDelaySec");
  assertPositiveInteger(input.eligibleAt, "eligibleAt");
  assertPositiveInteger(input.lockedAt, "lockedAt");
  assertNonNegativeInteger(input.eventAgeAtLockSec, "eventAgeAtLockSec");
  assertHash(input.rowHash, "rowHash");
  assertLockMetadata(input);

  const existing = await loadSealedPublicPredictions(db, { incidentKeys: [input.incidentKey] });
  if (existing.length > 0) return existing[0];

  const canonicalRowHash = computeDdrPublicRowHash(input.sealedPayload);
  if (canonicalRowHash !== input.rowHash) {
    throw new Error("rowHash does not match canonical sealed public row payload");
  }
  const payloadJson = jsonString(
    attachDdrPublicRowHash(input.sealedPayload as Record<string, unknown>, input.rowHash),
    "sealedPayload",
  );
  const results = await executeAtomicBatch(db, [
    await insertPublicPredictionAssessment(db, input, payloadJson),
    lockStateStatement(db, input, outcomeKind === "prediction" ? "frozen" : "no_call"),
    sealedPredictionStatement(db, input, outcomeKind, payloadJson),
    lockAuditStatement(db, input, outcomeKind === "prediction" ? "locked_prediction" : "locked_no_call"),
  ], { returnResults: true });
  const sealedChanges = Number(results[2]?.meta?.changes ?? 0);
  if (sealedChanges !== 1) {
    throw new Error(`Expected to seal one DDR public ${outcomeKind}; inserted ${sealedChanges}`);
  }

  const [prediction] = await loadSealedPublicPredictions(db, { incidentKeys: [input.incidentKey] });
  if (!prediction) throw new Error(`Sealed DDR public ${outcomeKind} could not be reloaded`);
  return prediction;
}

export function sealPublicPrediction(
  db: D1Database,
  input: DdrPublicAssessmentSealInput,
): Promise<DdrSealedPublicPrediction> {
  return sealPublicOutcome(db, input, "prediction");
}

export function sealPublicNoCall(
  db: D1Database,
  input: Omit<
    DdrPublicAssessmentSealInput,
    | "resolutionTier"
    | "durationSuppressed"
    | "durationSuppressedReason"
    | "medianRemainingSec"
    | "iqrLowRemainingSec"
    | "iqrHighRemainingSec"
    | "stratum"
    | "horizons"
    | "factors"
  > & { resolutionTier?: "insufficient_signal" },
): Promise<DdrSealedPublicPrediction> {
  return sealPublicOutcome(
    db,
    {
      ...input,
      resolutionTier: "insufficient_signal",
      durationSuppressed: true,
      durationSuppressedReason: "insufficient_signal",
      medianRemainingSec: null,
      iqrLowRemainingSec: null,
      iqrHighRemainingSec: null,
      stratum: null,
      horizons: [],
      factors: [],
    },
    "no_call",
  );
}

/**
 * Shared 3-branch filter dispatch for chunked IN reads.
 * Each branch receives a clause-builder callback that turns the IN-clause SQL
 * into the WHERE/AND fragment appropriate for that function's query.
 */
function dispatchFilteredChunkedRead<T>(
  filters: LoadSealedPublicPredictionsFilters,
  clauseBuilders: {
    byPredictionIds: (inClauseSql: string) => string;
    byIncidentKeys: (inClauseSql: string) => string;
    byEventIds: (inClauseSql: string) => string;
  },
  readRows: (filterSql: string, binds: unknown[]) => Promise<T[]>,
): Promise<T[]> {
  if (filters.publicPredictionIds) {
    if (filters.publicPredictionIds.length === 0) return Promise.resolve([]);
    return runChunkedInRead(
      normalizeIdSet(filters.publicPredictionIds),
      clauseBuilders.byPredictionIds,
      readRows,
    );
  }
  if (filters.incidentKeys) {
    if (filters.incidentKeys.length === 0) return Promise.resolve([]);
    return runChunkedInRead(
      [...new Set(filters.incidentKeys)],
      clauseBuilders.byIncidentKeys,
      readRows,
    );
  }
  if (filters.eventIds) {
    if (filters.eventIds.length === 0) return Promise.resolve([]);
    return runChunkedInRead(
      normalizeIdSet(filters.eventIds),
      clauseBuilders.byEventIds,
      readRows,
    );
  }
  return readRows("", []);
}

export async function loadSealedPublicPredictions(
  db: D1Database,
  filters: LoadSealedPublicPredictionsFilters = {},
): Promise<DdrSealedPublicPrediction[]> {
  const readRows = async (whereSql: string, binds: unknown[]) => {
    const policySql = filters.predictionPolicyVersion
      ? `${whereSql ? " AND" : "WHERE"} prediction_policy_version = ?`
      : "";
    const policyBinds = filters.predictionPolicyVersion ? [filters.predictionPolicyVersion] : [];
    const result = await db
      .prepare(
        `SELECT *
         FROM depeg_resolver_public_predictions
         ${whereSql} ${policySql}
         ORDER BY locked_at DESC, id DESC`,
      )
      .bind(...binds, ...policyBinds)
      .all<SealedPublicPredictionRow>();
    return (result.results ?? []).map(mapSealedPublicPrediction);
  };

  return dispatchFilteredChunkedRead(
    filters,
    {
      byPredictionIds: (inClauseSql) => `WHERE id IN (${inClauseSql})`,
      byIncidentKeys: (inClauseSql) => `WHERE incident_key IN (${inClauseSql})`,
      byEventIds: (inClauseSql) => `WHERE event_id IN (${inClauseSql})`,
    },
    readRows,
  );
}

async function loadPublicationManifestByToken(
  db: D1Database,
  snapshotToken: string,
): Promise<DdrPublicationManifest | null> {
  const compressed = await db
    .prepare(
      `SELECT *
       FROM depeg_resolver_publication_snapshots_v2
       WHERE snapshot_token = ?`,
    )
    .bind(snapshotToken)
    .first<CompressedPublicationManifestRow>();
  if (compressed) return mapCompressedPublicationManifest(compressed);

  const row = await db
    .prepare(
      `SELECT s.*, f.finalized_at, f.validator_version
       FROM depeg_resolver_publication_snapshots s
       JOIN depeg_resolver_publication_snapshot_finalizations f
         ON f.snapshot_token = s.snapshot_token
       WHERE s.snapshot_token = ?`,
    )
    .bind(snapshotToken)
    .first<PublicationManifestRow>();
  return row ? mapPublicationManifest(row) : null;
}

export async function writePublicationManifest(
  db: D1Database,
  input: WritePublicationManifestInput,
): Promise<DdrPublicationManifest> {
  assertPositiveInteger(input.snapshotGeneration, "snapshotGeneration");
  assertPositiveInteger(input.publishedAt, "publishedAt");
  const validatorVersion = input.validatorVersion ?? "ddr-publication-store-v2";
  assertNonEmpty(validatorVersion, "validatorVersion");

  const payload = basePayloadObject(input.basePayload);
  const payloadRows = payload.rows;
  if (!Array.isArray(payloadRows)) throw new Error("basePayload.rows must be an array");

  const ids = normalizeIdSet(input.publicPredictionIds ?? publicPredictionIdsFromPayload(payload));
  const rowHashes = normalizeRowHashes(input.publicPredictionRowHashes ?? rowHashesFromPayload(payload));
  assertMatchingIdAndHashSets(ids, rowHashes);

  const sealedRows = ids.length > 0 ? await loadSealedPublicPredictions(db, { publicPredictionIds: ids }) : [];
  const sealedById = new Map(sealedRows.map((row) => [row.id, row]));
  const payloadRowById = new Map<number, unknown>();
  for (const row of payloadRows) {
    const id = publicPredictionIdFromPayloadRow(row);
    if (id == null) continue;
    if (payloadRowById.has(id)) throw new Error(`basePayload contains duplicate public prediction row ${id}`);
    payloadRowById.set(id, row);
  }
  for (const id of ids) {
    const sealed = sealedById.get(id);
    if (!sealed) throw new Error(`Cannot publish missing sealed public prediction ${id}`);
    if (sealed.rowHash !== rowHashes[String(id)]) {
      throw new Error(`Public prediction ${id} row hash does not match sealed row hash`);
    }
    const payloadRow = payloadRowById.get(id);
    if (!payloadRow) throw new Error(`basePayload is missing public prediction row ${id}`);
    const payloadRowHash = publicPredictionRowHashFromPayloadRow(payloadRow);
    if (payloadRowHash !== sealed.rowHash) {
      throw new Error(`basePayload row ${id} does not carry the sealed row hash`);
    }
    const recomputedRowHash = computeDdrPublicRowHash(payloadRow);
    if (recomputedRowHash !== sealed.rowHash) {
      throw new Error(`basePayload row ${id} canonical hash does not match sealed row hash`);
    }
  }

  const basePayloadJson = stableJsonStringifyV1(payload);
  const basePayloadHash = stableJsonHashV1(DDR_HASH_DOMAINS.publicationManifest, payload);
  const publicPredictionIdsHash = stableJsonHashV1(DDR_HASH_DOMAINS.publicPredictionIds, ids);
  if (input.basePayloadHash && input.basePayloadHash !== basePayloadHash) {
    throw new Error("basePayloadHash does not match canonical publication payload hash");
  }
  if (input.publicPredictionIdsHash && input.publicPredictionIdsHash !== publicPredictionIdsHash) {
    throw new Error("publicPredictionIdsHash does not match canonical public prediction id hash");
  }

  const publicPredictionIdsJson = JSON.stringify(ids);
  const publicPredictionRowHashesJson = JSON.stringify(rowHashes);
  const snapshotToken =
    input.snapshotToken ??
    `ddrpub:${input.publishedAt}:${basePayloadHash.slice(0, 16)}:${publicPredictionIdsHash.slice(0, 8)}`;
  const createdAt = input.createdAt ?? input.publishedAt;
  const compressedPayload = await gzipCanonicalJson(basePayloadJson, {
    label: "DDR public publication manifest",
    maximumCompressedBytes: DDR_PUBLICATION_MAX_COMPRESSED_BYTES,
    maximumUncompressedBytes: DDR_PUBLICATION_MAX_UNCOMPRESSED_BYTES,
  });

  await executeAtomicBatch(db, [
    db
      .prepare(
        `INSERT INTO depeg_resolver_publication_snapshots_v2
         (snapshot_token, snapshot_kind, snapshot_sequence, snapshot_generation, published_at,
          base_payload_hash, public_prediction_ids_hash, public_prediction_ids_json,
          public_prediction_row_hashes_json, base_payload_gzip, base_payload_bytes,
          compressed_payload_bytes, base_row_count, public_prediction_count, created_at,
          finalized_at, validator_version)
         VALUES (
           ?,
           'ddr_public',
           (SELECT COALESCE(MAX(snapshot_sequence), 0) + 1
              FROM (
                SELECT snapshot_sequence FROM depeg_resolver_publication_snapshots WHERE snapshot_kind = 'ddr_public'
                UNION ALL
                SELECT snapshot_sequence FROM depeg_resolver_publication_snapshots_v2 WHERE snapshot_kind = 'ddr_public'
              )),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .bind(
        snapshotToken,
        input.snapshotGeneration,
        input.publishedAt,
        basePayloadHash,
        publicPredictionIdsHash,
        publicPredictionIdsJson,
        publicPredictionRowHashesJson,
        compressedPayload.compressed,
        compressedPayload.uncompressedBytes,
        compressedPayload.compressed.byteLength,
        payloadRows.length,
        ids.length,
        createdAt,
        input.publishedAt,
        validatorVersion,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO depeg_resolver_first_publications_v2
         (public_prediction_id, incident_key, snapshot_token, snapshot_sequence,
          snapshot_generation, published_at, finalized_at)
         SELECT p.id, p.incident_key, ?, s.snapshot_sequence,
                s.snapshot_generation, s.published_at, s.finalized_at
         FROM json_each(?) ids
         JOIN depeg_resolver_public_predictions p
           ON p.id = CAST(ids.value AS INTEGER)
         JOIN depeg_resolver_publication_snapshots_v2 s
           ON s.snapshot_token = ?
         WHERE NOT EXISTS (
           SELECT 1
           FROM depeg_resolver_publication_snapshot_rows existing
           WHERE existing.public_prediction_id = p.id
             AND existing.first_published = 1
         )
         ORDER BY p.id`,
      )
      .bind(snapshotToken, publicPredictionIdsJson, snapshotToken),
  ]);

  const manifest = await loadPublicationManifestByToken(db, snapshotToken);
  if (!manifest) throw new Error(`Publication manifest ${snapshotToken} was not finalized`);
  const firstMembership = await loadFirstPublicationMembership(db, { publicPredictionIds: ids });
  return {
    ...manifest,
    firstPublishedPublicPredictionIds: firstMembership
      .filter((membership) => membership.snapshotToken === snapshotToken)
      .map((membership) => membership.publicPredictionId),
  };
}

export async function loadLatestPublicationManifest(db: D1Database): Promise<DdrPublicationManifest | null> {
  const [legacyRow, compressedRow] = await Promise.all([
    db
      .prepare(
        `SELECT s.*, f.finalized_at, f.validator_version
         FROM depeg_resolver_publication_snapshots s
         JOIN depeg_resolver_publication_snapshot_finalizations f
           ON f.snapshot_token = s.snapshot_token
         WHERE s.snapshot_kind = 'ddr_public'
           AND NOT EXISTS (
             SELECT 1
             FROM depeg_resolver_publication_snapshot_errata e
             WHERE e.snapshot_token = s.snapshot_token
           )
         ORDER BY s.snapshot_sequence DESC
         LIMIT 1`,
      )
      .first<PublicationManifestRow>(),
    db
      .prepare(
        `SELECT *
         FROM depeg_resolver_publication_snapshots_v2 s
         WHERE s.snapshot_kind = 'ddr_public'
           AND NOT EXISTS (
             SELECT 1
             FROM depeg_resolver_publication_snapshot_errata e
             WHERE e.snapshot_token = s.snapshot_token
           )
         ORDER BY s.published_at DESC, s.snapshot_sequence DESC
         LIMIT 1`,
      )
      .first<CompressedPublicationManifestRow>(),
  ]);
  if (!legacyRow && !compressedRow) return null;
  if (!compressedRow) return mapPublicationManifest(legacyRow!);
  if (!legacyRow) return mapCompressedPublicationManifest(compressedRow);
  return compressedRow.published_at > legacyRow.published_at ||
    (compressedRow.published_at === legacyRow.published_at &&
      compressedRow.snapshot_sequence > legacyRow.snapshot_sequence)
    ? mapCompressedPublicationManifest(compressedRow)
    : mapPublicationManifest(legacyRow);
}

export async function loadFirstPublicationMembership(
  db: D1Database,
  filters: LoadSealedPublicPredictionsFilters = {},
): Promise<DdrFirstPublicationMembership[]> {
  const readRows = async (filterSql: string, binds: unknown[]) => {
    const result = await db
      .prepare(
        `WITH first_publications AS (
           SELECT r.public_prediction_id, r.incident_key, r.snapshot_token,
                  s.snapshot_sequence, s.snapshot_generation, s.published_at,
                  f.finalized_at
             FROM depeg_resolver_publication_snapshot_rows r
             JOIN depeg_resolver_publication_snapshots s ON s.snapshot_token = r.snapshot_token
             JOIN depeg_resolver_publication_snapshot_finalizations f ON f.snapshot_token = r.snapshot_token
            WHERE r.first_published = 1
           UNION ALL
           SELECT public_prediction_id, incident_key, snapshot_token,
                  snapshot_sequence, snapshot_generation, published_at, finalized_at
             FROM depeg_resolver_first_publications_v2
         )
         SELECT r.*
         FROM first_publications r
         JOIN depeg_resolver_public_predictions p ON p.id = r.public_prediction_id
         WHERE 1 = 1
         ${filterSql}
         ORDER BY r.published_at ASC, r.snapshot_sequence ASC, r.public_prediction_id ASC`,
      )
      .bind(...binds)
      .all<FirstPublicationMembershipRow>();
    return (result.results ?? []).map((row) => ({
      publicPredictionId: row.public_prediction_id,
      incidentKey: row.incident_key,
      snapshotToken: row.snapshot_token,
      snapshotSequence: row.snapshot_sequence,
      snapshotGeneration: row.snapshot_generation,
      publishedAt: row.published_at,
      finalizedAt: row.finalized_at,
      firstPublished: true,
    }));
  };

  return dispatchFilteredChunkedRead(
    filters,
    {
      byPredictionIds: (inClauseSql) => `AND r.public_prediction_id IN (${inClauseSql})`,
      byIncidentKeys: (inClauseSql) => `AND r.incident_key IN (${inClauseSql})`,
      byEventIds: (inClauseSql) => `AND p.event_id IN (${inClauseSql})`,
    },
    readRows,
  );
}
