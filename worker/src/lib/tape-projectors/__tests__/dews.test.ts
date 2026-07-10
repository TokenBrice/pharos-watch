import { describe, it, expect } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../../test-helpers/__shared/mock-d1";
import { projectDewsEscalated, projectDewsDeescalated, projectDewsBandTransitions } from "../dews";

const SEC = 1_700_000_000;

const MATCH_FETCH_SAMPLES = "WHERE computed_at > ?";
const MATCH_PRIOR_BAND = "pharos:tape:dews-prior-band-seek";

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

function extractInsertBindsForType(db: MockD1Database, type: string): unknown[][] {
  return extractInsertBinds(db).filter((binds) => binds[1] === type);
}

function baseTables(samples: Record<string, unknown>[], priors: Record<string, unknown>[] = []): MockTableConfig[] {
  return [
    { match: "FROM cache WHERE key", rows: [] },
    { match: MATCH_FETCH_SAMPLES, rows: samples },
    { match: MATCH_PRIOR_BAND, rows: priors },
  ];
}

describe("dews projector", () => {
  it("emits dews.escalated with severity scaled to the new band", async () => {
    // Two consecutive samples for one coin: CALM → ALERT.
    const db = mockD1(
      baseTables([
        {
          stablecoin_id: "usdt-tether",
          computed_at: SEC,
          score: 10,
          band: "CALM",
        },
        {
          stablecoin_id: "usdt-tether",
          computed_at: SEC + 900,
          score: 50,
          band: "ALERT",
        },
      ]),
    ) as MockD1Database;

    await projectDewsEscalated(db);
    const inserts = extractInsertBindsForType(db, "dews.escalated");
    expect(inserts).toHaveLength(1);
    // bind order: eventId, type, severity, ts, ...
    expect(inserts[0]![2]).toBe("warning"); // ALERT → warning
    expect(inserts[0]![1]).toBe("dews.escalated");
  });

  it("uses the prior-batch band when only one sample appears in the new batch", async () => {
    // One sample in the new batch; the prior band is seeded from before the
    // watermark via the per-coin "prior band" lookup. Seed the watermark cache
    // so `since > 0`, which is required for prior-band lookup.
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [{ key: "tape-projector:cursor:dews.escalated", value: String(SEC - 1) }],
      },
      {
        match: MATCH_FETCH_SAMPLES,
        rows: [
          {
            stablecoin_id: "usdt-tether",
            computed_at: SEC + 900,
            score: 80,
            band: "DANGER",
          },
        ],
      },
      {
        match: MATCH_PRIOR_BAND,
        rows: [
          {
            stablecoin_id: "usdt-tether",
            computed_at: SEC,
            score: 30,
            band: "WATCH",
          },
        ],
      },
    ]) as MockD1Database;

    await projectDewsEscalated(db);
    const inserts = extractInsertBindsForType(db, "dews.escalated");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("critical"); // DANGER → critical
    const priorQuery = db.getHistory().find((entry) => entry.sql.includes(MATCH_PRIOR_BAND));
    expect(priorQuery?.sql).toContain("ORDER BY candidate.computed_at DESC");
    expect(priorQuery?.sql).toContain("LIMIT 1");
    expect(priorQuery?.sql).not.toContain("GROUP BY");
  });

  it("emits dews.deescalated with severity=info", async () => {
    const db = mockD1(
      baseTables([
        {
          stablecoin_id: "dai-makerdao",
          computed_at: SEC,
          score: 80,
          band: "DANGER",
        },
        {
          stablecoin_id: "dai-makerdao",
          computed_at: SEC + 900,
          score: 20,
          band: "WATCH",
        },
      ]),
    ) as MockD1Database;

    await projectDewsDeescalated(db);
    const inserts = extractInsertBindsForType(db, "dews.deescalated");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toBe("info");
  });

  it("emits nothing when consecutive samples share a band", async () => {
    const db = mockD1(
      baseTables([
        {
          stablecoin_id: "usdt-tether",
          computed_at: SEC,
          score: 10,
          band: "CALM",
        },
        {
          stablecoin_id: "usdt-tether",
          computed_at: SEC + 900,
          score: 12,
          band: "CALM",
        },
      ]),
    ) as MockD1Database;

    await projectDewsEscalated(db);
    await projectDewsDeescalated(db);
    expect(extractInsertBindsForType(db, "dews.escalated")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "dews.deescalated")).toHaveLength(0);
  });

  it("produces a stable eventId across re-runs (idempotency)", async () => {
    function buildDb(): MockD1Database {
      return mockD1(
        baseTables([
          {
            stablecoin_id: "usdt-tether",
            computed_at: SEC,
            score: 10,
            band: "CALM",
          },
          {
            stablecoin_id: "usdt-tether",
            computed_at: SEC + 900,
            score: 50,
            band: "ALERT",
          },
        ]),
      ) as MockD1Database;
    }

    const dbA = buildDb();
    const dbB = buildDb();
    await projectDewsEscalated(dbA);
    await projectDewsEscalated(dbB);
    const a = extractInsertBindsForType(dbA, "dews.escalated");
    const b = extractInsertBindsForType(dbB, "dews.escalated");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // eventId stable → unique-index absorbs duplicates on re-insert.
    expect(a[0]![0]).toBe(b[0]![0]);
  });

  it("emits no events when there are no new samples", async () => {
    const db = mockD1(baseTables([])) as MockD1Database;
    const escalated = await projectDewsEscalated(db);
    const deescalated = await projectDewsDeescalated(db);
    expect(escalated.projected).toBe(0);
    expect(deescalated.projected).toBe(0);
    expect(extractInsertBindsForType(db, "dews.escalated")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "dews.deescalated")).toHaveLength(0);
  });

  it("classifies escalations and deescalations independently", async () => {
    // Same batch has one escalation (coin A) and one deescalation (coin B).
    const db = mockD1(
      baseTables([
        { stablecoin_id: "a-issuer", computed_at: SEC,        score: 10, band: "CALM"    },
        { stablecoin_id: "a-issuer", computed_at: SEC + 900,  score: 60, band: "WARNING" },
        { stablecoin_id: "b-issuer", computed_at: SEC,        score: 90, band: "DANGER"  },
        { stablecoin_id: "b-issuer", computed_at: SEC + 900,  score: 20, band: "WATCH"   },
      ]),
    ) as MockD1Database;

    await projectDewsEscalated(db);
    await projectDewsDeescalated(db);

    const escalated = extractInsertBindsForType(db, "dews.escalated");
    const deescalated = extractInsertBindsForType(db, "dews.deescalated");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]![2]).toBe("severe"); // WARNING → severe
    expect(deescalated).toHaveLength(1);
    expect(deescalated[0]![2]).toBe("info");
  });

  it("single-pass band-transition projector emits both directions from one scan", async () => {
    // Same batch as the independent test: one escalation (coin A), one
    // deescalation (coin B). A single fetchSamplesSince call covers both.
    const db = mockD1(
      baseTables([
        { stablecoin_id: "a-issuer", computed_at: SEC,        score: 10, band: "CALM"    },
        { stablecoin_id: "a-issuer", computed_at: SEC + 900,  score: 60, band: "WARNING" },
        { stablecoin_id: "b-issuer", computed_at: SEC,        score: 90, band: "DANGER"  },
        { stablecoin_id: "b-issuer", computed_at: SEC + 900,  score: 20, band: "WATCH"   },
      ]),
    ) as MockD1Database;

    const result = await projectDewsBandTransitions(db);

    expect(result.projected).toBe(2);
    const sampleScans = db
      .getHistory()
      .filter((entry) => entry.sql.includes(MATCH_FETCH_SAMPLES));
    expect(sampleScans).toHaveLength(1); // single scan, not one per variant
    const escalated = extractInsertBindsForType(db, "dews.escalated");
    const deescalated = extractInsertBindsForType(db, "dews.deescalated");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]![2]).toBe("severe"); // WARNING → severe
    expect(deescalated).toHaveLength(1);
    expect(deescalated[0]![2]).toBe("info");
  });

  it("single-pass projector preserves already-advanced divergent watermarks", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "tape-projector:cursor:dews.escalated", value: String(SEC + 900) },
          { key: "tape-projector:cursor:dews.deescalated", value: String(SEC) },
        ],
      },
      {
        match: MATCH_FETCH_SAMPLES,
        rows: [
          {
            stablecoin_id: "usdt-tether",
            computed_at: SEC + 100,
            score: 50,
            band: "ALERT",
          },
        ],
      },
      { match: MATCH_PRIOR_BAND, rows: [] },
    ]) as MockD1Database;

    const result = await projectDewsBandTransitions(db);

    expect(result.advanced).toBe(SEC + 100);
    const watermarkWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))
      .map((entry) => entry.binds);
    expect(watermarkWrites).toEqual([
      ["tape-projector:cursor:dews.escalated", String(SEC + 900), expect.any(Number)],
      ["tape-projector:cursor:dews.deescalated", String(SEC + 100), expect.any(Number)],
    ]);
  });

  it("single-pass projector emits nothing for an empty batch", async () => {
    const db = mockD1(baseTables([])) as MockD1Database;
    const result = await projectDewsBandTransitions(db);
    expect(result.projected).toBe(0);
    expect(extractInsertBindsForType(db, "dews.escalated")).toHaveLength(0);
    expect(extractInsertBindsForType(db, "dews.deescalated")).toHaveLength(0);
  });
});
