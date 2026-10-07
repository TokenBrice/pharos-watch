import { STATUS_HEAVY_SCHEDULER_LIVENESS_THRESHOLDS, STATUS_SCHEDULER_LIVENESS_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import type { SchedulerLiveness } from "@shared/types/status/public-health";
import { maxPublicStatus } from "@shared/lib/public-health";

const SCHEDULER_LIVENESS_LANES = [
  "fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll",
] as const satisfies readonly CronScheduleKey[];

// Resolve the fastest heavy-owned lane from the topology, never a public sentinel.
const HEAVY_LIVENESS_PLAN = Object.values(SCHEDULED_SLOT_PLANS)
  .filter((plan) => plan.worker === "heavy")
  .sort((a, b) => CRON_SCHEDULE_CADENCES[a.scheduleKey].intervalSec - CRON_SCHEDULE_CADENCES[b.scheduleKey].intervalSec)[0];

interface SlotStarts {
  last_any: number | null;
  reserve: number | null;
  telegram: number | null;
  digest: number | null;
  heavy: number | null;
}

/** Delivery evidence is an actual slot start, never a scheduled clock or completed child. */
export async function loadSchedulerLiveness(db: D1Database, now: number): Promise<SchedulerLiveness> {
  const observation: SchedulerLiveness = {
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
  };
  try {
    const row = await db.prepare(`SELECT
      (SELECT MAX(started_at) FROM cron_slot_executions) AS last_any,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS reserve,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS telegram,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS digest,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS heavy`)
      .bind(...SCHEDULER_LIVENESS_LANES, observation.heavy.scheduleKey).first<SlotStarts>();
    if (!row) {
      observation.unavailableReason = "slot-start-evidence-missing";
      if (HEAVY_LIVENESS_PLAN) observation.heavy.unavailableReason = "slot-start-evidence-missing";
      return observation;
    }
    if (HEAVY_LIVENESS_PLAN) {
      observation.heavy.lastStartedAt = row.heavy ?? null;
      if (row.heavy == null) {
        observation.heavy.unavailableReason = "heavy-slot-start-evidence-missing";
      } else if (!Number.isFinite(row.heavy) || row.heavy <= 0 || row.heavy > now) {
        observation.heavy.unavailableReason = "slot-start-clock-invalid";
        observation.heavy.lastStartedAt = null;
      } else {
        observation.heavy.ageSeconds = now - row.heavy;
        observation.heavy.status = observation.heavy.ageSeconds > observation.heavy.staleAfterSec ? "stale"
          : observation.heavy.ageSeconds > observation.heavy.warningAfterSec ? "degraded" : "healthy";
      }
    }
    observation.lastAnyStartedAt = row.last_any;
    const starts = [row.reserve, row.telegram, row.digest];
    observation.lanes.forEach((lane, index) => { lane.lastStartedAt = starts[index]; });
    if ([row.last_any, ...starts].some((clock) => clock != null && (!Number.isFinite(clock) || clock <= 0 || clock > now))) {
      observation.unavailableReason = "slot-start-clock-invalid";
      return observation;
    }
    const delivered = starts.filter((clock): clock is number => clock != null);
    if (row.last_any == null || delivered.length === 0) {
      observation.unavailableReason = "five-minute-slot-start-evidence-missing";
      return observation;
    }
    observation.lastFiveMinuteStartedAt = Math.max(...delivered);
    observation.ageSeconds = now - observation.lastFiveMinuteStartedAt;
    observation.status = observation.ageSeconds > observation.staleAfterSec ? "stale"
      : observation.ageSeconds > observation.warningAfterSec ? "degraded" : "healthy";
    return observation;
  } catch {
    observation.unavailableReason = "slot-start-query-failed";
    if (HEAVY_LIVENESS_PLAN) observation.heavy.unavailableReason = "slot-start-query-failed";
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
