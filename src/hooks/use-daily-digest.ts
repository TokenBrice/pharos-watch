"use client";

import { useApiQuery, CRON_1H } from "@/hooks/use-api-query";

interface DailyDigestData {
  digest: string | null;
  generatedAt: number | null;
}

export function useDailyDigest() {
  return useApiQuery<DailyDigestData>(
    ["daily-digest"],
    "/api/daily-digest",
    CRON_1H,
  );
}
