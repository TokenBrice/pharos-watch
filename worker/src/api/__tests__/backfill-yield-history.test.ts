import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillYieldHistory } from "../backfill-yield-history";
import type { ResolvedYield } from "../../cron/yield-sync/types";

stubCryptoForAuth();

const mockSource: ResolvedYield = {
  currentApy: 4.5,
  apyBase: 4.5,
  apyReward: null,
  sourcePool: null,
  sourceTvlUsd: null,
  dataSource: "protocol-api",
  exchangeRate: null,
  sourceKey: "protocol-api:zys-zephyr-protocol",
  yieldSource: "Zephyr Scanner ZYS returns",
  yieldType: "nav-appreciation",
  sourceObservedAt: 1_730_000_000,
  comparisonAnchorObservedAt: null,
};

vi.mock("../../lib/yield-source-adapters/zephyr", () => ({
  fetchZephyrZysSource: vi.fn(async () => mockSource),
}));

import { fetchZephyrZysSource } from "../../lib/yield-source-adapters/zephyr";

function makeDb(capturedStatements: Array<{ sql: string; args: unknown[] }> = []): D1Database {
  const stmt = (_sql: string) => ({
    bind: (...args: unknown[]) => {
      capturedStatements.push({ sql: _sql, args });
      return {
        all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
        first: async <T>() => null as T | null,
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
    },
    all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
    first: async <T>() => null as T | null,
    run: async () => ({ success: true, meta: { changes: 1 } }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: D1PreparedStatement[]) => (
      stmts.map(() => ({ success: true, meta: { changes: 1 } }))
    ),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("handleBackfillYieldHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires admin auth", async () => {
    const res = await handleBackfillYieldHistory({ db: makeDb(), url: makeApiUrl("/api/backfill-yield-history"), request: makeApiRequest("/api/backfill-yield-history") });

    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillYieldHistory({ db: makeDb(), url: makeApiUrl("/api/backfill-yield-history?stablecoin=not-a-real-id"), trustedAdmin: true, request: makeApiRequest("/api/backfill-yield-history?stablecoin=not-a-real-id", { adminKey: "secret" }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillYieldHistory({ db: makeDb(), url: makeApiUrl("/api/backfill-yield-history?batch=999999&batchSize=100"), trustedAdmin: true, request: makeApiRequest("/api/backfill-yield-history?batch=999999&batchSize=100", { adminKey: "secret" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });

  it("inserts Zephyr yield history row", async () => {
    const capturedStatements: Array<{ sql: string; args: unknown[] }> = [];

    const res = await handleBackfillYieldHistory({ db: makeDb(capturedStatements), url: makeApiUrl("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol"), trustedAdmin: true, request: makeApiRequest("/api/backfill-yield-history?stablecoin=zys-zephyr-protocol", { adminKey: "secret" }) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coinsProcessed: number;
      rowsInserted: number;
      coinResults: Array<{ id: string; symbol: string; inserted: boolean }>;
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(1);
    expect(body.coinResults[0]).toEqual({ id: "zys-zephyr-protocol", symbol: "ZYS", inserted: true });

    const insertStmt = capturedStatements.find((stmt) =>
      stmt.sql.includes("INSERT OR IGNORE INTO yield_history"),
    );
    expect(insertStmt?.args).toEqual([
      "zys-zephyr-protocol",
      "protocol-api:zys-zephyr-protocol",
      1_730_000_000,
      4.5,
      4.5,
      null,
      null,
      "protocol-api-backfill",
      1,
      "[]",
    ]);

    expect(fetchZephyrZysSource).toHaveBeenCalledTimes(1);
  });
});
