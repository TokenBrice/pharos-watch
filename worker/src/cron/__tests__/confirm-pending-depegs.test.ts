import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/db", () => ({
  executeAtomicBatch: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
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

import { executeAtomicBatch as batchExecute } from "../../lib/db";
import { fetchBinancePricesDetailed } from "../../lib/cex-tickers";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import {
  CIRCUIT_SOURCE,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
} from "../../lib/constants";
import { normalizePendingDepegRow } from "../../lib/depeg-pending";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { buildConfirmationPlan } from "../pending-depeg-confirmation";

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

const brlMeta: StablecoinMeta = {
  id: "brz-transfero",
  name: "Brazilian Digital Token",
  symbol: "BRZ",
  geckoId: "brz",
  flags: {
    backing: "rwa-backed",
    pegCurrency: "BRL",
    governance: "centralized",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
};

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
          const rows = sql.includes("price_sources_json")
            ? (config.dexRows ?? []).filter((row) => row.price_sources_json != null)
            : (config.dexRows ?? []);
          return { results: rows as T[], success: true, meta: {} };
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

function lastBatchStatements(): PreparedStatementWithMeta[] {
  const calls = vi.mocked(batchExecute).mock.calls;
  return calls.flatMap(([, statements]) => statements as PreparedStatementWithMeta[]);
}

function pendingOutcomeInserts(statements = lastBatchStatements()): PreparedStatementWithMeta[] {
  return statements.filter((stmt) => stmt.sql.includes("INSERT INTO depeg_pending_outcomes"));
}

describe("confirmPendingDepegs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(fetchCurrentNativePegQuotes).mockReset().mockResolvedValue(new Map());
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  });

  it("skips confirmation and emits a degraded warning when open-event hydration reaches its limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const openRows = Array.from({ length: 200 }, (_, index) => ({
      stablecoin_id: `open-${index}`,
    }));

    try {
      await confirmPendingDepegs(
        makeDb({ pendingRows: [makePendingRow()], openRows }),
        [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98 }), ...makeNeutralUsdAssets()],
      );

      expect(batchExecute).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.map(([message]) => String(message))).toContainEqual(
        expect.stringContaining('"event":"depeg_open_event_limit_reached"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns early when there are no pending rows", async () => {
    await confirmPendingDepegs(makeDb({ pendingRows: [] }), []);

    expect(batchExecute).not.toHaveBeenCalled();
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
  });

  it("keeps the stored pending peg reference when the refreshed fiat median is thin", () => {
    const nowSec = 1_700_000_000;
    const row = makePendingRow({
      stablecoin_id: "brz-transfero",
      symbol: "BRZ",
      peg_type: "peggedREAL",
      first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      peg_reference: 0.18765951,
    });

    const plan = buildConfirmationPlan({
      db: makeDb({}),
      row,
      pendingState: normalizePendingDepegRow(row),
      asset: makeAuthoritativeUsdAsset(nowSec, {
        id: "brz-transfero",
        name: "Brazilian Digital Token",
        symbol: "BRZ",
        geckoId: "brz",
        pegType: "peggedREAL",
        price: 0.3,
      }),
      meta: brlMeta,
      pegRates: { peggedREAL: 0.3 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 1 },
      nativePegQuote: undefined,
      openSet: new Set(),
      now: nowSec,
    });

    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error(`unexpected plan kind: ${plan.kind}`);
    expect(plan.pegReference).toBe(row.peg_reference);
  });

  it("waits instead of deleting when a thin fiat reference has no valid stored reference", () => {
    const nowSec = 1_700_000_000;
    const row = makePendingRow({
      stablecoin_id: "brz-transfero",
      symbol: "BRZ",
      peg_type: "peggedREAL",
      first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      peg_reference: 0,
    });

    const plan = buildConfirmationPlan({
      db: makeDb({}),
      row,
      pendingState: normalizePendingDepegRow(row),
      asset: makeAuthoritativeUsdAsset(nowSec, {
        id: "brz-transfero",
        name: "Brazilian Digital Token",
        symbol: "BRZ",
        geckoId: "brz",
        pegType: "peggedREAL",
        price: 0.3,
      }),
      meta: brlMeta,
      pegRates: { peggedREAL: 0.3 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 1 },
      nativePegQuote: undefined,
      openSet: new Set(),
      now: nowSec,
    });

    expect(plan).toEqual({ kind: "wait", reason: "peg-reference-unavailable" });
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
            first_seen_at: nowSec - (DEPEG_PENDING_EXPIRY_SEC * 3) - 60,
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

    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(batchExecute).toHaveBeenCalledTimes(4);
    const statements = lastBatchStatements();
    const deletes = statements
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

  it("clears BRZ pending rows when the native quote is below the full confirmation bar", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
      ["brz-transfero", {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 1.01,
        updatedAt: nowSec - 60,
      }],
    ]));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 22,
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
        makeAuthoritativeUsdAsset(nowSec, {
          id: "brz-transfero",
          name: "Brazilian Digital",
          symbol: "BRZ",
          geckoId: "brz",
          pegType: "peggedREAL",
          price: 0.190587,
        }),
        ...makeNeutralUsdAssets(),
      ],
      { peggedREAL: 0.18765951 },
    );

    const statements = lastBatchStatements();
    const outcome = pendingOutcomeInserts(statements)[0];
    const inserts = statements.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    const deletes = statements
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);

    expect(inserts).toHaveLength(0);
    expect(deletes).toEqual([22]);
    expect(outcome?.boundValues[15]).toBe("recovered");
    expect(outcome?.boundValues[21]).toBe("native-peg-recovered");
  });

  it("rejects the EURm native-origin spike when fresh independent USD/FX pricing remains at peg", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
      ["ceur-celo", {
        stablecoinId: "ceur-celo",
        geckoId: "celo-euro",
        pegCurrency: "EUR",
        price: 1.199869,
        updatedAt: nowSec - 60,
      }],
    ]));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 24,
            stablecoin_id: "ceur-celo",
            symbol: "EURm",
            peg_type: "peggedEUR",
            direction: "above",
            first_seen_bps: 15_984,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 2.598389348610164,
            last_seen_bps: 1_999,
            last_seen_at: nowSec - 60,
            last_price: 1.199869,
            peak_seen_bps: 15_984,
            peak_price: 2.598389348610164,
            peg_reference: 1,
            reason: "large-cap+native-origin",
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "ceur-celo",
          name: "Mento Euro",
          symbol: "EURm",
          geckoId: "celo-euro",
          pegType: "peggedEUR",
          price: 1.1529327180815145,
          priceSource: "defillama",
          consensusSources: ["defillama"],
          agreeSources: ["defillama"],
        }),
        ...makeNeutralUsdAssets(),
      ],
      { peggedEUR: 1.153265 },
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
    const statements = lastBatchStatements();
    const inserts = statements.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    const outcome = pendingOutcomeInserts(statements)[0];
    expect(inserts).toHaveLength(0);
    expect(outcome?.boundValues[15]).toBe("rejected");
    expect(outcome?.boundValues[18]).toBe("primary:defillama");
    expect(outcome?.boundValues[21]).toBe("secondary-evidence-opposes");
  });

  it("promotes a native-origin row after the native quote persists for the full window", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
      ["brz-transfero", {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.9758,
        updatedAt: nowSec - 60,
      }],
    ]));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 23,
            stablecoin_id: "brz-transfero",
            symbol: "BRZ",
            peg_type: "peggedREAL",
            direction: "below",
            first_seen_bps: -242,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.9758,
            peak_seen_bps: -242,
            peak_price: 0.9758,
            peg_reference: 1,
            reason: "large-cap+native-origin",
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "brz-transfero",
          name: "Brazilian Digital",
          symbol: "BRZ",
          geckoId: "brz",
          pegType: "peggedREAL",
          price: 0.187251141,
        }),
        ...makeNeutralUsdAssets(),
      ],
      { peggedREAL: 0.191895 },
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
    const insert = lastBatchStatements().find((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    expect(insert?.boundValues[4]).toBe(-242);
    expect(insert?.boundValues[7]).toBe(0.9758);
    expect(insert?.boundValues[9]).toBe("temporal:15m+primary:oracle:pyth");
  });

  it("promotes or rejects pending rows based on secondary-source agreement", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("tether")) {
        return new Response(JSON.stringify({ tether: { usd: 0.95, last_updated_at: nowSec - 30 } }), { status: 200 });
      }
      if (url.includes("usd-coin")) {
        return null;
      }
      if (url.includes("ethena-usde")) {
        return new Response(JSON.stringify({ "ethena-usde": { usd: 1, last_updated_at: nowSec - 30 } }), { status: 200 });
      }
      if (url.includes("usds")) {
        return new Response(JSON.stringify({ usds: { usd: 1, last_updated_at: nowSec - 30 } }), { status: 200 });
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
            price_sources_json: JSON.stringify([
              { price: 0.96, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 0.955, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
            ]),
          },
          {
            stablecoin_id: "usde-ethena",
            dex_price_usd: 1.001,
            updated_at: nowSec - 30,
            source_pool_count: 4,
            source_total_tvl: 5_000_000,
            price_sources_json: JSON.stringify([
              { price: 1.001, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 1, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
            ]),
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
    expect(batchExecute).toHaveBeenCalledTimes(4);

    const prepared = lastBatchStatements();
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
      "temporal:15m+coingecko-confirm",
      "large-cap",
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
      "temporal:15m+dex:curve+dex:uniswap",
      "large-cap",
    ]);
    expect(deletes).toEqual([10, 11, 12, 13]);
  });

  it("does not promote before threshold observations span the full window", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({
      tether: { usd: 0.95, last_updated_at: nowSec - 30 },
    }), { status: 200 }));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 15,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            first_seen_bps: -240,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.976,
            last_seen_bps: -240,
            last_seen_at: nowSec - 120,
            last_price: 0.976,
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("treats missing CoinGecko confirmation timestamps as insufficient evidence", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({ tether: { usd: 0.95 } }), { status: 200 }));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 60,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.978,
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("does not query the DefiLlama CoinGecko mirror for confirmation", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({
      coins: { "coingecko:tether": { price: 0.95 } },
    }), { status: 200 }));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 65,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.978,
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
          priceSource: "coingecko",
          agreeSources: ["coingecko"],
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("keeps pending when authoritative primary remains depegged and only one soft source opposes", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({
      tether: { usd: 1.0, last_updated_at: nowSec - 30 },
    }), { status: 200 }));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 61,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.978,
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("rejects when authoritative primary remains depegged but two independent hard sources oppose", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchWithRetry).mockResolvedValue(null);
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

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 62,
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
            source_pool_count: 4,
            source_total_tvl: 6_000_000,
            price_sources_json: JSON.stringify([
              { price: 1.03, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 1.031, tvl: 3_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
            ]),
          },
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const statements = lastBatchStatements();
    const deletes = statements
      .filter((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"))
      .map((stmt) => stmt.boundValues[0]);
    expect(deletes).toEqual([62]);
    const outcome = pendingOutcomeInserts(statements)[0];
    expect(outcome?.boundValues[15]).toBe("rejected");
    expect(outcome?.boundValues[18]).toContain("cex:binance");
    expect(outcome?.boundValues[21]).toMatch(/^two-hard-opposing-sources:/);
  });

  it("keeps expired-base pending rows when confirmation provider circuits are open", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 63,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -220,
            first_seen_at: nowSec - DEPEG_PENDING_EXPIRY_SEC - 60,
            first_price: 0.978,
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("persists a lifecycle outcome before deleting a promoted pending row", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 64,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -200,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.98,
            peg_reference: 1,
          }),
        ],
        dexRows: [
          {
            stablecoin_id: "usdt-tether",
            dex_price_usd: 0.988,
            updated_at: nowSec - 30,
            source_pool_count: 3,
            source_total_tvl: 5_000_000,
            price_sources_json: JSON.stringify([
              { price: 0.988, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 0.987, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
            ]),
          },
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.985,
          priceSource: "defillama-list+coingecko",
          agreeSources: ["defillama-list", "coingecko"],
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    const statements = lastBatchStatements();
    const outcomeIndex = statements.findIndex((stmt) => stmt.sql.includes("INSERT INTO depeg_pending_outcomes"));
    const deleteIndex = statements.findIndex((stmt) => stmt.sql.startsWith("DELETE FROM depeg_pending"));
    expect(outcomeIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(outcomeIndex);
    const outcome = statements[outcomeIndex]!;
    expect(outcome.boundValues[0]).toBe(64);
    expect(outcome.boundValues[15]).toBe("promoted");
    expect(outcome.boundValues[17]).toContain("dex:curve+dex:uniswap");
    expect(outcome.boundValues[21]).toBe("confirmed-by:temporal:15m+dex:curve+dex:uniswap");
  });

  it("does not treat DefiLlama's CoinGecko mirror as independent confirmation", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

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

    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("promotes a refreshed pending row using the worst stored or confirmer peak state", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({ tether: { usd: 0.95, last_updated_at: nowSec - 30 } }), { status: 200 }));

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
      -500,
      nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
      0.98,
      0.95,
      1,
      "temporal:15m+coingecko-confirm",
      "large-cap",
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
          coins: { "coingecko:kinesis-gold": { price: 133.81, timestamp: nowSec - 30 } },
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

  it("does not promote large-cap pending rows from already-used off-chain source families", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({ tether: { usd: 0.95, last_updated_at: nowSec - 30 } }), { status: 200 }));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 51,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -240,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.976,
            reason: "large-cap",
          }),
        ],
      }),
      [
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.95,
          priceSource: "defillama-list+coingecko",
          agreeSources: ["defillama-list", "coingecko"],
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(fetchWithRetry).not.toHaveBeenCalled();
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

  it("does not let one aggregate DEX protocol group promote a pending event", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.mocked(fetchWithRetry).mockResolvedValue(null);

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 25,
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
            source_pool_count: 2,
            source_total_tvl: 5_000_000,
            price_sources_json: JSON.stringify([
              { price: 0.96, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 0.959, tvl: 2_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
            ]),
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
      kind: "ok",
      value: {
        prices: new Map([["USDTUSDC", 0.9998]]),
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

  it("skips off-chain fetch when the CoinGecko circuit breaker is open", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(shouldAttemptFetch).mockImplementation(
      async (_db, source) => source !== CIRCUIT_SOURCE.COINGECKO_CONFIRM,
    );
    vi.mocked(fetchWithRetry).mockReset();

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 90,
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
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    // No CoinGecko URL fetched
    const fetchSpy = vi.mocked(fetchWithRetry);
    expect(
      fetchSpy.mock.calls.find(
        ([url]) => typeof url === "string" && url.includes("/simple/price"),
      ),
    ).toBeUndefined();
    // Circuit-breaker skip path must also NOT record a false outcome — only real fetch attempts do.
    expect(vi.mocked(recordOutcomeSafe)).not.toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.COINGECKO_CONFIRM,
      false,
    );
  });

  it("records CoinGecko outcome to circuit breaker on fetch failure", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetchWithRetry).mockRejectedValueOnce(new Error("timeout"));

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 91,
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
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(recordOutcomeSafe).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.COINGECKO_CONFIRM,
      false,
    );
  });

  it("cancels non-OK off-chain confirmation response bodies", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = new Response(JSON.stringify({ error: "rate-limited" }), { status: 429 });
    const cancelSpy = vi.spyOn(response.body!, "cancel");
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(response);

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 92,
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
        makeAuthoritativeUsdAsset(nowSec, {
          id: "usdt-tether",
          symbol: "USDT",
          geckoId: "tether",
          price: 0.94,
        }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(recordOutcomeSafe).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.COINGECKO_CONFIRM,
      false,
    );
  });

  it("treats Binance all-host 403 blocks as non-outage circuit outcomes", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.mocked(fetchBinancePricesDetailed).mockResolvedValueOnce({
      kind: "blocked",
      value: {
        prices: new Map(),
        diagnostics: [
          {
            source: "binance",
            stage: "primary",
            endpoint: "data-api.binance.vision/api/v3/ticker/price",
            status: 403,
            ok: false,
            success: false,
          },
          {
            source: "binance",
            stage: "primary",
            endpoint: "api.binance.com/api/v3/ticker/price",
            status: 403,
            ok: false,
            success: false,
          },
        ],
      },
    });

    const result = await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 24,
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

    expect(result.providerDiagnostics).toHaveLength(2);
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
      expect.stringContaining("[depeg-helpers] Unexpected error loading dex_prices:"),
    );
  });

  it("promotes a pending depeg when individual pool prices confirm the deviation", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    // CoinGecko returns ~$1 (disagrees with depeg)
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string) => {
      if (url.includes("dusd")) {
        return new Response(JSON.stringify({ "dusd-trinity": { usd: 1.0, last_updated_at: nowSec - 30 } }), { status: 200 });
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
              { price: 0.80, tvl: 500_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 0.95, tvl: 200_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
              { price: 1.00, tvl: 50_000, protocol: "balancer", sourceFamily: "balancer", chain: "ethereum" },
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
        return new Response(JSON.stringify({ tether: { usd: 1.0, last_updated_at: nowSec - 30 } }), { status: 200 });
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
              { price: 1.001, tvl: 20_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
              { price: 0.999, tvl: 15_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
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

  it("does not count same-protocol pool challengers as independent confirmation", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchWithRetry).mockResolvedValue(null);

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 42,
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
            source_total_tvl: 10_000_000,
            price_sources_json: JSON.stringify([
              { price: 0.98, tvl: 1_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 0.979, tvl: 1_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
            ]),
          },
        ],
      }),
      [
        makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: "tether", price: 0.98 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(batchExecute).not.toHaveBeenCalled();
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

  it("promoted event carries confirmationSources and pendingReason", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await confirmPendingDepegs(
      makeDb({
        pendingRows: [
          makePendingRow({
            id: 90,
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            direction: "below",
            first_seen_bps: -200,
            first_seen_at: nowSec - DEPEG_PENDING_MIN_AGE_SEC - 60,
            first_price: 0.98,
            peg_reference: 1,
            reason: "large-cap",
          }),
        ],
        dexRows: [
          {
            stablecoin_id: "usdt-tether",
            dex_price_usd: 0.988,
            updated_at: nowSec - 30,
            source_pool_count: 3,
            source_total_tvl: 5_000_000,
            price_sources_json: JSON.stringify([
              { price: 0.988, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
              { price: 0.987, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
            ]),
          },
        ],
      }),
      [
        makeAsset({ id: "usdt-tether", symbol: "USDT", geckoId: undefined, price: 0.985 }),
        ...makeNeutralUsdAssets(),
      ],
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    const inserts = prepared.filter((stmt) => stmt.sql.startsWith("INSERT INTO depeg_events"));
    expect(inserts).toHaveLength(1);
    // buildInsertDepegEventStmt bind order:
    // [0]=stablecoinId, [1]=symbol, [2]=pegType, [3]=direction, [4]=peakBps,
    // [5]=startedAt, [6]=startPrice, [7]=peakPrice, [8]=pegReference,
    // [9]=confirmationSources, [10]=pendingReason
    const bound = inserts[0]!.boundValues;
    expect(bound[9]).toBe("temporal:15m+dex:curve+dex:uniswap");
    expect(bound[10]).toBe("large-cap");
  });
});
