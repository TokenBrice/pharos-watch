import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  filterUnprojectedTapeEvents,
  insertTapeEvents,
  queryTapeEvents,
} from "../tape-event-store";
import { mapTapeEventRow, parseDateStringToEpochSec } from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixtures.closeAll();
});

function event(sourceRowId: string): TapeEventInsert {
  return {
    eventId: `event-${sourceRowId}`,
    type: "catalog.entry.added",
    severity: "notice",
    ts: 1_000,
    endsAt: null,
    coinId: null,
    issuerId: null,
    pegCurrency: null,
    chain: null,
    title: sourceRowId,
    summary: sourceRowId,
    payload: {},
    sourceTable: "catalog",
    sourceRowId,
    transition: "opened",
    sourceUrl: null,
    methodologyVersion: null,
  };
}

function createTapeDatabase(): { db: D1Database } {
  return fixtures.open();
}

describe("Tape event store static-catalog probes", () => {
  it("retries two overload failures and returns each unprojected event once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { db } = createTapeDatabase();
    const observed = event("observed-after-overload");
    const pending = event("pending-after-overload");
    await insertTapeEvents(db, [observed]);

    const batch = db.batch.bind(db);
    let attempts = 0;
    const retryingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            attempts += 1;
            if (attempts <= 2) {
              throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
            }
            return batch(statements);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const filtering = filterUnprojectedTapeEvents(retryingDb, [observed, pending]);
    await vi.runAllTimersAsync();

    await expect(filtering).resolves.toEqual([pending]);
    expect(attempts).toBe(3);
  });
});

describe("Curated tape event dates", () => {
  it("round-trips valid month and day precision in UTC", () => {
    expect(parseDateStringToEpochSec("2024-02")).toBe(Date.UTC(2024, 1, 1) / 1000);
    expect(parseDateStringToEpochSec("2024-02-29")).toBe(Date.UTC(2024, 1, 29) / 1000);
  });

  it.each([undefined, null, "", "24-02-29", "2024-13", "2024-02-31"])(
    "rejects invalid curated date %j",
    (value) => {
      expect(parseDateStringToEpochSec(value)).toBeNull();
    },
  );
});


describe("Tape event read boundary", () => {
  it("serves a projector insert through the full wire schema", async () => {
    const { db } = createTapeDatabase();
    const inserted = event("round-trip");
    await insertTapeEvents(db, [inserted]);

    const { rows } = await queryTapeEvents(db, { filters: {}, limit: 10, cursor: null, includeTotal: false });
    const mapping = mapTapeEventRow(rows[0]!);

    expect(mapping.quarantine).toBeNull();
    expect(mapping.event).toMatchObject({
      id: inserted.eventId,
      type: inserted.type,
      severity: inserted.severity,
      ts: inserted.ts,
      payload: inserted.payload,
      sourceTable: inserted.sourceTable,
      sourceRowId: inserted.sourceRowId,
      transition: inserted.transition,
    });
  });

  it.each(["a".repeat(48), "a".repeat(49), "a".repeat(200), "%", "_", "\\", "\u8cc7\u7523"])(
    "matches literal substrings across searchable columns for %j", async (q) => {
      const { db } = createTapeDatabase();
      await insertTapeEvents(db, [
        { ...event("title"), title: `before ${q.toUpperCase()} after` },
        { ...event("summary"), summary: `before ${q.toUpperCase()} after` },
        { ...event("coin"), coinId: `before-${q.toUpperCase()}-after` },
        { ...event("distractor"), title: `before ${q.slice(0, -1)} after` },
      ]);
      const options = { limit: 10, cursor: null, includeTotal: true } as const;
      const result = await queryTapeEvents(db, { ...options, filters: { q } });
      expect(result.rows.map((row) => row.event_id)).toEqual(["event-coin", "event-summary", "event-title"]);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);

      const missing = await queryTapeEvents(db, { ...options, filters: { q: `missing-${q}` } });
      expect(missing.rows).toEqual([]);
      expect(missing.total).toBe(0);
    },
  );

  it.each(["depeg", "de_peg", "a".repeat(1_000)])(
    "matches only literal dot-delimited type prefixes for %j", async (prefix) => {
      const { db } = createTapeDatabase();
      await insertTapeEvents(db, [
        { ...event("child"), type: `${prefix}.opened` },
        { ...event("nested"), type: `${prefix.toUpperCase()}.opened.updated` },
        { ...event("bare"), type: prefix },
        { ...event("not-delimited"), type: `${prefix}extra.opened` },
        { ...event("not-leading"), type: `other.${prefix}.opened` },
        { ...event("wildcard-decoy"), type: `${prefix.includes("_") ? prefix.replace(/_/g, "x") : "other"}.opened` },
      ]);
      const result = await queryTapeEvents(db, {
        filters: { typePrefixes: [prefix] }, limit: 10, cursor: null, includeTotal: true,
      });
      expect(result.rows.map((row) => row.event_id)).toEqual(["event-nested", "event-child"]);
      expect(result.total).toBe(2);
    },
  );
});
