import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  filterUnprojectedTapeEvents,
  insertTapeEvents,
  queryTapeEvents,
} from "../tape-event-store";
import { mapTapeEventRow } from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
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

function createTapeDatabase(): { db: D1Database; reads: string[] } {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE tape_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ends_at INTEGER,
      coin_id TEXT,
      issuer_id TEXT,
      peg_currency TEXT,
      chain TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_row_id TEXT NOT NULL,
      transition TEXT NOT NULL,
      source_url TEXT,
      methodology_version TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_tape_source_key
      ON tape_events(source_table, source_row_id, transition);
  `);
  const reads: string[] = [];
  const delegate = createSqliteD1(sqlite);
  const db = new Proxy(delegate, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("FROM tape_events")) reads.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, reads };
}

describe("Tape event store static-catalog probes", () => {
  it("filters observed source keys through bounded unique-index probes", async () => {
    const { db, reads } = createTapeDatabase();
    const observed = event("observed");
    const pending = event("pending");
    await insertTapeEvents(db, [observed]);

    await expect(filterUnprojectedTapeEvents(db, [observed, pending])).resolves.toEqual([pending]);

    expect(reads).toHaveLength(2);
    expect(reads.every((sql) => sql.includes("INDEXED BY idx_tape_source_key"))).toBe(true);
    expect(reads.every((sql) => sql.includes("LIMIT 1"))).toBe(true);
    expect(reads.every((sql) => !sql.includes("WHERE type ="))).toBe(true);
  });
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
});
