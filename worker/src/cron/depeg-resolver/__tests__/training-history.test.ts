import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeDuration, groupIncidents, type DdrStratumKey } from "@shared/lib/depeg-resolver";
import { DDR_INELIGIBLE_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { auditVerdictNotInSql } from "../../../lib/depeg-audit";
import { HISTORICAL_ROW_CAP, TRAINING_ROLLUP_BACKFILL_EVENT_CAP, TRAINING_WINDOW_SEC } from "../constants";
import { loadDdrHistoricalEvents } from "../context";
import { readDdrTrainingHistory, type DdrTrainingHistoryRow } from "../training-history";
import { seedAssessmentSample, seedHistoricalEvent } from "./context.test-support";
import { NOW_SEC } from "./depeg-resolver.test-support";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.restoreAllMocks();
  fixtures.closeAll();
});
const windowStart = NOW_SEC - TRAINING_WINDOW_SEC;
const startedAt = NOW_SEC - 10 * 86400;

// Frozen pre-rollup query: do not share the new query builder or aggregate view.
async function legacyHistory(db: D1Database, directions = ["below"]): Promise<DdrTrainingHistoryRow[]> {
  const audit = auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS);
  const result = await db.prepare(
    "WITH history AS (" +
    "SELECT id, stablecoin_id, peg_type, direction, source, peak_deviation_bps, started_at, ended_at, recovery_price, close_reason " +
    "FROM depeg_events_with_provenance WHERE ended_at IS NOT NULL AND started_at >= ? " +
    `AND ${audit.sql} AND direction IN (${directions.map(() => "?").join(",")}) ` +
    `ORDER BY started_at ASC, id ASC LIMIT ${HISTORICAL_ROW_CAP}) ` +
    "SELECT h.*, p.first_seen_bps, p.last_seen_bps, p.last_seen_at, " +
    "(SELECT json_group_array(json_object('observedAt', a.assessed_at, 'deviationBps', " +
    "CASE WHEN json_valid(a.row_json) THEN json_extract(a.row_json, '$.currentDeviationBps') END)) " +
    "FROM depeg_resolver_assessments a WHERE a.event_id = h.id AND a.stablecoin_id = h.stablecoin_id " +
    "AND a.direction = h.direction AND a.started_at = h.started_at " +
    "AND a.assessed_at >= h.started_at AND a.assessed_at <= h.ended_at) AS severity_observations_json " +
    "FROM history h LEFT JOIN depeg_pending_outcomes p ON h.source = 'live' AND p.outcome = 'promoted' " +
    "AND p.stablecoin_id = h.stablecoin_id AND p.peg_type = h.peg_type AND p.direction = h.direction " +
    "AND p.first_seen_at = h.started_at " +
    "AND NOT EXISTS (SELECT 1 FROM depeg_pending_outcomes duplicate WHERE duplicate.outcome = 'promoted' " +
    "AND duplicate.stablecoin_id = p.stablecoin_id AND duplicate.peg_type = p.peg_type " +
    "AND duplicate.direction = p.direction AND duplicate.first_seen_at = p.first_seen_at AND duplicate.id != p.id) " +
    "ORDER BY h.started_at ASC, h.id ASC",
  ).bind(windowStart, ...audit.binds, ...directions).all<DdrTrainingHistoryRow>();
  return result.results ?? [];
}

describe("DDR training corpus rollup", () => {
  it("returns byte-identical history including window edges, empty samples, audit exclusions and ambiguous onset", async () => {
    const { sqlite, db } = fixtures.open();
    for (const [id, date] of [[1, windowStart - 1], [2, windowStart], [3, windowStart + 1], [4, startedAt]]) {
      seedHistoricalEvent(sqlite, { id, coin: `coin-${id}`, startedAt: date, timed: id !== 3 });
    }
    seedHistoricalEvent(sqlite, { id: 5, coin: "excluded", startedAt, verdict: "false_positive" });
    seedHistoricalEvent(sqlite, { id: 6, coin: "above", startedAt });
    sqlite.exec("UPDATE depeg_events SET direction = 'above' WHERE id = 6");
    seedHistoricalEvent(sqlite, { id: 7, coin: "open", startedAt });
    sqlite.exec("UPDATE depeg_events SET ended_at = NULL WHERE id = 7");
    seedAssessmentSample(sqlite, 2, "coin-2", windowStart, windowStart, -500);
    seedAssessmentSample(sqlite, 4, "coin-4", startedAt, startedAt + 300, -600);
    // Different checkpoints preserve duplicate clocks, insertion-vs-time ordering,
    // malformed JSON, nonnumeric evidence and exact identity/time predicates.
    sqlite.exec(`
      INSERT INTO depeg_resolver_assessments
      SELECT id + 100, event_id, stablecoin_id, symbol, name, peg_currency, governance,
        direction, started_at, assessed_at + 1, event_age_sec, 'age_1h', methodology_version,
        methodology_version_label, resolution_rubric_version, duration_model_version,
        incident_grouping_version, support_rules_version, resolution_tier,
        duration_suppressed, duration_suppressed_reason, median_remaining_sec,
        iqr_low_remaining_sec, iqr_high_remaining_sec, stratum, horizons_json,
        factors_json, 'not-json', created_at, updated_at
      FROM depeg_resolver_assessments WHERE event_id = 4;
      INSERT INTO depeg_resolver_assessments
      SELECT id + 200, event_id, stablecoin_id, symbol, name, peg_currency, governance,
        direction, started_at, assessed_at, event_age_sec, 'age_6h', methodology_version,
        methodology_version_label, resolution_rubric_version, duration_model_version,
        incident_grouping_version, support_rules_version, resolution_tier,
        duration_suppressed, duration_suppressed_reason, median_remaining_sec,
        iqr_low_remaining_sec, iqr_high_remaining_sec, stratum, horizons_json,
        factors_json, '{"currentDeviationBps":"-900"}', created_at, updated_at
      FROM depeg_resolver_assessments WHERE event_id = 4 AND checkpoint = 'latest';
      INSERT INTO depeg_pending_outcomes
      SELECT id + 100, pending_id, stablecoin_id, symbol, peg_type, direction, reason,
        first_seen_bps, first_seen_at, first_price, last_seen_bps, last_seen_at,
        last_price, peak_seen_bps, peak_price, peg_reference, outcome, outcome_at,
        confirming_sources, opposing_sources, unavailable_sources, circuit_open_sources,
        final_decision_reason, created_at
      FROM depeg_pending_outcomes WHERE stablecoin_id = 'coin-4';
    `);
    const prepare = vi.spyOn(db, "prepare");
    const rolled = await readDdrTrainingHistory(db, ["below", "above"], windowStart);
    expect(prepare.mock.calls).toHaveLength(1);
    expect(JSON.stringify(rolled)).toBe(JSON.stringify(await legacyHistory(db, ["below", "above"])));
    expect(rolled.map((row) => row.id)).toEqual([2, 3, 4, 6]);
    expect(rolled.find((row) => row.id === 3)?.severity_observations_json).toBe("[]");
    expect(rolled.find((row) => row.id === 4)?.first_seen_bps).toBeNull();
  });

  it("keeps inclusive observation boundaries and rejects every mismatched assessment identity", async () => {
    const { sqlite, db } = fixtures.open();
    seedHistoricalEvent(sqlite, { id: 1, coin: "coin", startedAt, timed: false });
    seedAssessmentSample(sqlite, 1, "coin", startedAt, startedAt + 300, -600);
    const endedAt = startedAt + 72 * 3600;
    const cases = [
      { coin: "coin", direction: "below", start: startedAt, at: startedAt, count: 1 },
      { coin: "coin", direction: "below", start: startedAt, at: endedAt, count: 1 },
      { coin: "coin", direction: "below", start: startedAt, at: startedAt - 1, count: 0 },
      { coin: "coin", direction: "below", start: startedAt, at: endedAt + 1, count: 0 },
      { coin: "other", direction: "below", start: startedAt, at: startedAt, count: 0 },
      { coin: "coin", direction: "above", start: startedAt, at: startedAt, count: 0 },
      { coin: "coin", direction: "below", start: startedAt + 1, at: startedAt, count: 0 },
    ];
    for (const sample of cases) {
      sqlite.prepare("UPDATE depeg_resolver_assessments SET stablecoin_id = ?, direction = ?, started_at = ?, assessed_at = ? WHERE event_id = 1")
        .run(sample.coin, sample.direction, sample.start, sample.at);
      const rolled = await readDdrTrainingHistory(db, ["below"], windowStart);
      expect(JSON.stringify(rolled)).toBe(JSON.stringify(await legacyHistory(db)));
      expect(JSON.parse(rolled[0].severity_observations_json ?? "[]")).toHaveLength(sample.count);
    }
  });

  it("maintains close/reopen, late insert, ignored insert, replacement, update, move and delete atomically", async () => {
    const { sqlite, db } = fixtures.open();
    seedHistoricalEvent(sqlite, { id: 1, coin: "coin", startedAt });
    seedHistoricalEvent(sqlite, { id: 2, coin: "other", startedAt });
    sqlite.exec("UPDATE depeg_events SET ended_at = NULL WHERE id = 1");
    seedAssessmentSample(sqlite, 1, "coin", startedAt, startedAt + 300, -600);
    expect(sqlite.prepare("SELECT event_id FROM depeg_resolver_training_corpus WHERE event_id = 1").get()).toBeUndefined();
    sqlite.prepare("UPDATE depeg_events SET ended_at = ? WHERE id = 1").run(startedAt + 72 * 3600);
    const assertEquivalent = async () => {
      expect(JSON.stringify(await readDdrTrainingHistory(db, ["below"], windowStart)))
        .toBe(JSON.stringify(await legacyHistory(db)));
    };
    await assertEquivalent();
    sqlite.exec("INSERT OR IGNORE INTO depeg_resolver_assessments SELECT id + 100, event_id, stablecoin_id, symbol, name, peg_currency, governance, direction, started_at, assessed_at, event_age_sec, 'age_1h', methodology_version, methodology_version_label, resolution_rubric_version, duration_model_version, incident_grouping_version, support_rules_version, resolution_tier, duration_suppressed, duration_suppressed_reason, median_remaining_sec, iqr_low_remaining_sec, iqr_high_remaining_sec, stratum, horizons_json, factors_json, row_json, created_at, updated_at FROM depeg_resolver_assessments WHERE checkpoint = 'latest'");
    await assertEquivalent();
    sqlite.exec("INSERT OR IGNORE INTO depeg_resolver_assessments SELECT * FROM depeg_resolver_assessments");
    await assertEquivalent();
    sqlite.exec("INSERT OR REPLACE INTO depeg_resolver_assessments SELECT * FROM depeg_resolver_assessments WHERE checkpoint = 'latest'");
    await assertEquivalent();
    sqlite.exec("UPDATE depeg_resolver_assessments SET row_json = '{\"currentDeviationBps\":-800}', assessed_at = assessed_at + 1 WHERE checkpoint = 'latest'");
    await assertEquivalent();
    sqlite.exec("UPDATE depeg_resolver_assessments SET event_id = 2, stablecoin_id = 'other' WHERE checkpoint = 'latest'");
    await assertEquivalent();
    sqlite.exec("DELETE FROM depeg_resolver_assessments WHERE event_id = 2");
    await assertEquivalent();
    sqlite.exec("BEGIN; UPDATE depeg_events SET started_at = started_at + 1 WHERE id = 1; ROLLBACK;");
    await assertEquivalent();
    sqlite.exec("UPDATE depeg_events SET started_at = started_at + 1 WHERE id = 1");
    await assertEquivalent();
    sqlite.exec("DELETE FROM depeg_events WHERE id = 1");
    expect(sqlite.prepare("SELECT event_id FROM depeg_resolver_training_corpus WHERE event_id = 1").get()).toBeUndefined();
    await assertEquivalent();
  });

  it("never serves a partial corpus and repairs at most one bounded page per load", async () => {
    const { sqlite, db } = fixtures.open();
    for (let id = 1; id <= TRAINING_ROLLUP_BACKFILL_EVENT_CAP + 1; id++) {
      seedHistoricalEvent(sqlite, { id, coin: `coin-${id}`, startedAt, timed: false });
    }
    sqlite.exec("DELETE FROM depeg_resolver_training_corpus");
    const prepare = vi.spyOn(db, "prepare");
    const expected = JSON.stringify(await legacyHistory(db));
    prepare.mockClear();
    expect(JSON.stringify(await readDdrTrainingHistory(db, ["below"], windowStart))).toBe(expected);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("ddr-training-history-live"))).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM depeg_resolver_training_corpus").get()?.n)
      .toBe(TRAINING_ROLLUP_BACKFILL_EVENT_CAP);
    expect(JSON.stringify(await readDdrTrainingHistory(db, ["below"], windowStart))).toBe(expected);
    prepare.mockClear();
    expect(JSON.stringify(await readDdrTrainingHistory(db, ["below"], windowStart))).toBe(expected);
    expect(prepare.mock.calls).toHaveLength(1);
  });

  it("falls back for inconsistent identities or an unreadable rollup without masking live-query failure", async () => {
    const { sqlite, db } = fixtures.open();
    seedHistoricalEvent(sqlite, { id: 1, coin: "coin", startedAt, latePeak: true });
    const expected = JSON.stringify(await legacyHistory(db));
    sqlite.exec("UPDATE depeg_resolver_training_corpus SET started_at = started_at - 1");
    const original = db.prepare.bind(db);
    const prepare = vi.spyOn(db, "prepare");
    expect(JSON.stringify(await readDdrTrainingHistory(db, ["below"], windowStart))).toBe(expected);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("ddr-training-history-live"))).toBe(true);
    sqlite.exec("DELETE FROM depeg_resolver_training_corpus");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    prepare.mockImplementation((sql) => {
      if (sql.includes("ddr-training-backfill")) throw new Error("backfill unavailable");
      return original(sql);
    });
    expect(JSON.stringify(await readDdrTrainingHistory(db, ["below"], windowStart))).toBe(expected);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM depeg_resolver_training_corpus").get()?.n).toBe(0);
    prepare.mockImplementation((sql) => {
      if (sql.includes("/* pharos:ddr-training-history */")) throw new Error("rollup unreadable");
      return original(sql);
    });
    expect(JSON.stringify(await readDdrTrainingHistory(db, ["below"], windowStart))).toBe(expected);
    prepare.mockImplementation(() => { throw new Error("database unavailable"); });
    await expect(readDdrTrainingHistory(db, ["below"], windowStart)).rejects.toThrow("database unavailable");
  });

  it("preserves incident grouping and duration verdicts across rollup and live fallback", async () => {
    const { sqlite, db } = fixtures.open();
    for (let id = 1; id <= 12; id++) seedHistoricalEvent(sqlite, { id, coin: `coin-${id}`, startedAt, latePeak: true });
    const rolled = await loadDdrHistoricalEvents(db, ["below"], windowStart);
    sqlite.exec("DELETE FROM depeg_resolver_training_corpus");
    const live = await loadDdrHistoricalEvents(db, ["below"], windowStart);
    expect(JSON.stringify(rolled)).toBe(JSON.stringify(live));
    const key: DdrStratumKey = { direction: "below", depth: "catastrophic", structural: "fragile", currency: "USD" };
    for (const age of [3600, 49 * 3600]) {
      expect(computeDuration(key, age, groupIncidents(rolled.historical, () => "USD"), new Set()))
        .toEqual(computeDuration(key, age, groupIncidents(live.historical, () => "USD"), new Set()));
    }
  });

  it("preserves the 60000 cap and id tie-break without reading assessments on the complete path", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id <= ${HISTORICAL_ROW_CAP})
      INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
        started_at, ended_at, start_price, recovery_price, peg_reference, source)
      SELECT id, 'coin-' || id, 'FIX', 'peggedUSD', 'below', -500,
        ${startedAt}, ${startedAt + 3600}, 0.95, 1, 1, 'backfill' FROM n;
    `);
    const prepare = vi.spyOn(db, "prepare");
    const rows = await readDdrTrainingHistory(db, ["below"], windowStart);
    expect(prepare.mock.calls).toHaveLength(1);
    const sql = prepare.mock.calls[0][0];
    expect(sql).not.toContain("depeg_resolver_assessments");
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(windowStart, ...auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS).binds, "below");
    expect(JSON.stringify(plan)).toContain("idx_depeg_pending_outcomes_training_identity");
    expect(JSON.stringify(plan)).toContain("COVERING INDEX idx_depeg_training_history");
    expect(JSON.stringify(rows)).toBe(JSON.stringify(await legacyHistory(db)));
    expect(rows).toHaveLength(HISTORICAL_ROW_CAP);
    expect(rows[0].id).toBe(1);
    expect(rows[rows.length - 1].id).toBe(HISTORICAL_ROW_CAP);
    expect((await loadDdrHistoricalEvents(db, ["below"], windowStart)).trainingRowsTruncated).toBe(true);
  });
});
