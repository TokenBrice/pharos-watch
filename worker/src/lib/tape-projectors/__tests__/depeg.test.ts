import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { DEPEG_RECOVERY_CLOSE_REASONS } from "@shared/lib/depeg-closure";
import { type MockD1Database } from "@shared/test-utils/mock-d1";
import { mapTapeEventRow } from "../../tape-event-helpers";
import { queryTapeEvents } from "../../tape-event-store";
import { projectDepegOpened, projectDepegPeakWorsened, projectDepegResolved } from "../depeg";
import { DEFAULT_BATCH_LIMIT, SOURCE_RECONCILIATION_LOOKBACK_SEC } from "../types";
import { mockTapeD1, tapeCacheWriteBinds, tapeInsertBinds } from "./test-support";

const SEC = 1_700_000_000;
const RECONCILIATION_SINCE = SEC - SOURCE_RECONCILIATION_LOOKBACK_SEC;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(SEC * 1000));
const MATCH_DEPEG_EVENTS = "FROM depeg_events";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

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
  it("reconciles delayed confirmations behind the watermark without duplicating identities or regressing progress", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, source)
      VALUES (?, ?, 'USDT', 'USD', 'below', -450, ?, 0.955, 1, 'live')`);
    insert.run(1, "usdt-tether", SEC);
    expect(await projectDepegOpened(db)).toEqual({ projected: 1, advanced: SEC });
    // Confirmation preserves the earlier pending first-seen time.
    insert.run(2, "usdc-circle", SEC - 1800);
    expect(await projectDepegOpened(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    expect(await projectDepegOpened(db)).toEqual({ projected: 0, advanced: null });
    const events = sqlite.prepare("SELECT source_row_id, ts FROM tape_events ORDER BY source_row_id").all();
    expect(events).toEqual([{ source_row_id: "1", ts: SEC * 1000 }, { source_row_id: "2", ts: (SEC - 1800) * 1000 }]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:depeg.opened'").get()?.value).toBe(String(SEC));

    insert.run(3, "dai-makerdao", RECONCILIATION_SINCE - 1);
    expect(await projectDepegOpened(db)).toEqual({ projected: 0, advanced: null });
    expect(await projectDepegOpened(db, { since: 0, until: RECONCILIATION_SINCE })).toEqual({
      projected: 1, advanced: RECONCILIATION_SINCE - 1,
    });
    expect(await projectDepegOpened(db, { since: 0 })).toEqual({ projected: 0, advanced: null });
  });

  it("reconciles healed old resolutions and excludes non-recovery closures before batch limiting", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price,
       recovery_price, close_reason, peg_reference, source)
      VALUES (?, ?, 'USDT', 'USD', 'below', -450, ?, ?, 0.955, ?, ?, 1, 'live')`);
    insert.run(1, "usdt-tether", SEC - 900, SEC, 1, "recovered-primary");
    insert.run(2, "usdc-circle", SEC - 7200, SEC - 3600, null, null);
    insert.run(3, "dai-makerdao", SEC - 10000, SEC - 8000, null, "superseded-direction");
    expect(await projectDepegResolved(db)).toEqual({ projected: 1, advanced: SEC });
    sqlite.prepare("UPDATE depeg_events SET close_reason = 'recovered-native', recovery_price = 1 WHERE id = 2").run();
    expect(await projectDepegResolved(db, { maxRows: 1, dryRun: true })).toEqual({ projected: 1, advanced: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM tape_events").get()?.count).toBe(1);
    expect(await projectDepegResolved(db, { maxRows: 1 })).toEqual({ projected: 1, advanced: SEC });
    expect(await projectDepegResolved(db, { maxRows: 1 })).toEqual({ projected: 0, advanced: null });
    expect(sqlite.prepare("SELECT source_row_id, ts FROM tape_events ORDER BY source_row_id").all()).toEqual([
      { source_row_id: "1", ts: SEC * 1000 }, { source_row_id: "2", ts: (SEC - 3600) * 1000 },
    ]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:depeg.resolved'").get()?.value).toBe(String(SEC));
  });

  it.each([
    {
      name: "opened batch through same-started_at rows",
      project: projectDepegOpened,
      type: "depeg.opened",
      limitedRows: [
        depegRow({ id: 1, stablecoin_id: "usdt-tether" }),
        depegRow({ id: 2, stablecoin_id: "usdc-circle" }),
      ],
      extraRow: depegRow({ id: 3, stablecoin_id: "dai-makerdao" }),
      limitedBinds: [RECONCILIATION_SINCE, "opened", 2],
      expandedBinds: [RECONCILIATION_SINCE, SEC, "opened"],
      sourceIds: ["1", "2", "3"],
      advanced: SEC,
    },
    {
      name: "resolved batch through same-ended_at rows",
      project: projectDepegResolved,
      type: "depeg.resolved",
      limitedRows: [
        depegRow({ id: 10, ended_at: SEC + 900, recovery_price: 0.999, close_reason: "recovered-primary" }),
        depegRow({ id: 11, ended_at: SEC + 900, recovery_price: 1.001, close_reason: "recovered-dex" }),
      ],
      extraRow: depegRow({ id: 12, ended_at: SEC + 900, recovery_price: 1, close_reason: "recovered-native" }),
      limitedBinds: [RECONCILIATION_SINCE, ...DEPEG_RECOVERY_CLOSE_REASONS, "resolved", 2],
      expandedBinds: [RECONCILIATION_SINCE, SEC + 900, ...DEPEG_RECOVERY_CLOSE_REASONS, "resolved"],
      sourceIds: ["10", "11", "12"],
      advanced: SEC + 900,
    },
  ])("expands a full $name before advancing the watermark", async ({ project, type, limitedRows, extraRow, limitedBinds, expandedBinds, sourceIds, advanced }) => {
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_DEPEG_EVENTS, matchBinds: limitedBinds, rows: limitedRows },
      { match: MATCH_DEPEG_EVENTS, matchBinds: expandedBinds, rows: [...limitedRows, extraRow] },
    ]) as MockD1Database;

    const result = await project(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced });
    expect(tapeInsertBinds(db).map((binds) => binds[13])).toEqual(sourceIds);
    expect(tapeInsertBinds(db).map((binds) => binds[16])).toEqual([
      getMethodologyVersionAt("depeg-dews", advanced),
      getMethodologyVersionAt("depeg-dews", advanced),
      getMethodologyVersionAt("depeg-dews", advanced),
    ]);
    expect(tapeCacheWriteBinds(db, type)[0]?.[1]).toBe(String(advanced));
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
      .filter((entry) => entry.sql.includes("INSERT INTO cache")
        && entry.binds[0] === "tape-projector:peak-worsened-seen");
    expect(JSON.parse(String(cacheWrites[0]?.binds[1]))).toEqual({
      "1": 450,
      "2": 450,
    });
  });

  it("preserves unscanned peak baselines under maxRows and prunes closures only after a full census", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, source)
      VALUES (?, ?, ?, 'USD', 'below', -100, ?, 0.99, 1, 'live')`);
    insert.run(1, "usdt-tether", "USDT", SEC);
    insert.run(2, "usdc-circle", "USDC", SEC);
    const readSeen = () => JSON.parse(String(sqlite.prepare(
      "SELECT value FROM cache WHERE key = 'tape-projector:peak-worsened-seen'",
    ).get()!.value));

    expect(await projectDepegPeakWorsened(db)).toEqual({ projected: 0, advanced: null });
    expect(readSeen()).toEqual({ "1": 100, "2": 100 });
    expect(await projectDepegPeakWorsened(db, { maxRows: 1 })).toEqual({ projected: 0, advanced: null });
    expect(readSeen()).toEqual({ "1": 100, "2": 100 });
    sqlite.prepare("UPDATE depeg_events SET peak_deviation_bps = -200 WHERE id = 2").run();
    expect(await projectDepegPeakWorsened(db)).toEqual({ projected: 1, advanced: null });
    const event = sqlite.prepare("SELECT source_row_id, payload_json FROM tape_events").get()!;
    expect(event.source_row_id).toBe("2:200");
    expect(JSON.parse(String(event.payload_json))).toMatchObject({
      depegEventId: 2, prevAbsDeviationBps: 100, absDeviationBps: 200,
    });

    sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 2").run(SEC + 900);
    await projectDepegPeakWorsened(db, { maxRows: 1 });
    expect(readSeen()).toEqual({ "1": 100, "2": 200 });
    await projectDepegPeakWorsened(db);
    expect(readSeen()).toEqual({ "1": 100 });
  });

  it("rolls back a bounded peak write when its seen-map checkpoint fails", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, source)
      VALUES (1, 'usdt-tether', 'USDT', 'USD', 'below', -100, ?, 0.99, 1, 'live')`).run(SEC);
    await projectDepegPeakWorsened(db);
    sqlite.exec(`UPDATE depeg_events SET peak_deviation_bps = -200;
      CREATE TRIGGER fail_peak_checkpoint BEFORE UPDATE ON cache
      WHEN NEW.key = 'tape-projector:peak-worsened-seen'
      BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END`);

    await expect(projectDepegPeakWorsened(db)).rejects.toThrow("injected checkpoint failure");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM tape_events").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:peak-worsened-seen'").get()?.value)
      .toBe('{"1":100}');
    sqlite.exec("DROP TRIGGER fail_peak_checkpoint");
    vi.mocked(Date.now).mockReturnValue((SEC + 60) * 1000);
    await projectDepegPeakWorsened(db);
    expect(sqlite.prepare("SELECT source_row_id, ts FROM tape_events").all())
      .toEqual([{ source_row_id: "1:200", ts: (SEC + 60) * 1000 }]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:peak-worsened-seen'").get()?.value)
      .toBe('{"1":200}');
  });

  it.each([
    { failure: "checkpoint", retained: 102 },
    { failure: "event batch", retained: 100 },
  ])("retains first-observation identities after a partial $failure failure and retry", async ({ failure, retained }) => {
    const { db, sqlite } = fixtures.open();
    const seed = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, source)
      VALUES (?, 'usdt-tether', 'USDT', 'USD', 'below', -100, ?, 0.99, 1, 'live')`);
    // The source schema identifies incidents by coin/start/source, independently of row ID.
    for (let id = 1; id <= 201; id += 1) seed.run(id, SEC - id);
    await projectDepegPeakWorsened(db);
    sqlite.exec("UPDATE depeg_events SET peak_deviation_bps = -200");
    sqlite.exec(failure === "checkpoint"
      ? `CREATE TRIGGER fail_peak BEFORE UPDATE ON cache
         WHEN NEW.key = 'tape-projector:peak-worsened-seen'
         BEGIN SELECT RAISE(ABORT, 'injected peak failure'); END`
      : `CREATE TRIGGER fail_peak BEFORE INSERT ON tape_events
         WHEN NEW.source_row_id = '101:200'
         BEGIN SELECT RAISE(ABORT, 'injected peak failure'); END`);

    await expect(projectDepegPeakWorsened(db)).rejects.toThrow("injected peak failure");
    const original = sqlite.prepare("SELECT * FROM tape_events ORDER BY id").all();
    expect(original).toHaveLength(retained);
    expect(new Set(original.map((row) => row.ts))).toEqual(new Set([SEC * 1000]));
    const seen = JSON.parse(String(sqlite.prepare(
      "SELECT value FROM cache WHERE key = 'tape-projector:peak-worsened-seen'",
    ).get()?.value));
    expect(Object.keys(seen)).toHaveLength(201);
    expect(new Set(Object.values(seen))).toEqual(new Set([100]));

    sqlite.exec("DROP TRIGGER fail_peak");
    vi.mocked(Date.now).mockReturnValue((SEC + 60) * 1000);
    await projectDepegPeakWorsened(db);
    const result = await queryTapeEvents(db, { filters: {}, limit: 300, cursor: null, includeTotal: true });
    expect(result.total).toBe(201);
    for (const first of original) {
      // Resolve the original permalink and compare numeric ingestion ID,
      // timestamps, payload and every other persisted field after replay.
      expect(await db.prepare("SELECT * FROM tape_events WHERE event_id = ?").bind(first.event_id).first())
        .toEqual(first);
      const row = result.rows.find((item) => item.event_id === first.event_id)!;
      expect(mapTapeEventRow(row).event).toMatchObject({ id: first.event_id, ts: SEC * 1000 });
    }
    expect(result.rows.filter((row) => row.ts === (SEC + 60) * 1000)).toHaveLength(201 - retained);
    const checkpoint = JSON.parse(String(sqlite.prepare(
      "SELECT value FROM cache WHERE key = 'tape-projector:peak-worsened-seen'",
    ).get()?.value));
    expect(new Set(Object.values(checkpoint))).toEqual(new Set([200]));
    expect(await projectDepegPeakWorsened(db)).toEqual({ projected: 0, advanced: null });

    sqlite.exec("UPDATE depeg_events SET peak_deviation_bps = -300 WHERE id = 1");
    expect(await projectDepegPeakWorsened(db)).toEqual({ projected: 1, advanced: null });
    expect(sqlite.prepare("SELECT source_row_id FROM tape_events WHERE source_row_id LIKE '1:%' ORDER BY id").all())
      .toEqual([{ source_row_id: "1:200" }, { source_row_id: "1:300" }]);
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
      .filter((entry) => entry.sql.includes("INSERT INTO cache")
        && entry.binds[0] === "tape-projector:peak-worsened-seen");
    const seen = JSON.parse(String(cacheWrites[0]?.binds[1])) as Record<string, number>;
    expect(Object.keys(seen)).toHaveLength(DEFAULT_BATCH_LIMIT + 1);
  });
});
