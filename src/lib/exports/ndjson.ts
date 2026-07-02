import { formatDatedExportFilename, triggerFileDownload } from "./download";
import type { CsvColumn } from "./csv";
import type { ExportPreamble } from "./preamble";
import { formatPreambleNdjson } from "./preamble";

function cellValue(value: string | number | null): string | number | null {
  if (value === undefined) return null;
  return value;
}

/**
 * Build the NDJSON body. First line is a `{"_meta": ...}` row carrying the
 * preamble; subsequent lines are one JSON object per data row, keyed by the
 * column headers. Pure: no DOM access.
 */
export function buildNdjsonWithPreamble<T>(
  data: T[],
  columns: CsvColumn<T>[],
  preamble: ExportPreamble,
): string {
  const meta = formatPreambleNdjson(preamble);
  const rows = data.map((row, rowIndex) => {
    const obj: Record<string, string | number | null> = {};
    for (const column of columns) {
      obj[column.header] = cellValue(column.accessor(row, rowIndex));
    }
    return JSON.stringify(obj);
  });
  return [meta, ...rows].join("\n");
}

/** Trigger a browser download of the NDJSON. */
export function downloadNdjsonWithPreamble<T>(
  data: T[],
  columns: CsvColumn<T>[],
  filename: string,
  preamble: ExportPreamble,
): void {
  const ndjson = buildNdjsonWithPreamble(data, columns, preamble);
  triggerFileDownload(
    [ndjson],
    "application/x-ndjson;charset=utf-8;",
    formatDatedExportFilename(filename, "ndjson"),
  );
}
