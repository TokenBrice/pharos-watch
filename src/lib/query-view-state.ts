export type QueryViewState = "loading" | "ready" | "empty" | "unavailable" | "stale-with-data";

/** `QueryViewState` plus the two gates that precede any transport state. */
export type GatedQueryViewState = QueryViewState | "unsupported" | "deferred";

export interface ResolveQueryViewStateInput {
  hasData: boolean;
  isLoading: boolean;
  error: unknown | null | undefined;
  isEmpty?: boolean;
}

export interface ResolveGatedQueryViewStateInput extends ResolveQueryViewStateInput {
  /** `false` when the surface does not exist for this subject at all. Outranks every other signal. */
  supported?: boolean;
  /** `false` when the query is deliberately not run yet. Outranks every transport state. */
  enabled?: boolean;
  /**
   * What "the request answered but this subject has no row" means for this surface.
   * Defaults to `"empty"`; surfaces whose absence proves non-applicability pass `"unsupported"`.
   */
  emptyState?: "empty" | "unsupported";
}

/**
 * Converts transport state into the semantic states monitoring surfaces need.
 * In particular, a failed request is never allowed to masquerade as valid
 * empty data, while retained query data remains usable with a stale warning.
 *
 * The gated overload adds `supported` / `enabled` ahead of the transport ladder so
 * per-feature status ladders do not have to be hand-written per call site.
 */
export function resolveQueryViewState(input: ResolveQueryViewStateInput): QueryViewState;
export function resolveQueryViewState(input: ResolveGatedQueryViewStateInput): GatedQueryViewState;
export function resolveQueryViewState({
  hasData,
  isLoading,
  error,
  isEmpty = false,
  supported = true,
  enabled = true,
  emptyState = "empty",
}: ResolveGatedQueryViewStateInput): GatedQueryViewState {
  if (!supported) return "unsupported";
  if (!enabled) return "deferred";
  if (hasData) {
    if (error) return "stale-with-data";
    return isEmpty ? emptyState : "ready";
  }
  if (error) return "unavailable";
  if (isLoading) return "loading";
  return emptyState;
}
