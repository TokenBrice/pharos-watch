import { describe, expect, it } from "vitest";
import { getDepegDewsMethodologyVersionAt } from "@shared/lib/methodology-versions/depeg-dews";
import { type MockD1Database } from "@shared/test-utils/mock-d1";
import { projectDepegOpened, projectDepegResolved } from "../depeg";
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
      getDepegDewsMethodologyVersionAt(SEC),
      getDepegDewsMethodologyVersionAt(SEC),
      getDepegDewsMethodologyVersionAt(SEC),
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
      getDepegDewsMethodologyVersionAt(SEC + 900),
      getDepegDewsMethodologyVersionAt(SEC + 900),
      getDepegDewsMethodologyVersionAt(SEC + 900),
    ]);
    expect(tapeCacheWriteBinds(db, "depeg.resolved")[0]?.[1]).toBe(String(SEC + 900));
  });
});
