import { describe, it, expect } from "vitest";
import { mockD1 as createMockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { projectPsiBandShifts } from "../psi";

const SEC = 1_700_000_000;
const TAPE_WRITE_TABLES: MockTableConfig[] = [
  { match: "INSERT OR REPLACE INTO tape_events", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []): MockD1Database {
  return createMockD1([...tables, ...TAPE_WRITE_TABLES]);
}

const MATCH_FETCH_SAMPLES = "WHERE stored_at > ?";
const MATCH_PRIOR_BAND = "WHERE stored_at <= ?";

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

function extractInsertBindsForType(db: MockD1Database, type: string): unknown[][] {
  return extractInsertBinds(db).filter((binds) => binds[1] === type);
}

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
    const db = mockD1(
      tables([
        { stored_at: SEC,       score: 96, band: "BEDROCK",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = extractInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    // bind order: eventId, type, severity, ts, ...
    expect(inserts[0]![2]).toBe("warning"); // FRACTURE → warning
    expect(inserts[0]![1]).toBe("psi.shifted_down");
  });

  it("scales severity to critical for MELTDOWN transitions", async () => {
    const db = mockD1(
      tables([
        { stored_at: SEC,       score: 96, band: "BEDROCK",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 5,  band: "MELTDOWN", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = extractInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("critical");
  });

  it("emits psi.shifted_up at info regardless of magnitude", async () => {
    const db = mockD1(
      tables([
        { stored_at: SEC,       score: 50, band: "CRISIS",  methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 96, band: "BEDROCK", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const ups = extractInsertBindsForType(db, "psi.shifted_up");
    const downs = extractInsertBindsForType(db, "psi.shifted_down");
    expect(ups).toHaveLength(1);
    expect(downs).toHaveLength(0);
    expect(ups[0]![2]).toBe("info");
  });

  it("emits nothing when consecutive samples share a band", async () => {
    const db = mockD1(
      tables([
        { stored_at: SEC,       score: 96, band: "BEDROCK", methodology_version: "3.3" },
        { stored_at: SEC + 900, score: 95, band: "BEDROCK", methodology_version: "3.3" },
      ]),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    expect(extractInsertBinds(db)).toHaveLength(0);
  });

  it("uses prior-batch band when only one sample appears in the new batch", async () => {
    const db = mockD1([
      { match: "FROM cache WHERE key", rows: [{ key: "tape-projector:cursor:psi.band_changed", value: String(SEC - 1) }] },
      { match: MATCH_PRIOR_BAND, rows: [], first: { stored_at: SEC - 900, score: 96, band: "BEDROCK", methodology_version: "3.3" } },
      { match: MATCH_FETCH_SAMPLES, rows: [{ stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" }] },
    ]) as MockD1Database;

    await projectPsiBandShifts(db);
    const inserts = extractInsertBindsForType(db, "psi.shifted_down");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("warning"); // BEDROCK → FRACTURE
  });

  it("is idempotent on rerun (event_id is stable for the same source row)", async () => {
    const sample = { stored_at: SEC + 900, score: 70, band: "FRACTURE", methodology_version: "3.3" };
    const priors = [{ stored_at: SEC, score: 96, band: "BEDROCK", methodology_version: "3.3" }];
    const db = mockD1(
      tables([priors[0]!, sample], priors),
    ) as MockD1Database;

    await projectPsiBandShifts(db);
    const firstId = (extractInsertBindsForType(db, "psi.shifted_down")[0]?.[0]) as string;

    const db2 = mockD1(
      tables([priors[0]!, sample], priors),
    ) as MockD1Database;
    await projectPsiBandShifts(db2);
    const secondId = (extractInsertBindsForType(db2, "psi.shifted_down")[0]?.[0]) as string;
    expect(firstId).toEqual(secondId);
  });
});
