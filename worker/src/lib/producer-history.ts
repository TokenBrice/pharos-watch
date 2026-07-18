import type { PublicationSurfaceId } from "@shared/types/status";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { boundedJson, parseObjectMetadata } from "./json-metadata";

export type ProducerOutcome =
  "ok" | "degraded" | "error" | "skipped_locked" | "skipped_neutral" | "not_started" | "abandoned";

export interface CronPublicationRecord {
  surface: PublicationSurfaceId;
  generationId: string;
  publishedAt: number;
  candidateRows?: number | null;
  publishedRows?: number | null;
  expectedRows?: number | null;
  artifactCacheKey?: string | null;
  artifactChecksum?: string | null;
  inputWatermarks?: Record<string, unknown> | null;
  validationSummary?: Record<string, unknown> | null;
}

export interface CronProductivity {
  productive: boolean;
  reason?: string;
  publications?: readonly CronPublicationRecord[];
}

export interface ProducerIdentity {
  scheduleKey: string;
  job: string;
  producerPath: string;
  producerKind: string;
  invocationId: string;
  workerVersion?: string | null;
  slotStartedAt?: number | null;
  calendarPeriod?: string | null;
}

export interface RecordProducerOutcomeInput extends ProducerIdentity {
  idempotencyKey: string;
  invokedAt: number;
  completedAt: number;
  outcome: ProducerOutcome;
  itemCount?: number | null;
  metadata?: string | null;
  error?: string | null;
  productivity?: CronProductivity | null;
}

export interface ProducerHead {
  scheduleKey: string;
  job: string;
  producerPath: string;
  producerKind: string;
  lastInvocationId: string;
  lastWorkerVersion: string | null;
  lastInvokedAt: number;
  lastCompletedAt: number;
  lastOutcome: ProducerOutcome;
  lastError: string | null;
  lastProductiveInvocationId: string | null;
  lastProductiveAt: number | null;
  lastProductiveItemCount: number | null;
  lastPublicationAt: number | null;
  invocationCount: number;
  productiveCount: number;
}

interface ProducerHeadRow {
  schedule_key: string;
  job: string;
  producer_path: string;
  producer_kind: string;
  last_invocation_id: string;
  last_worker_version: string | null;
  last_invoked_at: number;
  last_completed_at: number;
  last_outcome: ProducerOutcome;
  last_error: string | null;
  last_productive_invocation_id: string | null;
  last_productive_at: number | null;
  last_productive_item_count: number | null;
  last_publication_at: number | null;
  invocation_count: number;
  productive_count: number;
}

const MAX_HISTORY_METADATA_CHARS = 16_000;
const MAX_HISTORY_ERROR_CHARS = 1_000;
const REGULAR_HISTORY_RETENTION_SEC = 30 * 24 * 60 * 60;
const BUDGET_HISTORY_RETENTION_SEC = 90 * 24 * 60 * 60;
const CALENDAR_HISTORY_RETENTION_SEC = 550 * 24 * 60 * 60;

function normalizeMetadata(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  const parsed = parseObjectMetadata(metadata);
  return boundedJson(parsed ?? { raw: metadata.slice(0, MAX_HISTORY_METADATA_CHARS) }, MAX_HISTORY_METADATA_CHARS);
}

function normalizePublications(
  publications: readonly CronPublicationRecord[] | null | undefined,
): CronPublicationRecord[] {
  if (!publications) return [];
  return publications
    .filter(
      (publication) =>
        publication.generationId.trim().length > 0 &&
        Number.isFinite(publication.publishedAt) &&
        publication.publishedAt > 0,
    )
    .slice(0, 12)
    .map((publication) => ({
      ...publication,
      generationId: publication.generationId.slice(0, 240),
      artifactCacheKey: publication.artifactCacheKey?.slice(0, 240) ?? null,
      artifactChecksum: publication.artifactChecksum?.slice(0, 240) ?? null,
    }));
}

function latestPublicationAt(publications: readonly CronPublicationRecord[]): number | null {
  return publications.reduce<number | null>(
    (latest, publication) => (latest == null ? publication.publishedAt : Math.max(latest, publication.publishedAt)),
    null,
  );
}

async function recordGenericSurfacePublications(
  db: D1Database,
  input: RecordProducerOutcomeInput,
  publications: readonly CronPublicationRecord[],
): Promise<void> {
  for (const publication of publications) {
    await runWithOverloadRetry(() =>
      db
        .prepare(
          `INSERT INTO surface_publication_generations (
           surface, generation_id, started_at, validated_at, published_at, state,
           candidate_rows, published_rows, expected_rows, input_watermarks_json,
           validation_summary_json, artifact_checksum, artifact_cache_key,
           producer_schedule_key, producer_job, producer_path, producer_kind,
           invocation_id, worker_version
         ) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(surface, generation_id) DO UPDATE SET
           validated_at = COALESCE(surface_publication_generations.validated_at, excluded.validated_at),
           published_at = COALESCE(surface_publication_generations.published_at, excluded.published_at),
           state = CASE
             WHEN surface_publication_generations.state = 'published' THEN surface_publication_generations.state
             ELSE excluded.state
           END,
           candidate_rows = COALESCE(excluded.candidate_rows, surface_publication_generations.candidate_rows),
           published_rows = COALESCE(excluded.published_rows, surface_publication_generations.published_rows),
           expected_rows = COALESCE(excluded.expected_rows, surface_publication_generations.expected_rows),
           input_watermarks_json = COALESCE(excluded.input_watermarks_json, surface_publication_generations.input_watermarks_json),
           validation_summary_json = COALESCE(excluded.validation_summary_json, surface_publication_generations.validation_summary_json),
           artifact_checksum = COALESCE(excluded.artifact_checksum, surface_publication_generations.artifact_checksum),
           artifact_cache_key = COALESCE(excluded.artifact_cache_key, surface_publication_generations.artifact_cache_key),
           producer_schedule_key = COALESCE(excluded.producer_schedule_key, surface_publication_generations.producer_schedule_key),
           producer_job = COALESCE(excluded.producer_job, surface_publication_generations.producer_job),
           producer_path = COALESCE(excluded.producer_path, surface_publication_generations.producer_path),
           producer_kind = COALESCE(excluded.producer_kind, surface_publication_generations.producer_kind),
           invocation_id = COALESCE(excluded.invocation_id, surface_publication_generations.invocation_id),
           worker_version = COALESCE(excluded.worker_version, surface_publication_generations.worker_version)`,
        )
        .bind(
          publication.surface,
          publication.generationId,
          input.invokedAt,
          publication.publishedAt,
          publication.publishedAt,
          publication.candidateRows ?? null,
          publication.publishedRows ?? null,
          publication.expectedRows ?? null,
          publication.inputWatermarks ? boundedJson(publication.inputWatermarks, 4_000) : null,
          publication.validationSummary ? boundedJson(publication.validationSummary, 4_000) : null,
          publication.artifactChecksum ?? null,
          publication.artifactCacheKey ?? null,
          input.scheduleKey,
          input.job,
          input.producerPath,
          input.producerKind,
          input.invocationId,
          input.workerVersion ?? null,
        )
        .run(),
    );
  }
}

/**
 * Persists an append-only invocation row and its path-scoped head. Head counts
 * are derived from the idempotent history table so retrying a partial write
 * cannot double count an invocation.
 */
export async function recordProducerOutcome(db: D1Database, input: RecordProducerOutcomeInput): Promise<void> {
  const productive = input.productivity?.productive === true;
  const publications = productive ? normalizePublications(input.productivity?.publications) : [];
  const publicationsJson = publications.length > 0 ? boundedJson(publications, MAX_HISTORY_METADATA_CHARS) : null;
  const publicationAt = latestPublicationAt(publications);
  const metadataJson = normalizeMetadata(input.metadata);
  const error = input.error?.slice(0, MAX_HISTORY_ERROR_CHARS) ?? null;

  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO worker_producer_history (
         idempotency_key, schedule_key, job, producer_path, producer_kind,
         invocation_id, worker_version, slot_started_at, invoked_at, completed_at,
         outcome, productive, item_count, publication_count, publications_json,
         calendar_period, metadata_json, error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         completed_at = excluded.completed_at,
         outcome = excluded.outcome,
         productive = excluded.productive,
         item_count = excluded.item_count,
         publication_count = excluded.publication_count,
         publications_json = excluded.publications_json,
         calendar_period = COALESCE(excluded.calendar_period, worker_producer_history.calendar_period),
         metadata_json = excluded.metadata_json,
         error = excluded.error`,
      )
      .bind(
        input.idempotencyKey,
        input.scheduleKey,
        input.job,
        input.producerPath,
        input.producerKind,
        input.invocationId,
        input.workerVersion ?? null,
        input.slotStartedAt ?? null,
        input.invokedAt,
        input.completedAt,
        input.outcome,
        productive ? 1 : 0,
        input.itemCount ?? null,
        publications.length,
        publicationsJson,
        input.calendarPeriod ?? null,
        metadataJson,
        error,
        input.completedAt,
      )
      .run(),
  );

  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO worker_producer_heads (
         schedule_key, job, producer_path, producer_kind,
         last_invocation_id, last_worker_version, last_invoked_at, last_completed_at,
         last_outcome, last_error, last_productive_invocation_id,
         last_productive_at, last_productive_item_count, last_publication_at,
         last_publications_json, invocation_count, productive_count, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(schedule_key, job, producer_path, producer_kind) DO UPDATE SET
         last_invocation_id = CASE
           WHEN excluded.last_completed_at >= worker_producer_heads.last_completed_at
           THEN excluded.last_invocation_id ELSE worker_producer_heads.last_invocation_id END,
         last_worker_version = CASE
           WHEN excluded.last_completed_at >= worker_producer_heads.last_completed_at
           THEN excluded.last_worker_version ELSE worker_producer_heads.last_worker_version END,
         last_invoked_at = MAX(worker_producer_heads.last_invoked_at, excluded.last_invoked_at),
         last_completed_at = MAX(worker_producer_heads.last_completed_at, excluded.last_completed_at),
         last_outcome = CASE
           WHEN excluded.last_completed_at >= worker_producer_heads.last_completed_at
           THEN excluded.last_outcome ELSE worker_producer_heads.last_outcome END,
         last_error = CASE
           WHEN excluded.last_completed_at >= worker_producer_heads.last_completed_at
           THEN excluded.last_error ELSE worker_producer_heads.last_error END,
         last_productive_invocation_id = CASE
           WHEN excluded.last_productive_at IS NOT NULL
            AND (worker_producer_heads.last_productive_at IS NULL
              OR excluded.last_productive_at >= worker_producer_heads.last_productive_at)
           THEN excluded.last_productive_invocation_id
           ELSE worker_producer_heads.last_productive_invocation_id END,
         last_productive_at = CASE
           WHEN excluded.last_productive_at IS NOT NULL
           THEN MAX(COALESCE(worker_producer_heads.last_productive_at, 0), excluded.last_productive_at)
           ELSE worker_producer_heads.last_productive_at END,
         last_productive_item_count = CASE
           WHEN excluded.last_productive_at IS NOT NULL
            AND (worker_producer_heads.last_productive_at IS NULL
              OR excluded.last_productive_at >= worker_producer_heads.last_productive_at)
           THEN excluded.last_productive_item_count
           ELSE worker_producer_heads.last_productive_item_count END,
         last_publication_at = CASE
           WHEN excluded.last_publication_at IS NOT NULL
           THEN MAX(COALESCE(worker_producer_heads.last_publication_at, 0), excluded.last_publication_at)
           ELSE worker_producer_heads.last_publication_at END,
         last_publications_json = CASE
           WHEN excluded.last_publication_at IS NOT NULL
            AND (worker_producer_heads.last_publication_at IS NULL
              OR excluded.last_publication_at >= worker_producer_heads.last_publication_at)
           THEN excluded.last_publications_json
           ELSE worker_producer_heads.last_publications_json END,
         invocation_count = (
           SELECT COUNT(*) FROM worker_producer_history history
            WHERE history.schedule_key = excluded.schedule_key
              AND history.job = excluded.job
              AND history.producer_path = excluded.producer_path
              AND history.producer_kind = excluded.producer_kind
         ),
         productive_count = (
           SELECT COUNT(*) FROM worker_producer_history history
            WHERE history.schedule_key = excluded.schedule_key
              AND history.job = excluded.job
              AND history.producer_path = excluded.producer_path
              AND history.producer_kind = excluded.producer_kind
              AND history.productive = 1
         ),
         updated_at = MAX(worker_producer_heads.updated_at, excluded.updated_at)`,
      )
      .bind(
        input.scheduleKey,
        input.job,
        input.producerPath,
        input.producerKind,
        input.invocationId,
        input.workerVersion ?? null,
        input.invokedAt,
        input.completedAt,
        input.outcome,
        error,
        productive ? input.invocationId : null,
        productive ? input.completedAt : null,
        productive ? (input.itemCount ?? null) : null,
        publicationAt,
        publicationsJson,
        productive ? 1 : 0,
        input.completedAt,
      )
      .run(),
  );

  if (publications.length > 0) {
    await recordGenericSurfacePublications(db, input, publications);
  }
}

export async function loadProducerHeads(
  db: D1Database,
  identities?: readonly Pick<ProducerIdentity, "scheduleKey" | "job" | "producerPath" | "producerKind">[],
): Promise<ProducerHead[]> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT schedule_key, job, producer_path, producer_kind,
              last_invocation_id, last_worker_version, last_invoked_at,
              last_completed_at, last_outcome, last_error,
              last_productive_invocation_id, last_productive_at,
              last_productive_item_count, last_publication_at,
              invocation_count, productive_count
         FROM worker_producer_heads
        ORDER BY schedule_key, producer_path, job, producer_kind`,
      )
      .all<ProducerHeadRow>(),
  );
  const identityKeys = identities
    ? new Set(
        identities.map(
          (identity) =>
            `${identity.scheduleKey}\u0000${identity.job}\u0000${identity.producerPath}\u0000${identity.producerKind}`,
        ),
      )
    : null;
  return (rows.results ?? [])
    .filter(
      (row) =>
        !identityKeys ||
        identityKeys.has(`${row.schedule_key}\u0000${row.job}\u0000${row.producer_path}\u0000${row.producer_kind}`),
    )
    .map((row) => ({
      scheduleKey: row.schedule_key,
      job: row.job,
      producerPath: row.producer_path,
      producerKind: row.producer_kind,
      lastInvocationId: row.last_invocation_id,
      lastWorkerVersion: row.last_worker_version,
      lastInvokedAt: row.last_invoked_at,
      lastCompletedAt: row.last_completed_at,
      lastOutcome: row.last_outcome,
      lastError: row.last_error,
      lastProductiveInvocationId: row.last_productive_invocation_id,
      lastProductiveAt: row.last_productive_at,
      lastProductiveItemCount: row.last_productive_item_count,
      lastPublicationAt: row.last_publication_at,
      invocationCount: row.invocation_count,
      productiveCount: row.productive_count,
    }));
}

export async function pruneProducerHistory(db: D1Database, nowSec: number, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `DELETE FROM worker_producer_history
        WHERE (calendar_period IS NOT NULL AND completed_at < ?)
           OR (calendar_period IS NULL AND producer_kind = 'budget-only' AND completed_at < ?)
           OR (calendar_period IS NULL AND producer_kind != 'budget-only' AND completed_at < ?)`,
        )
        .bind(
          nowSec - CALENDAR_HISTORY_RETENTION_SEC,
          nowSec - BUDGET_HISTORY_RETENTION_SEC,
          nowSec - REGULAR_HISTORY_RETENTION_SEC,
        )
        .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return result.meta.changes ?? 0;
}

export function utcCalendarMonth(timestampSec: number): string {
  return new Date(timestampSec * 1_000).toISOString().slice(0, 7);
}
