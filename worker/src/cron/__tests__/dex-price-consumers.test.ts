import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEX_PROTOCOL_SOURCE_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import type { LoadedDexPrices } from "../../lib/depeg-helpers";
import type * as depegHelpers from "../../lib/depeg-helpers";
import type * as nativePegQuotes from "../../lib/native-peg-quotes";
import type * as confirmationEvidence from "../pending-depeg-confirmation-evidence";
import { loadDexPoolChallengers } from "../../lib/depeg-helpers";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";
import { insertDexPrice, insertPendingDepeg, makePendingDepegRow } from "../../test-helpers/pending-depeg-fixtures";
import { buildPrimaryPricePlan } from "../sync-stablecoins/enrich-prices-primary-provider-collection";
import { hydrateDepegDetection } from "../depeg-detection/hydration";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { collectConfirmationEvidence } from "../pending-depeg-confirmation-evidence";

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => false),
  recordOutcomeSafe: vi.fn(async () => undefined),
}));
vi.mock("../../lib/native-peg-quotes", async (importOriginal) => ({
  ...await importOriginal<typeof nativePegQuotes>(),
  fetchCurrentNativePegQuotes: vi.fn(async () => new Map()),
}));
vi.mock("../../lib/depeg-helpers", async (importOriginal) => ({
  ...await importOriginal<typeof depegHelpers>(),
  loadDexPoolChallengers: vi.fn(async () => new Map()),
}));
vi.mock("../pending-depeg-confirmation-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof confirmationEvidence>();
  return { ...actual, collectConfirmationEvidence: vi.fn(actual.collectConfirmationEvidence) };
});

const NOW = 1_700_000_000;
const BOUNDARY = NOW - DEX_PROTOCOL_SOURCE_FRESHNESS_SEC;
const fixtures = createLatestSchemaFixtureTracker();
const sources = [
  { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.98, tvl: 3_000_000 },
  { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.98, tvl: 2_000_000 },
];
const asset = makePeggedAsset({
  id: "usdt-tether", symbol: "USDT", geckoId: undefined,
  price: 0.98, priceSource: "pool-tvl-weighted", priceConfidence: "low",
  priceObservedAt: NOW - 30, priceUpdatedAt: NOW - 30, priceSyncedAt: NOW - 30,
});

interface Consumer {
  name: string;
  load(db: D1Database, signal?: AbortSignal): Promise<LoadedDexPrices>;
}
const consumers: Consumer[] = [
  {
    name: "primary price planning",
    async load(db) {
      const plan = await buildPrimaryPricePlan([asset], db);
      expect(plan.nowSec).toBe(NOW);
      expect(plan.dexPriceSourceTelemetry).toEqual(plan.dexRows.size === 0
        ? { staleRows: [], malformedRows: [] }
        : {
          staleRows: [{ stablecoinId: "stale", updatedAt: BOUNDARY - 1, ageSec: DEX_PROTOCOL_SOURCE_FRESHNESS_SEC + 1, maxAgeSec: DEX_PROTOCOL_SOURCE_FRESHNESS_SEC }],
          malformedRows: [{ stablecoinId: "malformed", updatedAt: NOW, reason: "json-parse-failed" }],
        });
      return { dexPriceRows: plan.dexRows, dexPriceSources: plan.dexPriceSources };
    },
  },
  {
    name: "depeg detection hydration",
    async load(db, signal) {
      const hydrated = await hydrateDepegDetection(db, [], undefined, signal);
      expect(hydrated.now).toBe(NOW);
      return hydrated;
    },
  },
  {
    name: "pending confirmation",
    async load(db, signal) {
      await confirmPendingDepegs(db, [asset], undefined, signal);
      const calls = vi.mocked(collectConfirmationEvidence).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].now).toBe(NOW);
      return calls[0][0];
    },
  },
];
function seedPending(sqlite: DatabaseSync) {
  insertPendingDepeg(sqlite, makePendingDepegRow());
}
function seedRows(sqlite: DatabaseSync) {
  insertDexPrice(sqlite, "usdt-tether", "USDT", 0.98, sources, BOUNDARY);
  insertDexPrice(sqlite, "stale", "STALE", 0.98, sources, BOUNDARY - 1);
  insertDexPrice(sqlite, "null", "NULL", 0.98, sources, BOUNDARY - 1);
  sqlite.prepare("UPDATE dex_prices SET price_sources_json = NULL WHERE stablecoin_id = 'null'").run();
  insertDexPrice(sqlite, "malformed", "BAD", 0.98, sources, NOW);
  sqlite.prepare("UPDATE dex_prices SET price_sources_json = '{bad-json' WHERE stablecoin_id = 'malformed'").run();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

for (const consumer of consumers) {
  describe(consumer.name, () => {
    it("preserves aggregate/source output with boundary, stale, NULL and malformed rows in one D1 read", async () => {
      const { sqlite } = fixtures.open();
      seedPending(sqlite);
      seedRows(sqlite);
      const dexReads: string[] = [];
      const db = createSqliteD1(sqlite, { onAll(sql) {
        if (sql.includes("FROM dex_prices")) {
          dexReads.push(sql);
          // The old second source-loader clock would now reject the boundary row.
          vi.mocked(Date.now).mockReturnValue((NOW + 1) * 1000);
        }
      } });
      const loaded = await consumer.load(db);
      expect(loaded.dexPriceRows).toEqual(new Map([
        ["usdt-tether", { stablecoin_id: "usdt-tether", dex_price_usd: 0.98, deviation_from_primary_bps: 0, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: BOUNDARY }],
        ["stale", { stablecoin_id: "stale", dex_price_usd: 0.98, deviation_from_primary_bps: 0, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: BOUNDARY - 1 }],
        ["null", { stablecoin_id: "null", dex_price_usd: 0.98, deviation_from_primary_bps: 0, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: BOUNDARY - 1 }],
        ["malformed", { stablecoin_id: "malformed", dex_price_usd: 0.98, deviation_from_primary_bps: 0, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: NOW }],
      ]));
      expect(loaded.dexPriceSources).toEqual(new Map([["usdt-tether", sources.map((source) => ({ ...source, updatedAt: BOUNDARY }))]]));
      expect(dexReads).toHaveLength(1);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("context=dex_prices.price_sources_json"));
    });

    it("continues with both maps empty on a missing dex_prices table using one failed read", async () => {
      const { sqlite, db } = fixtures.open();
      seedPending(sqlite);
      sqlite.exec("DROP TABLE dex_prices");
      const prepare = vi.spyOn(db, "prepare");
      const loaded = await consumer.load(db);
      expect(loaded.dexPriceRows.size).toBe(0);
      expect(loaded.dexPriceSources.size).toBe(0);
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM dex_prices"))).toHaveLength(1);
    });

    it("propagates unexpected DEX read failures instead of fabricating empty maps", async () => {
      const { sqlite } = fixtures.open();
      seedPending(sqlite);
      const failure = new Error("DEX storage unavailable");
      const db = createSqliteD1(sqlite, { onAll(sql) { if (sql.includes("FROM dex_prices")) throw failure; } });
      await expect(consumer.load(db)).rejects.toBe(failure);
    });
  });
}

for (const consumer of consumers.slice(1)) {
  it(`${consumer.name} stops after cancellation during the combined DEX await`, async () => {
    const { sqlite } = fixtures.open();
    seedPending(sqlite);
    const controller = new AbortController();
    const failure = new Error("DEX read cancelled");
    const db = createSqliteD1(sqlite, { onAll(sql) {
      if (sql.includes("FROM dex_prices")) controller.abort(failure);
    } });
    await expect(consumer.load(db, controller.signal)).rejects.toBe(failure);
    expect(loadDexPoolChallengers).not.toHaveBeenCalled();
    expect(collectConfirmationEvidence).not.toHaveBeenCalled();
  });

  it(`${consumer.name} does not read DEX data when already aborted`, async () => {
    const { db } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    const controller = new AbortController();
    const failure = new Error("already cancelled");
    controller.abort(failure);
    await expect(consumer.load(db, controller.signal)).rejects.toBe(failure);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchCurrentNativePegQuotes).not.toHaveBeenCalled();
  });
}
