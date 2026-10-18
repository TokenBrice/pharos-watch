export interface D1Cost {
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  bindingCalls: number;
  batchCalls: number;
  /** Sum of observed waits, including failures and overlapping operations. */
  awaitElapsedMs: number;
  /** Sum of available server SQL durations, not a complete invocation total. */
  sqlDurationMs: number | null;
  sqlDurationResults: number;
  servedByRegion: string | null;
  servedByRegionMixed: boolean;
  servedByRegionResults: number;
  servedByPrimaryResults: number;
  servedByReplicaResults: number;
  coverage: "complete" | "partial";
  reasons: string[];
}

export interface D1CostTracker {
  db: D1Database;
  wrapDatabase: <T extends D1Database | D1DatabaseSession>(database: T) => T;
  snapshot: () => D1Cost;
}

/** Observe the original binding calls, including retries, without changing their SQL or result shapes. */
export function createD1CostTracker(database: D1Database, exclusions: readonly string[] = []): D1CostTracker {
  let queries = 0;
  let rowsRead = 0;
  let rowsWritten = 0;
  let bindingCalls = 0;
  let batchCalls = 0;
  let awaitElapsedMs = 0;
  let sqlDurationMs: number | null = null;
  let sqlDurationResults = 0;
  let servedByRegion: string | null = null;
  let servedByRegionMixed = false;
  let servedByRegionResults = 0;
  let servedByPrimaryResults = 0;
  let servedByReplicaResults = 0;
  const reasons = new Set(exclusions);
  const originalStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

  function recordServerMetadata(meta: object): void {
    const timings = "timings" in meta ? meta.timings : null;
    const timedDuration = timings != null && typeof timings === "object" && "sql_duration_ms" in timings
      ? timings.sql_duration_ms : undefined;
    const legacyDuration = "duration" in meta ? meta.duration : undefined;
    const duration = typeof timedDuration === "number" && Number.isFinite(timedDuration) && timedDuration >= 0
      ? timedDuration : legacyDuration;
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
      sqlDurationMs = sqlDurationMs === null ? duration : sqlDurationMs + duration;
      sqlDurationResults++;
    }
    if ("served_by_region" in meta && typeof meta.served_by_region === "string"
      && meta.served_by_region.length > 0 && meta.served_by_region.length <= 64) {
      servedByRegionResults++;
      if (!servedByRegionMixed) {
        if (servedByRegion === null) servedByRegion = meta.served_by_region;
        else if (servedByRegion !== meta.served_by_region) {
          servedByRegion = null;
          servedByRegionMixed = true;
        }
      }
    }
    if ("served_by_primary" in meta && typeof meta.served_by_primary === "boolean") {
      if (meta.served_by_primary) servedByPrimaryResults++;
      else servedByReplicaResults++;
    }
  }

  function recordResult(result: unknown): void {
    if (result == null || typeof result !== "object" || !("meta" in result)) {
      reasons.add("result-meta-unavailable");
      return;
    }
    const meta = result.meta;
    if (meta == null || typeof meta !== "object") {
      reasons.add("result-meta-unavailable");
      return;
    }
    recordServerMetadata(meta);
    if ("rows_read" in meta && typeof meta.rows_read === "number" && Number.isFinite(meta.rows_read) && meta.rows_read >= 0) {
      rowsRead += meta.rows_read;
    } else {
      reasons.add("rows-read-unavailable");
    }
    if ("rows_written" in meta && typeof meta.rows_written === "number" && Number.isFinite(meta.rows_written) && meta.rows_written >= 0) {
      rowsWritten += meta.rows_written;
    } else {
      reasons.add("rows-written-unavailable");
    }
    if ("total_attempts" in meta && typeof meta.total_attempts === "number" && Number.isInteger(meta.total_attempts) && meta.total_attempts > 1) {
      queries += meta.total_attempts - 1;
      // D1 exposes row costs for the final automatic attempt only.
      reasons.add("automatic-retry-rows-unavailable");
    }
  }

  async function observe<T>(count: number, operation: () => Promise<T>, readResults: (result: T) => void): Promise<T> {
    queries += count;
    bindingCalls++;
    const startedAtMs = performance.now();
    try {
      const result = await operation();
      readResults(result);
      return result;
    } catch (error) {
      reasons.add("failed-attempt-rows-unavailable");
      throw error;
    } finally {
      awaitElapsedMs += performance.now() - startedAtMs;
    }
  }

  function wrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (property === "all" || property === "run") {
          return () => observe(1, () => target[property](), recordResult);
        }
        if (property === "first" || property === "raw") {
          const method = target[property];
          return (...args: unknown[]) => {
            reasons.add(`${property}-no-meta`);
            return observe(1, () => Reflect.apply(method, target, args) as Promise<unknown>, () => {});
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    originalStatements.set(wrapped, statement);
    return wrapped;
  }

  function wrapDatabase<T extends D1Database | D1DatabaseSession>(db: T): T {
    return new Proxy(db, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls++;
            return observe(
              statements.length,
              () => target.batch(statements.map((statement) => originalStatements.get(statement) ?? statement)),
              (results) => results.forEach(recordResult),
            );
          };
        }
        if (property === "withSession" && "withSession" in target) {
          return (constraint?: D1SessionBookmark | D1SessionConstraint) => wrapDatabase(target.withSession(constraint));
        }
        if (property === "exec" && "exec" in target) {
          return (sql: string) => {
            reasons.add("exec-no-meta");
            return observe(1, () => target.exec(sql), (result) => { queries += result.count - 1; });
          };
        }
        if (property === "dump" && "dump" in target) {
          return () => {
            reasons.add("dump-no-meta");
            return observe(0, () => target.dump(), () => {});
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
  }

  return {
    db: wrapDatabase(database),
    wrapDatabase,
    snapshot: () => ({
      queries, rowsRead, rowsWritten, bindingCalls, batchCalls, awaitElapsedMs,
      sqlDurationMs, sqlDurationResults, servedByRegion, servedByRegionMixed,
      servedByRegionResults, servedByPrimaryResults, servedByReplicaResults,
      coverage: reasons.size > 0 ? "partial" : "complete", reasons: [...reasons].sort(),
    }),
  };
}
