import { STATUS_SCHEDULER_LIVENESS_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import type { SchedulerLiveness } from "@shared/types/status/public-health";

const SCHEDULER_LIVENESS_LANES = [
  "fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll",
] as const satisfies readonly CronScheduleKey[];

interface SlotStarts {
  last_any: number | null;
  reserve: number | null;
  telegram: number | null;
  digest: number | null;
}

/** Delivery evidence is an actual slot start, never a scheduled clock or completed child. */
export async function loadSchedulerLiveness(db: D1Database, now: number): Promise<SchedulerLiveness> {
  const observation: SchedulerLiveness = {
    status: "unavailable", observedAt: now,
    lastAnyStartedAt: null, lastFiveMinuteStartedAt: null, ageSeconds: null,
    ...STATUS_SCHEDULER_LIVENESS_THRESHOLDS,
    lanes: SCHEDULER_LIVENESS_LANES.map((scheduleKey) => ({ scheduleKey, lastStartedAt: null })),
    unavailableReason: null,
  };
  try {
    const row = await db.prepare(`SELECT
      (SELECT MAX(started_at) FROM cron_slot_executions) AS last_any,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS reserve,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS telegram,
      (SELECT MAX(started_at) FROM cron_slot_executions WHERE slot_key = ?) AS digest`)
      .bind(...SCHEDULER_LIVENESS_LANES).first<SlotStarts>();
    if (!row) {
      observation.unavailableReason = "slot-start-evidence-missing";
      return observation;
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
    return observation;
  }
}

export function schedulerLivenessWarnings(observation: SchedulerLiveness): string[] {
  return observation.status === "healthy" ? [] : [observation.status === "unavailable"
    ? "scheduler_liveness_unavailable" : "scheduled_delivery_stalled"];
}
