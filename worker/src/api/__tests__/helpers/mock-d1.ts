/**
 * Lightweight D1 mock for API contract tests.
 * Returns canned row data based on SQL matching and optional bind matching.
 */

export interface MockTableConfig {
  /** Substring to match in SQL query (e.g., "mint_burn_hourly") */
  match: string;
  /** Optional bind array to match in order. */
  matchBinds?: unknown[];
  /** Rows to return from .all() */
  rows: Record<string, unknown>[];
  /** Single row to return from .first() (defaults to rows[0]) */
  first?: Record<string, unknown> | null;
  /** Optional metadata for .run() responses */
  runMeta?: Record<string, unknown>;
  /** Optional error to throw when this statement executes. */
  throwError?: unknown;
}

export interface MockPreparedStatement extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
}

export interface MockD1Database extends D1Database {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

function hasBindMatch(expected: unknown[] | undefined, actual: unknown[]): boolean {
  return !expected || JSON.stringify(actual) === JSON.stringify(expected);
}

function isReadSql(sql: string): boolean {
  return /^\s*SELECT\b/i.test(sql);
}

export function mockD1(tables: MockTableConfig[] = []): MockD1Database {
  const history: Array<{ sql: string; binds: unknown[] }> = [];

  function findTable(sql: string, boundValues: unknown[]): MockTableConfig | undefined {
    const exactBindMatch = tables.find(
      (t) => t.matchBinds && sql.includes(t.match) && hasBindMatch(t.matchBinds, boundValues),
    );
    if (exactBindMatch) return exactBindMatch;

    return tables.find(
      (t) => !t.matchBinds && sql.includes(t.match) && hasBindMatch(t.matchBinds, boundValues),
    );
  }

  function createStatement(sql: string, boundValues: unknown[] = []): MockPreparedStatement {
    const executeAll = async <T>() => {
      history.push({ sql, binds: [...boundValues] });
      const table = findTable(sql, boundValues);
      if (table?.throwError != null) throw toError(table.throwError);
      return {
        results: (table?.rows ?? []) as T[],
        success: true,
        meta: {},
      };
    };

    const executeFirst = async <T>() => {
      history.push({ sql, binds: [...boundValues] });
      const table = findTable(sql, boundValues);
      if (table?.throwError != null) throw toError(table.throwError);
      return (table?.first ?? table?.rows?.[0] ?? null) as T | null;
    };

    const executeRun = async () => {
      history.push({ sql, binds: [...boundValues] });
      const table = findTable(sql, boundValues);
      if (table?.throwError != null) throw toError(table.throwError);
      return { success: true, meta: table?.runMeta ?? {} };
    };

    return {
      sql,
      boundValues: [...boundValues],
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: executeAll,
      first: executeFirst,
      run: executeRun,
    } as unknown as MockPreparedStatement;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      const results: unknown[] = [];
      let batchError: unknown = null;

      for (const statement of stmts) {
        const executable = statement as Partial<MockPreparedStatement> & {
          all?: () => Promise<unknown>;
          first?: () => Promise<unknown>;
          run?: () => Promise<unknown>;
        };

        try {
          if (isReadSql(executable.sql ?? "") && typeof executable.all === "function") {
            results.push(await executable.all());
            continue;
          }
          if (typeof executable.run === "function") {
            results.push(await executable.run());
            continue;
          }
          if (typeof executable.all === "function") {
            results.push(await executable.all());
            continue;
          }
          if (typeof executable.first === "function") {
            results.push(await executable.first());
            continue;
          }
          throw new Error("Mock D1 batch statement has no executable method");
        } catch (err) {
          batchError ??= err;
        }
      }

      if (batchError) throw batchError;
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
  } as unknown as MockD1Database;
}
