import type { ColumnId } from "@/lib/column-visibility";

/**
 * Auto-fit drop order for the stablecoin workbench: when the user's chosen
 * columns exceed the container width, columns are shed in this order (least
 * essential first) until the table fits without horizontal scroll. Identity
 * and market basics (rank, name, price, peg, mcap) are never dropped; 24h
 * drops before 7d because the 7d cell carries the sparkline.
 */
export const COLUMN_FIT_DROP_ORDER: readonly ColumnId[] = [
  "flags",
  "type",
  "backing",
  "mintAuthority",
  "change24h",
  "blacklistable",
  "liquidity",
  "change7d",
  "stability",
  "grade",
];

export interface FitColumnsInput {
  /** User-chosen visible columns, in canonical column order. */
  intent: readonly ColumnId[];
  /** Measured container width in px; 0 or negative means "not measured yet" (no fit applied). */
  containerWidth: number;
  /** Per-column minimum width in px (variant-specific). */
  getColumnWidth: (id: ColumnId) => number;
  /** Width consumed by non-column chrome (e.g. the pinned/star cell). */
  fixedWidth: number;
}

export interface FitColumnsResult {
  /** Columns to render, in the intent's order. */
  rendered: ColumnId[];
  /** Intent columns hidden because they did not fit. */
  hiddenByFit: ColumnId[];
}

export function fitColumnsToWidth({
  intent,
  containerWidth,
  getColumnWidth,
  fixedWidth,
}: FitColumnsInput): FitColumnsResult {
  if (containerWidth <= 0) {
    return { rendered: [...intent], hiddenByFit: [] };
  }

  const rendered = new Set<ColumnId>(intent);
  const totalWidth = () =>
    [...rendered].reduce((sum, id) => sum + getColumnWidth(id), fixedWidth);

  for (const id of COLUMN_FIT_DROP_ORDER) {
    if (totalWidth() <= containerWidth) break;
    rendered.delete(id);
  }

  return {
    rendered: intent.filter((id) => rendered.has(id)),
    hiddenByFit: intent.filter((id) => !rendered.has(id)),
  };
}
