import { errorResponse, jsonResponse } from "../lib/api-response";
import { parseIntParam } from "../lib/api-params";
import {
  CONTRACT_CONFIGS,
  getBlacklistConfigsForSymbolAndChain,
} from "../lib/blacklist-contracts";
import { createBudget, createRateLimiter } from "../lib/evm-logs";
import {
  syncCurrentBalanceCacheForRows,
} from "../lib/blacklist/current-balance-cache";
import type { BlacklistRunBudget } from "../lib/blacklist/run-budget";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
} from "../lib/blacklist/run-budget";
import { BLACKLIST_PUBLIC_EVENT_SQL, type BlacklistRow } from "../lib/blacklist/shared";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { invalidateBlacklistDerivedCaches } from "../lib/blacklist-cache-invalidation";
import { blacklistEventOrderSql } from "@shared/lib/blacklist-event-order";
import { buildBlacklistAddressCountKey } from "@shared/lib/blacklist";
import { buildCurrentBalanceSnapshotRows } from "../lib/blacklist/row-preparation";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const RUNTIME_BUDGET_MS = 8 * 60_000;

/**
 * One-shot admin endpoint that backfills `blacklist_current_balances` for
 * stablecoins whose events were ingested before the current-balance-cache
 * feature existed (PAXG, PYUSD, XAUT, USD1).
 *
 * For each matching config it queries all blacklist_events, then feeds them
 * through `syncCurrentBalanceCacheForRows` — the same code path the hourly
 * cron uses for newly-fetched events.
 */
export interface BackfillBlacklistCurrentBalancesRouteContext {
  db: D1Database;
  url: URL;
  trustedAdmin: boolean;
  request: Request;
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export async function handleBackfillBlacklistCurrentBalances({
  db,
  url,
  chainRpcs,
}: BackfillBlacklistCurrentBalancesRouteContext): Promise<Response> {
  const stablecoinParam = url.searchParams.get("stablecoin")?.toUpperCase() ?? null;
  const chainIdParam = url.searchParams.get("chainId") ?? null;
  const parsedLimit = parseIntParam(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (parsedLimit instanceof Response) return parsedLimit;
  const limit = parsedLimit;
  const dryRun = url.searchParams.get("dryRun") === "true";

  const configs = CONTRACT_CONFIGS.filter((config) => {
    if (!ACTIVE_IDS.has(config.stablecoinId)) return false;
    if (stablecoinParam && config.stablecoin !== stablecoinParam) return false;
    if (chainIdParam && config.chain.chainId !== chainIdParam) return false;
    return true;
  });

  if (configs.length === 0) {
    return errorResponse(400, "No matching blacklist configs found");
  }

  const configResults: Array<{
    configKey: string;
    stablecoin: string;
    chainId: string;
    candidateCount: number;
    updated: number;
    deleted: number;
    failed: number;
    truncated: boolean;
    budgetExhausted: boolean;
    skippedDueBudget: number;
  }> = [];

  const budget = createBudget(900);
  const etherscanLimiter = createRateLimiter(4);
  const tronLimiter = createRateLimiter(3);
  const deadlineMs = Date.now() + RUNTIME_BUDGET_MS;
  let budgetExhausted = false;
  let skippedDueBudget = 0;

  for (const config of configs) {
    const runBudget = {
      subrequestBudget: budget,
      deadlineMs,
      minimumConfigWindowMs: 0,
    } satisfies BlacklistRunBudget;
    if (blacklistRuntimeBudgetReached(runBudget) || blacklistSubrequestBudgetReached(runBudget)) {
      budgetExhausted = true;
      skippedDueBudget += 1;
      continue;
    }

    const sameSymbolChainConfigs = getBlacklistConfigsForSymbolAndChain(
      config.stablecoin,
      config.chain.chainId,
    );
    const allowLegacyUnscopedFallback = sameSymbolChainConfigs.length === 1;
    const rows = await db
      .prepare(
        `WITH scoped AS (
           SELECT *
           FROM blacklist_events
           WHERE stablecoin = ? AND chain_id = ?
             AND ${BLACKLIST_PUBLIC_EVENT_SQL}
             AND (
               config_key = ?
               OR (config_key IS NULL AND LOWER(contract_address) = LOWER(?))
               OR (? = 1 AND config_key IS NULL AND contract_address IS NULL)
             )
         ),
         candidate_addresses AS (
           SELECT LOWER(address) AS identity, MAX(timestamp) AS latest_timestamp
           FROM scoped
           GROUP BY LOWER(address)
           ORDER BY MAX(timestamp) DESC, identity
           LIMIT ?
         )
         SELECT scoped.*
         FROM scoped
         ${config.chain.type === "tron"
           ? `ORDER BY timestamp DESC, block_number DESC`
           : `JOIN candidate_addresses ON LOWER(scoped.address) = candidate_addresses.identity
              ORDER BY candidate_addresses.latest_timestamp DESC, candidate_addresses.identity,
                       ${blacklistEventOrderSql("ASC")}`}`,
      )
      .bind(
        config.stablecoin,
        config.chain.chainId,
        config.configKey,
        config.contractAddress,
        allowLegacyUnscopedFallback ? 1 : 0,
        limit + 1,
      )
      .all<BlacklistRow>();
    const selectedRows = rows.results ?? [];
    const candidateKeys = new Set<string>();
    for (const row of selectedRows) {
      candidateKeys.add(buildBlacklistAddressCountKey(row.stablecoin, row.chain_id, row.address));
    }
    const configTruncated = candidateKeys.size > limit;
    const admittedKeys = new Set([...candidateKeys].slice(0, limit));
    const candidateRows = selectedRows.filter((row) =>
      admittedKeys.has(buildBlacklistAddressCountKey(row.stablecoin, row.chain_id, row.address)));
    const snapshotRows = buildCurrentBalanceSnapshotRows(candidateRows);
    const candidateCount = snapshotRows.filter((row) => row.event_type !== "unblacklist").length;

    if (!candidateRows.length) {
      configResults.push({
        configKey: config.configKey,
        stablecoin: config.stablecoin,
        chainId: config.chain.chainId,
        candidateCount: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        truncated: false,
        budgetExhausted: false,
        skippedDueBudget: 0,
      });
      continue;
    }

    if (dryRun) {
      // Use the exact execution fold, including retained release history and
      // withholding of unconfirmed cross-transaction Tron state.
      configResults.push({
        configKey: config.configKey,
        stablecoin: config.stablecoin,
        chainId: config.chain.chainId,
        candidateCount,
        updated: 0,
        deleted: 0,
        failed: 0,
        truncated: configTruncated,
        budgetExhausted: false,
        skippedDueBudget: 0,
      });
      continue;
    }

    const result = await syncCurrentBalanceCacheForRows(db, config, candidateRows, {
      etherscanApiKey: null,
      drpcApiKey: null,
      trongridApiKey: null,
      etherscanLimiter,
      tronLimiter,
      runBudget,
      latestRows: snapshotRows,
      signal: undefined,
      chainRpcs,
    });
    budgetExhausted ||= result.budgetExhausted;
    skippedDueBudget += result.skippedDueBudget;

    configResults.push({
      configKey: config.configKey,
      stablecoin: config.stablecoin,
      chainId: config.chain.chainId,
      candidateCount,
      updated: result.updated,
      deleted: "deleted" in result && typeof result.deleted === "number" ? result.deleted : 0,
      failed: result.failed,
      truncated: configTruncated,
      budgetExhausted: result.budgetExhausted,
      skippedDueBudget: result.skippedDueBudget,
    });

    if (Date.now() >= deadlineMs) {
      budgetExhausted = true;
      skippedDueBudget += configs.length - configResults.length;
      break;
    }
  }


  const totals = configResults.reduce(
    (acc, r) => ({
      candidates: acc.candidates + r.candidateCount,
      updated: acc.updated + r.updated,
      deleted: acc.deleted + r.deleted,
      failed: acc.failed + r.failed,
      skippedDueBudget: acc.skippedDueBudget + r.skippedDueBudget,
    }),
    { candidates: 0, updated: 0, deleted: 0, failed: 0, skippedDueBudget: 0 },
  );

  return jsonResponse({
    ok: true,
    dryRun,
    configs: configResults,
    totals,
    truncated: configResults.some((result) => result.truncated),
    budgetExhausted,
    skippedDueBudget,
    budgetUsed: budget.count,
    budgetLimit: budget.limit,
    cacheInvalidation: !dryRun
      ? await invalidateBlacklistDerivedCaches(db)
      : { attempted: 0, deleted: 0, failed: 0 },
  });
}
