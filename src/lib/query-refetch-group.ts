import { isCancelledError } from "@tanstack/query-core";

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

function isAbortLikeError(error: unknown): boolean {
  return isCancelledError(error) || (error instanceof DOMException && error.name === "AbortError");
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
