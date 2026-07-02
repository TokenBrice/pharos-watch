"use client";

import { useRegisteredApiQueryWithMeta } from "@/hooks/api-hooks";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";

export function useStabilityIndexLight() {
  return useRegisteredApiQueryWithMeta(FRONTEND_API_QUERY_REGISTRY.stabilityIndex, {});
}
