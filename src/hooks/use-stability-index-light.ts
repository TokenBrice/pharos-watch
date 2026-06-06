"use client";

import { useLightApiQuery } from "@/hooks/use-sidebar-nav-signal-data";
import { FRONTEND_API_QUERY_RUNTIME_REGISTRY } from "@/lib/api-query-runtime-registry";

export function useStabilityIndexLight() {
  return useLightApiQuery(FRONTEND_API_QUERY_RUNTIME_REGISTRY.stabilityIndex, {});
}
