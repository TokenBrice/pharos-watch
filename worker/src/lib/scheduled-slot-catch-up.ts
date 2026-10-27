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
import { sweepStaleScheduledSlotExecutions } from "./scheduled-slot-fence";
import { resolveScheduledSlotPolicy } from "./scheduled-slot-policy";
import { logWorkerEvent } from "./structured-log";

function getSlotCatchUpCacheKey(scheduleKey: SlotCatchUpScheduleKey): string {
  return `scheduled-catch-up:${scheduleKey}`;
}

interface DueSlotProbeRow {
  slot_key: SlotCatchUpScheduleKey;
  slot_started_at: number;
  state: string | null;
  result_status: string | null;
  started_at: number | null;
  updated_at: number | null;
  error: string | null;
  catch_up_type: string | null;
  armed_slot_started_at: number | null;
}

/**
 * One indexed read for every due lane: each slot row and each lane's
 * one-shot marker are primary-key lookups.
 */
async function probeDueSlots(
  db: D1Database,
  due: readonly { scheduleKey: SlotCatchUpScheduleKey; slotStartedAt: number }[],
): Promise<DueSlotProbeRow[]> {
  const rows = await runWithOverloadRetry(() => db.prepare(
    `WITH due(slot_key, slot_started_at, marker_key) AS (VALUES ${due.map(() => "(?, ?, ?)").join(", ")})
     SELECT due.slot_key, due.slot_started_at, slot.state, slot.result_status, slot.started_at, slot.updated_at,
            CASE WHEN json_valid(slot.metadata) THEN json_extract(slot.metadata, '$.error') END AS error,
            CASE WHEN json_valid(slot.metadata) THEN json_type(slot.metadata, '$.catchUp') END AS catch_up_type,
            (SELECT CASE WHEN json_valid(marker.value) THEN json_extract(marker.value, '$.slotStartedAt') END
               FROM cache marker WHERE marker.key = due.marker_key) AS armed_slot_started_at
       FROM due
       LEFT JOIN cron_slot_executions slot
         ON slot.slot_key = due.slot_key AND slot.slot_started_at = due.slot_started_at`,
  ).bind(...due.flatMap(({ scheduleKey, slotStartedAt }) => [
    scheduleKey, slotStartedAt, getSlotCatchUpCacheKey(scheduleKey),
  ])).all<DueSlotProbeRow>());
  return rows.results ?? [];
}

function classifyMissedSlot(row: DueSlotProbeRow): SlotCatchUpTrigger | null {
  if (row.state == null) return "never-delivered";
  // Only the stale-slot reconciler's platform-abandoned terminal is retried;
  // ordinary child errors and running slots belong to their own owner.
  return row.state === "finished" && row.result_status === "error"
    && row.error === STALE_SLOT_ERROR && row.catch_up_type == null
    ? "abandoned" : null;
}

/** The shared stale policy already lets any invocation reconcile this row. */
function isStaleRunningSlot(row: DueSlotProbeRow, nowSec: number): boolean {
  if (row.state !== "running" || row.updated_at == null || row.started_at == null) return false;
  const policy = resolveScheduledSlotPolicy(row.slot_key);
  return row.updated_at <= nowSec - policy.slotSilenceSec || row.started_at <= nowSec - policy.hardDeadSec;
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
 * Zero-fetch detector shared by the five-minute digest poll and the
 * one-minute reserve-recovery lane. Outside every lane's window it touches no
 * D1 at all; otherwise it costs one indexed read. `reconcileStale` lets the
 * minute lane reconcile the due slot itself (one targeted sweep, only when
 * that row is already stale), so abandonment does not wait for a late poll.
 * The forward-only marker and the slot fence make concurrent hosts safe.
 */
export async function armDueSlotCatchUps(
  env: Pick<ScheduledEnv, "DB" | "RESERVE_CONTINUATION_QUEUE" | "WORKER_SLOT_CATCH_UP_MODE">,
  input: { invocationId: string; nowSec?: number; signal?: AbortSignal; reconcileStale?: boolean },
): Promise<SlotCatchUpArmOutcome[]> {
  if (env.WORKER_SLOT_CATCH_UP_MODE !== "on" || !env.RESERVE_CONTINUATION_QUEUE) return [];
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const due = SLOT_CATCH_UP_SCHEDULE_KEYS.flatMap((scheduleKey) => {
    const slotStartedAt = resolveSlotCatchUpCandidate(scheduleKey, nowSec);
    return slotStartedAt == null ? [] : [{ scheduleKey, slotStartedAt }];
  });
  if (due.length === 0) return [];
  input.signal?.throwIfAborted();
  const outcomes: SlotCatchUpArmOutcome[] = [];
  for (const row of await probeDueSlots(env.DB, due)) {
    input.signal?.throwIfAborted();
    const scheduleKey = row.slot_key;
    const slotStartedAt = row.slot_started_at;
    if (row.armed_slot_started_at != null && row.armed_slot_started_at >= slotStartedAt) continue;
    let trigger = classifyMissedSlot(row);
    if (!trigger && input.reconcileStale && isStaleRunningSlot(row, nowSec)) {
      const sweep = await sweepStaleScheduledSlotExecutions(env.DB, {
        slotKey: scheduleKey, limit: 1, nowSec, signal: input.signal,
      });
      trigger = sweep.abandonedSlots.some((slot) =>
        slot.slotKey === scheduleKey && slot.slotStartedAt === slotStartedAt) ? "abandoned" : null;
    }
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

/** Host wrapper: detection never fails or delays the host lane's own work. */
export async function runSlotCatchUpDetection(
  env: Pick<ScheduledEnv, "DB" | "RESERVE_CONTINUATION_QUEUE" | "WORKER_SLOT_CATCH_UP_MODE">,
  input: { host: "digest-poll" | "minute-lane"; invocationId: string; signal?: AbortSignal; reconcileStale?: boolean },
): Promise<void> {
  try {
    const armed = await armDueSlotCatchUps(env, input);
    if (armed.length > 0) {
      logWorkerEvent({ scope: "handler", level: "info", event: "scheduled-slot-catch-up-armed",
        message: "Armed one-shot catch-ups for missed scheduled slots", metadata: { host: input.host, armed } });
    }
  } catch (error) {
    logWorkerEvent({ scope: "handler", level: "warn", event: "scheduled-slot-catch-up-arm-failed",
      message: "Missed-slot catch-up detection did not complete",
      metadata: { reason: "slot-catch-up-arm-failed", host: input.host }, error });
  }
}
