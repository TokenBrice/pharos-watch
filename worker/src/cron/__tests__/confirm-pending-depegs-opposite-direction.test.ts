import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/db", () => ({
  batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
  isMissingTableError: (error: unknown) => String(error).toLowerCase().includes("no such table"),
  isMissingColumnError: (error: unknown) => String(error).toLowerCase().includes("no such column"),
}));

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: vi.fn(), notOkAsNull: true, passthroughNonResponse: true }));

vi.mock("../../lib/cex-tickers", () => {
  const fetchBinancePricesDetailed = vi.fn(async () => ({
    kind: "no-data",
    value: {
      prices: new Map<string, number>(),
      diagnostics: [{
        source: "binance",
        stage: "primary",
        endpoint: "data-api.binance.vision/api/v3/ticker/price",
        status: 200,
        ok: true,
        success: false,
        matchedCount: 0,
      }],
    },
  }));
  return {
    createBinanceFetchSession: vi.fn(() => ({})),
    fetchBinancePricesDetailed,
    fetchBinancePricesForRun: vi.fn(async () => fetchBinancePricesDetailed()),
  };
});

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async () => undefined),
}));

vi.mock("../../lib/native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: vi.fn(async () => new Map()),
  normalizeSupportedPegCurrency: vi.fn((pegCurrency: string | null | undefined) => {
    if (!pegCurrency) return null;
    const normalized = pegCurrency.trim().toUpperCase();
    return ["ARS", "BRL", "EUR", "JPY", "NGN"].includes(normalized) ? normalized : null;
  }),
}));

import { batchExecute } from "../../lib/db";
import { fetchBinancePricesDetailed } from "../../lib/cex-tickers";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import { DEPEG_PENDING_MIN_AGE_SEC } from "../../lib/constants";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
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
  last_seen_bps: number | null;
  last_seen_at: number | null;
  last_price: number | null;
  peak_seen_bps: number | null;
  peak_price: number | null;
  peg_reference: number;
  reason?: string;
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
  const firstSeenAt = overrides.first_seen_at ?? 0;
  const firstSeenBps = overrides.first_seen_bps ?? -200;
  const firstPrice = overrides.first_price ?? 0.98;
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    first_seen_bps: firstSeenBps,
    first_seen_at: firstSeenAt,
    first_price: firstPrice,
    last_seen_bps: firstSeenBps,
    last_seen_at: firstSeenAt + DEPEG_PENDING_MIN_AGE_SEC,
    last_price: firstPrice,
    peak_seen_bps: null,
    peak_price: null,
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
  const emptyMeta = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };

  type FakeStatement = D1PreparedStatement & { sql: string; boundValues: unknown[] };

  function createStatement(sql: string, boundValues: unknown[] = []): FakeStatement {
    function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
      if (options?.columnNames) {
        const result: [string[], ...T[]] = [[], ...[] as T[]];
        return Promise.resolve(result);
      }
      return Promise.resolve([] as T[]);
    }

    return {
      sql,
      boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T = Record<string, unknown>>() => {
        if (sql.includes("FROM depeg_pending")) {
          return { results: (config.pendingRows ?? []) as T[], success: true, meta: emptyMeta };
        }
        if (sql.includes("FROM dex_prices")) {
          if (config.dexError != null) throw (config.dexError instanceof Error ? config.dexError : new Error(String(config.dexError)));
          const rows = sql.includes("price_sources_json")
            ? (config.dexRows ?? []).filter((row) => row.price_sources_json != null)
            : (config.dexRows ?? []);
          return { results: rows as T[], success: true, meta: emptyMeta };
        }
        if (sql.includes("FROM depeg_events")) {
          return { results: (config.openRows ?? []) as T[], success: true, meta: emptyMeta };
        }
        return { results: [] as T[], success: true, meta: emptyMeta };
      },
      first: async <T = Record<string, unknown>>(_colName?: string) => null as T | null,
      run: async <T = Record<string, unknown>>() => ({ results: [] as T[], success: true, meta: { ...emptyMeta, changes: 1 } }),
      raw,
    } satisfies FakeStatement;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async <T>(_statements: D1PreparedStatement[]) => [] as D1Result<T>[],
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => {
      throw new Error("withSession is not used by this fixture");
    },
    dump: async () => new ArrayBuffer(0),
  } satisfies D1Database;
}

describe("confirmPendingDepegs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(fetchCurrentNativePegQuotes).mockReset().mockResolvedValue(new Map());
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
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
        vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({ tether: { usd: 1.03, last_updated_at: nowSec - 30 } }), { status: 200 }));
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
          kind: "ok",
          value: {
            prices: new Map([["USDT", 1.03]]),
            diagnostics: [{
              source: "binance",
              stage: "primary",
              endpoint: "data-api.binance.vision/api/v3/ticker/price",
              status: 200,
              ok: true,
              success: true,
              matchedCount: 1,
            }],
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
              { price: 1.03, tvl: 1_500_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 1.001, tvl: 900_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
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
});
