import type { DexArchiveFamily, ResolvedDexArchiveMode } from "./config";
import type { DexArchiveObjectFamily, EncodedDexArchiveArtifact } from "./codec";

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

export interface DexArchiveManifest {
  family: DexArchiveObjectFamily;
  generationId: string;
  objectKey: string;
  sha256: string | null;
  objectEtag: string | null;
  rowCount: number | null;
  dependencyRowCount: number | null;
  uncompressedBytes: number | null;
  storedBytes: number | null;
  uploadedAt: number | null;
  verifiedAt: number | null;
  sourceDeletedAt: number | null;
  expiresAt: number | null;
  attemptCount: number;
  lastAttemptAt: number | null;
  lastError: string | null;
}

interface DexArchiveManifestRow {
  family: DexArchiveObjectFamily;
  generation_id: string;
  object_key: string;
  sha256: string | null;
  object_etag: string | null;
  row_count: number | null;
  dependency_row_count: number | null;
  uncompressed_bytes: number | null;
  stored_bytes: number | null;
  uploaded_at: number | null;
  verified_at: number | null;
  source_deleted_at: number | null;
  expires_at: number | null;
  attempt_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
}

interface ManifestAggregateRow {
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
  verified_pending_delete_count: number;
  oldest_verified_pending_delete_at: number | null;
  last_upload_at: number | null;
  last_verified_at: number | null;
  last_delete_at: number | null;
}

function mapManifest(row: DexArchiveManifestRow): DexArchiveManifest {
  return {
    family: row.family,
    generationId: row.generation_id,
    objectKey: row.object_key,
    sha256: row.sha256,
    objectEtag: row.object_etag,
    rowCount: row.row_count,
    dependencyRowCount: row.dependency_row_count,
    uncompressedBytes: row.uncompressed_bytes,
    storedBytes: row.stored_bytes,
    uploadedAt: row.uploaded_at,
    verifiedAt: row.verified_at,
    sourceDeletedAt: row.source_deleted_at,
    expiresAt: row.expires_at,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
  };
}

export async function loadDexArchiveManifest(
  db: D1Database,
  family: DexArchiveObjectFamily,
  generationId: string,
): Promise<DexArchiveManifest | null> {
  const row = await db
    .prepare(
      `SELECT family, generation_id, object_key, sha256, object_etag, row_count,
              dependency_row_count, uncompressed_bytes, stored_bytes, uploaded_at,
              verified_at, source_deleted_at, expires_at, attempt_count, last_attempt_at, last_error
         FROM dex_archive_manifests
        WHERE family = ? AND generation_id = ?`,
    )
    .bind(family, generationId)
    .first<DexArchiveManifestRow>();
  return row ? mapManifest(row) : null;
}

export async function beginDexArchiveManifestAttempt(input: {
  db: D1Database;
  objectKey: string;
  encoded: EncodedDexArchiveArtifact;
  now: number;
  expiresAt: number;
}): Promise<DexArchiveManifest> {
  const { db, objectKey, encoded, now, expiresAt } = input;
  const artifact = encoded.artifact;
  const existing = await loadDexArchiveManifest(db, artifact.family, artifact.generationId);
  if (
    existing
    && (
      existing.objectKey !== objectKey
      || (existing.sha256 != null && existing.sha256 !== encoded.sha256)
      || (existing.rowCount != null && existing.rowCount !== artifact.rowCount)
      || (
        existing.dependencyRowCount != null
        && existing.dependencyRowCount !== artifact.dependencyRowCount
      )
      || (
        existing.uncompressedBytes != null
        && existing.uncompressedBytes !== artifact.uncompressedBytes
      )
    )
  ) {
    throw new Error(`DEX archive manifest mismatch for ${artifact.family}/${artifact.generationId}`);
  }
  await db
    .prepare(
      `INSERT INTO dex_archive_manifests
         (family, generation_id, source_slot_started_at, schema_version, object_key,
          sha256, row_count, dependency_row_count, uncompressed_bytes, expires_at,
          attempt_count, last_attempt_at, last_error)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
       ON CONFLICT(family, generation_id) DO UPDATE SET
         sha256 = COALESCE(dex_archive_manifests.sha256, excluded.sha256),
         row_count = COALESCE(dex_archive_manifests.row_count, excluded.row_count),
         dependency_row_count = COALESCE(
           dex_archive_manifests.dependency_row_count,
           excluded.dependency_row_count
         ),
         uncompressed_bytes = COALESCE(
           dex_archive_manifests.uncompressed_bytes,
           excluded.uncompressed_bytes
         ),
         expires_at = COALESCE(dex_archive_manifests.expires_at, excluded.expires_at),
         attempt_count = dex_archive_manifests.attempt_count + 1,
         last_attempt_at = excluded.last_attempt_at,
         last_error = NULL`,
    )
    .bind(
      artifact.family,
      artifact.generationId,
      artifact.sourceSlotStartedAt,
      objectKey,
      encoded.sha256,
      artifact.rowCount,
      artifact.dependencyRowCount,
      artifact.uncompressedBytes,
      expiresAt,
      now,
    )
    .run();
  for (const dependencyGenerationId of artifact.dependencyGenerationIds) {
    await db
      .prepare(
        `INSERT INTO dex_archive_manifest_dependencies
           (family, generation_id, dependency_generation_id, row_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(family, generation_id, dependency_generation_id) DO UPDATE SET
           row_count = excluded.row_count`,
      )
      .bind(
        artifact.family,
        artifact.generationId,
        dependencyGenerationId,
        artifact.dependencyRowCount,
      )
      .run();
  }
  const manifest = await loadDexArchiveManifest(db, artifact.family, artifact.generationId);
  if (!manifest) throw new Error(`DEX archive manifest write was not durable: ${artifact.generationId}`);
  return manifest;
}

export async function recordDexArchiveManifestUpload(input: {
  db: D1Database;
  family: DexArchiveObjectFamily;
  generationId: string;
  etag: string;
  storedBytes: number;
  now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE dex_archive_manifests
          SET object_etag = ?, stored_bytes = ?, uploaded_at = COALESCE(uploaded_at, ?), last_error = NULL
        WHERE family = ? AND generation_id = ?`,
    )
    .bind(
      input.etag,
      input.storedBytes,
      input.now,
      input.family,
      input.generationId,
    )
    .run();
}

export async function recordDexArchiveManifestVerified(input: {
  db: D1Database;
  family: DexArchiveObjectFamily;
  generationId: string;
  etag: string;
  storedBytes: number;
  now: number;
}): Promise<void> {
  const result = await input.db
    .prepare(
      `UPDATE dex_archive_manifests
          SET object_etag = ?, stored_bytes = ?, uploaded_at = COALESCE(uploaded_at, ?),
              verified_at = COALESCE(verified_at, ?), last_error = NULL
        WHERE family = ? AND generation_id = ?
          AND sha256 IS NOT NULL AND row_count IS NOT NULL
          AND dependency_row_count IS NOT NULL AND uncompressed_bytes IS NOT NULL`,
    )
    .bind(
      input.etag,
      input.storedBytes,
      input.now,
      input.now,
      input.family,
      input.generationId,
    )
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error(`DEX archive manifest verification write failed: ${input.generationId}`);
  }
}

export async function recordDexArchiveManifestError(
  db: D1Database,
  family: DexArchiveObjectFamily,
  generationId: string,
  now: number,
  error: string,
): Promise<void> {
  const message = error.trim() || "unknown DEX archive error";
  await db
    .prepare(
      `UPDATE dex_archive_manifests
          SET last_attempt_at = ?, last_error = ?
        WHERE family = ? AND generation_id = ?`,
    )
    .bind(now, message.slice(0, 500), family, generationId)
    .run();
}

export async function recordDexArchiveCandidateError(input: {
  db: D1Database;
  family: DexArchiveObjectFamily;
  generationId: string;
  sourceSlotStartedAt: number;
  objectKey: string;
  now: number;
  error: string;
}): Promise<void> {
  const message = input.error.trim() || "unknown DEX archive error";
  await input.db
    .prepare(
      `INSERT INTO dex_archive_manifests
         (family, generation_id, source_slot_started_at, schema_version, object_key,
          attempt_count, last_attempt_at, last_error)
       VALUES (?, ?, ?, 1, ?, 1, ?, ?)
       ON CONFLICT(family, generation_id) DO UPDATE SET
         attempt_count = dex_archive_manifests.attempt_count + 1,
         last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error`,
    )
    .bind(
      input.family,
      input.generationId,
      input.sourceSlotStartedAt,
      input.objectKey,
      input.now,
      message.slice(0, 500),
    )
    .run();
}

export async function recordDexArchiveMeasuredRun(input: {
  db: D1Database;
  mode: ResolvedDexArchiveMode;
  now: number;
  eligibleGenerationCount: number;
  eligibleRowCount: number;
  eligibleLogicalBytes: number;
  oldestEligibleAt: number | null;
  runError: string | null;
}): Promise<void> {
  const aggregate = await input.db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE uploaded_at IS NOT NULL) AS uploaded_object_count,
         COUNT(*) FILTER (WHERE verified_at IS NOT NULL) AS verified_object_count,
         COUNT(*) FILTER (WHERE source_deleted_at IS NOT NULL) AS deleted_generation_count,
         COALESCE(SUM(CASE WHEN verified_at IS NOT NULL THEN uncompressed_bytes ELSE 0 END), 0)
           AS archived_uncompressed_bytes,
         COALESCE(SUM(CASE WHEN verified_at IS NOT NULL THEN stored_bytes ELSE 0 END), 0)
           AS archived_stored_bytes,
         COALESCE(SUM(CASE WHEN source_deleted_at IS NOT NULL THEN
           COALESCE(row_count, 0) + COALESCE(dependency_row_count, 0) ELSE 0 END), 0)
           AS deleted_source_row_count,
         COALESCE(SUM(CASE WHEN source_deleted_at IS NOT NULL THEN
           COALESCE(uncompressed_bytes, 0) ELSE 0 END), 0) AS deleted_source_bytes,
         COUNT(*) FILTER (WHERE uploaded_at >= ?) AS objects_written_24h,
         COALESCE(SUM(CASE WHEN source_deleted_at >= ? THEN
           COALESCE(row_count, 0) + COALESCE(dependency_row_count, 0) ELSE 0 END), 0)
           AS source_rows_deleted_24h,
         COALESCE(SUM(CASE WHEN source_deleted_at >= ? THEN
           COALESCE(uncompressed_bytes, 0) ELSE 0 END), 0) AS source_bytes_deleted_24h,
         COUNT(*) FILTER (WHERE verified_at IS NOT NULL AND source_deleted_at IS NULL)
           AS verified_pending_delete_count,
         MIN(CASE WHEN verified_at IS NOT NULL AND source_deleted_at IS NULL
           THEN source_slot_started_at END) AS oldest_verified_pending_delete_at,
         MAX(uploaded_at) AS last_upload_at,
         MAX(verified_at) AS last_verified_at,
         MAX(source_deleted_at) AS last_delete_at
       FROM dex_archive_manifests
       WHERE family IN ('measured-quote-generation', 'measured-target-generation')`,
    )
    .bind(
      input.now - 24 * 60 * 60,
      input.now - 24 * 60 * 60,
      input.now - 24 * 60 * 60,
    )
    .first<ManifestAggregateRow>();
  await input.db
    .prepare(
      `UPDATE dex_archive_family_state
          SET configured_mode = ?, effective_mode = ?, config_error = ?,
              eligible_generation_count = ?, eligible_row_count = ?,
              eligible_logical_bytes = ?, oldest_eligible_at = ?,
              verified_pending_delete_count = ?,
              oldest_verified_pending_delete_at = ?,
              uploaded_object_count = ?, verified_object_count = ?,
              deleted_generation_count = ?, archived_uncompressed_bytes = ?,
              archived_stored_bytes = ?, deleted_source_row_count = ?,
              deleted_source_bytes = ?, objects_written_24h = ?,
              source_rows_deleted_24h = ?, source_bytes_deleted_24h = ?,
              last_upload_at = ?, last_verified_at = ?, last_delete_at = ?,
              last_success_at = ?, last_error_at = ?, last_error = ?,
              last_run_at = ?, updated_at = ?
        WHERE family = 'measured-execution'`,
    )
    .bind(
      input.mode.configuredMode,
      input.mode.effectiveMode,
      input.mode.configError,
      input.eligibleGenerationCount,
      input.eligibleRowCount,
      input.eligibleLogicalBytes,
      input.oldestEligibleAt,
      Number(aggregate?.verified_pending_delete_count ?? 0),
      aggregate?.oldest_verified_pending_delete_at ?? null,
      Number(aggregate?.uploaded_object_count ?? 0),
      Number(aggregate?.verified_object_count ?? 0),
      Number(aggregate?.deleted_generation_count ?? 0),
      Number(aggregate?.archived_uncompressed_bytes ?? 0),
      Number(aggregate?.archived_stored_bytes ?? 0),
      Number(aggregate?.deleted_source_row_count ?? 0),
      Number(aggregate?.deleted_source_bytes ?? 0),
      Number(aggregate?.objects_written_24h ?? 0),
      Number(aggregate?.source_rows_deleted_24h ?? 0),
      Number(aggregate?.source_bytes_deleted_24h ?? 0),
      aggregate?.last_upload_at ?? null,
      aggregate?.last_verified_at ?? null,
      aggregate?.last_delete_at ?? null,
      input.runError == null ? input.now : null,
      input.runError == null ? null : input.now,
      input.runError,
      input.now,
      input.now,
    )
    .run();
}
