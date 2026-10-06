import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { getCronSlotStartedAtForSchedule, type CronScheduleKey } from "@shared/lib/cron-jobs";
import { RESERVE_RECOVERY_HEAVY_SLOT_KEYS } from "@shared/lib/scheduled-runner-registry";
import { resolveLiveReserveSyncBudgetConfig } from "../cron/sync-live-reserves-config";
import { CRON_TIMEOUT_MS, SCHEDULED_SLOT_JOB_BUDGET_MS } from "./cron-timeouts";
import { runWithOverloadRetry } from "./d1-overload-retry";

export const CRON_LEASE_TTL_ALLOWANCE_SEC = 60;
export const RESERVE_RECOVERY_CLAIM_SEC = 15 * 60;
export const RESERVE_CONFIG_RECOVERY_LEASE_SEC = 180;
export const RESERVE_PRODUCER_FINALIZATION_MARGIN_MS = 35_000;
export const RESERVE_PRODUCER_WAIT_MAX_MS = 4 * 60_000;

export interface ReserveRecoveryPollIdentity {
  invocationId?: string;
  scheduleKey?: string;
  slotStartedAt?: number;
}

export type ReserveProducerPriority = {
  reason: "producer-slot-priority" | "heavy-slot-co-tenancy";
  scheduleKey: CronScheduleKey;
  slotStartedAt: number;
  observedAt: number;
  lookaheadSec: number;
  condition: "next-slot-lookahead" | "current-slot-unfinished" | "heavy-slot-running";
};

export function getReserveRecoveryLookaheadSec(): number {
  return Math.ceil(resolveLiveReserveSyncBudgetConfig().runBudgetMs / 1000)
    + Math.max(RESERVE_RECOVERY_CLAIM_SEC,
      Math.ceil(CRON_TIMEOUT_MS["sync-live-reserves"] / 1000) + CRON_LEASE_TTL_ALLOWANCE_SEC,
      RESERVE_CONFIG_RECOVERY_LEASE_SEC);
}

/** Shared by preflight and both mutation fences; database time closes read/write races. */
export function reserveRecoveryAdmissionSql(clockSql = "unixepoch()") {
  const { intervalSec, offsetSec } = CRON_SCHEDULE_CADENCES.fourHourlyReserveSync;
  const current = `(${clockSql} - ((${clockSql} - ? + ?) % ?))`;
  return {
    sql: `(${current} + ? - ${clockSql} > ?)
      AND EXISTS (SELECT 1 FROM cron_slot_executions
        WHERE slot_key = ? AND slot_started_at = ${current}
          AND state = 'finished' AND finished_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM cron_slot_executions
        WHERE slot_key IN (${RESERVE_RECOVERY_HEAVY_SLOT_KEYS.map(() => "?").join(", ")})
          AND state = 'running' AND started_at > ${clockSql} - ? AND started_at <= ${clockSql})`,
    binds: [offsetSec, intervalSec, intervalSec, intervalSec, getReserveRecoveryLookaheadSec(),
      "fourHourlyReserveSync", offsetSec, intervalSec, intervalSec,
      ...RESERVE_RECOVERY_HEAVY_SLOT_KEYS, SCHEDULED_SLOT_JOB_BUDGET_MS / 1000],
  };
}

export async function getReserveProducerPriority(
  db: D1Database,
  observedAt = Math.floor(Date.now() / 1000),
): Promise<ReserveProducerPriority | null> {
  const scheduleKey = "fourHourlyReserveSync";
  const current = getCronSlotStartedAtForSchedule(scheduleKey, observedAt * 1000);
  const next = current + CRON_SCHEDULE_CADENCES.fourHourlyReserveSync.intervalSec;
  const lookaheadSec = getReserveRecoveryLookaheadSec();
  if (next - observedAt <= lookaheadSec) {
    return { reason: "producer-slot-priority", scheduleKey, slotStartedAt: next, observedAt, lookaheadSec, condition: "next-slot-lookahead" };
  }
  const row = await runWithOverloadRetry(() => db.prepare(
    "SELECT state, finished_at FROM cron_slot_executions WHERE slot_key = ? AND slot_started_at = ?",
  ).bind(scheduleKey, current).first<{ state: string; finished_at: number | null }>());
  if (!row || row.state !== "finished" || row.finished_at == null) {
    return { reason: "producer-slot-priority", scheduleKey, slotStartedAt: current, observedAt, lookaheadSec, condition: "current-slot-unfinished" };
  }
  const heavy = await runWithOverloadRetry(() => db.prepare(
    `SELECT slot_key, slot_started_at FROM cron_slot_executions
      WHERE slot_key IN (${RESERVE_RECOVERY_HEAVY_SLOT_KEYS.map(() => "?").join(", ")})
        AND state = 'running' AND started_at > ? AND started_at <= ?
      ORDER BY started_at DESC, slot_key ASC LIMIT 1`,
  ).bind(...RESERVE_RECOVERY_HEAVY_SLOT_KEYS, observedAt - SCHEDULED_SLOT_JOB_BUDGET_MS / 1000, observedAt)
    .first<{ slot_key: CronScheduleKey; slot_started_at: number }>());
  return heavy ? { reason: "heavy-slot-co-tenancy", scheduleKey: heavy.slot_key, slotStartedAt: heavy.slot_started_at,
    observedAt, lookaheadSec, condition: "heavy-slot-running" } : null;
}

export function createReserveLeaseOwner(
  leaseId: string,
  holderJob: string,
  path: string,
  identity: ReserveRecoveryPollIdentity & { producerKind?: string },
): string {
  return JSON.stringify({ version: 1, leaseId, holderJob, path,
    invocationId: identity.invocationId ?? null, scheduleKey: identity.scheduleKey ?? null,
    slotStartedAt: identity.slotStartedAt ?? null, producerKind: identity.producerKind ?? "scheduled-recovery" });
}
