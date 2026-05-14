import { describe, it, expect } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../api/__tests__/helpers/mock-d1";
import { projectTape } from "../project-tape";

const SEC = 1_700_000_000;

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

// Match substrings deliberately tolerate the SQL's line-wrapped formatting.
const MATCH_DEPEG_OPENED = "started_at > ?";
const MATCH_DEPEG_RESOLVED = "ended_at IS NOT NULL AND ended_at > ?";
const MATCH_BLACKLIST = "FROM blacklist_events";
const MATCH_SAFETY = "FROM safety_grade_history";

function baseTables(): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    { match: MATCH_DEPEG_OPENED, rows: [] },
    { match: MATCH_DEPEG_RESOLVED, rows: [] },
    { match: MATCH_BLACKLIST, rows: [] },
    { match: MATCH_SAFETY, rows: [] },
  ];
}

function dbWithOverride(override: MockTableConfig): MockD1Database {
  // Place override BEFORE the empty defaults so substring-matching picks it
  // up first.
  return mockD1([
    { match: "FROM cache WHERE key", rows: [] },
    override,
    ...baseTables().filter((entry) => entry.match !== override.match && entry.match !== "FROM cache WHERE key"),
  ]) as MockD1Database;
}

describe("projectTape", () => {
  it("projects depeg.opened with severity scaled by absolute bps", async () => {
    const db = dbWithOverride({
      match: MATCH_DEPEG_OPENED,
      rows: [
        {
          id: 1,
          stablecoin_id: "usdt-tether",
          symbol: "USDT",
          peg_type: "peggedUSD",
          direction: "below",
          peak_deviation_bps: -2600, // critical (>=2500)
          started_at: SEC,
          ended_at: null,
          peg_reference: 1,
          source: "live",
          methodology_version: "5.0",
        },
        {
          id: 2,
          stablecoin_id: "dai-makerdao",
          symbol: "DAI",
          peg_type: "peggedUSD",
          direction: "below",
          peak_deviation_bps: -150, // notice (<300)
          started_at: SEC + 10,
          ended_at: null,
          peg_reference: 1,
          source: "live",
          methodology_version: "5.0",
        },
      ],
    });

    const result = await projectTape(db);
    expect(result.itemCount).toBe(2);

    const inserts = extractInsertBinds(db);
    expect(inserts).toHaveLength(2);
    // bind order: eventId, type, severity, ts, ends_at, coin_id, issuer_id, peg_currency, ...
    expect(inserts[0]![1]).toBe("depeg.opened");
    expect(inserts[0]![2]).toBe("critical");
    expect(inserts[1]![1]).toBe("depeg.opened");
    expect(inserts[1]![2]).toBe("notice");
    // Stable event ids (deterministic hash) so a second run is a no-op.
    expect(typeof inserts[0]![0]).toBe("string");
  });

  it("projects depeg.resolved as severity=info", async () => {
    const db = dbWithOverride({
      match: MATCH_DEPEG_RESOLVED,
      rows: [
        {
          id: 1,
          stablecoin_id: "usdt-tether",
          symbol: "USDT",
          peg_type: "peggedUSD",
          direction: "below",
          peak_deviation_bps: -800,
          started_at: SEC,
          ended_at: SEC + 600,
          peg_reference: 1,
          source: "live",
          methodology_version: "5.0",
        },
      ],
    });
    const result = await projectTape(db);
    expect(result.itemCount).toBe(1);
    const inserts = extractInsertBinds(db);
    expect(inserts[0]![1]).toBe("depeg.resolved");
    expect(inserts[0]![2]).toBe("info");
  });

  it("projects freeze.destroyed with severity scaled by USD amount", async () => {
    const db = dbWithOverride({
      match: "WHERE event_type = ?",
      matchBinds: ["destroy", 0, 500],
      rows: [
        {
          id: "be-1",
          stablecoin: "USDC",
          chain_id: "ethereum",
          chain_name: "Ethereum",
          event_type: "destroy",
          amount_usd_at_event: 250_000_000, // critical (>=100M)
          timestamp: SEC,
          methodology_version: "3.1",
          rowid: 1,
        },
      ],
    });
    const result = await projectTape(db);
    expect(result.itemCount).toBe(1);
    const inserts = extractInsertBinds(db);
    expect(inserts[0]![1]).toBe("freeze.destroyed");
    expect(inserts[0]![2]).toBe("critical");
  });

  it("projects freeze.unblocked as severity=info", async () => {
    const db = dbWithOverride({
      match: "WHERE event_type = ?",
      matchBinds: ["unblacklist", 0, 500],
      rows: [
        {
          id: "be-2",
          stablecoin: "USDC",
          chain_id: "ethereum",
          chain_name: "Ethereum",
          event_type: "unblacklist",
          amount_usd_at_event: null,
          timestamp: SEC,
          methodology_version: "3.1",
          rowid: 2,
        },
      ],
    });
    const result = await projectTape(db);
    expect(result.itemCount).toBe(1);
    const inserts = extractInsertBinds(db);
    expect(inserts[0]![1]).toBe("freeze.unblocked");
    expect(inserts[0]![2]).toBe("info");
  });

  it("projects score.downgraded landing on F as severity=critical", async () => {
    const db = dbWithOverride({
      match: MATCH_SAFETY,
      rows: [
        {
          stablecoin_id: "usdt-tether",
          recorded_at: SEC,
          grade: "F",
          score: 10,
          prev_grade: "B",
          prev_score: 70,
          methodology_version: "5.0",
          rowid: 1,
        },
      ],
    });
    const result = await projectTape(db);
    expect(result.itemCount).toBe(1);
    const inserts = extractInsertBinds(db);
    expect(inserts[0]![1]).toBe("score.downgraded");
    expect(inserts[0]![2]).toBe("critical");
  });

  it("projects score.upgraded as severity=info", async () => {
    const db = dbWithOverride({
      match: MATCH_SAFETY,
      rows: [
        {
          stablecoin_id: "usdt-tether",
          recorded_at: SEC,
          grade: "A-",
          score: 88,
          prev_grade: "B+",
          prev_score: 81,
          methodology_version: "5.0",
          rowid: 1,
        },
      ],
    });
    const result = await projectTape(db);
    expect(result.itemCount).toBe(1);
    const inserts = extractInsertBinds(db);
    expect(inserts[0]![1]).toBe("score.upgraded");
    expect(inserts[0]![2]).toBe("info");
  });

  it("uses INSERT OR REPLACE so re-runs are idempotent on the source key", async () => {
    const db = dbWithOverride({
      match: MATCH_DEPEG_OPENED,
      rows: [
        {
          id: 1,
          stablecoin_id: "usdt-tether",
          symbol: "USDT",
          peg_type: "peggedUSD",
          direction: "below",
          peak_deviation_bps: -1500,
          started_at: SEC,
          ended_at: null,
          peg_reference: 1,
          source: "live",
          methodology_version: "5.0",
        },
      ],
    });

    await projectTape(db);
    const inserts = extractInsertBinds(db);
    expect(inserts.length).toBeGreaterThan(0);
    const firstInsertSql = db.getHistory().find((e) => e.sql.includes("tape_events"))?.sql ?? "";
    expect(firstInsertSql).toContain("INSERT OR REPLACE INTO tape_events");
  });

  it("returns empty result when no source rows are new", async () => {
    const db = mockD1(baseTables()) as MockD1Database;
    const result = await projectTape(db);
    expect(result.itemCount).toBe(0);
    expect(extractInsertBinds(db)).toHaveLength(0);
  });

  it("filters out same-grade rows from score history", async () => {
    const db = dbWithOverride({
      match: MATCH_SAFETY,
      rows: [
        {
          stablecoin_id: "usdt-tether",
          recorded_at: SEC,
          grade: "B",
          score: 75,
          prev_grade: "B",      // same rank — should be skipped
          prev_score: 76,
          methodology_version: "5.0",
          rowid: 1,
        },
      ],
    });
    const result = await projectTape(db);
    expect(result.itemCount).toBe(0);
  });
});
