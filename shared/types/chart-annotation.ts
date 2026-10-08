/**
 * Shared types for the retained historical annotation corpus.
 *
 * `ChartAnnotation` is the runtime-neutral evidence shape loaded from the
 * editorially curated per-coin JSON assets by
 * `shared/data/annotations/curated-annotations.ts`. The live chart overlay
 * has been retired; corpus validation, review and evidence consumers remain.
 *
 * Kept in `shared/types` so the static curated data can validate at build
 * time without pulling client-only modules.
 */

export const CHART_ANNOTATION_KINDS = [
  "depeg",
  "mint-burn-spike",
  "blacklist-surge",
  "exploit",
  "governance",
  "regulatory",
  "methodology-change",
] as const;

export type ChartAnnotationKind = (typeof CHART_ANNOTATION_KINDS)[number];

export interface ChartAnnotation {
  /** Unix milliseconds. */
  ts: number;
  kind: ChartAnnotationKind;
  /** Short editorial evidence label; ≤80 chars. */
  label: string;
  /**
   * Marks `label` as a verbatim external title rather than Pharos-composed
   * copy. Editorial style rules never apply to quoted text, so the corpus gate
   * reads this as `ownership: "quoted"` and label punctuation migrations must
   * leave it untouched. See docs/editorial-style.md.
   */
  quoted?: boolean;
  severity?: "low" | "med" | "high";
  /** Optional primary-source URL (issuer post-mortem, regulator filing, etc.). */
  href?: string;
}
