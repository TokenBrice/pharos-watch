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

import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
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

  describe("pool challenger status classification", () => {
    // Inline captureLogs equivalent: collect console.log output into an array so
    // tests can assert on the "[depeg-confirm] ... pool summary: ... status=..."
    // log line emitted by the pool-challenger loop.
    function captureLogs(): string[] {
      const logs: string[] = [];
      vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
      return logs;
    }

    function findStructuredLog(logs: string[], event: string): Record<string, unknown> | undefined {
      return logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record.event === event);
    }

    // Same wiring in all three: one pending USDT row plus one dex_prices row; only
    // the pool prices/TVL and the expected summary vary.
    it.each([
      {
        label: "reports poolStatus='contradict' when at least one qualifying pool is opposite-direction above bar",
        pendingId: 80,
        // Pool 1: same-direction (below) but deviation 30 bps < 50 bps secondary bar => "recover"
        // Pool 2: opposite-direction (above) deviation 120 bps > 50 bps bar          => "contradict"
        dexPriceUsd: 1.0, // neutral DEX signal -> "recover"
        sourcePoolCount: 4,
        sourceTotalTvl: 4_000_000,
        pools: [
          { price: 0.997, tvl: 5_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
          { price: 1.012, tvl: 5_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
        ],
        expectedStatus: "contradict",
        expectedHighTvl: false,
      },
      {
        label: "reports poolStatus='confirm' with highTvl=true when a single qualifying pool has TVL >= $5M",
        pendingId: 82,
        // Single pool, same-direction deviation 200bps > 50bps bar, TVL $6M > $5M high-TVL threshold.
        // Below POOL_CHALLENGE_CONFIRM_MIN=2 count, but high-TVL short-circuits to confirm.
        dexPriceUsd: 0.98,
        sourcePoolCount: 1,
        sourceTotalTvl: 6_000_000,
        pools: [
          { price: 0.98, tvl: 6_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
        ],
        expectedStatus: "confirm",
        expectedHighTvl: true,
      },
      {
        label: "reports poolStatus='recover' only when every qualifying pool is under the secondary bar",
        pendingId: 81,
        dexPriceUsd: 1.0,
        sourcePoolCount: 4,
        sourceTotalTvl: 4_000_000,
        pools: [
          { price: 0.998, tvl: 5_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
          { price: 0.999, tvl: 5_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
        ],
        expectedStatus: "recover",
        expectedHighTvl: false,
      },
    ])("$label", async (testCase) => {
      const nowSec = 1_700_000_000;
      vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
      const pendingRows: PendingRow[] = [makePendingRow({
        id: testCase.pendingId,
        stablecoin_id: "usdt-tether",
        symbol: "USDT",
        direction: "below",
        first_seen_bps: -200,
        first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
        first_price: 0.98,
        peg_reference: 1,
      })];
      const dexRows = [
        {
          stablecoin_id: "usdt-tether",
          dex_price_usd: testCase.dexPriceUsd,
          updated_at: nowSec - 30,
          source_pool_count: testCase.sourcePoolCount,
          source_total_tvl: testCase.sourceTotalTvl,
          price_sources_json: JSON.stringify(testCase.pools),
        },
      ];
      const logs = captureLogs();

      await confirmPendingDepegs(
        makeDb({ pendingRows, dexRows }),
        [
          makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: undefined, price: 0.98 }),
          ...makeNeutralUsdAssets(),
        ],
      );

      expect(findStructuredLog(logs, "pool-confirmation-summary")).toMatchObject({
        status: testCase.expectedStatus,
        metadata: { highTvlConfirmation: testCase.expectedHighTvl },
      });
    });
  });
});
