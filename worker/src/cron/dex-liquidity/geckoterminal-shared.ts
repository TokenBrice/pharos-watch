import { USER_AGENT } from "../../lib/constants";
import { GT_API_BASE } from "../../lib/dex-constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import type { ParsedPool } from "./crawl-helpers";
import type { GtPool } from "./types";

type GtPoolKind = "concentrated" | "stable-amm" | "amm";

async function fetchGtTokenPoolsInternal(
  tokenAddress: string,
  gtChain: string,
  signal?: AbortSignal,
  maxRetries = 0,
): Promise<GtPool[]> {
  const url = `${GT_API_BASE}/networks/${gtChain}/tokens/${tokenAddress}/pools?page=1`;
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal,
    },
    maxRetries,
  );
  if (!res?.ok) return [];
  const json = (await res.json()) as { data?: GtPool[] };
  return json.data ?? [];
}

export function fetchGtTokenPools(
  tokenAddress: string,
  gtChain: string,
  signal?: AbortSignal,
  maxRetries = 0,
): Promise<GtPool[]> {
  return fetchGtTokenPoolsInternal(tokenAddress, gtChain, signal, maxRetries);
}

export function parseGtPool(pool: GtPool): ParsedPool | null {
  const attrs = pool.attributes;
  const dexId = pool.relationships.dex.data.id;
  const poolAddress = attrs.address?.toLowerCase();
  if (!dexId || !poolAddress) return null;

  return {
    dexId,
    poolAddress,
    tvlUsd: parseFloat(attrs.reserve_in_usd ?? ""),
    volume24hUsd: parseFloat(attrs.volume_usd?.h24 ?? "0"),
    baseTokenAddress: pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "",
    quoteTokenAddress: pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "",
    baseTokenPriceUsd: parseFloat(attrs.base_token_price_usd ?? ""),
    quoteTokenPriceUsd: parseFloat(attrs.quote_token_price_usd ?? ""),
    createdAt: attrs.pool_created_at,
    poolName: attrs.name,
  };
}

export function getGtPoolKind(dexId: string): GtPoolKind {
  if (dexId.includes("v3") || dexId.includes("v4")) {
    return "concentrated";
  }
  if (dexId.includes("stable")) {
    return "stable-amm";
  }
  return "amm";
}

export function getGtPoolType(dexId: string, prefix = "gt"): string {
  return `${prefix}-${getGtPoolKind(dexId)}`;
}
