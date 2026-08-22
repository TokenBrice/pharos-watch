"use client";

import { useMemo } from "react";
import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { TapeEventsResponseSchema, type TapeEvent } from "@shared/types/tape-event";
import type {
  ChartAnnotation,
  ChartAnnotationKind,
} from "@shared/types/chart-annotation";
import { getCuratedAnnotations } from "@shared/data/annotations/curated-annotations";
import { caseStudySlugForEvent } from "@/lib/case-study-client-index";
import { DAY_MS } from "@/lib/constants";
import { CRON_TAPE } from "@/lib/cron-intervals";
import { isChartAnnotationsEnabled } from "@/lib/feature-flags";
import { useApiQueryWithMeta } from "./use-api-query";

/**
 * Idea 4 phase 2 — event-annotated price/supply charts.
 *
 * Merges two annotation sources, both gated by
 * `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`:
 *
 *   1. Worker tape events from `/api/events?coin=…&since=…&until=…` (live,
 *      auto-detected depegs / mint-burn spikes / freeze surges / methodology
 *      changes).
 *
 *   2. Static editorial annotations from
 *      `shared/data/annotations/curated-annotations.ts` (historical events the
 *      tape can't recover: SVB depeg, BUSD ban, Black Thursday, coin launches,
 *      etc).
 *
 * Both sources are clamped to `[fromMs, toMs]` in this memo so out-of-range
 * rows never extend the chart's data domain (defence in depth with
 * `ifOverflow="hidden"` on the lines themselves). Per-source rows are
 * de-duplicated by `kind` + same-day timestamp, with the curated entry
 * winning over the tape row.
 */

export type { ChartAnnotation, ChartAnnotationKind };

interface UseChartAnnotationsResult {
  data: ChartAnnotation[];
  isLoading: boolean;
}

const EMPTY_ANNOTATIONS: ChartAnnotation[] = [];

// `apiFetchWithMeta` lifts `_meta` off the body before schema parsing.
const TapeEventsResponseBodySchema = TapeEventsResponseSchema.omit({ _meta: true });
type TapeEventsResponseBody = z.infer<typeof TapeEventsResponseBodySchema>;

const TAPE_EVENTS_LIMIT = 200;
const ANNOTATION_QUERY_BUCKET_MS = 30 * DAY_MS;
const ANNOTATION_EVENT_TYPES = ["depeg.opened", "depeg.peak_worsened"] as const;
const ANNOTATION_EVENT_CLASSES = ["methodology"] as const;

function buildAnnotationQueryWindow(fromMs: number, toMs: number): { since: number; until: number } {
  return {
    since: Math.max(0, Math.floor(fromMs / ANNOTATION_QUERY_BUCKET_MS) * ANNOTATION_QUERY_BUCKET_MS),
    until: Math.ceil(toMs / ANNOTATION_QUERY_BUCKET_MS) * ANNOTATION_QUERY_BUCKET_MS,
  };
}

/**
 * Map a worker tape-event `type` slug onto the public `ChartAnnotationKind`
 * enum. Returns null for slugs we don't plot so they're dropped at the hook
 * boundary.
 *
 * Only editorially significant tape kinds reach the chart overlay:
 *   - `depeg.opened` — rare, grade-impacting
 *   - `depeg.peak_worsened` — active depeg widened materially
 *   - `methodology.*` — issued by us, low-volume
 *
 * `mint_burn.*` and `freeze.*` are intentionally NOT mapped. They fire often
 * enough on large issuers (USDT mints dozens of times per month) to flood the
 * legend and drown the curated SVB/CFTC-tier events visually. They remain
 * visible on the tape stream UI; chart overlays restrict to high-signal kinds.
 * The `mint-burn-spike` and `blacklist-surge` annotation kinds in
 * `CHART_ANNOTATION_KINDS` / `ANNOTATION_HEX_COLORS` are reserved for these
 * tape event families should they ever be promoted to chart overlays.
 *
 * `depeg.resolved` is intentionally NOT mapped — pairing each `depeg.opened`
 * with its matching resolution doubles the visual count without adding
 * editorial signal.
 */
function mapWorkerKind(rowType: string): ChartAnnotationKind | null {
  if (rowType === "depeg.opened" || rowType === "depeg.peak_worsened") return "depeg";
  if (rowType.startsWith("methodology.")) return "methodology-change";
  return null;
}

function severityToBand(s: TapeEvent["severity"]): ChartAnnotation["severity"] {
  if (s === "critical" || s === "severe") return "high";
  if (s === "warning") return "med";
  return "low";
}

/**
 * Tape annotations are filtered to `warning` severity or above. The `info`
 * and `notice` tiers correspond to threshold-skimming events (e.g. LUSD
 * crossing $0.99 by a few basis points) that visually overwhelm a chart
 * without flagging anything a reader needs to investigate. Curated
 * annotations bypass this filter — they're editorially selected.
 */
function isTapeSeverityWorthPlotting(s: TapeEvent["severity"]): boolean {
  return s === "warning" || s === "severe" || s === "critical";
}

function buildAnnotationEventsPath(
  stablecoinId: string,
  queryWindow: { since: number; until: number } | null,
): string {
  const params = new URLSearchParams({
    coin: stablecoinId,
    severityFloor: "warning",
    limit: String(TAPE_EVENTS_LIMIT),
  });

  if (queryWindow) {
    params.set("since", String(queryWindow.since));
    params.set("until", String(queryWindow.until));
  }

  for (const type of ANNOTATION_EVENT_TYPES) params.append("type", type);
  for (const eventClass of ANNOTATION_EVENT_CLASSES) params.append("class", eventClass);

  return `${API_PATHS.events()}?${params.toString()}`;
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
  const queryWindow = enabled ? buildAnnotationQueryWindow(fromMs as number, toMs as number) : null;

  const path = enabled
    ? buildAnnotationEventsPath(stablecoinId, queryWindow)
    : API_PATHS.events();

  const query = useApiQueryWithMeta<TapeEventsResponseBody>(
    [
      "events",
      "chart-annotations",
      {
        coin: stablecoinId,
        since: queryWindow?.since ?? null,
        until: queryWindow?.until ?? null,
      },
    ],
    path,
    CRON_TAPE,
    { enabled, schema: TapeEventsResponseBodySchema },
  );

  return useMemo<UseChartAnnotationsResult>(() => {
    if (!enabled) {
      return { data: EMPTY_ANNOTATIONS, isLoading: false };
    }
    const lo = fromMs as number;
    const hi = toMs as number;

    const curated = getCuratedAnnotations(stablecoinId);
    const annotations: ChartAnnotation[] = [];
    const seen = new Set<string>();

    for (const a of curated) {
      if (a.ts < lo || a.ts > hi) continue;
      const key = `${a.kind}|${Math.floor(a.ts / DAY_MS)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      annotations.push(a);
    }

    if (query.data) {
      for (const ev of query.data.events) {
        if (ev.ts < lo || ev.ts > hi) continue;
        if (!isTapeSeverityWorthPlotting(ev.severity)) continue;
        const kind = mapWorkerKind(ev.type);
        if (kind === null) continue;
        const key = `${kind}|${Math.floor(ev.ts / DAY_MS)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        annotations.push({
          ts: ev.ts,
          kind,
          label: ev.title,
          severity: severityToBand(ev.severity),
          href: ev.sourceUrl ?? undefined,
        });
      }
    }

    annotations.sort((a, b) => a.ts - b.ts);
    // Link any pin that falls inside a case study's event window to that study.
    const linked = annotations.map((a) => {
      const slug = caseStudySlugForEvent(stablecoinId, a.ts);
      return slug ? { ...a, caseStudySlug: slug } : a;
    });
    return { data: linked, isLoading: query.isLoading };
  }, [enabled, stablecoinId, fromMs, toMs, query.data, query.isLoading]);
}
