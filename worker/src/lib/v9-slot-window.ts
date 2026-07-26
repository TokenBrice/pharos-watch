import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { sleepWithSignal } from "./abort";
import {
  runCronWithLease,
  runWithOverloadRetry,
} from "./cron-lease";
import type { CronResult } from "./cron-logger";

interface CoreSlotRow {
  state: string;
  result_status: string | null;
  worker_version: string | null;
}

interface CompetingSlotRow {
  slot_key: string;
  slot_started_at: number;
  state: string;
  updated_at: number;
}

export interface V9SlotWindowOptions {
  db: D1Database;
  scheduledTimeMs: number | null;
  slotStartedAt: number;
  workerVersion: string | null;
  signal?: AbortSignal;
  deadlineOffsetMs: number;
  minimumRemainingMs: number;
  lane: string;
  currentSlotKey: string;
}

interface V9MemoryLaneRow {
  lease_until: number;
}

export const V9_MEMORY_LANE_LEASE_KEY =
  "worker-memory-lane:safety-score-v9";
const V9_MEMORY_LANE_POLL_MS = 1_000;
const V9_MEMORY_LANE_TTL_MARGIN_SEC = 30;

function neutralSkip(
  reason: string,
  metadata: Record<string, unknown>,
): CronResult {
  return {
    status: "skipped_neutral",
    itemCount: 0,
    metadata: JSON.stringify({ reason, ...metadata }),
    productivity: {
      productive: false,
      reason,
    },
  };
}

function degradedAdmission(
  reason: string,
  metadata: Record<string, unknown>,
): CronResult {
  return {
    status: "degraded",
    itemCount: 0,
    metadata: JSON.stringify({ reason, ...metadata }),
    productivity: {
      productive: false,
      reason,
    },
  };
}

async function hasActiveV9MemoryLane(
  db: D1Database,
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1_000);
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT lease_until
           FROM cron_leases
          WHERE job = ?
            AND lease_until >= ?`,
      )
      .bind(V9_MEMORY_LANE_LEASE_KEY, nowSec)
      .first<V9MemoryLaneRow>(),
  );
  return row != null;
}

/**
 * Keeps later scheduled triggers from loading their runner graphs while a
 * memory-intensive V9 slot owns the shared Worker heap lane.
 */
export async function waitForV9MemoryLaneRelease(
  db: D1Database,
  signal?: AbortSignal,
): Promise<void> {
  while (await hasActiveV9MemoryLane(db)) {
    await sleepWithSignal(V9_MEMORY_LANE_POLL_MS, signal);
  }
}

/**
 * Admits private V9 work only after the matching public quarter-hour slot has
 * completed on the active Worker version, no other scheduled slot is active,
 * and while an absolute pre-quarter execution window remains. The V9 lane
 * lease is acquired before the competing-slot query, so later triggers wait
 * before loading their job graphs and earlier triggers make V9 skip.
 */
export async function runV9AfterCoreWithinWindow(
  options: V9SlotWindowOptions,
  run: (signal: AbortSignal) => Promise<CronResult>,
): Promise<CronResult> {
  const scheduledTimeMs =
    options.scheduledTimeMs ?? options.slotStartedAt * 1_000;
  const scheduledTimeSec = Math.floor(scheduledTimeMs / 1_000);
  const coreSlotStartedAt = Math.floor(scheduledTimeSec / 900) * 900;
  const deadlineMs = scheduledTimeMs + options.deadlineOffsetMs;
  const initialRemainingMs = deadlineMs - Date.now();

  if (initialRemainingMs < options.minimumRemainingMs) {
    return neutralSkip("v9-slot-window-too-short", {
      lane: options.lane,
      coreSlotStartedAt,
      remainingMs: Math.max(0, initialRemainingMs),
      minimumRemainingMs: options.minimumRemainingMs,
    });
  }

  if (!options.workerVersion?.trim()) {
    return degradedAdmission("v9-worker-version-unavailable", {
      lane: options.lane,
      coreSlotStartedAt,
    });
  }

  const timeout = createTimeoutSignal({
    timeoutMs: initialRemainingMs,
    timeoutReason: new DOMException(
      `${options.lane} exceeded its pre-quarter execution window`,
      "TimeoutError",
    ),
    parentSignal: options.signal,
  });
  try {
    const laneLease = await runCronWithLease(
      options.db,
      V9_MEMORY_LANE_LEASE_KEY,
      async ({ signal }) => {
        const coreSlot = await options.db
          .prepare(
            `SELECT state, result_status, worker_version
               FROM cron_slot_executions
              WHERE slot_key = 'quarterHourly'
                AND slot_started_at = ?`,
          )
          .bind(coreSlotStartedAt)
          .first<CoreSlotRow>();

        if (
          coreSlot?.state !== "finished" ||
          coreSlot.result_status !== "ok" ||
          coreSlot.worker_version !== options.workerVersion
        ) {
          return neutralSkip("v9-core-slot-not-ready", {
            lane: options.lane,
            coreSlotStartedAt,
            coreState: coreSlot?.state ?? null,
            coreResultStatus: coreSlot?.result_status ?? null,
            coreWorkerVersion: coreSlot?.worker_version ?? null,
            expectedWorkerVersion: options.workerVersion,
          });
        }

        const competingSlot = await options.db
          .prepare(
            `SELECT slot_key, slot_started_at, state, updated_at
               FROM cron_slot_executions
              WHERE state IN ('running', 'reconciling')
                AND NOT (
                  slot_key = ?
                  AND slot_started_at = ?
                )
                AND updated_at >= ?
              ORDER BY updated_at DESC
              LIMIT 1`,
          )
          .bind(
            options.currentSlotKey,
            options.slotStartedAt,
            coreSlotStartedAt - 35 * 60,
          )
          .first<CompetingSlotRow>();
        if (competingSlot) {
          return neutralSkip("v9-competing-slot-active", {
            lane: options.lane,
            coreSlotStartedAt,
            competingSlotKey: competingSlot.slot_key,
            competingSlotStartedAt: competingSlot.slot_started_at,
            competingSlotState: competingSlot.state,
            competingSlotUpdatedAt: competingSlot.updated_at,
          });
        }

        const remainingMs = deadlineMs - Date.now();
        if (remainingMs < options.minimumRemainingMs) {
          return neutralSkip("v9-slot-window-too-short", {
            lane: options.lane,
            coreSlotStartedAt,
            remainingMs: Math.max(0, remainingMs),
            minimumRemainingMs: options.minimumRemainingMs,
          });
        }

        return run(signal);
      },
      {
        abortSignal: timeout.signal,
        ttlSec:
          Math.ceil(options.deadlineOffsetMs / 1_000) +
          V9_MEMORY_LANE_TTL_MARGIN_SEC,
        heartbeatSec: 15,
      },
    );
    if (laneLease.status === "skipped_locked") {
      return neutralSkip("v9-memory-lane-active", {
        lane: options.lane,
        coreSlotStartedAt,
      });
    }
    return laneLease.result!;
  } finally {
    timeout.dispose();
  }
}
