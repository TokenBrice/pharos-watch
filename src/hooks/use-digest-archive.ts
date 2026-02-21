"use client";

import { useApiQuery, CRON_24H } from "@/hooks/use-api-query";

interface DigestArchiveData {
  digests: { digestText: string; generatedAt: number }[];
}

export function useDigestArchive() {
  return useApiQuery<DigestArchiveData>(
    ["digest-archive"],
    "/api/digest-archive",
    CRON_24H,
  );
}
