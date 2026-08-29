import { toErrorMessage } from "@shared/lib/error-utils";
// Digest trigger poll slot (every 5 minutes, cron "*/5 * * * *"):
//   If `digest:force-run-request` cache key is set, run daily-digest under
//   scheduled-event wall-clock (15 min). The `daily-digest` lease serializes
//   execution with the 08:05 UTC scheduled run; if the lease is held, we
//   preserve the intent for the next poll. Transient failures retain the
//   bounded intent with backoff, while permanent or exhausted failures remain
//   as dead letters for operator inspection. Success clears the intent and
//   persists a `digest:last-trigger-result` key.
//
// The manual trigger HTTP endpoint writes the intent synchronously and returns
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
export const MAX_ATTEMPTS = 3;
export const DIGEST_TRIGGER_POLL_INTERVAL_SECONDS = 5 * 60;

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

type DigestForceRunState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed_transient"
  | "dead_letter";

interface DigestForceRunRequest {
  requestedAt: number;
  requestId: string;
  attempts: number;
  nextAttemptAt: number;
  state: DigestForceRunState;
  lastError: string | null;
}

function isDigestForceRunState(value: unknown): value is DigestForceRunState {
  return value === "pending"
    || value === "running"
    || value === "succeeded"
    || value === "failed_transient"
    || value === "dead_letter";
}

function parseForceRunPayload(value: string): DigestForceRunRequest | null {
  try {
    const parsed = JSON.parse(value) as {
      requestedAt?: unknown;
      requestId?: unknown;
      attempts?: unknown;
      nextAttemptAt?: unknown;
      state?: unknown;
      lastError?: unknown;
    };
    if (typeof parsed.requestedAt !== "number"
      || !Number.isFinite(parsed.requestedAt)
      || typeof parsed.requestId !== "string"
      || parsed.requestId.length === 0) {
      return null;
    }
    if (parsed.attempts == null && parsed.nextAttemptAt == null && parsed.state == null && parsed.lastError == null) {
      return {
        requestedAt: parsed.requestedAt,
        requestId: parsed.requestId,
        attempts: 0,
        nextAttemptAt: parsed.requestedAt,
        state: "pending",
        lastError: null,
      };
    }
    if (typeof parsed.attempts !== "number"
      || !Number.isInteger(parsed.attempts)
      || parsed.attempts < 0
      || parsed.attempts > MAX_ATTEMPTS
      || typeof parsed.nextAttemptAt !== "number"
      || !Number.isFinite(parsed.nextAttemptAt)
      || !isDigestForceRunState(parsed.state)
      || (parsed.lastError !== null && typeof parsed.lastError !== "string")) {
      return null;
    }
    return {
      requestedAt: parsed.requestedAt,
      requestId: parsed.requestId,
      attempts: parsed.attempts,
      nextAttemptAt: parsed.nextAttemptAt,
      state: parsed.state,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    };
  } catch {
    return null;
  }
}

function boundedErrorMessage(value: string): string {
  return value.slice(0, 500);
}

function classifyFailure(errorMessage: string): "permanent" | "transient" {
  const normalized = errorMessage.toLowerCase();
  if (/\b(?:5\d\d|5xx|429|d1|database|network|timeout|timed out|overload|rate[- ]limit|rate-limited|circuit open|unavailable|fetch failed)\b/u.test(normalized)) {
    return "transient";
  }
  if (/\b(?:validation|invalid|quality[- ]gate|unauthorized|forbidden|authorization|authentication|auth|permission denied|api key|bad request|4\d\d)\b/u.test(normalized)) {
    return "permanent";
  }
  return "transient";
}

function resultFailureMessage(result: CronResult | null): string {
  if (typeof result?.metadata === "string" && result.metadata.length > 0) {
    return result.metadata;
  }
  return `daily-digest returned status ${result?.status ?? "unknown"}`;
}

function isFailureResult(result: CronResult | null): boolean {
  if (result?.status === "degraded" || result?.status === "error") return true;
  return typeof result?.metadata === "string" && result.metadata.startsWith("skipped:");
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
    const malformedPayload: DigestForceRunRequest = {
      requestedAt: Math.floor(Date.now() / 1000),
      requestId: "malformed-digest-request",
      attempts: 0,
      nextAttemptAt: Math.floor(Date.now() / 1000),
      state: "dead_letter",
      lastError: "malformed-payload",
    };
    logWorkerEvent({ scope: "handler", level: "warn", event: "digest_force_run_payload_malformed", message: "Malformed digest force-run payload; retaining as dead letter", job: DIGEST_TRIGGER_POLL_SURFACE, metadata: { payloadPrefix: pending.value.slice(0, 200) } });
    await setCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY, JSON.stringify(malformedPayload));
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: DIGEST_TRIGGER_POLL_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 1,
      processedCount: 1,
      outcome: "error",
      error: "malformed-payload",
      metadata: { pending: true, deadLettered: true },
      producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
    });
    return buildScheduledSlotSummary([
      summarizeSkippedScheduledJob("digest-trigger-poll", "malformed-payload"),
    ], { budgetOnlyJobs: 2 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.state === "succeeded" || payload.state === "dead_letter") {
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: DIGEST_TRIGGER_POLL_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 0,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: payload.state === "dead_letter" ? "dead-letter" : "already-succeeded",
      metadata: {
        pending: true,
        requestId: payload.requestId,
        state: payload.state,
        attempts: payload.attempts,
      },
      producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
    });
    return buildScheduledSlotSummary([
      summarizeSkippedScheduledJob(
        "digest-trigger-poll",
        payload.state === "dead_letter" ? "dead-letter" : "already-succeeded",
      ),
    ], { budgetOnlyJobs: 2 });
  }
  if (payload.nextAttemptAt > now) {
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: DIGEST_TRIGGER_POLL_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 0,
      processedCount: 0,
      outcome: "skipped",
      skippedReason: "retry-not-due",
      metadata: {
        pending: true,
        requestId: payload.requestId,
        state: payload.state,
        attempts: payload.attempts,
        nextAttemptAt: payload.nextAttemptAt,
      },
      producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
    });
    return buildScheduledSlotSummary([
      summarizeSkippedScheduledJob("digest-trigger-poll", "retry-not-due"),
    ], { budgetOnlyJobs: 2 });
  }

  let result: CronResult | null = null;
  let caught: unknown = null;

  try {
    const { generateDailyDigest } = await import("../../cron/daily-digest");
    result = (await runtime.runLeasedCron("daily-digest", async (signal, reportProgress) => {
      try {
        await setCache(
          runtime.db,
          DIGEST_FORCE_RUN_CACHE_KEY,
          JSON.stringify({ ...payload, state: "running" }),
        );
      } catch (err) {
        logWorkerEvent({ scope: "handler", level: "warn", event: "digest_force_run_running_state_persistence_failed", message: "Failed to persist running digest force-run state", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId } });
      }
      return generateDailyDigest(
        runtime.db,
        runtime.env.ANTHROPIC_API_KEY ?? null,
        buildTwitterCreds(runtime.env),
        true,
        buildTelegramCreds(runtime.env),
        signal,
        reportProgress,
      );
    })) ?? null;
  } catch (err) {
    caught = err;
    logWorkerEvent({ scope: "handler", level: "error", event: "digest_force_run_failed", message: "Forced daily digest failed", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId } });
  }

  const leaseLocked = result?.status === "skipped_locked";

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
  } else if (isFailureResult(result)) {
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
    errorMessage = resultFailureMessage(result);
  } else {
    const status = result?.status;
    if (status === "skipped_neutral") {
      outcome = "skipped";
    } else if (status === "skipped_locked") {
      outcome = "skipped_locked";
    } else if (typeof result?.metadata === "string"
      && result.metadata.startsWith("skipped:")) {
      outcome = "skipped";
    }
  }

  const failed = !leaseLocked && (Boolean(caught) || isFailureResult(result));
  const failureClass = failed
    ? classifyFailure(errorMessage ?? resultFailureMessage(result))
    : null;
  const nextAttempts = failed ? Math.min(payload.attempts + 1, MAX_ATTEMPTS) : payload.attempts;
  const deadLettered = failed && (failureClass === "permanent" || nextAttempts >= MAX_ATTEMPTS);
  if (!leaseLocked) {
    if (!failed) {
      try {
        await setCache(
          runtime.db,
          DIGEST_FORCE_RUN_CACHE_KEY,
          JSON.stringify({
            ...payload,
            state: "succeeded",
            nextAttemptAt: finishedAt,
            lastError: null,
          }),
        );
      } catch (err) {
        logWorkerEvent({ scope: "handler", level: "warn", event: "digest_trigger_state_persistence_failed", message: "Failed to persist succeeded digest trigger state", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId } });
      }
      try {
        await deleteCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
      } catch (err) {
        logWorkerEvent({ scope: "handler", level: "warn", event: "digest_trigger_state_clear_failed", message: "Failed to clear succeeded digest trigger state", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId } });
      }
    } else {
      const lastError = boundedErrorMessage(errorMessage ?? resultFailureMessage(result));
      const nextAttemptAt = deadLettered
        ? finishedAt
        : finishedAt + 2 * DIGEST_TRIGGER_POLL_INTERVAL_SECONDS * nextAttempts;
      try {
        await setCache(
          runtime.db,
          DIGEST_FORCE_RUN_CACHE_KEY,
          JSON.stringify({
            ...payload,
            attempts: nextAttempts,
            nextAttemptAt,
            state: deadLettered ? "dead_letter" : "failed_transient",
            lastError,
          }),
        );
      } catch (err) {
        logWorkerEvent({ scope: "handler", level: "warn", event: "digest_trigger_state_persistence_failed", message: "Failed to persist failed digest trigger state", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId, attempts: nextAttempts } });
      }
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
        state: leaseLocked
          ? payload.state
          : failed
            ? deadLettered ? "dead_letter" : "failed_transient"
            : "succeeded",
        attempts: nextAttempts,
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
      state: leaseLocked
        ? payload.state
        : failed
          ? deadLettered ? "dead_letter" : "failed_transient"
          : "succeeded",
      attempts: nextAttempts,
      nextAttemptAt: failed && !deadLettered
        ? finishedAt + 2 * DIGEST_TRIGGER_POLL_INTERVAL_SECONDS * nextAttempts
        : null,
      intentCleared: !leaseLocked && !failed,
      deadLettered,
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
