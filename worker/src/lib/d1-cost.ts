export interface D1Cost {
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  coverage: "complete" | "partial";
  reasons: string[];
}

export interface D1CostTracker {
  db: D1Database;
  snapshot: () => D1Cost;
}

/** Observe the original binding calls, including retries, without changing their SQL or result shapes. */
export function createD1CostTracker(database: D1Database, exclusions: readonly string[] = []): D1CostTracker {
  let queries = 0;
  let rowsRead = 0;
  let rowsWritten = 0;
  const reasons = new Set(exclusions);
  const originalStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

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
    try {
      const result = await operation();
      readResults(result);
      return result;
    } catch (error) {
      reasons.add("failed-attempt-rows-unavailable");
      throw error;
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
          return (statements: D1PreparedStatement[]) => observe(
            statements.length,
            () => target.batch(statements.map((statement) => originalStatements.get(statement) ?? statement)),
            (results) => results.forEach(recordResult),
          );
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
            return target.dump();
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
    snapshot: () => ({ queries, rowsRead, rowsWritten, coverage: reasons.size > 0 ? "partial" : "complete", reasons: [...reasons].sort() }),
  };
}
