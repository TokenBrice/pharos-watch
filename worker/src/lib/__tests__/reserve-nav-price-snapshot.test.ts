import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { loadReserveNavSupplyPrice } from "../reserve-nav-price";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../live-reserves/store-shared";
import { collectPrimaryProviderQuotes, type PrimaryPricePlan } from "../../cron/sync-stablecoins/enrich-prices-primary-provider-collection";
import { fetchFiatCoinGeckoTokens } from "../../cron/sync-stablecoins/supplemental-assets/fiat-cg";
import type { StablecoinMeta } from "@shared/types/core";
import type * as StablecoinRegistry from "@shared/lib/stablecoins/registry";
import type * as SupplementalShared from "../../cron/sync-stablecoins/supplemental-assets/shared";
import type * as OnchainSupply from "../../cron/sync-stablecoins/supplemental-assets/onchain-supply";
import { createDexPriceSourceLoadTelemetry } from "../depeg-helpers";

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof StablecoinRegistry>();
  return { ...actual, ACTIVE_STABLECOINS: actual.ACTIVE_STABLECOINS.filter((coin) => ["usyc-hashnote", "ustb-superstate"].includes(coin.id)) };
});
vi.mock("../../cron/sync-stablecoins/supplemental-assets/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof SupplementalShared>();
  return { ...actual, fetchSupplementalPriceData: vi.fn(async () => ({ coins: {} })) };
});
vi.mock("../../cron/sync-stablecoins/supplemental-assets/onchain-supply", async (importOriginal) => {
  const actual = await importOriginal<typeof OnchainSupply>();
  return {
    ...actual,
    fetchCuratedAggregateOnChainMcap: vi.fn(async () => null),
    fetchOnChainMcap: vi.fn(async (_meta: StablecoinMeta, price: number) => ({ mcap: price * 1_000, supplySource: "onchain-total-supply", observedAt: CLOCK, chainCirculating: {} })),
  };
});

const CLOCK = 1_790_000_000;
const openDatabases: Array<{ close(): void }> = [];
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(CLOCK * 1000); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

function harness(id: string) {
  const sqlite = createLatestSchemaSqlite().sqlite;
  openDatabases.push(sqlite);
  const db = createSqliteD1(sqlite);
  const meta = ACTIVE_META_BY_ID.get(id)!;
  const config = meta.liveReservesConfig!;
  const fingerprint = computeLiveReserveConfigFingerprint(config);
  sqlite.prepare(`INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source, attempt_id, metadata, config_fingerprint)
    VALUES (?, '[]', ?, ?, 'success', ?, ?)`).run(id, CLOCK - 60, config.adapter, JSON.stringify({ navPerToken: 1.23, sourceTimestamp: CLOCK - 60 }), fingerprint);
  sqlite.prepare(`INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at, last_status, last_attempt_id, last_success_attempt_id, config_fingerprint)
    VALUES (?, ?, 'test', ?, ?, 'ok', 'success', 'success', ?)`).run(id, config.adapter, CLOCK - 60, CLOCK - 60, fingerprint);
  const plan: PrimaryPricePlan = {
    candidates: [{ id, name: meta.name, symbol: meta.symbol, navToken: true, pegType: "peggedUSD" }],
    nowSec: CLOCK, dexRows: new Map(), dexPriceSources: new Map(),
    dexPriceSourceTelemetry: createDexPriceSourceLoadTelemetry(),
    geckoIds: [], coinbaseSymbols: [], krakenSymbols: [], shouldFetchBitstamp: false, redstoneSymbols: [], navPriceIds: [id],
    sourceAllowed: { cg: false, cgTicker: false, binance: false, kraken: false, bitstamp: false, coinbase: false, redstone: false, curve: false, curveOracle: false },
  };
  return { sqlite, db, meta, config, plan };
}

interface NavConsumerInputs { db: D1Database; meta: StablecoinMeta; plan: PrimaryPricePlan }

async function assertBothConsumers(h: NavConsumerInputs, admitted: boolean) {
  const supplyQuote = await loadReserveNavSupplyPrice(h.meta, h.db, CLOCK);
  const { quoteMaps } = await collectPrimaryProviderQuotes({ db: h.db, plan: h.plan });
  const primaryQuote = quoteMaps.navPrices.get(h.meta.id);
  if (admitted) {
    expect(supplyQuote).toMatchObject({ price: 1.23, observedAt: CLOCK - 60 });
    expect(primaryQuote).toMatchObject({ price: 1.23, observedAt: CLOCK - 60 });
  } else {
    expect(supplyQuote).toBeNull();
    expect(primaryQuote).toBeUndefined();
  }
  if (h.meta.detailProvider === "coingecko") {
    const supplemental = await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined, h.db);
    expect(supplemental.some((asset) => asset.id === h.meta.id)).toBe(admitted);
    if (admitted) expect(supplemental.find((asset) => asset.id === h.meta.id)?.circulating).toEqual({ peggedUSD: 1_230 });
  }
}

describe.each(["usyc-hashnote", "ustb-superstate"])("current reserve NAV snapshot binding for %s", (id) => {
  it("admits a matching binding for primary prices and supplemental native supply", async () => {
    await assertBothConsumers(harness(id), true);
  });

  it("rejects time-fresh evidence from prior params with the same adapter", async () => {
    const h = harness(id);
    const prior = { ...h.config, params: { ...h.config.params, oracleAddress: "0x0000000000000000000000000000000000000001" } };
    h.sqlite.prepare("UPDATE reserve_composition SET config_fingerprint = ?").run(computeLiveReserveConfigFingerprint(prior));
    await assertBothConsumers(h, false);
  });

  it.each([null, "", "a".repeat(63), "G".repeat(64)])("rejects missing or malformed snapshot fingerprints: %s", async (fingerprint) => {
    const h = harness(id);
    h.sqlite.prepare("UPDATE reserve_composition SET config_fingerprint = ?").run(fingerprint);
    await assertBothConsumers(h, false);
  });

  it.each([
    "last_success_attempt_id = 'different'", "last_success_attempt_id = NULL", "last_success_attempt_id = ''", "last_success_at = last_success_at - 1",
  ])("requires the successful snapshot/attempt linkage: %s", async (change) => {
    const h = harness(id);
    h.sqlite.exec(`UPDATE reserve_sync_state SET ${change}`);
    await assertBothConsumers(h, false);
  });

  it("retains a current successful binding after a later failed attempt", async () => {
    const h = harness(id);
    h.sqlite.prepare("UPDATE reserve_sync_state SET last_status = 'error', last_attempt_id = 'failed', last_attempted_at = ?, config_fingerprint = ?")
      .run(CLOCK, "b".repeat(64));
    await assertBothConsumers(h, true);
  });

  it("checks successful fetch age independently of fresh source NAV", async () => {
    const h = harness(id);
    const fetchedAt = CLOCK - LIVE_RESERVE_FRESHNESS_SEC - 1;
    h.sqlite.prepare("UPDATE reserve_composition SET fetched_at = ?").run(fetchedAt);
    h.sqlite.prepare("UPDATE reserve_sync_state SET last_success_at = ?").run(fetchedAt);
    await assertBothConsumers(h, false);
  });
});
