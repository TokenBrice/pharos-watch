import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { encodeJsonCursor } from "../api-params";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import {
  buildPaginatedEventResponse,
  fetchPaginatedEvents,
  parsePaginatedEventParams,
} from "../api-pagination";

interface Row {
  id: number;
  started_at: number;
  stablecoin: string;
}

const PAGINATION = {
  defaultLimit: 50,
  minLimit: 1,
  maxLimit: 100,
} as const;

const TWO_COLUMN_CURSOR = {
  columns: [
    { column: "started_at", type: "number", direction: "DESC", getValue: (r: Row) => r.started_at },
    { column: "id", type: "number", direction: "DESC", getValue: (r: Row) => r.id },
  ],
} as const;

// parsePaginatedEventParams only reads column/type/direction (never getValue), and is typed for
// PaginatedEventCursorConfig<unknown>; these row-agnostic configs satisfy that signature directly.
const UNKNOWN_TWO_COLUMN_CURSOR = {
  columns: [
    { column: "started_at", type: "number", direction: "DESC", getValue: () => 0 },
    { column: "id", type: "number", direction: "DESC", getValue: () => 0 },
  ],
} as const;

const UNKNOWN_STRING_CURSOR = {
  columns: [{ column: "stablecoin", type: "string", direction: "ASC", getValue: () => "" }],
} as const;

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

const paginationDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of paginationDatabases.splice(0)) sqlite.close();
});

describe("parsePaginatedEventParams cursor validation", () => {
  it("returns null cursorValues when no cursor supplied", () => {
    const result = parsePaginatedEventParams(params(""), PAGINATION, UNKNOWN_TWO_COLUMN_CURSOR);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { cursorValues: unknown }).cursorValues).toBeNull();
  });

  it("decodes a valid cursor into ordered values", () => {
    const cursor = encodeJsonCursor({ v: 1, values: [1_700_000_000, 42] });
    const result = parsePaginatedEventParams(params(`cursor=${cursor}`), PAGINATION, UNKNOWN_TWO_COLUMN_CURSOR);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { cursorValues: unknown }).cursorValues).toEqual([1_700_000_000, 42]);
  });

  it("rejects corrupt base64 cursor with 400", async () => {
    const result = parsePaginatedEventParams(params("cursor=%%%not-base64%%%"), PAGINATION, UNKNOWN_TWO_COLUMN_CURSOR);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("rejects cursor with wrong version (v !== 1)", () => {
    const cursor = encodeJsonCursor({ v: 2, values: [1_700_000_000, 42] });
    const result = parsePaginatedEventParams(params(`cursor=${cursor}`), PAGINATION, UNKNOWN_TWO_COLUMN_CURSOR);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("rejects cursor with mismatched column count", () => {
    const cursor = encodeJsonCursor({ v: 1, values: [1_700_000_000] });
    const result = parsePaginatedEventParams(params(`cursor=${cursor}`), PAGINATION, UNKNOWN_TWO_COLUMN_CURSOR);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("rejects cursor with a non-finite number column value", () => {
    // Number-typed column receiving null serialises to JSON null, which fails the number guard.
    const cursor = encodeJsonCursor({ v: 1, values: [null, 42] });
    const result = parsePaginatedEventParams(params(`cursor=${cursor}`), PAGINATION, UNKNOWN_TWO_COLUMN_CURSOR);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("rejects cursor with wrong column type (string column receiving a number)", () => {
    const cursor = encodeJsonCursor({ v: 1, values: [123] });
    const result = parsePaginatedEventParams(params(`cursor=${cursor}`), PAGINATION, UNKNOWN_STRING_CURSOR);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("rejects cursor pagination on an endpoint with no cursor config", () => {
    const cursor = encodeJsonCursor({ v: 1, values: [1] });
    const result = parsePaginatedEventParams(params(`cursor=${cursor}`), PAGINATION);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("rejects combined cursor and offset with 400", () => {
    const cursor = encodeJsonCursor({ v: 1, values: [1_700_000_000, 42] });
    const result = parsePaginatedEventParams(
      params(`cursor=${cursor}&offset=10`),
      PAGINATION,
      UNKNOWN_TWO_COLUMN_CURSOR,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });
});

describe("fetchPaginatedEvents cursor WHERE clause", () => {
  it("rejects an unknown table", async () => {
    await expect(
      fetchPaginatedEvents<Row, Row>(mockD1([], { requireMatch: true }), {
        tableName: "not_a_table",
        orderBy: "started_at DESC",
        conditions: [],
        filterBindings: [],
        limit: 10,
        offset: 0,
        mapRow: (r) => r,
      }),
    ).rejects.toThrow(/Invalid table/);
  });

  it("rejects an index that is not allowlisted for the selected table", async () => {
    await expect(
      fetchPaginatedEvents<Row, Row>(mockD1([], { requireMatch: true }), {
        tableName: "blacklist_events",
        indexName: "idx_untrusted_runtime_input",
        orderBy: "timestamp DESC, id DESC",
        conditions: ["suppression_reason IS NULL"],
        filterBindings: [],
        limit: 10,
        offset: 0,
        mapRow: (r) => r,
      }),
    ).rejects.toThrow(/Invalid pagination index/);
  });

  it("emits an allowlisted index hint for data and count queries", async () => {
    const db = mockD1([
      { match: "COUNT(*) as total", rows: [{ total: 0 }] },
      { match: "FROM blacklist_events INDEXED BY", rows: [] },
    ], { requireMatch: true });
    await fetchPaginatedEvents<Row, Row>(db, {
      tableName: "blacklist_events",
      indexName: "idx_blacklist_events_public_date_page",
      orderBy: "timestamp DESC, id DESC",
      conditions: ["suppression_reason IS NULL"],
      filterBindings: [],
      limit: 10,
      offset: 0,
      includeTotal: true,
      mapRow: (r) => r,
    });

    const queries = db.getHistory().filter((entry) => entry.sql.includes("FROM blacklist_events"));
    expect(queries).toHaveLength(2);
    expect(queries.every((entry) => entry.sql.includes("INDEXED BY idx_blacklist_events_public_date_page"))).toBe(true);
  });

  it("rejects a cursor config referencing a non-allowlisted column", async () => {
    await expect(
      fetchPaginatedEvents<Row, Row>(mockD1([], { requireMatch: true }), {
        tableName: "depeg_events",
        orderBy: "started_at DESC",
        conditions: [],
        filterBindings: [],
        limit: 10,
        offset: 0,
        mapRow: (r) => r,
        cursor: {
          columns: [{ column: "not_allowed", type: "number", direction: "DESC", getValue: (r) => r.id }],
        },
        cursorValues: [1],
      }),
    ).rejects.toThrow(/Invalid cursor column/);
  });

  it("traverses tied timestamps with mixed secondary directions without losing rows", async () => {
    const sqlite = new DatabaseSync(":memory:");
    paginationDatabases.push(sqlite);
    sqlite.exec(`CREATE TABLE depeg_events (id INTEGER PRIMARY KEY, started_at INTEGER, stablecoin TEXT);
      INSERT INTO depeg_events VALUES (9, 300, 'a'), (8, 300, 'a'), (7, 300, 'b'),
        (6, 300, 'b'), (5, 300, 'b'), (4, 200, 'a')`);
    const db = createSqliteD1(sqlite);
    const config = {
      tableName: "depeg_events",
      orderBy: "started_at DESC, stablecoin ASC, id DESC",
      conditions: [] as string[],
      filterBindings: [] as (string | number)[],
      limit: 3,
      offset: 0,
      includeTotal: false,
      mapRow: (r: Row) => r,
      cursor: {
        columns: [
          { column: "started_at", type: "number", direction: "DESC", getValue: (r: Row) => r.started_at },
          { column: "stablecoin", type: "string", direction: "ASC", getValue: (r: Row) => r.stablecoin },
          { column: "id", type: "number", direction: "DESC", getValue: (r: Row) => r.id },
        ],
      },
    } as const;
    const first = await fetchPaginatedEvents<Row, Row>(db, config);
    expect(first.events.map((r) => r.id)).toEqual([9, 8, 7]);
    const decoded = JSON.parse(atob(first.nextCursor!));
    expect(decoded).toEqual({ v: 1, values: [300, "b", 7] });
    const second = await fetchPaginatedEvents<Row, Row>(db, { ...config, cursorValues: decoded.values });
    expect(second.events.map((r) => r.id)).toEqual([6, 5, 4]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not emit a cursor when the last emitted row has a null cursor value", async () => {
    const db = mockD1([{ match: "FROM depeg_events", rows: [
      { id: 2, started_at: 200, stablecoin: "a" },
      { id: 1, started_at: 100, stablecoin: "a" },
    ] }]);
    const result = await fetchPaginatedEvents<Row, Row>(db, {
      tableName: "depeg_events", orderBy: "id DESC", conditions: [], filterBindings: [],
      limit: 1, offset: 0, includeTotal: false, mapRow: (r) => r,
      cursor: { columns: [{ column: "id", type: "number", direction: "DESC", getValue: () => null }] },
    });
    expect(result.events.map((r) => r.id)).toEqual([2]);
    expect(result.nextCursor).toBeNull();
  });

  it("emits a nextCursor when more rows exist and null when the page is short", async () => {
    const rows = [
      { id: 3, started_at: 300, stablecoin: "usdc" },
      { id: 2, started_at: 200, stablecoin: "usdc" },
      { id: 1, started_at: 100, stablecoin: "usdc" },
    ];
    const more = mockD1([{ match: "FROM depeg_events", rows }], { requireMatch: true });
    const moreResult = await fetchPaginatedEvents<Row, Row>(more, {
      tableName: "depeg_events",
      orderBy: "started_at DESC, id DESC",
      conditions: [],
      filterBindings: [],
      limit: 2,
      offset: 0,
      includeTotal: false,
      mapRow: (r) => r,
      cursor: TWO_COLUMN_CURSOR,
      cursorValues: null,
    });
    expect(moreResult.events).toHaveLength(2);
    expect(JSON.parse(atob(moreResult.nextCursor!))).toEqual({ v: 1, values: [200, 2] });

    const short = mockD1([{ match: "FROM depeg_events", rows: rows.slice(0, 1) }], { requireMatch: true });
    const shortResult = await fetchPaginatedEvents<Row, Row>(short, {
      tableName: "depeg_events",
      orderBy: "started_at DESC, id DESC",
      conditions: [],
      filterBindings: [],
      limit: 2,
      offset: 0,
      includeTotal: false,
      mapRow: (r) => r,
      cursor: TWO_COLUMN_CURSOR,
      cursorValues: null,
    });
    expect(shortResult.events).toHaveLength(1);
    expect(shortResult.nextCursor).toBeNull();
  });

  it("rejects invalid order clauses and unsafe query comments", async () => {
    await expect(
      fetchPaginatedEvents<Row, Row>(mockD1([], { requireMatch: true }), {
        tableName: "depeg_events",
        orderBy: "started_at DESC NULLS LAST",
        conditions: [],
        filterBindings: [],
        limit: 10,
        offset: 0,
        mapRow: (r) => r,
      }),
    ).rejects.toThrow(/Invalid orderBy/);

    await expect(
      fetchPaginatedEvents<Row, Row>(mockD1([], { requireMatch: true }), {
        tableName: "depeg_events",
        orderBy: "started_at DESC",
        queryComment: "unsafe comment",
        conditions: [],
        filterBindings: [],
        limit: 10,
        offset: 0,
        mapRow: (r) => r,
      }),
    ).rejects.toThrow(/Invalid query comment/);
  });

  it("reports an inexact lower-bound total for cursor pages without totals", async () => {
    const rows = [
      { id: 3, started_at: 300, stablecoin: "usdc" },
      { id: 2, started_at: 200, stablecoin: "usdc" },
      { id: 1, started_at: 100, stablecoin: "usdc" },
    ];
    const db = mockD1([{ match: "FROM depeg_events", rows }], { requireMatch: true });
    const result = await fetchPaginatedEvents<Row, Row>(db, {
      tableName: "depeg_events",
      orderBy: "started_at DESC, id DESC",
      conditions: ["stablecoin = ?"],
      filterBindings: ["usdc"],
      limit: 2,
      offset: 25,
      includeTotal: false,
      mapRow: (r) => r,
      cursor: TWO_COLUMN_CURSOR,
      cursorValues: [400, 4],
    });

    expect(result.totalExact).toBe(false);
    expect(result.total).toBe(3);
    expect(db.getHistory()[0]!.binds).toEqual(["usdc", 400, 400, 4, 3]);
  });

});

describe("buildPaginatedEventResponse", () => {
  const baseConfig = {
    tableName: "depeg_events" as const,
    orderBy: "started_at DESC, id DESC",
    conditions: [] as string[],
    filterBindings: [] as (string | number)[],
    mapRow: (r: Row) => r,
    pagination: PAGINATION,
    cursor: TWO_COLUMN_CURSOR,
    freshness: {
      producerJob: "detect-depegs",
      maxAgeSec: 600,
      fallbackTimestamp: () => 0,
    },
    cacheControl: "public, max-age=60",
  };

  it("returns a fresh 200 response with events, total, and nextCursor", async () => {
    const db = mockD1([
      { match: "COUNT(*) as total FROM depeg_events", rows: [{ total: 1 }] },
      { match: "FROM depeg_events", rows: [{ id: 1, started_at: 100, stablecoin: "usdc" }] },
      { match: "MAX(started_at) as started_at FROM cron_runs", rows: [{ started_at: 1_700_000_000 }] },
    ], { requireMatch: true });
    const response = await buildPaginatedEventResponse<Row, Row>(db, {
      ...baseConfig,
      searchParams: params("limit=10"),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: Row[]; total: number; nextCursor: unknown };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body).toHaveProperty("nextCursor");
  });


  it("uses custom cursor parameter names and merges async extra response fields", async () => {
    const db = mockD1([
      { match: "COUNT(*) as total FROM depeg_events", rows: [{ total: 2 }] },
      { match: "FROM depeg_events", rows: [{ id: 2, started_at: 200, stablecoin: "usdc" }] },
      { match: "MAX(started_at) as started_at FROM cron_runs", rows: [] },
    ], { requireMatch: true });
    const cursor = encodeJsonCursor({ v: 1, values: [300, 3] });
    const response = await buildPaginatedEventResponse<Row, Row, { symbols: string[] }>(db, {
      ...baseConfig,
      cursor: { ...TWO_COLUMN_CURSOR, parameterName: "after" },
      searchParams: params(`after=${cursor}&includeTotal=true`),
      buildExtraBody: async (events) => ({ symbols: events.map((event) => event.stablecoin) }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { symbols: string[]; total: number };
    expect(body.symbols).toEqual(["usdc"]);
    expect(body.total).toBe(2);
  });

  it("short-circuits with the parse error response on an invalid cursor", async () => {
    const db = mockD1([], { requireMatch: true });
    const response = await buildPaginatedEventResponse<Row, Row>(db, {
      ...baseConfig,
      searchParams: params("cursor=%%%bad%%%"),
    });
    expect(response.status).toBe(400);
    expect(db.getHistory()).toHaveLength(0);
  });
});

describe("fetchPaginatedEvents", () => {
  it("builds count and data queries with validated pagination inputs", async () => {
    type BoundStatement = { sql: string; binds: unknown[] };
      const db = makeNoopD1({
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({ sql, binds }),
      }),
      batch: vi.fn(async (stmts: BoundStatement[]) => {
        expect(stmts).toHaveLength(2);
        expect(stmts[0]).toEqual({
          sql: "SELECT COUNT(*) as total FROM blacklist_events WHERE stablecoin_id = ?",
          binds: ["usdt-tether"],
        });
        expect(stmts[1]).toEqual({
          sql: "SELECT * FROM blacklist_events WHERE stablecoin_id = ? ORDER BY timestamp DESC, id ASC LIMIT ? OFFSET ?",
          binds: ["usdt-tether", 25, 50],
        });

        return [
          { results: [{ total: 2 }] },
          { results: [{ id: "a" }, { id: "b" }] },
        ];
      }),
    });

    const result = await fetchPaginatedEvents<{ id: string }, string>(db, {
      tableName: "blacklist_events",
      orderBy: "timestamp DESC, id ASC",
      conditions: ["stablecoin_id = ?"],
      filterBindings: ["usdt-tether"],
      limit: 25,
      offset: 50,
      mapRow: (row) => row.id,
    });

    expect(result).toEqual({
      total: 2,
      events: ["a", "b"],
    });
  });

  it("rejects non-allowlisted tables and malformed order clauses", async () => {
    await expect(fetchPaginatedEvents(makeNoopD1(), {
      tableName: "cache",
      orderBy: "timestamp DESC",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid table: cache");

    await expect(fetchPaginatedEvents(makeNoopD1(), {
      tableName: "blacklist_events",
      orderBy: "timestamp DOWN",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid orderBy direction: DOWN");

    await expect(fetchPaginatedEvents(makeNoopD1(), {
      tableName: "blacklist_events",
      orderBy: "timestamp DESC NULLS LAST",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid orderBy: timestamp DESC NULLS LAST");
  });
});
