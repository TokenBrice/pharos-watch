import {
  resolveSlotCatchUpCandidate,
  SLOT_CATCH_UP_SCHEDULE_KEYS,
  type SlotCatchUpScheduleKey,
} from "@shared/lib/scheduled-slot-catch-up-policy";
import {
  SLOT_CATCH_UP_MESSAGE_KIND,
  type SlotCatchUpMessage,
  type SlotCatchUpTrigger,
} from "@shared/types/slot-catch-up";
import type { ScheduledEnv } from "./env";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { STALE_SLOT_ERROR } from "./scheduled-slot-reconciliation";
import { logWorkerEvent } from "./structured-log";

export function getSlotCatchUpCacheKey(scheduleKey: SlotCatchUpScheduleKey): string {
  return `scheduled-catch-up:${scheduleKey}`;
}

interface SlotExecutionProbeRow {
  state: string;
  result_status: string | null;
  error: string | null;
  catch_up_type: string | null;
}

async function classifyMissedSlot(
  db: D1Database,
  scheduleKey: SlotCatchUpScheduleKey,
  slotStartedAt: number,
): Promise<SlotCatchUpTrigger | null> {
  const row = await runWithOverloadRetry(() => db.prepare(
    `SELECT state, result_status,
            CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.error') END AS error,
            CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.catchUp') END AS catch_up_type
       FROM cron_slot_executions
      WHERE slot_key = ? AND slot_started_at = ?`,
  ).bind(scheduleKey, slotStartedAt).first<SlotExecutionProbeRow>());
  if (!row) return "never-delivered";
  // Only the stale-slot reconciler's platform-abandoned terminal is retried;
  // ordinary child errors and running slots belong to their own owner.
  return row.state === "finished" && row.result_status === "error"
    && row.error === STALE_SLOT_ERROR && row.catch_up_type == null
    ? "abandoned" : null;
}

/** One-shot per lane and slot: the marker only ever moves forward. */
async function claimSlotCatchUpMarker(
  db: D1Database,
  scheduleKey: SlotCatchUpScheduleKey,
  message: SlotCatchUpMessage,
): Promise<boolean> {
  const result = await runWithOverloadRetry(() => db.prepare(
    `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE COALESCE(CASE WHEN json_valid(cache.value) THEN json_extract(cache.value, '$.slotStartedAt') END, 0)
        < json_extract(excluded.value, '$.slotStartedAt')`,
  ).bind(getSlotCatchUpCacheKey(scheduleKey), JSON.stringify(message), message.armedAt).run());
  return (result.meta.changes ?? 0) === 1;
}

export interface SlotCatchUpArmOutcome {
  scheduleKey: SlotCatchUpScheduleKey;
  slotStartedAt: number;
  trigger: SlotCatchUpTrigger;
  disposition: "sent" | "send-failed";
}

/**
 * Zero-fetch detector for the five-minute poll: run after the stale-slot sweep
 * so a freshly reconciled abandonment is visible in the same invocation.
 */
export async function armDueSlotCatchUps(
  env: Pick<ScheduledEnv, "DB" | "RESERVE_CONTINUATION_QUEUE" | "WORKER_SLOT_CATCH_UP_MODE">,
  input: { invocationId: string; nowSec?: number; signal?: AbortSignal },
): Promise<SlotCatchUpArmOutcome[]> {
  if (env.WORKER_SLOT_CATCH_UP_MODE !== "on" || !env.RESERVE_CONTINUATION_QUEUE) return [];
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const outcomes: SlotCatchUpArmOutcome[] = [];
  for (const scheduleKey of SLOT_CATCH_UP_SCHEDULE_KEYS) {
    input.signal?.throwIfAborted();
    const slotStartedAt = resolveSlotCatchUpCandidate(scheduleKey, nowSec);
    if (slotStartedAt == null) continue;
    const trigger = await classifyMissedSlot(env.DB, scheduleKey, slotStartedAt);
    if (!trigger) continue;
    const message: SlotCatchUpMessage = {
      version: 1, kind: SLOT_CATCH_UP_MESSAGE_KIND, scheduleKey, slotStartedAt, trigger,
      armedAt: nowSec, armedByInvocationId: input.invocationId,
    };
    input.signal?.throwIfAborted();
    if (!await claimSlotCatchUpMarker(env.DB, scheduleKey, message)) continue;
    let disposition: SlotCatchUpArmOutcome["disposition"] = "sent";
    try {
      await env.RESERVE_CONTINUATION_QUEUE.send(message, { contentType: "json", delaySeconds: 0 });
    } catch (error) {
      // One-shot: a lost hint leaves the next natural slot as the fallback.
      disposition = "send-failed";
      logWorkerEvent({ scope: "handler", level: "warn", event: "scheduled-slot-catch-up-send-failed",
        message: "Slot catch-up hint could not be queued", metadata: { reason: "slot-catch-up-send-failed",
          scheduleKey, slotStartedAt, trigger }, error });
    }
    outcomes.push({ scheduleKey, slotStartedAt, trigger, disposition });
  }
  return outcomes;
}
