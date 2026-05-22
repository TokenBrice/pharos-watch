import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { vi } from "vitest";

export interface TestD1Database extends D1Database {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
}

export type RemoteD1Like = {
  query<T>(sql: string): T[];
  queryRaw(sql: string): string;
  executeStatements(statements: string[], prefix: string): void;
};

export type RemoteD1Mock = RemoteD1Like & {
  executeStatementsMock: ReturnType<typeof vi.fn>;
  queryMock: ReturnType<typeof vi.fn>;
  queryRawMock: ReturnType<typeof vi.fn>;
};

export function makeTestD1Database(options: { runChanges?: (sql: string) => number } = {}): TestD1Database {
  const history: Array<{ sql: string; binds: unknown[] }> = [];
  const runChanges = options.runChanges ?? ((sql: string) => (sql.includes("DELETE") ? 0 : 1));

  function buildStatement(sql: string, binds: unknown[] = []): D1PreparedStatement {
    return {
      bind: (...nextBinds: unknown[]) => buildStatement(sql, nextBinds),
      run: async () => {
        history.push({ sql, binds: [...binds] });
        return { success: true, meta: { changes: runChanges(sql) } };
      },
      first: async () => {
        history.push({ sql, binds: [...binds] });
        return null;
      },
      all: async () => {
        history.push({ sql, binds: [...binds] });
        return { results: [], success: true, meta: {} };
      },
      raw: async () => {
        history.push({ sql, binds: [...binds] });
        return [];
      },
    } as unknown as D1PreparedStatement;
  }

  return {
    prepare: (sql: string) => buildStatement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results as Awaited<ReturnType<D1Database["batch"]>>;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
  } as unknown as TestD1Database;
}

export function createRemoteD1Mock<TQueryRow = Record<string, unknown>>(queryRows: TQueryRow[] = []): RemoteD1Mock {
  const queryMock = vi.fn(() => queryRows);
  const queryRawMock = vi.fn(() => "[]");
  const executeStatementsMock = vi.fn();

  return {
    query: queryMock as RemoteD1Like["query"],
    queryRaw: queryRawMock,
    executeStatements: executeStatementsMock,
    queryMock,
    queryRawMock,
    executeStatementsMock,
  };
}
