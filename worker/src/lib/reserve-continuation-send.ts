import type { ReserveContinuationMessage } from "@shared/types/reserve-continuation";
import type { ScheduledEnv } from "./env";
import { loadLiveReserveCheckpoint } from "./scheduled-recovery-checkpoint";
import { settleAfterAbort } from "./cron-abort-settlement";
import { SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS, type SlotDeadline } from "./cron-timeouts";
import { logWorkerEventArgs } from "./structured-log";

/** Called only after the executing event and all job/child leases settle. */
export async function sendReserveContinuation(
  env: ScheduledEnv, message: ReserveContinuationMessage | undefined, deadline: SlotDeadline,
): Promise<void> {
  if (!message || env.WORKER_RESERVE_QUEUE_MODE !== "on" || !env.RESERVE_CONTINUATION_QUEUE) return;
  const startedAt = Date.now();
  const remaining = Math.min(5_000, deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS - startedAt);
  if (remaining <= 0) return;
  const outcome = await settleAfterAbort(async () => {
    const current = await loadLiveReserveCheckpoint(env.DB, message);
    if (!current || current.state !== "ready" || current.invocationId !== message.sourceInvocationId
      || current.executionGeneration !== message.executionGeneration || current.nextItemKey !== message.nextItemKey
      || current.itemsDone !== message.itemsDone || current.queueHash !== message.queueHash) return "stale";
    if (message.phase === "tail") {
      // Tail-only graph loading preserves the adapter invocation's normal lazy boundary.
      const { loadAcceptedReserveGeneration } = await import("./accepted-reserve-generation");
      const seal = await loadAcceptedReserveGeneration(env.DB);
      if (seal.root.slotStartedAt !== message.slotStartedAt || seal.root.queueHash !== message.queueHash) return "unsealed";
    }
    if (Date.now() >= startedAt + remaining) return "deadline";
    await env.RESERVE_CONTINUATION_QUEUE!.send(message, { contentType: "json", delaySeconds: 0 });
    return "sent";
  }, AbortSignal.timeout(remaining), { platformDeadlineMs: startedAt + remaining });
  const metrics = { phase: message.phase, sendStatus: outcome.status === "fulfilled" ? outcome.value : "failed",
    sendDurationMs: Date.now() - startedAt, sourceInvocationId: message.sourceInvocationId };
  // Send failure only loses latency. It never rewrites ready/checkpoint authority.
  if (outcome.status !== "fulfilled") logWorkerEventArgs("handler", "warn", "[reserve-queue] Wakeup send failed; cron fallback remains eligible", metrics);
  const accountingMs = deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS - Date.now();
  if (accountingMs <= 0) return;
  await settleAfterAbort(() => env.DB.batch([
    env.DB.prepare(`UPDATE cron_runs SET metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
      '$.reserveQueueHandoff', json(?)) WHERE invocation_id = ? AND job IN ('sync-live-reserves', 'reserve-recovery')`)
      .bind(JSON.stringify(metrics), message.sourceInvocationId),
    env.DB.prepare(`UPDATE reserve_continuation_executions SET metadata = json_set(COALESCE(metadata, '{}'),
      '$.handoff', json(?)) WHERE invocation_id = ? AND state = 'finished'`)
      .bind(JSON.stringify(metrics), message.sourceInvocationId),
  ]), AbortSignal.timeout(Math.min(5_000, accountingMs)), { platformDeadlineMs: Date.now() + accountingMs });
}
