import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { projectTape } from "../project-tape";
import { TAPE_PROJECTOR_JOBS } from "../../lib/tape-projectors/registry";
import { mockTapeD1, tapeInsertBinds, tapeInsertBindsForType } from "../../lib/tape-projectors/__tests__/test-support";
import { projectCemeteryEntries } from "../../lib/tape-projectors/cemetery";
import { projectLifecycleFrozen } from "../../lib/tape-projectors/lifecycle";
import { projectMethodologyBumps } from "../../lib/tape-projectors/methodology";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { SOURCE_RECONCILIATION_LOOKBACK_SEC } from "../../lib/tape-projectors/types";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { observeMockD1Cost } from "../../lib/__tests__/d1-cost.test-support";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { logCronRun, type CronResult } from "../../lib/cron-logger";
import { loadCronHealth } from "../../lib/status/cron-health";
import { loadProducerFreshnessFacts } from "../../lib/status/freshness-oracle";
import { getLatestSuccessfulCronTimestampResult } from "../../lib/api-freshness";
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

const SEC = 1_700_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(SEC * 1000));
const RECONCILIATION_SINCE = SEC - SOURCE_RECONCILIATION_LOOKBACK_SEC;

/**
 * Pull only the inserts emitted for one event-type slug. The static
 * first-observation projectors (methodology / cemetery / lifecycle) run on
 * every cron tick and will emit on an empty in-memory mock; filtering by type
 * keeps each test focused on the projector under exam.
 */
// Match substrings deliberately tolerate the SQL's line-wrapped formatting.
const MATCH_DEPEG_OPEN_PEAK = "ended_at IS NULL";
const MATCH_DEPEG_OPENED = "started_at > ?";
const MATCH_DEPEG_RESOLVED = "AND source = 'live' AND ended_at IS NOT NULL";
const MATCH_BLACKLIST = "FROM blacklist_events";
const MATCH_SAFETY = "FROM safety_grade_history";

function baseTables(): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    { match: "FROM tape_events INDEXED BY idx_tape_source_key", rows: [] },
    { match: "FROM tape_events INDEXED BY idx_tape_type_ts", rows: [] },
    { match: MATCH_DEPEG_OPEN_PEAK, rows: [] },
    { match: MATCH_DEPEG_OPENED, rows: [] },
    { match: MATCH_DEPEG_RESOLVED, rows: [] },
    { match: MATCH_BLACKLIST, rows: [] },
    { match: MATCH_SAFETY, rows: [] },
    { match: "FROM stability_index_samples", rows: [] },
    { match: "FROM stress_signals", rows: [] },
    { match: "FROM mint_burn_events", rows: [] },
    { match: "FROM mint_burn_flows", rows: [] },
    { match: "FROM yield_history", rows: [] },
    { match: "FROM yield_source_decisions", rows: [] },
  ];
}

function dbWithOverride(override: MockTableConfig): MockD1Database {
  // Place override BEFORE the empty defaults so substring-matching picks it
  // up first.
  return mockTapeD1([
    { match: "FROM cache WHERE key", rows: [] },
    override,
    ...baseTables().filter((entry) => entry.match !== override.match && entry.match !== "FROM cache WHERE key"),
  ]) as MockD1Database;
}

describe("projectTape", () => {
  it("emits binding-call costs while preserving SQL rows and projector failures", async () => {
    const rows = [{ id: "observed" }];
    const failure = new Error("original SQL failure");
    const db = mockD1([
      { match: "SELECT id", rows },
      { match: "UPDATE tape", rows: [] },
      { match: "SELECT failed", rows: [], throwError: failure },
    ]);
    const assertCost = observeMockD1Cost(db);
    const jobs = TAPE_PROJECTOR_JOBS as unknown as Array<(typeof TAPE_PROJECTOR_JOBS)[number]>;
    const originalJobs = [...jobs];
    jobs.splice(0, jobs.length, {
      name: "test.sql",
      run: async (trackedDb) => {
        expect((await trackedDb.prepare("SELECT id").all()).results).toBe(rows);
        await trackedDb.batch([trackedDb.prepare("UPDATE tape"), trackedDb.prepare("UPDATE tape")]);
        return { projected: rows.length, advanced: null };
      },
    }, {
      name: "test.failure",
      run: async (trackedDb) => {
        try {
          await trackedDb.prepare("SELECT failed").all();
        } catch (error) {
          expect(error).toBe(failure);
          throw error;
        }
        throw new Error("expected original SQL failure");
      },
    });
    try {
      const result = await projectTape(db);
      expect(result).toMatchObject({ status: "degraded", itemCount: 1 });
      expect(assertCost(result)).toMatchObject({ queries: 4, bindingCalls: 3, batchCalls: 1 });
      expect(JSON.parse(result.metadata!)).toMatchObject({ perClass: { "test.sql": 1, "test.failure": -1 } });
    } finally {
      jobs.splice(0, jobs.length, ...originalJobs);
    }
  });

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
      const result = await projectTape(mockTapeD1([]) as MockD1Database);

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
    const inserts = tapeInsertBindsForType(db, "depeg.opened");
    expect(inserts).toHaveLength(2);
    // bind order: eventId, type, severity, ts, ends_at, coin_id, issuer_id, peg_currency, ...
    expect(inserts[0]![2]).toBe("critical");
    expect(inserts[1]![2]).toBe("notice");
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
    const inserts = tapeInsertBindsForType(db, "depeg.resolved");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("info");
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
    expect(tapeInsertBindsForType(dbBaseline, "depeg.peak_worsened")).toHaveLength(0);

    // Second run: same row now reports a larger magnitude AND the cache holds
    // the prior baseline. A `depeg.peak_worsened` event should fire.
    const dbWorsened = mockTapeD1([
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
      ...baseTables(),
    ]) as MockD1Database;
    await projectTape(dbWorsened);
    const worsened = tapeInsertBindsForType(dbWorsened, "depeg.peak_worsened");
    expect(worsened).toHaveLength(1);
    // severity for 2700 bps abs → critical
    expect(worsened[0]![2]).toBe("critical");
  });

  it("projects freeze.destroyed with severity scaled by USD amount", async () => {
    const db = dbWithOverride({
      match: "AND event_type = ?",
      matchBinds: [RECONCILIATION_SINCE, "destroy", "opened", 500],
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
    const inserts = tapeInsertBindsForType(db, "freeze.destroyed");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("critical");
  });

  it("projects freeze.unblocked as severity=info", async () => {
    const db = dbWithOverride({
      match: "AND event_type = ?",
      matchBinds: [RECONCILIATION_SINCE, "unblacklist", "resolved", 500],
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
    const inserts = tapeInsertBindsForType(db, "freeze.unblocked");
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
    const inserts = tapeInsertBindsForType(db, "score.downgraded");
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
    const inserts = tapeInsertBindsForType(db, "score.upgraded");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("info");
  });

  it("keeps one durable event identity when the same source is replayed", async () => {
    const { sqlite, db } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, peg_reference, source, start_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("usdt-tether", "USDT", "peggedUSD", "below", -1500, now - 60, 1, "live", 0.85);
    await projectTape(db);
    const readEvents = () => sqlite.prepare("SELECT event_id, type, coin_id, severity, ts FROM tape_events WHERE type = 'depeg.opened'").all();
    const first = readEvents();
    expect(first).toHaveLength(1);
    sqlite.prepare("DELETE FROM cache WHERE key LIKE 'tape-projector:cursor:%'").run();
    await projectTape(db);
    expect(readEvents()).toEqual(first);
  });

  it("emits no relational-class events when the source tables are empty", async () => {
    const db = mockTapeD1(baseTables()) as MockD1Database;
    await projectTape(db);
    // Static first-observation projectors still fire on a fresh mock; only
    // assert that the watermark-driven relational projectors emitted nothing.
    expect(tapeInsertBindsForType(db, "depeg.opened")).toHaveLength(0);
    expect(tapeInsertBindsForType(db, "depeg.resolved")).toHaveLength(0);
    expect(tapeInsertBindsForType(db, "depeg.peak_worsened")).toHaveLength(0);
    expect(tapeInsertBindsForType(db, "freeze.blocked")).toHaveLength(0);
    expect(tapeInsertBindsForType(db, "freeze.unblocked")).toHaveLength(0);
    expect(tapeInsertBindsForType(db, "freeze.destroyed")).toHaveLength(0);
    expect(tapeInsertBindsForType(db, "score.upgraded")).toHaveLength(0);
    expect(tapeInsertBindsForType(db, "score.downgraded")).toHaveLength(0);
  });

  it.each([
    { name: "cemetery", project: projectCemeteryEntries },
    { name: "lifecycle", project: projectLifecycleFrozen },
    { name: "methodology", project: projectMethodologyBumps },
  ])("preserves $name source keys and archived identities on repeated catalog scans", async ({ project }) => {
    const { db, sqlite } = fixtures.open();
    await project(db);
    const select = sqlite.prepare("SELECT * FROM tape_events ORDER BY event_id");
    const original = select.all();
    expect(original.length).toBeGreaterThan(0);
    vi.spyOn(Date, "now").mockReturnValue((SEC + 86400) * 1000);
    expect(await project(db)).toEqual({ projected: 0, advanced: null });
    expect(select.all()).toEqual(original);
    const replay = fixtures.open();
    await project(replay.db);
    expect(replay.sqlite.prepare(
      "SELECT event_id, source_table, source_row_id, transition FROM tape_events ORDER BY event_id",
    ).all()).toEqual(sqlite.prepare(
      "SELECT event_id, source_table, source_row_id, transition FROM tape_events ORDER BY event_id",
    ).all());
  });

  it("emits cemetery.entry.added on first observation", async () => {
    const db = mockTapeD1(baseTables()) as MockD1Database;
    await projectTape(db);
    expect(tapeInsertBindsForType(db, "cemetery.entry.added").length).toBeGreaterThan(0);
  });

  it("emits lifecycle.tracked.frozen on first observation", async () => {
    const db = mockTapeD1(baseTables()) as MockD1Database;
    await projectTape(db);
    expect(tapeInsertBindsForType(db, "lifecycle.tracked.frozen").length).toBeGreaterThan(0);
  });

  it("logs and skips cemetery entries with invalid curated dates", async () => {
    const id = "fixture-invalid-cemetery-date";
    const invalid = {
      ...CEMETERY_ENTRIES[0]!,
      id,
      deathDate: "2024-02-31",
    };
    CEMETERY_ENTRIES.push(invalid);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const db = mockTapeD1(baseTables()) as MockD1Database;
      await projectCemeteryEntries(db);

      expect(tapeInsertBinds(db).some((binds) => binds[13] === id)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Skipping cemetery entry ${id}`));
    } finally {
      CEMETERY_ENTRIES.pop();
      warn.mockRestore();
    }
  });

  it("logs and skips frozen lifecycle entries with invalid curated dates", async () => {
    const id = "fixture-invalid-frozen-date";
    const entries = FROZEN_STABLECOINS as Array<(typeof FROZEN_STABLECOINS)[number]>;
    entries.push({
      ...entries[0]!,
      id,
      frozenAt: "24-01-01",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const db = mockTapeD1(baseTables()) as MockD1Database;
      await projectLifecycleFrozen(db);

      expect(tapeInsertBinds(db).some((binds) => binds[13] === id)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Skipping frozen stablecoin ${id}`));
    } finally {
      entries.pop();
      warn.mockRestore();
    }
  });
});

describe("projectTape quiet publication", () => {
  const NOW = 1_800_000_000;
  const HALF_HOUR = 1_800;

  it("confirms output for a settled pass that advances every class watermark without inserting events", async () => {
    vi.useFakeTimers();
    const jobs = TAPE_PROJECTOR_JOBS as unknown as Array<(typeof TAPE_PROJECTOR_JOBS)[number]>;
    const original = [...jobs];
    jobs.splice(0, jobs.length, ...original.map(({ name }) => ({
      name,
      run: async () => ({ projected: 0, advanced: Math.floor(Date.now() / 1000) - 60 }),
    })));
    try {
      vi.setSystemTime(NOW * 1000);
      const { db } = fixtures.open();
      // A productive tick one interval before the quiet ticks established the
      // last publication.
      await logCronRun(db, "project-tape", async () => ({
        status: "ok",
        itemCount: 2,
        metadata: JSON.stringify({ reason: "tape-projection-completed" }),
      }));

      // No event was inserted, but every class read its source and persisted an
      // advanced watermark, so each pass is a confirmed quiet observation.
      let quietResult: CronResult | void | null = null;
      for (const offset of [HALF_HOUR, HALF_HOUR * 2, HALF_HOUR * 3]) {
        vi.setSystemTime((NOW + offset) * 1000);
        quietResult = await logCronRun(db, "project-tape", () => projectTape(db));
      }
      expect(quietResult).toMatchObject({ status: "ok", itemCount: 0 });

      const lastTick = NOW + HALF_HOUR * 3;
      await expect(getLatestSuccessfulCronTimestampResult(db, "project-tape"))
        .resolves.toEqual({ timestamp: lastTick, status: "ok" });
      const [fact] = await loadProducerFreshnessFacts(db, lastTick, [getCronJobMeta("project-tape")!]);
      expect(fact?.lastSuccessAt).toBe(lastTick);
      expect((await loadCronHealth(db, lastTick)).crons["project-tape"].healthy).toBe(true);
    } finally {
      jobs.splice(0, jobs.length, ...original);
      vi.useRealTimers();
    }
  });
});
