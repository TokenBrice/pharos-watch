import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchRetry, mockRegistry } from "../../test-helpers/cron";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  insertDexPrice,
  insertPendingDepeg,
  makePendingDepegRow,
} from "../../test-helpers/pending-depeg-fixtures";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { buildUpsertPendingDepegStmt, normalizePendingDepegRow, type PendingDepegRow } from "../../lib/depeg-pending";
import { buildOutcomeAndDeleteStmts } from "../pending-depeg-confirmation";

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: Array.from({ length: 51 }, (_, index) => ({
    id: `atomic-confirm-${index}`, symbol: `atomic-confirm-${index}`, flags: { pegCurrency: "USD" },
  })),
}));

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

const NOW_SEC = 1_700_000_000;

function insertConfirmablePending(sqlite: DatabaseSync, id: number, stablecoinId: string): void {
  const row = makePendingDepegRow({
    id,
    stablecoin_id: stablecoinId,
    symbol: stablecoinId,
    first_seen_bps: -300,
    first_price: 0.97,
    last_seen_bps: -300,
    last_seen_at: NOW_SEC - 30,
    last_price: 0.97,
    peak_seen_bps: -300,
    peak_price: 0.97,
    updated_at: NOW_SEC - 30,
  });
  insertPendingDepeg(sqlite, row);
  insertDexPrice(sqlite, stablecoinId, stablecoinId, 0.97, [
    { price: 0.97, tvl: 3_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
    { price: 0.969, tvl: 2_000_000, protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum" },
  ]);
}

function makePromotionAsset(stablecoinId: string) {
  return makeAsset({
    id: stablecoinId,
    name: stablecoinId,
    symbol: stablecoinId,
    geckoId: undefined,
    price: 0.97,
    priceSource: "defillama",
    priceConfidence: "low",
    priceUpdatedAt: NOW_SEC - 30,
    priceObservedAt: NOW_SEC - 30,
    priceSyncedAt: NOW_SEC - 30,
  });
}

function instrumentBatches(sqlite: DatabaseSync): { db: D1Database; batchSizes: number[] } {
  const base = createSqliteD1(sqlite);
  const batchSizes: number[] = [];
  const db = makeNoopD1({
    ...base,
    batch: async <T>(statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return base.batch<T>(statements);
    },
  });
  return { db, batchSizes };
}

const sqliteFixtures = createLatestSchemaFixtureTracker();
describe("confirmPendingDepegs atomic candidate transitions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sqliteFixtures.closeAll();
  });

  it("keeps every three-statement promotion intact beyond the 100-statement boundary", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite } = sqliteFixtures.open();
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
  });

  it("rolls back a failing later candidate without undoing earlier candidates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    const { sqlite } = sqliteFixtures.open();
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
  });

  it("keeps a clocked closure pending on incompatible rollback", async () => {
    const { db, sqlite } = sqliteFixtures.open();
    const firstSeenAt = Date.parse("2026-11-21T12:00:00Z") / 1000;
    const fridayClose = 0.000625;
    const price = 0.0004375;
    await buildUpsertPendingDepegStmt(db, {
      stablecoinId: "cngn-compliant-naira", symbol: "cNGN", pegType: "peggedNGN", direction: "below",
      seenAt: firstSeenAt, quoteObservedAt: firstSeenAt - 30, bps: -3000, price, pegReference: fridayClose,
      reason: "confirmation-window+low-confidence",
      referenceAdmission: {
        status: "admitted", reason: "severe-deviation", kind: "fx", source: "fawazahmed0",
        cadence: "calendar-daily", quoteObservedAtSec: firstSeenAt - 30, decisionAtSec: firstSeenAt,
        referenceObservedAtSec: Date.parse("2026-11-20T00:00:00Z") / 1000,
        budgetSec: 86400, sessionOpenedAtSec: null, generation: "friday-close", policyVersion: 1,
      },
    }).run();
    const row = (await db.prepare("SELECT * FROM depeg_pending").first<PendingDepegRow>())!;
    const state = normalizePendingDepegRow(row);
    const outcome = buildOutcomeAndDeleteStmts(db, row, state, "promoted", firstSeenAt + 960,
      { confirmingSources: ["pool:curve:curve"] }, "confirmed-by:temporal:15m+pool:curve:curve");
    const insertEvent = (reference: number) => db.prepare(
      `INSERT INTO depeg_events (
        stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price,
        peg_reference, source, confirmation_sources, pending_reason
      ) VALUES (?, 'cNGN', 'peggedNGN', 'below', -3000, ?, ?, ?, ?, 'live', 'temporal:15m+pool:curve:curve', ?)`,
    ).bind(row.stablecoin_id, firstSeenAt, price, price, reference, state.reason);
    const readEvents = () => sqlite.prepare("SELECT peak_deviation_bps, peak_price, peg_reference FROM depeg_events").all();
    const readOutcomes = () => sqlite.prepare("SELECT pending_id FROM depeg_pending_outcomes").all();
    await expect(db.batch([insertEvent(0.0006), ...outcome]))
      .rejects.toThrow("incompatible closure pending promotion");
    expect(readEvents()).toEqual([]);
    expect(readOutcomes()).toEqual([]);
    expect(await db.prepare("SELECT * FROM depeg_pending").first()).toEqual(row);

    await db.batch([insertEvent(fridayClose), ...outcome]);
    expect(await db.prepare("SELECT * FROM depeg_pending").first()).toBeNull();
    expect(readOutcomes()).toEqual([{ pending_id: row.id }]);
    expect(readEvents()).toEqual([{ peak_deviation_bps: -3000, peak_price: price, peg_reference: fridayClose }]);
  });
});
