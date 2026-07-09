"use client";

import type { StabilityIndexResponse } from "@shared/types/stability";
import { useApiQueryWithMeta } from "@/hooks/use-api-query";
import { STABILITY_INDEX_QUERY_DESCRIPTOR } from "@/lib/api-query-domains/stability-light";

export function useStabilityIndexLight() {
  const descriptor = STABILITY_INDEX_QUERY_DESCRIPTOR;
  return useApiQueryWithMeta<StabilityIndexResponse>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    { schema: descriptor.schema, metaMaxAgeSec: descriptor.metaMaxAgeSec },
  );
}
