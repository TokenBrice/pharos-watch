interface MockStep {
  match: string;
  first?: unknown;
  run?: unknown;
}

interface MockHistoryEntry {
  sql: string;
  binds: unknown[];
}

export function createMockD1(steps: MockStep[]): D1Database & { getHistory(): MockHistoryEntry[] } {
  const history: MockHistoryEntry[] = [];
  const db = {
    prepare(sql: string) {
      const entry: MockHistoryEntry = { sql, binds: [] };
      history.push(entry);
      const statement = {
        bind(...binds: unknown[]) {
          entry.binds = binds;
          return statement;
        },
        async first<T>() {
          const step = steps.find((candidate) => sql.includes(candidate.match));
          return (step?.first ?? null) as T | null;
        },
        async run() {
          const step = steps.find((candidate) => sql.includes(candidate.match));
          return (step?.run ?? { success: true }) as D1Result;
        },
      };
      return statement;
    },
    getHistory: () => history,
  };
  return db as unknown as D1Database & { getHistory(): MockHistoryEntry[] };
}
