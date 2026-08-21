import { toErrorMessage } from "../../lib/error-utils";
// Digest trigger poll slot (every 5 minutes, cron "*/5 * * * *"):
//   If `digest:force-run-request` cache key is set, run daily-digest under
//   scheduled-event wall-clock (15 min). The `daily-digest` lease serializes
//   execution with the 08:05 UTC scheduled run; if the lease is held, we
//   preserve the flag for the next poll. Otherwise we clear the flag and
//   persist a `digest:last-trigger-result` key so the ops UI can report the
//   outcome of the most recent manual trigger.
//
// The manual trigger HTTP endpoint writes the flag synchronously and returns
// 202; this poll slot is the execution surface. See
// `2026-04-17-daily-digest-root-cause-and-fix-plan.md` for why HTTP
// `ctx.waitUntil` was abandoned.
import { buildTelegramCreds, buildTwitterCreds } from "../../lib/runtime-credentials";
import { drainTelegramDigestOutbox } from "../../lib/telegram-digest-outbox";
import { deleteCache, getCache, setCache } from "../../lib/db-cache";
import { DIGEST_FORCE_RUN_CACHE_KEY } from "../../api/admin-actions";
import {
  getRuntimeProducerIdentity,
  runRuntimeBudgetOnlyTask,
  type ScheduledRuntimeContext,
} from "./context";
import type { CronResult } from "../../lib/cron-logger";
import { recordBudgetSurfaceTelemetry, type BudgetSurfaceOutcome } from "../../lib/budget-surface-telemetry";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  buildScheduledSlotSummary,
  summarizeCronResult,
  summarizeSkippedScheduledJob,
  summarizeThrownScheduledJob,
} from "./slot-summary";

export const DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY = "digest:last-trigger-result";
const DIGEST_TRIGGER_POLL_SURFACE = "digest-trigger-poll";
const TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE = "telegram-digest-outbox-drain";

async function runTelegramDigestOutboxDrain(runtime: ScheduledRuntimeContext): Promise<void> {
  const startedMs = Date.now();
  const creds = buildTelegramCreds(runtime.env);
  if (!creds) {
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 0,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "missing-telegram-credentials",
      metadata: { telegramCredentialsConfigured: false },
      producer: getRuntimeProducerIdentity(runtime, TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE),
    });
    return;
  }
  try {
    const summary = await runRuntimeBudgetOnlyTask(
      runtime,
      TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE,
      (signal) => drainTelegramDigestOutbox(runtime.db, creds, { signal }),
    );
    const currentAttemptFailures = summary.pending
      + summary.executionUnknown
      + summary.failedPermanent;
    const unresolved = currentAttemptFailures
      + summary.retainedExecutionUnknown
      + summary.retainedFailedPermanent;
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: summary.due,
      processedCount: summary.sent,
      outcome: unresolved > 0 ? "degraded" : "ok",
      error: unresolved > 0
        ? `${summary.pending} retryable, ${summary.retainedExecutionUnknown} ambiguous, ${summary.retainedFailedPermanent} permanent`
        : null,
      metadata: { ...summary },
      producer: getRuntimeProducerIdentity(runtime, TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE),
    });
  } catch (err) {
    const error = toErrorMessage(err);
    logWorkerEvent({ scope: "handler", level: "error", event: "telegram_digest_outbox_drain_failed", message: "Telegram digest outbox drain failed", job: TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE, error: err });
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 0,
      processedCount: 0,
      outcome: "error",
      error,
      producer: getRuntimeProducerIdentity(runtime, TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE),
    });
  }
}

interface DigestForceRunRequest {
  requestedAt: number;
  requestId: string;
}

function parseForceRunPayload(value: string): DigestForceRunRequest | null {
  try {
    const parsed = JSON.parse(value) as { requestedAt?: unknown; requestId?: unknown };
    if (typeof parsed.requestedAt !== "number" || typeof parsed.requestId !== "string") {
      return null;
    }
    return { requestedAt: parsed.requestedAt, requestId: parsed.requestId };
  } catch {
    return null;
  }
}

export async function runDigestTriggerPollSlot(runtime: ScheduledRuntimeContext) {
  const startedMs = Date.now();
  await runTelegramDigestOutboxDrain(runtime);
  const pending = await getCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
  if (!pending) {
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: DIGEST_TRIGGER_POLL_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 0,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "no-pending-request",
      metadata: { pending: false },
      producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
    });
    return buildScheduledSlotSummary([
      summarizeSkippedScheduledJob("digest-trigger-poll", "no-pending-request", { neutral: true }),
    ], { budgetOnlyJobs: 2 });
  }

  const payload = parseForceRunPayload(pending.value);
  if (!payload) {
    logWorkerEvent({ scope: "handler", level: "warn", event: "digest_force_run_payload_malformed", message: "Malformed digest force-run payload; clearing", job: DIGEST_TRIGGER_POLL_SURFACE, metadata: { payloadPrefix: pending.value.slice(0, 200) } });
    await deleteCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: DIGEST_TRIGGER_POLL_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 1,
      processedCount: 1,
      outcome: "error",
      error: "malformed-payload",
      metadata: { pending: true, cleared: true },
      producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
    });
    return buildScheduledSlotSummary([
      summarizeSkippedScheduledJob("digest-trigger-poll", "malformed-payload"),
    ], { budgetOnlyJobs: 2 });
  }

  let result: CronResult | null = null;
  let caught: unknown = null;

  try {
    const { generateDailyDigest } = await import("../../cron/daily-digest");
    result = (await runtime.runLeasedCron("daily-digest", (signal, reportProgress) =>
      generateDailyDigest(
        runtime.db,
        runtime.env.ANTHROPIC_API_KEY ?? null,
        buildTwitterCreds(runtime.env),
        true,
        buildTelegramCreds(runtime.env),
        signal,
        reportProgress,
      ),
    )) ?? null;
  } catch (err) {
    caught = err;
    logWorkerEvent({ scope: "handler", level: "error", event: "digest_force_run_failed", message: "Forced daily digest failed", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId } });
  }

  const leaseLocked = result?.status === "skipped_locked";

  // Preserve the flag when the 08:05 scheduled run holds the lease so the next
  // poll can retry. Clear it on every other outcome (ok, degraded, error,
  // thrown exception) so persistent failures don't loop.
  if (!leaseLocked) {
    await deleteCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
  }

  // Surface the outcome for the ops UI. Use a short, bounded payload — we only
  // need enough for operators to see whether their trigger landed.
  const finishedAt = Math.floor(Date.now() / 1000);
  let outcome: "ok" | "degraded" | "error" | "skipped_locked" | "skipped" = "ok";
  let errorMessage: string | null = null;
  if (caught) {
    outcome = "error";
    errorMessage = toErrorMessage(caught);
  } else if (leaseLocked) {
    outcome = "skipped_locked";
  } else {
    const status = result?.status;
    if (status === "degraded" || status === "error") {
      outcome = status;
    } else if (status === "skipped_neutral") {
      outcome = "skipped";
    } else if (status === "skipped_locked") {
      outcome = "skipped_locked";
    } else if (typeof result?.metadata === "string"
      && result.metadata.startsWith("skipped:")) {
      outcome = "skipped";
    }
  }
  try {
    await setCache(
      runtime.db,
      DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY,
      JSON.stringify({
        requestId: payload.requestId,
        requestedAt: payload.requestedAt,
        finishedAt,
        outcome,
        error: errorMessage ? errorMessage.slice(0, 500) : null,
      }),
    );
  } catch (err) {
    logWorkerEvent({ scope: "handler", level: "warn", event: "digest_trigger_result_persistence_failed", message: "Failed to persist digest trigger result", job: DIGEST_TRIGGER_POLL_SURFACE, error: err });
  }

  const telemetryOutcome: BudgetSurfaceOutcome =
    outcome === "skipped_locked" || outcome === "skipped" ? "skipped" : outcome;
  await recordBudgetSurfaceTelemetry(runtime.db, {
    surface: DIGEST_TRIGGER_POLL_SURFACE,
    durationMs: Date.now() - startedMs,
    dueCount: 1,
    processedCount: leaseLocked ? 0 : 1,
    outcome: telemetryOutcome,
    skippedReason: outcome === "skipped_locked"
      ? "daily-digest-lease-locked"
      : outcome === "skipped"
        ? "daily-digest-skipped"
        : null,
    error: errorMessage,
    metadata: {
      pending: true,
      requestId: payload.requestId,
      requestedAt: payload.requestedAt,
      dailyDigestOutcome: outcome,
      flagCleared: !leaseLocked,
    },
    producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
  });

  // Do not re-throw: logCronRun (inside runLeasedCron) already wrote the
  // error row to cron_runs. Swallowing matches the five-minute-telegram slot
  // pattern and keeps the scheduled slot fence clean.
  return buildScheduledSlotSummary([
    caught
      ? summarizeThrownScheduledJob("daily-digest", caught)
      : summarizeCronResult("daily-digest", result),
  ], { budgetOnlyJobs: 2 });
}
