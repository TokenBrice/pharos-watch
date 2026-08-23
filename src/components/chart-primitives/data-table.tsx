"use client";

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

/**
 * Cap a time-series for screen-reader table rendering. Keeps the most recent
 * `maxRows` rows in chronological order. Returns the capped slice plus a flag
 * indicating whether the original series was truncated, so callers can amend
 * the table caption.
 */
function capDataForTable<T>(
  data: ReadonlyArray<T>,
  maxRows: number,
): { rows: ReadonlyArray<T>; truncated: boolean } {
  if (data.length <= maxRows) return { rows: data, truncated: false };
  return { rows: data.slice(data.length - maxRows), truncated: true };
}

/**
 * Convenience wrapper: caps `data` to `maxRows`, then renders a `ChartDataTable`.
 * The `caption` render-prop receives `(rows, truncated, total)` so each chart
 * can produce its own human-readable description without duplicating the cap logic.
 */
export function ScreenReaderDataTable<T>({
  data,
  columns,
  maxRows = 90,
  caption,
}: {
  data: ReadonlyArray<T>;
  columns: ReadonlyArray<ChartDataTableColumn<T>>;
  maxRows?: number;
  caption: (rows: ReadonlyArray<T>, truncated: boolean, total: number) => string;
}) {
  const { rows, truncated } = capDataForTable(data, maxRows);
  return <ChartDataTable caption={caption(rows, truncated, data.length)} data={rows} columns={columns} />;
}
