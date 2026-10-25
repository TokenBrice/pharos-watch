import {
  getCronSlotStartedAtForSchedule,
  getCronSlotStartedAtForTrigger,
  V9_PUBLICATION_SECOND_CHANCE,
} from "@shared/lib/cron-jobs";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { sleepWithSignal } from "./abort";
import {
  runCronWithLease,
} from "./cron-lease-primitives";
import {
  runWithOverloadRetry,
} from "./d1-overload-retry";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "./safety-score-v9/publication-cache-keys";
import type { CronResult } from "./cron-logger";

interface CoreSlotRow {
  state: string;
  result_status: string | null;
  worker_version: string | null;
}

interface StablecoinsPublicationRow {
  published_at: number;
}

interface ActiveV9SlotRow {
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
  /** Skip neutrally while this core window's V9 publication slot is still due. */
  yieldToV9Publication?: boolean;
  /** The :52 second chance: skip neutrally once this hour has an accepted publication. */
  v9PublicationSecondChance?: boolean;
  /** Recover accepted bytes under the same lease/window instead of compiling again. */
  onV9PublicationAlreadyAccepted?: (signal: AbortSignal, window: V9ExecutionWindow) => Promise<CronResult>;
}

export interface V9ExecutionWindow {
  slotStartedAtSec: number;
  deadlineMs: number;
  minimumRemainingMs: number;
}

interface V9MemoryLaneRow {
  lease_until: number;
}

export const V9_MEMORY_LANE_LEASE_KEY =
  "worker-memory-lane:safety-score-v9";
const V9_MEMORY_LANE_POLL_MS = 1_000;
const V9_MEMORY_LANE_TTL_MARGIN_SEC = 30;

export const V9_EXECUTION_WINDOW_POLICY = {
  // 10s usable publisher floor plus its 15s persistence/settlement reserve.
  publication: { deadlineOffsetMs: 3 * 60_000, minimumRemainingMs: 25_000 },
  supplyAttribution: { deadlineOffsetMs: 3 * 60_000, minimumRemainingMs: 60_000 },
} as const;

/** The pre-quarter clamp applies equally to admission and capture provenance. */
export function getV9ExecutionDeadlineMs(scheduledTimeMs: number, deadlineOffsetMs: number): number {
  const nextCoreSlotStartedAt = Math.floor(scheduledTimeMs / 900_000) * 900 + 900;
  return Math.min(scheduledTimeMs + deadlineOffsetMs, nextCoreSlotStartedAt * 1_000);
}

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
 * The publication-evidence join deliberately ignores `worker_version`: a
 * deploy routinely lands between the quarter-hourly core slot finishing and
 * the next V9 lane trigger, and requiring the publishing Worker to still be
 * the current one turned every such deploy into a false
 * `v9-core-slot-not-ready` skip. The freshness guarantee is carried entirely
 * by the slot-window bounds plus the live-cache join — the row must be a
 * published `sync-stablecoins` generation from this slot that is still the
 * current `stablecoins` cache generation — so a stale or no-write run cannot
 * match regardless of which Worker version wrote it.
 */
export async function loadMatchingCoreStablecoinsPublishedAt(
  db: D1Database,
  coreSlotStartedAt: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const nextCoreSlotStartedAt = coreSlotStartedAt + 15 * 60;
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT publication.published_at
           FROM surface_publication_generations publication
           JOIN cache stablecoins_cache
             ON stablecoins_cache.key = 'stablecoins'
            AND stablecoins_cache.updated_at = publication.published_at
          WHERE publication.surface = 'stablecoins'
            AND publication.state = 'published'
            AND publication.producer_schedule_key = 'quarterHourly'
            AND publication.producer_job = 'sync-stablecoins'
            AND publication.artifact_cache_key = 'stablecoins'
            AND publication.started_at >= ?
            AND publication.started_at < ?
            AND publication.published_at >= ?
            AND publication.published_at < ?
          ORDER BY publication.started_at DESC
          LIMIT 1`,
      )
      .bind(
        coreSlotStartedAt,
        nextCoreSlotStartedAt,
        coreSlotStartedAt,
        nextCoreSlotStartedAt,
      )
      .first<StablecoinsPublicationRow>(),
    3, signal);
  return row?.published_at ?? null;
}

export const V9_PUBLICATION_HEALTH_CACHE_KEY = SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth;

/**
 * Accepted clock of a publication accepted since the top of this second-chance
 * slot's hour, or null. Accepted clocks are scoring clocks, never later than
 * the run that published them, so every earlier hour's publication (including
 * the previous :52) falls before the boundary. A :22 run that could only admit
 * a previous-hour capture is therefore retried with the fresher :46 capture.
 * Read failures throw; callers must not treat them as "nothing accepted".
 */
export async function loadV9PublicationHourAcceptedAtSec(
  db: D1Database,
  secondChanceSlotStartedAt: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const hourStartedAt = secondChanceSlotStartedAt - V9_PUBLICATION_SECOND_CHANCE.offsetSec;
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT json_extract(value, '$.acceptedAtSec') AS accepted_at
           FROM cache
          WHERE key = ?`,
      )
      .bind(V9_PUBLICATION_HEALTH_CACHE_KEY)
      .first<{ accepted_at: number | null }>(),
    3, signal);
  const acceptedAtSec = row?.accepted_at;
  return typeof acceptedAtSec === "number" && acceptedAtSec >= hourStartedAt ? acceptedAtSec : null;
}

/**
 * The publisher and supply attribution share one memory lane, and a late
 * publication trigger (:22/:52) can land on attribution's :23/:53 start; the
 * first to claim the lease wins and the other skips. Losing an attribution run
 * costs one 15-minute refresh, losing a publication costs a public Safety
 * Score slot, so attribution yields while this core window's publication slot
 * has no finished row and its execution window is still open. The :52 second
 * chance counts only while its hour still lacks an accepted publication.
 */
async function loadDueV9PublicationSlot(
  db: D1Database,
  scheduledTimeMs: number,
  coreSlotStartedAt: number,
): Promise<{ slotStartedAt: number; state: string | null; deadlineMs: number } | null> {
  let slotStartedAt = getCronSlotStartedAtForSchedule("v9PublicationOffset", scheduledTimeMs);
  const secondChance = slotStartedAt < coreSlotStartedAt;
  if (secondChance) {
    slotStartedAt = getCronSlotStartedAtForTrigger(
      "v9PublicationOffset", V9_PUBLICATION_SECOND_CHANCE.trigger, scheduledTimeMs,
    );
  }
  const deadlineMs = getV9ExecutionDeadlineMs(
    slotStartedAt * 1_000, V9_EXECUTION_WINDOW_POLICY.publication.deadlineOffsetMs,
  );
  if (slotStartedAt < coreSlotStartedAt || Date.now() >= deadlineMs) return null;
  if (secondChance && await loadV9PublicationHourAcceptedAtSec(db, slotStartedAt) != null) return null;
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT state
           FROM cron_slot_executions
          WHERE slot_key = 'v9PublicationOffset'
            AND slot_started_at = ?`,
      )
      .bind(slotStartedAt)
      .first<{ state: string }>(),
  );
  if (row?.state === "finished") return null;
  return { slotStartedAt, state: row?.state ?? null, deadlineMs };
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
 * Admits canonical V9 work only after the matching public quarter-hour slot
 * has completed on the active Worker version, or when the durable publication
 * ledger proves that this slot's `sync-stablecoins` run published the current
 * stablecoins cache generation (whichever Worker version wrote it), and while
 * an absolute pre-quarter execution window remains. This keeps an isolated
 * parent-slot terminal-row failure — or a deploy landing between the core slot
 * and this trigger — from starving V9 without allowing a stale/no-write
 * stablecoin run through. The shared V9 lane lease serializes V9 work and
 * keeps later triggers from loading their job graphs. A prior active
 * invocation of the same V9 schedule lane still fails closed, while unrelated
 * scheduled slots cannot suppress canonical publication.
 */
export async function runV9AfterCoreWithinWindow(
  options: V9SlotWindowOptions,
  run: (signal: AbortSignal, window: V9ExecutionWindow) => Promise<CronResult>,
): Promise<CronResult> {
  const scheduledTimeMs =
    options.scheduledTimeMs ?? options.slotStartedAt * 1_000;
  const scheduledTimeSec = Math.floor(scheduledTimeMs / 1_000);
  const coreSlotStartedAt = Math.floor(scheduledTimeSec / 900) * 900;
  const deadlineMs = getV9ExecutionDeadlineMs(scheduledTimeMs, options.deadlineOffsetMs);
  const effectiveWindowMs = Math.max(0, deadlineMs - scheduledTimeMs);
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
  const workerVersion = options.workerVersion;

  let recoverAcceptedPublication = false;
  if (options.v9PublicationSecondChance) {
    let acceptedAtSec: number | null;
    try {
      acceptedAtSec = await loadV9PublicationHourAcceptedAtSec(options.db, options.slotStartedAt, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return degradedAdmission("v9-publication-second-chance-unknown", {
        lane: options.lane,
        coreSlotStartedAt,
        code: error instanceof Error ? error.name : "Error",
      });
    }
    if (acceptedAtSec != null && !options.onV9PublicationAlreadyAccepted) {
      return neutralSkip("v9-publication-hourly-already-accepted", {
        lane: options.lane,
        coreSlotStartedAt,
        acceptedAtSec,
      });
    }
    recoverAcceptedPublication = acceptedAtSec != null;
  }

  if (options.yieldToV9Publication) {
    let duePublication: Awaited<ReturnType<typeof loadDueV9PublicationSlot>>;
    try {
      duePublication = await loadDueV9PublicationSlot(options.db, scheduledTimeMs, coreSlotStartedAt);
    } catch (error) {
      return degradedAdmission("v9-publication-priority-unknown", {
        lane: options.lane,
        coreSlotStartedAt,
        code: error instanceof Error ? error.name : "Error",
      });
    }
    if (duePublication) {
      return neutralSkip("v9-publication-priority", {
        lane: options.lane,
        coreSlotStartedAt,
        publicationSlotStartedAt: duePublication.slotStartedAt,
        publicationSlotState: duePublication.state,
        publicationDeadlineMs: duePublication.deadlineMs,
      });
    }
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
        const coreSlot = recoverAcceptedPublication ? null : await options.db
          .prepare(
            `SELECT state, result_status, worker_version
               FROM cron_slot_executions
              WHERE slot_key = 'quarterHourly'
                AND slot_started_at = ?`,
          )
          .bind(coreSlotStartedAt)
          .first<CoreSlotRow>();

        let coreStablecoinsPublicationMatched = false;
        try {
          coreStablecoinsPublicationMatched =
            !recoverAcceptedPublication && (await loadMatchingCoreStablecoinsPublishedAt(
              options.db,
              coreSlotStartedAt,
              signal,
            )) != null;
        } catch (error) {
          return degradedAdmission(
            "v9-core-publication-evidence-unavailable",
            {
              lane: options.lane,
              coreSlotStartedAt,
              code: error instanceof Error ? error.name : "Error",
            },
          );
        }
        const degradedCorePublicationMatched =
          coreSlot?.state === "finished" &&
          coreSlot.result_status === "degraded" &&
          coreSlot.worker_version === workerVersion &&
          coreStablecoinsPublicationMatched;
        const coreSlotReady =
          coreSlot?.state === "finished" &&
          coreSlot.result_status === "ok" &&
          coreSlot.worker_version === workerVersion;

        if (
          !recoverAcceptedPublication && !coreSlotReady &&
          !coreStablecoinsPublicationMatched
        ) {
          return neutralSkip("v9-core-slot-not-ready", {
            lane: options.lane,
            coreSlotStartedAt,
            coreState: coreSlot?.state ?? null,
            coreResultStatus: coreSlot?.result_status ?? null,
            coreWorkerVersion: coreSlot?.worker_version ?? null,
            expectedWorkerVersion: workerVersion,
            coreStablecoinsPublicationMatched,
            degradedCorePublicationMatched,
          });
        }

        const activeV9Slot = await options.db
          .prepare(
            `SELECT slot_key, slot_started_at, state, updated_at
               FROM cron_slot_executions
              WHERE slot_key = ?
                AND slot_started_at != ?
                AND state IN ('running', 'reconciling')
                AND updated_at >= ?
              ORDER BY updated_at DESC
              LIMIT 1`,
          )
          .bind(
            options.currentSlotKey,
            options.slotStartedAt,
            // Matches the largest slot-fence stale window (6 minutes): a
            // competing row whose heartbeat is older than that has either been
            // reconciled already or is about to be, so it must not suppress
            // this lane for the half hour the old 35-minute bind allowed.
            coreSlotStartedAt - 6 * 60,
          )
          .first<ActiveV9SlotRow>();
        if (activeV9Slot) {
          return neutralSkip("v9-competing-slot-active", {
            lane: options.lane,
            coreSlotStartedAt,
            competingSlotKey: activeV9Slot.slot_key,
            competingSlotStartedAt: activeV9Slot.slot_started_at,
            competingSlotState: activeV9Slot.state,
            competingSlotUpdatedAt: activeV9Slot.updated_at,
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

        const execute = recoverAcceptedPublication ? options.onV9PublicationAlreadyAccepted! : run;
        return execute(signal, {
          slotStartedAtSec: options.slotStartedAt,
          deadlineMs,
          minimumRemainingMs: options.minimumRemainingMs,
        });
      },
      {
        abortSignal: timeout.signal,
        // Contention skips neutrally: waiting attribution could occupy the
        // publisher's inherited pre-quarter execution window.
        ttlSec:
          Math.ceil(effectiveWindowMs / 1_000) +
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
    if (laneLease.result === undefined) {
      throw new Error(`${options.lane} lease completed without a result`);
    }
    return laneLease.result;
  } finally {
    timeout.dispose();
  }
}
