"use client";

import { useDepegResolver, useDepegResolverReview } from "@/hooks/api-hooks";
import { isDepegResolverEnabled, isDepegResolverReviewerEnabled } from "@/lib/feature-flags";

/**
 * Pairs the two DDR queries with their feature gates. Callers read the query
 * objects directly — the hook deliberately does not re-flatten them into a
 * per-field bag.
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
