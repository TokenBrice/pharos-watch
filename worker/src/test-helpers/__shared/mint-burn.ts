import {
  mockD1,
  type MockD1Database,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import type {
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfig,
  MintBurnEventDef,
} from "../../lib/mint-burn-contracts";

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
    },
  ],
});

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
    {
      match: "SELECT started_at, status, metadata",
      rows: rows.cronSnapshot ?? [],
      first: rows.cronSnapshot?.[0] ?? null,
    },
    {
      match: "MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
      rows: rows.latestSuccessfulSync ?? [{ started_at: null }],
      first: rows.latestSuccessfulSync?.[0] ?? null,
    },
    cacheRowForStablecoins(stablecoinsCache, nowSec),
    ...normalizeCacheEntries(flowCache, nowSec),
    ...safetyCache.map((entry) => cacheRow(entry.key, entry.value, entry.updatedAt ?? nowSec)),
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT INTO cache (key, value, updated_at)", rows: [] },
  ]);
}

export interface MakeMintBurnConfigOverrides {
  chain?: Partial<MintBurnContractConfig["chain"]>;
  asset?: Partial<
    Pick<
      MintBurnContractConfig,
      | "stablecoinId"
      | "symbol"
      | "contractAddress"
      | "decimals"
      | "dustThreshold"
      | "startBlock"
      | "enabled"
      | "tier"
      | "startBlockSource"
      | "startBlockConfidence"
    >
  >;
  adapter?: MintBurnContractConfig["adapterKind"];
  events?: MintBurnEventDef[];
  bridgeDetection?: MintBurnBridgeDetectionConfig | null;
}

const DEFAULT_MINT_BURN_CHAIN: MintBurnContractConfig["chain"] = {
  chainId: "ethereum",
  chainName: "Ethereum",
  evmChainId: 1,
  explorerUrl: "https://etherscan.io",
  type: "evm",
};

const DEFAULT_MINT_BURN_ASSET: Pick<
  MintBurnContractConfig,
  | "stablecoinId"
  | "symbol"
  | "contractAddress"
  | "decimals"
  | "dustThreshold"
  | "startBlock"
  | "startBlockSource"
  | "startBlockConfidence"
> = {
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  contractAddress: "0x0000000000000000000000000000000000000001",
  decimals: 6,
  dustThreshold: 10_000,
  startBlock: 21_900_000,
  startBlockSource: "reviewed-contract-specific",
  startBlockConfidence: "high",
};

export function makeMintBurnConfig({
  chain,
  asset,
  adapter = "transfer-zero-address",
  events = [],
  bridgeDetection,
}: MakeMintBurnConfigOverrides = {}): MintBurnContractConfig {
  return {
    chain: { ...DEFAULT_MINT_BURN_CHAIN, ...chain },
    ...DEFAULT_MINT_BURN_ASSET,
    ...asset,
    adapterKind: adapter,
    events,
    ...(bridgeDetection ? { bridgeDetection } : {}),
  };
}
