import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { encodeJsonCursor } from "../api-params";
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

  it("builds the 3-column equality-prefix disjunction and binds in column order", async () => {
    const db = mockD1([
      { match: "FROM depeg_events", rows: [] },
    ], { requireMatch: true });
    await fetchPaginatedEvents<Row, Row>(db, {
      tableName: "depeg_events",
      orderBy: "started_at DESC, stablecoin ASC, id DESC",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      includeTotal: false,
      mapRow: (r) => r,
      cursor: {
        columns: [
          { column: "started_at", type: "number", direction: "DESC", getValue: (r) => r.started_at },
          { column: "stablecoin", type: "string", direction: "ASC", getValue: (r) => r.stablecoin },
          { column: "id", type: "number", direction: "DESC", getValue: (r) => r.id },
        ],
      },
      cursorValues: [1_700_000_000, "usdc", 42],
    });

    const dataQuery = db.getHistory().find((entry) => entry.sql.includes("FROM depeg_events"));
    expect(dataQuery).toBeDefined();
    // The third disjunct exercises the j<i equality-prefix predicates for all preceding columns.
    expect(dataQuery!.sql).toContain(
      "((started_at < ?) OR (started_at = ? AND stablecoin > ?) OR (started_at = ? AND stablecoin = ? AND id < ?))",
    );
    // Cursor bindings precede the LIMIT (offset is forced to 0 for cursor pages).
    expect(dataQuery!.binds.slice(0, 6)).toEqual([
      1_700_000_000,
      1_700_000_000,
      "usdc",
      1_700_000_000,
      "usdc",
      42,
    ]);
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
    expect(moreResult.nextCursor).toBeTruthy();

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
