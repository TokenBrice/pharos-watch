import type { CronResultStatus } from "@shared/types/status/cron";
import { resolveCronDegradedReason } from "../../lib/cron-logger";
import { CronChildTerminalSupersededError, writeScheduledChildTerminal } from "../../lib/scheduled-child-terminal";
import { projectChildDisposition } from "../../lib/cron-outcomes";
import { getRuntimeProducerIdentity, type ScheduledRuntimeContext } from "./context";

interface LogSkippedCronRunOptions {
  job: string;
  reason: string;
  message?: string;
  metadata?: Record<string, unknown>;
  status?: Extract<CronResultStatus, "ok" | "degraded" | "skipped_neutral">;
}

export async function logSkippedCronRun(
  runtime: ScheduledRuntimeContext,
  options: LogSkippedCronRunOptions,
): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const status = options.status ?? "degraded";
  if (!runtime.executionFence) throw new Error("Scheduled preflight terminal requires an execution fence");
  const metadataObject = {
    ...options.metadata,
    skippedReason: options.reason,
    reason: options.reason,
    message: options.message ?? null,
    slotStartedAt: runtime.slotStartedAt,
    scheduleKey: runtime.scheduleKey,
  };
  const metadata = JSON.stringify(metadataObject);
  const degradedReason = resolveCronDegradedReason(options.job, status, undefined, metadataObject);

  const producer = getRuntimeProducerIdentity(runtime, options.job);
  const terminal = await writeScheduledChildTerminal(runtime.db, {
    identity: {
      ...producer,
      slotStartedAt: runtime.slotStartedAt,
      attemptNo: runtime.jobAttemptNo ?? 1,
      executionFence: runtime.executionFence,
    },
    source: "preflight",
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    status,
    degradedReason,
    disposition: "not_started",
    producerOutcome: status === "skipped_neutral" ? "skipped_neutral" : projectChildDisposition("not_started").producerOutcome,
    itemCount: 0,
    metadata,
    error: status === "degraded" ? options.message ?? options.reason : null,
    productivity: { productive: false, reason: options.reason },
  });
  if (!terminal.accepted) {
    throw new CronChildTerminalSupersededError(terminal.attemptKey, undefined, null, false);
  }
}
