import { errorResponse, jsonResponse, parseIntParam } from "../lib/api-utils";
import {
  CONTRACT_CONFIGS,
  getBlacklistConfigsForSymbolAndChain,
} from "../lib/blacklist-contracts";
import { createBudget, createRateLimiter } from "../lib/evm-logs";
import {
  syncCurrentBalanceCacheForRows,
} from "../cron/blacklist/current-balance-cache";
import { backfillTronFromLedger } from "../cron/blacklist/amount-recovery";
import type { BlacklistRunBudget } from "../cron/blacklist/run-budget";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
} from "../cron/blacklist/run-budget";
import type { BlacklistRow } from "../cron/blacklist/shared";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { runAdminRoute } from "../lib/route-wrappers";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";

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
export async function handleBackfillBlacklistCurrentBalances(
  db: D1Database,
  url: URL,
  trustedAdmin: boolean,
  request: Request,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "backfill-blacklist-current-balances",
      request,
      trustedAdmin,
    },
    async () => {
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
                 AND suppression_reason IS NULL
                 AND (
                   config_key = ?
                   OR (config_key IS NULL AND LOWER(contract_address) = LOWER(?))
                   OR (? = 1 AND config_key IS NULL AND contract_address IS NULL)
                 )
             ),
             ranked AS (
               SELECT *,
                      ROW_NUMBER() OVER (
                        PARTITION BY LOWER(address)
                        ORDER BY timestamp DESC, id DESC
                      ) AS rn
               FROM scoped
             )
             SELECT *
             FROM ranked
             WHERE rn = 1
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
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
        const configTruncated = selectedRows.length > limit;
        const candidateRows = selectedRows.slice(0, limit);

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
          const latestByAddress = new Map<string, BlacklistRow>();
          const ordered = [...candidateRows].sort((a, b) =>
            a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp - b.timestamp,
          );
          for (const row of ordered) {
            latestByAddress.set(row.address.toLowerCase(), row);
          }
          const activeBlacklisted = [...latestByAddress.values()].filter(
            (r) => r.event_type === "blacklist" || r.event_type === "destroy",
          );
          configResults.push({
            configKey: config.configKey,
            stablecoin: config.stablecoin,
            chainId: config.chain.chainId,
            candidateCount: activeBlacklisted.length,
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
          signal: undefined,
          chainRpcs,
        });
        budgetExhausted ||= result.budgetExhausted;
        skippedDueBudget += result.skippedDueBudget;

        configResults.push({
          configKey: config.configKey,
          stablecoin: config.stablecoin,
          chainId: config.chain.chainId,
          candidateCount: candidateRows.length,
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

      if (!dryRun) {
        // Keep admin remediation aligned with the cron path: once current
        // balances exist for Tron rows, reapply the ledger mirror so matching
        // blacklist_events resolve immediately instead of waiting for another
        // scheduled sync.
        await backfillTronFromLedger(db);
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
      });
    },
  );
}
