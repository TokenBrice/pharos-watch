import type { DexArchiveFamily, ResolvedDexArchiveMode } from "./config";

export interface DexArchiveFamilyState {
  family: DexArchiveFamily;
  configuredMode: string;
  effectiveMode: "off" | "shadow" | "delete";
  configError: string | null;
  eligibleGenerationCount: number;
  eligibleRowCount: number;
  eligibleLogicalBytes: number;
  verifiedPendingDeleteCount: number;
  oldestEligibleAt: number | null;
  oldestVerifiedPendingDeleteAt: number | null;
  uploadedObjectCount: number;
  verifiedObjectCount: number;
  deletedGenerationCount: number;
  archivedUncompressedBytes: number;
  archivedStoredBytes: number;
  deletedSourceRowCount: number;
  deletedSourceBytes: number;
  objectsWritten24h: number;
  sourceRowsDeleted24h: number;
  sourceBytesDeleted24h: number;
  orphanObjectCount: number;
  missingObjectCount: number;
  lifecycleDriftCount: number;
  lastUploadAt: number | null;
  lastVerifiedAt: number | null;
  lastDeleteAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastRunAt: number | null;
  updatedAt: number;
}

interface DexArchiveFamilyStateRow {
  family: DexArchiveFamily;
  configured_mode: string;
  effective_mode: "off" | "shadow" | "delete";
  config_error: string | null;
  eligible_generation_count: number;
  eligible_row_count: number;
  eligible_logical_bytes: number;
  verified_pending_delete_count: number;
  oldest_eligible_at: number | null;
  oldest_verified_pending_delete_at: number | null;
  uploaded_object_count: number;
  verified_object_count: number;
  deleted_generation_count: number;
  archived_uncompressed_bytes: number;
  archived_stored_bytes: number;
  deleted_source_row_count: number;
  deleted_source_bytes: number;
  objects_written_24h: number;
  source_rows_deleted_24h: number;
  source_bytes_deleted_24h: number;
  orphan_object_count: number;
  missing_object_count: number;
  lifecycle_drift_count: number;
  last_upload_at: number | null;
  last_verified_at: number | null;
  last_delete_at: number | null;
  last_success_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  last_run_at: number | null;
  updated_at: number;
}

function mapFamilyState(row: DexArchiveFamilyStateRow): DexArchiveFamilyState {
  return {
    family: row.family,
    configuredMode: row.configured_mode,
    effectiveMode: row.effective_mode,
    configError: row.config_error,
    eligibleGenerationCount: row.eligible_generation_count,
    eligibleRowCount: row.eligible_row_count,
    eligibleLogicalBytes: row.eligible_logical_bytes,
    verifiedPendingDeleteCount: row.verified_pending_delete_count,
    oldestEligibleAt: row.oldest_eligible_at,
    oldestVerifiedPendingDeleteAt: row.oldest_verified_pending_delete_at,
    uploadedObjectCount: row.uploaded_object_count,
    verifiedObjectCount: row.verified_object_count,
    deletedGenerationCount: row.deleted_generation_count,
    archivedUncompressedBytes: row.archived_uncompressed_bytes,
    archivedStoredBytes: row.archived_stored_bytes,
    deletedSourceRowCount: row.deleted_source_row_count,
    deletedSourceBytes: row.deleted_source_bytes,
    objectsWritten24h: row.objects_written_24h,
    sourceRowsDeleted24h: row.source_rows_deleted_24h,
    sourceBytesDeleted24h: row.source_bytes_deleted_24h,
    orphanObjectCount: row.orphan_object_count,
    missingObjectCount: row.missing_object_count,
    lifecycleDriftCount: row.lifecycle_drift_count,
    lastUploadAt: row.last_upload_at,
    lastVerifiedAt: row.last_verified_at,
    lastDeleteAt: row.last_delete_at,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    lastRunAt: row.last_run_at,
    updatedAt: row.updated_at,
  };
}

export async function recordDexArchiveFoundationRun(
  db: D1Database,
  family: DexArchiveFamily,
  mode: ResolvedDexArchiveMode,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dex_archive_family_state
         (family, configured_mode, effective_mode, config_error, last_success_at, last_run_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(family) DO UPDATE SET
         configured_mode = excluded.configured_mode,
         effective_mode = excluded.effective_mode,
         config_error = excluded.config_error,
         last_success_at = excluded.last_success_at,
         last_run_at = excluded.last_run_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      family,
      mode.configuredMode,
      mode.effectiveMode,
      mode.configError,
      mode.configError == null ? now : null,
      now,
      now,
    )
    .run();
}

export async function loadDexArchiveFamilyStates(db: D1Database): Promise<DexArchiveFamilyState[]> {
  const rows = await db
    .prepare(
      `SELECT *
         FROM dex_archive_family_state
        ORDER BY CASE family WHEN 'measured-execution' THEN 0 ELSE 1 END`,
    )
    .all<DexArchiveFamilyStateRow>();
  return (rows.results ?? []).map(mapFamilyState);
}
