import { runWithOverloadRetry } from "../../lib/cron-lease";
import { recordProducerOutcome } from "../../lib/producer-history";
import { getRuntimeProducerIdentity, type ScheduledRuntimeContext } from "./context";

interface LogSkippedCronRunOptions {
  job: string;
  reason: string;
  message?: string;
  metadata?: Record<string, unknown>;
  status?: "ok" | "degraded" | "skipped_neutral";
}

export async function logSkippedCronRun(
  runtime: ScheduledRuntimeContext,
  options: LogSkippedCronRunOptions,
): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const status = options.status ?? "degraded";
  const idempotencyKey = [
    "scheduled-preflight",
    runtime.scheduleKey,
    runtime.slotStartedAt,
    options.job,
    options.reason,
  ].join(":");
  const metadata = JSON.stringify({
    ...options.metadata,
    skippedReason: options.reason,
    message: options.message ?? null,
    slotStartedAt: runtime.slotStartedAt,
    scheduleKey: runtime.scheduleKey,
  });

  const producer = getRuntimeProducerIdentity(runtime, options.job);
  await runWithOverloadRetry(() =>
    runtime.db
      .prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, item_count, metadata, slot_started_at, idempotency_key,
            schedule_key, producer_path, producer_kind, invocation_id, worker_version,
            productive, publication_count, calendar_period)
         VALUES (?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        options.job,
        startedAt,
        status,
        metadata,
        runtime.slotStartedAt,
        idempotencyKey,
        producer.scheduleKey,
        producer.producerPath,
        producer.producerKind,
        producer.invocationId,
        producer.workerVersion ?? null,
        producer.calendarPeriod ?? null,
      )
      .run(),
  );
  await recordProducerOutcome(runtime.db, {
    ...producer,
    idempotencyKey,
    invokedAt: startedAt,
    completedAt: startedAt,
    outcome: status === "skipped_neutral" ? "skipped_neutral" : "not_started",
    itemCount: 0,
    metadata,
    error: status === "degraded" ? options.message ?? options.reason : null,
    productivity: { productive: false, reason: options.reason },
  });
}
