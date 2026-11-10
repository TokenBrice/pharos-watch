import { ReserveContinuationMessageSchema } from "@shared/types/reserve-continuation";
import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
import type { Env } from "../lib/env";
import { createSlotDeadline, assertSlotDeadline, SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS } from "../lib/cron-timeouts";
import { createLeaseOwner, runCronWithLease } from "../lib/cron-lease-primitives";
import { createReserveLeaseOwner } from "../lib/reserve-producer-priority";
import { claimReserveContinuation, finishReserveContinuation, heartbeatReserveContinuation } from "../lib/reserve-continuation-fence";
import type { ReserveContinuationClaim } from "../lib/reserve-continuation-fence";
import { createScheduledRuntimeContext } from "./scheduled/context";
import { sendReserveContinuation } from "../lib/reserve-continuation-send";
import { retainUntilDeadline, settleAfterAbort } from "../lib/cron-abort-settlement";
import { logWorkerEventArgs } from "../lib/structured-log";
import type { ScheduledSlotSummary } from "./scheduled/slot-summary";

export const RESERVE_CONTINUATION_QUEUE_NAME = "pharos-reserve-continuation";

/** At most one reserve slice OR exhausted-cohort tail per real Queue event. */
export async function handleReserveContinuationBatch(
  batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext, eventEntryMs: number,
): Promise<void> {
  const deadline = createSlotDeadline(eventEntryMs);
  if (batch.queue !== RESERVE_CONTINUATION_QUEUE_NAME || batch.messages.length !== 1) {
    batch.ackAll();
    logWorkerEventArgs("handler", "warn", "[reserve-queue] Rejected foreign queue or unbounded batch");
    return;
  }
  const delivery = batch.messages[0];
  const parsed = ReserveContinuationMessageSchema.safeParse(delivery.body);
  if (!parsed.success || env.WORKER_RESERVE_QUEUE_MODE !== "on" || env.WORKER_RESERVE_RECOVERY_MODE !== "recover") {
    delivery.ack();
    return;
  }
  const message = parsed.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("reserve-queue-deadline")), deadline.remainingMs());
  const owner = createLeaseOwner("reserve-queue");
  const leaseOwner = createReserveLeaseOwner(owner, "reserve-recovery", "reserve-queue", {
    scheduleKey: message.scheduleKey, slotStartedAt: message.slotStartedAt,
    invocationId: owner, producerKind: "queue-recovery",
  });
  let claim: ReserveContinuationClaim | null = null;
  let pending: ReserveContinuationMessage | undefined;
  let summary: ScheduledSlotSummary | undefined;
  let workDrained = true;
  const lifecycle = async () => {
    try {
      const leased = await runCronWithLease(env.DB, "reserve-recovery", async ({ signal }) => {
        assertSlotDeadline(deadline, signal);
        claim = await claimReserveContinuation(env.DB, message, {
          deliveryId: delivery.id, owner, leaseOwner, workerVersion: env.CF_VERSION_METADATA?.id ?? null, deadline,
        });
        assertSlotDeadline(deadline, signal);
        if (!claim) return;
        const fence = claim.fence;
        const heartbeatAttempts = new Set<Promise<void>>();
        let heartbeatFailures = 0;
        let workSettled = false;
        const heartbeat = setInterval(() => {
          const attempt = heartbeatReserveContinuation(env.DB, fence).then((owned) => {
            heartbeatFailures = 0;
            if (!owned && !workSettled) controller.abort(new Error("reserve-queue-ownership-lost"));
          }).catch((error: unknown) => {
            // Tolerate one consecutive read fault like the cron lease heartbeat;
            // a settled producer is never rewritten by a late heartbeat.
            heartbeatFailures += 1;
            if (heartbeatFailures >= 2 && !workSettled) controller.abort(error);
          }).finally(() => heartbeatAttempts.delete(attempt));
          heartbeatAttempts.add(attempt);
        }, 30_000);
        try {
          const runtime = createScheduledRuntimeContext(env, ctx, {
            cron: "", scheduleKey: message.scheduleKey, scheduledTimeMs: null,
            slotStartedAt: message.slotStartedAt, deadline, parentSignal: signal, executionFence: fence,
            producerKind: "queue-recovery", recoveryCheckpoint: claim.checkpoint, jobAttemptNo: message.attemptNo,
          });
          runtime.slotSignal = signal;
          runtime.reserveQueueMetadata = { deliveryId: delivery.id, deliveryAttempt: delivery.attempts,
            phase: message.phase, eventEntryMs, readyToClaimMs: claim.readyToClaimMs,
            deliveryLatencyMs: Math.max(0, eventEntryMs - delivery.timestamp.getTime()),
            sourceInvocationId: message.sourceInvocationId, executionGeneration: fence.generation };
          // Lazy graph boundary: rejected/duplicate messages never load the producer or tail.
          const { runFourHourlyReserveSyncSlot } = await import("./scheduled/four-hourly-reserves");
          assertSlotDeadline(deadline, signal);
          workDrained = false;
          const outcome = await settleAfterAbort(() => runFourHourlyReserveSyncSlot(runtime), signal, {
            observer: true, platformDeadlineMs: deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS,
          });
          workDrained = outcome.status !== "aborted" || outcome.settled;
          workSettled = true;
          if (outcome.status !== "fulfilled") throw outcome.status === "rejected" ? outcome.error : outcome.reason;
          summary = outcome.value;
          pending = summary.reserveContinuation;
        } finally {
          workSettled = true;
          clearInterval(heartbeat);
          await Promise.allSettled(heartbeatAttempts);
        }
      }, { owner: leaseOwner, abortSignal: controller.signal, deadline, reserveRecoveryAdmission: true });
      // Global lease release precedes event terminal and the next send.
      if (leased.status !== "ok" || !claim) return;
      const status = summary?.jobsErrored ? "error" : summary?.jobsDegraded || summary?.jobsSkipped ? "degraded" : "ok";
      if (!await finishReserveContinuation(env.DB, claim.fence, status, { ...summary,
        deliveryAttempt: delivery.attempts, readyToClaimMs: claim.readyToClaimMs, eventEntryMs })) {
        throw new Error("reserve-queue-terminal-superseded");
      }
      // Semantic child failures are durably recorded and retried only by cron.
      if (status !== "error") await sendReserveContinuation(env, pending, deadline);
    } catch (error) {
      if (claim && workDrained) await finishReserveContinuation(env.DB, claim.fence, "error", {
        reason: "reserve-queue-consumer-failed", deliveryAttempt: delivery.attempts,
      });
      throw error;
    }
  };
  const work = lifecycle();
  try {
    const outcome = await settleAfterAbort(() => work, controller.signal, { platformDeadlineMs: deadline.platformDeadlineMs });
    if (outcome.status === "fulfilled") delivery.ack();
    else {
      // Transport/uncaught consumer failures have three delayed deliveries then DLQ.
      // A retry of an already claimed delivery can never authorize another attempt.
      delivery.retry({ delaySeconds: 60 });
      ctx.waitUntil(retainUntilDeadline(work.catch((error: unknown) => {
        logWorkerEventArgs("handler", "warn", "[reserve-queue] Consumer failed; cron remains recovery authority", error);
      }), deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS));
    }
  } finally {
    clearTimeout(timer);
  }
}
