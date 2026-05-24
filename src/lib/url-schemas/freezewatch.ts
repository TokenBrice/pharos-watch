/**
 * URL state schema for `/freezewatch/`.
 *
 * Mirrors the contract parsed by `parseFreezeWatchPageFilters` in
 * `src/app/freezewatch/view-model.ts`. All eight params on that surface
 * are meaningful to share — they together address a specific event slice.
 *
 * `stablecoin` and `chain` are declared as `string` (not `enum`) because
 * the canonical sets are large + data-derived (the chain list comes from
 * the summary API); per-value validation continues to happen in
 * `parseFreezeWatchPageFilters` and tracks the upstream registry.
 */
import type { UrlStateSchema } from "@/lib/url-state";

export type FreezeWatchEventType = "all" | "blacklist" | "unblacklist" | "destroy";
export type FreezeWatchSortKey = "date" | "stablecoin" | "chain" | "event";
export type FreezeWatchSortDirection = "asc" | "desc";
export type FreezeWatchStatusBucket = "" | "yes" | "upstream" | "possible" | "no";

export const FREEZEWATCH_EVENT_TYPES = [
  "all",
  "blacklist",
  "unblacklist",
  "destroy",
] as const satisfies readonly FreezeWatchEventType[];

export const FREEZEWATCH_SORT_KEYS = [
  "date",
  "stablecoin",
  "chain",
  "event",
] as const satisfies readonly FreezeWatchSortKey[];

export const FREEZEWATCH_SORT_DIRECTIONS = [
  "asc",
  "desc",
] as const satisfies readonly FreezeWatchSortDirection[];

export const FREEZEWATCH_STATUS_BUCKETS = [
  "",
  "yes",
  "upstream",
  "possible",
  "no",
] as const satisfies readonly FreezeWatchStatusBucket[];

export interface FreezeWatchUrlValues {
  /** Tracked-issuer ticker filter (`USDT`, `USDC`, ...) or `all`. */
  stablecoin: string;
  /** Chain id filter (`tron`, `ethereum`, ...) or `all`. */
  chain: string;
  event: FreezeWatchEventType;
  sortBy: FreezeWatchSortKey;
  sortDirection: FreezeWatchSortDirection;
  /** 1-indexed page number. Encoded as integer ≥ 1. */
  page: number;
  /** Free-text search query (address, label, or stablecoin symbol). */
  q: string;
  /** Blacklist-status drilldown bucket. Empty string means no drilldown. */
  status: FreezeWatchStatusBucket;
}

export const FREEZEWATCH_URL_SCHEMA: UrlStateSchema<FreezeWatchUrlValues> = {
  stablecoin: {
    kind: "string",
    defaultValue: "all",
  },
  chain: {
    kind: "string",
    defaultValue: "all",
  },
  event: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: FREEZEWATCH_EVENT_TYPES,
  },
  sortBy: {
    kind: "enum",
    defaultValue: "date",
    allowedValues: FREEZEWATCH_SORT_KEYS,
  },
  sortDirection: {
    kind: "enum",
    defaultValue: "desc",
    allowedValues: FREEZEWATCH_SORT_DIRECTIONS,
  },
  page: {
    kind: "boundedNumber",
    defaultValue: 1,
    min: 1,
    integer: true,
  },
  q: {
    kind: "string",
    defaultValue: "",
  },
  status: {
    kind: "enum",
    defaultValue: "",
    allowedValues: FREEZEWATCH_STATUS_BUCKETS,
  },
};
