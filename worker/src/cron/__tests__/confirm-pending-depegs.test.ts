import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", () => ({
  batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../lib/cex-tickers", () => ({
  fetchBinancePrices: vi.fn(async () => new Map<string, number>()),
  fetchBinancePricesDetailed: vi.fn(async () => ({
    prices: new Map<string, number>(),
    diagnostic: {
      source: "binance",
      stage: "primary",
      endpoint: "data-api.binance.vision/api/v3/ticker/price",
      status: 200,
      ok: true,
      success: false,
      matchedCount: 0,
    },
  })),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async () => undefined),
}));

vi.mock("../../lib/native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: vi.fn(async () => new Map()),
}));

import { batchExecute } from "../../lib/db";
import { fetchBinancePricesDetailed } from "../../lib/cex-tickers";
import { recordOutcomeSafe } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import {
  CIRCUIT_SOURCE,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
} from "../../lib/constants";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";
import { confirmPendingDepegs } from "../confirm-pending-depegs";

interface PendingRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  first_seen_bps: number;
  first_seen_at: number;
  first_price: number;
  last_seen_bps?: number | null;
  last_seen_at?: number | null;
  last_price?: number | null;
  peak_seen_bps?: number | null;
  peak_price?: number | null;
  peg_reference: number;
  reason?: "large-cap" | "low-confidence" | "extreme-move";
  updated_at?: number | null;
}

interface PreparedStatementWithMeta extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
}

interface OppositeDirectionCase {
  pendingRows: PendingRow[];
  dexRows?: Array<{
    stablecoin_id: string;
    dex_price_usd: number;
    updated_at: number;
    source_pool_count?: number;
    source_total_tvl?: number;
    deviation_from_primary_bps?: number | null;
    price_sources_json?: string;
  }>;
  assets: ReturnType<typeof makeAsset>[];
  expectedDeleteId?: number;
}

function makePendingRow(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    first_seen_bps: -200,
    first_seen_at: 0,
    first_price: 0.98,
    peg_reference: 1,
    ...overrides,
  };
}

function makeNeutralUsdAssets(count = 6) {
  return Array.from({ length: count }, (_, index) =>
    makeAsset({
      id: `neutral-usd-${index + 1}`,
      name: `Neutral USD ${index + 1}`,
      symbol: `NUSD${index + 1}`,
      geckoId: undefined,
      price: 1,
    }),
  );
}

function makeAuthoritativeUsdAsset(
  nowSec: number,
  overrides: Parameters<typeof makeAsset>[0] = {},
) {
  return makeAsset({
    priceSource: "pyth",
    priceConfidence: "single-source",
    priceObservedAt: nowSec - 30,
    priceUpdatedAt: nowSec - 30,
    priceSyncedAt: nowSec - 30,
    consensusSources: ["pyth"],
    agreeSources: ["pyth"],
    ...overrides,
  });
}

function makeDb(config: {
  pendingRows?: PendingRow[];
  dexRows?: Array<{
    stablecoin_id: string;
    dex_price_usd: number;
    updated_at: number;
    source_pool_count?: number;
    source_total_tvl?: number;
    deviation_from_primary_bps?: number | null;
    price_sources_json?: string;
  }>;
  openRows?: Array<{ stablecoin_id: string }>;
  dexError?: unknown;
}): D1Database {
  function createStatement(sql: string, boundValues: unknown[] = []): PreparedStatementWithMeta {
    return {
      sql,
      boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => {
        if (sql.includes("FROM depeg_pending")) {
          return { results: (config.pendingRows ?? []) as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM dex_prices")) {
          if (config.dexError != null) throw (config.dexError instanceof Error ? config.dexError : new Error(String(config.dexError)));
          return { results: (config.dexRows ?? []) as T[], success: true, meta: {} };
        }
        if (sql.includes("FROM depeg_events")) {
          return { results: (config.openRows ?? []) as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
      first: async <T>() => null as T | null,
      run: async () => ({ success: true, meta: { changes: 1 } }),
    } as unknown as PreparedStatementWithMeta;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("confirmPendingDepegs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(fetchCurrentNativePegQuotes).mockReset().mockResolvedValue(new Map());
  });

  it("returns early when there are no pending rows", async () => {
    await confirmPendingDepegs(makeDb({ pendingRows: [] }), []);

    expect(batchExecute).not.toHaveBeenCalled();
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
  });

  it("cleans invalid, duplicate, recovered, young, and expired pending rows correctly", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({ id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_reference: 0 }),
          makePendingRow({ id: 2, stablecoin_id: "usdc-circle", symbol: "USDC" }),
          makePendingRow({
            id: 3,
            stablecoin_id: "usde-ethena",
            symbol: "USDe",
            first_seen_bps: -150,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
          }),
          makePendingRow({
            id: 4,
            stablecoin_id: "usds-sky",
            symbol: "USDS",
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC + 60,
          }),
          makePendingRow({
            id: 5,
            stablecoin_id: "cusd-cap",
            symbol: "CUSD",
            first_seen_at: nowSec - DEPEG_PENDING_EXPIRY_SEC - 60,
          }),
        ],
        openRows: [{ stablecoin_id: "usdc-circle" }],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, { id: "usde-ethena", name: "USDe", symbol: "USDe", geckoId: "ethena-usde", price: 1.005 }),
        makeAsset({ id: "usds-sky", name: "USDS", symbol: "USDS", geckoId: "usds", price: 0.94 }),
        makeAsset({ id: "cusd-cap", name: "CUSD", symbol: "CUSD", geckoId: undefined, price: 0.93 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const deletes = (statements as PreparedStatementWithMeta[])
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);
    expect(deletes).toEqual([1, 2, 3, 5]);
  });

  it("clears BRZ pending rows when the direct BRL quote is back inside threshold", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
      ["brz-transfero", {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.995,
        updatedAt: nowSec - 60,
      }],
    ]));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 21,
            stablecoin_id: "brz-transfero",
            symbol: "BRZ",
            peg_type: "peggedREAL",
            direction: "above",
            first_seen_bps: 180,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.190587,
            peg_reference: 0.18765951,
          }),
        ],
      }),
      [
        makeAsset({
          id: "brz-transfero",
          name: "Brazilian Digital",
          symbol: "BRZ",
          geckoId: "brz",
          pegType: "peggedREAL",
          price: 0.190587,
          priceSource: "pyth",
          priceConfidence: "single-source",
          priceObservedAt: nowSec - 30,
          priceUpdatedAt: nowSec - 30,
          priceSyncedAt: nowSec - 30,
        }),
      ],
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const deletes = (statements as PreparedStatementWithMeta[])
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);
    expect(deletes).toEqual([21]);
  });

  it("promotes or rejects pending rows based on secondary-source agreement", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("tether")) {
        return new Response(JSON.stringify({ tether: { usd: 0.95 } }), { status: 200 });
      }
      if (url.includes("usd-coin")) {
        return null;
      }
      if (url.includes("ethena-usde")) {
        return new Response(JSON.stringify({ "ethena-usde": { usd: 1 } }), { status: 200 });
      }
      if (url.includes("usds")) {
        return new Response(JSON.stringify({ usds: { usd: 1 } }), { status: 200 });
      }
      return null;
    });

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 10,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            first_seen_bps: -250,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.975,
          }),
          makePendingRow({
            id: 11,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            first_seen_bps: -200,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.98,
          }),
          makePendingRow({
            id: 12,
            stablecoin_id: "usde-ethena",
            symbol: "USDe",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.978,
          }),
          makePendingRow({
            id: 13,
            stablecoin_id: "usds-sky",
            symbol: "USDS",
            first_seen_bps: -210,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.979,
          }),
          makePendingRow({
            id: 14,
            stablecoin_id: "mystery-coin",
            symbol: "MYST",
            first_seen_bps: -230,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.977,
          }),
        ],
        dexRows: [
          {
            stablecoin_id: "usdc-circle",
            dex_price_usd: 0.96,
            updated_at: nowSec - 30,
            source_pool_count: 4,
            source_total_tvl: 5_000_000,
          },
          {
            stablecoin_id: "usde-ethena",
            dex_price_usd: 1.001,
            updated_at: nowSec - 30,
            source_pool_count: 4,
            source_total_tvl: 5_000_000,
          },
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, { id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.95 }),
        makeAuthoritativeUsdAsset(nowSec, { id: "usdc-circle", symbol: "USDC", geckoId: "usd-coin", price: 0.94 }),
        makeAsset({ id: "usde-ethena", symbol: "USDe", geckoId: "ethena-usde", price: 0.93 }),
        makeAsset({ id: "usds-sky", symbol: "USDS", geckoId: "usds", price: 0.94 }),
        makeAsset({ id: "mystery-coin", name: "Mystery USD", symbol: "MYST", geckoId: undefined, price: 0.92 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).toHaveBeenCalledTimes(4);
    expect(fetchBinancePricesDetailed).toHaveBeenCalledTimes(1);
    expect(batchExecute).toHaveBeenCalledTimes(1);

    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    const deletes = prepared
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);

    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      "peggedUSD",
      "below",
      -500,
      nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      0.975,
      0.95,
      1,
    ]);
    expect(inserts[1]?.boundValues).toEqual([
      "usdc-circle",
      "USDC",
      "peggedUSD",
      "below",
      -600,
      nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      0.98,
      0.94,
      1,
    ]);
    expect(deletes).toEqual([10, 11, 12, 13]);
  });

  it.each([
    {
      label: "native quote",
      setup: async (nowSec: number): Promise<OppositeDirectionCase> => {
        vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
          ["brz-transfero", {
            stablecoinId: "brz-transfero",
            geckoId: "brz",
            pegCurrency: "BRL",
            price: 1.03,
            updatedAt: nowSec - 60,
          }],
        ]));
        return {
          pendingRows: [
            makePendingRow({
              id: 70,
              stablecoin_id: "brz-transfero",
              symbol: "BRZ",
              peg_type: "peggedREAL",
              direction: "below",
              first_seen_bps: -220,
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
              first_price: 0.1835,
              peg_reference: 0.18765951,
            }),
          ],
          assets: [
            makeAsset({
              id: "brz-transfero",
              name: "Brazilian Digital",
              symbol: "BRZ",
              geckoId: "brz",
              pegType: "peggedREAL",
              price: 0.1835,
            }),
            ...makeNeutralUsdAssets(),
          ],
          expectedDeleteId: 70,
        };
      },
    },
    {
      label: "off-chain quote",
      setup: async (nowSec: number): Promise<OppositeDirectionCase> => {
        vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({ tether: { usd: 1.03 } }), { status: 200 }));
        return {
          pendingRows: [
            makePendingRow({
              id: 71,
              stablecoin_id: "usdt-tether",
              symbol: "USDT",
              direction: "below",
              first_seen_bps: -220,
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
              first_price: 0.978,
            }),
          ],
          assets: [
            makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.978 }),
            ...makeNeutralUsdAssets(),
          ],
          expectedDeleteId: 71,
        };
      },
    },
    {
      label: "DEX quote",
      setup: async (nowSec: number): Promise<OppositeDirectionCase> => ({
        pendingRows: [
          makePendingRow({
            id: 72,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.978,
          }),
        ],
        dexRows: [
          {
            stablecoin_id: "usdt-tether",
            dex_price_usd: 1.03,
            updated_at: nowSec - 30,
            source_pool_count: 5,
            source_total_tvl: 5_000_000,
          },
        ],
        assets: [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: undefined, price: 0.978 }),
          ...makeNeutralUsdAssets(),
        ],
      }),
    },
    {
      label: "CEX quote",
      setup: async (nowSec: number): Promise<OppositeDirectionCase> => {
        vi.mocked(fetchBinancePricesDetailed).mockResolvedValueOnce({
          prices: new Map([["USDT", 1.03]]),
          diagnostic: {
            source: "binance",
            stage: "primary",
            endpoint: "data-api.binance.vision/api/v3/ticker/price",
            status: 200,
            ok: true,
            success: true,
            matchedCount: 1,
          },
        });
        return {
          pendingRows: [
            makePendingRow({
              id: 73,
              stablecoin_id: "usdt-tether",
              symbol: "USDT",
              direction: "below",
              first_seen_bps: -220,
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
              first_price: 0.978,
            }),
          ],
          assets: [
            makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: undefined, price: 0.978 }),
            ...makeNeutralUsdAssets(),
          ],
        };
      },
    },
    {
      label: "pool challenger",
      setup: async (nowSec: number): Promise<OppositeDirectionCase> => ({
        pendingRows: [
          makePendingRow({
            id: 74,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.978,
          }),
        ],
        dexRows: [
          {
            stablecoin_id: "usdt-tether",
            dex_price_usd: 1.0,
            updated_at: nowSec - 30,
            source_pool_count: 4,
            source_total_tvl: 4_000_000,
            price_sources_json: JSON.stringify([
              { price: 1.03, tvl: 1_500_000, protocol: "curve", chain: "ethereum" },
              { price: 1.001, tvl: 900_000, protocol: "uniswap", chain: "ethereum" },
            ]),
          },
        ],
        assets: [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: undefined, price: 0.978 }),
          ...makeNeutralUsdAssets(),
        ],
      }),
    },
  ])("does not promote opposite-direction corroboration from $label", async ({ setup }) => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { pendingRows, dexRows, assets, expectedDeleteId } = await setup(nowSec);

    await confirmPendingDepegs(
      makeDb({ pendingRows, dexRows }),
      assets,
    );

    const batchCalls = vi.mocked(batchExecute).mock.calls;
    const inserts = batchCalls.flatMap(([, statements]) =>
      (statements as PreparedStatementWithMeta[]).filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events")),
    );
    expect(inserts).toHaveLength(0);

    if (expectedDeleteId != null) {
      const deletes = batchCalls.flatMap(([, statements]) =>
        (statements as PreparedStatementWithMeta[])
          .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
          .map((stmt) => stmt.boundValues[0]),
      );
      expect(deletes).toContain(expectedDeleteId);
    }
  });

  it("uses DefiLlama as the off-chain confirmer when the primary price already comes from CoinGecko", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("coins.llama.fi/prices/current/coingecko:tether")) {
        return new Response(JSON.stringify({
          coins: {
            "coingecko:tether": { price: 0.95 },
          },
        }), { status: 200 });
      }
      if (url.includes("api.coingecko.com")) {
        throw new Error("should not query CoinGecko for CoinGecko-primary confirmation");
      }
      return null;
    });

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 31,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            first_seen_bps: -240,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.976,
            reason: "large-cap",
          }),
        ],
      }),
      [
        makeAsset({
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.95,
          priceSource: "coingecko",
          priceConfidence: "single-source",
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(fetchWithRetry).toHaveBeenCalledWith(
      expect.stringContaining("coins.llama.fi/prices/current/coingecko:tether"),
      expect.objectContaining({ headers: { "User-Agent": "Pharos/1.0 (stablecoin analytics)" } }),
      1,
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    const deletes = prepared
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      "peggedUSD",
      "below",
      -240,
      nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      0.976,
      0.976,
      1,
    ]);
    expect(deletes).toEqual([31]);
  });

  it("promotes a refreshed pending row using stored peak state", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({ tether: { usd: 0.95 } }), { status: 200 }));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 32,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -200,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.98,
            last_seen_bps: -260,
            last_seen_at: nowSec - 60,
            last_price: 0.974,
            peak_seen_bps: -400,
            peak_price: 0.96,
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, { id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.97 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    const insert = prepared.find((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    expect(insert?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      "peggedUSD",
      "below",
      -400,
      nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      0.98,
      0.96,
      1,
    ]);
  });

  it("does not promote a low-confidence pending event on circular off-chain agreement alone", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    // DL→CG returns a price that "agrees" with the depeg — but it's the same
    // underlying CoinGecko source, so the agreement is circular.
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("coins.llama.fi/prices/current/coingecko:kinesis-gold")) {
        return new Response(JSON.stringify({
          coins: { "coingecko:kinesis-gold": { price: 133.81 } },
        }), { status: 200 });
      }
      return null;
    });

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 50,
            stablecoin_id: "kau-kinesis",
            symbol: "KAU",
            peg_type: "peggedGOLD",
            first_seen_bps: -225,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 133.81,
            peg_reference: 136.77,
            reason: "low-confidence",
          }),
        ],
        // No DEX data — KAU has zero on-chain liquidity
      }),
      [
        makeAsset({
          id: "kau-kinesis",
          name: "Kinesis Gold",
          symbol: "KAU",
          geckoId: "kinesis-gold",
          price: 133.81,
          priceSource: "coingecko+defillama-list",
          priceConfidence: "single-source",
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    // Off-chain (DL→CG) agrees, but with reason "low-confidence" this is
    // circular — the event should NOT be promoted without a hard source.
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("does not let a thin DEX row promote a pending event without CoinGecko support", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.mocked(fetchWithRetry).mockResolvedValue(null);

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 21,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
          }),
        ],
        dexRows: [
          {
            stablecoin_id: "usdt-tether",
            dex_price_usd: 0.96,
            updated_at: nowSec - 30,
            source_pool_count: 1,
            source_total_tvl: 250_000,
          },
        ],
      }),
      [
        makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.94 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("handles a missing dex_prices table without failing the run", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockResolvedValue(null);

    await expect(
      confirmPendingDepegs(
        makeDb({
          pendingRows: [
            makePendingRow({
              id: 20,
              stablecoin_id: "usdt-tether",
              symbol: "USDT",
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            }),
          ],
          dexError: new Error("no such table: dex_prices"),
        }),
        [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.94 }),
          ...makeNeutralUsdAssets(),
        ],
      ),
    ).resolves.toMatchObject({ providerDiagnostics: expect.any(Array) });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("records a successful Binance probe outcome when CEX confirmation data is available", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.mocked(fetchBinancePricesDetailed).mockResolvedValueOnce({
      prices: new Map([["USDTUSDC", 0.9998]]),
      diagnostic: {
        source: "binance",
        stage: "primary",
        endpoint: "data-api.binance.vision/api/v3/ticker/price",
        status: 200,
        ok: true,
        success: true,
        matchedCount: 1,
      },
    });

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 22,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC + 60,
          }),
        ],
      }),
      [
        makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.94 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(recordOutcomeSafe).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.BINANCE_PRICES,
      true,
    );
  });

  it("surfaces unexpected dex_prices failures instead of treating them as absent data", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      confirmPendingDepegs(
        makeDb({
          pendingRows: [
            makePendingRow({
              id: 23,
              stablecoin_id: "usdt-tether",
              symbol: "USDT",
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            }),
          ],
          dexError: new Error("database is locked"),
        }),
        [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.94 }),
          ...makeNeutralUsdAssets(),
        ],
      ),
    ).rejects.toThrow("database is locked");

    expect(errorSpy).toHaveBeenCalledWith(
      "[depeg-helpers] Unexpected error loading dex_prices:",
      "database is locked",
    );
  });

  it("promotes a pending depeg when individual pool prices confirm the deviation", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    // CoinGecko returns ~$1 (disagrees with depeg)
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("dusd")) {
        return new Response(JSON.stringify({ "dusd-trinity": { usd: 1.0 } }), { status: 200 });
      }
      return null;
    });

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 40,
            stablecoin_id: "dusd-trinity",
            symbol: "dUSD",
            peg_type: "peggedUSD",
            first_seen_bps: -510,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.949,
            peg_reference: 1,
          }),
        ],
        // DEX aggregate shows ~$1 (misleading)
        dexRows: [
          {
            stablecoin_id: "dusd-trinity",
            dex_price_usd: 0.9988,
            updated_at: nowSec - 30,
            source_pool_count: 3,
            source_total_tvl: 3_290_000,
            // Individual pools show real depeg via price_sources_json
            price_sources_json: JSON.stringify([
              { price: 0.80, tvl: 500_000, protocol: "curve", chain: "ethereum" },
              { price: 0.95, tvl: 200_000, protocol: "uniswap", chain: "ethereum" },
              { price: 1.00, tvl: 50_000, protocol: "balancer", chain: "ethereum" },
            ]),
          },
        ],
      }),
      [
        makeAsset({
          id: "dusd-trinity",
          name: "dUSD",
          symbol: "dUSD",
          geckoId: "dusd-trinity",
          price: 0.949,
          priceSource: "pool-tvl-weighted",
          priceConfidence: "low",
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.boundValues?.[0]).toBe("dusd-trinity");
  });

  it("does not promote when individual pool prices do not confirm the deviation", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    // CoinGecko disagrees
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("tether")) {
        return new Response(JSON.stringify({ tether: { usd: 1.0 } }), { status: 200 });
      }
      return null;
    });

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 41,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            peg_type: "peggedUSD",
            first_seen_bps: -200,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.98,
            peg_reference: 1,
          }),
        ],
        dexRows: [
          {
            stablecoin_id: "usdt-tether",
            dex_price_usd: 1.0,
            updated_at: nowSec - 30,
            source_pool_count: 5,
            source_total_tvl: 50_000_000,
            // All pools near peg — should NOT confirm
            price_sources_json: JSON.stringify([
              { price: 1.001, tvl: 20_000_000, protocol: "uniswap", chain: "ethereum" },
              { price: 0.999, tvl: 15_000_000, protocol: "curve", chain: "ethereum" },
            ]),
          },
        ],
      }),
      [
        makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.98 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    // Off-chain (CG $1) disagrees, DEX aggregate ($1) disagrees, pools near peg
    // → rejected as false positive
    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    expect(inserts).toHaveLength(0);
  });

  it("rethrows abort-related failures from secondary fetches", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);

    const controller = new AbortController();
    vi.mocked(fetchWithRetry).mockImplementation(async () => {
      controller.abort(new Error("stop now"));
      throw new Error("network aborted");
    });

    await expect(
      confirmPendingDepegs(
        makeDb({
          pendingRows: [
            makePendingRow({
              id: 30,
              stablecoin_id: "usdt-tether",
              symbol: "USDT",
              first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            }),
          ],
        }),
        [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.94 }),
          ...makeNeutralUsdAssets(),
        ],
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("network aborted");

    expect(batchExecute).not.toHaveBeenCalled();
  });
});
