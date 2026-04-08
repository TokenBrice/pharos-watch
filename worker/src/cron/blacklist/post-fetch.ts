import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { buildInClause } from "../../lib/db";
import { type RateLimitedFetch, type SubrequestBudget } from "../../lib/evm-logs";
import { type ChainRpcConfig } from "../../lib/chain-registry";
import { syncCurrentBalanceCacheForRows, fetchGoldPriceFromCache } from "./current-balance-cache";
import type { BlacklistRow } from "./shared";
import { enrichRowBalances } from "./amount-recovery";
import { insertBlacklistRows } from "./persistence";

type BlacklistConfig = (typeof CONTRACT_CONFIGS)[number];
const EXISTING_BLACKLIST_ID_QUERY_CHUNK = 200;

export interface BlacklistPostFetchCounters {
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface CurrentBalanceCacheCounters {
  updated: number;
  deleted: number;
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
  budget: SubrequestBudget;
  deadlineMs: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

async function filterNewBlacklistRows(
  db: D1Database,
  rows: BlacklistRow[],
): Promise<BlacklistRow[]> {
  if (rows.length === 0) return rows;

  const existingIds = new Set<string>();
  for (let i = 0; i < rows.length; i += EXISTING_BLACKLIST_ID_QUERY_CHUNK) {
    const ids = rows.slice(i, i + EXISTING_BLACKLIST_ID_QUERY_CHUNK).map((row) => row.id);
    const { sql, binds } = buildInClause(ids);
    const result = await db
      .prepare(`SELECT id FROM blacklist_events WHERE id IN (${sql})`)
      .bind(...binds)
      .all<{ id: string }>();
    for (const row of result.results ?? []) {
      existingIds.add(row.id);
    }
  }

  return rows.filter((row) => !existingIds.has(row.id));
}

export async function processFetchedBlacklistRows(
  options: ProcessFetchedBlacklistRowsOptions,
): Promise<{
  insertedRows: number;
  enrichCounters: BlacklistPostFetchCounters;
  currentBalanceCacheCounters: CurrentBalanceCacheCounters;
}> {
  const newRows = await filterNewBlacklistRows(options.db, options.rows);
  const duplicateCount = options.rows.length - newRows.length;
  if (duplicateCount > 0) {
    console.log(
      `[sync-blacklist] Skipping ${duplicateCount} previously ingested row(s) before enrichment/cache sync`,
    );
  }

  if (newRows.length === 0) {
    return {
      insertedRows: 0,
      enrichCounters: { attempted: 0, succeeded: 0, failed: 0 },
      currentBalanceCacheCounters: { updated: 0, deleted: 0, failed: 0 },
    };
  }

  const goldPriceUsd = isGoldBlacklistStablecoin(options.config.stablecoin)
    ? await fetchGoldPriceFromCache(options.db, options.config.stablecoin)
    : null;

  const enrichCounters = await enrichRowBalances(
    newRows,
    options.config,
    options.etherscanApiKey,
    options.drpcApiKey,
    options.etherscanLimiter,
    options.budget,
    options.deadlineMs,
    options.signal,
    options.chainRpcs,
    goldPriceUsd,
  );
  console.log(
    `[sync-blacklist] enrichRowBalances (${options.chainLabel}): attempted=${enrichCounters.attempted} succeeded=${enrichCounters.succeeded} failed=${enrichCounters.failed}`,
  );

  const insertedRows = await insertBlacklistRows(options.db, newRows);
  const currentBalanceCacheCounters = await syncCurrentBalanceCacheForRows(
    options.db,
    options.config,
    newRows,
    {
      etherscanApiKey: options.etherscanApiKey,
      drpcApiKey: options.drpcApiKey,
      trongridApiKey: options.trongridApiKey,
      etherscanLimiter: options.etherscanLimiter,
      tronLimiter: options.tronLimiter,
      budget: options.budget,
      deadlineMs: options.deadlineMs,
      signal: options.signal,
      chainRpcs: options.chainRpcs,
    },
  );

  return {
    insertedRows,
    enrichCounters,
    currentBalanceCacheCounters,
  };
}
