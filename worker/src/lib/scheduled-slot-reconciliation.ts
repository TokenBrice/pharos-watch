import {
  flattenScheduledSlotPlanJobs,
  getScheduledTaskDescriptor,
  SCHEDULED_SLOT_PLANS,
} from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { parseObjectMetadata } from "./json-metadata";
import { recordProducerOutcome } from "./producer-history";
import { STALE_SLOT_ABANDONED_EVENT_TYPE, staleSlotEventCacheKey } from "./scheduled-slot-reconciliation-keys";

export {
  cacheKeySegment,
  STALE_SLOT_ABANDONED_EVENT_TYPE,
  staleSlotEventCacheKey,
} from "./scheduled-slot-reconciliation-keys";

export interface StaleSlotExecutionArtifact {
  slot_key: string;
  slot_started_at: number;
  state: "running" | "reconciling";
  execution_owner: string;
  execution_generation: number;
  invocation_id?: string | null;
  worker_version?: string | null;
  started_at: number;
  updated_at: number;
}

type StaleSlotProgressRow = {
  job: string;
  started_at: number;
  updated_at: number;
  stage: string | null;
  lease_owner: string | null;
  slot_started_at: number | null;
  metadata: string | null;
};

type StaleSlotLeaseRow = {
  lease_owner: string;
  lease_until: number;
};

type StaleSlotTerminalRunRow = {
  id: number;
  started_at: number;
  status: string;
  error: string | null;
  item_count: number | null;
  idempotency_key: string | null;
  metadata: string | null;
};

export interface ScheduledSlotReconciliationFence {
  slotKey: string;
  slotStartedAt: number;
  owner: string;
  generation: number;
  state: "running" | "reconciling";
}

type ReconciliationEvidence = {
  terminalRun: StaleSlotTerminalRunRow | null;
  generation: DexPublicationGenerationEvidence;
};

class ReconciliationEvidenceChangedError extends Error {
  constructor(job: string, slotStartedAt: number) {
    super(`reconciliation evidence changed for ${job}@${slotStartedAt}`);
    this.name = "ReconciliationEvidenceChangedError";
  }
}

class ScheduledSlotReconciliationOwnershipLostError extends Error {
  constructor(fence: ScheduledSlotReconciliationFence) {
    super(`scheduled slot reconciliation ownership lost for ${fence.slotKey}@${fence.slotStartedAt}`);
    this.name = "ScheduledSlotReconciliationOwnershipLostError";
  }
}

type WorkerJobAttemptCandidateRow = {
  attempt_id: string;
  idempotency_key: string;
  producer_kind: string;
  producer_path: string | null;
  invocation_id: string | null;
  attempt_no: number;
  owner: string | null;
  state: "queued" | "claimed" | "running" | "completed" | "failed" | "abandoned" | "skipped_locked";
  started_at: number | null;
  duration_ms: number | null;
  updated_at: number;
  item_count: number | null;
  result_metadata_json: string | null;
};

type AttemptTerminalOutcome = {
  state: "completed" | "failed" | "abandoned" | "skipped_locked";
  statusClass: "ok" | "degraded" | "controlled_error" | "abandoned" | "skipped_locked";
  error: string | null;
  itemCount: number | null;
};

type AttemptTerminalizationResult = {
  attemptsTerminalized: number;
  leasesCleared: number;
};

type DexPublicationGenerationRow = {
  generation_id: string;
  started_at: number;
  state: "staged" | "published" | "failed";
  expected_row_count: number;
  written_row_count: number;
  current_row_count: number | null;
  published_at: number | null;
};

type AmbiguousDexPublicationGenerationEvidence = {
  kind: "ambiguous";
  scope: "malformed-progress" | "generation-id" | "fallback-window";
  generationId: string | null;
  rows: DexPublicationGenerationRow[];
};

type DexPublicationGenerationEvidence = DexPublicationGenerationRow | AmbiguousDexPublicationGenerationEvidence | null;

export type StaleSlotChildDisposition =
  | "terminal_success"
  | "terminal_skipped_locked"
  | "terminal_failure"
  | "published_terminal_missing"
  | "publication_failure"
  | "terminal_accounting_unknown"
  | "not_started";

export interface StaleSlotReconciliationSummary {
  syntheticCronRuns: number;
  jobAttemptsAbandoned: number;
  jobAttemptsTerminalized: number;
  progressRowsCleared: number;
  leasesCleared: number;
  recoveryCheckpointsPrepared: number;
  notStartedCronRuns: number;
  successfulChildTerminals: number;
  skippedLockedChildTerminals: number;
  derivedPublishedChildTerminals: number;
  publicationFailures: number;
  terminalAccountingUnknown: number;
  realChildFailures: number;
  abandonedJobs: Array<{
    job: string;
    disposition: StaleSlotChildDisposition;
    progressStage: string | null;
    progressUpdatedAt: number;
    leaseOwner: string | null;
    leaseUntil: number | null;
  }>;
}

const STALE_SLOT_ERROR = "scheduled slot heartbeat stale; marked expired by later invocation";
const DEX_GENERATION_FALLBACK_WINDOW_SEC = 13 * 60;

async function listProgressRowsForStaleSlot(
  db: D1Database,
  slotStartedAt: number,
  jobs: readonly string[],
): Promise<StaleSlotProgressRow[]> {
  if (jobs.length === 0) return [];
  const jobPlaceholders = jobs.map(() => "?").join(", ");
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT job, started_at, updated_at, stage, lease_owner, slot_started_at, metadata
           FROM cron_run_progress
           WHERE slot_started_at = ?
             AND job IN (${jobPlaceholders})
           ORDER BY updated_at DESC`,
      )
      .bind(slotStartedAt, ...jobs)
      .all<StaleSlotProgressRow>(),
  );
  return rows.results ?? [];
}

async function getProgressRowForScheduledSlotJob(
  db: D1Database,
  job: string,
  slotStartedAt: number,
): Promise<StaleSlotProgressRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT job, started_at, updated_at, stage, lease_owner, slot_started_at, metadata
           FROM cron_run_progress
          WHERE job = ? AND slot_started_at = ?
          LIMIT 1`,
      )
      .bind(job, slotStartedAt)
      .first<StaleSlotProgressRow>(),
  );
}

function getExpectedJobsForScheduledSlot(slotKey: string): readonly string[] {
  const plan = SCHEDULED_SLOT_PLANS[slotKey as CronScheduleKey];
  return plan ? flattenScheduledSlotPlanJobs(plan) : [];
}

export async function hasActiveChildLeaseForScheduledSlot(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  nowSec: number,
): Promise<boolean> {
  const jobs = getExpectedJobsForScheduledSlot(slotKey);
  if (jobs.length === 0) return false;
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT 1 AS active
           FROM cron_run_progress p
           JOIN cron_leases l
             ON l.job = p.job
            AND l.lease_owner = p.lease_owner
          WHERE p.slot_started_at = ?
            AND p.job IN (${jobs.map(() => "?").join(", ")})
            AND l.lease_until >= ?
          LIMIT 1`,
      )
      .bind(slotStartedAt, ...jobs, nowSec)
      .first<{ active: number }>(),
  );
  return row?.active === 1;
}

async function getCronLeaseForJob(db: D1Database, job: string): Promise<StaleSlotLeaseRow | null> {
  return runWithOverloadRetry(() =>
    db.prepare("SELECT lease_owner, lease_until FROM cron_leases WHERE job = ?").bind(job).first<StaleSlotLeaseRow>(),
  );
}

async function getTerminalCronRunForSlot(
  db: D1Database,
  job: string,
  slotStartedAt: number,
): Promise<StaleSlotTerminalRunRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT id, started_at, status, error, item_count, idempotency_key, metadata
           FROM cron_runs
          WHERE job = ? AND slot_started_at = ?
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
      )
      .bind(job, slotStartedAt)
      .first<StaleSlotTerminalRunRow>(),
  );
}

function scheduledSlotFencePredicate(): string {
  return `EXISTS (
    SELECT 1
      FROM cron_slot_executions reconciliation_slot
     WHERE reconciliation_slot.slot_key = ?
       AND reconciliation_slot.slot_started_at = ?
       AND reconciliation_slot.state = ?
       AND reconciliation_slot.execution_owner = ?
       AND reconciliation_slot.execution_generation = ?
  )`;
}

function scheduledSlotFenceBinds(fence: ScheduledSlotReconciliationFence): Array<string | number> {
  return [fence.slotKey, fence.slotStartedAt, fence.state, fence.owner, fence.generation];
}

async function hasScheduledSlotReconciliationFence(
  db: D1Database,
  fence: ScheduledSlotReconciliationFence,
): Promise<boolean> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT 1 AS owned
         FROM cron_slot_executions
        WHERE slot_key = ?
          AND slot_started_at = ?
          AND state = ?
          AND execution_owner = ?
          AND execution_generation = ?
        LIMIT 1`,
      )
      .bind(...scheduledSlotFenceBinds(fence))
      .first<{ owned: number }>(),
  );
  return row?.owned === 1;
}

async function assertScheduledSlotReconciliationFence(
  db: D1Database,
  fence: ScheduledSlotReconciliationFence,
): Promise<void> {
  if (!(await hasScheduledSlotReconciliationFence(db, fence))) {
    throw new ScheduledSlotReconciliationOwnershipLostError(fence);
  }
}

function evidenceFingerprint(evidence: ReconciliationEvidence): string {
  return JSON.stringify({
    terminalRun:
      evidence.terminalRun == null
        ? null
        : {
            id: evidence.terminalRun.id,
            startedAt: evidence.terminalRun.started_at,
            status: evidence.terminalRun.status,
            error: evidence.terminalRun.error,
            itemCount: evidence.terminalRun.item_count,
            idempotencyKey: evidence.terminalRun.idempotency_key,
            metadata: evidence.terminalRun.metadata,
          },
    generation: isAmbiguousGenerationEvidence(evidence.generation)
      ? {
          kind: evidence.generation.kind,
          scope: evidence.generation.scope,
          generationId: evidence.generation.generationId,
          rows: evidence.generation.rows.map(dexGenerationFingerprint),
        }
      : evidence.generation == null
        ? null
        : dexGenerationFingerprint(evidence.generation),
  });
}

function isAmbiguousGenerationEvidence(
  evidence: DexPublicationGenerationEvidence,
): evidence is AmbiguousDexPublicationGenerationEvidence {
  return evidence != null && "kind" in evidence && evidence.kind === "ambiguous";
}

function dexGenerationFingerprint(generation: DexPublicationGenerationRow): Record<string, unknown> {
  return {
    generationId: generation.generation_id,
    startedAt: generation.started_at,
    state: generation.state,
    expectedRowCount: generation.expected_row_count,
    writtenRowCount: generation.written_row_count,
    currentRowCount: generation.current_row_count,
    publishedAt: generation.published_at,
  };
}

function appendExactDexGenerationPredicate(
  clauses: string[],
  binds: unknown[],
  generation: DexPublicationGenerationRow,
): void {
  clauses.push(`EXISTS (
    SELECT 1 FROM dex_liquidity_publication_generations generation
     WHERE generation.generation_id = ?
       AND generation.started_at = ?
       AND generation.state = ?
       AND generation.expected_row_count = ?
       AND generation.written_row_count = ?
       AND generation.current_row_count IS ?
       AND generation.published_at IS ?
  )`);
  binds.push(
    generation.generation_id,
    generation.started_at,
    generation.state,
    generation.expected_row_count,
    generation.written_row_count,
    generation.current_row_count,
    generation.published_at,
  );
}

function buildReconciliationEvidencePredicate(
  job: string,
  slotStartedAt: number,
  progress: StaleSlotProgressRow | null,
  evidence: ReconciliationEvidence,
): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (evidence.terminalRun) {
    const terminal = evidence.terminalRun;
    clauses.push(`EXISTS (
      SELECT 1 FROM cron_runs terminal
       WHERE terminal.id = ?
         AND terminal.job = ?
         AND terminal.slot_started_at = ?
         AND terminal.started_at = ?
         AND terminal.status = ?
         AND terminal.error IS ?
         AND terminal.item_count IS ?
         AND terminal.idempotency_key IS ?
         AND terminal.metadata IS ?
    ) AND NOT EXISTS (
      SELECT 1 FROM cron_runs newer_terminal
       WHERE newer_terminal.job = ?
         AND newer_terminal.slot_started_at = ?
         AND (
           newer_terminal.started_at > ?
           OR (newer_terminal.started_at = ? AND newer_terminal.id > ?)
         )
    )`);
    binds.push(
      terminal.id,
      job,
      slotStartedAt,
      terminal.started_at,
      terminal.status,
      terminal.error,
      terminal.item_count,
      terminal.idempotency_key,
      terminal.metadata,
      job,
      slotStartedAt,
      terminal.started_at,
      terminal.started_at,
      terminal.id,
    );
  } else {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM cron_runs terminal
       WHERE terminal.job = ? AND terminal.slot_started_at = ?
    )`);
    binds.push(job, slotStartedAt);
  }

  if (progress) {
    clauses.push(`EXISTS (
      SELECT 1 FROM cron_run_progress reconciliation_progress
       WHERE reconciliation_progress.job = ?
         AND reconciliation_progress.slot_started_at = ?
         AND reconciliation_progress.started_at = ?
         AND reconciliation_progress.updated_at = ?
         AND reconciliation_progress.stage IS ?
         AND reconciliation_progress.lease_owner IS ?
         AND reconciliation_progress.metadata IS ?
    )`);
    binds.push(
      progress.job,
      slotStartedAt,
      progress.started_at,
      progress.updated_at,
      progress.stage,
      progress.lease_owner,
      progress.metadata,
    );
  } else {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM cron_run_progress reconciliation_progress
       WHERE reconciliation_progress.job = ?
         AND reconciliation_progress.slot_started_at = ?
    )`);
    binds.push(job, slotStartedAt);
  }

  if (progress?.job === "sync-dex-liquidity" && progress.stage?.startsWith("persistence")) {
    const metadata = parseObjectMetadata(progress.metadata);
    const generationId =
      typeof metadata?.generationId === "string" && metadata.generationId.length > 0 ? metadata.generationId : null;
    const fallbackWindowEnd = Math.min(progress.updated_at, progress.started_at + DEX_GENERATION_FALLBACK_WINDOW_SEC);
    if (evidence.generation && !isAmbiguousGenerationEvidence(evidence.generation)) {
      const generation = evidence.generation;
      appendExactDexGenerationPredicate(clauses, binds, generation);
      if (!generationId) {
        clauses.push(`(
          SELECT COUNT(*) FROM dex_liquidity_publication_generations generation
           WHERE generation.started_at BETWEEN ? AND ?
        ) = 1`);
        binds.push(progress.started_at, fallbackWindowEnd);
      }
    } else if (evidence.generation == null) {
      if (generationId) {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM dex_liquidity_publication_generations generation
           WHERE generation.generation_id = ?
        )`);
        binds.push(generationId);
      } else {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM dex_liquidity_publication_generations generation
           WHERE generation.started_at BETWEEN ? AND ?
        )`);
        binds.push(progress.started_at, fallbackWindowEnd);
      }
    } else if (evidence.generation.scope === "generation-id") {
      if (evidence.generation.rows[0]) {
        appendExactDexGenerationPredicate(clauses, binds, evidence.generation.rows[0]);
      } else {
        clauses.push(`NOT EXISTS (
          SELECT 1 FROM dex_liquidity_publication_generations generation
           WHERE generation.generation_id = ?
        )`);
        binds.push(evidence.generation.generationId);
      }
    } else if (evidence.generation.scope === "fallback-window") {
      clauses.push(`(
        SELECT COUNT(*) FROM dex_liquidity_publication_generations generation
         WHERE generation.started_at BETWEEN ? AND ?
      ) = ?`);
      binds.push(progress.started_at, fallbackWindowEnd, evidence.generation.rows.length);
      for (const generation of evidence.generation.rows) {
        appendExactDexGenerationPredicate(clauses, binds, generation);
      }
    }
  }

  return { sql: clauses.map((clause) => `AND ${clause}`).join("\n"), binds };
}

function isSuccessfulTerminalStatus(status: string): boolean {
  return status === "ok" || status === "degraded" || status === "skipped_neutral";
}

function dispositionForTerminalStatus(status: string): StaleSlotChildDisposition {
  if (isSuccessfulTerminalStatus(status)) return "terminal_success";
  return status === "skipped_locked" ? "terminal_skipped_locked" : "terminal_failure";
}

function syntheticDispositionForTerminalRun(run: StaleSlotTerminalRunRow): StaleSlotChildDisposition | null {
  const metadata = parseObjectMetadata(run.metadata);
  const disposition = metadata?.childDisposition;
  if (
    metadata?.reason === "stale-slot-reconciled" &&
    (disposition === "published_terminal_missing" ||
      disposition === "publication_failure" ||
      disposition === "terminal_accounting_unknown" ||
      disposition === "not_started")
  ) {
    return disposition;
  }
  if (run.idempotency_key?.startsWith("scheduled-slot-not-started:")) return "not_started";
  if (run.idempotency_key?.startsWith("scheduled-slot-published-terminal-missing:")) {
    return "published_terminal_missing";
  }
  if (run.idempotency_key?.startsWith("scheduled-slot-stale:")) return "terminal_accounting_unknown";
  return null;
}

function recordDisposition(summary: StaleSlotReconciliationSummary, disposition: StaleSlotChildDisposition): void {
  if (disposition === "terminal_success") summary.successfulChildTerminals++;
  else if (disposition === "terminal_skipped_locked") summary.skippedLockedChildTerminals++;
  else if (disposition === "terminal_failure") summary.realChildFailures++;
  else if (disposition === "published_terminal_missing") {
    summary.derivedPublishedChildTerminals++;
    summary.terminalAccountingUnknown++;
  } else if (disposition === "publication_failure") summary.publicationFailures++;
  else if (disposition === "terminal_accounting_unknown") summary.terminalAccountingUnknown++;
  else summary.notStartedCronRuns++;
}

function terminalOutcomeForRun(
  run: StaleSlotTerminalRunRow,
  disposition: StaleSlotChildDisposition,
): AttemptTerminalOutcome {
  if (disposition === "published_terminal_missing") {
    return { state: "completed", statusClass: "degraded", error: null, itemCount: run.item_count };
  }
  if (
    disposition === "publication_failure" ||
    disposition === "terminal_accounting_unknown" ||
    disposition === "not_started"
  ) {
    return {
      state: "abandoned",
      statusClass: "abandoned",
      error: run.error ?? STALE_SLOT_ERROR,
      itemCount: run.item_count,
    };
  }
  if (disposition === "terminal_skipped_locked") {
    return { state: "skipped_locked", statusClass: "skipped_locked", error: run.error, itemCount: run.item_count };
  }
  if (disposition === "terminal_success") {
    return {
      state: "completed",
      statusClass: run.status === "degraded" ? "degraded" : "ok",
      error: run.error,
      itemCount: run.item_count,
    };
  }
  return { state: "failed", statusClass: "controlled_error", error: run.error, itemCount: run.item_count };
}

function isReconciliationOwnedTerminalAttempt(attempt: WorkerJobAttemptCandidateRow): boolean {
  if (!["completed", "failed", "abandoned", "skipped_locked"].includes(attempt.state)) return false;
  const metadata = parseObjectMetadata(attempt.result_metadata_json);
  const fence = metadata?.reconciliationFence;
  return (
    metadata?.reason === "stale-slot-reconciled" &&
    fence != null &&
    typeof fence === "object" &&
    typeof (fence as Record<string, unknown>).owner === "string" &&
    typeof (fence as Record<string, unknown>).generation === "number"
  );
}

async function terminalizeWorkerJobAttemptsForKnownOutcome(
  db: D1Database,
  input: {
    slot: StaleSlotExecutionArtifact;
    job: string;
    nowSec: number;
    outcome: AttemptTerminalOutcome;
    metadata: Record<string, unknown>;
    expectedOwner?: string | null;
    expectedExpiredLease?: StaleSlotLeaseRow;
    reconciliationFence: ScheduledSlotReconciliationFence;
    progress: StaleSlotProgressRow | null;
    evidence: ReconciliationEvidence;
  },
): Promise<AttemptTerminalizationResult> {
  const descriptor = getScheduledTaskDescriptor(input.slot.slot_key as CronScheduleKey, input.job);
  const activeRows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT attempt_id, idempotency_key, producer_kind, producer_path, invocation_id,
                attempt_no, owner, state, started_at, duration_ms, updated_at, item_count, result_metadata_json
           FROM worker_job_attempts
          WHERE schedule_key = ?
            AND slot_started_at = ?
            AND job = ?
            AND state IN ('queued', 'claimed', 'running')
          ORDER BY attempt_no DESC
          LIMIT 2`,
      )
      .bind(input.slot.slot_key, input.slot.slot_started_at, input.job)
      .all<WorkerJobAttemptCandidateRow>(),
  );
  const activeAttempts = activeRows.results ?? [];
  if (activeAttempts.length > 1) {
    throw new Error(`ambiguous active worker-job attempts for ${input.job}@${input.slot.slot_started_at}`);
  }
  const correctionRows =
    activeAttempts.length === 0
      ? await runWithOverloadRetry(() =>
          db
            .prepare(
              `SELECT attempt_id, idempotency_key, producer_kind, producer_path, invocation_id,
                attempt_no, owner, state, started_at, duration_ms, updated_at, item_count, result_metadata_json
           FROM worker_job_attempts
          WHERE schedule_key = ?
            AND slot_started_at = ?
            AND job = ?
            AND state IN ('completed', 'failed', 'abandoned', 'skipped_locked')
          ORDER BY attempt_no DESC
          LIMIT 2`,
            )
            .bind(input.slot.slot_key, input.slot.slot_started_at, input.job)
            .all<WorkerJobAttemptCandidateRow>(),
        )
      : null;
  const correctionAttempt = (correctionRows?.results ?? []).find(isReconciliationOwnedTerminalAttempt);
  const attempt = activeAttempts[0] ?? correctionAttempt;
  const correctingReconciliationAttempt = activeAttempts.length === 0 && correctionAttempt != null;
  if (!attempt && !input.expectedExpiredLease) {
    await assertScheduledSlotReconciliationFence(db, input.reconciliationFence);
    return { attemptsTerminalized: 0, leasesCleared: 0 };
  }
  if (
    attempt &&
    (attempt.producer_kind !== "scheduled-job" ||
      attempt.producer_path !== descriptor.producerPath ||
      (input.slot.invocation_id != null && attempt.invocation_id !== input.slot.invocation_id) ||
      (input.expectedOwner !== undefined && attempt.owner !== input.expectedOwner))
  ) {
    throw new Error(`worker-job attempt identity mismatch for ${input.job}@${input.slot.slot_started_at}`);
  }
  const expectedLease = input.expectedExpiredLease;
  if (
    expectedLease &&
    (expectedLease.lease_until >= input.nowSec ||
      (input.expectedOwner !== undefined && expectedLease.lease_owner !== input.expectedOwner))
  ) {
    throw new Error(`refusing to retire active or mismatched lease for ${input.job}@${input.slot.slot_started_at}`);
  }
  const evidencePredicate = buildReconciliationEvidencePredicate(
    input.job,
    input.slot.slot_started_at,
    input.progress,
    input.evidence,
  );
  const statements: D1PreparedStatement[] = [];
  let mergedMetadata: string | null = null;
  if (attempt) {
    const existingMetadata = parseObjectMetadata(attempt.result_metadata_json) ?? {};
    mergedMetadata = JSON.stringify({
      ...existingMetadata,
      ...input.metadata,
      reconciliationFence: {
        owner: input.reconciliationFence.owner,
        generation: input.reconciliationFence.generation,
      },
    });
    const leaseFenceSql =
      expectedLease && !correctingReconciliationAttempt
        ? `
            AND EXISTS (
              SELECT 1
                FROM cron_leases
               WHERE job = ?
                 AND lease_owner = ?
                 AND lease_until = ?
                 AND lease_until < ?
            )`
        : "";
    statements.push(
      db
        .prepare(
          `UPDATE worker_job_attempts
            SET state = ?,
                status_class = ?,
                finished_at = ?,
                duration_ms = CASE
                  WHEN started_at IS NULL THEN duration_ms
                  ELSE MAX(0, (? - started_at) * 1000)
                END,
                item_count = COALESCE(?, item_count),
                error = ?,
                result_metadata_json = ?,
                updated_at = ?
          WHERE attempt_id = ?
            AND idempotency_key = ?
            AND schedule_key = ?
            AND slot_started_at = ?
            AND job = ?
            AND producer_kind = ?
            AND producer_path IS ?
            AND invocation_id IS ?
            AND attempt_no = ?
            AND owner IS ?
            AND state = ?
            AND updated_at = ?${leaseFenceSql}
            AND ${scheduledSlotFencePredicate()}
            ${evidencePredicate.sql}`,
        )
        .bind(
          input.outcome.state,
          input.outcome.statusClass,
          input.nowSec,
          input.nowSec,
          input.outcome.itemCount,
          input.outcome.error,
          mergedMetadata,
          input.nowSec,
          attempt.attempt_id,
          attempt.idempotency_key,
          input.slot.slot_key,
          input.slot.slot_started_at,
          input.job,
          attempt.producer_kind,
          attempt.producer_path,
          attempt.invocation_id,
          attempt.attempt_no,
          attempt.owner,
          attempt.state,
          attempt.updated_at,
          ...(expectedLease && !correctingReconciliationAttempt
            ? [input.job, expectedLease.lease_owner, expectedLease.lease_until, input.nowSec]
            : []),
          ...scheduledSlotFenceBinds(input.reconciliationFence),
          ...evidencePredicate.binds,
        ),
    );
  }
  if (expectedLease) {
    const terminalAttemptFenceSql = attempt
      ? `
            AND EXISTS (
              SELECT 1
                FROM worker_job_attempts
               WHERE attempt_id = ?
                 AND idempotency_key = ?
                 AND state = ?
                 AND finished_at = ?
                 AND updated_at = ?
            )`
      : "";
    statements.push(
      db
        .prepare(
          `DELETE FROM cron_leases
          WHERE job = ?
            AND lease_owner = ?
            AND lease_until = ?
            AND lease_until < ?
            AND NOT EXISTS (
              SELECT 1
                FROM worker_job_attempts
               WHERE schedule_key = ?
                 AND slot_started_at = ?
                 AND job = ?
                 AND owner IS ?
                 AND state IN ('queued', 'claimed', 'running')
            )${terminalAttemptFenceSql}
            AND ${scheduledSlotFencePredicate()}
            ${evidencePredicate.sql}`,
        )
        .bind(
          input.job,
          expectedLease.lease_owner,
          expectedLease.lease_until,
          input.nowSec,
          input.slot.slot_key,
          input.slot.slot_started_at,
          input.job,
          expectedLease.lease_owner,
          ...(attempt
            ? [attempt.attempt_id, attempt.idempotency_key, input.outcome.state, input.nowSec, input.nowSec]
            : []),
          ...scheduledSlotFenceBinds(input.reconciliationFence),
          ...evidencePredicate.binds,
        ),
    );
  }
  const results = await runWithOverloadRetry(() => db.batch(statements));
  const attemptsTerminalized = attempt ? (results[0]?.meta.changes ?? 0) : 0;
  const leaseResultIndex = attempt ? 1 : 0;
  const leasesCleared = expectedLease ? (results[leaseResultIndex]?.meta.changes ?? 0) : 0;
  const attemptApplied = !attempt || attemptsTerminalized === 1;
  const leaseApplied = !expectedLease || leasesCleared === 1;
  if (!attemptApplied || !leaseApplied) {
    const expectedItemCount = input.outcome.itemCount ?? attempt?.item_count ?? null;
    const exactAttempt =
      !attempt ||
      (await runWithOverloadRetry(() =>
        db
          .prepare(
            `SELECT 1 AS applied
           FROM worker_job_attempts
          WHERE attempt_id = ?
            AND idempotency_key = ?
            AND state = ?
            AND status_class = ?
            AND finished_at = ?
            AND item_count IS ?
            AND error IS ?
            AND result_metadata_json = ?
            AND updated_at = ?
          LIMIT 1`,
          )
          .bind(
            attempt.attempt_id,
            attempt.idempotency_key,
            input.outcome.state,
            input.outcome.statusClass,
            input.nowSec,
            expectedItemCount,
            input.outcome.error,
            mergedMetadata,
            input.nowSec,
          )
          .first<{ applied: number }>(),
      ));
    const exactLeaseRetired =
      !expectedLease ||
      !(await runWithOverloadRetry(() =>
        db
          .prepare(
            `SELECT 1 AS present FROM cron_leases
          WHERE job = ? AND lease_owner = ? AND lease_until = ?
          LIMIT 1`,
          )
          .bind(input.job, expectedLease.lease_owner, expectedLease.lease_until)
          .first<{ present: number }>(),
      ));
    if (exactAttempt && exactLeaseRetired) {
      return {
        attemptsTerminalized: attempt ? 1 : 0,
        leasesCleared: expectedLease ? 1 : 0,
      };
    }
    await assertScheduledSlotReconciliationFence(db, input.reconciliationFence);
    await assertReconciliationEvidenceUnchanged(
      db,
      input.job,
      input.slot.slot_started_at,
      input.progress,
      input.evidence,
    );
    if (attempt && attemptsTerminalized !== 1) {
      throw new Error(`worker-job attempt terminal CAS lost for ${input.job}@${input.slot.slot_started_at}`);
    }
    throw new Error(`expired lease retirement CAS lost for ${input.job}@${input.slot.slot_started_at}`);
  }
  return { attemptsTerminalized, leasesCleared };
}

async function loadDexPublicationGeneration(
  db: D1Database,
  progress: StaleSlotProgressRow,
): Promise<DexPublicationGenerationEvidence> {
  if (progress.job !== "sync-dex-liquidity") return null;
  if (!progress.stage?.startsWith("persistence")) return null;
  const fallbackWindowEnd = Math.min(progress.updated_at, progress.started_at + DEX_GENERATION_FALLBACK_WINDOW_SEC);
  if (fallbackWindowEnd < progress.started_at) {
    return { kind: "ambiguous", scope: "malformed-progress", generationId: null, rows: [] };
  }
  const metadata = parseObjectMetadata(progress.metadata);
  if (progress.metadata != null && metadata == null) {
    return { kind: "ambiguous", scope: "malformed-progress", generationId: null, rows: [] };
  }
  const hasGenerationIdentity = metadata != null && Object.prototype.hasOwnProperty.call(metadata, "generationId");
  if (hasGenerationIdentity) {
    if (typeof metadata.generationId !== "string" || metadata.generationId.length === 0) {
      return { kind: "ambiguous", scope: "malformed-progress", generationId: null, rows: [] };
    }
    const generation = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT generation_id, started_at, state, expected_row_count, written_row_count,
                  current_row_count, published_at
             FROM dex_liquidity_publication_generations
            WHERE generation_id = ?
            LIMIT 1`,
        )
        .bind(metadata.generationId)
        .first<DexPublicationGenerationRow>(),
    );
    if (
      !generation ||
      generation.generation_id !== metadata.generationId ||
      generation.started_at < progress.started_at ||
      generation.started_at > fallbackWindowEnd
    ) {
      return {
        kind: "ambiguous",
        scope: "generation-id",
        generationId: metadata.generationId,
        rows: generation ? [generation] : [],
      };
    }
    return generation;
  }
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT generation_id, started_at, state, expected_row_count, written_row_count,
                current_row_count, published_at
          FROM dex_liquidity_publication_generations
          WHERE started_at BETWEEN ? AND ?
          ORDER BY started_at ASC, generation_id ASC`,
      )
      .bind(progress.started_at, fallbackWindowEnd)
      .all<DexPublicationGenerationRow>(),
  );
  const results = rows.results ?? [];
  if (results.length > 1) {
    return {
      kind: "ambiguous",
      scope: "fallback-window",
      generationId: null,
      rows: results,
    };
  }
  return results[0] ?? null;
}

function progressFingerprint(progress: StaleSlotProgressRow | null): string {
  return JSON.stringify(
    progress == null
      ? null
      : {
          job: progress.job,
          startedAt: progress.started_at,
          updatedAt: progress.updated_at,
          stage: progress.stage,
          leaseOwner: progress.lease_owner,
          slotStartedAt: progress.slot_started_at,
          metadata: progress.metadata,
        },
  );
}

async function assertReconciliationEvidenceUnchanged(
  db: D1Database,
  job: string,
  slotStartedAt: number,
  progress: StaleSlotProgressRow | null,
  evidence: ReconciliationEvidence,
): Promise<void> {
  const currentProgress = await getProgressRowForScheduledSlotJob(db, job, slotStartedAt);
  const currentEvidence: ReconciliationEvidence = {
    terminalRun: await getTerminalCronRunForSlot(db, job, slotStartedAt),
    generation: currentProgress ? await loadDexPublicationGeneration(db, currentProgress) : null,
  };
  if (
    progressFingerprint(currentProgress) !== progressFingerprint(progress) ||
    evidenceFingerprint(currentEvidence) !== evidenceFingerprint(evidence)
  ) {
    throw new ReconciliationEvidenceChangedError(job, slotStartedAt);
  }
}

function isCompletePublishedGeneration(generation: DexPublicationGenerationRow): boolean {
  return (
    generation.state === "published" &&
    generation.published_at != null &&
    generation.expected_row_count > 0 &&
    generation.written_row_count === generation.expected_row_count &&
    generation.current_row_count === generation.expected_row_count
  );
}

async function hasCronRunWithIdempotencyKey(
  db: D1Database,
  job: string,
  slotStartedAt: number,
  idempotencyKey: string,
): Promise<boolean> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT id
           FROM cron_runs
          WHERE job = ? AND slot_started_at = ? AND idempotency_key = ?
          LIMIT 1`,
      )
      .bind(job, slotStartedAt, idempotencyKey)
      .first<{ id: number }>(),
  );
  return row != null;
}

async function canPersistSyntheticProducerOutcome(
  db: D1Database,
  input: {
    scheduleKey: string;
    job: string;
    producerPath: string;
    invocationId: string;
    idempotencyKey: string;
  },
): Promise<boolean> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT idempotency_key
           FROM worker_producer_history
          WHERE schedule_key = ?
            AND job = ?
            AND producer_path = ?
            AND producer_kind = 'scheduled-job'
            AND invocation_id = ?
          LIMIT 1`,
      )
      .bind(input.scheduleKey, input.job, input.producerPath, input.invocationId)
      .first<{ idempotency_key: string }>(),
  );
  return row == null || row.idempotency_key === input.idempotencyKey;
}

async function insertSyntheticStaleCronRun(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  progress: StaleSlotProgressRow,
  lease: StaleSlotLeaseRow | null,
  nowSec: number,
  disposition: "publication_failure" | "terminal_accounting_unknown",
  generation?: DexPublicationGenerationRow | null,
  reconciliationFence?: ScheduledSlotReconciliationFence,
  evidence?: ReconciliationEvidence,
): Promise<boolean> {
  const startedAt = progress.started_at || slot.started_at || slot.slot_started_at;
  const durationMs = Math.max(0, nowSec - startedAt) * 1000;
  const error = "scheduled slot heartbeat stale; child job progress abandoned";
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: disposition === "publication_failure" ? "publication-failure" : "terminal-accounting-unknown",
    childDisposition: disposition,
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    progressStage: progress.stage,
    progressUpdatedAt: progress.updated_at,
    leaseOwner: progress.lease_owner,
    leaseUntil: lease?.lease_until ?? null,
    generationId: generation?.generation_id ?? null,
    generationState: generation?.state ?? null,
    expectedRows: generation?.expected_row_count ?? null,
    writtenRows: generation?.written_row_count ?? null,
    publishedRows: generation?.current_row_count ?? null,
    reconciledAt: nowSec,
  });
  const idempotencyKey = ["scheduled-slot-stale", slot.slot_key, slot.slot_started_at, progress.job, startedAt].join(
    ":",
  );
  const descriptor = getScheduledTaskDescriptor(slot.slot_key as CronScheduleKey, progress.job);
  const invocationId = slot.invocation_id ?? `platform-abandoned:${slot.execution_owner}`;
  if (
    !(await canPersistSyntheticProducerOutcome(db, {
      scheduleKey: slot.slot_key,
      job: progress.job,
      producerPath: descriptor.producerPath,
      invocationId,
      idempotencyKey,
    }))
  ) {
    return false;
  }

  if (!reconciliationFence || !evidence) {
    throw new Error("synthetic stale cron reconciliation requires an ownership and evidence fence");
  }
  const evidencePredicate = buildReconciliationEvidencePredicate(
    progress.job,
    slot.slot_started_at,
    progress,
    evidence,
  );
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, error, item_count, metadata, slot_started_at, idempotency_key,
            schedule_key, producer_path, producer_kind, invocation_id, worker_version,
            productive, publication_count, calendar_period)
         SELECT ?, ?, ?, 'error', ?, NULL, ?, ?, ?, ?, ?, 'scheduled-job', ?, ?, 0, 0, NULL
          WHERE ${scheduledSlotFencePredicate()}
            ${evidencePredicate.sql}
            AND NOT EXISTS (
            SELECT 1 FROM cron_runs WHERE job = ? AND slot_started_at = ?
          )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        progress.job,
        startedAt,
        durationMs,
        error,
        metadata,
        slot.slot_started_at,
        idempotencyKey,
        slot.slot_key,
        descriptor.producerPath,
        invocationId,
        slot.worker_version ?? null,
        ...scheduledSlotFenceBinds(reconciliationFence),
        ...evidencePredicate.binds,
        progress.job,
        slot.slot_started_at,
      )
      .run(),
  );
  const inserted = (result.meta.changes ?? 0) === 1;
  if (!inserted && !(await hasCronRunWithIdempotencyKey(db, progress.job, slot.slot_started_at, idempotencyKey))) {
    await assertScheduledSlotReconciliationFence(db, reconciliationFence);
    await assertReconciliationEvidenceUnchanged(db, progress.job, slot.slot_started_at, progress, evidence);
    return false;
  }
  await assertScheduledSlotReconciliationFence(db, reconciliationFence);
  await recordProducerOutcome(db, {
    scheduleKey: slot.slot_key,
    job: progress.job,
    producerPath: descriptor.producerPath,
    producerKind: "scheduled-job",
    invocationId,
    workerVersion: slot.worker_version ?? null,
    slotStartedAt: slot.slot_started_at,
    idempotencyKey,
    invokedAt: startedAt,
    completedAt: nowSec,
    outcome: "abandoned",
    itemCount: null,
    metadata,
    error,
    productivity: { productive: false, reason: "platform-abandoned" },
    writeFence: reconciliationFence,
  });
  return inserted;
}

async function insertSyntheticPublishedCronRun(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  progress: StaleSlotProgressRow,
  generation: DexPublicationGenerationRow,
  nowSec: number,
  reconciliationFence: ScheduledSlotReconciliationFence,
  evidence: ReconciliationEvidence,
): Promise<boolean> {
  const startedAt = progress.started_at || slot.started_at || slot.slot_started_at;
  const durationMs = Math.max(0, nowSec - startedAt) * 1000;
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: "terminal-accounting-unknown",
    childDisposition: "published_terminal_missing",
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    progressStage: progress.stage,
    progressUpdatedAt: progress.updated_at,
    generationId: generation.generation_id,
    expectedRows: generation.expected_row_count,
    publishedRows: generation.current_row_count,
    publishedAt: generation.published_at,
    reconciledAt: nowSec,
  });
  const idempotencyKey = [
    "scheduled-slot-published-terminal-missing",
    slot.slot_key,
    slot.slot_started_at,
    progress.job,
    generation.generation_id,
  ].join(":");
  const descriptor = getScheduledTaskDescriptor(slot.slot_key as CronScheduleKey, progress.job);
  const invocationId = slot.invocation_id ?? `platform-abandoned:${slot.execution_owner}`;
  if (
    !(await canPersistSyntheticProducerOutcome(db, {
      scheduleKey: slot.slot_key,
      job: progress.job,
      producerPath: descriptor.producerPath,
      invocationId,
      idempotencyKey,
    }))
  ) {
    return false;
  }

  const evidencePredicate = buildReconciliationEvidencePredicate(
    progress.job,
    slot.slot_started_at,
    progress,
    evidence,
  );
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, error, item_count, metadata, slot_started_at, idempotency_key,
            schedule_key, producer_path, producer_kind, invocation_id, worker_version,
            productive, publication_count, calendar_period)
         SELECT ?, ?, ?, 'degraded', NULL, ?, ?, ?, ?, ?, ?, 'scheduled-job', ?, ?, 1, 1, NULL
          WHERE ${scheduledSlotFencePredicate()}
            ${evidencePredicate.sql}
            AND NOT EXISTS (
            SELECT 1 FROM cron_runs WHERE job = ? AND slot_started_at = ?
          )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        progress.job,
        startedAt,
        durationMs,
        generation.current_row_count,
        metadata,
        slot.slot_started_at,
        idempotencyKey,
        slot.slot_key,
        descriptor.producerPath,
        invocationId,
        slot.worker_version ?? null,
        ...scheduledSlotFenceBinds(reconciliationFence),
        ...evidencePredicate.binds,
        progress.job,
        slot.slot_started_at,
      )
      .run(),
  );
  const inserted = (result.meta.changes ?? 0) === 1;
  if (!inserted && !(await hasCronRunWithIdempotencyKey(db, progress.job, slot.slot_started_at, idempotencyKey))) {
    await assertScheduledSlotReconciliationFence(db, reconciliationFence);
    await assertReconciliationEvidenceUnchanged(db, progress.job, slot.slot_started_at, progress, evidence);
    return false;
  }
  await assertScheduledSlotReconciliationFence(db, reconciliationFence);
  await recordProducerOutcome(db, {
    scheduleKey: slot.slot_key,
    job: progress.job,
    producerPath: descriptor.producerPath,
    producerKind: "scheduled-job",
    invocationId,
    workerVersion: slot.worker_version ?? null,
    slotStartedAt: slot.slot_started_at,
    idempotencyKey,
    invokedAt: startedAt,
    completedAt: nowSec,
    outcome: "degraded",
    itemCount: generation.current_row_count,
    metadata,
    productivity: {
      productive: true,
      reason: "published-terminal-accounting-recovered",
      publications: [
        {
          surface: "dex-liquidity",
          generationId: generation.generation_id,
          publishedAt: generation.published_at!,
          candidateRows: generation.written_row_count,
          publishedRows: generation.current_row_count,
          expectedRows: generation.expected_row_count,
        },
      ],
    },
    writeFence: reconciliationFence,
  });
  return inserted;
}

async function correctSyntheticTerminalForPublishedGeneration(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  progress: StaleSlotProgressRow,
  terminalRun: StaleSlotTerminalRunRow,
  generation: DexPublicationGenerationRow,
  nowSec: number,
  reconciliationFence: ScheduledSlotReconciliationFence,
  evidence: ReconciliationEvidence,
): Promise<void> {
  const startedAt = progress.started_at || slot.started_at || slot.slot_started_at;
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: "terminal-accounting-unknown",
    childDisposition: "published_terminal_missing",
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    progressStage: progress.stage,
    progressUpdatedAt: progress.updated_at,
    generationId: generation.generation_id,
    expectedRows: generation.expected_row_count,
    publishedRows: generation.current_row_count,
    publishedAt: generation.published_at,
    reconciledAt: nowSec,
  });
  const idempotencyKey = [
    "scheduled-slot-published-terminal-missing",
    slot.slot_key,
    slot.slot_started_at,
    progress.job,
    generation.generation_id,
  ].join(":");
  const evidencePredicate = buildReconciliationEvidencePredicate(
    progress.job,
    slot.slot_started_at,
    progress,
    evidence,
  );
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE cron_runs
            SET status = 'degraded',
                error = NULL,
                item_count = ?,
                metadata = ?,
                idempotency_key = ?,
                productive = 1,
                publication_count = 1
          WHERE id = ?
            AND job = ?
            AND slot_started_at = ?
            AND ${scheduledSlotFencePredicate()}
            ${evidencePredicate.sql}`,
      )
      .bind(
        generation.current_row_count,
        metadata,
        idempotencyKey,
        terminalRun.id,
        progress.job,
        slot.slot_started_at,
        ...scheduledSlotFenceBinds(reconciliationFence),
        ...evidencePredicate.binds,
      )
      .run(),
  );
  if ((result.meta.changes ?? 0) !== 1) {
    const exactCorrection = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT 1 AS corrected
             FROM cron_runs
            WHERE id = ?
              AND job = ?
              AND slot_started_at = ?
              AND status = 'degraded'
              AND error IS NULL
              AND item_count IS ?
              AND metadata = ?
              AND idempotency_key = ?
              AND productive = 1
              AND publication_count = 1
            LIMIT 1`,
        )
        .bind(
          terminalRun.id,
          progress.job,
          slot.slot_started_at,
          generation.current_row_count,
          metadata,
          idempotencyKey,
        )
        .first<{ corrected: number }>(),
    );
    if (!exactCorrection) {
      await assertScheduledSlotReconciliationFence(db, reconciliationFence);
      await assertReconciliationEvidenceUnchanged(db, progress.job, slot.slot_started_at, progress, evidence);
      throw new Error(`synthetic terminal correction CAS lost for ${progress.job}@${slot.slot_started_at}`);
    }
  }

  const descriptor = getScheduledTaskDescriptor(slot.slot_key as CronScheduleKey, progress.job);
  const invocationId = slot.invocation_id ?? `platform-abandoned:${slot.execution_owner}`;
  await recordProducerOutcome(db, {
    scheduleKey: slot.slot_key,
    job: progress.job,
    producerPath: descriptor.producerPath,
    producerKind: "scheduled-job",
    invocationId,
    workerVersion: slot.worker_version ?? null,
    slotStartedAt: slot.slot_started_at,
    idempotencyKey,
    invokedAt: startedAt,
    completedAt: nowSec,
    outcome: "degraded",
    itemCount: generation.current_row_count,
    metadata,
    productivity: {
      productive: true,
      reason: "published-terminal-accounting-recovered",
      publications: [
        {
          surface: "dex-liquidity",
          generationId: generation.generation_id,
          publishedAt: generation.published_at!,
          candidateRows: generation.written_row_count,
          publishedRows: generation.current_row_count,
          expectedRows: generation.expected_row_count,
        },
      ],
    },
    writeFence: reconciliationFence,
  });
}

async function correctSyntheticNotStartedTerminalForProgress(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  progress: StaleSlotProgressRow,
  terminalRun: StaleSlotTerminalRunRow,
  lease: StaleSlotLeaseRow | null,
  disposition: "publication_failure" | "terminal_accounting_unknown",
  generation: DexPublicationGenerationRow | null,
  nowSec: number,
  reconciliationFence: ScheduledSlotReconciliationFence,
  evidence: ReconciliationEvidence,
): Promise<void> {
  const startedAt = progress.started_at || slot.started_at || slot.slot_started_at;
  const durationMs = Math.max(0, nowSec - startedAt) * 1000;
  const error = "scheduled slot heartbeat stale; child job progress abandoned";
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: disposition === "publication_failure" ? "publication-failure" : "terminal-accounting-unknown",
    childDisposition: disposition,
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    progressStage: progress.stage,
    progressUpdatedAt: progress.updated_at,
    leaseOwner: progress.lease_owner,
    leaseUntil: lease?.lease_until ?? null,
    generationId: generation?.generation_id ?? null,
    generationState: generation?.state ?? null,
    expectedRows: generation?.expected_row_count ?? null,
    writtenRows: generation?.written_row_count ?? null,
    publishedRows: generation?.current_row_count ?? null,
    reconciledAt: nowSec,
  });
  const idempotencyKey = ["scheduled-slot-stale", slot.slot_key, slot.slot_started_at, progress.job, startedAt].join(
    ":",
  );
  const evidencePredicate = buildReconciliationEvidencePredicate(
    progress.job,
    slot.slot_started_at,
    progress,
    evidence,
  );
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE cron_runs
            SET started_at = ?,
                duration_ms = ?,
                status = 'error',
                error = ?,
                item_count = NULL,
                metadata = ?,
                idempotency_key = ?,
                productive = 0,
                publication_count = 0
          WHERE id = ?
            AND job = ?
            AND slot_started_at = ?
            AND ${scheduledSlotFencePredicate()}
            ${evidencePredicate.sql}`,
      )
      .bind(
        startedAt,
        durationMs,
        error,
        metadata,
        idempotencyKey,
        terminalRun.id,
        progress.job,
        slot.slot_started_at,
        ...scheduledSlotFenceBinds(reconciliationFence),
        ...evidencePredicate.binds,
      )
      .run(),
  );
  if ((result.meta.changes ?? 0) !== 1) {
    const exactCorrection = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT 1 AS corrected
             FROM cron_runs
            WHERE id = ?
              AND job = ?
              AND slot_started_at = ?
              AND started_at = ?
              AND duration_ms = ?
              AND status = 'error'
              AND error = ?
              AND item_count IS NULL
              AND metadata = ?
              AND idempotency_key = ?
              AND productive = 0
              AND publication_count = 0
            LIMIT 1`,
        )
        .bind(
          terminalRun.id,
          progress.job,
          slot.slot_started_at,
          startedAt,
          durationMs,
          error,
          metadata,
          idempotencyKey,
        )
        .first<{ corrected: number }>(),
    );
    if (!exactCorrection) {
      await assertScheduledSlotReconciliationFence(db, reconciliationFence);
      await assertReconciliationEvidenceUnchanged(db, progress.job, slot.slot_started_at, progress, evidence);
      throw new Error(`synthetic not-started correction CAS lost for ${progress.job}@${slot.slot_started_at}`);
    }
  }

  const descriptor = getScheduledTaskDescriptor(slot.slot_key as CronScheduleKey, progress.job);
  const invocationId = slot.invocation_id ?? `platform-abandoned:${slot.execution_owner}`;
  await recordProducerOutcome(db, {
    scheduleKey: slot.slot_key,
    job: progress.job,
    producerPath: descriptor.producerPath,
    producerKind: "scheduled-job",
    invocationId,
    workerVersion: slot.worker_version ?? null,
    slotStartedAt: slot.slot_started_at,
    idempotencyKey,
    invokedAt: startedAt,
    completedAt: nowSec,
    outcome: "abandoned",
    itemCount: null,
    metadata,
    error,
    productivity: { productive: false, reason: "platform-abandoned" },
    writeFence: reconciliationFence,
  });
}

async function insertSyntheticNotStartedCronRun(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  job: string,
  nowSec: number,
  reconciliationFence: ScheduledSlotReconciliationFence,
  evidence: ReconciliationEvidence,
): Promise<boolean> {
  const idempotencyKey = ["scheduled-slot-not-started", slot.slot_key, slot.slot_started_at, job].join(":");
  const descriptor = getScheduledTaskDescriptor(slot.slot_key as CronScheduleKey, job);
  const invocationId = slot.invocation_id ?? `platform-abandoned:${slot.execution_owner}`;
  if (
    !(await canPersistSyntheticProducerOutcome(db, {
      scheduleKey: slot.slot_key,
      job,
      producerPath: descriptor.producerPath,
      invocationId,
      idempotencyKey,
    }))
  ) {
    return false;
  }
  const error = "scheduled slot abandoned before child job started";
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: "platform-abandoned",
    childDisposition: "not_started",
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    reconciledAt: nowSec,
  });
  const evidencePredicate = buildReconciliationEvidencePredicate(job, slot.slot_started_at, null, evidence);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, error, item_count, metadata, slot_started_at, idempotency_key,
            schedule_key, producer_path, producer_kind, invocation_id, worker_version,
            productive, publication_count, calendar_period)
         SELECT ?, ?, 0, 'error', ?, 0, ?, ?, ?, ?, ?, 'scheduled-job', ?, ?, 0, 0, NULL
          WHERE ${scheduledSlotFencePredicate()}
            ${evidencePredicate.sql}
            AND NOT EXISTS (
            SELECT 1 FROM cron_runs WHERE job = ? AND slot_started_at = ?
          )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        job,
        nowSec,
        error,
        metadata,
        slot.slot_started_at,
        idempotencyKey,
        slot.slot_key,
        descriptor.producerPath,
        invocationId,
        slot.worker_version ?? null,
        ...scheduledSlotFenceBinds(reconciliationFence),
        ...evidencePredicate.binds,
        job,
        slot.slot_started_at,
      )
      .run(),
  );
  const inserted = (result.meta.changes ?? 0) === 1;
  if (!inserted && !(await hasCronRunWithIdempotencyKey(db, job, slot.slot_started_at, idempotencyKey))) {
    await assertScheduledSlotReconciliationFence(db, reconciliationFence);
    await assertReconciliationEvidenceUnchanged(db, job, slot.slot_started_at, null, evidence);
    return false;
  }
  await assertScheduledSlotReconciliationFence(db, reconciliationFence);
  await recordProducerOutcome(db, {
    scheduleKey: slot.slot_key,
    job,
    producerPath: descriptor.producerPath,
    producerKind: "scheduled-job",
    invocationId,
    workerVersion: slot.worker_version ?? null,
    slotStartedAt: slot.slot_started_at,
    idempotencyKey,
    invokedAt: nowSec,
    completedAt: nowSec,
    outcome: "not_started",
    itemCount: 0,
    metadata,
    error,
    productivity: { productive: false, reason: "platform-abandoned-before-start" },
    writeFence: reconciliationFence,
  });
  return inserted;
}

async function deleteReconciledProgressRow(
  db: D1Database,
  progress: StaleSlotProgressRow,
  slotStartedAt: number,
  reconciliationFence: ScheduledSlotReconciliationFence,
  evidence: ReconciliationEvidence,
): Promise<number> {
  const evidencePredicate = buildReconciliationEvidencePredicate(progress.job, slotStartedAt, progress, evidence);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM cron_run_progress
        WHERE job = ?
          AND slot_started_at = ?
          AND started_at = ?
          AND updated_at = ?
          AND stage IS ?
          AND lease_owner IS ?
          AND metadata IS ?
          AND ${scheduledSlotFencePredicate()}
          ${evidencePredicate.sql}`,
      )
      .bind(
        progress.job,
        slotStartedAt,
        progress.started_at,
        progress.updated_at,
        progress.stage,
        progress.lease_owner,
        progress.metadata,
        ...scheduledSlotFenceBinds(reconciliationFence),
        ...evidencePredicate.binds,
      )
      .run(),
  );
  if ((result.meta.changes ?? 0) === 1) return 1;
  await assertScheduledSlotReconciliationFence(db, reconciliationFence);
  const current = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT started_at, updated_at, stage, lease_owner, metadata
         FROM cron_run_progress
        WHERE job = ? AND slot_started_at = ?
        LIMIT 1`,
      )
      .bind(progress.job, slotStartedAt)
      .first<{
        started_at: number;
        updated_at: number;
        stage: string | null;
        lease_owner: string | null;
        metadata: string | null;
      }>(),
  );
  if (!current) return 1;
  await assertReconciliationEvidenceUnchanged(db, progress.job, slotStartedAt, progress, evidence);
  throw new Error(`cron progress changed during reconciliation for ${progress.job}@${slotStartedAt}`);
}

async function reconcileStaleSlotArtifacts(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  nowSec: number,
  reconciliationFence: ScheduledSlotReconciliationFence,
): Promise<StaleSlotReconciliationSummary> {
  const summary: StaleSlotReconciliationSummary = {
    syntheticCronRuns: 0,
    jobAttemptsAbandoned: 0,
    jobAttemptsTerminalized: 0,
    progressRowsCleared: 0,
    leasesCleared: 0,
    recoveryCheckpointsPrepared: 0,
    notStartedCronRuns: 0,
    successfulChildTerminals: 0,
    skippedLockedChildTerminals: 0,
    derivedPublishedChildTerminals: 0,
    publicationFailures: 0,
    terminalAccountingUnknown: 0,
    realChildFailures: 0,
    abandonedJobs: [],
  };
  const expectedJobs = getExpectedJobsForScheduledSlot(slot.slot_key);
  const progressRows = await listProgressRowsForStaleSlot(db, slot.slot_started_at, expectedJobs);
  const progressRowsToReconcile = [...progressRows];
  const progressJobs = new Set(progressRows.map((progress) => progress.job));
  const noProgressJobs = expectedJobs.filter((job) => !progressJobs.has(job));
  for (const job of noProgressJobs) {
    let reconciled = false;
    for (let evidenceAttempt = 0; evidenceAttempt < 3; evidenceAttempt++) {
      const summaryBeforeAttempt = { ...summary };
      const appearedProgress = await getProgressRowForScheduledSlotJob(db, job, slot.slot_started_at);
      if (appearedProgress) {
        progressRowsToReconcile.push(appearedProgress);
        reconciled = true;
        break;
      }
      const terminalRun = await getTerminalCronRunForSlot(db, job, slot.slot_started_at);
      const evidence: ReconciliationEvidence = { terminalRun, generation: null };
      const disposition = terminalRun
        ? (syntheticDispositionForTerminalRun(terminalRun) ?? dispositionForTerminalStatus(terminalRun.status))
        : "not_started";
      const attemptOutcome = terminalRun
        ? terminalOutcomeForRun(terminalRun, disposition)
        : ({ state: "abandoned", statusClass: "abandoned", error: STALE_SLOT_ERROR, itemCount: 0 } as const);
      try {
        const terminalization = await terminalizeWorkerJobAttemptsForKnownOutcome(db, {
          slot,
          job,
          nowSec,
          outcome: attemptOutcome,
          reconciliationFence,
          progress: null,
          evidence,
          metadata: {
            reason: "stale-slot-reconciled",
            reconciliationSource: terminalRun ? "existing-terminal-run" : "slot-no-progress-sweep",
            childDisposition: disposition,
            slotKey: slot.slot_key,
            slotStartedAt: slot.slot_started_at,
            ...(terminalRun ? {} : { slotOwner: slot.execution_owner }),
            reconciledAt: nowSec,
          },
        });
        summary.jobAttemptsTerminalized += terminalization.attemptsTerminalized;
        summary.leasesCleared += terminalization.leasesCleared;
        if (attemptOutcome.state === "abandoned") {
          summary.jobAttemptsAbandoned += terminalization.attemptsTerminalized;
        }
        let insertedNotStarted = false;
        if (terminalRun) {
          const syntheticNotStartedKey = ["scheduled-slot-not-started", slot.slot_key, slot.slot_started_at, job].join(
            ":",
          );
          if (terminalRun.idempotency_key === syntheticNotStartedKey) {
            await insertSyntheticNotStartedCronRun(db, slot, job, nowSec, reconciliationFence, evidence);
          }
        } else {
          insertedNotStarted = await insertSyntheticNotStartedCronRun(
            db,
            slot,
            job,
            nowSec,
            reconciliationFence,
            evidence,
          );
        }
        const progressAfterTerminalWrite = await getProgressRowForScheduledSlotJob(db, job, slot.slot_started_at);
        if (progressAfterTerminalWrite) {
          Object.assign(summary, summaryBeforeAttempt);
          if (insertedNotStarted) summary.syntheticCronRuns++;
          progressRowsToReconcile.push(progressAfterTerminalWrite);
          reconciled = true;
          break;
        }
        if (terminalRun) {
          recordDisposition(summary, disposition);
        } else if (insertedNotStarted) {
          summary.notStartedCronRuns++;
          summary.syntheticCronRuns++;
        }
        reconciled = true;
        break;
      } catch (err) {
        if (err instanceof ReconciliationEvidenceChangedError) {
          Object.assign(summary, summaryBeforeAttempt);
          continue;
        }
        throw err;
      }
    }
    if (!reconciled) {
      throw new Error(`reconciliation evidence did not stabilize for ${job}@${slot.slot_started_at}`);
    }
  }

  for (const progress of progressRowsToReconcile) {
    const lease = await getCronLeaseForJob(db, progress.job);
    const matchingLease = lease && lease.lease_owner === progress.lease_owner ? lease : null;
    if (matchingLease && matchingLease.lease_until >= nowSec) {
      throw new Error(`active child lease renewed during reconciliation for ${progress.job}@${slot.slot_started_at}`);
    }

    let disposition: StaleSlotChildDisposition | null = null;
    let progressReconciled = false;
    for (let evidenceAttempt = 0; evidenceAttempt < 3; evidenceAttempt++) {
      const summaryBeforeAttempt = { ...summary };
      const terminalRun = await getTerminalCronRunForSlot(db, progress.job, slot.slot_started_at);
      const generationEvidence = await loadDexPublicationGeneration(db, progress);
      const evidence: ReconciliationEvidence = { terminalRun, generation: generationEvidence };
      try {
        if (terminalRun) {
          const syntheticDisposition = syntheticDispositionForTerminalRun(terminalRun);
          const completePublishedGeneration =
            !isAmbiguousGenerationEvidence(generationEvidence) &&
            generationEvidence != null &&
            isCompletePublishedGeneration(generationEvidence)
              ? generationEvidence
              : null;
          if (
            completePublishedGeneration &&
            (syntheticDisposition === "publication_failure" ||
              syntheticDisposition === "terminal_accounting_unknown" ||
              syntheticDisposition === "not_started")
          ) {
            await correctSyntheticTerminalForPublishedGeneration(
              db,
              slot,
              progress,
              terminalRun,
              completePublishedGeneration,
              nowSec,
              reconciliationFence,
              evidence,
            );
            throw new ReconciliationEvidenceChangedError(progress.job, slot.slot_started_at);
          }
          if (syntheticDisposition === "not_started") {
            const reachedPublication = progress.stage?.startsWith("persistence") === true;
            const publicationFailed =
              progress.job === "sync-dex-liquidity" &&
              reachedPublication &&
              !isAmbiguousGenerationEvidence(generationEvidence);
            const correctedDisposition = publicationFailed ? "publication_failure" : "terminal_accounting_unknown";
            await correctSyntheticNotStartedTerminalForProgress(
              db,
              slot,
              progress,
              terminalRun,
              matchingLease,
              correctedDisposition,
              isAmbiguousGenerationEvidence(generationEvidence) ? null : generationEvidence,
              nowSec,
              reconciliationFence,
              evidence,
            );
            throw new ReconciliationEvidenceChangedError(progress.job, slot.slot_started_at);
          }
          disposition = syntheticDisposition ?? dispositionForTerminalStatus(terminalRun.status);
          const attemptOutcome = terminalOutcomeForRun(terminalRun, disposition);
          const terminalization = await terminalizeWorkerJobAttemptsForKnownOutcome(db, {
            slot,
            job: progress.job,
            nowSec,
            outcome: attemptOutcome,
            expectedOwner: progress.lease_owner,
            expectedExpiredLease: matchingLease ?? undefined,
            reconciliationFence,
            progress,
            evidence,
            metadata: {
              reason: "stale-slot-reconciled",
              reconciliationSource: "existing-terminal-run",
              childDisposition: disposition,
              slotKey: slot.slot_key,
              slotStartedAt: slot.slot_started_at,
              reconciledAt: nowSec,
            },
          });
          summary.jobAttemptsTerminalized += terminalization.attemptsTerminalized;
          summary.leasesCleared += terminalization.leasesCleared;
          if (attemptOutcome.state === "abandoned") {
            summary.jobAttemptsAbandoned += terminalization.attemptsTerminalized;
          }
          recordDisposition(summary, disposition);
          if (syntheticDisposition === "published_terminal_missing") {
            if (
              !isAmbiguousGenerationEvidence(generationEvidence) &&
              generationEvidence &&
              isCompletePublishedGeneration(generationEvidence)
            ) {
              await insertSyntheticPublishedCronRun(
                db,
                slot,
                progress,
                generationEvidence,
                nowSec,
                reconciliationFence,
                evidence,
              );
            }
          } else if (
            syntheticDisposition === "publication_failure" ||
            syntheticDisposition === "terminal_accounting_unknown"
          ) {
            await insertSyntheticStaleCronRun(
              db,
              slot,
              progress,
              matchingLease,
              nowSec,
              syntheticDisposition,
              isAmbiguousGenerationEvidence(generationEvidence) ? null : generationEvidence,
              reconciliationFence,
              evidence,
            );
          }
        } else if (
          !isAmbiguousGenerationEvidence(generationEvidence) &&
          generationEvidence &&
          isCompletePublishedGeneration(generationEvidence)
        ) {
          disposition = "published_terminal_missing";
          const terminalization = await terminalizeWorkerJobAttemptsForKnownOutcome(db, {
            slot,
            job: progress.job,
            nowSec,
            outcome: {
              state: "completed",
              statusClass: "degraded",
              error: null,
              itemCount: generationEvidence.current_row_count,
            },
            expectedOwner: progress.lease_owner,
            expectedExpiredLease: matchingLease ?? undefined,
            reconciliationFence,
            progress,
            evidence,
            metadata: {
              reason: "stale-slot-reconciled",
              childDisposition: disposition,
              generationId: generationEvidence.generation_id,
              reconciledAt: nowSec,
            },
          });
          summary.jobAttemptsTerminalized += terminalization.attemptsTerminalized;
          summary.leasesCleared += terminalization.leasesCleared;
          recordDisposition(summary, disposition);
          if (
            await insertSyntheticPublishedCronRun(
              db,
              slot,
              progress,
              generationEvidence,
              nowSec,
              reconciliationFence,
              evidence,
            )
          ) {
            summary.syntheticCronRuns++;
          }
        } else {
          const reachedPublication = progress.stage?.startsWith("persistence") === true;
          const publicationFailed =
            progress.job === "sync-dex-liquidity" &&
            reachedPublication &&
            !isAmbiguousGenerationEvidence(generationEvidence);
          disposition = publicationFailed ? "publication_failure" : "terminal_accounting_unknown";
          const terminalization = await terminalizeWorkerJobAttemptsForKnownOutcome(db, {
            slot,
            job: progress.job,
            nowSec,
            outcome: { state: "abandoned", statusClass: "abandoned", error: STALE_SLOT_ERROR, itemCount: null },
            expectedOwner: progress.lease_owner,
            expectedExpiredLease: matchingLease ?? undefined,
            reconciliationFence,
            progress,
            evidence,
            metadata: {
              reason: "stale-slot-reconciled",
              childDisposition: disposition,
              slotKey: slot.slot_key,
              slotStartedAt: slot.slot_started_at,
              slotOwner: slot.execution_owner,
              progressStage: progress.stage,
              progressUpdatedAt: progress.updated_at,
              leaseOwner: progress.lease_owner,
              leaseUntil: matchingLease?.lease_until ?? null,
              reconciledAt: nowSec,
            },
          });
          summary.jobAttemptsAbandoned += terminalization.attemptsTerminalized;
          summary.jobAttemptsTerminalized += terminalization.attemptsTerminalized;
          summary.leasesCleared += terminalization.leasesCleared;
          recordDisposition(summary, disposition);
          if (
            await insertSyntheticStaleCronRun(
              db,
              slot,
              progress,
              matchingLease,
              nowSec,
              disposition,
              isAmbiguousGenerationEvidence(generationEvidence) ? null : generationEvidence,
              reconciliationFence,
              evidence,
            )
          ) {
            summary.syntheticCronRuns++;
          }
        }
        const cleanupEvidence: ReconciliationEvidence = {
          terminalRun: await getTerminalCronRunForSlot(db, progress.job, slot.slot_started_at),
          generation: await loadDexPublicationGeneration(db, progress),
        };
        const terminalStable = terminalRun
          ? evidenceFingerprint({ terminalRun, generation: null }) ===
            evidenceFingerprint({ terminalRun: cleanupEvidence.terminalRun, generation: null })
          : cleanupEvidence.terminalRun != null &&
            syntheticDispositionForTerminalRun(cleanupEvidence.terminalRun) === disposition;
        const generationStable =
          evidenceFingerprint({ terminalRun: null, generation: generationEvidence }) ===
          evidenceFingerprint({ terminalRun: null, generation: cleanupEvidence.generation });
        if (!terminalStable || !generationStable) {
          throw new ReconciliationEvidenceChangedError(progress.job, slot.slot_started_at);
        }
        summary.progressRowsCleared += await deleteReconciledProgressRow(
          db,
          progress,
          slot.slot_started_at,
          reconciliationFence,
          cleanupEvidence,
        );
        progressReconciled = true;
        break;
      } catch (err) {
        if (err instanceof ReconciliationEvidenceChangedError) {
          Object.assign(summary, summaryBeforeAttempt);
          continue;
        }
        throw err;
      }
    }
    if (!progressReconciled || disposition == null) {
      throw new Error(`reconciliation evidence did not stabilize for ${progress.job}@${slot.slot_started_at}`);
    }
    summary.abandonedJobs.push({
      job: progress.job,
      disposition,
      progressStage: progress.stage,
      progressUpdatedAt: progress.updated_at,
      leaseOwner: progress.lease_owner || null,
      leaseUntil: matchingLease?.lease_until ?? null,
    });
  }

  return summary;
}

async function writeStaleSlotEventMarker(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  nowSec: number,
  reconciliation: StaleSlotReconciliationSummary,
  reconciliationFence: ScheduledSlotReconciliationFence,
): Promise<void> {
  const record = {
    event: "cron_event",
    job: slot.slot_key,
    eventType: STALE_SLOT_ABANDONED_EVENT_TYPE,
    severity: "error",
    message: `Scheduled slot ${slot.slot_key}@${slot.slot_started_at} stopped heartbeating and was reconciled as abandoned.`,
    metadata: {
      slotKey: slot.slot_key,
      slotStartedAt: slot.slot_started_at,
      slotOwner: slot.execution_owner,
      slotStartedAtActual: slot.started_at,
      slotUpdatedAt: slot.updated_at,
      reconciledAt: nowSec,
      staleSlotReconciliation: reconciliation,
    },
    recordedAt: nowSec,
  };
  try {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `INSERT INTO cache (key, value, updated_at)
           SELECT ?, ?, ?
            WHERE ${scheduledSlotFencePredicate()}
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .bind(
          staleSlotEventCacheKey(slot.slot_key),
          JSON.stringify(record),
          nowSec,
          ...scheduledSlotFenceBinds(reconciliationFence),
        )
        .run(),
    );
    if ((result.meta.changes ?? 0) !== 1) {
      await assertScheduledSlotReconciliationFence(db, reconciliationFence);
      throw new Error(`stale slot event marker CAS lost for ${slot.slot_key}@${slot.slot_started_at}`);
    }
    console.error(`[cron-event:${slot.slot_key}] ${STALE_SLOT_ABANDONED_EVENT_TYPE}: ${record.message}`);
  } catch (err) {
    if (err instanceof ScheduledSlotReconciliationOwnershipLostError) throw err;
    console.warn(`[cron-slot] Failed to persist stale slot marker for ${slot.slot_key}@${slot.slot_started_at}:`, err);
  }
}

/** Reconcile durable child artifacts and record the corresponding operator event as one internal stage. */
export async function reconcileStaleSlotArtifactsAndRecordEvent(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  nowSec: number,
  reconciliationFence: ScheduledSlotReconciliationFence,
): Promise<StaleSlotReconciliationSummary> {
  const reconciliation = await reconcileStaleSlotArtifacts(db, slot, nowSec, reconciliationFence);
  await writeStaleSlotEventMarker(db, slot, nowSec, reconciliation, reconciliationFence);
  return reconciliation;
}
