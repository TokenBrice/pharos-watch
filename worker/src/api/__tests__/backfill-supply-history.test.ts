import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { fetchHistoricalFxRates } from "../../lib/backfill-fx";

stubCryptoForAuth();

const evmRpcMocks = vi.hoisted(() => ({
  resolveClosestBlockAtOrBeforeTimestamp: vi.fn(),
}));

vi.mock("../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/evm-rpc")>();
  return {
    ...actual,
    resolveClosestBlockAtOrBeforeTimestamp: evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp,
  };
});

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

import { handleBackfillSupplyHistory } from "../backfill-supply-history";
import { fetchMarketBackfillPriceSeries } from "../backfill-price-sources";

vi.mock("../../lib/backfill-fx", async () => {
  const actual = await vi.importActual<typeof import("../../lib/backfill-fx")>("../../lib/backfill-fx");
  return {
    ...actual,
    fetchHistoricalFxRates: vi.fn(async () => ({})),
    fetchHistoricalSecondaryFxRates: vi.fn(async () => ({})),
  };
});

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
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockReset();
    vi.mocked(fetchMarketBackfillPriceSeries).mockClear().mockResolvedValue({
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
    });
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
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15", {
        adminKey: "secret",
      }),
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

  it("preserves unbounded history for bare backfill calls", async () => {
    const capturedStatements: Array<{ sql: string; args: unknown[] }> = [];
    const oldDay = Math.floor(Date.UTC(2020, 0, 1) / 1000);
    const recentDay = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          price: 1,
          tokens: [
            { date: oldDay, circulating: { peggedUSD: 10_000_000 } },
            { date: recentDay, circulating: { peggedUSD: 20_000_000 } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await handleBackfillSupplyHistory(
      makeDb(capturedStatements),
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdt-tether", {
        adminKey: "secret",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rowsInserted: number;
      done: boolean;
      continuationCursor: string | null;
      window: {
        startDay: number | null;
        endDay: number | null;
        requestedStartDay: number | null;
        requestedEndDay: number | null;
        windowDays: number | null;
      };
    };
    expect(body.rowsInserted).toBe(2);
    expect(body.done).toBe(true);
    expect(body.continuationCursor).toBeNull();
    expect(body.window).toEqual({
      startDay: null,
      endDay: null,
      requestedStartDay: null,
      requestedEndDay: null,
      windowDays: null,
    });

    const inserts = capturedStatements.filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts.map((stmt) => stmt.args[1])).toEqual([oldDay, recentDay]);
    expect(vi.mocked(fetchMarketBackfillPriceSeries).mock.calls[0]?.[2]?.range).toBeUndefined();
  });

  it("bounds explicit historical windows and returns a continuation cursor", async () => {
    const day1 = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    const day2 = day1 + 86_400;
    const day3 = day2 + 86_400;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          price: 1,
          tokens: [day1, day2, day3].map((date, index) => ({
            date,
            circulating: { peggedUSD: 100_000_000 + index },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const firstStatements: Array<{ sql: string; args: unknown[] }> = [];
    const firstUrl = "/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2026-01-01&endDay=2026-01-03&windowDays=2";
    const firstRes = await handleBackfillSupplyHistory(
      makeDb(firstStatements),
      makeApiUrl(firstUrl),
      true,
      makeApiRequest(firstUrl, { adminKey: "secret" }),
    );
    const firstBody = (await firstRes.json()) as {
      rowsInserted: number;
      done: boolean;
      continuationCursor: string | null;
      window: { startDay: number; endDay: number; windowDays: number };
    };

    expect(firstBody.rowsInserted).toBe(2);
    expect(firstBody.done).toBe(false);
    expect(firstBody.continuationCursor).toBeTypeOf("string");
    expect(firstBody.window).toMatchObject({ startDay: day1, endDay: day2, windowDays: 2 });

    const secondStatements: Array<{ sql: string; args: unknown[] }> = [];
    const secondUrl = `/api/backfill-supply-history?stablecoin=usdt-tether&cursor=${encodeURIComponent(firstBody.continuationCursor!)}`;
    const secondRes = await handleBackfillSupplyHistory(
      makeDb(secondStatements),
      makeApiUrl(secondUrl),
      true,
      makeApiRequest(secondUrl, { adminKey: "secret" }),
    );
    const secondBody = (await secondRes.json()) as {
      rowsInserted: number;
      done: boolean;
      continuationCursor: string | null;
      window: { startDay: number; endDay: number };
    };

    expect(secondBody.rowsInserted).toBe(1);
    expect(secondBody.done).toBe(true);
    expect(secondBody.continuationCursor).toBeNull();
    expect(secondBody.window).toMatchObject({ startDay: day3, endDay: day3 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("threads the request AbortSignal into supply backfill upstream helpers", async () => {
    const capturedStatements: Array<{ sql: string; args: unknown[] }> = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          price: 1,
          tokens: [{ date: 1_700_000_000, circulating: { peggedUSD: 125_000_000 } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const request = makeApiRequest(
      "/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15",
      { adminKey: "secret" },
    );

    const res = await handleBackfillSupplyHistory(
      makeDb(capturedStatements),
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15"),
      true,
      request,
    );

    expect(res.status).toBe(200);
    expect(fetchMarketBackfillPriceSeries).toHaveBeenCalledWith(
      expect.objectContaining({ id: "usdt-tether" }),
      expect.any(String),
      expect.objectContaining({
        signal: request.signal,
        range: {
          startSec: Math.floor(Date.UTC(2023, 10, 14) / 1000),
          endSec: Math.floor(Date.UTC(2023, 10, 16) / 1000) - 1,
        },
      }),
    );
  });

  it("uses fiat FX history for a non-USD DefiLlama coin without CoinGecko history", async () => {
    const capturedStatements: Array<{ sql: string; args: unknown[] }> = [];
    const day1 = 1_700_006_400;
    const day2 = 1_700_092_800;

    vi.mocked(fetchHistoricalFxRates).mockResolvedValue({
      EUR: [
        { timestamp: Math.floor(day1 / 86400) * 86400, rate: 1.1 },
        { timestamp: Math.floor(day2 / 86400) * 86400, rate: 1.2 },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          price: 1,
          tokens: [
            {
              date: day1,
              circulating: { peggedEUR: 1_000_000 },
            },
            {
              date: day2,
              circulating: { peggedEUR: 2_000_000 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await handleBackfillSupplyHistory(
      makeDb(capturedStatements),
      makeApiUrl("/api/backfill-supply-history?stablecoin=euro3-3a-dao&startDay=2023-11-14&endDay=2023-11-16"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=euro3-3a-dao&startDay=2023-11-14&endDay=2023-11-16", {
        adminKey: "secret",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();

    const inserts = capturedStatements.filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].args).toEqual([
      "euro3-3a-dao",
      Math.floor(day1 / 86400) * 86400,
      1_100_000,
      1.1,
    ]);
    expect(inserts[1].args).toEqual([
      "euro3-3a-dao",
      Math.floor(day2 / 86400) * 86400,
      2_400_000,
      1.2,
    ]);
    expect(fetchHistoricalFxRates).toHaveBeenCalledWith(
      ["EUR"],
      new Date(day1 * 1000).toISOString().slice(0, 10),
      new Date(day2 * 1000).toISOString().slice(0, 10),
      expect.any(AbortSignal),
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
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdat-saturn&startDay=2026-04-09&endDay=2026-04-10"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdat-saturn&startDay=2026-04-09&endDay=2026-04-10", {
        adminKey: "secret",
      }),
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

  it("backfills USG historical supply after subtracting PegKeeper balances", async () => {
    const capturedStatements: Array<{ sql: string; args: unknown[] }> = [];
    const snapshotDate = Math.floor(Date.UTC(2026, 4, 9) / 1000);
    const blockNumber = 24_500_000;
    const totalSupplyRaw = 40_020_000n * 10n ** 18n;
    const keeperOneRaw = 19_686_793n * 10n ** 18n;
    const keeperTwoRaw = 19_780_590n * 10n ** 18n;
    const keeperOneCall = encodeBalanceOfCallData("0xf89615f75c8161dc185c03020240905f6b66bad9");
    const keeperTwoCall = encodeBalanceOfCallData("0x8a7f16508d1e8b48bdf36023f378cc04d9506d4e");

    const uint256Hex = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockResolvedValue(blockNumber);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: Array<{ data?: string } | string>;
      };
      if (body.method !== "eth_call") {
        throw new Error(`Unexpected RPC method: ${body.method}`);
      }
      const call = body.params?.[0];
      const data = typeof call === "object" && call != null ? call.data?.toLowerCase() : undefined;
      if (data === TOTAL_SUPPLY_SELECTOR) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: uint256Hex(totalSupplyRaw) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (data === keeperOneCall.toLowerCase()) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: uint256Hex(keeperOneRaw) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (data === keeperTwoCall.toLowerCase()) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: uint256Hex(keeperTwoRaw) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected eth_call data: ${data}`);
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
      makeApiUrl("/api/backfill-supply-history?stablecoin=usg-tangent&startDay=2026-05-09&endDay=2026-05-09"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usg-tangent&startDay=2026-05-09&endDay=2026-05-09", {
        adminKey: "secret",
      }),
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
    expect(body.rowsInserted).toBe(1);
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();

    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).toHaveBeenCalledWith(
      "ethereum",
      snapshotDate + 86_400 - 1,
      expect.any(Object),
      expect.objectContaining({ chainRpcs }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const insert = capturedStatements.find((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(insert?.args).toEqual([
      "usg-tangent",
      snapshotDate,
      552_617,
      null,
    ]);
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
      makeApiUrl("/api/backfill-supply-history?stablecoin=usdat-saturn&startDay=2026-04-09&endDay=2026-04-09"),
      true,
      makeApiRequest("/api/backfill-supply-history?stablecoin=usdat-saturn&startDay=2026-04-09&endDay=2026-04-09", {
        adminKey: "secret",
      }),
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
