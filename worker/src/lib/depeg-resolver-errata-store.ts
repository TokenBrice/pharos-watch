import { runChunkedInRead } from "./db";

export type DdrPredictionErratumReason =
  | "false_positive"
  | "disputed"
  | "no_data"
  | "event_identity_error"
  | "input_corruption"
  | "lifecycle_status_error"
  | "implementation_bug"
  | "hash_mismatch";

export type DdrPredictionErratum = {
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
};

export interface LoadPredictionErrataFilters {
  // Read-only: the loader measures length and copies through `new Set`, never
  // mutating. Accepting readonly arrays lets callers pass `as const` fixtures
  // and frozen constants without a cast.
  publicPredictionIds?: readonly number[];
  incidentKeys?: readonly string[];
  eventIds?: readonly number[];
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

export async function loadPredictionErrata(
  db: D1Database,
  filters: LoadPredictionErrataFilters = {},
): Promise<DdrPredictionErratum[]> {
  const readRows = async (whereSql: string, binds: unknown[]) => {
    const result = await db
      .prepare(
        `SELECT *
         FROM depeg_resolver_prediction_errata
         ${whereSql}
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(...binds)
      .all<ErratumRow>();
    return (result.results ?? []).map(mapErratum);
  };

  if (filters.publicPredictionIds) {
    if (filters.publicPredictionIds.length === 0) return [];
    return runChunkedInRead(
      [...new Set(filters.publicPredictionIds)],
      (inClauseSql) => `WHERE public_prediction_id IN (${inClauseSql})`,
      readRows,
    );
  }

  if (filters.incidentKeys) {
    if (filters.incidentKeys.length === 0) return [];
    return runChunkedInRead(
      [...new Set(filters.incidentKeys)],
      (inClauseSql) => `WHERE incident_key IN (${inClauseSql})`,
      readRows,
    );
  }

  if (filters.eventIds) {
    if (filters.eventIds.length === 0) return [];
    return runChunkedInRead(
      [...new Set(filters.eventIds)],
      (inClauseSql) => `WHERE event_id IN (${inClauseSql})`,
      readRows,
    );
  }

  return readRows("", []);
}
