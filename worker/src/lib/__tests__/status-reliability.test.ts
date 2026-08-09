import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFallbackStatusState,
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
  reconcileStatusState,
  summarizeStatusPersistenceIssues,
  STATUS_HYSTERESIS,
  STATUS_SYSTEM_FRESHNESS_SEC,
  updateDiscrepancyObservation,
  writeStatusProbeRun,
} from "../status-reliability";
import { STATUS_DEGRADED_TO_STALE_THRESHOLD } from "../status-reliability-shared";
import { decideNextStatus } from "../status-reliability-decision";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

type StatusLevel = "healthy" | "degraded" | "stale";

interface StatusStateRow {
  scope: string;
  current_status: StatusLevel;
  raw_status: StatusLevel;
  last_evaluated_at: number;
  last_changed_at: number;
  consecutive_healthy: number;
  consecutive_degraded: number;
  consecutive_stale: number;
  confidence: number;
  causes_json: string | null;
}

interface DiscrepancyStateRow {
  scope: string;
  consecutive_divergent: number;
  last_divergent_at: number | null;
  last_alert_at: number | null;
  consecutive_probe_failures: number;
  last_probe_failure_at: number | null;
  last_probe_alert_at: number | null;
  updated_at: number;
}

interface StatefulDbOptions {
  failOnSql?: string;
  failMessage?: string;
  failBatchAfterApplyOnce?: boolean;
  failFirstOnSql?: string;
  failRunAfterApplyOnceOnSql?: string;
  seed?: Partial<StatusStateRow>;
}

const openDatabases: DatabaseSync[] = [];

function writeStatusStateRow(sqlite: DatabaseSync, seed: Partial<StatusStateRow>): void {
  const lastEvaluatedAt = seed.last_evaluated_at ?? 0;
  sqlite
    .prepare(
      `INSERT INTO status_state
       (scope, current_status, raw_status, last_evaluated_at, last_changed_at,
        consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.scope ?? "global",
      seed.current_status ?? "healthy",
      seed.raw_status ?? "healthy",
      lastEvaluatedAt,
      seed.last_changed_at ?? 0,
      seed.consecutive_healthy ?? 0,
      seed.consecutive_degraded ?? 0,
      seed.consecutive_stale ?? 0,
      seed.confidence ?? 1,
      seed.causes_json ?? "[]",
      lastEvaluatedAt,
    );
}

/**
 * Real-schema status-reliability harness. `db` is a normal SQLite-backed D1
 * with narrowly scoped fault injection; `store` is a live view of the same
 * tables so assertions read what production SQL actually persisted.
 */
function makeStatefulDb(options: StatefulDbOptions = {}) {
  const { sqlite } = createLatestSchemaSqlite();
  openDatabases.push(sqlite);
  if (options.seed) writeStatusStateRow(sqlite, options.seed);

  const inner = createSqliteD1(sqlite);
  let batchPostApplyFailureUsed = false;
  let firstSqlFailureUsed = false;
  let runPostApplyFailureUsed = false;

  function createStatement(sql: string, boundValues: unknown[] = []): D1PreparedStatement {
    const bound = boundValues.length > 0
      ? inner.prepare(sql).bind(...boundValues)
      : inner.prepare(sql);
    return {
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => bound.all<T>(),
      first: async <T>() => {
        if (options.failFirstOnSql && !firstSqlFailureUsed && sql.includes(options.failFirstOnSql)) {
          firstSqlFailureUsed = true;
          throw new Error(options.failMessage ?? "transient read failed");
        }
        return bound.first<T>();
      },
      run: async () => {
        if (options.failOnSql && sql.includes(options.failOnSql)) {
          throw new Error(options.failMessage ?? "missing migration");
        }
        const result = await bound.run();
        if (
          options.failRunAfterApplyOnceOnSql &&
          !runPostApplyFailureUsed &&
          sql.includes(options.failRunAfterApplyOnceOnSql)
        ) {
          runPostApplyFailureUsed = true;
          throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
        }
        return result;
      },
    } as unknown as D1PreparedStatement;
  }

  const db = {
    prepare: (sql: string) => createStatement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN IMMEDIATE");
      let postApplyFailureThisCall = false;
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        if (options.failBatchAfterApplyOnce && !batchPostApplyFailureUsed) {
          batchPostApplyFailureUsed = true;
          postApplyFailureThisCall = true;
          throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        // A post-apply failure models D1 losing the response after the writes
        // landed, so the rows stay committed and the caller must retry safely.
        sqlite.exec(postApplyFailureThisCall ? "COMMIT" : "ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  const store = {
    get stateRow(): StatusStateRow | null {
      return (sqlite.prepare("SELECT * FROM status_state WHERE scope = 'global'").get() ??
        null) as StatusStateRow | null;
    },
    set stateRow(row: StatusStateRow | null) {
      sqlite.prepare("DELETE FROM status_state WHERE scope = 'global'").run();
      if (row) writeStatusStateRow(sqlite, row);
    },
    get transitions() {
      return sqlite.prepare("SELECT * FROM status_transitions ORDER BY id").all() as Array<
        Record<string, unknown>
      >;
    },
    get probes() {
      return sqlite.prepare("SELECT * FROM status_probe_runs ORDER BY id").all() as Array<
        Record<string, unknown>
      >;
    },
    get discrepancy(): DiscrepancyStateRow | null {
      return (sqlite.prepare("SELECT * FROM status_discrepancy_state WHERE scope = 'global'").get() ??
        null) as DiscrepancyStateRow | null;
    },
    set discrepancy(row: DiscrepancyStateRow | null) {
      sqlite.prepare("DELETE FROM status_discrepancy_state WHERE scope = 'global'").run();
      if (!row) return;
      sqlite
        .prepare(
          `INSERT INTO status_discrepancy_state
           (scope, consecutive_divergent, last_divergent_at, last_alert_at,
            consecutive_probe_failures, last_probe_failure_at, last_probe_alert_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.scope,
          row.consecutive_divergent,
          row.last_divergent_at,
          row.last_alert_at,
          row.consecutive_probe_failures,
          row.last_probe_failure_at,
          row.last_probe_alert_at,
          row.updated_at,
        );
    },
  };

  return { db, store, sqlite };
}

function makeFailingDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw new Error("missing migration");
        },
        first: async () => {
          throw new Error("missing migration");
        },
        run: async () => {
          throw new Error("missing migration");
        },
      }),
      all: async () => {
        throw new Error("missing migration");
      },
      first: async () => {
        throw new Error("missing migration");
      },
      run: async () => {
        throw new Error("missing migration");
      },
    }),
    batch: async () => {
      throw new Error("missing migration");
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("status-reliability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const sqlite of openDatabases.splice(0)) sqlite.close();
  });

  it("initializes state and clamps invalid confidence", async () => {
    const { db, store } = makeStatefulDb();
    const causes = [{ code: "seed", layer: "availability", severity: "warning", message: "seed" }] as const;

    const result = await reconcileStatusState(db, 100, "healthy", Number.POSITIVE_INFINITY, [...causes]);

    expect(result.effectiveStatus).toBe("healthy");
    expect(result.transition).toMatchObject({
      transitionType: "init",
      reason: "status-state-initialized",
      confidence: 0.1,
    });
    expect(result.persistenceSucceeded).toBe(true);
    expect(store.stateRow?.current_status).toBe("healthy");
    expect(store.transitions).toHaveLength(1);
  });

  it("applies hysteresis across stale escalation and staged recoveries", async () => {
    const { db, store } = makeStatefulDb();

    await reconcileStatusState(db, 100, "healthy", 0.95, []);
    const stale = await reconcileStatusState(db, 160, "stale", 0.95, []);
    expect(stale.effectiveStatus).toBe("stale");
    expect(stale.transition?.reason).toBe("raw-stale-immediate-escalation");

    const hold = await reconcileStatusState(db, 200, "degraded", 0.95, []);
    expect(hold.effectiveStatus).toBe("stale");
    expect(hold.transition).toBeNull();

    const recoverToDegraded = await reconcileStatusState(db, 400, "degraded", 0.95, []);
    expect(recoverToDegraded.effectiveStatus).toBe("degraded");
    expect(recoverToDegraded.transition?.reason).toBe("raw-degraded-recovery-from-stale");

    await reconcileStatusState(db, 520, "healthy", 0.95, []);
    await reconcileStatusState(db, 640, "healthy", 0.95, []);
    const recoverToHealthy = await reconcileStatusState(db, 760, "healthy", 0.95, []);
    expect(recoverToHealthy.effectiveStatus).toBe("healthy");
    expect(recoverToHealthy.transition?.reason).toBe("raw-healthy-recovery-threshold");

    expect(store.transitions.map((row) => row.transition_type)).toEqual(["init", "degrade", "recover", "recover"]);
  });

  it("rolls back a seeded status write when the transition insert fails", async () => {
    const { db, store } = makeStatefulDb({
      failOnSql: "status_transitions",
      failMessage: "seed transition failed",
    });
    const issues: Array<{ code: string; operation: string; message: string }> = [];

    const result = await reconcileStatusState(db, 100, "healthy", 0.95, [], (issue) => issues.push(issue));

    expect(result.effectiveStatus).toBe("healthy");
    expect(result.persistenceSucceeded).toBe(false);
    expect(result.state).toEqual(buildFallbackStatusState("healthy", 100));
    expect(result.transition).toBeNull();
    expect(store.stateRow).toBeNull();
    expect(store.transitions).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "status_state_persistence_failed",
      operation: "seed_status_state",
    });
  });

  it("rolls back an update when the transition insert fails", async () => {
    const { db, store } = makeStatefulDb({
      failOnSql: "status_transitions",
      failMessage: "update transition failed",
    });
    store.stateRow = {
      scope: "global",
      current_status: "healthy",
      raw_status: "healthy",
      last_evaluated_at: 100,
      last_changed_at: 100,
      consecutive_healthy: 1,
      consecutive_degraded: 1,
      consecutive_stale: 0,
      confidence: 0.95,
      causes_json: "[]",
    };

    const issues: Array<{ code: string; operation: string; message: string }> = [];
    const result = await reconcileStatusState(db, 220, "degraded", 0.95, [], (issue) => issues.push(issue));

    expect(result.effectiveStatus).toBe("healthy");
    expect(result.persistenceSucceeded).toBe(false);
    expect(result.state.currentStatus).toBe("healthy");
    expect(result.transition).toBeNull();
    expect(store.stateRow).toMatchObject({
      current_status: "healthy",
      raw_status: "healthy",
      last_evaluated_at: 100,
      last_changed_at: 100,
    });
    expect(store.transitions).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "status_state_persistence_failed",
      operation: "update_status_state",
    });
  });

  it("retries status-state batches without duplicating transition rows", async () => {
    const { db, store } = makeStatefulDb({ failBatchAfterApplyOnce: true });

    const result = await reconcileStatusState(db, 100, "healthy", 0.95, []);

    expect(result.persistenceSucceeded).toBe(true);
    expect(store.stateRow?.current_status).toBe("healthy");
    expect(store.transitions).toHaveLength(1);
    expect(store.transitions[0]?.idempotency_key).toBeTruthy();
  });

  it("returns snapshots with staleness metadata and nulls on DB failure", async () => {
    const { db } = makeStatefulDb();
    await reconcileStatusState(db, 100, "degraded", 0.9, []);

    const snapshot = await getStatusStateSnapshot(db, 2_100);
    expect(snapshot.state?.currentStatus).toBe("degraded");
    expect(snapshot.staleness).toEqual({
      ageSeconds: 2_000,
      maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
      isStale: true,
    });

    const failed = await getStatusStateSnapshot(makeFailingDb(), 2_100);
    expect(failed).toEqual({ state: null, staleness: null });
  });

  it("does not seed status state after a transient read failure", async () => {
    const { db, store } = makeStatefulDb({
      failFirstOnSql: "FROM status_state",
      failMessage: "transient status read failed",
      seed: {
        current_status: "healthy",
        raw_status: "healthy",
        last_evaluated_at: 500,
        last_changed_at: 500,
        consecutive_healthy: 5,
      },
    });
    const issues: Array<{ code: string; operation: string; message: string }> = [];

    const result = await reconcileStatusState(db, 2_000, "degraded", 0.9, [], (issue) => issues.push(issue));

    expect(result).toMatchObject({
      effectiveStatus: "degraded",
      persistenceSucceeded: false,
      transition: null,
    });
    expect(result.state).toEqual(buildFallbackStatusState("degraded", 2_000));
    expect(store.stateRow).toMatchObject({
      current_status: "healthy",
      raw_status: "healthy",
      last_changed_at: 500,
      consecutive_healthy: 5,
    });
    expect(store.transitions).toHaveLength(0);
    expect(issues).toEqual([
      expect.objectContaining({
        code: "status_state_read_failed",
        operation: "load-status-state",
      }),
    ]);
  });

  it("reports persistence diagnostics when status-state tables are unavailable", async () => {
    const issues: Array<{ code: string; operation: string; message: string }> = [];

    const reconcile = await reconcileStatusState(
      makeFailingDb(),
      100,
      "healthy",
      0.9,
      [],
      (issue) => issues.push(issue),
    );
    expect(reconcile.effectiveStatus).toBe("healthy");
    expect(reconcile.persistenceSucceeded).toBe(false);

    const snapshot = await getStatusStateSnapshot(makeFailingDb(), 200, (issue) => issues.push(issue));
    expect(snapshot).toEqual({ state: null, staleness: null });

    const summary = summarizeStatusPersistenceIssues(issues);
    expect(issues.some((issue) => issue.code === "status_state_read_failed")).toBe(true);
    expect(issues.some((issue) => issue.code === "status_state_snapshot_failed")).toBe(true);
    expect(summary?.code).toBe("status_persistence_degraded");
    expect(summary?.message).toBe("Status persistence degraded.");
  });

  it("builds fallback state from the canonical hysteresis policy", () => {
    expect(buildFallbackStatusState("degraded", 500)).toEqual({
      scope: "global",
      currentStatus: "degraded",
      rawStatus: "degraded",
      lastEvaluatedAt: 500,
      lastChangedAt: 500,
      minDwellSec: STATUS_HYSTERESIS.minDwellSec,
      staleMinDwellSec: STATUS_HYSTERESIS.staleMinDwellSec,
      consecutiveRaw: {
        healthy: 0,
        degraded: 1,
        stale: 0,
      },
      thresholds: {
        escalateToDegraded: STATUS_HYSTERESIS.escalateToDegraded,
        escalateToStale: STATUS_HYSTERESIS.escalateToStale,
        recoverToDegraded: STATUS_HYSTERESIS.recoverToDegraded,
        recoverToHealthy: STATUS_HYSTERESIS.recoverToHealthy,
      },
    });
  });

  it("lists recent transitions with bounds and safely parses invalid causes", async () => {
    const { db, sqlite } = makeStatefulDb();
    const insertTransition = sqlite.prepare(
      `INSERT INTO status_transitions
       (id, scope, previous_status, next_status, raw_status, transition_type,
        reason, confidence, causes_json, created_at)
       VALUES (?, 'global', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertTransition.run(1, null, "healthy", "healthy", "init", "init", 1, "[]", 100);
    insertTransition.run(2, "healthy", "degraded", "degraded", "degrade", "degrade", 0.8, "not-json", 200);
    insertTransition.run(
      3, "degraded", "healthy", "healthy", "recover", "recover", 0.9,
      '[{"code":"ok","layer":"availability","severity":"info","message":"ok"}]', 300,
    );

    const rows = await listRecentStatusTransitions(db, 999, { from: 150, to: 300 });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.at).toBe(300);
    expect(rows[0]?.causes).toHaveLength(1);
    expect(rows[1]?.at).toBe(200);
    expect(rows[1]?.causes).toEqual([]);
  });

  it("writes probe runs and returns latest probe or unknown fallback", async () => {
    const { db } = makeStatefulDb();

    expect(await getLatestStatusProbe(db)).toEqual({
      timestamp: null,
      status: "unknown",
      sampleCount: 0,
      passCount: 0,
      failCount: 0,
      p95LatencyMs: null,
    });

    await expect(writeStatusProbeRun(db, 100, {
      status: "healthy",
      sampleCount: 10,
      passCount: 10,
      failCount: 0,
      p95LatencyMs: 180,
      details: { route: "/api/health" },
    })).resolves.toBe(true);
    await expect(writeStatusProbeRun(db, 200, {
      status: "degraded",
      sampleCount: 8,
      passCount: 6,
      failCount: 2,
      p95LatencyMs: 450,
      details: {
        planes: {
          internal: {
            status: "healthy",
            sampleCount: 5,
            passCount: 5,
            failCount: 0,
            p95LatencyMs: 120,
            origins: ["https://api.pharos.watch"],
          },
          external: {
            status: "degraded",
            sampleCount: 3,
            passCount: 1,
            failCount: 2,
            p95LatencyMs: 450,
            origins: ["https://api.pharos.watch", "https://site-api.pharos.watch", "https://ops-api.pharos.watch"],
          },
        },
        internalExternalDiscrepancy: {
          hasDivergence: true,
          severityDelta: 1,
          internalStatus: "healthy",
          externalStatus: "degraded",
          reason: "external-worse",
          details: "internal=healthy, external=degraded, delta=1",
        },
      },
    })).resolves.toBe(true);

    expect(await getLatestStatusProbe(db)).toEqual({
      timestamp: 200,
      status: "degraded",
      sampleCount: 8,
      passCount: 6,
      failCount: 2,
      p95LatencyMs: 450,
      internal: {
        status: "healthy",
        sampleCount: 5,
        passCount: 5,
        failCount: 0,
        p95LatencyMs: 120,
        origins: ["https://api.pharos.watch"],
      },
      external: {
        status: "degraded",
        sampleCount: 3,
        passCount: 1,
        failCount: 2,
        p95LatencyMs: 450,
        origins: ["https://api.pharos.watch", "https://site-api.pharos.watch", "https://ops-api.pharos.watch"],
      },
      internalExternalDiscrepancy: {
        hasDivergence: true,
        severityDelta: 1,
        internalStatus: "healthy",
        externalStatus: "degraded",
        reason: "external-worse",
        details: "internal=healthy, external=degraded, delta=1",
      },
    });
  });

  it("retries status probe writes without duplicating probe rows", async () => {
    const { db, store } = makeStatefulDb({ failRunAfterApplyOnceOnSql: "status_probe_runs" });

    await expect(writeStatusProbeRun(db, 300, {
      status: "healthy",
      sampleCount: 3,
      passCount: 3,
      failCount: 0,
      p95LatencyMs: 90,
      details: { route: "/api/status" },
    })).resolves.toBe(true);

    expect(store.probes).toHaveLength(1);
    expect(store.probes[0]?.idempotency_key).toBeTruthy();
  });

  it("tracks discrepancy streaks", async () => {
    const { db, store } = makeStatefulDb();

    const first = await updateDiscrepancyObservation(db, 100, true, true);
    expect(first).toEqual({
      consecutiveDivergent: 1,
      consecutiveProbeFailures: 1,
      persistenceSucceeded: true,
    });

    const second = await updateDiscrepancyObservation(db, 400, false, false);
    expect(second).toEqual({
      consecutiveDivergent: 0,
      consecutiveProbeFailures: 0,
      persistenceSucceeded: true,
    });

    expect(store.discrepancy).toMatchObject({ last_alert_at: null, last_probe_alert_at: null });

    expect(await getDiscrepancyStreak(db)).toBe(0);
  });

  it("preserves legacy alert-timestamp columns on upsert", async () => {
    const { db, store } = makeStatefulDb();
    store.discrepancy = {
      scope: "global",
      consecutive_divergent: 3,
      last_divergent_at: 90,
      last_alert_at: 80,
      consecutive_probe_failures: 4,
      last_probe_failure_at: 70,
      last_probe_alert_at: 60,
      updated_at: 90,
    };

    const result = await updateDiscrepancyObservation(db, 100, true, true);

    expect(result).toMatchObject({
      consecutiveDivergent: 4,
      persistenceSucceeded: true,
    });
    expect(store.discrepancy).toMatchObject({ last_alert_at: 80, last_probe_alert_at: 60 });
  });

  it("falls back to durable discrepancy counters when the write fails", async () => {
    const { db, store } = makeStatefulDb({
      failOnSql: "INSERT INTO status_discrepancy_state",
      failMessage: "discrepancy write failed",
    });
    store.discrepancy = {
      scope: "global",
      consecutive_divergent: 4,
      last_divergent_at: 90,
      last_alert_at: 80,
      consecutive_probe_failures: 2,
      last_probe_failure_at: 70,
      last_probe_alert_at: 60,
      updated_at: 90,
    };

    const result = await updateDiscrepancyObservation(db, 100, false, false);

    expect(result).toEqual({
      consecutiveDivergent: 4,
      consecutiveProbeFailures: 2,
      persistenceSucceeded: false,
    });
  });

  it("builds discrepancies for unknown, stale, and divergent probe states", () => {
    expect(
      buildDiscrepancy(
        "stale",
        {
          timestamp: null,
          status: "unknown",
          sampleCount: 0,
          passCount: 0,
          failCount: 0,
          p95LatencyMs: null,
        },
        500,
        2,
      ),
    ).toEqual({
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 2,
      probeSeverity: -1,
      details: null,
      probeAgeSeconds: null,
      consecutiveDivergent: 2,
      discrepancyReason: "probe-missing",
    });

    expect(
      buildDiscrepancy(
        "stale",
        {
          timestamp: 1,
          status: "healthy",
          sampleCount: 10,
          passCount: 10,
          failCount: 0,
          p95LatencyMs: 200,
        },
        STATUS_SYSTEM_FRESHNESS_SEC + 200,
        1,
      ).hasDivergence,
    ).toBe(false);

    const divergent = buildDiscrepancy(
      "stale",
      {
        timestamp: 100,
        status: "healthy",
        sampleCount: 10,
        passCount: 10,
        failCount: 0,
        p95LatencyMs: 200,
      },
      200,
      3,
    );
    expect(divergent.hasDivergence).toBe(true);
    expect(divergent.severityDelta).toBe(2);
    expect(divergent.details).toBe("status=stale, probe=healthy, probeAge=100s");
  });

  it("degraded → stale transition respects STATUS_DEGRADED_TO_STALE_THRESHOLD", () => {
    const counterBelow = { healthy: 0, degraded: 0, stale: STATUS_DEGRADED_TO_STALE_THRESHOLD - 1 };
    const counterAt = { healthy: 0, degraded: 0, stale: STATUS_DEGRADED_TO_STALE_THRESHOLD };
    expect(decideNextStatus("degraded", "stale", counterBelow, 500, STATUS_HYSTERESIS).changed).toBe(false);
    expect(decideNextStatus("degraded", "stale", counterAt, 500, STATUS_HYSTERESIS).changed).toBe(true);
  });
});
