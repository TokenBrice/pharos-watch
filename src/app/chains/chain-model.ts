import type { ChainSummary } from "@shared/types/chains";
import { createTableComparator } from "@/lib/table-comparator";

export type ChainSortKey =
  | "totalUsd"
  | "healthScore"
  | "change24hPct"
  | "change7dPct"
  | "change30dPct"
  | "stablecoinCount"
  | "dominanceShare";

const CHAIN_SORT_KEYS: ChainSortKey[] = [
  "totalUsd",
  "healthScore",
  "change24hPct",
  "change7dPct",
  "change30dPct",
  "stablecoinCount",
  "dominanceShare",
];

// An absent health score or window change is unknown, not the bottom of the
// scale: the shared comparator keeps those rows last in both directions.
const compareChains = createTableComparator<ChainSortKey, ChainSummary>(
  Object.fromEntries(CHAIN_SORT_KEYS.map((key) => [key, (chain: ChainSummary) => chain[key] ?? null])) as Record<
    ChainSortKey,
    (chain: ChainSummary) => number | null
  >,
);

export function sortChains(chains: ChainSummary[], key: ChainSortKey, dir: "asc" | "desc"): ChainSummary[] {
  return [...chains].sort((a, b) => compareChains(a, b, { key, direction: dir }));
}
