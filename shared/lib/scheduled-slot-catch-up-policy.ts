import { CRON_SCHEDULE_CADENCES } from "./cron-cadences";
import { getCronSlotStartedAtForSchedule, type CronScheduleKey } from "./cron-jobs";
import { SCHEDULED_SLOT_PLANS, SCHEDULED_TASK_DESCRIPTORS } from "./scheduled-runner-registry";

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
 * T+10 (off the :05 measured-execution collision) and the two-hourly
 * hourlyYieldSync between T+10 and T+105, at least 15 minutes before its next
 * natural slot.
 */
export const SLOT_CATCH_UP_POLICIES = {
  quarterHourly: { graceSec: 6 * 60, nextSlotMarginSec: 3 * 60 },
  hourlyYieldSync: { graceSec: 10 * 60, nextSlotMarginSec: 15 * 60 },
} as const satisfies Partial<Record<CronScheduleKey, SlotCatchUpPolicy>>;

export type SlotCatchUpScheduleKey = keyof typeof SLOT_CATCH_UP_POLICIES;
export const SLOT_CATCH_UP_SCHEDULE_KEYS = Object.keys(SLOT_CATCH_UP_POLICIES) as SlotCatchUpScheduleKey[];

for (const scheduleKey of SLOT_CATCH_UP_SCHEDULE_KEYS) {
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

/**
 * A catch-up holds the single-concurrency Queue consumer for at most the
 * lane's own longest task timeout, and never past its next natural slot.
 * This bounds the latency it can add to reserve continuation hints.
 */
export function resolveSlotCatchUpDeadlineMs(
  scheduleKey: SlotCatchUpScheduleKey,
  slotStartedAt: number,
  eventEntryMs: number,
): number {
  const laneTimeoutMs = Math.max(...SCHEDULED_TASK_DESCRIPTORS
    .filter((descriptor) => descriptor.scheduleKey === scheduleKey)
    .map((descriptor) => descriptor.timeoutMs));
  const nextSlotAtMs = (slotStartedAt + CRON_SCHEDULE_CADENCES[scheduleKey].intervalSec) * 1000;
  return Math.min(eventEntryMs + laneTimeoutMs, nextSlotAtMs);
}
