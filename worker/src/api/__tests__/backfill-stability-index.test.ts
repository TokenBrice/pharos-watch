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
  }>;
  onExec?: (sql: string) => void;
}): D1Database {
  const earliest = options?.earliest ?? null;
  const depegRows = options?.depegRows ?? [];
  const supplyRows = options?.supplyRows ?? [];
  const onExec = options?.onExec;

  const stmt = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async <T>() => {
        if (sql.includes("FROM depeg_events ORDER BY started_at")) {
          return { results: depegRows as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM supply_history ORDER BY snapshot_date")) {
          return { results: supplyRows as T[], success: true, meta: {} };
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
          { stablecoin_id: "usdt-tether", snapshot_date: day0, circulating_usd: 99_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: day1, circulating_usd: 100_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: day2, circulating_usd: 101_000_000 },
        ],
      }),
      true,
      makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; daysBackfilled: number };
    expect(body.ok).toBe(true);
    expect(body.daysBackfilled).toBeGreaterThanOrEqual(2);
  });

  it("runs rebuild table DDL as separate exec statements", async () => {
    const execCalls: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - 86400;
    const day = Math.floor(nowSec / 86400) * 86400;

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
          { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000 },
        ],
        onExec: (sql) => execCalls.push(sql),
      }),
      true,
      makeApiRequest("/api/backfill-stability-index", { method: "POST", adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    expect(execCalls).toEqual([
      "DROP TABLE IF EXISTS stability_index_rebuild",
      "CREATE TABLE stability_index_rebuild ( computed_at INTEGER PRIMARY KEY, score REAL NOT NULL, band TEXT NOT NULL, components TEXT NOT NULL, input_snapshot TEXT NOT NULL, methodology_version TEXT NOT NULL )",
      "DROP TABLE IF EXISTS stability_index_rebuild",
    ]);
  });
});
