import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { type RateLimitedFetch, type SubrequestBudget } from "../../lib/evm-logs";
import { type ChainRpcConfig } from "../../lib/chain-registry";
import { syncCurrentBalanceCacheForRows } from "./current-balance-cache";
import type { BlacklistRow } from "./shared";
import { enrichRowBalances } from "./amount-recovery";
import { insertBlacklistRows } from "./persistence";

type BlacklistConfig = (typeof CONTRACT_CONFIGS)[number];

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

export async function processFetchedBlacklistRows(
  options: ProcessFetchedBlacklistRowsOptions,
): Promise<{
  insertedRows: number;
  enrichCounters: BlacklistPostFetchCounters;
  currentBalanceCacheCounters: CurrentBalanceCacheCounters;
}> {
  const enrichCounters = await enrichRowBalances(
    options.rows,
    options.config,
    options.etherscanApiKey,
    options.drpcApiKey,
    options.etherscanLimiter,
    options.budget,
    options.deadlineMs,
    options.signal,
    options.chainRpcs,
  );
  console.log(
    `[sync-blacklist] enrichRowBalances (${options.chainLabel}): attempted=${enrichCounters.attempted} succeeded=${enrichCounters.succeeded} failed=${enrichCounters.failed}`,
  );

  const insertedRows = await insertBlacklistRows(options.db, options.rows);
  const currentBalanceCacheCounters = await syncCurrentBalanceCacheForRows(
    options.db,
    options.config,
    options.rows,
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
