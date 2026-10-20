import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { advanceDepegPriceCoverage } from "@shared/lib/depeg-price-coverage";
import { mergeDepegSeconds, mergeUnknownDepegSeconds } from "@shared/lib/peg-utils";
import { rowToDepegEvent, type DepegRow } from "../../../lib/depeg-helpers";
import { makeDepegRow } from "../../../test-helpers/__shared/fixtures";
import { buildDuplicateOpenEventRepair, buildOrphanCloseRepair } from "../repair";
import { persistDepegCommands } from "../persistence";
import { seedOpenEvent } from "../../__tests__/detect-depegs.test-support";

const sqliteFixtures = createLatestSchemaFixtureTracker();
afterEach(() => sqliteFixtures.closeAll());

async function repairPersistedRows(rows: DepegRow[]) {
  const { sqlite, db } = sqliteFixtures.open();
  const insert = sqlite.prepare(`INSERT INTO depeg_events (
    id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
    started_at, start_price, peak_price, peg_reference, source,
    price_coverage_json, last_trusted_price_at, price_coverage_gap_started_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(
      row.id, row.stablecoin_id, row.symbol, row.peg_type, row.direction,
      row.peak_deviation_bps, row.started_at, row.start_price, row.peak_price,
      row.peg_reference, row.source, row.price_coverage_json ?? null,
      row.last_trusted_price_at ?? null, row.price_coverage_gap_started_at ?? null,
    );
  }
  await persistDepegCommands(db, buildDuplicateOpenEventRepair(rows).commands);
  return (sqlite.prepare("SELECT * FROM depeg_events ORDER BY id").all() as unknown as DepegRow[]).map(rowToDepegEvent);
}

function makeOpenRow(overrides: Parameters<typeof makeDepegRow>[0] = {}): DepegRow {
  return {
    ...makeDepegRow(overrides),
    confirmation_sources: null,
    pending_reason: null,
  };
}

describe("buildDuplicateOpenEventRepair", () => {
  it.each(["first", "current", "link"] as const)("retains a duplicate referenced by an unsealed incident's %s reference", async (reference) => {
    const { sqlite, db } = sqliteFixtures.open();
    seedOpenEvent(sqlite, { id: 1, started_at: 100, peak_deviation_bps: -200 });
    seedOpenEvent(sqlite, { id: 2, started_at: 200, peak_deviation_bps: -300 });
    seedOpenEvent(sqlite, { id: 3, started_at: 300, peak_deviation_bps: -250 });
    const key = "ddr2:00000000000000000000000000000001";
    const first = reference === "first" ? 2 : 1;
    const current = reference === "current" ? 2 : 1;
    for (const id of new Set([current, ...(reference === "link" ? [2] : [])])) {
      sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links
        (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', 300)`).run(key, id);
    }
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, 'usdt-tether', 'USD', 'below', ?, ?, ?, ?, 200, ?, 300, 300)`)
      .run(key, first, current, first === 2 ? 200 : 100, current === 2 ? 200 : 100, "a".repeat(64));
    const rows = sqlite.prepare("SELECT * FROM depeg_events ORDER BY id").all() as unknown as DepegRow[];
    await persistDepegCommands(db, buildDuplicateOpenEventRepair(rows).commands);
    expect(sqlite.prepare("SELECT id FROM depeg_events ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(sqlite.prepare("SELECT peak_deviation_bps FROM depeg_events WHERE id = 1").get())
      .toEqual({ peak_deviation_bps: -300 });
    expect(sqlite.prepare(`SELECT first_event_id, current_event_id FROM depeg_resolver_incidents
      WHERE incident_key = ?`).get(key)).toEqual({ first_event_id: first, current_event_id: current });
    expect(sqlite.prepare(`SELECT COUNT(*) AS dangling FROM depeg_resolver_incident_event_links l
      LEFT JOIN depeg_events e ON e.id = l.event_id WHERE e.id IS NULL`).get()).toEqual({ dangling: 0 });
  });

  it("unions duplicate trusted intervals without bridging gaps and preserves the earliest unresolved gap", async () => {
    const repaired = await repairPersistedRows([
      { ...makeOpenRow({ id: 3, started_at: 180 }), price_coverage_json: '{"intervals":[[650,650]]}', last_trusted_price_at: 650, price_coverage_gap_started_at: null },
      { ...makeOpenRow({ id: 1, started_at: 100 }), price_coverage_json: '{"intervals":[[100,200],[300,400]]}', last_trusted_price_at: 400, price_coverage_gap_started_at: 450 },
      { ...makeOpenRow({ id: 4, started_at: 200 }), price_coverage_json: '{"intervals":[]}', last_trusted_price_at: null, price_coverage_gap_started_at: 430 },
      { ...makeOpenRow({ id: 2, started_at: 150 }), price_coverage_json: '{"intervals":[[150,250],[500,600]]}', last_trusted_price_at: 600, price_coverage_gap_started_at: 480 },
    ]);
    expect(repaired.map((event) => event.id)).toEqual([1]);
    expect(mergeDepegSeconds(repaired, 0, 900)).toBe(350);
    expect(mergeUnknownDepegSeconds(repaired, 0, 900)).toBe(450);
    expect(repaired[0]!.priceCoverage).toMatchObject({
      lastTrustedObservationAt: 650,
      gapStartedAt: 430,
    });
    const resumed = { ...repaired[0]!, priceCoverage: advanceDepegPriceCoverage(repaired[0]!.priceCoverage, 900, "trusted-off-peg") };
    expect(mergeDepegSeconds([resumed], 0, 900)).toBe(350);
    expect(mergeUnknownDepegSeconds([resumed], 0, 900)).toBe(450);
  });

  it("retains known at-par intervals and their continuity across duplicate repair", async () => {
    const repaired = await repairPersistedRows([
      {
        ...makeOpenRow({ id: 1, started_at: 100 }),
        price_coverage_json: JSON.stringify({ intervals: [[100, 200]], atParIntervals: [[300, 400]], lastObservationKind: "trusted-at-par" }),
        last_trusted_price_at: 400, price_coverage_gap_started_at: 300,
      },
      {
        ...makeOpenRow({ id: 2, started_at: 150 }),
        price_coverage_json: JSON.stringify({ intervals: [[150, 250]], atParIntervals: [[350, 500]], lastObservationKind: "trusted-at-par" }),
        last_trusted_price_at: 500, price_coverage_gap_started_at: 350,
      },
    ]);
    expect(mergeDepegSeconds(repaired, 0, 600)).toBe(150);
    expect(mergeUnknownDepegSeconds(repaired, 0, 600)).toBe(150);
    const resumed = { ...repaired[0]!, priceCoverage: advanceDepegPriceCoverage(repaired[0]!.priceCoverage, 600, "trusted-at-par") };
    expect(mergeDepegSeconds([resumed], 0, 600)).toBe(150);
    expect(mergeUnknownDepegSeconds([resumed], 0, 600)).toBe(50);
  });

  it.each([false, true])("keeps legacy duplicate spans unknown when later duplicate instrumentation is %s", async (instrumented) => {
    const later = makeOpenRow({ id: 2, started_at: 200 });
    if (instrumented) {
      later.price_coverage_json = '{"intervals":[[200,300]]}';
      later.last_trusted_price_at = 300;
    }
    const repaired = await repairPersistedRows([later, makeOpenRow({ id: 1, started_at: 50 })]);
    expect(repaired.map((event) => event.id)).toEqual([1]);
    expect(repaired[0]!.startedAt).toBe(50);
    expect(repaired[0]!.endedAt).toBeNull();
    expect(mergeDepegSeconds(repaired, 0, 500)).toBe(instrumented ? 100 : 0);
    expect(mergeUnknownDepegSeconds(repaired, 0, 500)).toBe(instrumented ? 350 : 450);
  });

  it("closes stale opposite-direction rows instead of absorbing their peak", () => {
    const result = buildDuplicateOpenEventRepair([
      makeOpenRow({ id: 1, direction: "below", peak_deviation_bps: -150, peak_price: 0.985, started_at: 100 }),
      makeOpenRow({ id: 2, direction: "below", peak_deviation_bps: -300, peak_price: 0.97, started_at: 200 }),
      makeOpenRow({ id: 3, direction: "above", peak_deviation_bps: 400, peak_price: 1.04, started_at: 300 }),
    ]);

    expect(result.openEvents.get("usdt-tether")).toMatchObject({
      id: 3,
      direction: "above",
      peak_deviation_bps: 400,
      peak_price: 1.04,
    });
    expect(result.commands).toEqual([
      { type: "delete-event", id: 2 },
      { type: "update-peak", id: 1, peakDeviationBps: -300, peakPrice: 0.97 },
      {
        type: "close-event",
        id: 1,
        endedAt: 300,
        recoveryPrice: null,
        closeReason: "superseded-direction",
      },
    ]);
  });
});

describe("buildOrphanCloseRepair", () => {
  it("closes untracked orphan events and reports the repair", () => {
    const result = buildOrphanCloseRepair({
      rows: [
        { id: 10, stablecoin_id: "retired-coin", started_at: 100 },
        { id: 11, stablecoin_id: "usdt-tether", started_at: 100 },
        { id: 12, stablecoin_id: "new-coin", started_at: 500 },
      ],
      seenEventIds: new Set(),
      syncStart: 500,
      trackedCoinIds: new Set(["usdt-tether"]),
      now: 1_000,
    });

    expect(result.commands).toEqual([
      {
        type: "close-event",
        id: 10,
        endedAt: 1_000,
        recoveryPrice: null,
        closeReason: "orphan-tracking-removed",
      },
    ]);
    expect(result.diagnostics).toEqual([
      { level: "log", message: "[depeg] Closing orphan event for retired-coin (id=10)" },
    ]);
  });
});
