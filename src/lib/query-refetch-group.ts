import { isCancelledError } from "@tanstack/react-query";
import type { StaleQuery } from "@/components/stale-data-banner";

export type QueryRefetchFn = () => Promise<unknown>;

export interface QueryRefetchGroupOptions {
  warnLabel?: string;
}

export interface QueryRefetchGroupOutcome {
  failures: unknown[];
  results: PromiseSettledResult<unknown>[];
}

interface QueryRefetchResultLike {
  error?: unknown;
  status?: string;
}

export interface QueryFreshnessGroupEntry extends Omit<StaleQuery, "dataUpdatedAt" | "hasData"> {
  data?: unknown;
  dataUpdatedAt?: number;
  hasData?: boolean;
  refetch?: QueryRefetchFn;
}

export interface QueryFreshnessGroupOptions extends QueryRefetchGroupOptions {}

export interface QueryFreshnessGroup {
  globalError: unknown | null;
  hasAnyData: boolean;
  queries: StaleQuery[];
  refetchAll: () => Promise<QueryRefetchGroupOutcome>;
}

function isAbortLikeError(error: unknown): boolean {
  return isCancelledError(error) || (error instanceof DOMException && error.name === "AbortError");
}

function resolveHasData(entry: Pick<QueryFreshnessGroupEntry, "data" | "hasData">): boolean {
  return entry.hasData ?? entry.data != null;
}

function firstQueryError(entries: readonly QueryFreshnessGroupEntry[]): unknown | null {
  return entries.find((entry) => entry.error != null)?.error ?? null;
}

function collectRefetchFailure(result: PromiseSettledResult<unknown>): unknown | null {
  if (result.status === "rejected") {
    return isAbortLikeError(result.reason) ? null : result.reason;
  }

  if (typeof result.value !== "object" || result.value == null) {
    return null;
  }

  const value = result.value as QueryRefetchResultLike;
  if (value.status !== "error" && value.error == null) {
    return null;
  }

  if (isAbortLikeError(value.error)) {
    return null;
  }

  return value.error ?? new Error("Refetch returned an error state");
}

export async function refetchQueryGroup(
  refetchers: readonly QueryRefetchFn[],
  options: QueryRefetchGroupOptions = {},
): Promise<QueryRefetchGroupOutcome> {
  const results = await Promise.allSettled(refetchers.map((refetch) => refetch()));
  const failures = results
    .map((result) => collectRefetchFailure(result))
    .filter((failure): failure is unknown => failure != null);

  if (options.warnLabel && failures.length > 0) {
    console.warn(options.warnLabel, failures);
  }

  return { failures, results };
}

export function buildQueryFreshnessGroup(
  entries: readonly QueryFreshnessGroupEntry[],
  options: QueryFreshnessGroupOptions = {},
): QueryFreshnessGroup {
  const refetchers = entries
    .map((entry) => entry.refetch)
    .filter((refetch): refetch is QueryRefetchFn => typeof refetch === "function");

  return {
    globalError: firstQueryError(entries),
    hasAnyData: entries.some((entry) => resolveHasData(entry)),
    queries: entries.map((entry) => ({
      preset: entry.preset,
      label: entry.label,
      dataUpdatedAt: entry.dataUpdatedAt ?? 0,
      staleTime: entry.staleTime,
      hasData: resolveHasData(entry),
      error: entry.error,
      meta: entry.meta,
    })),
    refetchAll: () => refetchQueryGroup(refetchers, options),
  };
}
