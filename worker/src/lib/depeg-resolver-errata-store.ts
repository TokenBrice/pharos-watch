import { buildInClause, chunkArray } from "./db";
import { assertNonEmpty, assertOptionalHash, assertPositiveInteger } from "./depeg-resolver-store-validators";

export type DdrPredictionErratumReason =
  | "false_positive"
  | "disputed"
  | "no_data"
  | "event_identity_error"
  | "input_corruption"
  | "lifecycle_status_error"
  | "implementation_bug"
  | "hash_mismatch";

export interface AppendPredictionErratumInput {
  publicPredictionId: number;
  incidentKey: string;
  eventId: number;
  assessmentId: number;
  reason: DdrPredictionErratumReason;
  operatorNote: string;
  replacementAssessmentId?: number | null;
  replacementRowHash?: string | null;
  rowHashBefore?: string | null;
  createdAt: number;
  createdBy: string;
}

export interface DdrPredictionErratum {
  id: number;
  publicPredictionId: number;
  incidentKey: string;
  eventId: number;
  assessmentId: number;
  reason: DdrPredictionErratumReason;
  operatorNote: string;
  replacementAssessmentId: number | null;
  replacementRowHash: string | null;
  rowHashBefore: string | null;
  createdAt: number;
  createdBy: string;
}

export interface LoadPredictionErrataFilters {
  publicPredictionIds?: number[];
  incidentKeys?: string[];
  eventIds?: number[];
}

interface ErratumRow {
  id: number;
  public_prediction_id: number;
  incident_key: string;
  event_id: number;
  assessment_id: number;
  reason: DdrPredictionErratumReason;
  operator_note: string;
  replacement_assessment_id: number | null;
  replacement_row_hash: string | null;
  row_hash_before: string | null;
  created_at: number;
  created_by: string;
}

function mapErratum(row: ErratumRow): DdrPredictionErratum {
  return {
    id: row.id,
    publicPredictionId: row.public_prediction_id,
    incidentKey: row.incident_key,
    eventId: row.event_id,
    assessmentId: row.assessment_id,
    reason: row.reason,
    operatorNote: row.operator_note,
    replacementAssessmentId: row.replacement_assessment_id,
    replacementRowHash: row.replacement_row_hash,
    rowHashBefore: row.row_hash_before,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export async function appendPredictionErratum(
  db: D1Database,
  input: AppendPredictionErratumInput,
): Promise<DdrPredictionErratum> {
  assertPositiveInteger(input.publicPredictionId, "publicPredictionId");
  assertPositiveInteger(input.eventId, "eventId");
  assertPositiveInteger(input.assessmentId, "assessmentId");
  assertPositiveInteger(input.createdAt, "createdAt");
  assertNonEmpty(input.incidentKey, "incidentKey");
  assertNonEmpty(input.operatorNote, "operatorNote");
  assertNonEmpty(input.createdBy, "createdBy");
  if (input.replacementAssessmentId != null) assertPositiveInteger(input.replacementAssessmentId, "replacementAssessmentId");
  assertOptionalHash(input.replacementRowHash, "replacementRowHash");
  assertOptionalHash(input.rowHashBefore, "rowHashBefore");

  await db
    .prepare(
      `INSERT INTO depeg_resolver_prediction_errata
       (public_prediction_id, incident_key, event_id, assessment_id, reason, operator_note,
        replacement_assessment_id, replacement_row_hash, row_hash_before, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.publicPredictionId,
      input.incidentKey,
      input.eventId,
      input.assessmentId,
      input.reason,
      input.operatorNote,
      input.replacementAssessmentId ?? null,
      input.replacementRowHash ?? null,
      input.rowHashBefore ?? null,
      input.createdAt,
      input.createdBy,
    )
    .run();

  const row = await db
    .prepare(
      `SELECT *
       FROM depeg_resolver_prediction_errata
       WHERE public_prediction_id = ?
         AND incident_key = ?
         AND event_id = ?
         AND assessment_id = ?
         AND reason = ?
         AND created_at = ?
         AND created_by = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(
      input.publicPredictionId,
      input.incidentKey,
      input.eventId,
      input.assessmentId,
      input.reason,
      input.createdAt,
      input.createdBy,
    )
    .first<ErratumRow>();
  if (!row) throw new Error("prediction erratum insert could not be reloaded");
  return mapErratum(row);
}

export async function loadPredictionErrata(
  db: D1Database,
  filters: LoadPredictionErrataFilters = {},
): Promise<DdrPredictionErratum[]> {
  const byId = new Map<number, DdrPredictionErratum>();
  const query = async (whereSql: string, binds: unknown[]) => {
    const result = await db
      .prepare(
        `SELECT *
         FROM depeg_resolver_prediction_errata
         ${whereSql}
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(...binds)
      .all<ErratumRow>();
    for (const row of result.results ?? []) byId.set(row.id, mapErratum(row));
  };

  if (filters.publicPredictionIds) {
    if (filters.publicPredictionIds.length === 0) return [];
    for (const chunk of chunkArray([...new Set(filters.publicPredictionIds)])) {
      const clause = buildInClause(chunk);
      await query(`WHERE public_prediction_id IN (${clause.sql})`, clause.binds);
    }
    return [...byId.values()];
  }

  if (filters.incidentKeys) {
    if (filters.incidentKeys.length === 0) return [];
    for (const chunk of chunkArray([...new Set(filters.incidentKeys)])) {
      const clause = buildInClause(chunk);
      await query(`WHERE incident_key IN (${clause.sql})`, clause.binds);
    }
    return [...byId.values()];
  }

  if (filters.eventIds) {
    if (filters.eventIds.length === 0) return [];
    for (const chunk of chunkArray([...new Set(filters.eventIds)])) {
      const clause = buildInClause(chunk);
      await query(`WHERE event_id IN (${clause.sql})`, clause.binds);
    }
    return [...byId.values()];
  }

  await query("", []);
  return [...byId.values()];
}
