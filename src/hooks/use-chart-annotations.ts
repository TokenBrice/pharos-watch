"use client";

import { useMemo } from "react";
import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { TapeEventsResponseSchema, type TapeEvent } from "@shared/types/tape-event";
import { CRON_1H } from "@/lib/cron-intervals";
import { isChartAnnotationsEnabled } from "@/lib/feature-flags";
import { useApiQueryWithMeta } from "./use-api-query";

/**
 * Idea 4 phase 2 — event-annotated price/supply charts.
 *
 * Pulls tape events from `/api/events` filtered to the given coin + time range
 * and maps them into the `ChartAnnotation` shape consumed by
 * `<ChartAnnotationLines>` and the SR-only event legend. Out-of-range rows are
 * clamped inside the memo so they cannot push the chart's data domain (defence
 * in depth with `ifOverflow="hidden"` on the lines themselves).
 *
 * Gated by `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`: when off, the hook returns
 * an empty array and the underlying query is disabled.
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

// `apiFetchWithMeta` lifts `_meta` off the body before schema parsing.
const TapeEventsResponseBodySchema = TapeEventsResponseSchema.omit({ _meta: true });
type TapeEventsResponseBody = z.infer<typeof TapeEventsResponseBodySchema>;

const TAPE_EVENTS_LIMIT = 200;

/**
 * Map a worker tape-event `type` slug onto the public `ChartAnnotationKind`
 * enum. Returns null for slugs we don't plot (score/psi/dews/yield/lifecycle
 * etc.) so they're dropped at the hook boundary.
 */
function mapWorkerKind(rowType: string): ChartAnnotationKind | null {
  if (rowType.startsWith("depeg.")) return "depeg";
  if (rowType.startsWith("mint_burn.")) return "mint-burn-spike";
  if (rowType.startsWith("freeze.")) return "blacklist-surge";
  if (rowType.startsWith("methodology.")) return "methodology-change";
  return null;
}

function severityToBand(s: TapeEvent["severity"]): ChartAnnotation["severity"] {
  if (s === "critical" || s === "severe") return "high";
  if (s === "warning") return "med";
  return "low";
}

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

  const path = enabled
    ? `${API_PATHS.events()}?coin=${encodeURIComponent(stablecoinId)}&since=${fromMs}&until=${toMs}&limit=${TAPE_EVENTS_LIMIT}`
    : API_PATHS.events();

  const query = useApiQueryWithMeta<TapeEventsResponseBody>(
    [
      "events",
      "chart-annotations",
      {
        coin: stablecoinId,
        since: fromMs ?? null,
        until: toMs ?? null,
      },
    ],
    path,
    CRON_1H,
    { enabled, schema: TapeEventsResponseBodySchema },
  );

  return useMemo<UseChartAnnotationsResult>(() => {
    if (!enabled || !query.data) {
      return { data: EMPTY_ANNOTATIONS, isLoading: query.isLoading };
    }
    const lo = fromMs as number;
    const hi = toMs as number;
    const annotations: ChartAnnotation[] = [];
    for (const ev of query.data.events) {
      if (ev.ts < lo || ev.ts > hi) continue;
      const kind = mapWorkerKind(ev.type);
      if (kind === null) continue;
      annotations.push({
        ts: ev.ts,
        kind,
        label: ev.title,
        severity: severityToBand(ev.severity),
        href: ev.sourceUrl ?? undefined,
      });
    }
    return { data: annotations, isLoading: query.isLoading };
  }, [enabled, fromMs, toMs, query.data, query.isLoading]);
}
