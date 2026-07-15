import { describe, it, expect } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { projectTape, TAPE_PROJECTOR_JOBS } from "../project-tape";

const SEC = 1_700_000_000;

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

/**
 * Pull only the inserts emitted for one event-type slug. The static
 * first-observation projectors (methodology / cemetery / lifecycle) run on
 * every cron tick and will emit on an empty in-memory mock; filtering by type
 * keeps each test focused on the projector under exam.
 */
function extractInsertBindsForType(db: MockD1Database, type: string): unknown[][] {
  return extractInsertBinds(db).filter((binds) => binds[1] === type);
}

// Match substrings deliberately tolerate the SQL's line-wrapped formatting.
const MATCH_DEPEG_OPEN_PEAK = "ended_at IS NULL";
const MATCH_DEPEG_OPENED = "started_at > ?";
const MATCH_DEPEG_RESOLVED = "AND source = 'live' AND ended_at IS NOT NULL";
const MATCH_BLACKLIST = "FROM blacklist_events";
const MATCH_SAFETY = "FROM safety_grade_history";

function baseTables(): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    { match: MATCH_DEPEG_OPEN_PEAK, rows: [] },
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
  it("returns degraded when a projector fails", async () => {
    const jobs = TAPE_PROJECTOR_JOBS as unknown as Array<(typeof TAPE_PROJECTOR_JOBS)[number]>;
    const originalJobs = [...jobs];
    jobs.splice(
      0,
      jobs.length,
      { name: "test.success", run: async () => ({ projected: 2, advanced: null }) },
      {
        name: "test.failure",
        run: async () => {
          throw new Error("projector failed");
        },
      },
    );

    try {
      const result = await projectTape(mockD1([]) as MockD1Database);

      expect(result.status).toBe("degraded");
      expect(result.itemCount).toBe(2);
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        perClass: {
          "test.success": 2,
          "test.failure": -1,
        },
      });
    } finally {
      jobs.splice(0, jobs.length, ...originalJobs);
    }
  });

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

    await projectTape(db);
    const inserts = extractInsertBindsForType(db, "depeg.opened");
    expect(inserts).toHaveLength(2);
    // bind order: eventId, type, severity, ts, ends_at, coin_id, issuer_id, peg_currency, ...
    expect(inserts[0]![2]).toBe("critical");
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
          recovery_price: 1,
          peg_reference: 1,
          source: "live",
          close_reason: "recovered-primary",
          methodology_version: "5.0",
        },
      ],
    });
    await projectTape(db);
    const inserts = extractInsertBindsForType(db, "depeg.resolved");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("info");
  });

  it("does not project depeg.resolved for non-recovery closures", async () => {
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
          recovery_price: null,
          peg_reference: 1,
          source: "live",
          close_reason: "coverage-lost-supply",
          methodology_version: "5.0",
        },
      ],
    });

    await projectTape(db);
    expect(extractInsertBindsForType(db, "depeg.resolved")).toHaveLength(0);
  });

  it("emits depeg.peak_worsened when an open row's magnitude exceeds the last-seen peak", async () => {
    // First run: open row at -1500 bps; seen-map is empty so it becomes the
    // baseline observation and no event is emitted.
    const dbBaseline = dbWithOverride({
      match: MATCH_DEPEG_OPEN_PEAK,
      rows: [
        {
          id: 7,
          stablecoin_id: "usdc-circle",
          symbol: "USDC",
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
    await projectTape(dbBaseline);
    expect(extractInsertBindsForType(dbBaseline, "depeg.peak_worsened")).toHaveLength(0);

    // Second run: same row now reports a larger magnitude AND the cache holds
    // the prior baseline. A `depeg.peak_worsened` event should fire.
    const dbWorsened = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [{ key: "tape-projector:peak-worsened-seen", value: JSON.stringify({ "7": 1500 }) }],
      },
      {
        match: MATCH_DEPEG_OPEN_PEAK,
        rows: [
          {
            id: 7,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -2700, // grew past 1500 → critical (>=2500)
            started_at: SEC,
            ended_at: null,
            peg_reference: 1,
            source: "live",
            methodology_version: "5.0",
          },
        ],
      },
      { match: MATCH_DEPEG_OPENED, rows: [] },
      { match: MATCH_DEPEG_RESOLVED, rows: [] },
      { match: MATCH_BLACKLIST, rows: [] },
      { match: MATCH_SAFETY, rows: [] },
    ]) as MockD1Database;
    await projectTape(dbWorsened);
    const worsened = extractInsertBindsForType(dbWorsened, "depeg.peak_worsened");
    expect(worsened).toHaveLength(1);
    // severity for 2700 bps abs → critical
    expect(worsened[0]![2]).toBe("critical");
  });

  it("projects freeze.destroyed with severity scaled by USD amount", async () => {
    const db = dbWithOverride({
      match: "AND event_type = ?",
      matchBinds: [0, "destroy", 500],
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
    await projectTape(db);
    const inserts = extractInsertBindsForType(db, "freeze.destroyed");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("critical");
  });

  it("projects freeze.unblocked as severity=info", async () => {
    const db = dbWithOverride({
      match: "AND event_type = ?",
      matchBinds: [0, "unblacklist", 500],
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
    await projectTape(db);
    const inserts = extractInsertBindsForType(db, "freeze.unblocked");
    expect(inserts).toHaveLength(1);
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
          transition_kind: "organic-grade-change",
          model: "v8",
          identity_schema_version: 1,
          policy_id: null,
          policy_digest: null,
          evaluation_build_digest: null,
          base_input_generation_id: null,
          model_publication_generation_id: null,
          source_table: "safety_grade_history",
          source_row_id: `usdt-tether:${SEC}`,
          row_sort_id: `legacy:usdt-tether:${SEC}`,
        },
      ],
    });
    await projectTape(db);
    const inserts = extractInsertBindsForType(db, "score.downgraded");
    expect(inserts).toHaveLength(1);
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
          transition_kind: "organic-grade-change",
          model: "v8",
          identity_schema_version: 1,
          policy_id: null,
          policy_digest: null,
          evaluation_build_digest: null,
          base_input_generation_id: null,
          model_publication_generation_id: null,
          source_table: "safety_grade_history",
          source_row_id: `usdt-tether:${SEC}`,
          row_sort_id: `legacy:usdt-tether:${SEC}`,
        },
      ],
    });
    await projectTape(db);
    const inserts = extractInsertBindsForType(db, "score.upgraded");
    expect(inserts).toHaveLength(1);
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
    const inserts = extractInsertBindsForType(db, "depeg.opened");
    expect(inserts.length).toBeGreaterThan(0);
    const firstInsertSql = db.getHistory().find((e) => e.sql.includes("tape_events"))?.sql ?? "";
    expect(firstInsertSql).toContain("INSERT OR REPLACE INTO tape_events");
  });

  it("emits no relational-class events when the source tables are empty", async () => {
    const db = mockD1(baseTables()) as MockD1Database;
    await projectTape(db);
    // Static first-observation projectors still fire on a fresh mock; only
    // assert that the watermark-driven relational projectors emitted nothing.
    expect(extractInsertBindsForType(db, "depeg.opened")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "depeg.resolved")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "depeg.peak_worsened")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "freeze.blocked")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "freeze.unblocked")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "freeze.destroyed")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "score.upgraded")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "score.downgraded")).toHaveLength(0);
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
          prev_grade: "B", // same rank — should be skipped
          prev_score: 76,
          methodology_version: "5.0",
          transition_kind: "organic-grade-change",
          source_table: "safety_grade_history",
          source_row_id: `usdt-tether:${SEC}`,
          row_sort_id: `legacy:usdt-tether:${SEC}`,
        },
      ],
    });
    await projectTape(db);
    expect(extractInsertBindsForType(db, "score.upgraded")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "score.downgraded")).toHaveLength(0);
  });

  it("emits methodology.bumped:<domain> for changelog versions not yet observed", async () => {
    // No tape_events rows for any methodology type → projector should emit at
    // least one event per domain (10 domains in v1).
    const db = mockD1(baseTables()) as MockD1Database;
    await projectTape(db);
    // Each domain emits ≥ 1 entry on a fresh DB.
    const inserts = extractInsertBinds(db).filter(
      (binds) => typeof binds[1] === "string" && (binds[1] as string).startsWith("methodology.bumped:"),
    );
    expect(inserts.length).toBeGreaterThan(0);
  });

  it("emits cemetery.entry.added on first observation", async () => {
    const db = mockD1(baseTables()) as MockD1Database;
    await projectTape(db);
    expect(extractInsertBindsForType(db, "cemetery.entry.added").length).toBeGreaterThan(0);
  });

  it("emits lifecycle.tracked.frozen on first observation", async () => {
    const db = mockD1(baseTables()) as MockD1Database;
    await projectTape(db);
    expect(extractInsertBindsForType(db, "lifecycle.tracked.frozen").length).toBeGreaterThan(0);
  });
});
