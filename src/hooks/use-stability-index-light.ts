"use client";

import { useLightApiQueryWithMeta } from "@/hooks/use-sidebar-nav-signal-data";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";

export function useStabilityIndexLight() {
  return useLightApiQueryWithMeta(FRONTEND_API_QUERY_REGISTRY.stabilityIndex, {});
}
