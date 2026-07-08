import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database } from "../../../test-helpers/__shared/mock-d1";
import { projectFreezeBlocked } from "../freeze";

const SEC = 1_700_000_000;
const MATCH_BLACKLIST_EVENTS = "FROM blacklist_events";

function blacklistRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "freeze-a",
    stablecoin: "USDT",
    chain_id: "1",
    chain_name: "Ethereum",
    event_type: "blacklist",
    amount_usd_at_event: 1_500_000,
    timestamp: SEC,
    methodology_version: "freeze-v1",
    rowid: 1,
    ...overrides,
  };
}

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

function extractCacheWriteBinds(db: MockD1Database, cursorKey: string): unknown[][] {
  return db
    .getHistory()
    .filter(
      (entry) =>
        entry.sql.includes("INSERT OR REPLACE INTO cache") &&
        entry.binds[0] === `tape-projector:cursor:${cursorKey}`,
    )
    .map((entry) => entry.binds);
}

describe("freeze projector", () => {
  it("expands a full batch through same-timestamp freeze rows before advancing the watermark", async () => {
    const limitedRows = [
      blacklistRow({ id: "freeze-a", rowid: 1 }),
      blacklistRow({ id: "freeze-b", rowid: 2 }),
    ];
    const expandedRows = [
      ...limitedRows,
      blacklistRow({ id: "freeze-c", rowid: 3 }),
    ];
    const db = mockD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_BLACKLIST_EVENTS, matchBinds: [0, "blacklist", 2], rows: limitedRows },
      { match: MATCH_BLACKLIST_EVENTS, matchBinds: [0, SEC, "blacklist"], rows: expandedRows },
    ]) as MockD1Database;

    const result = await projectFreezeBlocked(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced: SEC });
    expect(extractInsertBinds(db).map((binds) => binds[13])).toEqual([
      "freeze-a",
      "freeze-b",
      "freeze-c",
    ]);
    expect(extractCacheWriteBinds(db, "freeze.blocked")[0]?.[1]).toBe(String(SEC));
  });
});
