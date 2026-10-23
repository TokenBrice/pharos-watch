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
 * Windows derive from the lane's cadence I: grace = min(2I/5, 10 min) and
 * next-slot margin = min(I/5, 15 min), which keeps the reviewed quarterHourly
 * (6/3 min) and two-hourly yield (10/15 min) windows.
 * The 10-minute grace cap covers the observed delivery lag plus the six-minute
 * long-runner slot silence; the 15-minute margin cap exceeds every catch-up
 * lane's task timeout (at most 13 minutes), so a lane of 75 minutes or longer
 * admits its full timeout before its next natural slot.
 */
const SLOT_CATCH_UP_GRACE_CAP_SEC = 10 * 60;
const SLOT_CATCH_UP_NEXT_SLOT_MARGIN_CAP_SEC = 15 * 60;

export function deriveSlotCatchUpPolicy(scheduleKey: CronScheduleKey): SlotCatchUpPolicy {
  const { intervalSec } = CRON_SCHEDULE_CADENCES[scheduleKey];
  return {
    graceSec: Math.min(Math.floor(intervalSec * 2 / 5), SLOT_CATCH_UP_GRACE_CAP_SEC),
    nextSlotMarginSec: Math.min(Math.floor(intervalSec / 5), SLOT_CATCH_UP_NEXT_SLOT_MARGIN_CAP_SEC),
  };
}

/**
 * Opt-in lanes for the one-shot missed-slot catch-up. The executor is the
 * public Queue consumer (configured 300 s CPU), never a sub-hourly cron lane:
 * these runners are measured to exceed Cloudflare's 30-second sub-hourly class.
 * `fourHourlyReserveSync` is deliberately absent: the five-minute
 * reserve-recovery lane already sweeps its abandoned slot and replays the
 * checkpoint under the same slot identity, so a catch-up reopen would race it.
 * Heavy-Worker lanes are absent because the heavy Worker has no Queue.
 */
const SLOT_CATCH_UP_LANES = [
  "quarterHourly",
  "halfHourlyMintBurnCritical",
  "dewsPsiOffset",
  "hourlyYieldSync",
  "twoHourlyDexDiscovery",
] as const satisfies readonly CronScheduleKey[];

export type SlotCatchUpScheduleKey = (typeof SLOT_CATCH_UP_LANES)[number];
export const SLOT_CATCH_UP_POLICIES: Readonly<Record<SlotCatchUpScheduleKey, SlotCatchUpPolicy>> = Object.freeze(
  Object.fromEntries(SLOT_CATCH_UP_LANES.map((scheduleKey) => [scheduleKey, deriveSlotCatchUpPolicy(scheduleKey)])) as
    Record<SlotCatchUpScheduleKey, SlotCatchUpPolicy>,
);
export const SLOT_CATCH_UP_SCHEDULE_KEYS: readonly SlotCatchUpScheduleKey[] = SLOT_CATCH_UP_LANES;

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
