function makeSqliteStatement(
  sqlite: import("node:sqlite").DatabaseSync,
  sql: string,
  boundValues: unknown[] = [],
): D1PreparedStatement {
  return {
    bind: (...args: unknown[]) => makeSqliteStatement(sqlite, sql, args),
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...(boundValues as never[])) as T[],
      success: true,
      meta: {},
    }),
    first: async <T>() => {
      const row = sqlite.prepare(sql).get(...(boundValues as never[])) as T | undefined;
      return row ?? null;
    },
    run: async () => {
      const result = sqlite.prepare(sql).run(...(boundValues as never[]));
      return {
        success: true,
        meta: { changes: Number(result.changes ?? 0) },
      };
    },
  } as unknown as D1PreparedStatement;
}

export function createSqliteD1(sqlite: import("node:sqlite").DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => makeSqliteStatement(sqlite, sql),
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
  } as unknown as D1Database;
}
