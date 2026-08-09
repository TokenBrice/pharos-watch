import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../../test-helpers/sqlite-d1";
import { writeDewsPublishedGeneration } from "../../dews-publication-pointer";
import { projectDewsEscalated, projectDewsDeescalated, projectDewsBandTransitions } from "../dews";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";

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

function openDewsProjectorSqlite(): {
  sqlite: DatabaseSync;
  db: D1Database;
} {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

function seedStressSignal(
  sqlite: DatabaseSync,
  computedAt: number,
  score: number,
  band: string,
): void {
  sqlite.prepare(
    `INSERT INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json)
     VALUES ('usdt-tether', ?, ?, ?, '[]')`,
  ).run(computedAt, score, band);
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

  it("skips a failed partial generation and later projects T2 from the last published band", async () => {
    const { sqlite, db } = openDewsProjectorSqlite();
    const publishedP = SEC;
    const failedT = SEC + 900;
    const publishedT2 = SEC + 1_800;
    try {
      seedStressSignal(sqlite, publishedP, 10, "CALM");
      seedStressSignal(sqlite, failedT, 90, "DANGER");
      await writeDewsPublishedGeneration(db, publishedP, ["usdt-tether"]);
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "tape-projector:cursor:dews.escalated",
        String(publishedP),
        publishedP,
      );
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "tape-projector:cursor:dews.deescalated",
        String(publishedP),
        publishedP,
      );

      const afterFailedT = await projectDewsBandTransitions(db);

      expect(afterFailedT).toEqual({ projected: 0, advanced: null });
      expect(sqlite.prepare("SELECT COUNT(*) AS cnt FROM tape_events").get()).toEqual({ cnt: 0 });
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(
        "tape-projector:cursor:dews.escalated",
      )).toEqual({ value: String(publishedP) });

      seedStressSignal(sqlite, publishedT2, 50, "ALERT");
      await writeDewsPublishedGeneration(db, publishedT2, ["usdt-tether"]);
      const afterPublishedT2 = await projectDewsBandTransitions(db);

      expect(afterPublishedT2).toEqual({ projected: 1, advanced: publishedT2 });
      const events = sqlite.prepare(
        "SELECT type, source_row_id, payload_json FROM tape_events ORDER BY id",
      ).all() as Array<{ type: string; source_row_id: string; payload_json: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "dews.escalated",
        source_row_id: `usdt-tether:${publishedT2}:ALERT`,
      });
      expect(JSON.parse(events[0]!.payload_json)).toMatchObject({
        prevBand: "CALM",
        newBand: "ALERT",
      });
      expect(events[0]!.source_row_id).not.toContain(String(failedT));
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(
        "tape-projector:cursor:dews.escalated",
      )).toEqual({ value: String(publishedT2) });
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(
        "tape-projector:cursor:dews.deescalated",
      )).toEqual({ value: String(publishedT2) });
    } finally {
      sqlite.close();
    }
  });

  it("recovers T2 even when a legacy projector already advanced its watermark through failed T", async () => {
    const { sqlite, db } = openDewsProjectorSqlite();
    const publishedP = SEC;
    const failedT = SEC + 900;
    const publishedT2 = SEC + 1_800;
    try {
      seedStressSignal(sqlite, publishedP, 10, "CALM");
      seedStressSignal(sqlite, failedT, 90, "DANGER");
      seedStressSignal(sqlite, publishedT2, 50, "ALERT");
      await writeDewsPublishedGeneration(db, publishedP, ["usdt-tether"]);
      await writeDewsPublishedGeneration(db, publishedT2, ["usdt-tether"]);
      for (const variant of ["escalated", "deescalated"]) {
        sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
          `tape-projector:cursor:dews.${variant}`,
          String(failedT),
          failedT,
        );
      }

      const result = await projectDewsBandTransitions(db);

      expect(result).toEqual({ projected: 1, advanced: publishedT2 });
      const event = sqlite.prepare(
        "SELECT source_row_id, payload_json FROM tape_events",
      ).get() as { source_row_id: string; payload_json: string };
      expect(event.source_row_id).toBe(`usdt-tether:${publishedT2}:ALERT`);
      expect(JSON.parse(event.payload_json)).toMatchObject({ prevBand: "CALM", newBand: "ALERT" });
    } finally {
      sqlite.close();
    }
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

  it("keeps dry-run projection read-only instead of reconciling the pointer ledger", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [{
          key: "dews:published-generation",
          value: JSON.stringify({
            updatedAt: SEC,
            source: "compute-dews",
            publishStatus: "published",
          }),
          updated_at: SEC,
        }],
      },
      { match: MATCH_FETCH_SAMPLES, rows: [] },
    ]) as MockD1Database;

    await projectDewsBandTransitions(db, { dryRun: true });

    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO surface_publication_generations"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
  });
});
