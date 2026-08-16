import { getBlacklistPriceAssetId } from "@shared/lib/blacklist";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { buildInClause } from "../../lib/db";
import { type RateLimitedFetch } from "../../lib/evm-logs";
import { type ChainRpcConfig } from "../../lib/chain-registry";
import { syncCurrentBalanceCacheForRows } from "../../lib/blacklist/current-balance-cache";
import { type BlacklistRow, shouldSuppressAsMirrorZero } from "../../lib/blacklist/shared";
import { enrichRowBalances } from "../../lib/blacklist/amount-recovery";
import { insertBlacklistRows } from "./persistence";
import { type BlacklistRunBudget } from "../../lib/blacklist/run-budget";
import { throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import {
  buildCurrentBalanceSnapshotRows,
  buildLatestBlacklistRows,
  fetchBlacklistAssetPriceFromCache,
} from "../../lib/blacklist/row-preparation";

type BlacklistConfig = (typeof CONTRACT_CONFIGS)[number];
// D1's practical SQL-variable ceiling can be lower than the nominal 100.
const EXISTING_BLACKLIST_ID_QUERY_CHUNK = 90;

export interface BlacklistPostFetchCounters {
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface CurrentBalanceCacheCounters {
  updated: number;
  failed: number;
}

interface ProcessFetchedBlacklistRowsOptions {
  db: D1Database;
  config: BlacklistConfig;
  rows: BlacklistRow[];
  chainLabel: "evm" | "tron";
  etherscanApiKey: string | null;
  drpcApiKey: string | null;
  trongridApiKey: string | null;
  etherscanLimiter: RateLimitedFetch;
  tronLimiter: RateLimitedFetch;
  runBudget: BlacklistRunBudget;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

async function filterNewBlacklistRows(
  db: D1Database,
  rows: BlacklistRow[],
  signal?: AbortSignal,
): Promise<BlacklistRow[]> {
  if (rows.length === 0) return rows;

  const existingIds = new Set<string>();
  for (let i = 0; i < rows.length; i += EXISTING_BLACKLIST_ID_QUERY_CHUNK) {
    throwIfAborted(signal);
    const ids = rows.slice(i, i + EXISTING_BLACKLIST_ID_QUERY_CHUNK).map((row) => row.id);
    const { sql, binds } = buildInClause(ids);
    const result = await runWithOverloadRetry(() => db
        .prepare(`/* blacklist-post-fetch-existing-id-filter */ SELECT id FROM blacklist_events WHERE id IN (${sql})`)
        .bind(...binds)
        .all<{ id: string }>(),
      3,
      signal,
    );
    throwIfAborted(signal);
    for (const row of result.results ?? []) {
      existingIds.add(row.id);
    }
  }

  return rows.filter((row) => !existingIds.has(row.id));
}

function filterCacheRepairLedgerRows(rows: BlacklistRow[]): BlacklistRow[] {
  return rows.filter(
    (row) =>
      row.suppression_reason == null
      && (row.event_type === "unblacklist"
        || !shouldSuppressAsMirrorZero(row.stablecoin, row.event_type, row.amount_native)),
  );
}

async function fetchLatestKnownRepairRows(
  db: D1Database,
  rows: BlacklistRow[],
  signal?: AbortSignal,
): Promise<BlacklistRow[]> {
  if (rows.length === 0) return [];

  const seenKeys = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const key = `${row.stablecoin}:${row.chain_id}:${row.config_key}:${(row.contract_address ?? "").toLowerCase()}:${row.address.toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    statements.push(
      db.prepare(`
        SELECT * FROM blacklist_events
        WHERE stablecoin = ?
          AND chain_id = ?
          AND config_key = ?
          AND lower(contract_address) = lower(?)
          AND lower(address) = lower(?)
        ORDER BY timestamp DESC, id DESC
        LIMIT 1
      `).bind(
        row.stablecoin,
        row.chain_id,
        row.config_key,
        row.contract_address,
        row.address,
      ),
    );
  }

  const results: D1Result[] = [];
  for (let i = 0; i < statements.length; i += D1_BATCH_SIZE) {
    throwIfAborted(signal);
    results.push(...await runWithOverloadRetry(
      () => db.batch(statements.slice(i, i + D1_BATCH_SIZE)),
      3,
      signal,
    ));
    throwIfAborted(signal);
  }
  return results
    .map((result) => (result as { results?: BlacklistRow[] }).results?.[0])
    .filter((row): row is BlacklistRow => row != null && row.suppression_reason == null);
}

export async function processFetchedBlacklistRows(
  options: ProcessFetchedBlacklistRowsOptions,
): Promise<{
  insertedRows: number;
  enrichCounters: BlacklistPostFetchCounters;
  currentBalanceCacheCounters: CurrentBalanceCacheCounters;
}> {
  const newRows = await filterNewBlacklistRows(options.db, options.rows, options.signal);
  const newRowIds = new Set(newRows.map((row) => row.id));
  const duplicateRows = options.rows.filter((row) => !newRowIds.has(row.id));
  const duplicateCount = options.rows.length - newRows.length;
  if (duplicateCount > 0) {
    console.log(
      `[sync-blacklist] Skipping ${duplicateCount} previously ingested row(s) before enrichment/cache sync`,
    );
  }

  if (newRows.length === 0) {
    const duplicateLedgerRows = filterCacheRepairLedgerRows(duplicateRows);
    if (duplicateLedgerRows.length > 0) {
      const latestKnownRepairRows = await fetchLatestKnownRepairRows(options.db, duplicateLedgerRows, options.signal);
      const assetPriceUsd = getBlacklistPriceAssetId(options.config.stablecoin)
        ? await fetchBlacklistAssetPriceFromCache(options.db, options.config.stablecoin)
        : null;
      const currentBalanceCacheCounters = await syncCurrentBalanceCacheForRows(
        options.db,
        options.config,
        duplicateLedgerRows,
        {
          etherscanApiKey: options.etherscanApiKey,
          drpcApiKey: options.drpcApiKey,
          trongridApiKey: options.trongridApiKey,
          etherscanLimiter: options.etherscanLimiter,
          tronLimiter: options.tronLimiter,
          runBudget: options.runBudget,
          signal: options.signal,
          chainRpcs: options.chainRpcs,
          assetPriceUsd,
          latestRows: buildLatestBlacklistRows([...duplicateLedgerRows, ...latestKnownRepairRows]),
        },
      );
      return {
        insertedRows: 0,
        enrichCounters: { attempted: 0, succeeded: 0, failed: 0 },
        currentBalanceCacheCounters,
      };
    }
    return {
      insertedRows: 0,
      enrichCounters: { attempted: 0, succeeded: 0, failed: 0 },
      currentBalanceCacheCounters: { updated: 0, failed: 0 },
    };
  }

  const assetPriceUsd = getBlacklistPriceAssetId(options.config.stablecoin)
    ? await fetchBlacklistAssetPriceFromCache(options.db, options.config.stablecoin)
    : null;

  const enrichCounters = await enrichRowBalances({
    rows: newRows,
    config: options.config,
    etherscanApiKey: options.etherscanApiKey,
    drpcApiKey: options.drpcApiKey,
    etherscanLimiter: options.etherscanLimiter,
    runBudget: options.runBudget,
    signal: options.signal,
    chainRpcs: options.chainRpcs,
    assetPriceUsd,
  });

  for (const row of newRows) {
    if (shouldSuppressAsMirrorZero(row.stablecoin, row.event_type, row.amount_native)) {
      row.suppression_reason = "circle_mirror_zero_balance";
      row.amount_status = "permanently_unavailable";
    }
  }
  console.log(
    `[sync-blacklist] enrichRowBalances (${options.chainLabel}): attempted=${enrichCounters.attempted} succeeded=${enrichCounters.succeeded} failed=${enrichCounters.failed}`,
  );

  const insertedRows = await insertBlacklistRows(options.db, newRows, options.signal);
  const ledgerRows = newRows.filter((row) => row.suppression_reason == null);
  const duplicateLedgerRows = filterCacheRepairLedgerRows(duplicateRows);
  const latestKnownRepairRows = await fetchLatestKnownRepairRows(options.db, duplicateLedgerRows);
  const cacheSyncRows = [...ledgerRows, ...duplicateLedgerRows];
  const latestLedgerRows = [
    ...buildCurrentBalanceSnapshotRows(ledgerRows),
    ...buildLatestBlacklistRows([...duplicateLedgerRows, ...latestKnownRepairRows]),
  ];
  const currentBalanceCacheCounters = await syncCurrentBalanceCacheForRows(
    options.db,
    options.config,
    cacheSyncRows,
    {
      etherscanApiKey: options.etherscanApiKey,
      drpcApiKey: options.drpcApiKey,
      trongridApiKey: options.trongridApiKey,
      etherscanLimiter: options.etherscanLimiter,
      tronLimiter: options.tronLimiter,
      runBudget: options.runBudget,
      signal: options.signal,
      chainRpcs: options.chainRpcs,
      assetPriceUsd,
      latestRows: latestLedgerRows,
    },
  );

  return {
    insertedRows,
    enrichCounters,
    currentBalanceCacheCounters,
  };
}
