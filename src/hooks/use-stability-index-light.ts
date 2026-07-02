"use client";

import { useRegisteredApiQueryWithMeta } from "@/hooks/api-hooks";
import { FRONTEND_API_QUERY_RUNTIME_REGISTRY } from "@/lib/api-query-runtime-registry";

export function useStabilityIndexLight() {
  return useRegisteredApiQueryWithMeta(FRONTEND_API_QUERY_RUNTIME_REGISTRY.stabilityIndex, {});
}
