/**
 * Lightweight D1 mock for API contract tests.
 * Returns canned row data based on table name substring matching.
 * Tests response shape, not SQL correctness.
 */

interface MockTable {
  /** Substring to match in SQL query (e.g., "mint_burn_hourly") */
  match: string;
  /** Rows to return from .all() */
  rows: unknown[];
  /** Single row to return from .first() (defaults to rows[0]) */
  first?: unknown;
  /** Optional metadata for .run() responses */
  runMeta?: Record<string, unknown>;
}

export function mockD1(tables: MockTable[] = []): D1Database {
  function findTable(sql: string): MockTable | undefined {
    return tables.find((t) => sql.includes(t.match));
  }

  const stmt = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async <T>() => ({
        results: (findTable(sql)?.rows ?? []) as T[],
        success: true,
        meta: {},
      }),
      first: async <T>() =>
        (findTable(sql)?.first ?? findTable(sql)?.rows?.[0] ?? null) as T | null,
      run: async () => ({ success: true, meta: findTable(sql)?.runMeta ?? {} }),
    }),
    all: async <T>() => ({
      results: (findTable(sql)?.rows ?? []) as T[],
      success: true,
      meta: {},
    }),
    first: async <T>() =>
      (findTable(sql)?.first ?? findTable(sql)?.rows?.[0] ?? null) as T | null,
    run: async () => ({ success: true, meta: findTable(sql)?.runMeta ?? {} }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: { all: () => Promise<unknown>; first: () => Promise<unknown> }[]) => {
      const results = [];
      for (const s of stmts) {
        results.push(await s.all());
      }
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}
