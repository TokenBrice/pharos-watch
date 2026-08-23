import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

type LeaseRow = {
  job: string;
  lease_owner: string;
  lease_until: number;
  heartbeat_at: number;
  updated_at: number;
};

type SlotExecutionRow = {
  slot_key: string;
  slot_started_at: number;
  state: string;
  result_status: string | null;
  execution_owner: string;
  execution_generation?: number;
  invocation_id?: string | null;
  worker_version?: string | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
  metadata: string | null;
};

type ProgressRow = {
  job: string;
  started_at: number;
  updated_at: number;
  stage: string | null;
  lease_owner: string | null;
  slot_started_at: number | null;
};

type CronRunRow = {
  job: string;
  started_at: number;
  duration_ms: number;
  status: string;
  error: string | null;
  metadata: string | null;
  slot_started_at: number | null;
};

type CacheRow = {
  key: string;
  value: string;
  updated_at: number;
};

interface TestLeaseDb extends D1Database {
  sqlite: DatabaseSync;
  getSlot: (slotKey: string, slotStartedAt: number) => SlotExecutionRow | undefined;
  getLease: (job: string) => LeaseRow | undefined;
  getProgress: (job: string) => ProgressRow | undefined;
  getRuns: () => CronRunRow[];
  getCache: (key: string) => CacheRow | undefined;
}

const openLeaseDatabases: DatabaseSync[] = [];

/** Closes every sqlite handle `makeLeaseDb` opened since the last call. */
export function closeOpenLeaseDatabases(): void {
  for (const sqlite of openLeaseDatabases.splice(0)) sqlite.close();
}

/** Mutates a seeded slot row mid-statement, standing in for a racing worker. */
export function setSlotUpdatedAt(
  sqlite: DatabaseSync,
  slotKey: string,
  slotStartedAt: number,
  updatedAt: number,
): void {
  sqlite
    .prepare(
      "UPDATE cron_slot_executions SET updated_at = ? WHERE slot_key = ? AND slot_started_at = ?",
    )
    .run(updatedAt, slotKey, slotStartedAt);
}

export function makeLeaseDb(seed?: {
  leases?: LeaseRow[];
  slots?: SlotExecutionRow[];
  progress?: ProgressRow[];
  runs?: CronRunRow[];
  cache?: CacheRow[];
  failSlotHeartbeatRuns?: number;
  failSlotFinishRuns?: number;
  failSlotProgressReads?: number;
  beforeSlotTakeover?: (sqlite: DatabaseSync) => void;
  beforeSlotReconciliationClaim?: (sqlite: DatabaseSync) => void;
  beforeOrphanedProgressDelete?: (sqlite: DatabaseSync) => void;
}): TestLeaseDb {
  const { sqlite } = createLatestSchemaSqlite();
  openLeaseDatabases.push(sqlite);

  let failSlotHeartbeatRuns = seed?.failSlotHeartbeatRuns ?? 0;
  let failSlotFinishRuns = seed?.failSlotFinishRuns ?? 0;
  let failSlotProgressReads = seed?.failSlotProgressReads ?? 0;
  const beforeSlotTakeover = seed?.beforeSlotTakeover;
  const beforeSlotReconciliationClaim = seed?.beforeSlotReconciliationClaim;
  const beforeOrphanedProgressDelete = seed?.beforeOrphanedProgressDelete;

  for (const lease of seed?.leases ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(lease.job, lease.lease_owner, lease.lease_until, lease.heartbeat_at, lease.updated_at);
  }
  for (const slot of seed?.slots ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_slot_executions (
           slot_key, slot_started_at, state, result_status, execution_owner, execution_generation,
           invocation_id, worker_version, started_at, finished_at, updated_at, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slot.slot_key,
        slot.slot_started_at,
        slot.state,
        slot.result_status,
        slot.execution_owner,
        slot.execution_generation ?? 1,
        slot.invocation_id ?? null,
        slot.worker_version ?? null,
        slot.started_at,
        slot.finished_at,
        slot.updated_at,
        slot.metadata,
      );
  }
  for (const progress of seed?.progress ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_run_progress (job, started_at, updated_at, stage, lease_owner, slot_started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        progress.job,
        progress.started_at,
        progress.updated_at,
        progress.stage,
        progress.lease_owner,
        progress.slot_started_at,
      );
  }
  for (const run of seed?.runs ?? []) {
    sqlite
      .prepare(
        `INSERT INTO cron_runs (job, started_at, duration_ms, status, error, metadata, slot_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.job, run.started_at, run.duration_ms, run.status, run.error, run.metadata, run.slot_started_at);
  }
  for (const row of seed?.cache ?? []) {
    sqlite
      .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(row.key, row.value, row.updated_at);
  }

  const inner = createSqliteD1(sqlite);

  function stmt(sql: string, boundValues: unknown[] = []): D1PreparedStatement {
    const bound = boundValues.length > 0 ? inner.prepare(sql).bind(...boundValues) : inner.prepare(sql);
    return {
      bind: (...args: unknown[]) => stmt(sql, args),
      run: async () => {
        const isSlotUpdate = sql.includes("UPDATE cron_slot_executions");
        if (isSlotUpdate && sql.includes("SET updated_at = ?") && failSlotHeartbeatRuns > 0) {
          failSlotHeartbeatRuns--;
          throw new Error("slot heartbeat write failed");
        }
        if (isSlotUpdate && sql.includes("SET state = 'finished'") && failSlotFinishRuns > 0) {
          failSlotFinishRuns--;
          throw new Error("slot terminal write failed");
        }
        if (isSlotUpdate && sql.includes("SET state = 'reconciling'")) {
          beforeSlotReconciliationClaim?.(sqlite);
        }
        if (isSlotUpdate && sql.includes("SET execution_owner = ?")) {
          beforeSlotTakeover?.(sqlite);
        }
        if (sql.includes("DELETE FROM cron_run_progress") && sql.includes("AND NOT EXISTS")) {
          beforeOrphanedProgressDelete?.(sqlite);
        }
        return bound.run();
      },
      first: async <T>() => bound.first<T>(),
      all: async <T>() => {
        if (
          failSlotProgressReads > 0 &&
          sql.includes("FROM cron_run_progress") &&
          sql.includes("slot_started_at = ?")
        ) {
          failSlotProgressReads--;
          throw new Error("simulated reconciliation crash");
        }
        return bound.all<T>();
      },
    } as unknown as D1PreparedStatement;
  }

  return {
    sqlite,
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    getSlot: (slotKey: string, slotStartedAt: number) =>
      sqlite
        .prepare(
          `SELECT slot_key, slot_started_at, state, result_status, execution_owner, execution_generation,
                  invocation_id, worker_version, started_at, finished_at, updated_at, metadata
             FROM cron_slot_executions WHERE slot_key = ? AND slot_started_at = ?`,
        )
        .get(slotKey, slotStartedAt) as SlotExecutionRow | undefined,
    getLease: (job: string) =>
      sqlite
        .prepare(
          "SELECT job, lease_owner, lease_until, heartbeat_at, updated_at FROM cron_leases WHERE job = ?",
        )
        .get(job) as LeaseRow | undefined,
    getProgress: (job: string) =>
      sqlite
        .prepare(
          `SELECT job, started_at, updated_at, stage, lease_owner, slot_started_at
             FROM cron_run_progress WHERE job = ?`,
        )
        .get(job) as ProgressRow | undefined,
    getRuns: () =>
      sqlite
        .prepare(
          `SELECT job, started_at, duration_ms, status, error, metadata, slot_started_at
             FROM cron_runs ORDER BY id`,
        )
        .all() as CronRunRow[],
    getCache: (key: string) =>
      sqlite
        .prepare("SELECT key, value, updated_at FROM cache WHERE key = ?")
        .get(key) as CacheRow | undefined,
  } as unknown as TestLeaseDb;
}
