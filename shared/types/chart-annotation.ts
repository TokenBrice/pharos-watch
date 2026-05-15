/**
 * Shared types for chart annotations (idea 4 phase 2).
 *
 * `ChartAnnotation` is the runtime-neutral shape consumed by both:
 *   - the worker-tape branch (`useChartAnnotations` → `/api/events`)
 *   - the editorially curated branch (`shared/data/annotations/curated-annotations.ts`)
 *
 * Kept in `shared/types` so the static curated data can validate at build
 * time without pulling client-only modules.
 */

export const CHART_ANNOTATION_KINDS = [
  "depeg",
  "mint-burn-spike",
  "blacklist-surge",
  "governance",
  "regulatory",
  "methodology-change",
] as const;

export type ChartAnnotationKind = (typeof CHART_ANNOTATION_KINDS)[number];

export interface ChartAnnotation {
  /** Unix milliseconds. */
  ts: number;
  kind: ChartAnnotationKind;
  /** Short label rendered in the SR-only legend; ≤80 chars. */
  label: string;
  severity?: "low" | "med" | "high";
  /** Optional primary-source URL (issuer post-mortem, regulator filing, etc.). */
  href?: string;
}
