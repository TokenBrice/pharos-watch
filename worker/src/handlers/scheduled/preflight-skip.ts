import { runWithOverloadRetry } from "../../lib/cron-lease";
import type { ScheduledRuntimeContext } from "./context";

interface LogSkippedCronRunOptions {
  job: string;
  reason: string;
  message?: string;
  metadata?: Record<string, unknown>;
  status?: "ok" | "degraded";
}

export async function logSkippedCronRun(
  runtime: ScheduledRuntimeContext,
  options: LogSkippedCronRunOptions,
): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const status = options.status ?? "degraded";
  const metadata = JSON.stringify({
    ...options.metadata,
    skipped: options.reason,
    skippedReason: options.reason,
    message: options.message ?? null,
    slotStartedAt: runtime.slotStartedAt,
    scheduleKey: runtime.scheduleKey,
  });

  try {
    await runWithOverloadRetry(() =>
      runtime.db
        .prepare(
          `INSERT INTO cron_runs
             (job, started_at, duration_ms, status, item_count, metadata, slot_started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(options.job, startedAt, 0, status, 0, metadata, runtime.slotStartedAt)
        .run(),
    );
  } catch (err) {
    console.warn(`[cron] Failed to log skipped run for ${options.job}:`, err);
  }
}
