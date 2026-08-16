import { DepegEventsResponseSchema } from "@shared/types/market";
import { describe, it, expect, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import { makeDepegRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleDepegEvents } from "../depeg-events";

describe("handleDepegEvents", () => {
  const row = makeDepegRow();

  it("returns 200 with events and total", async () => {
    const db = mockD1([
      { match: "threshold-crossing-count", rows: [{ total: 13 }], first: { total: 13 } },
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      total: number;
      methodology: Record<string, unknown>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body).toMatchObject({ counts: { incidents: 1, thresholdCrossings: 13 } });
    expect(body.methodology).toHaveProperty("version");
    expect(body.methodology).toHaveProperty("changelogPath");
  });

  it("maps snake_case to camelCase via rowToDepegEvent", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]);
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
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      {
        match: "depeg_events",
        rows: [
          makeDepegRow({
            ended_at: 1_800_000_000,
            recovery_price: null,
            close_reason: "coverage-lost-supply",
          }),
        ],
      },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const body = DepegEventsResponseSchema.parse(await res.json());
    expect(body.events[0]?.closeReason).toBe("coverage-lost-supply");
  });

  it("maps optional provenance JSON while preserving legacy rows", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 2 }] },
      {
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
      },
    ]);
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
    const emptyDb = mockD1([
      { match: "COUNT", rows: [{ total: 0 }] },
      { match: "depeg_events", rows: [] },
    ]);
    const res = await handleDepegEvents(emptyDb, new URL("https://x/api/depeg-events"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number };
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
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [makeDepegRow({ ended_at: null })] },
    ]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?active=true"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    const dataQuery = db
      .getHistory()
      .find((entry) => entry.sql.includes("FROM depeg_events") && !entry.sql.includes("COUNT(*)"));
    expect(dataQuery?.sql).toContain("ended_at IS NULL");
  });

  it("rejects malformed active booleans instead of silently treating them as false", async () => {
    const res = await handleDepegEvents(mockD1([]), new URL("https://x/api/depeg-events?active=yes"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid active: must be true or false" });
  });

  it("excludes superseded rows from active DDR incident repairs", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=apxusd-apyx"));

    expect(res.status).toBe(200);
    const dataQuery = db
      .getHistory()
      .find((entry) => entry.sql.includes("FROM depeg_events") && !entry.sql.includes("COUNT(*)"));
    expect(dataQuery?.sql).toContain("depeg_resolver_incident_event_links");
    expect(dataQuery?.sql).toContain("links.event_id != incidents.current_event_id");
  });

  it("projects active DDR incidents from the first linked event start", async () => {
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
            first_start_price: 0.9893,
            first_peg_reference: 1,
            constituent_event_count: 4,
          },
        ],
      },
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "FROM depeg_events_with_provenance", rows: [currentRow] },
    ]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?stablecoin=apxusd-apyx"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(body.events[0]).toMatchObject({
      id: 90089,
      startedAt: 1_780_437_028,
      startPrice: 0.9893,
      pegReference: 1,
      constituentEventCount: 4,
    });
  });

  it("includes X-Data-Age header", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [row] },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("uses latest successful sync timestamp for freshness headers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "depeg_events", rows: [makeDepegRow({ started_at: now - 7 * 86400 })] },
      { match: "cron_runs", rows: [], first: { started_at: now - 45 } },
    ]);
    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events"));
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeLessThan(120);
  });

  it("rejects oversized limits instead of coercing them", async () => {
    const res = await handleDepegEvents(mockD1([]), new URL("https://x/api/depeg-events?limit=1001"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 1 and 1000" });
  });

  it("rejects offsets above the endpoint cap", async () => {
    const res = await handleDepegEvents(mockD1([]), new URL("https://x/api/depeg-events?offset=50001"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid offset: must be between 0 and 50000" });
  });

  it("can skip the exact total count for cursor-style callers", async () => {
    const db = mockD1([
      { match: "depeg_events", rows: [row] },
    ]) as MockD1Database;

    const res = await handleDepegEvents(db, new URL("https://x/api/depeg-events?includeTotal=false"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number; totalExact: boolean };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.totalExact).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("COUNT(*) as total"))).toBe(false);
  });

  it("omits incident and crossing counts when the exact total is skipped", async () => {
    const db = mockD1([
      { match: "depeg_events", rows: [row] },
    ]) as MockD1Database;

    const res = await handleDepegEvents(
      db,
      new URL("https://x/api/depeg-events?stablecoin=usdt-tether&includeTotal=false"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("counts");
    expect(db.getHistory().some((entry) => entry.sql.includes("threshold-crossing-count"))).toBe(false);
  });

  it("emits and accepts a keyset cursor", async () => {
    const first = makeDepegRow({ id: 3, started_at: 1_700_000_003 });
    const second = makeDepegRow({ id: 2, started_at: 1_700_000_002 });
    const db = mockD1([
      { match: "depeg_events", rows: [first, second] },
    ]) as MockD1Database;

    const firstRes = await handleDepegEvents(db, new URL("https://x/api/depeg-events?limit=1&includeTotal=false"));
    const firstBody = (await firstRes.json()) as { events: unknown[]; nextCursor: string | null };
    expect(firstBody.events).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTypeOf("string");

    const cursorDb = mockD1([
      { match: "depeg_events", rows: [second] },
    ]) as MockD1Database;
    const cursorRes = await handleDepegEvents(
      cursorDb,
      new URL(`https://x/api/depeg-events?limit=1&includeTotal=false&cursor=${firstBody.nextCursor}`),
    );

    expect(cursorRes.status).toBe(200);
    const dataQuery = cursorDb.getHistory().find((entry) => entry.sql.includes("FROM depeg_events"));
    expect(dataQuery?.sql).toContain("started_at < ?");
    expect(dataQuery?.sql).toContain("id < ?");
    expect(dataQuery?.binds).toContain(first.started_at);
    expect(dataQuery?.binds).toContain(first.id);
  });

  it("can include schema-validated pending incidents with derivable confirmation categories", async () => {
    const nowSec = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSec * 1000));

    try {
      const db = mockD1([
        { match: "depeg_events", rows: [] },
        {
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
              source_pool_count: 2,
              source_total_tvl: 5_000_000,
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
        },
      ]);

      const res = await handleDepegEvents(
        db,
        new URL("https://x/api/depeg-events?includeTotal=false&includePending=true"),
      );

      expect(res.status).toBe(200);
      const body = DepegEventsResponseSchema.parse(await res.json());
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
          availableConfirmationCategories: ["offchain", "dex"],
          missingConfirmationCategories: ["pool"],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters pending incidents by readable stablecoin ID", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 0 }] },
      { match: "depeg_events", rows: [] },
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
    ]) as MockD1Database;

    const res = await handleDepegEvents(
      db,
      new URL("https://x/api/depeg-events?stablecoin=usdc-circle&includePending=true"),
    );

    expect(res.status).toBe(200);
    const body = DepegEventsResponseSchema.parse(await res.json());
    expect(body.pending?.map((pending) => pending.stablecoinId)).toEqual(["usdc-circle"]);
    const pendingQuery = db.getHistory().find((entry) => entry.sql.includes("FROM depeg_pending"));
    expect(pendingQuery?.binds).toEqual(["usdc-circle"]);
  });
});
