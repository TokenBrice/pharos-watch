import type { V9ContinuationMessage } from "@shared/types/v9-continuation";
import type { ScheduledEnv } from "./env";
import { loadV9EvalRun } from "./safety-score-v9/chunked-eval-store";
import { settleAfterAbort } from "./cron-abort-settlement";
import { SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS, type SlotDeadline } from "./cron-timeouts";
import { logWorkerEventArgs } from "./structured-log";

function messageMatchesActiveRun(
  message: V9ContinuationMessage,
  run: Awaited<ReturnType<typeof loadV9EvalRun>>,
): boolean {
  if (!run || run.state !== "active") return false;
  if (
    run.quarantine_epoch !== message.quarantineEpoch ||
    run.execution_generation !== message.executionGeneration ||
    run.evaluation_build_digest !== message.evaluationBuildDigest ||
    run.registry_fingerprint !== message.registryFingerprint ||
    run.policy_digest !== message.policyDigest
  ) {
    return false;
  }
  if (message.stage === "eval") {
    return run.stage === "evaluating" && message.chunkIndex !== null && run.next_chunk_index === message.chunkIndex;
  }
  if (message.stage === "commit") {
    return run.stage === "committing" && message.chunkIndex === null;
  }
  return run.stage === "materializing" && message.chunkIndex === null;
}

/**
 * Post-settlement heavy Queue handoff (1/6 serialized connection budget).
 * Called ONLY after the shared memory-lane lease and slot/execution accounting
 * settle. A send failure only loses latency; `:52` stage resume remains authority.
 */
export async function sendV9Continuation(
  env: ScheduledEnv,
  message: V9ContinuationMessage | undefined,
  deadline: SlotDeadline,
): Promise<"disabled" | "sent" | "stale" | "deadline" | "failed"> {
  if (!message || env.WORKER_V9_QUEUE_MODE !== "on" || !env.V9_CONTINUATION_QUEUE) {
    return "disabled";
  }
  const startedAt = Date.now();
  const remaining = Math.min(5_000, deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS - startedAt);
  if (remaining <= 0) return "deadline";

  const outcome = await settleAfterAbort(async () => {
    const current = await loadV9EvalRun(env.DB, message.runId);
    if (!messageMatchesActiveRun(message, current)) return "stale" as const;
    if (Date.now() >= startedAt + remaining) return "deadline" as const;
    await env.V9_CONTINUATION_QUEUE!.send(message, { contentType: "json", delaySeconds: 0 });
    return "sent" as const;
  }, AbortSignal.timeout(remaining), { platformDeadlineMs: startedAt + remaining });

  const sendStatus = outcome.status === "fulfilled" ? outcome.value : "failed";
  const metrics = {
    runId: message.runId,
    stage: message.stage,
    chunkIndex: message.chunkIndex,
    quarantineEpoch: message.quarantineEpoch,
    executionGeneration: message.executionGeneration,
    sendStatus,
    sendDurationMs: Date.now() - startedAt,
    sourceInvocationId: message.sourceInvocationId,
  };
  if (sendStatus === "failed") {
    logWorkerEventArgs("handler", "warn", "[v9-queue] Wakeup send failed; :52 resume remains eligible", metrics);
  }
  const accountingMs = deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS - Date.now();
  if (accountingMs > 0) {
    await settleAfterAbort(
      () => env.DB.batch([
        env.DB.prepare(
          `UPDATE cron_runs
              SET metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.v9QueueHandoff', json(?))
            WHERE invocation_id = ?
              AND job = 'compute-safety-score-v9'`,
        ).bind(JSON.stringify(metrics), message.sourceInvocationId),
        env.DB.prepare(
          `UPDATE v9_eval_queue_executions
              SET metadata = json_set(COALESCE(metadata, '{}'), '$.handoff', json(?))
            WHERE invocation_id = ?
              AND state = 'finished'`,
        ).bind(JSON.stringify(metrics), message.sourceInvocationId),
      ]),
      AbortSignal.timeout(Math.min(5_000, accountingMs)),
      { platformDeadlineMs: Date.now() + accountingMs },
    );
  }
  return sendStatus;
}
