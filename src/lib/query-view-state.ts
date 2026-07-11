export type QueryViewState = "loading" | "ready" | "empty" | "unavailable" | "stale-with-data";

export interface ResolveQueryViewStateInput {
  hasData: boolean;
  isLoading: boolean;
  error: unknown | null | undefined;
  isEmpty?: boolean;
}

/**
 * Converts transport state into the semantic states monitoring surfaces need.
 * In particular, a failed request is never allowed to masquerade as valid
 * empty data, while retained query data remains usable with a stale warning.
 */
export function resolveQueryViewState({
  hasData,
  isLoading,
  error,
  isEmpty = false,
}: ResolveQueryViewStateInput): QueryViewState {
  if (hasData) {
    if (error) return "stale-with-data";
    return isEmpty ? "empty" : "ready";
  }
  if (error) return "unavailable";
  if (isLoading) return "loading";
  return "empty";
}
