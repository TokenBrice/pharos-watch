"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// IDEA-4 — Screen-reader chart data tables
// ---------------------------------------------------------------------------

export interface ChartDataTableColumn<T> {
  /** Unique column id; also used as `<th>` key. */
  id: string;
  /** Header label rendered inside `<th scope="col">`. */
  label: string;
  /**
   * Cell formatter. Receives the raw row + a `key` matching `id`. Return a
   * plain string — the table only renders text content for AT clarity.
   */
  format: (row: T) => string;
}

interface ChartDataTableProps<T> {
  /** Caption describing the chart contents (e.g. "Market cap over 90 days"). */
  caption: string;
  /** Rows to render. Pass a summarised subset for long series. */
  data: ReadonlyArray<T>;
  /** Column descriptors. */
  columns: ReadonlyArray<ChartDataTableColumn<T>>;
  /**
   * When true (default) the table is `sr-only` and not visible to sighted
   * users. When false the table is rendered as a normal disclosure body.
   */
  srOnly?: boolean;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

/**
 * Renders the underlying chart series as a semantic `<table>` so screen
 * readers can announce the actual values. Pair with `ChartDataTableDisclosure`
 * to give low-vision sighted users a visible toggle.
 *
 * Note: keep `data` summarised. For multi-year time-series, cap to ~90 rows
 * and call that out in the caption so the announcement isn't misleading.
 */
export function ChartDataTable<T>({ caption, data, columns, srOnly = true, className }: ChartDataTableProps<T>) {
  const wrapperClassName = srOnly ? cn("sr-only", className) : className;
  return (
    <div className={wrapperClassName}>
      <table className={srOnly ? undefined : "w-full border-collapse text-xs"}>
        <caption className={srOnly ? undefined : "mb-2 text-left text-xs text-muted-foreground"}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                className={
                  srOnly
                    ? undefined
                    : "border-b border-border/60 px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                }
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((col, colIndex) => {
                const value = col.format(row);
                if (colIndex === 0) {
                  return (
                    <th
                      key={col.id}
                      scope="row"
                      className={
                        srOnly
                          ? undefined
                          : "border-b border-border/30 px-2 py-1 text-left font-mono tabular-nums text-foreground/85"
                      }
                    >
                      {value}
                    </th>
                  );
                }
                return (
                  <td
                    key={col.id}
                    className={
                      srOnly
                        ? undefined
                        : "border-b border-border/30 px-2 py-1 text-left font-mono tabular-nums text-foreground/85"
                    }
                  >
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ChartDataTableDisclosureProps<T> extends ChartDataTableProps<T> {
  /** Label for the closed state. Defaults to "Show as table". */
  showLabel?: string;
  /** Label for the open state. Defaults to "Hide table". */
  hideLabel?: string;
  /** Optional className applied to the toggle button. */
  buttonClassName?: string;
}

/**
 * Disclosure pair: a small "Show as table" button + a lazily-rendered visible
 * data table. While closed, the sr-only table is always present so screen
 * readers can still announce the data. While open, the visible table replaces
 * the sr-only one.
 */
export function ChartDataTableDisclosure<T>({
  caption,
  data,
  columns,
  showLabel = "Show as table",
  hideLabel = "Hide table",
  buttonClassName,
  className,
}: ChartDataTableDisclosureProps<T>) {
  const [open, setOpen] = useState(false);
  const tableId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={tableId}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "pharos-focus-ring pharos-control-pill px-2.5 sm:py-1 text-[10px] tracking-wider",
          buttonClassName,
        )}
      >
        {open ? hideLabel : showLabel}
      </button>
      <div id={tableId} className={cn("w-full", className)}>
        <ChartDataTable caption={caption} data={data} columns={columns} srOnly={!open} />
      </div>
    </>
  );
}

/**
 * Cap a time-series for screen-reader table rendering. Keeps the most recent
 * `maxRows` rows in chronological order. Returns the capped slice plus a flag
 * indicating whether the original series was truncated, so callers can amend
 * the table caption.
 */
export function capDataForTable<T>(
  data: ReadonlyArray<T>,
  maxRows: number,
): { rows: ReadonlyArray<T>; truncated: boolean } {
  if (data.length <= maxRows) return { rows: data, truncated: false };
  return { rows: data.slice(data.length - maxRows), truncated: true };
}
