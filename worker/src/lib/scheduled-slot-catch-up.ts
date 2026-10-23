import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { getCronSlotStartedAtForSchedule, type CronScheduleKey } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import {
  SLOT_CATCH_UP_MESSAGE_KIND,
  type SlotCatchUpMessage,
  type SlotCatchUpTrigger,
} from "@shared/types/slot-catch-up";
import type { ScheduledEnv } from "./env";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { STALE_SLOT_ERROR } from "./scheduled-slot-reconciliation";
import { logWorkerEvent } from "./structured-log";

export interface SlotCatchUpPolicy {
  /** Arm only once the slot is this late without a live or finished execution. */
  readonly graceSec: number;
  /** Never start this close to the lane's next natural slot. */
  readonly nextSlotMarginSec: number;
}

/**
 * Opt-in lanes for the one-shot missed-slot catch-up. The executor is the
 * public Queue consumer (configured 300 s CPU), never a sub-hourly cron lane:
 * these runners are measured to exceed Cloudflare's 30-second sub-hourly class.
 * Windows are chosen so the five-minute digest poll arms quarterHourly only at
 * T+10 (off the :05 measured-execution collision) and hourlyYieldSync between
 * T+10 and T+45.
 */
export const SLOT_CATCH_UP_POLICIES = {
  quarterHourly: { graceSec: 6 * 60, nextSlotMarginSec: 3 * 60 },
  hourlyYieldSync: { graceSec: 10 * 60, nextSlotMarginSec: 15 * 60 },
} as const satisfies Partial<Record<CronScheduleKey, SlotCatchUpPolicy>>;

export type SlotCatchUpScheduleKey = keyof typeof SLOT_CATCH_UP_POLICIES;

for (const scheduleKey of Object.keys(SLOT_CATCH_UP_POLICIES) as SlotCatchUpScheduleKey[]) {
  // The only consumer is the public Worker's Queue handler.
  if (SCHEDULED_SLOT_PLANS[scheduleKey].worker !== "public") {
    throw new Error(`Slot catch-up lane ${scheduleKey} must be owned by the public Worker`);
  }
  const policy = SLOT_CATCH_UP_POLICIES[scheduleKey];
  if (policy.graceSec + policy.nextSlotMarginSec >= CRON_SCHEDULE_CADENCES[scheduleKey].intervalSec) {
    throw new Error(`Slot catch-up window for ${scheduleKey} is empty`);
  }
}

export function getSlotCatchUpPolicy(scheduleKey: string): SlotCatchUpPolicy | null {
  return Object.prototype.hasOwnProperty.call(SLOT_CATCH_UP_POLICIES, scheduleKey)
    ? SLOT_CATCH_UP_POLICIES[scheduleKey as SlotCatchUpScheduleKey]
    : null;
}

export function getSlotCatchUpCacheKey(scheduleKey: SlotCatchUpScheduleKey): string {
  return `scheduled-catch-up:${scheduleKey}`;
}

/** The one slot of this lane that may be caught up at `nowSec`, or null. */
export function resolveSlotCatchUpCandidate(scheduleKey: SlotCatchUpScheduleKey, nowSec: number): number | null {
  const policy = SLOT_CATCH_UP_POLICIES[scheduleKey];
  const slotStartedAt = getCronSlotStartedAtForSchedule(scheduleKey, (nowSec - policy.graceSec) * 1000);
  return isSlotCatchUpWithinWindow(scheduleKey, slotStartedAt, nowSec) ? slotStartedAt : null;
}

export function isSlotCatchUpWithinWindow(scheduleKey: string, slotStartedAt: number, nowSec: number): boolean {
  const policy = getSlotCatchUpPolicy(scheduleKey);
  if (!policy) return false;
  const nextSlotAt = slotStartedAt + CRON_SCHEDULE_CADENCES[scheduleKey as SlotCatchUpScheduleKey].intervalSec;
  return nowSec >= slotStartedAt + policy.graceSec && nowSec <= nextSlotAt - policy.nextSlotMarginSec;
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
  for (const scheduleKey of Object.keys(SLOT_CATCH_UP_POLICIES) as SlotCatchUpScheduleKey[]) {
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
