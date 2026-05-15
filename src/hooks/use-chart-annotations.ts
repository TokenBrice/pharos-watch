"use client";

import { useMemo } from "react";
import { isChartAnnotationsEnabled } from "@/lib/feature-flags";

/**
 * Idea 4 phase 1 — event-annotated price/supply charts.
 *
 * Phase 1 ships the consumer surface (hook + `<ChartAnnotationDots>` + SR-only
 * legend) gated behind `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`. The worker's
 * `/api/events` endpoint already filters by `coin` (multi-value) + `since`/
 * `until` (epoch ms), not the `stablecoin` + `from`/`to` shape the plan
 * sketched. Phase 2 will:
 *   1. Either align this hook's URL params to the existing handler
 *      (`coin`, `since`, `until`) or extend the worker to accept chart-friendly
 *      aliases.
 *   2. Wire `useApiQueryWithMeta` here, map tape-event rows to
 *      `ChartAnnotation`, and clamp results to `[fromMs, toMs]` inside the
 *      memo so out-of-range markers can't push the chart's data domain.
 *
 * Until then the hook returns an empty array — charts render byte-identically
 * to today and the flag-off path never fetches.
 */

export type ChartAnnotationKind =
  | "depeg"
  | "mint-burn-spike"
  | "blacklist-surge"
  | "governance"
  | "regulatory"
  | "methodology-change";

export interface ChartAnnotation {
  ts: number; // unix ms
  kind: ChartAnnotationKind;
  label: string;
  severity?: "low" | "med" | "high";
  href?: string;
}

interface UseChartAnnotationsResult {
  data: ChartAnnotation[];
  isLoading: boolean;
}

const EMPTY_ANNOTATIONS: ChartAnnotation[] = [];

export function useChartAnnotations(
  stablecoinId: string,
  fromMs: number | null | undefined,
  toMs: number | null | undefined,
): UseChartAnnotationsResult {
  const enabled =
    isChartAnnotationsEnabled() &&
    typeof fromMs === "number" &&
    typeof toMs === "number" &&
    fromMs < toMs &&
    stablecoinId.length > 0;

  return useMemo(
    () => ({ data: enabled ? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS, isLoading: false }),
    [enabled],
  );
}
