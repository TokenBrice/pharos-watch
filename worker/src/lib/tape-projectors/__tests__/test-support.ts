import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";

/**
 * Shared D1 setup and tape history extractors for projector tests.
 *
 * Write matchers are appended after caller matchers so suite-specific fixtures
 * keep precedence in the substring-based D1 mock.
 */
const TAPE_WRITE_TABLES: MockTableConfig[] = [
  { match: "INSERT OR REPLACE INTO tape_events", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
];

export function mockTapeD1(tables: MockTableConfig[] = []): MockD1Database {
  return mockD1([...tables, ...TAPE_WRITE_TABLES]);
}

export function tapeInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

export function tapeInsertBindsForType(db: MockD1Database, type: string): unknown[][] {
  return tapeInsertBinds(db).filter((binds) => binds[1] === type);
}

export function tapeCacheWriteBinds(db: MockD1Database, cursorKey: string): unknown[][] {
  return db
    .getHistory()
    .filter(
      (entry) =>
        entry.sql.includes("INSERT OR REPLACE INTO cache") &&
        entry.binds[0] === `tape-projector:cursor:${cursorKey}`,
    )
    .map((entry) => entry.binds);
}
