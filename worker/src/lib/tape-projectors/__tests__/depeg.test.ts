import { describe, expect, it } from "vitest";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { type MockD1Database } from "@shared/test-utils/mock-d1";
import { projectDepegOpened, projectDepegPeakWorsened, projectDepegResolved } from "../depeg";
import { DEFAULT_BATCH_LIMIT } from "../types";
import { mockTapeD1, tapeCacheWriteBinds, tapeInsertBinds } from "./test-support";

const SEC = 1_700_000_000;
const MATCH_DEPEG_EVENTS = "FROM depeg_events";

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
    expect(tapeInsertBinds(db).map((binds) => binds[13])).toEqual(["1", "2", "3"]);
    expect(tapeInsertBinds(db).map((binds) => binds[16])).toEqual([
      getMethodologyVersionAt("depeg-dews", SEC),
      getMethodologyVersionAt("depeg-dews", SEC),
      getMethodologyVersionAt("depeg-dews", SEC),
    ]);
    expect(tapeCacheWriteBinds(db, "depeg.opened")[0]?.[1]).toBe(String(SEC));
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
    expect(tapeInsertBinds(db).map((binds) => binds[13])).toEqual(["10", "11", "12"]);
    expect(tapeInsertBinds(db).map((binds) => binds[16])).toEqual([
      getMethodologyVersionAt("depeg-dews", SEC + 900),
      getMethodologyVersionAt("depeg-dews", SEC + 900),
      getMethodologyVersionAt("depeg-dews", SEC + 900),
    ]);
    expect(tapeCacheWriteBinds(db, "depeg.resolved")[0]?.[1]).toBe(String(SEC + 900));
  });

  it("caps peak-worsened scans at the maxRows total instead of paging past it", async () => {
    const cappedPage = [
      depegRow({ id: 1, stablecoin_id: "usdt-tether" }),
      depegRow({ id: 2, stablecoin_id: "usdc-circle" }),
    ];
    const beyondCap = [
      depegRow({ id: 3, stablecoin_id: "dai-makerdao" }),
    ];
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [2], rows: cappedPage },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [2, 2], rows: beyondCap },
    ]);

    const result = await projectDepegPeakWorsened(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 0, advanced: null });
    const scans = db.getHistory().filter((entry) => entry.sql.includes(MATCH_DEPEG_EVENTS));
    expect(scans).toHaveLength(1);
    expect(scans[0]?.binds).toEqual([2]);
    const cacheWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache")
        && entry.binds[0] === "tape-projector:peak-worsened-seen");
    expect(JSON.parse(String(cacheWrites[0]?.binds[1]))).toEqual({
      "1": 450,
      "2": 450,
    });
  });

  it("drains every matching open row in default-size pages when no cap is set", async () => {
    const fullPage = Array.from(
      { length: DEFAULT_BATCH_LIMIT },
      (_, index) => depegRow({ id: index + 1, stablecoin_id: "usdt-tether" }),
    );
    const tail = [depegRow({ id: DEFAULT_BATCH_LIMIT + 1, stablecoin_id: "usdc-circle" })];
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [DEFAULT_BATCH_LIMIT], rows: fullPage },
      { match: MATCH_DEPEG_EVENTS, matchBinds: [DEFAULT_BATCH_LIMIT, DEFAULT_BATCH_LIMIT], rows: tail },
    ]);

    const result = await projectDepegPeakWorsened(db);

    expect(result).toEqual({ projected: 0, advanced: null });
    const scans = db.getHistory().filter((entry) => entry.sql.includes(MATCH_DEPEG_EVENTS));
    expect(scans).toHaveLength(2);
    expect(scans[1]?.binds).toEqual([DEFAULT_BATCH_LIMIT, DEFAULT_BATCH_LIMIT]);
    const cacheWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache")
        && entry.binds[0] === "tape-projector:peak-worsened-seen");
    const seen = JSON.parse(String(cacheWrites[0]?.binds[1])) as Record<string, number>;
    expect(Object.keys(seen)).toHaveLength(DEFAULT_BATCH_LIMIT + 1);
  });
});
