"use client";

import { useDepegResolver, useDepegResolverReview } from "@/hooks/api-hooks";
import { isDepegResolverEnabled, isDepegResolverReviewerEnabled } from "@/lib/feature-flags";

export function useDepegResolverSurfaces() {
  const resolverEnabled = isDepegResolverEnabled();
  const resolverReviewerEnabled = resolverEnabled && isDepegResolverReviewerEnabled();
  const resolver = useDepegResolver({ enabled: resolverEnabled });
  const resolverReview = useDepegResolverReview({ enabled: resolverReviewerEnabled });

  return {
    resolverEnabled,
    resolverReviewerEnabled,
    resolverData: resolver.data,
    resolverError: resolver.error,
    resolverUpdatedAt: resolver.dataUpdatedAt,
    resolverMeta: resolver.meta,
    refetchResolver: resolver.refetch,
    resolverReviewData: resolverReview.data,
    resolverReviewError: resolverReview.error,
    resolverReviewUpdatedAt: resolverReview.dataUpdatedAt,
    resolverReviewMeta: resolverReview.meta,
    refetchResolverReview: resolverReview.refetch,
  };
}
