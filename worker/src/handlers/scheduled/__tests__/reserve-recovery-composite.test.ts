import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";

const mocks = vi.hoisted(() => ({
  adapterFetch: vi.fn(),
  syncRedemptionBackstops: vi.fn(),
  syncKinesisSupply: vi.fn(),
}));

vi.mock("../../../cron/reserve-adapters/index", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../cron/reserve-adapters/index")>();
  return {
    ...original,
    getReserveAdapter(adapterKey: string) {
      const adapter = original.getReserveAdapter(adapterKey);
      return adapter ? { ...adapter, fetch: mocks.adapterFetch } : null;
    },
  };
});

vi.mock("../../../cron/sync-redemption-backstops", () => ({
  syncRedemptionBackstops: mocks.syncRedemptionBackstops,
}));

vi.mock("../../../cron/sync-kinesis-supply", () => ({
  syncKinesisSupply: mocks.syncKinesisSupply,
}));

import { LIVE_RESERVE_QUEUE_HASH, SYNC_ORDERED_CONFIGURED_COINS } from "../../../cron/sync-live-reserves-shared";
import {
  claimNextScheduledCheckpointRecovery,
  beginScheduledCheckpoint,
  prepareEligibleScheduledCheckpointRecoveries,
  prepareScheduledCheckpointRecoveryForSlot,
} from "../../../lib/scheduled-recovery-checkpoint";
import {
  armReserveRecoveryFaultInjection,
  ReserveRecoveryFaultInjectionTermination,
} from "../../../lib/reserve-recovery-fault-injection";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import type { ScheduledRuntimeContext } from "../context";
import { LIVE_RESERVE_SLOT_JOBS, runFourHourlyReserveSyncSlot } from "../hourly-live-reserves";

const WORKER_VERSION = "reserve-recovery-composite-v1";
const OLD_QUEUE_HASH = `old-${LIVE_RESERVE_QUEUE_HASH}`;
const CHECKPOINT_JOB = "sync-live-reserves";

function count(sqlite: DatabaseSync, sql: string, ...binds: unknown[]): number {
  const row = sqlite.prepare(sql).get(...(binds as never[])) as { count: number };
  return Number(row.count);
}

function checkpointBytes(sqlite: DatabaseSync, slotStartedAt: number): string {
  const rows = sqlite
    .prepare(
      `SELECT *
         FROM worker_scheduled_checkpoints
        WHERE schedule_key = 'fourHourlyReserveSync' AND slot_started_at = ?
        ORDER BY attempt_no`,
    )
    .all(slotStartedAt);
  return Buffer.from(JSON.stringify(rows)).toString("hex");
}

function markSlotAbandoned(sqlite: DatabaseSync, slotStartedAt: number, nowSec: number): void {
  sqlite
    .prepare(
      `INSERT INTO cron_slot_executions (
         slot_key, slot_started_at, state, result_status, execution_owner,
         execution_generation, invocation_id, worker_version, started_at,
         finished_at, updated_at, metadata
       ) VALUES (
         'fourHourlyReserveSync', ?, 'finished', 'error', 'slot-owner',
         1, 'slot-owner', ?, ?, ?, ?, '{}'
       )`,
    )
    .run(slotStartedAt, WORKER_VERSION, slotStartedAt, nowSec, nowSec);
}

function reconcile(db: D1Database, nowSec: number) {
  return prepareEligibleScheduledCheckpointRecoveries(db, {
    scheduleKey: "fourHourlyReserveSync",
    job: CHECKPOINT_JOB,
    childJobs: LIVE_RESERVE_SLOT_JOBS,
    expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
    staleAfterSec: 120,
    nowSec,
  });
}

function claim(db: D1Database, owner: string, nowSec: number) {
  return claimNextScheduledCheckpointRecovery(db, {
    job: CHECKPOINT_JOB,
    childJobs: LIVE_RESERVE_SLOT_JOBS,
    owner,
    leaseSec: 15 * 60,
    expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
    nowSec,
  });
}

function runtime(
  db: D1Database,
  slotStartedAt: number,
  startedJobs: string[],
  recoveryCheckpoint?: ScheduledRuntimeContext["recoveryCheckpoint"],
): ScheduledRuntimeContext {
  return {
    db,
    env: {
      DB: db,
      WORKER_RESERVE_FAULT_INJECTION_ENABLED: "true",
    } as ScheduledRuntimeContext["env"],
    ctx: {} as ExecutionContext,
    cron: "11 */4 * * *",
    scheduleKey: "fourHourlyReserveSync",
    scheduledTimeMs: slotStartedAt * 1_000,
    slotStartedAt,
    invocationId: recoveryCheckpoint?.invocationId ?? "slot-owner",
    workerVersion: WORKER_VERSION,
    jobAttemptNo: recoveryCheckpoint?.attemptNo ?? 1,
    producerKind: recoveryCheckpoint ? "scheduled-recovery" : "scheduled-job",
    ...(recoveryCheckpoint ? { recoveryCheckpoint } : {}),
    mintBurnDisabledIds: [],
    mintBurnDisabledSymbols: [],
    mintBurnFreshnessConfig: {} as ScheduledRuntimeContext["mintBurnFreshnessConfig"],
    coingeckoApiKey: null,
    alertWebhookUrl: null,
    chainRpcs: new Map(),
    runLeasedCron: async (job, run) => {
      startedJobs.push(job);
      return run(new AbortController().signal, async () => {});
    },
  };
}

describe("reserve recovery composite", () => {
  const databases: DatabaseSync[] = [];
  let nowMs: number;

  beforeEach(() => {
    vi.clearAllMocks();
    nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mocks.syncRedemptionBackstops.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.syncKinesisSupply.mockResolvedValue({ status: "ok", itemCount: 1 });
    mocks.adapterFetch.mockImplementation(async (_coin, config) => {
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter as LiveReserveAdapterKey];
      const allowedModes: readonly string[] | undefined =
        "validation" in definition ? definition.validation?.allowedFreshnessModes : undefined;
      const freshnessMode = allowedModes?.includes("verified")
        ? "verified"
        : (allowedModes?.[0] ?? (definition.evidenceClass === "independent" ? "verified" : "not-applicable"));
      return {
        slices: [{ name: "Cash", pct: 100, risk: "low" as const }],
        metadata: {
          freshnessMode,
          ...(freshnessMode === "verified" ? { sourceTimestamp: Math.floor(Date.now() / 1_000) } : {}),
          ...(freshnessMode === "unverified"
            ? { details: { freshnessSource: "composite-test", freshnessReason: "transport fixture" } }
            : {}),
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const sqlite of databases.splice(0)) sqlite.close();
  });

  it("repairs an authoritative item and then resumes interrupted sidecars exactly once", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    databases.push(sqlite);
    const nowSec = Math.floor(nowMs / 1_000);
    const slotStartedAt = nowSec - 60;
    const legacySlotStartedAt = slotStartedAt - 10_000;
    const targetCoin = SYNC_ORDERED_CONFIGURED_COINS[0];
    expect(targetCoin).toBeDefined();

    const legacy = await beginScheduledCheckpoint(db, {
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt: legacySlotStartedAt,
      job: CHECKPOINT_JOB,
      invocationId: "legacy-slot-owner",
      workerVersion: "legacy-worker",
      queueHash: OLD_QUEUE_HASH,
      nextItemKey: targetCoin!.id,
      itemsTotal: SYNC_ORDERED_CONFIGURED_COINS.length,
      childJobs: LIVE_RESERVE_SLOT_JOBS,
      nowSec: nowSec - 9_999,
    });
    await prepareScheduledCheckpointRecoveryForSlot(db, {
      scheduleKey: legacy.scheduleKey,
      slotStartedAt: legacy.slotStartedAt,
      job: legacy.job,
      childJobs: LIVE_RESERVE_SLOT_JOBS,
      nowSec: nowSec - 9_998,
    });
    const legacyBytesBefore = checkpointBytes(sqlite, legacySlotStartedAt);

    await armReserveRecoveryFaultInjection(db, {
      workerVersion: WORKER_VERSION,
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt,
      attemptNo: 1,
      killPoint: "after_authoritative_write",
      targetItemKey: targetCoin!.id,
      nowSec,
    });

    const startedJobs: string[] = [];
    await expect(runFourHourlyReserveSyncSlot(runtime(db, slotStartedAt, startedJobs))).rejects.toBeInstanceOf(
      ReserveRecoveryFaultInjectionTermination,
    );

    const authoritativeAttempt = sqlite
      .prepare(
        `SELECT c.attempt_id, s.pending_attempt_id
           FROM reserve_composition c
           JOIN reserve_sync_state s USING (stablecoin_id)
          WHERE c.stablecoin_id = ?`,
      )
      .get(targetCoin!.id) as { attempt_id: string; pending_attempt_id: string | null };
    expect(authoritativeAttempt).toMatchObject({
      attempt_id: expect.any(String),
      pending_attempt_id: null,
    });
    expect(
      count(
        sqlite,
        "SELECT COUNT(*) AS count FROM reserve_composition_history WHERE stablecoin_id = ?",
        targetCoin!.id,
      ),
    ).toBe(0);
    expect(
      count(
        sqlite,
        "SELECT COUNT(*) AS count FROM reserve_sync_attempt_history WHERE stablecoin_id = ?",
        targetCoin!.id,
      ),
    ).toBe(0);

    markSlotAbandoned(sqlite, slotStartedAt, nowSec + 1);
    const firstReconcile = await reconcile(db, nowSec + 2);
    expect(firstReconcile.prepared).toEqual([expect.objectContaining({ abandonedAttemptNo: 1, recoveryAttemptNo: 2 })]);
    await expect(reconcile(db, nowSec + 3)).resolves.toMatchObject({ prepared: [] });

    const secondAttempt = await claim(db, "recovery-owner-2", nowSec + 4);
    expect(secondAttempt).toMatchObject({
      attemptNo: 2,
      state: "recovering",
      nextItemKey: targetCoin!.id,
      currentDomainAttemptId: authoritativeAttempt.attempt_id,
    });

    await armReserveRecoveryFaultInjection(db, {
      workerVersion: WORKER_VERSION,
      scheduleKey: "fourHourlyReserveSync",
      slotStartedAt,
      attemptNo: 2,
      killPoint: "before_sync-kinesis-supply",
      targetItemKey: null,
      nowSec: nowSec + 4,
    });
    nowMs = (nowSec + 4) * 1_000;

    await expect(
      runFourHourlyReserveSyncSlot(runtime(db, slotStartedAt, startedJobs, secondAttempt!)),
    ).rejects.toBeInstanceOf(ReserveRecoveryFaultInjectionTermination);
    expect(mocks.syncRedemptionBackstops).toHaveBeenCalledTimes(1);
    expect(mocks.syncKinesisSupply).not.toHaveBeenCalled();
    expect(
      count(
        sqlite,
        "SELECT COUNT(*) AS count FROM reserve_composition_history WHERE stablecoin_id = ? AND attempt_id = ?",
        targetCoin!.id,
        authoritativeAttempt.attempt_id,
      ),
    ).toBe(1);
    expect(
      count(
        sqlite,
        "SELECT COUNT(*) AS count FROM reserve_sync_attempt_history WHERE stablecoin_id = ? AND attempt_id = ?",
        targetCoin!.id,
        authoritativeAttempt.attempt_id,
      ),
    ).toBe(1);

    const secondLeaseUntil = secondAttempt!.recoveryLeaseUntil!;
    const secondReconcile = await reconcile(db, secondLeaseUntil + 1);
    expect(secondReconcile.prepared).toEqual([
      expect.objectContaining({ abandonedAttemptNo: 2, recoveryAttemptNo: 3 }),
    ]);
    await expect(reconcile(db, secondLeaseUntil + 2)).resolves.toMatchObject({ prepared: [] });

    const thirdAttempt = await claim(db, "recovery-owner-3", secondLeaseUntil + 3);
    expect(thirdAttempt).toMatchObject({ attemptNo: 3, state: "recovering" });
    nowMs = (secondLeaseUntil + 3) * 1_000;

    const finalSummary = await runFourHourlyReserveSyncSlot(runtime(db, slotStartedAt, startedJobs, thirdAttempt!));

    expect(finalSummary).toMatchObject({ jobsErrored: 0, jobsSkipped: 0 });
    expect(mocks.syncRedemptionBackstops).toHaveBeenCalledTimes(1);
    expect(mocks.syncKinesisSupply).toHaveBeenCalledTimes(1);
    expect(startedJobs.filter((job) => job === "reserve-post-sync-watchdog")).toHaveLength(1);
    expect(mocks.adapterFetch.mock.calls.filter(([coin]) => coin.id === targetCoin!.id)).toHaveLength(1);

    expect(count(sqlite, "SELECT COUNT(*) AS count FROM reserve_composition")).toBe(
      SYNC_ORDERED_CONFIGURED_COINS.length,
    );
    expect(count(sqlite, "SELECT COUNT(*) AS count FROM reserve_composition_history")).toBe(
      SYNC_ORDERED_CONFIGURED_COINS.length,
    );
    expect(count(sqlite, "SELECT COUNT(*) AS count FROM reserve_sync_attempt_history")).toBe(
      SYNC_ORDERED_CONFIGURED_COINS.length,
    );
    expect(
      count(
        sqlite,
        `SELECT COUNT(*) AS count
         FROM (
           SELECT stablecoin_id, attempt_id
             FROM reserve_composition_history
            GROUP BY stablecoin_id, attempt_id
           HAVING COUNT(*) > 1
         )`,
      ),
    ).toBe(0);
    expect(
      count(
        sqlite,
        `SELECT COUNT(*) AS count
         FROM (
           SELECT stablecoin_id, attempt_id
             FROM reserve_sync_attempt_history
            GROUP BY stablecoin_id, attempt_id
           HAVING COUNT(*) > 1
         )`,
      ),
    ).toBe(0);
    expect(
      sqlite.prepare("SELECT attempt_id FROM reserve_composition WHERE stablecoin_id = ?").get(targetCoin!.id),
    ).toEqual({ attempt_id: authoritativeAttempt.attempt_id });

    expect(count(sqlite, "SELECT COUNT(*) AS count FROM reserve_sync_state WHERE pending_attempt_id IS NOT NULL")).toBe(
      0,
    );
    expect(
      count(
        sqlite,
        `SELECT COUNT(*) AS count
         FROM worker_scheduled_checkpoints
        WHERE slot_started_at = ? AND state IN ('running', 'ready', 'recovering')`,
        slotStartedAt,
      ),
    ).toBe(0);
    expect(
      sqlite
        .prepare(
          `SELECT state, recovery_owner, recovery_lease_until, current_domain_attempt_id
         FROM worker_scheduled_checkpoints
        WHERE slot_started_at = ? AND attempt_no = 3`,
        )
        .get(slotStartedAt),
    ).toEqual({
      state: "completed",
      recovery_owner: null,
      recovery_lease_until: null,
      current_domain_attempt_id: null,
    });
    expect(count(sqlite, "SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'ops:reserve-recovery:fault:v1:%'")).toBe(
      0,
    );
    await expect(claim(db, "recovery-owner-4", secondLeaseUntil + 4)).resolves.toBeNull();
    expect(checkpointBytes(sqlite, legacySlotStartedAt)).toBe(legacyBytesBefore);
  }, 30_000);
});
