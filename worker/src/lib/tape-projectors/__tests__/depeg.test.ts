import { describe, expect, it } from "vitest";
import { getDepegDewsMethodologyVersionAt } from "@shared/lib/methodology-versions/depeg-dews";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { projectDepegOpened, projectDepegResolved } from "../depeg";

const SEC = 1_700_000_000;
const MATCH_DEPEG_EVENTS = "FROM depeg_events";
const TAPE_WRITE_TABLES: MockTableConfig[] = [
  { match: "INSERT OR REPLACE INTO tape_events", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
];

function mockTapeD1(tables: MockTableConfig[] = []): MockD1Database {
  return mockD1([...tables, ...TAPE_WRITE_TABLES]);
}

function depegRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "USD",
    direction: "below",
    peak_deviation_bps: -450,
    started_at: SEC,
    ended_at: null,
    start_price: 0.955,
    recovery_price: null,
    peg_reference: 1,
    source: "live",
    close_reason: null,
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

describe("depeg projector", () => {
  it("expands a full opened batch through same-started_at rows before advancing the watermark", async () => {
    const limitedRows = [
      depegRow({ id: 1, stablecoin_id: "usdt-tether" }),
      depegRow({ id: 2, stablecoin_id: "usdc-circle" }),
    ];
    const expandedRows = [
      ...limitedRows,
      depegRow({ id: 3, stablecoin_id: "dai-makerdao" }),
    ];
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [0, 2], rows: limitedRows },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [0, SEC], rows: expandedRows },
    ]) as MockD1Database;

    const result = await projectDepegOpened(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced: SEC });
    expect(extractInsertBinds(db).map((binds) => binds[13])).toEqual(["1", "2", "3"]);
    expect(extractInsertBinds(db).map((binds) => binds[16])).toEqual([
      getDepegDewsMethodologyVersionAt(SEC),
      getDepegDewsMethodologyVersionAt(SEC),
      getDepegDewsMethodologyVersionAt(SEC),
    ]);
    expect(extractCacheWriteBinds(db, "depeg.opened")[0]?.[1]).toBe(String(SEC));
  });

  it("expands a full resolved batch through same-ended_at rows before advancing the watermark", async () => {
    const limitedRows = [
      depegRow({ id: 10, ended_at: SEC + 900, recovery_price: 0.999, close_reason: "recovered-primary" }),
      depegRow({ id: 11, ended_at: SEC + 900, recovery_price: 1.001, close_reason: "recovered-dex" }),
    ];
    const expandedRows = [
      ...limitedRows,
      depegRow({ id: 12, ended_at: SEC + 900, recovery_price: 1, close_reason: "recovered-native" }),
    ];
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [0, 2], rows: limitedRows },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [0, SEC + 900], rows: expandedRows },
    ]) as MockD1Database;

    const result = await projectDepegResolved(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced: SEC + 900 });
    expect(extractInsertBinds(db).map((binds) => binds[13])).toEqual(["10", "11", "12"]);
    expect(extractInsertBinds(db).map((binds) => binds[16])).toEqual([
      getDepegDewsMethodologyVersionAt(SEC + 900),
      getDepegDewsMethodologyVersionAt(SEC + 900),
      getDepegDewsMethodologyVersionAt(SEC + 900),
    ]);
    expect(extractCacheWriteBinds(db, "depeg.resolved")[0]?.[1]).toBe(String(SEC + 900));
  });
});
