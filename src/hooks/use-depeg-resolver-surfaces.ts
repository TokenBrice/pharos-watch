"use client";

import { useDepegResolver, useDepegResolverReview } from "@/hooks/api-hooks";
import { isDepegResolverEnabled, isDepegResolverReviewerEnabled } from "@/lib/feature-flags";

/**
 * Pairs the two DDR queries with their feature gates. Callers read the query
 * objects directly — the hook deliberately does not re-flatten them into a
 * per-field bag.
 *
 * Both queries are eager: the reviewer's ledger renders behind a disclosure on
 * `/depeg/`, but its headline accuracy is a hero figure, so the payload is
 * needed on first paint regardless.
 */
export function useDepegResolverSurfaces() {
  const resolverEnabled = isDepegResolverEnabled();
  const resolverReviewerEnabled = resolverEnabled && isDepegResolverReviewerEnabled();

  return {
    resolverEnabled,
    resolverReviewerEnabled,
    resolver: useDepegResolver({ enabled: resolverEnabled }),
    resolverReview: useDepegResolverReview({ enabled: resolverReviewerEnabled }),
  };
}
