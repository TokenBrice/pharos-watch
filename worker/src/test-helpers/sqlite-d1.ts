function makeSqliteStatement(
  sqlite: import("node:sqlite").DatabaseSync,
  sql: string,
  boundValues: unknown[] = [],
  options: SqliteD1Options = {},
): D1PreparedStatement {
  return {
    bind: (...args: unknown[]) => makeSqliteStatement(sqlite, sql, args, options),
    all: async <T>() => {
      const results = sqlite.prepare(sql).all(...(boundValues as never[])) as T[];
      options.onAll?.(sql);
      return { results, success: true, meta: {} };
    },
    first: async <T>() => {
      const row = sqlite.prepare(sql).get(...(boundValues as never[])) as T | undefined;
      return row ?? null;
    },
    run: async () => {
      options.onRun?.(sql);
      const result = sqlite.prepare(sql).run(...(boundValues as never[]));
      return {
        success: true,
        meta: { changes: Number(result.changes ?? 0) },
      };
    },
  } as unknown as D1PreparedStatement;
}

interface SqliteD1Options {
  onAll?: (sql: string) => void;
  onRun?: (sql: string) => void;
}

export function createSqliteD1(
  sqlite: import("node:sqlite").DatabaseSync,
  options: SqliteD1Options = {},
): D1Database {
  return {
    prepare: (sql: string) => makeSqliteStatement(sqlite, sql, [], options),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements) {
          results.push(await statement.run<T>());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}
