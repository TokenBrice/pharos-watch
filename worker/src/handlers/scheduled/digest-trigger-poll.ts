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
import {
  buildTelegramCreds,
  buildTwitterCreds,
  missingTelegramCredentialNames,
  missingTwitterCredentialNames,
} from "../../lib/runtime-credentials";
import { drainTelegramDigestOutbox } from "../../lib/telegram/digest-outbox";
import { getCache, setCache } from "../../lib/db-cache";
import { DIGEST_FORCE_RUN_CACHE_KEY } from "../../api/admin-actions";
import { resolveDigestSafetyMap } from "../../lib/digest-safety-map";
import { formatIsoDate } from "@shared/lib/format";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import {
  getRuntimeProducerIdentity,
  runRuntimeBudgetOnlyTask,
  type ScheduledRuntimeContext,
} from "./context";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { recordBudgetSurfaceTelemetry, type BudgetSurfaceOutcome } from "../../lib/budget-surface-telemetry";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  buildScheduledSlotSummary,
  summarizeCronResult,
  summarizeSkippedScheduledJob,
  summarizeThrownScheduledJob,
} from "./slot-summary";
import { NON_BLOCKED_DIGEST_SQL_FILTER } from "../../lib/digest-sql-filters";
import { runWeeklyRecapForRuntime } from "./weekly-recap-invocation";
import { resolveTelegramRecapRolloutPolicy } from "@shared/lib/telegram-recap-rollout";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { runSafetyMapProducerKick } from "../../cron/safety-map-producer-kick";

export const DIGEST_LAST_TRIGGER_RESULT_CACHE_KEY = "digest:last-trigger-result";
const DIGEST_TRIGGER_POLL_SURFACE = "digest-trigger-poll";
const TELEGRAM_DIGEST_OUTBOX_DRAIN_SURFACE = "telegram-digest-outbox-drain";
const SAFETY_MAP_PRODUCER_KICK_SURFACE = "safety-map-producer-kick";
const DIGEST_TRIGGER_POLL_BUDGET_ONLY_JOBS = SCHEDULED_SLOT_PLANS.digestTriggerPoll.budgetOnlyJobs?.length ?? 0;
export const MAX_ATTEMPTS = 3;
export const DIGEST_TRIGGER_POLL_INTERVAL_SECONDS = 5 * 60;
/**
 * A `running` state is only reclaimable after one `daily-digest` lease TTL.
 * Each start consumes its attempt durably before work, including starts whose
 * isolate terminates before the post-run handler.
 */
const DIGEST_FORCE_RUN_RUNNING_DEADLINE_SEC = 15 * 60;
/**
 * Weekly recap generations per edition day, counting the 08:10 slot. A failed
 * weekly (refusal, truncation, blocked quality gate) leaves no non-blocked row,
 * so without a cap every five-minute poll would regenerate and re-bill it for
 * the rest of Monday. Matches the three-attempt bound on forced daily runs.
 */
const WEEKLY_RECAP_MAX_RUNS_PER_EDITION = MAX_ATTEMPTS;

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

/**
 * Pre-digest Safety Score map producer kick. Outside its window it makes no
 * reads and records nothing; its telemetry interval is therefore one day.
 */
async function runSafetyMapProducerKickSurface(runtime: ScheduledRuntimeContext): Promise<void> {
  const startedMs = Date.now();
  try {
    const result = await runRuntimeBudgetOnlyTask(
      runtime,
      SAFETY_MAP_PRODUCER_KICK_SURFACE,
      (signal) => runSafetyMapProducerKick({
        db: runtime.db,
        nowSec: runtime.slotStartedAt,
        githubToken: runtime.env.GITHUB_PAT,
        signal,
      }),
    );
    if (result.outcome === null) return;
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: SAFETY_MAP_PRODUCER_KICK_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: result.action === "current" ? 0 : 1,
      processedCount: result.action === "dispatched" ? 1 : 0,
      outcome: result.outcome,
      skippedReason: result.outcome === "skipped" ? result.action : null,
      error: result.error,
      metadata: {
        action: result.action,
        date: result.date,
        manifestDate: result.manifestDate,
        manifestReason: result.manifestReason,
        dispatches: result.dispatches,
      },
      producer: getRuntimeProducerIdentity(runtime, SAFETY_MAP_PRODUCER_KICK_SURFACE),
    });
  } catch (err) {
    logWorkerEvent({ scope: "handler", level: "error", event: "safety_map_producer_kick_failed", message: "Safety map producer kick failed", job: SAFETY_MAP_PRODUCER_KICK_SURFACE, error: err });
    await recordBudgetSurfaceTelemetry(runtime.db, {
      surface: SAFETY_MAP_PRODUCER_KICK_SURFACE,
      durationMs: Date.now() - startedMs,
      dueCount: 0,
      processedCount: 0,
      outcome: "error",
      error: toErrorMessage(err),
      producer: getRuntimeProducerIdentity(runtime, SAFETY_MAP_PRODUCER_KICK_SURFACE),
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

async function replaceForceRunRequest(
  db: D1Database,
  expectedValue: string,
  request: DigestForceRunRequest,
  timestamp: number,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
    .bind(JSON.stringify(request), timestamp, DIGEST_FORCE_RUN_CACHE_KEY, expectedValue)
    .run();
  return (result.meta.changes ?? 0) === 1;
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

/**
 * Leased daily-digest work with duplicate-safe recovery. When today already
 * has a publishable row — a prior run generated but left a channel
 * unresolved — delivery resumes from the stored edition; regenerating,
 * forced or not, would mint a duplicate edition. Only when no publishable
 * row exists does the full generation path run. Map availability only changes
 * attachment/prose; it never changes whether delivery is attempted.
 */
async function runDailyDigestWithResume(
  runtime: ScheduledRuntimeContext,
  force: boolean,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const { generateDailyDigest, resumeDailyDigestDelivery } = await import("../../cron/daily-digest");
  const nowSec = Math.floor(Date.now() / 1000);
  const resolution = await resolveDigestSafetyMap(formatIsoDate(nowSec), nowSec, signal);
  const twitterCreds = buildTwitterCreds(runtime.env);
  const telegramCreds = buildTelegramCreds(runtime.env);
  const credentialDiagnostics = {
    twitterMissing: missingTwitterCredentialNames(runtime.env),
    telegramMissing: missingTelegramCredentialNames(runtime.env),
  };
  const recapRollout = resolveTelegramRecapRolloutPolicy(runtime.env);
  const resumed = await resumeDailyDigestDelivery(
    runtime.db,
    twitterCreds,
    telegramCreds,
    resolution,
    signal,
    reportProgress,
    credentialDiagnostics,
    recapRollout,
  );
  if (resumed.kind === "resumed") {
    return {
      itemCount: 1,
      ...(resumed.deliveryComplete ? {} : { status: "degraded" as const }),
      metadata: `resumed delivery, tweet: ${resumed.tweetStatus}, telegram: ${resumed.telegramStatus}`,
    };
  }
  return generateDailyDigest(
    runtime.db,
    runtime.env.ANTHROPIC_API_KEY ?? null,
    twitterCreds,
    force,
    telegramCreds,
    signal,
    reportProgress,
    credentialDiagnostics,
    // Checked-in daily LLM defaults; see daily-0805.ts.
    undefined,
    recapRollout,
  );
}

async function runWeeklyResumeIfDue(
  runtime: ScheduledRuntimeContext,
  startedMs: number,
): Promise<ReturnType<typeof buildScheduledSlotSummary> | null> {
  const slotDate = new Date(runtime.slotStartedAt * 1000);
  const secondsIntoDay = slotDate.getUTCHours() * 3_600
    + slotDate.getUTCMinutes() * 60
    + slotDate.getUTCSeconds();
  if (slotDate.getUTCDay() !== 1 || secondsIntoDay < 8 * 3_600 + 10 * 60) {
    return null;
  }
  const dayStart = bucketUnixSecondsToUtcDay(runtime.slotStartedAt);
  const existing = await runtime.db
    .prepare(
      `SELECT 1 AS present
         FROM daily_digest
        WHERE generated_at >= ?
          AND generated_at < ?
          AND json_extract(digest_meta, '$.type') = 'weekly'
          AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
        LIMIT 1`,
    )
    .bind(dayStart, dayStart + 86_400)
    .first<{ present: number }>();
  if (existing) return null;
  // Window on the scheduled slot, not wall-clock start: a delayed Monday poll
  // executed after midnight still generates Monday's edition and must count.
  const priorRuns = await runtime.db
    .prepare(
      `SELECT COUNT(*) AS runs
         FROM cron_runs
        WHERE job = 'weekly-recap'
          AND COALESCE(slot_started_at, started_at) >= ?
          AND COALESCE(slot_started_at, started_at) < ?
          AND status NOT IN ('skipped_neutral', 'skipped_locked')`,
    )
    .bind(dayStart, dayStart + 86_400)
    .first<{ runs: number }>();
  if ((priorRuns?.runs ?? 0) >= WEEKLY_RECAP_MAX_RUNS_PER_EDITION) return null;

  let result: CronResult | null = null;
  let caught: unknown = null;
  try {
    result = (await runtime.runLeasedCron("weekly-recap", (signal, reportProgress) =>
      runWeeklyRecapForRuntime(runtime, signal, reportProgress))) ?? null;
  } catch (error) {
    caught = error;
    logWorkerEvent({
      scope: "handler",
      level: "error",
      event: "weekly_recap_resume_failed",
      message: "Missed weekly recap resume failed",
      job: DIGEST_TRIGGER_POLL_SURFACE,
      error,
      metadata: { digestDate: formatIsoDate(runtime.slotStartedAt) },
    });
  }
  const leaseLocked = result?.status === "skipped_locked";
  await recordBudgetSurfaceTelemetry(runtime.db, {
    surface: DIGEST_TRIGGER_POLL_SURFACE,
    durationMs: Date.now() - startedMs,
    dueCount: 1,
    processedCount: leaseLocked ? 0 : 1,
    outcome: caught
      ? "error"
      : leaseLocked
        ? "skipped"
        : result?.status === "degraded" || result?.status === "error"
          ? result.status
          : "ok",
    skippedReason: leaseLocked ? "weekly-recap-lease-locked" : null,
    error: caught ? toErrorMessage(caught) : null,
    metadata: {
      weeklyResume: true,
      digestDate: formatIsoDate(runtime.slotStartedAt),
    },
    producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
  });
  return buildScheduledSlotSummary([
    caught
      ? summarizeThrownScheduledJob("weekly-recap", caught)
      : summarizeCronResult("weekly-recap", result),
  ], { budgetOnlyJobs: DIGEST_TRIGGER_POLL_BUDGET_ONLY_JOBS });
}

async function finishSkippedDigestTriggerPoll(
  runtime: ScheduledRuntimeContext,
  startedMs: number,
  skippedReason: string,
  metadata: Record<string, unknown>,
  neutral = false,
) {
  const weeklyResume = await runWeeklyResumeIfDue(runtime, startedMs);
  if (weeklyResume) return weeklyResume;
  await recordBudgetSurfaceTelemetry(runtime.db, {
    surface: DIGEST_TRIGGER_POLL_SURFACE,
    durationMs: Date.now() - startedMs,
    dueCount: 0,
    processedCount: 0,
    outcome: "skipped",
    skippedReason,
    metadata,
    producer: getRuntimeProducerIdentity(runtime, DIGEST_TRIGGER_POLL_SURFACE),
  });
  return buildScheduledSlotSummary([
    summarizeSkippedScheduledJob("digest-trigger-poll", skippedReason, neutral ? { neutral: true } : undefined),
  ], { budgetOnlyJobs: DIGEST_TRIGGER_POLL_BUDGET_ONLY_JOBS });
}


export async function runDigestTriggerPollSlot(runtime: ScheduledRuntimeContext) {
  const startedMs = Date.now();
  await runTelegramDigestOutboxDrain(runtime);
  await runSafetyMapProducerKickSurface(runtime);
  const pending = await getCache(runtime.db, DIGEST_FORCE_RUN_CACHE_KEY);
  if (!pending) {
    return finishSkippedDigestTriggerPoll(
      runtime,
      startedMs,
      "no-pending-request",
      { pending: false },
      true,
    );
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
    ], { budgetOnlyJobs: DIGEST_TRIGGER_POLL_BUDGET_ONLY_JOBS });
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.state === "succeeded" || payload.state === "dead_letter") {
    const skippedReason = payload.state === "dead_letter" ? "dead-letter" : "already-succeeded";
    return finishSkippedDigestTriggerPoll(runtime, startedMs, skippedReason, {
      pending: true,
      requestId: payload.requestId,
      state: payload.state,
      attempts: payload.attempts,
    });
  }
  if (payload.nextAttemptAt > now) {
    return finishSkippedDigestTriggerPoll(runtime, startedMs, "retry-not-due", {
      pending: true,
      requestId: payload.requestId,
      state: payload.state,
      attempts: payload.attempts,
      nextAttemptAt: payload.nextAttemptAt,
    });
  }

  let result: CronResult | null = null;
  let caught: unknown = null;
  let claimedPayload: DigestForceRunRequest | null = null;
  let noStartReason: string | null = null;

  try {
    result = (await runtime.runLeasedCron("daily-digest", async (signal, reportProgress) => {
      const claimedAt = Math.floor(Date.now() / 1_000);
      if (payload.attempts >= MAX_ATTEMPTS) {
        const exhausted = await replaceForceRunRequest(runtime.db, pending.value, {
          ...payload,
          state: "dead_letter",
          nextAttemptAt: claimedAt,
          lastError: payload.lastError ?? "attempts-exhausted",
        }, claimedAt);
        noStartReason = exhausted ? "attempts-exhausted" : "intent-changed";
        return { status: "skipped_neutral", metadata: noStartReason };
      }
      const claim: DigestForceRunRequest = {
        ...payload,
        attempts: payload.attempts + 1,
        state: "running",
        nextAttemptAt: claimedAt + DIGEST_FORCE_RUN_RUNNING_DEADLINE_SEC,
      };
      if (!(await replaceForceRunRequest(runtime.db, pending.value, claim, claimedAt))) {
        noStartReason = "intent-changed";
        return { status: "skipped_neutral", metadata: noStartReason };
      }
      claimedPayload = claim;
      return runDailyDigestWithResume(runtime, true, signal, reportProgress);
    })) ?? null;
  } catch (err) {
    caught = err;
    logWorkerEvent({ scope: "handler", level: "error", event: "digest_force_run_failed", message: "Forced daily digest failed", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId } });
  }

  if (noStartReason) {
    return finishSkippedDigestTriggerPoll(runtime, startedMs, noStartReason, {
      pending: true,
      requestId: payload.requestId,
      attempts: payload.attempts,
      deadLettered: noStartReason === "attempts-exhausted",
    });
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
  const attemptPayload = claimedPayload ?? payload;
  const nextAttempts = attemptPayload.attempts;
  const deadLettered = claimedPayload !== null && failed && (failureClass === "permanent" || nextAttempts >= MAX_ATTEMPTS);
  const finalState = claimedPayload === null
    ? payload.state
    : failed
      ? deadLettered ? "dead_letter" : "failed_transient"
      : "succeeded";
  let intentCleared = false;
  if (claimedPayload !== null) {
    if (!failed) {
      try {
        const succeeded: DigestForceRunRequest = {
          ...attemptPayload,
          state: "succeeded",
          nextAttemptAt: finishedAt,
          lastError: null,
        };
        if (await replaceForceRunRequest(runtime.db, JSON.stringify(attemptPayload), succeeded, finishedAt)) {
          const cleared = await runtime.db
            .prepare("DELETE FROM cache WHERE key = ? AND value = ?")
            .bind(DIGEST_FORCE_RUN_CACHE_KEY, JSON.stringify(succeeded))
            .run();
          intentCleared = (cleared.meta.changes ?? 0) === 1;
        }
      } catch (err) {
        logWorkerEvent({ scope: "handler", level: "warn", event: "digest_trigger_state_persistence_failed", message: "Failed to persist succeeded digest trigger state", job: DIGEST_TRIGGER_POLL_SURFACE, error: err, metadata: { requestId: payload.requestId } });
      }
    } else {
      const lastError = boundedErrorMessage(errorMessage ?? resultFailureMessage(result));
      const nextAttemptAt = deadLettered
        ? finishedAt
        : finishedAt + 2 * DIGEST_TRIGGER_POLL_INTERVAL_SECONDS * nextAttempts;
      try {
        await replaceForceRunRequest(runtime.db, JSON.stringify(attemptPayload), {
          ...attemptPayload,
          nextAttemptAt,
          state: deadLettered ? "dead_letter" : "failed_transient",
          lastError,
        }, finishedAt);
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
        state: finalState,
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
    processedCount: claimedPayload === null ? 0 : 1,
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
      state: finalState,
      attempts: nextAttempts,
      nextAttemptAt: claimedPayload !== null && failed && !deadLettered
        ? finishedAt + 2 * DIGEST_TRIGGER_POLL_INTERVAL_SECONDS * nextAttempts
        : null,
      intentCleared,
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
  ], { budgetOnlyJobs: DIGEST_TRIGGER_POLL_BUDGET_ONLY_JOBS });
}
