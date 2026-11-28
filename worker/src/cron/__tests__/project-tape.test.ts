import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { YIELD_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { PlacedProjectTapeResultSchema as TapeResult } from "@shared/types/placed-executor";
import { projectTape } from "../project-tape";
import { TAPE_PROJECTOR_JOBS } from "../../lib/tape-projectors/registry";
import { mockTapeD1, tapeInsertBinds, tapeInsertBindsForType } from "../../lib/tape-projectors/__tests__/test-support";
import { projectCemeteryEntries } from "../../lib/tape-projectors/cemetery";
import { projectLifecycleFrozen } from "../../lib/tape-projectors/lifecycle";
import { projectMethodologyBumps } from "../../lib/tape-projectors/methodology";
import { queryTapeEvents } from "../../lib/tape-event-store";
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

const MATCH_DEPEG_OPEN_PEAK = "ended_at IS NULL";
const MATCH_DEPEG_OPENED = "started_at > ?";
const MATCH_DEPEG_RESOLVED = "AND source = 'live' AND ended_at IS NOT NULL";
const MATCH_BLACKLIST = "FROM blacklist_events";
const MATCH_SAFETY = "FROM safety_grade_history";

function baseTables(): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    { match: "INDEXED BY idx_tape_source_key", rows: [] },
    { match: "INDEXED BY idx_tape_type_ts", rows: [] },
    { match: "UPDATE tape_events SET ts = ?", rows: [] },
    { match: MATCH_DEPEG_OPEN_PEAK, rows: [] },
    { match: MATCH_DEPEG_OPENED, rows: [] },
    { match: MATCH_DEPEG_RESOLVED, rows: [] },
    { match: MATCH_BLACKLIST, rows: [] },
    { match: MATCH_SAFETY, rows: [] },
    { match: "FROM stability_index_samples", rows: [] },
    { match: "FROM stress_signals", rows: [] },
    ...["events", "flows", "scan_coverage", "admission", "publication_policy", "hourly"].map((table) => ({
      match: `FROM mint_burn_${table}`, rows: [],
    })),
    { match: "pharos:mint-burn-scan-coverage:read", rows: [] },
    { match: "FROM yield_history", rows: [] },
    { match: "FROM yield_source_decisions", rows: [] },
  ];
}

function dbWithOverride(override: MockTableConfig): MockD1Database {
  return mockTapeD1([
    { match: "FROM cache WHERE key", rows: [] },
    override,
    ...baseTables().filter((entry) => entry.match !== override.match && entry.match !== "FROM cache WHERE key"),
  ]) as MockD1Database;
}

function depegRow(overrides: Record<string, unknown>) {
  return {
    id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
    direction: "below", peak_deviation_bps: -800, started_at: SEC, ended_at: null,
    peg_reference: 1, source: "live", methodology_version: "5.0", ...overrides,
  };
}

function safetyRow(overrides: Record<string, unknown>) {
  return {
    stablecoin_id: "usdt-tether", recorded_at: SEC, methodology_version: "5.0",
    transition_kind: "organic-grade-change", model: "v8", identity_schema_version: 1,
    policy_id: null, policy_digest: null, evaluation_build_digest: null,
    base_input_generation_id: null, model_publication_generation_id: null,
    source_table: "safety_grade_history", source_row_id: `usdt-tether:${SEC}`,
    row_sort_id: `legacy:usdt-tether:${SEC}`, ...overrides,
  };
}

describe("projectTape", () => {
  it("emits binding-call costs while preserving SQL rows and projector failures", async () => {
    const rows = [{ id: "observed" }];
    const failure = new Error("original SQL failure Bearer test-secret");
    const db = mockD1([
      { match: "SELECT id", rows },
      { match: "UPDATE tape", rows: [] },
      { match: "SELECT failed", rows: [], throwError: failure },
    ]);
    const assertCost = observeMockD1Cost(db);
    const jobs = TAPE_PROJECTOR_JOBS as unknown as Array<(typeof TAPE_PROJECTOR_JOBS)[number]>;
    const originalJobs = [...jobs];
    jobs.splice(0, jobs.length, {
      name: "test.failure",
      run: async (trackedDb) => {
        await expect(trackedDb.prepare("SELECT failed").all()).rejects.toBe(failure);
        throw failure;
      },
    }, {
      name: "test.sql",
      run: async (trackedDb) => {
        expect((await trackedDb.prepare("SELECT id").all()).results).toBe(rows);
        await trackedDb.batch([trackedDb.prepare("UPDATE tape"), trackedDb.prepare("UPDATE tape")]);
        return { projected: rows.length, advanced: null };
      },
    });
    try {
      const result = TapeResult.parse(await projectTape(db));
      expect(result).toMatchObject({ status: "degraded", itemCount: 1,
        productivity: { productive: false, reason: "tape-projector-failed" } });
      expect(assertCost(result)).toMatchObject({ queries: 4, bindingCalls: 3, batchCalls: 1 });
      expect(JSON.parse(result.metadata)).toMatchObject({ reason: "tape-projector-failed",
        perClass: { "test.sql": 1, "test.failure": -1 },
        classFailures: { "test.failure": { name: "Error", message: "original SQL failure Bearer [redacted]" } } });
      jobs.splice(0, jobs.length, ...originalJobs.map(({ name }) => ({ name, run: async () => {
        throw Object.assign(new Error("\u0001".repeat(500)), { name: "\u0001".repeat(100) });
      } })));
      const failed = await projectTape(db);
      expect(Object.keys(JSON.parse(failed.metadata).classFailures)).toHaveLength(originalJobs.length);
      expect(new TextEncoder().encode(failed.metadata).length).toBeLessThan(8192);
    } finally {
      jobs.splice(0, jobs.length, ...originalJobs);
    }
  });

  it("projects depeg.opened with severity scaled by absolute bps", async () => {
    const db = dbWithOverride({
      match: MATCH_DEPEG_OPENED,
      rows: [
        depegRow({ id: 1, peak_deviation_bps: -2600 }), // critical (>=2500)
        depegRow({ id: 2, stablecoin_id: "dai-makerdao", symbol: "DAI", peak_deviation_bps: -150, started_at: SEC + 10 }), // notice (<300)
      ],
    });

    const result = TapeResult.parse(await projectTape(db));
    expect(result).toMatchObject({ status: "ok",
      productivity: { productive: true, reason: "tape-projection-current" } });
    const historical = TapeResult.extend({
      productivity: TapeResult.shape.productivity.unwrap().omit({ reason: true }).optional(),
    });
    expect(historical.safeParse(result).success).toBe(false);
    const inserts = tapeInsertBindsForType(db, "depeg.opened");
    expect(inserts).toHaveLength(2);
    expect(inserts[0]![2]).toBe("critical");
    expect(inserts[1]![2]).toBe("notice");
  });

  it("projects depeg.resolved as severity=info", async () => {
    const db = dbWithOverride({
      match: MATCH_DEPEG_RESOLVED,
      rows: [depegRow({ ended_at: SEC + 600, recovery_price: 1, close_reason: "recovered-primary" })],
    });
    await projectTape(db);
    const inserts = tapeInsertBindsForType(db, "depeg.resolved");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("info");
  });

  it("emits depeg.peak_worsened when an open row's magnitude exceeds the last-seen peak", async () => {
    const dbBaseline = dbWithOverride({
      match: MATCH_DEPEG_OPEN_PEAK,
      rows: [depegRow({ id: 7, stablecoin_id: "usdc-circle", symbol: "USDC", peak_deviation_bps: -1500 })],
    });
    await projectTape(dbBaseline);
    expect(tapeInsertBindsForType(dbBaseline, "depeg.peak_worsened")).toHaveLength(0);

    const dbWorsened = mockTapeD1([
      {
        match: "FROM cache WHERE key",
        rows: [{ key: "tape-projector:peak-worsened-seen", value: JSON.stringify({ "7": 1500 }) }],
      },
      {
        match: MATCH_DEPEG_OPEN_PEAK,
        rows: [depegRow({ id: 7, stablecoin_id: "usdc-circle", symbol: "USDC", peak_deviation_bps: -2700 })], // critical (>=2500)
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
      rows: [safetyRow({ grade: "F", score: 10, prev_grade: "B", prev_score: 70 })],
    });
    await projectTape(db);
    const inserts = tapeInsertBindsForType(db, "score.downgraded");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("critical");
  });

  it("projects score.upgraded as severity=info", async () => {
    const db = dbWithOverride({
      match: MATCH_SAFETY,
      rows: [safetyRow({ grade: "A-", score: 88, prev_grade: "B+", prev_score: 81 })],
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

  it("inserts new methodology bumps and reconciles drifted clocks/payloads in place without steady-state or dry-run writes", async () => {
    const { db, sqlite } = fixtures.open();
    await projectMethodologyBumps(db);
    const getRow = (table: string, ver: string) => sqlite.prepare(
      "SELECT * FROM tape_events WHERE source_table = ? AND source_row_id = ?",
    ).get(table, ver)!;
    const y855 = getRow("methodology:yield", "8.55");
    const p697 = getRow("methodology:pricing-pipeline", "6.97");
    const drift = sqlite.prepare(
      "UPDATE tape_events SET event_id = ?, ts = ?, title = ?, summary = ?, severity = ?, payload_json = ?, suppressed_at = ?, suppression_reason = ? WHERE id = ?",
    );
    const oldTs = 1_795_046_400_000;
    const oldId = String(y855.event_id).replace(/^\d+/, String(oldTs));
    const oldPayload = JSON.stringify({ effectiveAt: oldTs / 1000, impact: ["Pending"] });
    const pOldId = String(p697.event_id).replace(/^\d+/, "1795723200000");
    sqlite.exec("DELETE FROM tape_events WHERE source_table = 'methodology:yield' AND source_row_id = '8.56'");
    drift.run(oldId, oldTs, "Old title", "Old summary", "warning", oldPayload, null, null, y855.id!);
    drift.run(pOldId, 1_795_723_200_000, p697.title, p697.summary, p697.severity, oldPayload, null, null, p697.id!);

    const prepare = vi.spyOn(db, "prepare");
    const updates = () => prepare.mock.calls.filter(([sql]) => sql.startsWith("UPDATE tape_events")).length;
    expect(await projectMethodologyBumps(db, { dryRun: true })).toEqual({ projected: 1, advanced: null });
    expect(updates()).toBe(0);
    expect(getRow("methodology:yield", "8.55")).toMatchObject({ ts: oldTs, title: "Old title", payload_json: oldPayload });

    expect(await projectMethodologyBumps(db)).toEqual({ projected: 1, advanced: null });
    expect(updates()).toBe(2);
    expect(getRow("methodology:yield", "8.56")).toMatchObject({ ts: 1_795_053_600_000 });
    expect(getRow("methodology:yield", "8.55")).toEqual({ ...y855, event_id: oldId });
    expect(getRow("methodology:pricing-pipeline", "6.97")).toEqual({ ...p697, event_id: pOldId });

    prepare.mockClear();
    expect(await projectMethodologyBumps(db)).toEqual({ projected: 0, advanced: null });
    expect(updates()).toBe(0);

    drift.run(oldId, oldTs, y855.title, y855.summary, y855.severity, oldPayload, SEC, "editorial-suppression", y855.id!);
    expect(await projectMethodologyBumps(db)).toEqual({ projected: 0, advanced: null });
    expect(getRow("methodology:yield", "8.55")).toEqual({
      ...y855, event_id: oldId, suppressed_at: SEC, suppression_reason: "editorial-suppression",
    });
    const visible = await queryTapeEvents(db, {
      filters: { typeExact: ["methodology.bumped:yield"], since: 1_795_013_063_000, until: 1_795_053_600_000 },
      limit: 3, cursor: null, includeTotal: false,
    });
    expect(visible.rows.map((row) => row.methodology_version)).toEqual(["8.56"]);

    const entries = YIELD_METHODOLOGY_CHANGELOG as Array<(typeof YIELD_METHODOLOGY_CHANGELOG)[number]>;
    entries.push({ ...entries[0]!, version: "0.0-invalid", effectiveAt: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await projectMethodologyBumps(db)).toEqual({ projected: 0, advanced: null });
      expect(getRow("methodology:yield", "0.0-invalid")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping methodology entry yield v0.0-invalid"));
    } finally {
      entries.pop();
      warn.mockRestore();
    }
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
      await logCronRun(db, "project-tape", async () => ({
        status: "ok",
        itemCount: 2,
        metadata: JSON.stringify({ reason: "tape-projection-completed" }),
      }));

      let quietResult: CronResult | void | null = null;
      for (const offset of [HALF_HOUR, HALF_HOUR * 2, HALF_HOUR * 3]) {
        vi.setSystemTime((NOW + offset) * 1000);
        quietResult = await logCronRun(db, "project-tape", async () => TapeResult.parse(await projectTape(db)));
      }
      expect(quietResult).toMatchObject({ status: "ok", itemCount: 0,
        productivity: { productive: true, reason: "tape-projection-current" } });

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
