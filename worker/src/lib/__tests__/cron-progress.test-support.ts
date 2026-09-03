import { makeNoopD1 } from "../../test-helpers/noop-d1";

export type DbCall = { sql: string; args: unknown[] };

export function makeCaptureDb(calls: DbCall[]): D1Database {
  const statement = (sql: string, args: unknown[] = []): D1PreparedStatement => ({
    bind: (...nextArgs: unknown[]) => statement(sql, nextArgs),
    run: async () => {
      calls.push({ sql, args });
      return { success: true, meta: { changes: 1 } } as D1Result<unknown>;
    },
    all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
    first: async <T>() => null as T | null,
  } as unknown as D1PreparedStatement);

  return makeNoopD1({
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((item) => item.run())),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  });
}
