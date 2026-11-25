import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { getScheduledTaskDescriptor } from "@shared/lib/scheduled-runner-registry";
import type { V9PublicationHoldReason } from "@shared/types/report-cards-v9";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "@shared/types/safety-score-cache-keys";
import {
  V9_CONTINUATION_QUEUE_NAME,
  V9ContinuationMessageSchema,
  type V9ContinuationMessage,
} from "@shared/types/v9-continuation";
import type { HeavyEnv } from "../lib/env";
import { executeAtomicBatch } from "../lib/db";
import type { CronProductivity } from "../lib/cron-run-contract";
import { prepareProducerOutcomeStatements } from "../lib/producer-history";
import {
  assertSlotDeadline,
  createSlotDeadline,
  SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
} from "../lib/cron-timeouts";
import { createLeaseOwner, runCronWithLease } from "../lib/cron-lease-primitives";
import { retainUntilDeadline, settleAfterAbort } from "../lib/cron-abort-settlement";
import { logWorkerEventArgs } from "../lib/structured-log";
import { V9_MEMORY_LANE_LEASE_KEY } from "../lib/v9-slot-window";
import { sendV9Continuation } from "../lib/v9-continuation-send";
import {
  claimV9Continuation,
  finishV9Continuation,
  heartbeatV9Continuation,
  type V9EvalQueueFence,
} from "../lib/safety-score-v9/chunked-eval-store";
import {
  currentV9PolicyDigestForClock,
  executeClaimedV9EvalStage,
  type RunChunkedV9StageOptions,
  type V9ChunkedStageStepResult,
} from "../lib/safety-score-v9/chunked-eval-pipeline";

export interface HandleV9ContinuationOptions {
  /** Test-only hook for deterministic evaluation-error quarantine tests. */
  onBeforeEvaluateAsset?: RunChunkedV9StageOptions["onBeforeEvaluateAsset"];
}

function summarizeQueueHoldReasons(reasons: readonly V9PublicationHoldReason[]): string {
  return reasons
    .map((reason) => {
      if (reason.code === "coverage-floor-failed") {
        return `${reason.code}:${reason.floorIds.join("|")}`;
      }
      if (reason.code === "producer-failed-pipeline-gap") {
        return `${reason.code}:${reason.assetId}:${reason.reasonCode}:${reason.effect}`;
      }
      if (reason.code === "assessment-failed") {
        return `${reason.code}:${reason.detail}`;
      }
      return reason.code;
    })
    .join(",");
}

async function recordQueueCommitCronEvidence(
  db: D1Database,
  input: {
    fence: V9EvalQueueFence;
    message: V9ContinuationMessage;
    stepResult: Extract<
      V9ChunkedStageStepResult,
      { status: "published-pending-materialize" | "published-materialized" | "held" }
    >;
    deliveryAttempt: number;
    eventEntryMs: number;
    workerVersion: string | null;
  },
): Promise<void> {
  const descriptor = getScheduledTaskDescriptor("v9PublicationOffset", "compute-safety-score-v9");
  const commitIdempotencyKey = `v9-queue-commit:${input.fence.runId}`;
  const nowMs = Date.now();
  const startedAt = Math.floor(input.eventEntryMs / 1_000);
  const completedAt = Math.floor(nowMs / 1_000);
  const durationMs = Math.max(0, nowMs - input.eventEntryMs);
  const step = input.stepResult;
  const isPublished = step.status !== "held";
  const cronStatus = isPublished ? "ok" : "degraded";
  const degradedReason = isPublished ? null : "v9-publication-held";
  const itemCount = step.status === "held" ? 0 : step.activeAssets;
  const productivity: CronProductivity =
    step.status === "held"
      ? {
          productive: false,
          reason: "v9-publication-held",
        }
      : {
          productive: true,
          reason:
            step.outcome === "partial"
              ? "v9-publication-published-partial"
              : "v9-publication-published",
          publications: [
            {
              surface: "safety-score-v9",
              generationId: step.publicationGenerationId,
              publishedAt: step.publishedAtSec,
              candidateRows: step.activeAssets,
              publishedRows: step.activeAssets,
              expectedRows: step.activeAssets,
              artifactCacheKey: SAFETY_SCORE_V9_CACHE_KEYS.publication,
              validationSummary: {
                outcome: step.outcome,
                quarantinedAssetCount: step.quarantineCount,
                affectedAssetCount: step.affectedAssetCount,
              },
            },
          ],
        };
  const metadataJson = JSON.stringify({
    mode: "queue-commit",
    runId: input.fence.runId,
    stage: "commit",
    outcome: step.status,
    deliveryId: input.fence.deliveryId,
    deliveryAttempt: input.deliveryAttempt,
    outputPublishedAt: step.status === "held" ? null : step.publishedAtSec,
    ...(step.status === "held"
      ? {
          reason: "v9-publication-held",
          attemptedPublicationGenerationId: step.attemptedPublicationGenerationId,
          holdReasonCodes: summarizeQueueHoldReasons(step.reasons),
        }
      : {
          publicationGenerationId: step.publicationGenerationId,
          payloadSha256: step.payloadSha256,
          publicationOutcome: step.outcome,
          quarantinedAssetCount: step.quarantineCount,
          affectedAssetCount: step.affectedAssetCount,
        }),
  });

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO cron_runs (
          job, started_at, duration_ms, status, item_count, metadata, slot_started_at, error, idempotency_key,
          schedule_key, producer_path, producer_kind, invocation_id, worker_version,
          productive, publication_count, calendar_period, degraded_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT DO NOTHING`,
      )
      .bind(
        descriptor.job,
        startedAt,
        durationMs,
        cronStatus,
        itemCount,
        metadataJson,
        input.message.slotStartedAt,
        commitIdempotencyKey,
        descriptor.scheduleKey,
        descriptor.producerPath,
        descriptor.producerKind,
        commitIdempotencyKey,
        input.workerVersion,
        isPublished ? 1 : 0,
        isPublished ? 1 : 0,
        degradedReason,
      ),
    ...prepareProducerOutcomeStatements(db, {
      scheduleKey: descriptor.scheduleKey,
      job: descriptor.job,
      producerPath: descriptor.producerPath,
      producerKind: descriptor.producerKind,
      invocationId: commitIdempotencyKey,
      workerVersion: input.workerVersion,
      slotStartedAt: input.message.slotStartedAt,
      calendarPeriod: null,
      idempotencyKey: commitIdempotencyKey,
      invokedAt: startedAt,
      completedAt,
      outcome: cronStatus,
      itemCount,
      metadata: metadataJson,
      error: null,
      productivity,
    }),
  ];
  await executeAtomicBatch(db, statements);
}

/**
 * Heavy Worker bounded Queue consumer for ADR-26 chunked Safety Score V9
 * evaluation (`pharos-v9-continuation`). At most one chunk/commit/materialize
 * stage per Queue event under the shared `worker-memory-lane:safety-score-v9`
 * lease and `v9_eval_queue_executions` idempotency fence.
 */
export async function handleV9ContinuationBatch(
  batch: MessageBatch<unknown>,
  env: HeavyEnv,
  ctx: ExecutionContext,
  eventEntryMs: number,
  options: HandleV9ContinuationOptions = {},
): Promise<void> {
  const deadline = createSlotDeadline(eventEntryMs);
  if (batch.queue !== V9_CONTINUATION_QUEUE_NAME || batch.messages.length !== 1) {
    batch.ackAll();
    logWorkerEventArgs("handler", "warn", "[v9-queue] Rejected foreign queue or unbounded batch");
    return;
  }
  const delivery = batch.messages[0]!;
  const parsed = V9ContinuationMessageSchema.safeParse(delivery.body);
  if (!parsed.success) {
    logWorkerEventArgs("handler", "warn", "[v9-queue] Acked invalid continuation payload", {
      deliveryId: delivery.id,
      reason: "invalid-continuation-payload",
    });
    delivery.ack();
    return;
  }
  if (env.WORKER_V9_QUEUE_MODE !== "on") {
    logWorkerEventArgs("handler", "info", "[v9-queue] Acked continuation while WORKER_V9_QUEUE_MODE is off", {
      deliveryId: delivery.id,
      runId: parsed.data.runId,
      stage: parsed.data.stage,
      reason: "v9-queue-mode-off",
    });
    delivery.ack();
    return;
  }

  const message = parsed.data;
  const workerVersion = env.CF_VERSION_METADATA?.id ?? null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("v9-queue-deadline")), deadline.remainingMs());
  const owner = createLeaseOwner("v9-queue");
  const leaseOwner = owner;

  let fence: V9EvalQueueFence | null = null;
  let stepResult: V9ChunkedStageStepResult | undefined;
  let pending: V9ContinuationMessage | undefined;
  let workDrained = true;
  let leaseLocked = false;

  const lifecycle = async () => {
    try {
      const leased = await runCronWithLease(
        env.DB,
        V9_MEMORY_LANE_LEASE_KEY,
        async ({ signal }) => {
          assertSlotDeadline(deadline, signal);
          const claimed = await claimV9Continuation(env.DB, message, {
            deliveryId: delivery.id,
            deliveryAttempt: delivery.attempts,
            owner,
            leaseOwner,
            workerVersion,
            deadline,
            currentEvaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
            currentRegistryFingerprint: computeReportCardsRegistryFingerprint(),
            currentPolicyDigestForClock: currentV9PolicyDigestForClock,
          });
          assertSlotDeadline(deadline, signal);
          if (claimed.status !== "claimed") {
            if (claimed.status === "build-drift") {
              logWorkerEventArgs("handler", "warn", "[v9-queue] Aborted run on evaluator build drift", {
                runId: claimed.runId,
                reason: claimed.reason,
              });
            } else {
              logWorkerEventArgs("handler", "info", "[v9-queue] Acked stale continuation delivery", {
                deliveryId: delivery.id,
                runId: message.runId,
                stage: message.stage,
                chunkIndex: message.chunkIndex,
                reason: claimed.reason,
              });
            }
            return;
          }
          fence = claimed.fence;
          const activeFence = claimed.fence;
          const heartbeatAttempts = new Set<Promise<void>>();
          let heartbeatFailures = 0;
          let workSettled = false;
          const heartbeat = setInterval(() => {
            const attempt = heartbeatV9Continuation(env.DB, activeFence)
              .then((owned) => {
                heartbeatFailures = 0;
                if (!owned && !workSettled) controller.abort(new Error("v9-queue-ownership-lost"));
              })
              .catch((error: unknown) => {
                heartbeatFailures += 1;
                if (heartbeatFailures >= 2 && !workSettled) controller.abort(error);
              })
              .finally(() => heartbeatAttempts.delete(attempt));
            heartbeatAttempts.add(attempt);
          }, 30_000);

          try {
            assertSlotDeadline(deadline, signal);
            workDrained = false;
            const outcome = await settleAfterAbort(
              () =>
                executeClaimedV9EvalStage(env.DB, claimed.run, owner, {
                  captureArchiveBucket: env.SAFETY_CAPTURE_ARCHIVE,
                  captureArchiveContext: ctx,
                  workerVersion,
                  deadlineMs: deadline.platformDeadlineMs,
                  signal,
                  onBeforeEvaluateAsset: options.onBeforeEvaluateAsset,
                }),
              signal,
              {
                observer: true,
                platformDeadlineMs: deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
              },
            );
            workDrained = outcome.status !== "aborted" || outcome.settled;
            workSettled = true;
            if (outcome.status !== "fulfilled") {
              throw outcome.status === "rejected" ? outcome.error : outcome.reason;
            }
            stepResult = outcome.value;
            pending = stepResult.nextMessage ?? undefined;
          } finally {
            workSettled = true;
            clearInterval(heartbeat);
            await Promise.allSettled(heartbeatAttempts);
          }
        },
        {
          owner: leaseOwner,
          abortSignal: controller.signal,
          deadline,
          ttlSec: 210,
          heartbeatSec: 15,
        },
      );

      if (leased.status === "skipped_locked") {
        leaseLocked = true;
        return;
      }
      // Global memory-lane lease release precedes terminal execution accounting and next send.
      if (leased.status !== "ok" || !fence) return;

      const status =
        stepResult?.status === "held" || stepResult?.status === "aborted" ? "degraded" : "ok";
      const failureReason = stepResult?.status === "aborted" ? stepResult.reason : null;
      const finished = await finishV9Continuation(env.DB, fence, status, failureReason, {
        stage: stepResult?.stage ?? message.stage,
        outcome: stepResult?.status ?? "noop",
        ...(failureReason ? { reason: failureReason } : {}),
        deliveryAttempt: delivery.attempts,
        eventEntryMs,
      });
      if (!finished) {
        throw new Error("v9-queue-terminal-superseded");
      }
      if (
        stepResult?.stage === "commit" &&
        (stepResult.status === "published-pending-materialize" ||
          stepResult.status === "published-materialized" ||
          stepResult.status === "held")
      ) {
        try {
          await recordQueueCommitCronEvidence(env.DB, {
            fence,
            message,
            stepResult,
            deliveryAttempt: delivery.attempts,
            eventEntryMs,
            workerVersion,
          });
        } catch (accountingError) {
          logWorkerEventArgs(
            "handler",
            "warn",
            "[v9-queue] Failed to record commit productivity evidence in cron_runs/producer_heads",
            accountingError,
          );
        }
      }
      if (pending) {
        await sendV9Continuation(env, pending, deadline);
      }
    } catch (error) {
      if (fence && workDrained) {
        await finishV9Continuation(
          env.DB,
          fence,
          "error",
          error instanceof Error ? error.message : String(error),
          {
            reason: "v9-queue-consumer-failed",
            stage: message.stage,
            deliveryAttempt: delivery.attempts,
          },
        ).catch(() => undefined);
      }
      throw error;
    }
  };

  const work = lifecycle();
  try {
    const outcome = await settleAfterAbort(() => work, controller.signal, {
      platformDeadlineMs: deadline.platformDeadlineMs,
    });
    if (outcome.status === "fulfilled") {
      if (leaseLocked) {
        delivery.retry({ delaySeconds: 60 });
      } else {
        delivery.ack();
      }
    } else {
      delivery.retry({ delaySeconds: 60 });
      ctx.waitUntil(
        retainUntilDeadline(
          work.catch((error: unknown) => {
            logWorkerEventArgs(
              "handler",
              "warn",
              "[v9-queue] Consumer failed; :52 resume remains recovery authority",
              error,
            );
          }),
          deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
        ),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
