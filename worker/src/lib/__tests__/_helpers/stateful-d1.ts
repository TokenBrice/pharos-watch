/**
 * Shared stateful D1 mock for status-reliability tests.
 * Extracted from status-reliability.test.ts so Task 2's race regression test
 * can reuse the same mock without inline-copying 100+ LOC.
 */

export type StatusLevel = "healthy" | "degraded" | "stale";

export interface StatusStateRow {
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

export interface StatusTransitionRow {
  id: number;
  scope: string;
  previous_status: StatusLevel | null;
  next_status: StatusLevel;
  raw_status: StatusLevel;
  transition_type: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causes_json: string | null;
  created_at: number;
  idempotency_key?: string | null;
}

export interface StatusProbeRow {
  created_at: number;
  status: StatusLevel;
  sample_count: number;
  pass_count: number;
  fail_count: number;
  p95_latency_ms: number;
  details_json: string | null;
  idempotency_key?: string | null;
}

export interface DiscrepancyStateRow {
  scope: string;
  consecutive_divergent: number;
  last_divergent_at: number | null;
  last_alert_at: number | null;
  consecutive_probe_failures: number;
  last_probe_failure_at: number | null;
  last_probe_alert_at: number | null;
  updated_at: number;
}

export interface StatefulDbOptions {
  failOnSql?: string;
  failMessage?: string;
  failBatchAfterApplyOnce?: boolean;
  failFirstOnSql?: string;
  failRunAfterApplyOnceOnSql?: string;
  seed?: Partial<StatusStateRow>;
}

function cloneStatefulStore(store: {
  stateRow: StatusStateRow | null;
  transitions: StatusTransitionRow[];
  probes: StatusProbeRow[];
  discrepancy: DiscrepancyStateRow | null;
  cache: Map<string, { value: string; updated_at: number }>;
}) {
  return {
    stateRow: store.stateRow ? { ...store.stateRow } : null,
    transitions: store.transitions.map((row) => ({ ...row })),
    probes: store.probes.map((row) => ({ ...row })),
    discrepancy: store.discrepancy ? { ...store.discrepancy } : null,
    cache: new Map([...store.cache].map(([key, row]) => [key, { ...row }])),
  };
}

function seedToStateRow(seed: Partial<StatusStateRow>): StatusStateRow {
  return {
    scope: seed.scope ?? "global",
    current_status: seed.current_status ?? "healthy",
    raw_status: seed.raw_status ?? "healthy",
    last_evaluated_at: seed.last_evaluated_at ?? 0,
    last_changed_at: seed.last_changed_at ?? 0,
    consecutive_healthy: seed.consecutive_healthy ?? 0,
    consecutive_degraded: seed.consecutive_degraded ?? 0,
    consecutive_stale: seed.consecutive_stale ?? 0,
    confidence: seed.confidence ?? 1,
    causes_json: seed.causes_json ?? "[]",
  };
}

export function makeStatefulDb(options: StatefulDbOptions = {}) {
  let batchPostApplyFailureUsed = false;
  let firstSqlFailureUsed = false;
  let runPostApplyFailureUsed = false;
  const store: {
    stateRow: StatusStateRow | null;
    transitions: StatusTransitionRow[];
    probes: StatusProbeRow[];
    discrepancy: DiscrepancyStateRow | null;
    cache: Map<string, { value: string; updated_at: number }>;
  } = {
    stateRow: options.seed ? seedToStateRow(options.seed) : null,
    transitions: [],
    probes: [],
    discrepancy: null,
    cache: new Map(),
  };

  const createStatement = (sql: string, boundValues: unknown[] = []) => ({
    sql,
    bind: (...args: unknown[]) => createStatement(sql, args),
    all: async <T>() => {
      if (sql.includes("FROM status_transitions")) {
        const hasFrom = sql.includes("created_at >= ?");
        const hasTo = sql.includes("created_at <= ?");
        let argIndex = 1;
        const from = hasFrom ? Number(boundValues[argIndex++]) : null;
        const to = hasTo ? Number(boundValues[argIndex++]) : null;
        const limit = Number(boundValues[argIndex] ?? 30);

        const rows = store.transitions
          .filter((row) => row.scope === "global")
          .filter((row) => from == null || row.created_at >= from)
          .filter((row) => to == null || row.created_at <= to)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit);
        return { results: rows as T[], success: true, meta: {} };
      }

      return { results: [] as T[], success: true, meta: {} };
    },
    first: async <T>() => {
      if (options.failFirstOnSql && !firstSqlFailureUsed && sql.includes(options.failFirstOnSql)) {
        firstSqlFailureUsed = true;
        throw new Error(options.failMessage ?? "transient read failed");
      }

      if (sql.includes("FROM status_state")) {
        return store.stateRow as T | null;
      }

      if (sql.includes("FROM status_probe_runs")) {
        const latest = [...store.probes].sort((a, b) => b.created_at - a.created_at)[0] ?? null;
        return latest as T | null;
      }

      if (sql.includes("SELECT consecutive_divergent FROM status_discrepancy_state")) {
        return (
          store.discrepancy ? { consecutive_divergent: store.discrepancy.consecutive_divergent } : null
        ) as T | null;
      }

      if (sql.includes("FROM status_discrepancy_state")) {
        return store.discrepancy as T | null;
      }

      if (sql.includes("FROM cache WHERE key = ?")) {
        return (store.cache.get(String(boundValues[0])) ?? null) as T | null;
      }

      return null as T | null;
    },
    run: async () => {
      if (options.failOnSql && sql.includes(options.failOnSql)) {
        throw new Error(options.failMessage ?? "missing migration");
      }
      if (sql.includes("INSERT INTO status_state")) {
        store.stateRow = {
          scope: String(boundValues[0]),
          current_status: boundValues[1] as StatusLevel,
          raw_status: boundValues[2] as StatusLevel,
          last_evaluated_at: Number(boundValues[3]),
          last_changed_at: Number(boundValues[4]),
          consecutive_healthy: Number(boundValues[5]),
          consecutive_degraded: Number(boundValues[6]),
          consecutive_stale: Number(boundValues[7]),
          confidence: Number(boundValues[8]),
          causes_json: boundValues[9] as string | null,
        };
      } else if (sql.includes("UPDATE status_state")) {
        store.stateRow = {
          ...(store.stateRow ?? {
            scope: "global",
            current_status: "healthy",
            raw_status: "healthy",
            last_evaluated_at: 0,
            last_changed_at: 0,
            consecutive_healthy: 0,
            consecutive_degraded: 0,
            consecutive_stale: 0,
            confidence: 1,
            causes_json: "[]",
          }),
          current_status: boundValues[0] as StatusLevel,
          raw_status: boundValues[1] as StatusLevel,
          last_evaluated_at: Number(boundValues[2]),
          last_changed_at: Number(boundValues[3]),
          consecutive_healthy: Number(boundValues[4]),
          consecutive_degraded: Number(boundValues[5]),
          consecutive_stale: Number(boundValues[6]),
          confidence: Number(boundValues[7]),
          causes_json: boundValues[8] as string | null,
        };
      } else if (sql.includes("status_transitions") && sql.includes("INSERT")) {
        const idempotencyKey = (boundValues[9] as string | null) ?? null;
        if (idempotencyKey && store.transitions.some((row) => row.idempotency_key === idempotencyKey)) {
          return { success: true, meta: { changes: 0 } };
        }
        store.transitions.push({
          id: store.transitions.length + 1,
          scope: String(boundValues[0]),
          previous_status: (boundValues[1] as StatusLevel | null) ?? null,
          next_status: boundValues[2] as StatusLevel,
          raw_status: boundValues[3] as StatusLevel,
          transition_type: boundValues[4] as "degrade" | "recover" | "init",
          reason: String(boundValues[5]),
          confidence: Number(boundValues[6]),
          causes_json: boundValues[7] as string | null,
          created_at: Number(boundValues[8]),
          idempotency_key: idempotencyKey,
        });
      } else if (sql.includes("status_probe_runs") && sql.includes("INSERT")) {
        const idempotencyKey = (boundValues[7] as string | null) ?? null;
        if (idempotencyKey && store.probes.some((row) => row.idempotency_key === idempotencyKey)) {
          return { success: true, meta: { changes: 0 } };
        }
        store.probes.push({
          created_at: Number(boundValues[6]),
          status: boundValues[4] as StatusLevel,
          sample_count: Number(boundValues[0]),
          pass_count: Number(boundValues[1]),
          fail_count: Number(boundValues[2]),
          p95_latency_ms: Number(boundValues[3]),
          details_json: (boundValues[5] as string | null) ?? null,
          idempotency_key: idempotencyKey,
        });
      } else if (sql.includes("INSERT INTO status_discrepancy_state")) {
        store.discrepancy = {
          scope: String(boundValues[0]),
          consecutive_divergent: Number(boundValues[1]),
          last_divergent_at: (boundValues[2] as number | null) ?? null,
          last_alert_at: (boundValues[3] as number | null) ?? null,
          consecutive_probe_failures: Number(boundValues[4]),
          last_probe_failure_at: (boundValues[5] as number | null) ?? null,
          last_probe_alert_at: (boundValues[6] as number | null) ?? null,
          updated_at: Number(boundValues[7]),
        };
      } else if (sql.includes("SET last_alert_at = ?")) {
        store.discrepancy = {
          ...(store.discrepancy ?? {
            scope: "global",
            consecutive_divergent: 0,
            last_divergent_at: null,
            last_alert_at: null,
            consecutive_probe_failures: 0,
            last_probe_failure_at: null,
            last_probe_alert_at: null,
            updated_at: 0,
          }),
          last_alert_at: Number(boundValues[0]),
          updated_at: Number(boundValues[1]),
        };
      } else if (sql.includes("SET last_probe_alert_at = ?")) {
        store.discrepancy = {
          ...(store.discrepancy ?? {
            scope: "global",
            consecutive_divergent: 0,
            last_divergent_at: null,
            last_alert_at: null,
            consecutive_probe_failures: 0,
            last_probe_failure_at: null,
            last_probe_alert_at: null,
            updated_at: 0,
          }),
          last_probe_alert_at: Number(boundValues[0]),
          updated_at: Number(boundValues[1]),
        };
      } else if (sql.includes("INSERT OR REPLACE INTO cache")) {
        store.cache.set(String(boundValues[0]), {
          value: String(boundValues[1]),
          updated_at: Number(boundValues[2]),
        });
      }

      if (
        options.failRunAfterApplyOnceOnSql &&
        !runPostApplyFailureUsed &&
        sql.includes(options.failRunAfterApplyOnceOnSql)
      ) {
        runPostApplyFailureUsed = true;
        throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
      }

      return { success: true, meta: { changes: 1 } };
    },
  });

  const db = {
    prepare: (sql: string) => createStatement(sql),
    batch: async (statements: Array<{ run?: () => Promise<unknown> }>) => {
      const snapshot = cloneStatefulStore(store);
      let postApplyFailureThisCall = false;
      try {
        for (const statement of statements) {
          if (!statement.run) {
            throw new Error("Missing run method on batched statement");
          }
          await statement.run();
        }
        if (options.failBatchAfterApplyOnce && !batchPostApplyFailureUsed) {
          batchPostApplyFailureUsed = true;
          postApplyFailureThisCall = true;
          throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
        }
        return [];
      } catch (error) {
        if (!postApplyFailureThisCall) {
          store.stateRow = snapshot.stateRow;
          store.transitions = snapshot.transitions;
          store.probes = snapshot.probes;
          store.discrepancy = snapshot.discrepancy;
          store.cache = snapshot.cache;
        }
        throw error;
      }
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return { db, store };
}
