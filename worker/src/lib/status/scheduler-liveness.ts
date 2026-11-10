import {
  getScheduledLaneLivenessThresholds,
  STATUS_HEAVY_SCHEDULER_LIVENESS_THRESHOLDS,
  STATUS_SCHEDULER_LIVENESS_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { CRON_SLOT_EXECUTIONS_RETENTION_SEC } from "@shared/lib/retention-policy";
import type { SchedulerLiveness } from "@shared/types/status/public-health";
import { maxPublicStatus } from "@shared/lib/public-health";

const SCHEDULER_LIVENESS_LANES = [
  "fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll",
] as const satisfies readonly CronScheduleKey[];

// Resolve the fastest heavy-owned lane from the topology, never a public sentinel.
const HEAVY_LIVENESS_PLAN = Object.values(SCHEDULED_SLOT_PLANS)
  .filter((plan) => plan.worker === "heavy")
  .sort((a, b) => CRON_SCHEDULE_CADENCES[a.scheduleKey].intervalSec - CRON_SCHEDULE_CADENCES[b.scheduleKey].intervalSec)[0];

type ExpectedLaneObservation = NonNullable<SchedulerLiveness["expectedLanes"]>[number];

/**
 * Expected-vs-observed delivery for every scheduled slot plan. A lane whose 3x
 * cadence exceeds slot-start retention can never be proven fresh, so it is
 * omitted rather than alerted forever (mirrors the producer freshness rule).
 */
const EXPECTED_LIVENESS_PLANS = Object.values(SCHEDULED_SLOT_PLANS)
  .filter((plan) => CRON_SCHEDULE_CADENCES[plan.scheduleKey].intervalSec * 3 <= CRON_SLOT_EXECUTIONS_RETENTION_SEC)
  .sort((a, b) => (
    CRON_SCHEDULE_CADENCES[a.scheduleKey].intervalSec - CRON_SCHEDULE_CADENCES[b.scheduleKey].intervalSec
    || a.scheduleKey.localeCompare(b.scheduleKey)
  ));

interface SlotStarts {
  observed_at: number | null;
  last_any: number | null;
  reserve: number | null;
  telegram: number | null;
  digest: number | null;
  heavy: number | null;
  lanes: string | null;
}

function initialExpectedLanes(unavailableReason: string): ExpectedLaneObservation[] {
  return EXPECTED_LIVENESS_PLANS.map((plan) => ({
    scheduleKey: plan.scheduleKey,
    lastStartedAt: null,
    ageSeconds: null,
    ...getScheduledLaneLivenessThresholds(CRON_SCHEDULE_CADENCES[plan.scheduleKey].intervalSec),
    status: "unavailable",
    unavailableReason,
  }));
}

/** Parse the bounded JSON map of `slot_key -> MAX(started_at)`; a null lane clock recorded no start. */
function parseLaneStarts(value: unknown): Map<string, number> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const starts = new Map<string, number>();
    for (const [scheduleKey, clock] of Object.entries(parsed as Record<string, unknown>)) {
      if (clock === null) continue;
      // Per-lane clock validity is graded by observeExpectedLanes; only a
      // non-numeric or non-finite map is unreadable evidence.
      if (typeof clock !== "number" || !Number.isFinite(clock)) return null;
      starts.set(scheduleKey, clock);
    }
    return starts;
  } catch {
    return null;
  }
}

function observeExpectedLanes(
  observation: SchedulerLiveness,
  laneStarts: Map<string, number>,
  observedAt: number,
): void {
  if (!observation.expectedLanes) return;
  for (const lane of observation.expectedLanes) {
    const clock = laneStarts.get(lane.scheduleKey);
    if (clock == null) {
      lane.unavailableReason = "lane-slot-start-evidence-missing";
      continue;
    }
    if (!Number.isFinite(clock) || clock <= 0 || clock > observedAt) {
      lane.unavailableReason = "slot-start-clock-invalid";
      continue;
    }
    lane.lastStartedAt = clock;
    lane.ageSeconds = observedAt - clock;
    lane.unavailableReason = null;
    lane.status = lane.ageSeconds > lane.staleAfterSec ? "stale"
      : lane.ageSeconds > lane.warningAfterSec ? "degraded" : "healthy";
  }
}

/** Delivery evidence is an actual slot start, never a scheduled clock or completed child. */
export async function loadSchedulerLiveness(db: D1Database, now: number): Promise<SchedulerLiveness> {
  const observation: SchedulerLiveness = {
    // Caller time is diagnostic only until the query supplies its observation clock.
    status: "unavailable", observedAt: now,
    lastAnyStartedAt: null, lastFiveMinuteStartedAt: null, ageSeconds: null,
    ...STATUS_SCHEDULER_LIVENESS_THRESHOLDS,
    lanes: SCHEDULER_LIVENESS_LANES.map((scheduleKey) => ({ scheduleKey, lastStartedAt: null })),
    unavailableReason: null,
    heavy: {
      scheduleKey: HEAVY_LIVENESS_PLAN?.scheduleKey ?? null,
      lastStartedAt: null, ageSeconds: null,
      ...STATUS_HEAVY_SCHEDULER_LIVENESS_THRESHOLDS,
      status: "unavailable",
      unavailableReason: HEAVY_LIVENESS_PLAN ? null : "heavy-schedule-plan-missing",
    },
    expectedLanes: initialExpectedLanes("lane-slot-start-evidence-unreadable"),
  };
  try {
    const laneKeys = EXPECTED_LIVENESS_PLANS.map((plan) => plan.scheduleKey);
    // One correlated MAX per lane keeps every lookup an index seek; a
    // `GROUP BY slot_key` aggregate scans every retained row of each group on
    // this public/15-minute path.
    const row = await db.prepare(`SELECT
      (SELECT unixepoch()) AS observed_at,
      (SELECT MAX(started_at) FROM cron_slot_executions) AS last_any,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS reserve,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS telegram,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS digest,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS heavy,
      (SELECT json_group_object(slot_key, last_started_at) FROM (
         WITH lane(slot_key) AS (VALUES ${laneKeys.map(() => "(?)").join(", ")})
         SELECT lane.slot_key AS slot_key,
                (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = lane.slot_key) AS last_started_at
           FROM lane
       )) AS lanes`)
      .bind(...SCHEDULER_LIVENESS_LANES, observation.heavy.scheduleKey, ...laneKeys)
      .first<SlotStarts>();
    if (!row) {
      observation.unavailableReason = "slot-start-evidence-missing";
      if (HEAVY_LIVENESS_PLAN) observation.heavy.unavailableReason = "slot-start-evidence-missing";
      observation.expectedLanes = initialExpectedLanes("slot-start-evidence-missing");
      return observation;
    }
    if (typeof row.observed_at !== "number" || !Number.isFinite(row.observed_at) || row.observed_at <= 0) {
      observation.unavailableReason = "slot-start-query-failed";
      if (HEAVY_LIVENESS_PLAN) observation.heavy.unavailableReason = "slot-start-query-failed";
      observation.expectedLanes = initialExpectedLanes("slot-start-query-failed");
      return observation;
    }
    const observedAt = row.observed_at;
    observation.observedAt = observedAt;
    if (HEAVY_LIVENESS_PLAN) {
      observation.heavy.lastStartedAt = row.heavy ?? null;
      if (row.heavy == null) {
        observation.heavy.unavailableReason = "heavy-slot-start-evidence-missing";
      } else if (!Number.isFinite(row.heavy) || row.heavy <= 0 || row.heavy > observedAt) {
        observation.heavy.unavailableReason = "slot-start-clock-invalid";
        observation.heavy.lastStartedAt = null;
      } else {
        observation.heavy.ageSeconds = observedAt - row.heavy;
        observation.heavy.status = observation.heavy.ageSeconds > observation.heavy.staleAfterSec ? "stale"
          : observation.heavy.ageSeconds > observation.heavy.warningAfterSec ? "degraded" : "healthy";
      }
    }
    const laneStarts = parseLaneStarts(row.lanes);
    if (laneStarts) observeExpectedLanes(observation, laneStarts, observedAt);

    observation.lastAnyStartedAt = row.last_any;
    const starts = [row.reserve, row.telegram, row.digest];
    observation.lanes.forEach((lane, index) => { lane.lastStartedAt = starts[index]; });
    if ([row.last_any, ...starts].some((clock) => clock != null && (!Number.isFinite(clock) || clock <= 0 || clock > observedAt))) {
      observation.unavailableReason = "slot-start-clock-invalid";
      return observation;
    }
    const delivered = starts.filter((clock): clock is number => clock != null);
    if (row.last_any == null || delivered.length === 0) {
      observation.unavailableReason = "five-minute-slot-start-evidence-missing";
      return observation;
    }
    observation.lastFiveMinuteStartedAt = Math.max(...delivered);
    observation.ageSeconds = observedAt - observation.lastFiveMinuteStartedAt;
    observation.status = observation.ageSeconds > observation.staleAfterSec ? "stale"
      : observation.ageSeconds > observation.warningAfterSec ? "degraded" : "healthy";
    return observation;
  } catch {
    observation.unavailableReason = "slot-start-query-failed";
    if (HEAVY_LIVENESS_PLAN) observation.heavy.unavailableReason = "slot-start-query-failed";
    observation.expectedLanes = initialExpectedLanes("slot-start-query-failed");
    return observation;
  }
}

export function schedulerLivenessWarnings(observation: SchedulerLiveness): string[] {
  const warnings = observation.status === "healthy" ? [] : [observation.status === "unavailable"
    ? "scheduler_liveness_unavailable" : "scheduled_delivery_stalled"];
  if (observation.heavy.status !== "healthy") warnings.push(observation.heavy.status === "unavailable"
    ? "heavy_scheduler_liveness_unavailable" : "heavy_scheduled_delivery_stalled");
  return warnings;
}

export function schedulerLivenessImpactStatus(observation: SchedulerLiveness) {
  return maxPublicStatus(
    observation.status === "unavailable" ? "degraded" : observation.status,
    observation.heavy.status === "unavailable" ? "degraded" : observation.heavy.status,
  );
}
