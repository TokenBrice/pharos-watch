"use client";

import { useApiQuery, CRON_24H } from "@/hooks/use-api-query";

interface DailyDigestData {
  digest: string | null;
  digestTitle: string | null;
  digestExtended: string | null;
  generatedAt: number | null;
}

export function useDailyDigest() {
  return useApiQuery<DailyDigestData>(
    ["daily-digest"],
    "/api/daily-digest",
    CRON_24H,
  );
}
