import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { fetchHistoricalFxRates } from "../../lib/backfill-fx";
import { ethereumSupplyRpc, supplyRpcResponse } from "./backfill-supply-history.test-support";

type PsiEligibleCoin = (typeof import("@shared/lib/psi-eligible"))["PSI_ELIGIBLE_STABLECOINS"][number];

stubCryptoForAuth();

const evmRpcMocks = vi.hoisted(() => ({
  resolveClosestBlockAtOrBeforeTimestamp: vi.fn(),
}));
const psiEligibleMocks = vi.hoisted(() => ({
  stablecoins: [] as PsiEligibleCoin[],
  defaultStablecoins: [] as PsiEligibleCoin[],
  metaById: new Map<string, PsiEligibleCoin>(),
  defaultMetaEntries: [] as Array<[string, PsiEligibleCoin]>,
}));

vi.mock("@shared/lib/psi-eligible", async () => {
  // Vitest hoists this factory before static test imports are initialized.
  const { supplyMetadata } = await import("./backfill-supply-history.test-support");
  const fixtures = supplyMetadata();
  const { SHADOW_STABLECOINS } = await import("@shared/lib/shadow-stablecoins");
  // The ID resolver validates shadow membership at import time.
  fixtures.push(...SHADOW_STABLECOINS);
  psiEligibleMocks.stablecoins.push(...fixtures);
  for (const coin of fixtures) psiEligibleMocks.metaById.set(coin.id, coin);
  psiEligibleMocks.defaultStablecoins.push(...fixtures);
  psiEligibleMocks.defaultMetaEntries.push(...fixtures.map((coin): [string, PsiEligibleCoin] => [coin.id, coin]));
  return {
    PSI_ELIGIBLE_STABLECOINS: psiEligibleMocks.stablecoins,
    PSI_ELIGIBLE_META_BY_ID: psiEligibleMocks.metaById,
  };
});

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

import { handleBackfillSupplyHistoryTrusted } from "../backfill-supply-history";
import { fetchMarketBackfillPriceSeries } from "../backfill-price-sources";

vi.mock("../../lib/backfill-fx", async () => {
  const actual = await vi.importActual<typeof import("../../lib/backfill-fx")>("../../lib/backfill-fx");
  return {
    ...actual,
    fetchHistoricalFxRates: vi.fn(async () => ({})),
    fetchHistoricalSecondaryFxRates: vi.fn(async () => ({})),
  };
});

function formatUint256Hex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function useSingleDeploymentSparkSupplyFixture(): string {
  const source = psiEligibleMocks.defaultMetaEntries.find(([id]) => id === "susdt-spark")?.[1];
  if (!source) throw new Error("Missing susdt-spark source metadata for supply fallback fixture");

  const fixtureId = "fixture-spark-savings-usdt";
  const contracts = source.contracts?.filter((contract) => contract.chain === "ethereum") ?? [];
  if (contracts.length !== 1) {
    throw new Error(`Expected one Ethereum contract in Spark supply fallback fixture, got ${contracts.length}`);
  }
  const fixture = { ...source, id: fixtureId, contracts } as PsiEligibleCoin;
  psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, fixture);
  psiEligibleMocks.metaById.clear();
  psiEligibleMocks.metaById.set(fixtureId, fixture);
  return fixtureId;
}

function useMissingDecimalsHistoricalSupplyFixture(): string {
  const source = psiEligibleMocks.defaultMetaEntries.find(([id]) => id === "autousd-auto-finance")?.[1];
  if (!source) throw new Error("Missing autoUSD source metadata for decimals fixture");

  const fixtureId = source.id;
  const contracts = source.contracts?.filter((contract) => contract.chain === "ethereum") ?? [];
  const fixture = {
    ...source,
    contracts: contracts.map(({ chain, address }) => ({ chain, address })),
  } as unknown as PsiEligibleCoin;
  psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, fixture);
  psiEligibleMocks.metaById.clear();
  psiEligibleMocks.metaById.set(fixtureId, fixture);
  return fixtureId;
}

describe("handleBackfillSupplyHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    psiEligibleMocks.stablecoins.splice(
      0,
      psiEligibleMocks.stablecoins.length,
      ...psiEligibleMocks.defaultStablecoins,
    );
    psiEligibleMocks.metaById.clear();
    for (const [id, meta] of psiEligibleMocks.defaultMetaEntries) {
      psiEligibleMocks.metaById.set(id, meta);
    }
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockReset();
    vi.mocked(fetchHistoricalFxRates).mockClear().mockResolvedValue({});
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

  registerStablecoinParameterContract({
    name: "supply history backfill",
    path: "/api/backfill-supply-history",
    invoke: (db, url) => handleBackfillSupplyHistoryTrusted({ db, url, request: makeApiRequest(url.toString(), { adminKey: "secret" }) }),
    cases: [{ kind: "unknown", stablecoin: "not-a-real-id", error: "Stablecoin not found" }],
  });

  it("returns no-op response for out-of-range batches", async () => {
    const res = await handleBackfillSupplyHistoryTrusted({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-supply-history?batch=999999&batchSize=100"), request: makeApiRequest("/api/backfill-supply-history?batch=999999&batchSize=100", { adminKey: "secret" }) });

    expect(await readJsonResponse(res, 200)).toEqual({ message: "No coins in this batch" });
  });

  it("inserts rows for a valid USD stablecoin detail payload", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
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

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15", {
        adminKey: "secret",
      }) });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(1);
    expect(body.errors).toBeUndefined();
    const insertStmt = db.getHistory().find((stmt) => stmt.sql.includes("INSERT OR REPLACE INTO supply_history"));
    expect(insertStmt?.binds).toEqual([
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
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
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

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=usdt-tether", {
        adminKey: "secret",
      }) });

    const body = (await readJsonResponse(res, 200)) as {
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

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts.map((stmt) => stmt.binds[1])).toEqual([oldDay, recentDay]);
    expect(vi.mocked(fetchMarketBackfillPriceSeries).mock.calls[0]?.[2]?.range).toBeUndefined();
  });

  it.each([undefined, 1])("preserves cursor windows unless explicitly overridden to %s days", async (override) => {
    const day1 = Date.UTC(2026, 0, 1) / 1000;
    const days = Array.from({ length: 5 }, (_, index) => day1 + index * 86_400);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      price: 1,
      tokens: days.map((date) => ({ date, circulating: { peggedUSD: 100_000_000 } })),
    }));
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    let path = "/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2026-01-01&endDay=2026-01-05&windowDays=2";
    const widths: number[] = [];
    for (let page = 0; page < 5; page++) {
      const res = await handleBackfillSupplyHistoryTrusted({
        db, url: makeApiUrl(path), request: makeApiRequest(path, { adminKey: "secret" }),
      });
      const body = await readJsonResponse<{
        rowsInserted: number; done: boolean; continuationCursor: string | null;
        window: { windowDays: number };
      }>(res, 200);
      widths.push(body.rowsInserted);
      expect(body.window.windowDays).toBe(page === 0 ? 2 : override ?? 2);
      if (body.done) {
        expect(body.continuationCursor).toBeNull();
        break;
      }
      expect(body.continuationCursor).toBeTypeOf("string");
      path = `/api/backfill-supply-history?stablecoin=usdt-tether&cursor=${encodeURIComponent(body.continuationCursor!)}`;
      if (page === 0 && override != null) path += `&windowDays=${override}`;
    }
    expect(widths).toEqual(override === 1 ? [2, 1, 1, 1] : [2, 2, 1]);
    expect(db.getHistory().filter((stmt) => stmt.sql.includes("INSERT OR REPLACE INTO supply_history"))
      .map((stmt) => stmt.binds[1])).toEqual(days);
  });

  it("threads the request AbortSignal into supply backfill upstream helpers", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
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

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15"), request });

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
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
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

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=euro3-3a-dao&startDay=2023-11-14&endDay=2023-11-16"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=euro3-3a-dao&startDay=2023-11-14&endDay=2023-11-16", {
        adminKey: "secret",
      }) });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].binds).toEqual([
      "euro3-3a-dao",
      Math.floor(day1 / 86400) * 86400,
      1_100_000,
      1.1,
    ]);
    expect(inserts[1].binds).toEqual([
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

  it("does not clamp sparse non-USD price history outside its covered range", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const beforePriceRange = Math.floor(1_699_913_600 / 86400) * 86400;
    const afterPriceRange = Math.floor(1_700_086_400 / 86400) * 86400;

    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValue({
      prices: [{ timestamp: 1_700_000_000, price: 2.5 }],
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          price: 1,
          tokens: [
            {
              date: beforePriceRange,
              circulating: { peggedEUR: 1_000 },
            },
            {
              date: afterPriceRange,
              circulating: { peggedEUR: 2_000 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=eurc-circle&startDay=2023-11-13&endDay=2023-11-15"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=eurc-circle&startDay=2023-11-13&endDay=2023-11-15", {
        adminKey: "secret",
      }) });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors).toBeUndefined();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(0);
    expect(fetchMarketBackfillPriceSeries).toHaveBeenCalled();
    expect(fetchHistoricalFxRates).not.toHaveBeenCalled();
  });

  it("falls back to historical on-chain totalSupply when CoinGecko market caps are all zero", async () => {
    // Simulates a brand-new single-deployment CG-only coin: CoinGecko returns valid prices
    // but market_caps=0 and circulating_supply=0 (upstream data not yet populated).
    // Backfill should replay on-chain totalSupply per historical day and compute mcap = supply × price.
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const fixtureId = useSingleDeploymentSparkSupplyFixture();

    const ts1 = 1_775_692_800_000; // CG returns ms timestamps
    const ts2 = 1_775_779_200_000; // +1 day
    const blockNumber = 22_500_000;
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockImplementation(async (_chain, timestamp) =>
      timestamp < ts2 / 1000 ? blockNumber : blockNumber + 1);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/spark-savings-usdt/market_chart")) {
        return new Response(
          JSON.stringify({
            market_caps: [[ts1, 0], [ts2, 0]],
            prices: [[ts1, 1.0002], [ts2, 1.0011]],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/spark-savings-usdt?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("fake-eth-rpc")) {
        const requestBlock = JSON.parse(String(init?.body)).params[1] as string;
        return requestBlock === `0x${blockNumber.toString(16)}`
          ? supplyRpcResponse(init, blockNumber, { [TOTAL_SUPPLY_SELECTOR]: 1_000_000_000_000n })
          : supplyRpcResponse(init, blockNumber + 1, { [TOTAL_SUPPLY_SELECTOR]: 1_100_000_000_000n });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const chainRpcs = ethereumSupplyRpc();

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl(`/api/backfill-supply-history?stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-10`), request: makeApiRequest(`/api/backfill-supply-history?stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-10`, {
        adminKey: "secret",
      }), coingeckoApiKey: null, chainRpcs });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
      skipped?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(2);
    // 1,000,000 tokens × $1.0002 ≈ 1,000,200
    expect(inserts[0].binds[0]).toBe(fixtureId);
    expect(inserts[0].binds[2] as number).toBeCloseTo(1_000_200, -1);
    expect(inserts[0].binds[3] as number).toBeCloseTo(1.0002, 4);
    expect(inserts[1].binds[2] as number).toBeCloseTo(1_101_210, -1);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).toHaveBeenCalledTimes(2);
  });

  it("repairs partial CoinGecko market-cap gaps with historical on-chain totalSupply", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const fixtureId = useSingleDeploymentSparkSupplyFixture();

    const ts1 = 1_775_692_800_000;
    const ts2 = 1_775_779_200_000;
    const blockNumber = 22_500_001;

    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockResolvedValue(blockNumber);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/spark-savings-usdt/market_chart")) {
        return new Response(
          JSON.stringify({
            market_caps: [[ts1, 1_234_567], [ts2, 0]],
            prices: [[ts1, 1.0002], [ts2, 1.0011]],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/spark-savings-usdt?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("fake-eth-rpc")) {
        return supplyRpcResponse(init, blockNumber, { [TOTAL_SUPPLY_SELECTOR]: 1_100_000_000_000n });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const chainRpcs = ethereumSupplyRpc();

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl(`/api/backfill-supply-history?stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-10`), request: makeApiRequest(`/api/backfill-supply-history?stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-10`, {
        adminKey: "secret",
      }), coingeckoApiKey: null, chainRpcs });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
      skipped?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].binds).toEqual([fixtureId, Math.floor(ts1 / 1000 / 86_400) * 86_400, 1_234_567, 1.0002]);
    expect(inserts[1].binds[0]).toBe(fixtureId);
    expect(inserts[1].binds[1]).toBe(Math.floor(ts2 / 1000 / 86_400) * 86_400);
    expect(inserts[1].binds[2] as number).toBeCloseTo(1_101_210, -1);
    expect(inserts[1].binds[3] as number).toBeCloseTo(1.0011, 4);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of replaying one EVM lane for multi-deployment supply fallback", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);

    const ts = 1_775_692_800_000;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/apollo-diversified-credit-securitize-fund/market_chart")) {
        return new Response(
          JSON.stringify({
            market_caps: [[ts, 0]],
            prices: [[ts, 1.01]],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/apollo-diversified-credit-securitize-fund?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const chainRpcs = new Map<string, ChainRpcConfig>([
      [
        "avalanche",
        {
          chainId: "avalanche",
          chainName: "Avalanche",
          type: "evm",
          rpcUrl: "https://fake-avax-rpc.test",
          explorerUrl: "https://snowtrace.io",
        },
      ],
    ]);

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=acred-apollo-securitize&startDay=2026-04-09&endDay=2026-04-09"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=acred-apollo-securitize&startDay=2026-04-09&endDay=2026-04-09", {
        adminKey: "secret",
      }), coingeckoApiKey: null, chainRpcs });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("historical totalSupply backfill requires exactly one supported EVM contract");
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(0);
  });

  it("skips eEARN days when historical totalSupply has no USD price", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unpriced days must not fetch"));
    const chainRpcs = ethereumSupplyRpc();

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=eearn-ember&startDay=2026-06-09&endDay=2026-06-10"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=eearn-ember&startDay=2026-06-09&endDay=2026-06-10", {
        adminKey: "secret",
      }), coingeckoApiKey: null, chainRpcs });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
      skipped?: string[];
      skippedDays?: number;
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("historical totalSupply backfill wrote 0 rows");
    expect(body.skippedDays).toBe(2);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(0);
  });

  it("skips autoUSD days without a CoinGecko ID or historical price", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unpriced days must not fetch"));
    const chainRpcs = ethereumSupplyRpc();

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=autousd-auto-finance&startDay=2026-06-09&endDay=2026-06-10"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=autousd-auto-finance&startDay=2026-06-09&endDay=2026-06-10", {
        adminKey: "secret",
      }), coingeckoApiKey: null, chainRpcs });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
      skipped?: string[];
      skippedDays?: number;
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("historical totalSupply backfill wrote 0 rows");
    expect(body.skippedDays).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(0);
  });

  it("skips historical totalSupply when contract decimals are missing", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const fixtureId = useMissingDecimalsHistoricalSupplyFixture();
    const path = `/api/backfill-supply-history?stablecoin=${fixtureId}&startDay=2026-06-09&endDay=2026-06-09`;

    const res = await handleBackfillSupplyHistoryTrusted({
      db,
      url: makeApiUrl(path),
      request: makeApiRequest(path, { adminKey: "secret" }),
    });

    const body = (await readJsonResponse(res, 200)) as { rowsInserted: number; errors?: string[] };
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("requires contract decimals");
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
    expect(db.getHistory()).toHaveLength(0);
  });

  it("backfills USD-valued Base Dollar supply from historical totalSupply without a CoinGecko ID", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const actual = await vi.importActual<typeof import("@shared/lib/psi-eligible")>("@shared/lib/psi-eligible");
    const baseDollar = actual.PSI_ELIGIBLE_META_BY_ID.get("bd-basedollar")!;
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, baseDollar);
    psiEligibleMocks.metaById.set(baseDollar.id, baseDollar);
    expect(baseDollar).toMatchObject({
      detailProvider: "defillama",
      llamaId: "434",
    });
    expect(baseDollar?.geckoId).toBeUndefined();
    // The corrected DefiLlama identity must not disable this allowlisted on-chain
    // totalSupply fixture; no CoinGecko detail request is available for BD.

    const day1 = Math.floor(Date.UTC(2026, 7, 4) / 1000);
    const day2 = Math.floor(Date.UTC(2026, 7, 5) / 1000);
    const blockNumber = 49_507_741;
    const totalSupplyByCall = [
      2_500n * 10n ** 18n,
      2_750n * 10n ** 18n,
    ];

    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockResolvedValue(blockNumber);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("fake-base-rpc")) throw new Error(`Unexpected fetch: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: Array<{ data?: string } | string>;
      };
      expect(body.method).toBe("eth_call");
      const call = body.params?.[0];
      const data = typeof call === "object" && call != null ? call.data?.toLowerCase() : undefined;
      expect(data).toBe(TOTAL_SUPPLY_SELECTOR);
      const raw = totalSupplyByCall.shift();
      if (raw == null) throw new Error("Unexpected extra Base Dollar totalSupply call");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: formatUint256Hex(raw) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const chainRpcs = new Map<string, ChainRpcConfig>([
      [
        "base",
        {
          chainId: "base",
          chainName: "Base",
          type: "evm",
          rpcUrl: "https://fake-base-rpc.test",
          explorerUrl: "https://base.blockscout.com",
        },
      ],
    ]);

    const path = "/api/backfill-supply-history?stablecoin=bd-basedollar&startDay=2026-08-04&endDay=2026-08-05";
    const res = await handleBackfillSupplyHistoryTrusted({
      db,
      url: makeApiUrl(path),
      request: makeApiRequest(path, { adminKey: "secret" }),
      coingeckoApiKey: null,
      chainRpcs,
    });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
      skipped?: string[];
    };
    expect(body).toMatchObject({ coinsProcessed: 1, rowsInserted: 2 });
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts.map((stmt) => stmt.binds)).toEqual([
      ["bd-basedollar", day1, 2_500, 1],
      ["bd-basedollar", day2, 2_750, 1],
    ]);
    expect(fetchMarketBackfillPriceSeries).not.toHaveBeenCalled();
  });

  it("skips unpriced historical totalSupply days across a batch", async () => {
    const historicalTotalSupplyCoins = psiEligibleMocks.defaultStablecoins.filter((coin) =>
      ["autousd-auto-finance", "eearn-ember"].includes(coin.id),
    );
    expect(historicalTotalSupplyCoins.map((coin) => coin.id)).toEqual([
      "autousd-auto-finance",
      "eearn-ember",
    ]);
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, ...historicalTotalSupplyCoins);

    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unpriced days must not fetch"));
    const chainRpcs = ethereumSupplyRpc();

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?batch=0&batchSize=2&startDay=2026-06-09&endDay=2026-06-09"), request: makeApiRequest("/api/backfill-supply-history?batch=0&batchSize=2&startDay=2026-06-09&endDay=2026-06-09", {
        adminKey: "secret",
      }), coingeckoApiKey: null, chainRpcs });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
      skipped?: string[];
      skippedDays?: number;
    };
    expect(body.coinsProcessed).toBe(2);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.skippedDays).toBe(2);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(0);
  });

  it.each([null, 1.25])("replays USG exclusions only with a historical price (%s)", async (price) => {
    const day = Date.UTC(2026, 4, 9) / 1000;
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const blockNumber = 24_500_000;
    // Synthetic replay-price availability; the live USG catalog has no CoinGecko ID.
    const source = psiEligibleMocks.metaById.get("usg-tangent")!;
    const pricedFixture = { ...source, geckoId: "fixture-usg" };
    psiEligibleMocks.metaById.set(source.id, pricedFixture);
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, pricedFixture);
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce({
      diagnostics: {
        granularity: "daily", sourcesUsed: ["coingecko"], quoteMode: "usd", quoteCurrency: "usd",
        mergeReasons: [], perSourceStats: [], policyAdjustments: [], finalPointCount: price == null ? 0 : 1,
      },
      prices: price == null ? [] : [{ timestamp: day, price }],
    });
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockResolvedValue(blockNumber);
    const amounts = {
      [TOTAL_SUPPLY_SELECTOR]: 40_020_000n * 10n ** 18n,
      [encodeBalanceOfCallData("0xf89615f75c8161dc185c03020240905f6b66bad9").toLowerCase()]: 19_686_793n * 10n ** 18n,
      [encodeBalanceOfCallData("0x8a7f16508d1e8b48bdf36023f378cc04d9506d4e").toLowerCase()]: 19_780_590n * 10n ** 18n,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      supplyRpcResponse(init, blockNumber, amounts));
    const path = "/api/backfill-supply-history?stablecoin=usg-tangent&startDay=2026-05-09&endDay=2026-05-09";
    const res = await handleBackfillSupplyHistoryTrusted({
      db, url: makeApiUrl(path), request: makeApiRequest(path, { adminKey: "secret" }),
      coingeckoApiKey: null, chainRpcs: ethereumSupplyRpc(),
    });
    const body = await readJsonResponse<{ rowsInserted: number; skippedDays?: number; errors?: string[] }>(res, 200);
    const inserts = db.getHistory().filter((stmt) => stmt.sql.includes("INSERT OR REPLACE INTO supply_history"));
    if (price == null) {
      expect(body.rowsInserted).toBe(0);
      expect(body.skippedDays).toBe(1);
      expect(body.errors?.[0]).toContain("historical on-chain supply backfill wrote 0 rows");
      expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
    } else {
      expect(body.rowsInserted).toBe(1);
      expect(body.errors).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(inserts.map((stmt) => stmt.binds)).toEqual([["usg-tangent", day, 690_771.25, 1.25]]);
    }
  });

  it("returns a clear error when CG market caps are all zero and on-chain fallback is unavailable", async () => {
    const ts1 = 1_775_692_800_000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/spark-savings-usdt/market_chart")) {
        return new Response(
          JSON.stringify({ market_caps: [[ts1, 0]], prices: [[ts1, 1.0]] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/spark-savings-usdt?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const res = await handleBackfillSupplyHistoryTrusted({ db: mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]), url: makeApiUrl("/api/backfill-supply-history?stablecoin=susdt-spark&startDay=2026-04-09&endDay=2026-04-09"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=susdt-spark&startDay=2026-04-09&endDay=2026-04-09", {
        adminKey: "secret",
      }), coingeckoApiKey: null });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("CoinGecko market caps all zero");
  });

  it("does not extrapolate TVL fallback prices beyond the DefiLlama price chart range", async () => {
    const db = mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]);
    const day1 = Math.floor(Date.UTC(2026, 3, 9) / 1000);
    const day2 = day1 + 86_400;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/tether-gold/market_chart")) {
        return new Response(
          JSON.stringify({ market_caps: [], prices: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/tether-gold?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/protocol/tether-gold")) {
        return new Response(
          JSON.stringify({
            tvl: [
              { date: day1, totalLiquidityUSD: 100_000_000 },
              { date: day2, totalLiquidityUSD: 101_000_000 },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/chart/coingecko:tether-gold")) {
        return new Response(
          JSON.stringify({
            coins: {
              "coingecko:tether-gold": {
                prices: [{ timestamp: day1, price: 2_300 }],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl("/api/backfill-supply-history?stablecoin=xaut-tether&startDay=2026-04-09&endDay=2026-04-10"), request: makeApiRequest("/api/backfill-supply-history?stablecoin=xaut-tether&startDay=2026-04-09&endDay=2026-04-10", {
        adminKey: "secret",
      }) });

    const body = (await readJsonResponse(res, 200)) as {
      coinsProcessed: number;
      rowsInserted: number;
      errors?: string[];
    };
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();

    const inserts = db.getHistory().filter((stmt) =>
      stmt.sql.includes("INSERT OR REPLACE INTO supply_history"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].binds).toEqual(["xaut-tether", day1, 100_000_000, 2_300]);
    expect(inserts[1].binds).toEqual(["xaut-tether", day2, 101_000_000, null]);
  });

  it("consumes the parallel price response before returning a protocol fallback error", async () => {
    const priceResponse = new Response(JSON.stringify({ coins: {} }), {
      headers: { "Content-Type": "application/json" },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/coins/tether-gold/market_chart")) {
        return new Response(
          JSON.stringify({ market_caps: [], prices: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/coins/tether-gold?")) {
        return new Response(
          JSON.stringify({ market_data: { circulating_supply: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/protocol/tether-gold")) {
        return new Response(JSON.stringify({ tvl: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/chart/coingecko:tether-gold")) {
        return priceResponse;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const path = "/api/backfill-supply-history?stablecoin=xaut-tether&startDay=2026-04-09&endDay=2026-04-10";
    const res = await handleBackfillSupplyHistoryTrusted({ db: mockD1([{ match: "INSERT OR REPLACE INTO supply_history", rows: [] }]), url: makeApiUrl(path), request: makeApiRequest(path, { adminKey: "secret" }) });

    const body = (await readJsonResponse(res, 200)) as { errors?: string[] };
    expect(body.errors?.[0]).toContain("no TVL history");
    expect(priceResponse.bodyUsed).toBe(true);
  });
});
