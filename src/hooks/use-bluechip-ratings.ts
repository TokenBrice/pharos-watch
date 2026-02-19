"use client";

import type { BluechipRatingsMap } from "@/lib/types";
import { useApiQuery, CRON_2H } from "./use-api-query";

export function useBluechipRatings() {
  return useApiQuery<BluechipRatingsMap | null>(["bluechip-ratings"], "/api/bluechip-ratings", CRON_2H);
}
