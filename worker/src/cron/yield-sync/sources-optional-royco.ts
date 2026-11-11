import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import { normalizeChainId } from "@shared/types/chain-identity";
import { throwIfAborted } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { logWorkerEvent } from "../../lib/structured-log";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import { buildTrackedYieldAssetIndex } from "./identity";
import { resolveVaultDepositToken } from "./optional-source-identity";
import {
  createOptionalSourceBudget,
  OPTIONAL_PROTOCOL_API_BUDGET_MS,
  OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
} from "./sources-rpc";
import type { ResolvedYieldCandidate } from "./types";

import { buildTrancheCandidate, type RoycoMarket } from "./optional-royco-model";
interface RoycoExploreResponse { data?: RoycoMarket[]; count?: number }

const ROYCO_DAWN_EXPLORE_URL = "https://dawn.royco.org/api/v1/ecosystem/explore";
const ROYCO_DAWN_PAGE_SIZE = 100;
const ROYCO_DAWN_MIN_MARKET_TVL_USD = 100_000;
const ROYCO_DAWN_DETAIL_CONCURRENCY = getCronJobMeta("sync-yield-supplemental")!.maxConnections!;

function buildExploreBody(pageIndex: number): string {
  return JSON.stringify({
    page: {
      index: pageIndex,
      size: ROYCO_DAWN_PAGE_SIZE,
    },
    filters: [
      {
        id: "listingType",
        value: "verified",
        condition: "eq",
      },
    ],
    sorting: [
      {
        id: "totalTvl",
        desc: true,
      },
    ],
  });
}

export interface RoycoDawnSourceResult {
  candidates: ResolvedYieldCandidate[];
  /**
   * SRC-SUPP-2: true when the paginated walk ended early — a non-ok page
   * response or a thrown fetch. The caller must retain the previous snapshot
   * instead of replacing it with this partial list.
   */
  degraded: boolean;
}

export async function fetchRoycoDawnSources(signal?: AbortSignal): Promise<RoycoDawnSourceResult> {
  const budget = createOptionalSourceBudget("Royco Dawn sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const trackedByAddress = buildTrackedYieldAssetIndex(ACTIVE_STABLECOINS, YIELD_VARIANT_MAP);
  const observedAt = Math.floor(Date.now() / 1000);
  const results: ResolvedYieldCandidate[] = [];

  try {
    let pageIndex = 1;
    while (!budget.budgetController.signal.aborted) {
      throwIfAborted(budget.budgetController.signal);
      const result = await fetchJsonWithRetry<RoycoExploreResponse>(
        ROYCO_DAWN_EXPLORE_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: buildExploreBody(pageIndex),
          signal: budget.signal,
        },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      );
      if (!result?.response.ok) return { candidates: results, degraded: true };

      const body = result.body;
      if (!Array.isArray(body.data)) return { candidates: results, degraded: true };
      const markets = body.data;
      if (markets.length === 0) break;

      const detailTargets: Array<{ discovery: RoycoMarket; chain: string; marketId: string }> = [];
      for (const discovery of markets) {
        const chain = normalizeChainId(discovery.chainId);
        if (!chain || discovery.majorType !== "marketv2" || discovery.listingType !== "verified") continue;
        const marketId = discovery.marketId;
        if (!marketId?.trim()) return { candidates: results, degraded: true };
        detailTargets.push({ discovery, chain, marketId });
      }

      for (let offset = 0; offset < detailTargets.length; offset += ROYCO_DAWN_DETAIL_CONCURRENCY) {
        throwIfAborted(budget.budgetController.signal);
        const details = await Promise.all(
          detailTargets.slice(offset, offset + ROYCO_DAWN_DETAIL_CONCURRENCY).map(async ({ discovery, chain, marketId }) => {
            // The ecosystem snapshot mixes Day and Dawn and reports TVL in native NAV units.
            // Use it only for discovery; the detail endpoint preserves Dawn's USD/risk schema.
            const detail = await fetchJsonWithRetry<RoycoMarket>(
              `https://dawn.royco.org/api/v1/market/info/${discovery.chainId}/${encodeURIComponent(marketId)}`,
              { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
              0,
              { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
            );
            return { discovery, chain, marketId, detail };
          }),
        );

        for (const { discovery, chain, marketId, detail } of details) {
          if (!detail?.response.ok) return { candidates: results, degraded: true };
          const market = detail.body;
          if (
            market.chainId !== discovery.chainId ||
            market.marketId?.toLowerCase() !== marketId.toLowerCase() ||
            market.majorType !== "marketv2"
          ) {
            return { candidates: results, degraded: true };
          }
          const marketTvlUsd = finiteNumber(market.tvlUsd);
          if (marketTvlUsd == null || marketTvlUsd < ROYCO_DAWN_MIN_MARKET_TVL_USD) continue;
          if (market.listingType !== "verified") continue;

          for (const side of ["senior", "junior"] as const) {
            const vault = (side === "senior" ? market.seniorVault : market.juniorVault) ?? null;
            if (!vault) continue;
            const trackedAsset = resolveVaultDepositToken(vault, chain, trackedByAddress);
            if (!trackedAsset) continue;
            const candidate = buildTrancheCandidate({
              side,
              market,
              vault,
              chain,
              trackedAsset,
              observedAt,
            });
            if (candidate) results.push(candidate);
          }
        }
      }

      pageIndex += 1;
      if (
        markets.length < ROYCO_DAWN_PAGE_SIZE ||
        (typeof body.count === "number" && (pageIndex - 1) * ROYCO_DAWN_PAGE_SIZE >= body.count)
      ) {
        break;
      }
    }

    throwIfAborted(budget.budgetController.signal);
    return { candidates: results, degraded: false };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "royco-dawn-sources-budget-exhausted",
        job: "sync-yield-supplemental",
        provider: "royco-dawn",
        source: "yield-supplemental",
        message: "Royco Dawn sources budget exhausted; keeping partial results",
        metadata: { resultCount: results.length },
      });
    } else {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "royco_dawn_sources_failed",
        job: "sync-yield-supplemental",
        provider: "royco-dawn",
        source: "yield-supplemental",
        message: "Royco Dawn supplemental yield sources failed",
        error,
      });
    }
    return { candidates: results, degraded: true };
  } finally {
    budget.cleanup();
  }
}
