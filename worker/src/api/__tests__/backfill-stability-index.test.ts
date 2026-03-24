import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, stubCryptoForAuth } from "./helpers/auth";
import { handleBackfillStabilityIndex } from "../backfill-stability-index";

stubCryptoForAuth();

vi.mock("../../lib/stability-index", () => ({
  computeStabilityIndex: vi.fn(() => ({
    score: 73.2,
    band: "Stable",
    components: {
      severity: 10,
      breadth: 5,
      stressBreadth: 3,
      trend: 4,
    },
  })),
}));

function makeDb(options?: {
  earliest?: number | null;
  depegRows?: Array<{
    stablecoin_id: string;
    peak_deviation_bps: number;
    peg_reference: number;
    started_at: number;
    ended_at: number | null;
  }>;
  supplyRows?: Array<{
    stablecoin_id: string;
    snapshot_date: number;
    circulating_usd: number;
    price?: number | null;
  }>;
  stabilityRows?: Array<{
    computed_at: number;
    score: number;
    band: string;
    methodology_version: string | null;
  }>;
  onExec?: (sql: string) => void;
}): D1Database {
  const earliest = options?.earliest ?? null;
  const depegRows = options?.depegRows ?? [];
  const supplyRows = options?.supplyRows ?? [];
  const onExec = options?.onExec;
  const stabilityRows = options?.stabilityRows ?? [];

  const stmt = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async <T>() => {
        if (sql.includes("FROM depeg_events ORDER BY started_at")) {
          return { results: depegRows as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM supply_history ORDER BY snapshot_date")) {
          return { results: supplyRows as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM stress_signal_history ORDER BY snapshot_date")) {
          return { results: [] as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM stability_index WHERE computed_at >= ? AND computed_at <= ?")) {
          return { results: stabilityRows as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
      first: async <T>() => {
        if (sql.includes("MIN(started_at) as earliest")) {
          return { earliest } as T;
        }
        return null as T | null;
      },
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }),
    all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
    first: async <T>() => (sql.includes("MIN(started_at) as earliest")
      ? ({ earliest } as T)
      : null as T | null),
    run: async () => ({ success: true, meta: { changes: 1 } }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: D1PreparedStatement[]) => (
      stmts.map(() => ({ success: true, meta: { changes: 1 } }))
    ),
    exec: async (sql: string) => {
      onExec?.(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("handleBackfillStabilityIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T10:00:00Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires admin auth", async () => {
    const res = await handleBackfillStabilityIndex(
      makeDb(),
      undefined,
      makeApiRequest("/api/backfill-stability-index"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when there are no depeg events", async () => {
    const res = await handleBackfillStabilityIndex(
      makeDb({ earliest: null }),
      true,
      makeApiRequest("/api/backfill-stability-index", { adminKey: "secret" }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No depeg events found" });
  });

  it("rebuilds daily PSI rows and reports days backfilled", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - 2 * 86400;
    const day0 = Math.floor((nowSec - 7 * 86400) / 86400) * 86400;
    const day1 = Math.floor((nowSec - 86400) / 86400) * 86400;
    const day2 = Math.floor(nowSec / 86400) * 86400;

    const res = await handleBackfillStabilityIndex(
      makeDb({
        earliest: start,
        depegRows: [
          {
            stablecoin_id: "usdt-tether",
            peak_deviation_bps: -120,
            peg_reference: 1,
            started_at: start,
            ended_at: null,
          },
        ],
        supplyRows: [
          { stablecoin_id: "usdt-tether", snapshot_date: day0, circulating_usd: 99_000_000, price: 1 },
          { stablecoin_id: "usdt-tether", snapshot_date: day1, circulating_usd: 100_000_000, price: 0.9975 },
          { stablecoin_id: "usdt-tether", snapshot_date: day2, circulating_usd: 101_000_000, price: 0.999 },
        ],
      }),
      true,
      makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; daysBackfilled: number; endDay: number; daysEvaluated: number };
    expect(body.ok).toBe(true);
    expect(body.daysBackfilled).toBeGreaterThanOrEqual(2);
    expect(body.daysEvaluated).toBeGreaterThanOrEqual(body.daysBackfilled);
    expect(body.endDay).toBe(day1);
  });

  it("runs rebuild table DDL atomically via db.batch and cleans up via exec", async () => {
    const execCalls: string[] = [];
    const batchCalls: string[][] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - 86400;
    const day = Math.floor(nowSec / 86400) * 86400;

    const db = makeDb({
      earliest: start,
      depegRows: [
        {
          stablecoin_id: "usdt-tether",
          peak_deviation_bps: -120,
          peg_reference: 1,
          started_at: start,
          ended_at: null,
        },
      ],
        supplyRows: [
          { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000, price: 0.998 },
        ],
      onExec: (sql) => execCalls.push(sql),
    });

    // Track SQL for each prepared statement via a WeakMap
    const stmtSqlMap = new WeakMap<object, string>();
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const s = origPrepare(sql);
      stmtSqlMap.set(s, sql);
      return s;
    }) as typeof db.prepare;

    const origBatch = db.batch.bind(db);
    db.batch = (async (stmts: D1PreparedStatement[]) => {
      batchCalls.push(stmts.map((s) => stmtSqlMap.get(s as unknown as object) ?? "<unknown>"));
      return origBatch(stmts);
    }) as typeof db.batch;

    const res = await handleBackfillStabilityIndex(
      db,
      true,
      makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    // First batch should contain the DDL: DROP + CREATE (atomic)
    expect(batchCalls[0]).toEqual([
      "DROP TABLE IF EXISTS stability_index_rebuild",
      "CREATE TABLE stability_index_rebuild ( computed_at INTEGER PRIMARY KEY, score REAL NOT NULL, band TEXT NOT NULL, components TEXT NOT NULL, input_snapshot TEXT NOT NULL, methodology_version TEXT NOT NULL )",
    ]);
    // Cleanup exec still runs
    expect(execCalls).toEqual([
      "DROP TABLE IF EXISTS stability_index_rebuild",
    ]);
  });

  it("returns a no-op when there are no completed UTC days to rebuild yet", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayMidnight = Math.floor(nowSec / 86400) * 86400;
    const res = await handleBackfillStabilityIndex(
      makeDb({
        earliest: todayMidnight + 60,
      }),
      true,
      makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dryRun: false,
      daysBackfilled: 0,
      daysEvaluated: 0,
      daysChanged: 0,
      skippedInsufficientData: 0,
      maxAbsoluteScoreDelta: 0,
      startDay: todayMidnight,
      endDay: todayMidnight - 86400,
      reason: "no-completed-utc-days",
    });
  });

  it("supports dry-run previews with bounded date ranges and change summary", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const day1 = Math.floor((nowSec - 2 * 86400) / 86400) * 86400;
    const day2 = Math.floor((nowSec - 86400) / 86400) * 86400;

    const res = await handleBackfillStabilityIndex(
      makeDb({
        earliest: day1,
        depegRows: [
          {
            stablecoin_id: "usdt-tether",
            peak_deviation_bps: -120,
            peg_reference: 1,
            started_at: day1,
            ended_at: null,
          },
        ],
        supplyRows: [
          { stablecoin_id: "usdt-tether", snapshot_date: day1 - 7 * 86400, circulating_usd: 99_000_000, price: 1 },
          { stablecoin_id: "usdt-tether", snapshot_date: day1, circulating_usd: 100_000_000, price: 0.996 },
          { stablecoin_id: "usdt-tether", snapshot_date: day2, circulating_usd: 101_000_000, price: 0.999 },
        ],
        stabilityRows: [
          { computed_at: day1, score: 99.9, band: "BEDROCK", methodology_version: "2.1" },
        ],
      } as Parameters<typeof makeDb>[0]),
      true,
      makeApiRequest(`/api/backfill-stability-index?dry-run=true&startDay=${day1}&endDay=${day1}`, {
        method: "POST",
        adminKey: "secret",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      dryRun: true,
      daysBackfilled: 1,
      daysEvaluated: 1,
      daysChanged: 1,
      skippedInsufficientData: 0,
      startDay: day1,
      endDay: day1,
    });
  });

  it("rejects invalid day parameters", async () => {
    const res = await handleBackfillStabilityIndex(
      makeDb({ earliest: 1 }),
      true,
      makeApiRequest("/api/backfill-stability-index?startDay=not-a-day", {
        method: "POST",
        adminKey: "secret",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid startDay/endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.",
    });
  });
});
