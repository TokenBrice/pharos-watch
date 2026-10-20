import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { DepegEventsResponseSchema } from "@shared/types/market";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeDepegRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleDepegEvents } from "../depeg-events";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

describe("handleDepegEvents", () => {
  const row = makeDepegRow();

  it("returns dependency unavailability rather than raw history when incident projection fails", async () => {
    const db = mockD1([
      {
        match: "pharos:depeg-event-projection:active-incidents",
        rows: [],
        throwError: new Error("projection read timed out"),
      },
      { match: "pharos:depeg-events:count", rows: [{ total: 2 }] },
      { match: "depeg_events", rows: [row, { ...row, id: 2 }] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    expect(await readJsonResponse(res, 503)).toEqual({
      error: "Canonical incident history unavailable",
      reason: "incident-projection-read-failed",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    { current_event_id: null, first_started_at: 1_700_000_000, first_start_price: 0.97, first_peg_reference: 1, constituent_event_count: 2 },
    { current_event_id: 2, first_started_at: null, first_start_price: 0.97, first_peg_reference: 1, constituent_event_count: 2 },
    { current_event_id: 2, first_started_at: 1_700_000_000, first_start_price: "0.97", first_peg_reference: 1, constituent_event_count: 2 },
    { current_event_id: 2, first_started_at: 1_700_000_000, first_start_price: 0.97, first_peg_reference: -1, constituent_event_count: 2 },
    { current_event_id: 2, first_started_at: 1_700_000_000, first_start_price: 0.97, first_peg_reference: 1, constituent_event_count: 0 },
    { current_event_id: 2, first_started_at: 1_700_000_000, first_start_price: 0.97, first_peg_reference: 1, constituent_event_count: 1.5 },
  ])("withholds raw history when an incident projection row is malformed: %j", async (projection) => {
    const db = mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [{ references_valid: 1, ...projection }] },
      { match: "pharos:depeg-events:count", rows: [{ total: 0 }] },
      { match: "pharos:depeg-events:page", rows: [] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    expect(await readJsonResponse(res, 503)).toEqual({
      error: "Canonical incident history unavailable", reason: "incident-projection-invalid",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps a successful empty incident projection readable", async () => {
    const db = mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
      { match: "pharos:depeg-events:count", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const body = await readJsonResponse(res, 200) as { events: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.events).toHaveLength(1);
  });

  function seedIncident(firstId: number, currentId: number, eventIds: number[], linkIds = [firstId, currentId]) {
    const { sqlite, db } = fixtures.open();
    const key = `ddr2:${"a".repeat(32)}`;
    for (const id of eventIds) {
      sqlite.prepare(`INSERT INTO depeg_events
        (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
        VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', 300, ?, ?, 1)`)
        .run(id, 1_700_000_000 + (id - firstId) * 1_000, id === firstId ? 0.97 : 0.96);
    }
    for (const id of new Set(linkIds)) {
      sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at)
        VALUES (?, ?, 'observed', 1700000000)`).run(key, id);
    }
    // Seed unsealed dangling pointers directly: no duplicate-deletion trigger or disabled seal guard.
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at, updated_at)
      VALUES (?, 'usdt-tether', 'USD', 'below', ?, ?, 1700000000, 1700001000, 300, ?, 1700000000, 1700001000)`)
      .run(key, firstId, currentId, "b".repeat(64));
    return { sqlite, db, key };
  }

  it.each([
    { name: "first event", first: 101, current: 102, events: [102], links: [101, 102] },
    { name: "current event", first: 101, current: 102, events: [101], links: [101, 102] },
    { name: "singleton event", first: 101, current: 101, events: [], links: [101] },
    { name: "constituent event", first: 101, current: 102, events: [101, 102], links: [101, 102, 103] },
    { name: "first membership", first: 101, current: 102, events: [101, 102], links: [102] },
  ])("returns named 503 for dangling $name references in migrated SQLite", async ({ first, current, events, links }) => {
    const { db } = seedIncident(first, current, events, links);
    for (const query of ["?active=true", "?active=true&stablecoin=usdt-tether"]) {
      const res = await handleDepegEvents(db, new URL(`https://x/api/depeg-events${query}`));
      expect(await readJsonResponse(res, 503)).toEqual({
        error: "Canonical incident history unavailable", reason: "incident-projection-dangling-reference",
      });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it.each([101, 102])("publishes valid canonical cohorts with current event %s in migrated SQLite", async (current) => {
    const { db } = seedIncident(101, current, current === 101 ? [101] : [101, 102]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?active=true&stablecoin=usdt-tether"));
    const body = await readJsonResponse(res, 200) as { events: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.events).toEqual([expect.objectContaining({
      id: current, startedAt: 1_700_000_000, startPrice: 0.97, constituentEventCount: current === 101 ? 1 : 2,
    })]);
  });

  it("keeps canonical active identity distinct from closed same-coin episodes", async () => {
    const { sqlite, db } = seedIncident(101, 102, [101, 102]);
    for (const [id, reason] of [[103, "recovered-primary"], [104, "coverage-lost-supply"], [105, "superseded-direction"]] as const) {
      sqlite.prepare(`INSERT INTO depeg_events
        (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at,
         start_price, peg_reference, recovery_price, close_reason, source)
        VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', 300, ?, 1699991000,
          .97, 1, ?, ?, 'live')`).run(id, 1_699_990_000 + id, reason === "recovered-primary" ? 1 : null, reason);
    }
    const response = await handleDepegEvents(db, new URL("https://x/api/depeg-events?active=true&includeTotal=false&limit=1"));
    const body = DepegEventsResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.events.map(({ id }) => id)).toEqual([102]);
    expect(body.events[0]).toMatchObject({ startedAt: 1_700_000_000, constituentEventCount: 2, endedAt: null });
    expect(body.events[0]).not.toHaveProperty("constituentEventIds");
    expect(body.nextCursor).toBeNull();
  });

  it("publishes a genuinely empty active cohort in migrated SQLite", async () => {
    const { db } = fixtures.open();
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?active=true"));
    expect(await readJsonResponse(res, 200)).toMatchObject({ events: [], total: 0 });
  });

  it.each([true, false])("pages interleaved public onsets with stable ties and methodology asOf (includeTotal=%s)", async (includeTotal) => {
    const { sqlite, db } = seedIncident(101, 102, [101, 102]);
    for (const [id, onset] of [[103, 1_700_000_500], [104, 1_700_000_000], [105, 1_699_999_000]]) {
      sqlite.prepare(`INSERT INTO depeg_events
        (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference, source)
        VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', 200, ?, .98, 1, ?)`)
        .run(id, onset, id === 104 ? "backfill" : "live");
    }
    for (const filter of ["", "&stablecoin=usdt-tether&active=true"]) {
      let cursor: string | null = null;
      const ids: number[] = [];
      for (const [id, onset] of [[103, 1_700_000_500], [104, 1_700_000_000], [102, 1_700_000_000], [105, 1_699_999_000]]) {
        const res = await handleDepegEvents(db, new URL(`https://x/api/depeg-events?limit=1&includeTotal=${includeTotal}${filter}${cursor ? `&cursor=${cursor}` : ""}`));
        const body = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200));
        expect(body.events.map((event) => event.id)).toEqual([id]);
        expect(body.events[0]?.startedAt).toBe(onset);
        expect(body.methodology?.asOf).toBe(onset);
        expect(body.totalExact).toBe(includeTotal);
        if (includeTotal) expect(body.total).toBe(4);
        if (id === 102) expect(body.events[0]?.constituentEventCount).toBe(2);
        ids.push(body.events[0]!.id);
        cursor = body.nextCursor ?? null;
        expect(cursor === null).toBe(id === 105);
      }
      expect(ids).toEqual([103, 104, 102, 105]);
      const offset = await handleDepegEvents(db, new URL(`https://x/api/depeg-events?limit=1&offset=2&includeTotal=${includeTotal}${filter}`));
      expect(DepegEventsResponseSchema.parse(await readJsonResponse(offset, 200)).events[0]?.id).toBe(102);
    }
  });

  it.each([
    { includeTotal: true, nextId: 103 }, { includeTotal: false, nextId: 103 },
    { includeTotal: true, nextId: 999 }, { includeTotal: false, nextId: 999 },
  ])("keeps pointer advance coherent or fails closed (includeTotal=$includeTotal, current=$nextId)", async ({ includeTotal, nextId }) => {
    const { sqlite, key } = seedIncident(101, 102, [101, 102, 103], [101, 102, 103]);
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      sqlite.exec("BEGIN IMMEDIATE");
      // The migrated current-pointer guard requires membership even when the
      // referenced event itself is missing; preserve that real schema guard.
      sqlite.prepare(`INSERT OR IGNORE INTO depeg_resolver_incident_event_links
        (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', 1700002000)`).run(key, nextId);
      sqlite.prepare(`UPDATE depeg_resolver_incidents SET current_event_id = ?, current_started_at = 1700002000
        WHERE incident_key = ?`).run(nextId, key);
      sqlite.exec("COMMIT");
      advanced = true;
    };
    // Before the fix this commits after the standalone projection read. With an
    // atomic batch the writer can commit only before or after the whole snapshot.
    const db = createSqliteD1(sqlite, { onAll: (sql) => {
      if (sql.includes("pharos:depeg-event-projection:active-incidents")) advance();
    } });
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation((statements) => {
      advance();
      return batch(statements);
    });
    const res = await handleDepegEvents(db, new URL(`https://x/api/depeg-events?active=true&includeTotal=${includeTotal}`));
    expect(advanced).toBe(true);
    if (nextId === 999) {
      expect(await readJsonResponse(res, 503)).toEqual({
        error: "Canonical incident history unavailable", reason: "incident-projection-dangling-reference",
      });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    } else {
      const body = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200));
      expect(body.events).toEqual([expect.objectContaining({
        id: 103, startedAt: 1_700_000_000, startPrice: .97, constituentEventCount: 3,
      })]);
      expect(body.total).toBe(1);
      expect(body.methodology?.asOf).toBe(1_700_000_000);
    }
  });

  it("returns 200 with events and total", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 1 }] }, { match: "depeg_events", rows: [row] },]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=usdt-tether"));
    const body = (await readJsonResponse(res, 200)) as {
      events: unknown[];
      total: number;
      methodology: Record<string, unknown>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body).not.toHaveProperty("counts");
    expect(body.methodology).toHaveProperty("version");
    expect(body.methodology).toHaveProperty("changelogPath");
  });

  it("maps snake_case to camelCase via rowToDepegEvent", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 1 }] }, { match: "depeg_events", rows: [row] },]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    const event = body.events[0];
    expect(event).toHaveProperty("stablecoinId");
    expect(event).toHaveProperty("peakDeviationBps");
    expect(event).toHaveProperty("startedAt");
    expect(event).toHaveProperty("pegReference");
    expect(event).toHaveProperty("closeReason", null);
    expect(event).not.toHaveProperty("stablecoin_id");
    expect(event).not.toHaveProperty("peak_deviation_bps");
  });

  it("exposes closeReason for terminal depeg rows", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 1 }] }, {
      match: "depeg_events",
      rows: [
        makeDepegRow({
          ended_at: 1_800_000_000,
          recovery_price: null,
          close_reason: "coverage-lost-supply",
        }),
      ],
    },]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const body = DepegEventsResponseSchema.parse(await res.json());
    expect(body.events[0]?.closeReason).toBe("coverage-lost-supply");
  });

  it("maps optional provenance JSON while preserving legacy rows", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 2 }] }, {
      match: "depeg_events",
      rows: [
        {
          ...row,
          provenance_json: JSON.stringify({
            sourceKind: "market",
            replayRunId: "run-1",
            confidenceTier: "medium",
            auditVerdict: "confirmed",
          }),
        },
        { ...row, id: 2 },
      ],
    },]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(body.events[0]?.provenance).toMatchObject({
      sourceKind: "market",
      replayRunId: "run-1",
      confidenceTier: "medium",
      auditVerdict: "confirmed",
    });
    expect(body.events[1]?.provenance).toBeNull();
  });

  it("returns 200 with empty results when no data", async () => {
    const emptyDb = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 0 }] }, { match: "depeg_events", rows: [] },]);
    const res = await handleDepegEvents(emptyDb, new URL("https://x/api/depeg-events"));
    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  registerStablecoinParameterContract({
    name: "depeg events",
    path: "/api/depeg-events",
    invoke: handleDepegEvents,
    cases: [{ kind: "unknown", stablecoin: "<script>" }],
  });

  it("filters active events", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 1 }] }, { match: "depeg_events", rows: [makeDepegRow({ ended_at: null })] },]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?active=true"));

    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    const dataQuery = db
      .getHistory()
      .find((entry) => entry.sql.includes("pharos:depeg-events:page"));
    expect(dataQuery?.sql).toContain("ended_at IS NULL");
  });

  it("rejects malformed active booleans instead of silently treating them as false", async () => {
    const res = await handleDepegEvents(mockD1([]), new URL("https://x/api/depeg-events?active=yes"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid active: must be true or false" });
  });

  it("excludes superseded rows from active DDR incident repairs", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 1 }] }, { match: "depeg_events", rows: [row] },]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=apxusd-apyx"));

    expect(res.status).toBe(200);
    const dataQuery = db
      .getHistory()
      .find((entry) => entry.sql.includes("pharos:depeg-events:page"));
    expect(dataQuery?.sql).toContain("depeg_resolver_incident_event_links");
    expect(dataQuery?.sql).toContain("links.event_id != incidents.current_event_id");
  });

  it.each([0, 0.9893])("projects observed first-event price %s without replacing zero", async (startPrice) => {
    const currentRow = makeDepegRow({
      id: 90089,
      stablecoin_id: "apxusd-apyx",
      started_at: 1_780_671_044,
      start_price: 0.9365,
    });
    const db = mockD1([
      {
        match: "FROM depeg_resolver_incidents incidents",
        matchBinds: ["apxusd-apyx", "apxusd-apyx"],
        rows: [
          {
            current_event_id: 90089,
            first_started_at: 1_780_437_028,
            first_start_price: startPrice,
            first_peg_reference: 1,
            constituent_event_count: 4,
            references_valid: 1,
          },
        ],
      },
      { match: "pharos:depeg-events:count", rows: [{ total: 1 }] },
      { match: "FROM depeg_events_with_provenance", rows: [currentRow] },
    ]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=apxusd-apyx"));

    const body = (await readJsonResponse(res, 200)) as { events: Array<Record<string, unknown>> };
    expect(body.events[0]).toMatchObject({
      id: 90089,
      startedAt: 1_780_437_028,
      startPrice,
      pegReference: 1,
      constituentEventCount: 4,
    });
  });

  it("uses latest successful sync timestamp for freshness headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 1 }] }, { match: "depeg_events", rows: [makeDepegRow({ started_at: now - 7 * 86400 })] },
    { match: "cron_runs", rows: [], first: { started_at: now - 45 } },]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    expect(res.headers.get("X-Data-Age")).toBe("45");
  });

  it("rejects oversized limits instead of coercing them", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?limit=1001"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 1 and 1000" });
    expect(db.getHistory()).toEqual([]);
  });

  it("rejects offsets above the endpoint cap", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?offset=50001"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid offset: must be between 0 and 50000" });
    expect(db.getHistory()).toEqual([]);
  });

  it.each([
    "active=yes",
    "includePending=yes",
    "includeTotal=yes",
    "limit=1001",
    "limit=abc",
    "offset=50001",
    "offset=-1",
    "cursor=invalid",
    `cursor=${btoa(JSON.stringify({ v: 1, values: [1_700_000_000, 1] }))}`,
    `cursor=${btoa(JSON.stringify({ v: 2, values: [1_700_000_000, 1] }))}&offset=1`,
  ])("rejects invalid query %s before reading an unavailable incident projection", async (query) => {
    const db = mockD1([{
      match: "pharos:depeg-event-projection:active-incidents",
      rows: [],
      throwError: new Error("projection read timed out"),
    }]);
    const res = await handleDepegEvents(db, new URL(`https://x/api/depeg-events?${query}`));
    expect(res.status).toBe(400);
    expect(db.getHistory()).toEqual([]);
  });

  it("can skip the exact total count for cursor-style callers", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "depeg_events", rows: [row] }, ]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?includeTotal=false"));

    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number; totalExact: boolean };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.totalExact).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("depeg-events:count") || entry.sql.includes("INSERT INTO cache"))).toBe(false);
  });

  it("does not query or emit derived incident counts", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "depeg_events", rows: [row] }, ]) as MockD1Database;

    const res = await handleDepegEvents(
      db,
      new URL("https://x/api/depeg-events?stablecoin=usdt-tether&includeTotal=false"),
    );

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("counts");
    expect(db.getHistory().some((entry) => entry.sql.includes("threshold-crossing-count"))).toBe(false);
  });

  it("emits and accepts a keyset cursor", async () => {
    const first = { ...makeDepegRow({ id: 3, started_at: 1_700_000_003 }), effective_started_at: 1_700_000_003 };
    const second = { ...makeDepegRow({ id: 2, started_at: 1_700_000_002 }), effective_started_at: 1_700_000_002 };
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "depeg_events", rows: [first, second] }, ]) as MockD1Database;

    const firstRes = await handleDepegEvents(db, new URL("https://x/api/depeg-events?limit=1&includeTotal=false"));
    const firstBody = (await firstRes.json()) as { events: unknown[]; nextCursor: string | null };
    expect(firstBody.events).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTypeOf("string");
    expect(JSON.parse(atob(firstBody.nextCursor!))).toEqual({ v: 2, values: [1_700_000_003, 3] });

    const cursorDb = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "depeg_events", rows: [second] }, ]) as MockD1Database;
    const cursorRes = await handleDepegEvents(
      cursorDb,
      new URL(`https://x/api/depeg-events?limit=1&includeTotal=false&cursor=${firstBody.nextCursor}`),
    );

    expect(cursorRes.status).toBe(200);
    const dataQuery = cursorDb.getHistory().find((entry) => entry.sql.includes("FROM depeg_events"));
    expect(dataQuery?.sql).toContain("effective_started_at < ?");
    expect(dataQuery?.sql).toContain("id < ?");
    expect(dataQuery?.binds).toContain(first.started_at);
    expect(dataQuery?.binds).toContain(first.id);
  });

  it.each([
    { label: "trusted pool evidence", count: 2, tvl: 5_000_000, dexAvailable: true },
    { label: "ticker-only price evidence", count: 1, tvl: 0, dexAvailable: false },
    { label: "absent TVL evidence", count: 1, tvl: null, dexAvailable: false },
    { label: "malformed TVL evidence", count: 1, tvl: "5000000", dexAvailable: false },
  ])("derives pending confirmation categories from $label", async ({ count, tvl, dexAvailable }) => {
    const nowSec = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSec * 1000));

    try {
      const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "depeg_events", rows: [] }, {
        match: "FROM depeg_pending",
        rows: [
          {
            id: 10,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            direction: "below",
            first_seen_bps: -180,
            first_seen_at: nowSec - 600,
            first_price: 0.982,
            last_seen_bps: -240,
            last_seen_at: nowSec - 120,
            last_price: 0.976,
            peak_seen_bps: -310,
            peak_price: 0.969,
            peg_reference: 1,
            reason: "large-cap+low-confidence",
            updated_at: nowSec - 120,
          },
        ],
      },
      {
        match: "FROM dex_prices",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            source_pool_count: count,
            source_total_tvl: tvl,
            updated_at: nowSec - 60,
          },
        ],
      },
      {
        match: "FROM dex_price_challenger_snapshots",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            snapshot_at: nowSec - 60,
            has_rows: 0,
          },
        ],
      },]);

      const res = await handleDepegEvents(
        db,
        new URL("https://x/api/depeg-events?includeTotal=false&includePending=true"),
      );

      const body = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200));
      expect(body.pending).toEqual([
        {
          stablecoinId: "usdt-tether",
          symbol: "USDT",
          direction: "below",
          firstSeenAt: nowSec - 600,
          lastSeenAt: nowSec - 120,
          firstSeenBps: -180,
          lastSeenBps: -240,
          peakSeenBps: -310,
          reason: "large-cap+low-confidence",
          ageSec: 600,
          expiresAt: nowSec - 600 + (45 * 60),
          availableConfirmationCategories: dexAvailable ? ["offchain", "dex"] : ["offchain"],
          missingConfirmationCategories: dexAvailable ? ["pool"] : ["dex", "pool"],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports pending pool availability from accepted v2 membership, retaining v1 only before a head exists", async () => {
    const nowSec = 1_800_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO depeg_pending
      (stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, peg_reference)
      VALUES ('usdt-tether', 'USDT', 'peggedUSD', 'below', -200, ?, .98, 1)`).run(nowSec - 60);
    sqlite.prepare(`INSERT INTO dex_price_challenger_snapshots
      (stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete)
      VALUES ('usdt-tether', ?, ?, 1, 1)`).run(nowSec - 60, nowSec - 60);
    const assertAvailability = async (available: boolean) => {
      for (const filter of ["", "&stablecoin=usdt-tether"]) {
        const res = await handleDepegEvents(db,
          new URL(`https://x/api/depeg-events?includeTotal=false&includePending=true${filter}`));
        const pending = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200)).pending?.[0];
        expect(pending?.availableConfirmationCategories.includes("pool")).toBe(available);
        expect(pending?.missingConfirmationCategories.includes("pool")).toBe(!available);
      }
    };
    await assertAvailability(true);
    sqlite.prepare(`INSERT INTO dex_price_challenger_publications_v2
      (publication_id, generation_id, snapshot_at, published_at) VALUES (1, 'generation', ?, ?)`)
      .run(nowSec - 60, nowSec);
    await assertAvailability(true); // Staging is not a visibility authority.
    sqlite.exec(`UPDATE dex_price_challenger_publications_v2 SET sealed = 1;
      INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
      VALUES ('usdt-tether', 1, 0);`);
    await assertAvailability(false); // Accepted empty overrides fresh legacy rows.
    sqlite.exec(`INSERT INTO dex_price_challenger_payloads_v2
      (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd)
      VALUES (1, 'usdt-tether', 'pool', 'Ethereum', 'curve', 'dl', .98, 100000);
      UPDATE dex_price_challenger_heads_v2 SET has_rows = 1;
      UPDATE dex_price_challenger_snapshots SET snapshot_at = 1;`);
    await assertAvailability(true); // Fresh v2 no longer depends on frozen v1.
    sqlite.exec("UPDATE dex_price_challenger_heads_v2 SET source_coverage_complete = 0");
    await assertAvailability(false);
    sqlite.exec(`UPDATE dex_price_challenger_heads_v2 SET source_coverage_complete = 1;
      UPDATE dex_price_challenger_publications_v2 SET snapshot_at = 1;`);
    await assertAvailability(false); // Source clock, not allocation clock, ages availability.
  });

  it("filters pending incidents by readable stablecoin ID", async () => {
    const db = mockD1([{ match: "pharos:depeg-event-projection:active-incidents", rows: [] }, { match: "pharos:depeg-events:count", rows: [{ total: 0 }] }, { match: "depeg_events", rows: [] },
    {
      match: "FROM depeg_pending",
      matchBinds: ["usdc-circle"],
      rows: [
        {
          id: 11,
          stablecoin_id: "usdc-circle",
          symbol: "USDC",
          peg_type: "peggedUSD",
          direction: "above",
          first_seen_bps: 140,
          first_seen_at: 1_800_000_000,
          first_price: 1.014,
          last_seen_bps: null,
          last_seen_at: null,
          last_price: null,
          peak_seen_bps: null,
          peak_price: null,
          peg_reference: 1,
          reason: "large-cap",
          updated_at: 1_800_000_000,
        },
      ],
    },
    { match: "pharos:depeg-events:dex-availability", rows: [] },
    { match: "pharos:depeg-events:pool-availability", rows: [] },]) as MockD1Database;

    const res = await handleDepegEvents(
      db,
      new URL("https://x/api/depeg-events?stablecoin=usdc-circle&includePending=true"),
    );

    const body = DepegEventsResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.pending?.map((pending) => pending.stablecoinId)).toEqual(["usdc-circle"]);
    const pendingQuery = db.getHistory().find((entry) => entry.sql.includes("FROM depeg_pending"));
    expect(pendingQuery?.binds).toEqual(["usdc-circle"]);
  });
});
