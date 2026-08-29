import type { ChainSummary } from "@shared/types/chains";

export type ChainSortKey =
  | "totalUsd"
  | "healthScore"
  | "change24hPct"
  | "change7dPct"
  | "change30dPct"
  | "stablecoinCount"
  | "dominanceShare";

export function sortChains(chains: ChainSummary[], key: ChainSortKey, dir: "asc" | "desc"): ChainSummary[] {
  return [...chains].sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    return dir === "desc" ? bv - av : av - bv;
  });
}
