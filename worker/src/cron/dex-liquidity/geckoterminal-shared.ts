import { canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";
import { USER_AGENT } from "../../lib/constants";
import { GT_API_BASE } from "../../lib/dex-cron-constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { fetchPagedTokenPools } from "../../lib/paged-token-pools";
import type { ParsedPool } from "./crawl-helpers";
import type { GtPool } from "./types";
import { GT_TOKEN_POOLS_MAX_PAGES, GT_TOKEN_POOLS_PAGE_SIZE } from "./constants";

type GtPoolKind = "concentrated" | "stable-amm" | "amm";

export function fetchGtTokenPools(
  tokenAddress: string,
  gtChain: string,
  signal?: AbortSignal,
  maxRetries = 0,
  timeoutMs = 15_000,
): Promise<GtPool[]> {
  return fetchPagedTokenPools({
    maxPages: GT_TOKEN_POOLS_MAX_PAGES,
    pageSize: GT_TOKEN_POOLS_PAGE_SIZE,
    fetchPage: async (page) => {
      const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${tokenAddress}/pools?page=${page}`;
      const result = await fetchJsonWithRetry<{ data?: unknown }>(
        url,
        {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
          signal,
        },
        maxRetries,
        { timeoutMs, passthrough404: true },
      );
      if (!result) throw new Error(`GeckoTerminal ${gtChain} token-pools request failed`);
      if (result.response.status === 404) return [];
      if (!result.response.ok) {
        throw new Error(`GeckoTerminal ${gtChain} token-pools returned ${result.response.status}`);
      }
      const json = result.body;
      return Array.isArray(json.data) ? (json.data as GtPool[]) : [];
    },
  });
}

export function parseGtPool(pool: GtPool, chain: string): ParsedPool | null {
  const attrs = pool.attributes;
  const dexId = pool.relationships?.dex?.data?.id;
  const poolAddress = canonicalExitRouteScopedId(chain, attrs.address ?? "");
  const baseTokenId = pool.relationships?.base_token?.data?.id;
  const quoteTokenId = pool.relationships?.quote_token?.data?.id;
  const baseTokenAddress = canonicalExitRouteScopedId(chain, baseTokenId?.split("_").pop() ?? "");
  const quoteTokenAddress = canonicalExitRouteScopedId(chain, quoteTokenId?.split("_").pop() ?? "");
  if (!dexId || !poolAddress || !baseTokenAddress || !quoteTokenAddress) return null;

  return {
    dexId,
    poolAddress,
    tvlUsd: parseFloat(attrs.reserve_in_usd ?? ""),
    volume24hUsd: parseFloat(attrs.volume_usd?.h24 ?? "0"),
    baseTokenAddress,
    quoteTokenAddress,
    baseTokenPriceUsd: parseFloat(attrs.base_token_price_usd ?? ""),
    quoteTokenPriceUsd: parseFloat(attrs.quote_token_price_usd ?? ""),
    createdAt: attrs.pool_created_at,
    poolName: attrs.name,
  };
}

// Concentrated-liquidity DEX IDs (GeckoTerminal `relationships.dex.data.id`).
// Prefix allowlist rather than a bare `v3`/`v4` substring match so DEXes whose
// names merely contain those substrings (e.g. "traderv3-stable") aren't
// misclassified. Add new concentrated-liquidity venues here as they appear.
const CONCENTRATED_DEX_PREFIXES = ["uniswap-v3", "uniswap-v4", "pancakeswap-v3", "sushiswap-v3", "quickswap-v3"];

export function getGtPoolKind(dexId: string): GtPoolKind {
  if (CONCENTRATED_DEX_PREFIXES.some((prefix) => dexId.startsWith(prefix))) {
    return "concentrated";
  }
  if (dexId.includes("stable")) {
    return "stable-amm";
  }
  return "amm";
}

export function getGtPoolType(dexId: string): string {
  return `gt-${getGtPoolKind(dexId)}`;
}
