"use client";

import { DataHealthBanner } from "@/components/data-health-banner";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import type { ApiMeta } from "@/lib/api";

/**
 * Compatibility wrapper around DataHealthBanner.
 * Prefer using `preset` to keep label/stale-time semantics centralized.
 */
export interface StaleQuery {
  preset?: keyof typeof DATA_HEALTH_PRESETS;
  label?: string;
  /** Timestamp in ms (from TanStack Query's dataUpdatedAt), 0 if never fetched */
  dataUpdatedAt: number;
  /** staleTime in ms (the cron interval) */
  staleTime?: number;
  hasData?: boolean;
  error?: unknown | null;
  meta?: ApiMeta | null;
}

export function StaleDataBanner({ queries }: { queries: StaleQuery[] }) {
  const health = queries.map((q) => {
    const preset = q.preset ? DATA_HEALTH_PRESETS[q.preset] : null;
    const label = q.label ?? preset?.label ?? "Data";
    const staleTime = q.staleTime ?? preset?.staleTime ?? 15 * 60_000;
    return deriveDataHealth({
      label,
      dataUpdatedAt: q.dataUpdatedAt,
      staleTime,
      hasData: q.hasData ?? q.dataUpdatedAt > 0,
      error: q.error,
      meta: q.meta ?? null,
    });
  });

  return <DataHealthBanner entries={health} />;
}
