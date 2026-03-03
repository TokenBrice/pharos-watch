"use client";

import { DataHealthBanner } from "@/components/data-health-banner";
import { deriveDataHealth } from "@/lib/data-health";

/**
 * Warns users when data from any critical query exceeds 2x its staleTime.
 * Usage: <StaleDataBanner queries={[{ label: "Prices", dataUpdatedAt, staleTime: CRON_15MIN }]} />
 */
export interface StaleQuery {
  label: string;
  /** Timestamp in ms (from TanStack Query's dataUpdatedAt), 0 if never fetched */
  dataUpdatedAt: number;
  /** staleTime in ms (the cron interval) */
  staleTime: number;
}

export function StaleDataBanner({ queries }: { queries: StaleQuery[] }) {
  const health = queries.map((q) =>
    deriveDataHealth({
      label: q.label,
      dataUpdatedAt: q.dataUpdatedAt,
      staleTime: q.staleTime,
      hasData: q.dataUpdatedAt > 0,
    }),
  );

  return <DataHealthBanner entries={health} />;
}
