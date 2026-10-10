import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS, SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS } from "./cron-timeouts";

const LONG_RUNNERS = [
  "fiveMinuteReserveRecovery", "sixHourlyBlacklist", "halfHourlyMintBurnCritical",
  "twoHourlyDexDiscovery", "halfHourlyMintBurnExtended", "fourHourlyReserveSync",
  "hourlyYieldSync", "fourHourlyYieldSupplemental", "daily0300Utc", "daily0800Utc",
  "daily0805Utc", "daily0810Utc", "monthlyYieldAudit",
] as const satisfies readonly CronScheduleKey[];
const longRunners: Readonly<Record<string, true>> = Object.fromEntries(LONG_RUNNERS.map((key) => [key, true]));
for (const key of LONG_RUNNERS) {
  if (!SCHEDULED_SLOT_PLANS[key]) throw new Error(`Unregistered scheduled slot policy: ${key}`);
}

export type ScheduledSlotPolicy = {
  readonly heartbeatSec: number;
  readonly slotSilenceSec: number;
  readonly childSilenceSec: number;
  readonly hardDeadSec: number;
};
const DEFAULT_POLICY: ScheduledSlotPolicy = Object.freeze({
  heartbeatSec: 60, slotSilenceSec: 300, childSilenceSec: 300,
  hardDeadSec: (SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS) / 1000,
});
const LONG_POLICY: ScheduledSlotPolicy = Object.freeze({ ...DEFAULT_POLICY, slotSilenceSec: 360 });
export function resolveScheduledSlotPolicy(scheduleKey: string): ScheduledSlotPolicy {
  return longRunners[scheduleKey] ? LONG_POLICY : DEFAULT_POLICY;
}
/** Bound values only; filter by this expression before LIMIT, then repeat in CAS. */
export function scheduledSlotSilenceSql(column = "slot_key"): { sql: string; bindings: string[] } {
  return { sql: `CASE WHEN ${column} IN (${LONG_RUNNERS.map(() => "?").join(", ")}) THEN ${LONG_POLICY.slotSilenceSec} ELSE ${DEFAULT_POLICY.slotSilenceSec} END`, bindings: [...LONG_RUNNERS] };
}
