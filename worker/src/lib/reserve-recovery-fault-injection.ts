import type { ScheduledRecoveryCheckpoint } from "./scheduled-recovery-checkpoint";
import { runWithOverloadRetry } from "./d1-overload-retry";

export const RESERVE_RECOVERY_FAULT_KILL_POINTS = [
  "after_checkpoint",
  "after_pending_begin",
  "after_authoritative_write",
  "before_sync-redemption-backstops",
  "before_sync-kinesis-supply",
  "before_reserve-post-sync-watchdog",
] as const;

export type ReserveRecoveryFaultKillPoint = (typeof RESERVE_RECOVERY_FAULT_KILL_POINTS)[number];

export interface ReserveRecoveryFaultInjectionSpec {
  workerVersion: string;
  scheduleKey: "fourHourlyReserveSync";
  slotStartedAt: number;
  attemptNo: number;
  killPoint: ReserveRecoveryFaultKillPoint;
  targetItemKey: string | null;
  armedAt: number;
  expiresAt: number;
}

export interface ReserveRecoveryFaultInjectionController {
  readonly spec: ReserveRecoveryFaultInjectionSpec;
  trigger(killPoint: ReserveRecoveryFaultKillPoint, targetItemKey?: string | null): Promise<void>;
}

const FAULT_CACHE_PREFIX = "ops:reserve-recovery:fault:v1";
const FAULT_TTL_SEC = 6 * 60 * 60;
const ABRUPT_FAULT_MARKER = "reserve-recovery-preview-abrupt-termination";

function faultCacheKey(identity: Pick<ReserveRecoveryFaultInjectionSpec, "scheduleKey" | "slotStartedAt" | "attemptNo">): string {
  return `${FAULT_CACHE_PREFIX}:${identity.scheduleKey}:${identity.slotStartedAt}:${identity.attemptNo}`;
}

function parseSpec(value: string): ReserveRecoveryFaultInjectionSpec | null {
  try {
    const parsed = JSON.parse(value) as Partial<ReserveRecoveryFaultInjectionSpec>;
    if (
      typeof parsed.workerVersion !== "string"
      || parsed.scheduleKey !== "fourHourlyReserveSync"
      || !Number.isInteger(parsed.slotStartedAt)
      || !Number.isInteger(parsed.attemptNo)
      || !RESERVE_RECOVERY_FAULT_KILL_POINTS.includes(parsed.killPoint as ReserveRecoveryFaultKillPoint)
      || (parsed.targetItemKey !== null && typeof parsed.targetItemKey !== "string")
      || !Number.isInteger(parsed.armedAt)
      || !Number.isInteger(parsed.expiresAt)
    ) {
      return null;
    }
    return parsed as ReserveRecoveryFaultInjectionSpec;
  } catch {
    return null;
  }
}

export class ReserveRecoveryFaultInjectionTermination extends Error {
  readonly faultInjectionMarker = ABRUPT_FAULT_MARKER;
  readonly spec: ReserveRecoveryFaultInjectionSpec;

  constructor(spec: ReserveRecoveryFaultInjectionSpec) {
    super(
      `Preview reserve recovery fault injected at ${spec.killPoint} for ${spec.scheduleKey}@${spec.slotStartedAt}#${spec.attemptNo}`,
    );
    this.name = "ReserveRecoveryFaultInjectionTermination";
    this.spec = spec;
  }
}

export function isReserveRecoveryFaultInjectionTermination(
  error: unknown,
): error is ReserveRecoveryFaultInjectionTermination {
  return error instanceof ReserveRecoveryFaultInjectionTermination
    || (typeof error === "object" && error !== null
      && (error as { faultInjectionMarker?: unknown }).faultInjectionMarker === ABRUPT_FAULT_MARKER);
}

export async function armReserveRecoveryFaultInjection(
  db: D1Database,
  input: Omit<ReserveRecoveryFaultInjectionSpec, "armedAt" | "expiresAt"> & { nowSec?: number },
): Promise<{ armed: boolean; spec: ReserveRecoveryFaultInjectionSpec }> {
  const timestamp = input.nowSec ?? Math.floor(Date.now() / 1000);
  const spec: ReserveRecoveryFaultInjectionSpec = {
    workerVersion: input.workerVersion,
    scheduleKey: input.scheduleKey,
    slotStartedAt: input.slotStartedAt,
    attemptNo: input.attemptNo,
    killPoint: input.killPoint,
    targetItemKey: input.targetItemKey,
    armedAt: timestamp,
    expiresAt: timestamp + FAULT_TTL_SEC,
  };
  const key = faultCacheKey(spec);
  await runWithOverloadRetry(() =>
    db.prepare("DELETE FROM cache WHERE key = ? AND updated_at < ?")
      .bind(key, timestamp - FAULT_TTL_SEC)
      .run(),
  );
  const result = await runWithOverloadRetry(() =>
    db.prepare("INSERT OR IGNORE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify(spec), timestamp)
      .run(),
  );
  return { armed: (result.meta.changes ?? 0) === 1, spec };
}

export async function loadReserveRecoveryFaultInjectionController(
  db: D1Database,
  checkpoint: Pick<
    ScheduledRecoveryCheckpoint,
    "scheduleKey" | "slotStartedAt" | "attemptNo" | "workerVersion"
  >,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<ReserveRecoveryFaultInjectionController | null> {
  const key = faultCacheKey({
    scheduleKey: checkpoint.scheduleKey as "fourHourlyReserveSync",
    slotStartedAt: checkpoint.slotStartedAt,
    attemptNo: checkpoint.attemptNo,
  });
  const row = await runWithOverloadRetry(() =>
    db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>(),
  );
  if (!row) return null;
  const spec = parseSpec(row.value);
  if (
    !spec
    || spec.expiresAt < nowSec
    || spec.workerVersion !== checkpoint.workerVersion
    || spec.scheduleKey !== checkpoint.scheduleKey
    || spec.slotStartedAt !== checkpoint.slotStartedAt
    || spec.attemptNo !== checkpoint.attemptNo
  ) {
    if (!spec || spec.expiresAt < nowSec) {
      await runWithOverloadRetry(() =>
        db.prepare("DELETE FROM cache WHERE key = ? AND value = ?").bind(key, row.value).run(),
      );
    }
    return null;
  }

  let consumed = false;
  return {
    spec,
    async trigger(killPoint, targetItemKey = null) {
      if (consumed || spec.killPoint !== killPoint) return;
      if (spec.targetItemKey !== (targetItemKey ?? null)) return;
      const result = await runWithOverloadRetry(() =>
        db.prepare("DELETE FROM cache WHERE key = ? AND value = ?").bind(key, row.value).run(),
      );
      if ((result.meta.changes ?? 0) !== 1) return;
      consumed = true;
      throw new ReserveRecoveryFaultInjectionTermination(spec);
    },
  };
}
