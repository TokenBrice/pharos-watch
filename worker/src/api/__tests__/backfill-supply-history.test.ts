import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleBackfillSupplyHistory } from "../backfill-supply-history";
import type { ChainRpcConfig } from "../../lib/chain-registry";

stubCryptoForAuth();

vi.mock("../backfill-price-sources", () => ({
  fetchMarketBackfillPriceSeries: vi.fn(async () => ({
    prices: [{ timestamp: 1_700_000_000, price: 1.001 }],
    diagnostics: {
      granularity: "daily",
      sourcesUsed: ["coingecko"],
      quoteMode: "usd",
      quoteCurrency: "usd",
      mergeReasons: [],
      perSourceStats: [],
      policyAdjustments: [],
      finalPointCount: 1,
    },
  })),
}));

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

describe("handleBackfillSupplyHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires admin auth", async () => {
    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history"),
      undefined,
      makeApiRequest("/api/backfill-supply-history"),
    );

    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown stablecoin", async () => {
    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history?stablecoin=not-a-real-id"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=not-a-real-id", { adminKey: "secret" }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Stablecoin not found" });
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history?batch=999999&batchSize=100"),
      true,
      makeApiRequest("/api/backfill-supply-history?batch=999999&batchSize=100", { adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "No coins in this batch" });
  });

  it("inserts rows for a valid USD stablecoin detail payload", async () => {
    const capturedStatements: Array<{ sql: string; args: unknown[] }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          price: 1,
          tokens: [
            {
              date: 1_700_000_000,
              circulating: { peggedUSD: 125_000_000 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await handleBackfillSupplyHistory(
      makeDb(capturedStatements),
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdt-tether", { adminKey: "secret" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(1);
    expect(body.errors).toBeUndefined();
    const insertStmt = capturedStatements.find((stmt) => stmt.sql.includes("INSERT OR REPLACE INTO supply_history"));
    expect(insertStmt?.args).toEqual([
      "usdt-tether",
      Math.floor(1_700_000_000 / 86400) * 86400,
      125_000_000,
      1.001,
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/stablecoin/1"),
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": expect.any(String) }),
      }),
    );
  });

  it("falls back to on-chain totalSupply when CoinGecko market caps are all zero", async () => {
    // Simulates a brand-new CG-only coin: CoinGecko returns valid prices but market_caps=0
    // and circulating_supply=0 (upstream data not yet populated). Backfill should probe
    // on-chain totalSupply and compute mcap = supply × price for each CG price point.
    const capturedStatements: Array<{ sql: string; args: unknown[] }> = [];

    const ts1 = 1_775_692_800_000; // CG returns ms timestamps
    const ts2 = 1_775_779_200_000; // +1 day
    const onChainRawSupply = 1_000_000_000_000n; // 1,000,000 tokens at 6 decimals
    const rawHex = `0x${onChainRawSupply.toString(16).padStart(64, "0")}`;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/saturn-dollar/market_chart")) {
        return new Response(
          JSON.stringify({
            market_caps: [[ts1, 0], [ts2, 0]],
            prices: [[ts1, 1.0002], [ts2, 1.0011]],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/saturn-dollar?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("fake-eth-rpc")) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: rawHex }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const chainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://fake-eth-rpc.test",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);

    const res = await handleBackfillSupplyHistory(
      makeDb(capturedStatements),
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdat-saturn"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdat-saturn", { adminKey: "secret" }),
      null,
      chainRpcs,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
      skipped?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();

    const inserts = capturedStatements.filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(2);
    // 1,000,000 tokens × $1.0002 ≈ 1,000,200
    expect(inserts[0].args[0]).toBe("usdat-saturn");
    expect(inserts[0].args[2] as number).toBeCloseTo(1_000_200, -1);
    expect(inserts[0].args[3] as number).toBeCloseTo(1.0002, 4);
    expect(inserts[1].args[2] as number).toBeCloseTo(1_001_100, -1);
  });

  it("returns a clear error when CG market caps are all zero and on-chain fallback is unavailable", async () => {
    const ts1 = 1_775_692_800_000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/saturn-dollar/market_chart")) {
        return new Response(
          JSON.stringify({ market_caps: [[ts1, 0]], prices: [[ts1, 1.0]] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/saturn-dollar?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const res = await handleBackfillSupplyHistory(
      makeDb(),
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdat-saturn"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdat-saturn", { adminKey: "secret" }),
      null,
      undefined, // no chainRpcs → no on-chain fallback
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("CoinGecko market caps all zero");
  });
});
