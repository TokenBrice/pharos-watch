import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchRetry } from "../../test-helpers/cron";
import {
  insertDexPrice,
  insertPendingDepeg,
  makePendingDepegRow,
} from "../../test-helpers/pending-depeg-fixtures";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: vi.fn(), passthroughNonResponse: true }));

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
    const normalized = pegCurrency?.trim().toUpperCase();
    return normalized && ["ARS", "BRL", "EUR", "JPY", "NGN"].includes(normalized) ? normalized : null;
  }),
}));

import { fetchBinancePricesDetailed } from "../../lib/cex-tickers";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import { confirmPendingDepegs } from "../confirm-pending-depegs";

const NOW_SEC = 1_700_000_000;
const sqliteFixtures = createLatestSchemaFixtureTracker();
const openFixture = sqliteFixtures.open;

const makePendingRow = makePendingDepegRow;
const insertPending = insertPendingDepeg;

function insertOpenEvent(sqlite: DatabaseSync, stablecoinId: string, symbol: string): void {
  sqlite.prepare(
    `INSERT INTO depeg_events (
       stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, start_price, peak_price, peg_reference, source
     ) VALUES (?, ?, 'peggedUSD', 'below', 100, ?, 0.99, 0.99, 1, 'live')`,
  ).run(stablecoinId, symbol, NOW_SEC - 3_600);
}

function lifecycle(sqlite: DatabaseSync, stablecoinId: string, pendingId: number) {
  return {
    pending: sqlite.prepare("SELECT id FROM depeg_pending WHERE id = ?").get(pendingId) as { id: number } | undefined,
    events: sqlite.prepare(
      `SELECT stablecoin_id, symbol, peak_deviation_bps, started_at, start_price,
              peak_price, peg_reference, source, confirmation_sources, pending_reason
         FROM depeg_events WHERE stablecoin_id = ? ORDER BY id`,
    ).all(stablecoinId) as Array<Record<string, unknown>>,
    outcomes: sqlite.prepare(
      `SELECT pending_id, stablecoin_id, outcome, peak_seen_bps, peak_price,
              peg_reference, confirming_sources, opposing_sources,
              unavailable_sources, circuit_open_sources, final_decision_reason
         FROM depeg_pending_outcomes WHERE pending_id = ? ORDER BY id`,
    ).all(pendingId) as Array<Record<string, unknown>>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(fetchWithRetry).mockReset();
  vi.mocked(fetchCurrentNativePegQuotes).mockReset().mockResolvedValue(new Map());
  vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  vi.mocked(fetchBinancePricesDetailed).mockReset().mockResolvedValue({
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
  });
  sqliteFixtures.closeAll();
});

describe("confirmPendingDepegs", () => {
  it("returns early when there are no pending rows", async () => {
    const { sqlite, db } = openFixture();

    await expect(confirmPendingDepegs(db, [])).resolves.toEqual({ providerDiagnostics: [] });

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_pending").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_pending_outcomes").get()).toEqual({ count: 0 });
  });

  it("skips confirmation and emits a degraded warning when open-event hydration reaches its limit", async () => {
    const { sqlite, db } = openFixture();
    const pending = makePendingRow();
    insertPending(sqlite, pending);
    for (let index = 0; index < 200; index++) insertOpenEvent(sqlite, `open-${index}`, `OPEN${index}`);

    await confirmPendingDepegs(db, [makeAsset({ id: pending.stablecoin_id, symbol: pending.symbol, geckoId: undefined })]);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_pending").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_pending_outcomes").get()).toEqual({ count: 0 });
  });

  it("promotes a pending depeg after independent DEX groups confirm the deviation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({ id: 10, first_seen_bps: -220, first_price: 0.978 });
    insertPending(sqlite, pending);
    insertDexPrice(sqlite, pending.stablecoin_id, pending.symbol, 0.97, [
      { price: 0.97, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
      { price: 0.969, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
    ]);

    await confirmPendingDepegs(db, [
      makeAsset({
        id: pending.stablecoin_id,
        symbol: pending.symbol,
        geckoId: undefined,
        price: 0.97,
        priceSource: "pool-tvl-weighted",
        priceConfidence: "low",
        priceObservedAt: NOW_SEC - 30,
        priceUpdatedAt: NOW_SEC - 30,
        priceSyncedAt: NOW_SEC - 30,
      }),
    ]);

    const state = lifecycle(sqlite, pending.stablecoin_id, pending.id);
    expect(state.pending).toBeUndefined();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      stablecoin_id: pending.stablecoin_id,
      source: "live",
      pending_reason: "large-cap",
    });
    expect(String(state.events[0]?.confirmation_sources)).toContain("dex:curve+dex:uniswap");
    expect(state.outcomes).toHaveLength(1);
    expect(state.outcomes[0]).toMatchObject({
      pending_id: pending.id,
      outcome: "promoted",
      final_decision_reason: expect.stringContaining("confirmed-by:temporal:15m+dex:curve+dex:uniswap"),
    });
  });

  it("clears BRZ pending rows when the direct BRL quote is back inside threshold", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({
      id: 21,
      stablecoin_id: "brz-transfero",
      symbol: "BRZ",
      peg_type: "peggedREAL",
      direction: "above",
      first_seen_bps: 180,
      first_price: 0.190587,
      peg_reference: 0.18765951,
    });
    insertPending(sqlite, pending);
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
      [pending.stablecoin_id, {
        stablecoinId: pending.stablecoin_id,
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.995,
        updatedAt: NOW_SEC - 60,
      }],
    ]));

    await confirmPendingDepegs(db, [makeAsset({
      id: pending.stablecoin_id,
      symbol: pending.symbol,
      geckoId: "brz",
      pegType: "peggedREAL",
      price: 0.190587,
    })]);

    const state = lifecycle(sqlite, pending.stablecoin_id, pending.id);
    expect(state.pending).toBeUndefined();
    expect(state.events).toHaveLength(0);
    expect(state.outcomes[0]).toMatchObject({ outcome: "recovered", final_decision_reason: "native-peg-recovered" });
  });

  it("treats Binance all-host 403 blocks as non-outage circuit outcomes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({ id: 24 });
    insertPending(sqlite, pending);
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

    const result = await confirmPendingDepegs(db, [makeAsset({
      id: pending.stablecoin_id,
      symbol: pending.symbol,
      geckoId: undefined,
      price: 0.98,
    })]);

    expect(result.providerDiagnostics).toHaveLength(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_pending").get()).toEqual({ count: 1 });
  });

  it("keeps pending after a confirmation provider failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({ id: 91 });
    insertPending(sqlite, pending);
    vi.mocked(fetchWithRetry).mockRejectedValueOnce(new Error("timeout"));

    await confirmPendingDepegs(db, [makeAsset({
      id: pending.stablecoin_id,
      symbol: pending.symbol,
      geckoId: "tether",
      price: 0.94,
    })]);

    expect(lifecycle(sqlite, pending.stablecoin_id, pending.id)).toMatchObject({
      pending: { id: pending.id },
      events: [],
      outcomes: [],
    });
  });

  it("rethrows abort-related failures from secondary fetches", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({ id: 30 });
    insertPending(sqlite, pending);
    const controller = new AbortController();
    vi.mocked(fetchWithRetry).mockImplementationOnce(async () => {
      controller.abort(new Error("stop now"));
      throw new Error("network aborted");
    });

    await expect(confirmPendingDepegs(
      db,
      [makeAsset({ id: pending.stablecoin_id, symbol: pending.symbol, geckoId: "tether", price: 0.94 })],
      undefined,
      controller.signal,
    )).rejects.toThrow("network aborted");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_pending_outcomes").get()).toEqual({ count: 0 });
  });

  it("persists a lifecycle outcome before deleting a promoted pending row", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite, db } = openFixture();
    const pending = makePendingRow({ id: 64, first_seen_bps: -200, first_price: 0.98 });
    insertPending(sqlite, pending);
    insertDexPrice(sqlite, pending.stablecoin_id, pending.symbol, 0.988, [
      { price: 0.988, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
      { price: 0.987, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
    ]);

    await confirmPendingDepegs(db, [makeAsset({
      id: pending.stablecoin_id,
      symbol: pending.symbol,
      geckoId: undefined,
      price: 0.985,
      priceSource: "pool-tvl-weighted",
      priceConfidence: "low",
      priceObservedAt: NOW_SEC - 30,
      priceUpdatedAt: NOW_SEC - 30,
      priceSyncedAt: NOW_SEC - 30,
    })]);

    const state = lifecycle(sqlite, pending.stablecoin_id, pending.id);
    expect(state.pending).toBeUndefined();
    expect(state.outcomes).toHaveLength(1);
    expect(state.outcomes[0]).toMatchObject({ pending_id: pending.id, outcome: "promoted" });
    expect(state.events).toHaveLength(1);
  });
});
