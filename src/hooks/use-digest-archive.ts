"use client";

import { useApiQuery, CRON_24H } from "@/hooks/use-api-query";

interface DigestArchiveData {
  digests: {
    digestText: string;
    digestTitle: string | null;
    digestExtended: string | null;
    generatedAt: number;
    psiScore: number | null;
    psiBand: string | null;
    totalMcapUsd: number | null;
  }[];
}

export function useDigestArchive() {
  return useApiQuery<DigestArchiveData>(
    ["digest-archive"],
    "/api/digest-archive",
    CRON_24H,
  );
}
