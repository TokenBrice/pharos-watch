import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  createD1JobAttemptStore,
  createWorkerJobAttempt,
  finishWorkerJobAttempt,
  loadWorkerJobAttemptHealth,
  normalizeWorkerJobLedgerMode,
  recordWorkerJobAttemptLease,
  shouldRecordWorkerJobAttempt,
} from "../job-ledger";

describe("worker job attempt ledger", () => {
  it("normalizes mode and allowlist controls", () => {
    expect(normalizeWorkerJobLedgerMode(undefined)).toBe("off");
    expect(normalizeWorkerJobLedgerMode("shadow")).toBe("shadow");
    expect(normalizeWorkerJobLedgerMode("WRITE")).toBe("write");
    expect(normalizeWorkerJobLedgerMode("enabled")).toBe("off");

    expect(shouldRecordWorkerJobAttempt({ mode: "off", allowlist: [], job: "sync-yield-data" })).toBe(false);
    expect(shouldRecordWorkerJobAttempt({ mode: "shadow", allowlist: [], job: "sync-yield-data" })).toBe(true);
    expect(shouldRecordWorkerJobAttempt({ mode: "shadow", allowlist: ["sync-yield-data"], job: "sync-yield-data" })).toBe(true);
    expect(shouldRecordWorkerJobAttempt({ mode: "shadow", allowlist: ["sync-stablecoins"], job: "sync-yield-data" })).toBe(false);
    expect(shouldRecordWorkerJobAttempt({ mode: "shadow", allowlist: ["*"], job: "sync-yield-data" })).toBe(true);
  });

  it("creates deterministic idempotency keys for scheduled slots", async () => {
    const db = mockD1();
    const identity = await createWorkerJobAttempt(db, {
      scheduleKey: "hourlyYieldSync",
      job: "sync-yield-data",
      slotStartedAt: 1_775_890_000,
      nowSec: 1_775_890_010,
    });

    expect(identity).toEqual({
      attemptId: "attempt|scheduled-slot|hourlyYieldSync|1775890000|sync-yield-data|1",
      idempotencyKey: "scheduled-slot|hourlyYieldSync|1775890000|sync-yield-data|1",
      attemptNo: 1,
    });
    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT OR IGNORE INTO worker_job_attempts"));
    expect(insert?.binds).toEqual([
      identity.attemptId,
      identity.idempotencyKey,
      "hourlyYieldSync",
      "sync-yield-data",
      1_775_890_000,
      "scheduled-slot",
      1,
      1_775_890_010,
      1_775_890_010,
      1_775_890_010,
    ]);
  });

  it("exposes a D1-backed queue-ready attempt store contract", async () => {
    const db = mockD1();
    const store = createD1JobAttemptStore(db);

    const identity = await store.createAttempt({
      scheduleKey: "daily0800Utc",
      job: "snapshot-public-dataset",
      slotStartedAt: 1_775_900_000,
      producerKind: "workflow-probe",
      nowSec: 1_775_900_010,
    });
    await store.claimAttempt({
      attemptId: identity.attemptId,
      owner: "future-consumer",
      nowSec: 1_775_900_020,
    });
    await store.heartbeatAttempt({
      attemptId: identity.attemptId,
      progress: { stage: "queued-adapter-smoke", itemsDone: 1 },
      nowSec: 1_775_900_030,
    });
    await store.finishAttempt({
      attemptId: identity.attemptId,
      startedAtMs: Date.now(),
      nowSec: 1_775_900_040,
      result: { status: "ok", itemCount: 1 },
    });

    expect(identity).toEqual({
      attemptId: "attempt|workflow-probe|daily0800Utc|1775900000|snapshot-public-dataset|1",
      idempotencyKey: "workflow-probe|daily0800Utc|1775900000|snapshot-public-dataset|1",
      attemptNo: 1,
    });
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT OR IGNORE INTO worker_job_attempts"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("SET state = 'running'"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("last_heartbeat_at = ?"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("status_class = ?"))).toBe(true);
  });

  it("classifies budget-truncated cron results as deferred attempts", async () => {
    const db = mockD1();
    await finishWorkerJobAttempt(db, {
      attemptId: "attempt-a",
      startedAtMs: Date.now(),
      nowSec: 1_775_890_100,
      result: {
        status: "degraded",
        itemCount: 20,
        metadata: JSON.stringify({ runBudgetTruncated: true, processed: 20 }),
      },
    });

    const update = db.getHistory().find((entry) => entry.sql.includes("UPDATE worker_job_attempts"));
    expect(update?.binds[0]).toBe("deferred");
    expect(update?.binds[1]).toBe("deferred");
    expect(update?.binds[4]).toBe(20);
  });

  it("records lease owner and lease_until from cron lease state", async () => {
    const db = mockD1();
    await recordWorkerJobAttemptLease(db, {
      attemptId: "attempt-a",
      owner: "lease-owner-a",
      leaseUntil: 1_775_890_500,
      nowSec: 1_775_890_100,
    });

    const update = db.getHistory().find((entry) => entry.sql.includes("lease_until = ?"));
    expect(update?.binds.slice(0, 7)).toEqual([
      "lease-owner-a",
      1_775_890_500,
      1_775_890_100,
      1_775_890_100,
      1_775_890_100,
      1_775_890_100,
      "attempt-a",
    ]);
  });

  it("loads latest per-job attempts and active/stale counters", async () => {
    const db = mockD1([
      {
        match: "ROW_NUMBER() OVER",
        rows: [{
          attempt_id: "attempt-a",
          idempotency_key: "scheduled-slot|hourlyYieldSync|1775890000|sync-yield-data|1",
          schedule_key: "hourlyYieldSync",
          job: "sync-yield-data",
          slot_started_at: 1_775_890_000,
          producer_kind: "scheduled-slot",
          state: "running",
          status_class: null,
          attempt_no: 1,
          owner: "owner-a",
          queued_at: 1_775_890_000,
          claimed_at: 1_775_890_001,
          started_at: 1_775_890_001,
          last_heartbeat_at: 1_775_890_050,
          finished_at: null,
          updated_at: 1_775_890_050,
          duration_ms: null,
          item_count: 12,
          result_metadata_json: JSON.stringify({ progress: { stage: "evaluation" } }),
          error: null,
        }],
      },
      {
        match: "COUNT(*) AS active_count",
        rows: [],
        first: { active_count: 2, stale_count: 1 },
      },
    ]);

    const health = await loadWorkerJobAttemptHealth(db, ["sync-yield-data"], 1_775_890_100);

    expect(health.queryFailed).toBe(false);
    expect(health.activeAttempts).toBe(2);
    expect(health.staleAttempts).toBe(1);
    expect(health.latestByJob.get("sync-yield-data")).toMatchObject({
      attemptId: "attempt-a",
      state: "running",
      stale: false,
      itemCount: 12,
      metadata: { progress: { stage: "evaluation" } },
    });
  });
});
