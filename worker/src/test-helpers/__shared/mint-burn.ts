import {
  mockD1,
  type MockD1Database,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts-types";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { isGrandfatheredMintBurnConfig } from "../../lib/mint-burn-publication";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnScanSegment } from "../../lib/mint-burn-pipeline/scan-coverage";

type MockRows = MockTableConfig["rows"];

export interface MintBurnScenarioRows {
  hourly?: MockRows;
  perCoinHourly?: MockRows;
  net7d?: MockRows;
  net30d?: MockRows;
  net90d?: MockRows;
  baseline?: MockRows;
  firstSeen?: MockRows;
  events?: MockRows;
  syncState?: MockRows;
  cronSnapshot?: MockRows;
  latestSuccessfulSync?: MockRows;
  scanCoverage?: MockRows;
}

export interface MintBurnCacheEntry {
  key: string;
  value: string;
  updatedAt?: number;
}

export type MintBurnStablecoinsCache =
  | string
  | { value: string; updatedAt?: number }
  | null;

export interface MintBurnScenarioOptions {
  nowSec?: number;
  rows?: MintBurnScenarioRows;
  stablecoinsCache?: MintBurnStablecoinsCache;
  flowCache?: MintBurnCacheEntry | MintBurnCacheEntry[];
  safetyCache?: MintBurnCacheEntry[];
  overrides?: MockTableConfig[];
}

function cacheRow(
  key: string,
  value: string,
  updatedAt: number,
): MockTableConfig {
  const row = { key, value, updated_at: updatedAt };
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [key],
    rows: [row],
    first: row,
  };
}

function cacheRowForStablecoins(
  value: MintBurnStablecoinsCache,
  nowSec: number,
): MockTableConfig {
  if (value == null) {
    return {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["stablecoins"],
      rows: [],
      first: null,
    };
  }

  const entry = typeof value === "string" ? { value } : value;
  return cacheRow("stablecoins", entry.value, entry.updatedAt ?? nowSec);
}

function normalizeCacheEntries(
  entries: MintBurnCacheEntry | MintBurnCacheEntry[] | undefined,
  nowSec: number,
): MockTableConfig[] {
  return (entries == null ? [] : Array.isArray(entries) ? entries : [entries]).map((entry) =>
    cacheRow(entry.key, entry.value, entry.updatedAt ?? nowSec),
  );
}

const DEFAULT_STABLECOINS_CACHE = JSON.stringify({
  peggedAssets: [
    {
      id: "usdt-tether",
      symbol: "USDT",
      circulating: { peggedUSD: 100_000_000_000 },
      chainCirculating: { Ethereum: { current: 100_000_000_000 } },
    },
  ],
});

/** New configs need explicit proof; defaults preserve the admitted legacy roster. */
export function makeMintBurnScanSegments(
  end: number, days = 90, configs: readonly MintBurnContractConfig[] = MINT_BURN_CONFIGS.filter(isGrandfatheredMintBurnConfig),
): Array<MintBurnScanSegment & Record<string, unknown>> {
  return configs.map((config) => ({
    config_key: mintBurnConfigKey(config), from_block: config.startBlock, to_block: config.startBlock + 1_000_000,
    from_timestamp: end - days * 86400, to_timestamp: end,
  }));
}

export function mintBurnScenario({
  nowSec = Math.floor(Date.now() / 1000),
  rows = {},
  stablecoinsCache = DEFAULT_STABLECOINS_CACHE,
  flowCache,
  safetyCache = [],
  overrides = [],
}: MintBurnScenarioOptions = {}): MockD1Database {
  const hourlyRows = rows.hourly ?? [];

  return mockD1([
    ...overrides,
    {
      match: "pharos:mint-burn-flows:window-rows",
      rows: hourlyRows,
    },
    {
      match: "SELECT chain_id, hour_ts, mint_count, burn_count",
      rows: rows.perCoinHourly ?? hourlyRows,
    },
    { match: "pharos:mint-burn-flows:net-7d", rows: rows.net7d ?? [] },
    { match: "pharos:mint-burn-flows:net-30d", rows: rows.net30d ?? [] },
    { match: "pharos:mint-burn-flows:net-90d", rows: rows.net90d ?? [] },
    { match: "pharos:mint-burn-flows:baseline-days", rows: rows.baseline ?? [] },
    { match: "pharos:mint-burn-flows:first-hour-seek", rows: rows.firstSeen ?? [] },
    { match: "FROM mint_burn_events", rows: rows.events ?? [] },
    { match: "FROM mint_burn_sync_state", rows: rows.syncState ?? [] },
    { match: "pharos:mint-burn-scan-coverage:read", rows: rows.scanCoverage ?? makeMintBurnScanSegments(Math.floor(nowSec / 3600) * 3600) },
    { match: "pharos:mint-burn-legacy-evidence", rows: [] },
    { match: "FROM mint_burn_admission", rows: [] },
    { match: "FROM mint_burn_publication_policy", rows: [] },
    {
      match: "SELECT started_at, status, metadata",
      rows: rows.cronSnapshot ?? [],
      first: rows.cronSnapshot?.[0] ?? null,
    },
    {
      match: "as started_at FROM cron_runs WHERE job = ?",
      rows: rows.latestSuccessfulSync ?? [{ started_at: null }],
      first: rows.latestSuccessfulSync?.[0] ?? null,
    },
    cacheRowForStablecoins(stablecoinsCache, nowSec),
    ...normalizeCacheEntries(flowCache, nowSec),
    ...safetyCache.map((entry) => cacheRow(entry.key, entry.value, entry.updatedAt ?? nowSec)),
    // A successful empty canonical-index join means no accepted publication.
    // Without this match mockD1 throws, incorrectly simulating a failed D1 read.
    { match: "i.value AS score_index", rows: [], first: null },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT INTO cache (key, value, updated_at)", rows: [] },
  ]);
}
