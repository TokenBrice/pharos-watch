import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { StabilityIndexResponse } from "@shared/types/stability";
import { CRON_30MIN } from "@/lib/cron-intervals";
import { defineApiQuery } from "@/lib/api-query-contract";
import { createLazySchema } from "@/lib/schema-like";

const FULL_STABILITY_SCHEMA = createLazySchema<StabilityIndexResponse>(async () =>
  (await import("@shared/types/stability")).StabilityIndexResponseSchema
);

export const STABILITY_INDEX_DETAIL_QUERY_DESCRIPTOR = defineApiQuery(
  {
    queryKey: ["stability-index-detail"] as const,
    path: API_PATHS.stabilityIndex(true),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
  },
  "meta",
  FULL_STABILITY_SCHEMA,
);
