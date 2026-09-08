import { afterEach, describe, it, expect } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);
import { type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { projectPsiBandShifts } from "../psi";
import { mockTapeD1, tapeInsertBinds, tapeInsertBindsForType } from "./test-support";

const SEC = 1_700_000_000;

const MATCH_FETCH_SAMPLES = "WHERE stored_at > ?";
const MATCH_PRIOR_BAND = "WHERE stored_at <= ?";

function tables(samples: Record<string, unknown>[], priors: Record<string, unknown>[] = []): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    // Prior-band lookup must match BEFORE the samples query (substring tie).
    { match: MATCH_PRIOR_BAND, rows: priors, first: priors[0] ?? null },
    { match: MATCH_FETCH_SAMPLES, rows: samples },
  ];
}

describe("psi projector", () => {
  it("emits psi.shifted_down with severity scaled to the new band", async () => {
    const db = mockTapeD1(
      tables([
        { stored_at: SEC,       score: 96, band: "BEDROCK",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = tapeInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    // bind order: eventId, type, severity, ts, ...
    expect(inserts[0]![2]).toBe("warning"); // FRACTURE → warning
    expect(inserts[0]![1]).toBe("psi.shifted_down");
  });

  it("scales severity to critical for MELTDOWN transitions", async () => {
    const db = mockTapeD1(
      tables([
        { stored_at: SEC,       score: 96, band: "BEDROCK",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 5,  band: "MELTDOWN", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = tapeInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("critical");
  });

  it("emits psi.shifted_up at info regardless of magnitude", async () => {
    const db = mockTapeD1(
      tables([
        { stored_at: SEC,       score: 50, band: "CRISIS",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 96, band: "BEDROCK", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const ups = tapeInsertBindsForType(db, "psi.shifted_up");
    const downs = tapeInsertBindsForType(db, "psi.shifted_down");
    expect(ups).toHaveLength(1);
    expect(downs).toHaveLength(0);
    expect(ups[0]![2]).toBe("info");
  });

  it("emits nothing when consecutive samples share a band", async () => {
    const db = mockTapeD1(
      tables([
        { stored_at: SEC,       score: 96, band: "BEDROCK", methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 95, band: "BEDROCK", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    expect(tapeInsertBinds(db)).toHaveLength(0);
  });

  it("uses prior-batch band when only one sample appears in the new batch", async () => {
    const db = mockTapeD1([
      { match: "FROM cache WHERE key", rows: [{ key: "tape-projector:cursor:psi.band_changed", value: String(SEC - 1) }] },
      { match: MATCH_PRIOR_BAND, rows: [], first: { stored_at: SEC - 900, score: 96, band: "BEDROCK", methodology_version: "3.3" } },
      { match: MATCH_FETCH_SAMPLES, rows: [{ stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" }] },
    ]) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = tapeInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("warning"); // BEDROCK → FRACTURE
  });

  it("persists one shift across cursor reruns and forced source replay", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, methodology_version, components, input_snapshot) VALUES (?, ?, ?, '3.3', '{}', '{}')");
    insert.run(SEC, 96, "BEDROCK");
    insert.run(SEC + 900, 70, "FRACTURE");
    await projectPsiBandShifts(db);
    const select = sqlite.prepare("SELECT event_id, source_row_id, type, severity FROM tape_events");
    const events = select.all();
    expect(events).toEqual([{
      event_id: expect.any(String), source_row_id: `${SEC + 900}:FRACTURE`, type: "psi.shifted_down", severity: "warning",
    }]);
    const cursor = sqlite.prepare("SELECT value FROM cache WHERE key = 'tape-projector:cursor:psi.band_changed'");
    expect(cursor.get()).toEqual({ value: String(SEC + 900) });
    await projectPsiBandShifts(db);
    await projectPsiBandShifts(db, { since: 0 });
    expect(select.all()).toEqual(events);
    expect(cursor.get()).toEqual({ value: String(SEC + 900) });
  });

  it("derives the same nonempty shift identity independently of persistence", async () => {
    const samples = [
      { stored_at: SEC, score: 96, band: "BEDROCK", methodology_version: "3.3" },
      { stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" },
    ];
    const first = mockTapeD1(tables(samples)) as MockD1Database;
    const second = mockTapeD1(tables(samples)) as MockD1Database;
    await projectPsiBandShifts(first);
    await projectPsiBandShifts(second);
    const firstIds = tapeInsertBindsForType(first, "psi.shifted_down").map((binds) => binds[0]);
    expect(firstIds).toEqual([expect.stringMatching(/\S+/)]);
    expect(tapeInsertBindsForType(second, "psi.shifted_down").map((binds) => binds[0])).toEqual(firstIds);
  });
});
