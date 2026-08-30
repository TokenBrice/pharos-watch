import type { D1Database, D1PreparedStatement } from "@shared/types/cloudflare-runtime";

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
  /** Optional artificial delay before resolving the statement. */
  delayMs?: number;
  /** Optional error to throw when this statement executes. */
  throwError?: unknown;
  /** Exclude a shared fallback fixture from unused-match assertions. */
  allowUnused?: boolean;
}

export interface MockPreparedStatement extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
}

export interface MockD1Database extends D1Database {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
  assertAllMatchesUsed(): void;
}

export interface MockD1Options {
  /** Shorthand for requireMatch + strictSql. */
  strict?: boolean;
  /** @deprecated mockD1 requires matches by default. Use allowUnmatched for permissive suites. */
  requireMatch?: boolean;
  /** Allow unmatched statements to return the legacy empty/success responses. */
  allowUnmatched?: boolean;
  /** Match normalized SQL exactly instead of substring search. */
  strictSql?: boolean;
  /** Resolve write changes dynamically when a table does not provide runMeta. */
  runChanges?: (sql: string) => number;
  /** Execute every batch entry with run(), matching the legacy scripts preset. */
  batchMode?: "auto" | "run";
}

export function mockD1Strict(tables: MockTableConfig[] = []): MockD1Database {
  return mockD1(tables, { strict: true });
}

export function assertAllD1MatchesUsed(db: Pick<MockD1Database, "assertAllMatchesUsed">): void {
  db.assertAllMatchesUsed();
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

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

async function maybeDelay(table: MockTableConfig | undefined): Promise<void> {
  if (!table?.delayMs || table.delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, table.delayMs));
}

function isCacheKeyLookup(sql: string): boolean {
  return /FROM\s+cache\s+WHERE\s+key\s*=\s*\?/i.test(sql);
}

export function mockD1(tables: MockTableConfig[] = [], options: MockD1Options = {}): MockD1Database {
  if (options.allowUnmatched === true && (options.strict === true || options.requireMatch === true)) {
    throw new Error("mockD1: allowUnmatched cannot be combined with strict or requireMatch");
  }

  const history: Array<{ sql: string; binds: unknown[] }> = [];
  const matchHits = new Map<MockTableConfig, number>();
  const requireMatch = options.allowUnmatched !== true;
  const strictSql = options.strict === true || options.strictSql === true;

  function findTable(sql: string, boundValues: unknown[]): MockTableConfig | undefined {
    const normalizedSql = normalizeSql(sql);
    const sqlMatches = (table: MockTableConfig) => {
      const candidate = strictSql ? normalizeSql(table.match) : table.match;
      return strictSql ? normalizedSql === candidate : sql.includes(candidate);
    };

    const exactBindMatch = tables.find(
      (t) => t.matchBinds && sqlMatches(t) && hasBindMatch(t.matchBinds, boundValues),
    );
    if (exactBindMatch) {
      matchHits.set(exactBindMatch, (matchHits.get(exactBindMatch) ?? 0) + 1);
      return exactBindMatch;
    }

    const fallbackMatch = tables.find(
      (t) => !t.matchBinds && sqlMatches(t) && hasBindMatch(t.matchBinds, boundValues),
    );
    if (fallbackMatch) {
      matchHits.set(fallbackMatch, (matchHits.get(fallbackMatch) ?? 0) + 1);
    }
    return fallbackMatch;
  }

  function createStatement(sql: string, boundValues: unknown[] = []): MockPreparedStatement {
    const executeAll = async <T>() => {
      history.push({ sql, binds: [...boundValues] });
      const table = findTable(sql, boundValues);
      if (!table && requireMatch) {
        throw new Error(`mockD1: no match for SQL: ${normalizeSql(sql)}`);
      }
      if (table?.throwError != null) throw toError(table.throwError);
      await maybeDelay(table);
      return {
        results: (table?.rows ?? []) as T[],
        success: true,
        meta: {},
      };
    };

    const executeFirst = async <T>() => {
      history.push({ sql, binds: [...boundValues] });
      const table = findTable(sql, boundValues);
      if (!table && requireMatch) {
        throw new Error(`mockD1: no match for SQL: ${normalizeSql(sql)}`);
      }
      if (table?.throwError != null) throw toError(table.throwError);
      await maybeDelay(table);
      if (table && isCacheKeyLookup(sql) && typeof boundValues[0] === "string") {
        const keyedRows = table.rows.filter((row) => typeof row.key === "string");
        const keyedFirst = table.first && typeof table.first.key === "string" ? table.first : null;
        const matchingRow = keyedRows.find((row) => row.key === boundValues[0]);
        if (matchingRow) return matchingRow as T;
        if (keyedFirst?.key === boundValues[0]) return keyedFirst as T;
        if (keyedRows.length > 0 || keyedFirst) return null;
      }
      return (table?.first ?? table?.rows?.[0] ?? null) as T | null;
    };

    const executeRun = async () => {
      history.push({ sql, binds: [...boundValues] });
      const table = findTable(sql, boundValues);
      if (!table && requireMatch) {
        throw new Error(`mockD1: no match for SQL: ${normalizeSql(sql)}`);
      }
      if (table?.throwError != null) throw toError(table.throwError);
      await maybeDelay(table);
      return {
        success: true,
        meta: table?.runMeta ?? { changes: options.runChanges?.(sql) ?? 1 },
      };
    };

    const executeRaw = async <T extends unknown[]>() => {
      history.push({ sql, binds: [...boundValues] });
      const table = findTable(sql, boundValues);
      if (!table && requireMatch) {
        throw new Error(`mockD1: no match for SQL: ${normalizeSql(sql)}`);
      }
      if (table?.throwError != null) throw toError(table.throwError);
      await maybeDelay(table);
      return (table?.rows ?? []).map((row) => Object.values(row)) as T[];
    };

    return {
      sql,
      boundValues: [...boundValues],
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: executeAll,
      first: executeFirst,
      run: executeRun,
      raw: executeRaw,
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
          if (options.batchMode === "run" && typeof executable.run === "function") {
            results.push(await executable.run());
            continue;
          }
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
    assertAllMatchesUsed: () => {
      const unused = tables.filter((table) => !table.allowUnused && (matchHits.get(table) ?? 0) === 0);
      if (unused.length > 0) {
        throw new Error(`mockD1: unused table match(es): ${unused.map((table) => table.match).join(", ")}`);
      }
    },
  } as unknown as MockD1Database;
}

/** Permissive preset retained for cross-runtime tests that only observe writes. */
export function makeTestD1Database(
  options: { runChanges?: (sql: string) => number } = {},
): MockD1Database {
  return mockD1([], {
    allowUnmatched: true,
    batchMode: "run",
    runChanges: options.runChanges ?? ((sql) => (sql.includes("DELETE") ? 0 : 1)),
  });
}
