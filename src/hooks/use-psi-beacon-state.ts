"use client";

import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { deriveDataHealth, formatDataHealthTimestamp, type DataHealthInfo } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import type { ApiMeta } from "@/lib/api";
import { derivePsiBeaconState, type PsiBeaconCurrentLike, type PsiBeaconState } from "@shared/lib/psi-beacon";

interface PsiQueryLike {
  current: PsiBeaconCurrentLike | null | undefined;
  meta?: ApiMeta | null;
  dataUpdatedAt: number;
  error?: unknown;
  isLoading?: boolean;
}

export interface PsiBeaconHealth {
  health: DataHealthInfo | null;
  isCurrent: boolean;
  /** "Retained observation as of …" stamp, in UTC like the regime bar. */
  retainedLabel: string | null;
  state: PsiBeaconState;
}

function getPsiHealthInput(query: PsiQueryLike): Parameters<typeof deriveDataHealth>[0] | null {
  const { current, meta } = query;
  if (!current) return null;
  const generationUpdatedAt = Math.min(meta?.updatedAt ?? current.computedAt, current.computedAt);
  const generationMeta: ApiMeta = meta?.updatedAt === null ? meta : {
    ...meta,
    updatedAt: generationUpdatedAt,
    ageSeconds: meta?.ageSeconds ?? Math.max(0, query.dataUpdatedAt / 1000 - generationUpdatedAt),
    status: meta?.status ?? "fresh",
  };
  return {
    ...DATA_HEALTH_PRESETS.stabilityIndex,
    dataUpdatedAt: query.dataUpdatedAt,
    error: query.error,
    hasData: true,
    meta: generationMeta,
  };
}

/**
 * Derives PSI freshness from the generation the payload carries (the older of
 * meta.updatedAt and current.computedAt), so a fresh response holding an old
 * sample never reads as current. Shared by every PSI beacon surface.
 */
function derivePsiBeaconHealth(query: PsiQueryLike, nowMs?: number): PsiBeaconHealth {
  const { current } = query;
  if (!current) {
    return {
      health: null,
      isCurrent: false,
      retainedLabel: null,
      state: derivePsiBeaconState({ current: null, isLoading: query.isLoading, isFresh: false }),
    };
  }
  const health = deriveDataHealth(getPsiHealthInput(query)!, nowMs);
  const isCurrent = health.state === "fresh";
  const asOfLabel = formatDataHealthTimestamp(current.computedAt * 1000, "en-US", "UTC");
  return {
    health,
    isCurrent,
    retainedLabel: `Retained observation as of ${asOfLabel}`,
    state: derivePsiBeaconState({ current, isFresh: isCurrent, healthMessage: health.message, asOfLabel }),
  };
}

/** Before hydration, health is judged at the query's own update time so SSR and first paint agree. */
export function usePsiBeaconState(query: PsiQueryLike): PsiBeaconHealth {
  const input = getPsiHealthInput(query);
  const nowMs = useFreshnessBoundary(input ? [input] : []);
  return derivePsiBeaconHealth(query, nowMs ?? query.dataUpdatedAt);
}
