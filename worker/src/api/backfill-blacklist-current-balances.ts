import { errorResponse, jsonResponse, parseIntParam } from "../lib/api-utils";
import { CONTRACT_CONFIGS } from "../lib/blacklist-contracts";
import { createBudget, createRateLimiter } from "../lib/evm-logs";
import {
  syncCurrentBalanceCacheForRows,
} from "../cron/blacklist/current-balance-cache";
import { backfillTronFromLedger } from "../cron/blacklist/amount-recovery";
import type { BlacklistRunBudget } from "../cron/blacklist/run-budget";
import type { BlacklistRow } from "../cron/blacklist/shared";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { runAdminRoute } from "../lib/route-wrappers";
import { FROZEN_IDS } from "@shared/lib/stablecoins";

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
      const limit = parseIntParam(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
      const dryRun = url.searchParams.get("dryRun") === "true";

      const configs = CONTRACT_CONFIGS.filter((config) => {
        if (FROZEN_IDS.has(config.stablecoinId)) return false;
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
      }> = [];

      const budget = createBudget(900);
      const etherscanLimiter = createRateLimiter(4);
      const tronLimiter = createRateLimiter(3);
      const deadlineMs = Date.now() + RUNTIME_BUDGET_MS;

      for (const config of configs) {
        const rows = await db
          .prepare(
            `SELECT * FROM blacklist_events
             WHERE stablecoin = ? AND chain_id = ?
               AND suppression_reason IS NULL
             ORDER BY timestamp ASC, id ASC
             LIMIT ?`,
          )
          .bind(config.stablecoin, config.chain.chainId, limit)
          .all<BlacklistRow>();

        if (!rows.results.length) {
          configResults.push({
            configKey: config.configKey,
            stablecoin: config.stablecoin,
            chainId: config.chain.chainId,
            candidateCount: 0,
            updated: 0,
            deleted: 0,
            failed: 0,
          });
          continue;
        }

        if (dryRun) {
          const latestByAddress = new Map<string, BlacklistRow>();
          const ordered = [...rows.results].sort((a, b) =>
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
          });
          continue;
        }

        const result = await syncCurrentBalanceCacheForRows(db, config, rows.results, {
          etherscanApiKey: null,
          drpcApiKey: null,
          trongridApiKey: null,
          etherscanLimiter,
          tronLimiter,
          runBudget: {
            subrequestBudget: budget,
            deadlineMs,
            minimumConfigWindowMs: 0,
          } satisfies BlacklistRunBudget,
          signal: undefined,
          chainRpcs,
        });

        configResults.push({
          configKey: config.configKey,
          stablecoin: config.stablecoin,
          chainId: config.chain.chainId,
          candidateCount: rows.results.length,
          updated: result.updated,
          deleted: result.deleted,
          failed: result.failed,
        });

        if (Date.now() >= deadlineMs) break;
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
        }),
        { candidates: 0, updated: 0, deleted: 0, failed: 0 },
      );

      return jsonResponse({
        ok: true,
        dryRun,
        configs: configResults,
        totals,
        budgetUsed: budget.count,
        budgetLimit: budget.limit,
      });
    },
  );
}
