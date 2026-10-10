import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeDuration, groupIncidents, type DdrStratumKey } from "@shared/lib/depeg-resolver";
import { DDR_INELIGIBLE_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { loadDdrContext, loadDdrHistoricalEvents } from "../context";
import { HISTORICAL_ROW_CAP, TRAINING_WINDOW_SEC } from "../constants";
import { activeRow, NOW_SEC } from "./depeg-resolver.test-support";
import { seedAssessmentSample, seedHistoricalEvent, seedResolverInputs } from "./context.test-support";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
const startedAt = NOW_SEC - 10 * 86400;
const key: DdrStratumKey = { direction: "below", depth: "catastrophic", structural: "fragile", currency: "USD" };

describe("DDR historical context", () => {
  it("loads timed onset and later severity without leaking final peaks into earlier landmarks", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    for (let index = 0; index < 12; index++) {
      seedHistoricalEvent(sqlite, { id: index + 1, coin: `timed-${index}`, startedAt, latePeak: true });
    }
    const loaded = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") throw new Error(loaded.reason);
    const { incidents, quarantined, lineage } = loaded.context;
    expect(lineage.eventCount).toBe(12);
    expect(incidents[0].fragments).toEqual(expect.arrayContaining([
      { offsetSec: 0, peakDeviationBps: -500 },
      { offsetSec: 300, peakDeviationBps: -600 },
      { offsetSec: 48 * 3600, peakDeviationBps: -9000 },
    ]));
    expect(incidents[0].fragments).not.toContainEqual({ offsetSec: 0, peakDeviationBps: -9000 });
    expect(incidents[0].fragments?.some((point) => point.peakDeviationBps === -9900)).toBe(false);
    const early = computeDuration(key, 3600, incidents, quarantined);
    const later = computeDuration(key, 49 * 3600, incidents, quarantined);
    expect(early.stratum).toContain("moderate+severe+catastrophic");
    expect(later.stratum).toBe("below · catastrophic · fragile · USD");
    expect(later.suppressed).toBe(false);
  });

  it("removes every excluded audit verdict from context lineage and duration support", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    for (let index = 0; index < 12; index++) {
      seedHistoricalEvent(sqlite, { id: index + 1, coin: `eligible-${index}`, startedAt,
        verdict: index % 3 === 0 ? "confirmed" : index % 3 === 1 ? "repaired" : null });
    }
    const baseline = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(baseline.kind).toBe("ok");
    if (baseline.kind !== "ok") throw new Error(baseline.reason);
    for (const [index, verdict] of [...DDR_INELIGIBLE_AUDIT_VERDICTS, "unknown-verdict"].entries()) {
      seedHistoricalEvent(sqlite, { id: 100 + index, coin: `excluded-${verdict}`, startedAt, verdict });
    }
    expect(() => sqlite.prepare(
      "INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (12, 'live', 'unknown-verdict', ?, ?)",
    ).run(NOW_SEC, NOW_SEC)).toThrow("unknown depeg audit verdict");
    const filtered = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(filtered.kind).toBe("ok");
    if (filtered.kind !== "ok") throw new Error(filtered.reason);
    expect(filtered.context.lineage).toEqual(baseline.context.lineage);
    expect(filtered.context.incidents).toEqual(baseline.context.incidents);
    expect(computeDuration({ ...key, depth: "moderate" }, 3600, filtered.context.incidents, filtered.context.quarantined))
      .toEqual(computeDuration({ ...key, depth: "moderate" }, 3600, baseline.context.incidents, baseline.context.quarantined));
  });

  it("filters audited-out episodes before the historical row cap", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < ${HISTORICAL_ROW_CAP})
      INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, recovery_price, peg_reference, source)
      SELECT id, 'excluded-' || id, 'FIX', 'peggedUSD', 'below', -500, ${startedAt - 86400}, ${startedAt}, 0.95, 1, 1, 'live' FROM n;
      INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at)
      SELECT id, 'live', 'false_positive', ${NOW_SEC}, ${NOW_SEC} FROM depeg_events;
    `);
    seedHistoricalEvent(sqlite, { id: HISTORICAL_ROW_CAP + 1, coin: "late-eligible", startedAt, verdict: "confirmed" });
    const loaded = await loadDdrHistoricalEvents(db, ["below"], NOW_SEC - TRAINING_WINDOW_SEC);
    expect(loaded.historical.map((event) => event.stablecoinId)).toEqual(["late-eligible"]);
    expect(loaded.trainingRowsTruncated).toBe(false);
  });

  it("leaves legacy, ambiguous promotion, and aggregate-only assessment evidence unsupported", async () => {
    const { sqlite, db } = fixtures.open();
    seedHistoricalEvent(sqlite, { id: 1, coin: "legacy", startedAt, timed: false });
    seedAssessmentSample(sqlite, 1, "legacy", startedAt, startedAt + 300, -9000);
    sqlite.prepare("UPDATE depeg_resolver_assessments SET row_json = ? WHERE event_id = 1")
      .run(JSON.stringify({ peakDeviationBps: -9000 }));
    seedHistoricalEvent(sqlite, { id: 2, coin: "ambiguous", startedAt });
    sqlite.exec("INSERT INTO depeg_pending_outcomes (stablecoin_id, symbol, peg_type, direction, reason, first_seen_bps, first_seen_at, first_price, peg_reference, outcome, outcome_at, final_decision_reason, created_at) " +
      `SELECT stablecoin_id, symbol, peg_type, direction, reason, first_seen_bps, first_seen_at, first_price, peg_reference, outcome, outcome_at, final_decision_reason, created_at FROM depeg_pending_outcomes WHERE stablecoin_id = 'ambiguous'`);
    const loaded = await loadDdrHistoricalEvents(db, ["below"], NOW_SEC - TRAINING_WINDOW_SEC);
    const incidents = groupIncidents(loaded.historical, () => "USD");
    expect(incidents.every((incident) => incident.fragments?.length === 0)).toBe(true);
    expect(computeDuration(key, 3600, incidents, new Set()).horizons.every((cell) => cell.rawAtRisk === 0)).toBe(true);
  });
});
