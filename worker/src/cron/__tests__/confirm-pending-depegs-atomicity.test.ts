import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchRetry } from "../../test-helpers/cron";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: vi.fn(), notOkAsNull: true, passthroughNonResponse: true }));

vi.mock("../../lib/cex-tickers", () => ({
  createBinanceFetchSession: vi.fn(() => ({})),
  fetchBinancePricesForRun: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => false),
  recordOutcomeSafe: vi.fn(async () => undefined),
}));

vi.mock("../../lib/native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: vi.fn(async () => new Map()),
}));

import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { DEPEG_PENDING_MIN_AGE_SEC } from "../../lib/constants";

const NOW_SEC = 1_700_000_000;

function insertConfirmablePending(sqlite: DatabaseSync, id: number, stablecoinId: string): void {
  sqlite.prepare(
    `INSERT INTO depeg_pending (
       id, stablecoin_id, symbol, peg_type, direction, first_seen_bps,
       first_seen_at, first_price, peg_reference, reason, last_seen_bps,
       last_seen_at, last_price, peak_seen_bps, peak_price, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    stablecoinId,
    stablecoinId,
    "peggedUSD",
    "below",
    -300,
    NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC - 60,
    0.97,
    1,
    "large-cap",
    -300,
    NOW_SEC - 30,
    0.97,
    -300,
    0.97,
    NOW_SEC - 30,
  );

  sqlite.prepare(
    `INSERT INTO dex_prices (
       stablecoin_id, symbol, dex_price_usd, source_pool_count,
       source_total_tvl, deviation_from_primary_bps, primary_price_at_calc,
       price_sources_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    stablecoinId,
    stablecoinId,
    0.97,
    2,
    5_000_000,
    0,
    0.97,
    JSON.stringify([
      { price: 0.97, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
      { price: 0.969, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
    ]),
    NOW_SEC - 30,
  );
}

function makePromotionAsset(stablecoinId: string) {
  return makeAsset({
    id: stablecoinId,
    name: stablecoinId,
    symbol: stablecoinId,
    geckoId: undefined,
    price: 0.97,
    priceSource: "pool-tvl-weighted",
    priceConfidence: "low",
    priceUpdatedAt: NOW_SEC - 30,
    priceObservedAt: NOW_SEC - 30,
    priceSyncedAt: NOW_SEC - 30,
  });
}

function instrumentBatches(sqlite: DatabaseSync): { db: D1Database; batchSizes: number[] } {
  const base = createSqliteD1(sqlite);
  const batchSizes: number[] = [];
  const db = {
    ...base,
    batch: async <T>(statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return base.batch<T>(statements);
    },
  } as unknown as D1Database;
  return { db, batchSizes };
}

describe("confirmPendingDepegs atomic candidate transitions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps every three-statement promotion intact beyond the 100-statement boundary", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite } = createLatestSchemaSqlite();
    const { db, batchSizes } = instrumentBatches(sqlite);
    const assets: ReturnType<typeof makePromotionAsset>[] = [];

    for (let index = 0; index < 51; index++) {
      const stablecoinId = `atomic-confirm-${index}`;
      insertConfirmablePending(sqlite, index + 1, stablecoinId);
      assets.push(makePromotionAsset(stablecoinId));
    }

    await confirmPendingDepegs(db, assets);

    const pendingCount = sqlite
      .prepare("SELECT COUNT(*) AS count FROM depeg_pending")
      .get() as { count: number };
    const outcomeCount = sqlite
      .prepare("SELECT COUNT(*) AS count FROM depeg_pending_outcomes WHERE outcome = 'promoted'")
      .get() as { count: number };
    const eventCount = sqlite
      .prepare("SELECT COUNT(*) AS count FROM depeg_events WHERE stablecoin_id LIKE 'atomic-confirm-%'")
      .get() as { count: number };

    expect(batchSizes).toEqual(new Array(51).fill(3));
    expect(pendingCount.count).toBe(0);
    expect(outcomeCount.count).toBe(51);
    expect(eventCount.count).toBe(51);
    sqlite.close();
  });

  it("rolls back a failing later candidate without undoing earlier candidates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite } = createLatestSchemaSqlite();
    sqlite.exec(`
      CREATE TRIGGER fail_atomic_pending_outcome
      BEFORE INSERT ON depeg_pending_outcomes
      WHEN NEW.pending_id = 3
      BEGIN
        SELECT RAISE(ABORT, 'injected pending outcome failure');
      END
    `);
    const { db, batchSizes } = instrumentBatches(sqlite);
    const assets = [1, 2, 3].map((id) => makePromotionAsset(`atomic-confirm-${id}`));

    for (const id of [1, 2, 3]) insertConfirmablePending(sqlite, id, `atomic-confirm-${id}`);

    await expect(confirmPendingDepegs(db, assets)).rejects.toThrow("injected pending outcome failure");

    const pendingRows = sqlite
      .prepare("SELECT id FROM depeg_pending ORDER BY id")
      .all() as Array<{ id: number }>;
    const outcomeRows = sqlite
      .prepare("SELECT pending_id FROM depeg_pending_outcomes ORDER BY pending_id")
      .all() as Array<{ pending_id: number }>;
    const eventRows = sqlite
      .prepare("SELECT stablecoin_id FROM depeg_events ORDER BY stablecoin_id")
      .all() as Array<{ stablecoin_id: string }>;

    expect(batchSizes).toEqual([3, 3, 3]);
    expect(pendingRows).toEqual([{ id: 3 }]);
    expect(outcomeRows).toEqual([{ pending_id: 1 }, { pending_id: 2 }]);
    expect(eventRows).toEqual([
      { stablecoin_id: "atomic-confirm-1" },
      { stablecoin_id: "atomic-confirm-2" },
    ]);
    sqlite.close();
  });
});
