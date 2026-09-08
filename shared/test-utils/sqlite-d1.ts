import type { D1Database, D1PreparedStatement, D1Result } from "@shared/types/cloudflare-runtime";
import type { DatabaseSync } from "node:sqlite";

export interface SqliteD1Options {
  onAll?: (sql: string) => void;
  onRun?: (sql: string) => void;
  rowsWritten?: (sql: string, changes: number) => number | null;
}

export function createSqliteD1(
  sqlite: DatabaseSync,
  options: SqliteD1Options = {},
): D1Database {
  // Every external operation shares the connection queue. Batch execution uses
  // private synchronous statements so it cannot enqueue behind itself.
  let queue: Promise<unknown> = Promise.resolve();
  const schedule = <T>(operation: () => T): Promise<T> => {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending;
  };
  const batchExecutors = new WeakMap<D1PreparedStatement, () => unknown>();
  const makeStatement = (sql: string, boundValues: unknown[] = []): D1PreparedStatement => {
    const execute = () => {
      options.onRun?.(sql);
      const prepared = sqlite.prepare(sql);
      let results: unknown[] = [];
      let changes: number;
      if (prepared.columns().length > 0) {
        const before = sqlite.prepare("SELECT total_changes() AS count").get()!.count;
        results = prepared.all(...(boundValues as never[]));
        const after = sqlite.prepare("SELECT total_changes() AS count").get()!.count;
        changes = before === after ? 0 : Number(sqlite.prepare("SELECT changes() AS count").get()!.count);
      } else {
        changes = Number(prepared.run(...(boundValues as never[])).changes);
      }
      return {
        results,
        success: true,
        meta: { changes, rows_written: options.rowsWritten ? options.rowsWritten(sql, changes) : changes },
      };
    };
    const statement = {
      bind: (...args: unknown[]) => makeStatement(sql, args),
      all: <T>() => schedule(() => {
        const results = sqlite.prepare(sql).all(...(boundValues as never[])) as T[];
        options.onAll?.(sql);
        return {
          results,
          success: true,
          meta: { rows_written: options.rowsWritten ? options.rowsWritten(sql, 0) : 0 },
        };
      }),
      first: <T>(columnName?: string) => schedule(() => {
        const row = sqlite.prepare(sql).get(...(boundValues as never[]));
        if (!row) return null;
        if (columnName === undefined) return row as T;
        if (!Object.prototype.hasOwnProperty.call(row, columnName)) {
          throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${columnName})`);
        }
        return row[columnName] as T;
      }),
      run: () => schedule(execute),
    } as unknown as D1PreparedStatement;
    batchExecutors.set(statement, execute);
    return statement;
  };
  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => schedule(() => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          const execute = batchExecutors.get(statement);
          if (!execute) throw new Error("SQLite D1 batch requires statements prepared by this database");
          return execute() as D1Result<T>;
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }),
    exec: (sql: string) => schedule(() => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}
