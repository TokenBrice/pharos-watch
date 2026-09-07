import type { DatabaseSync } from "node:sqlite";

function makeSqliteStatement(
  sqlite: DatabaseSync,
  sql: string,
  boundValues: unknown[] = [],
  options: SqliteD1Options = {},
): D1PreparedStatement {
  return {
    bind: (...args: unknown[]) => makeSqliteStatement(sqlite, sql, args, options),
    all: async <T>() => {
      const results = sqlite.prepare(sql).all(...(boundValues as never[])) as T[];
      options.onAll?.(sql);
      return {
        results,
        success: true,
        meta: { rows_written: options.rowsWritten ? options.rowsWritten(sql, 0) : 0 },
      };
    },
    first: async <T>() => {
      const row = sqlite.prepare(sql).get(...(boundValues as never[])) as T | undefined;
      return row ?? null;
    },
    run: async () => {
      options.onRun?.(sql);
      const result = sqlite.prepare(sql).run(...(boundValues as never[]));
      const changes = Number(result.changes ?? 0);
      return {
        success: true,
        meta: {
          changes,
          rows_written: options.rowsWritten ? options.rowsWritten(sql, changes) : changes,
        },
      };
    },
  } as unknown as D1PreparedStatement;
}

export interface SqliteD1Options {
  onAll?: (sql: string) => void;
  onRun?: (sql: string) => void;
  rowsWritten?: (sql: string, changes: number) => number | null;
}

export function createSqliteD1(
  sqlite: DatabaseSync,
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
