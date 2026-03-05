"use client";

import type { BluechipRatingsMap } from "@shared/types";
import { useApiQuery, CRON_24H } from "./use-api-query";

export function useBluechipRatings() {
  return useApiQuery<BluechipRatingsMap | null>(["bluechip-ratings"], "/api/bluechip-ratings", CRON_24H);
}
