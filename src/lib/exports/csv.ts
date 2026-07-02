import { formatDatedExportFilename, triggerFileDownload } from "./download";
import type { ExportPreamble } from "./preamble";
import { formatPreambleCsv } from "./preamble";
import { buildCsv as buildSharedCsv, buildCsvBody } from "@shared/lib/csv";
import type { CsvColumn } from "@shared/lib/csv";

export type { CsvColumn };
export { escapeCsvField } from "@shared/lib/csv";

/**
 * Build the CSV string (header + rows). Pure: no DOM access.
 * Mirrors `downloadCsv` field-escaping rules exactly.
 */
export function buildCsv<T>(data: T[], columns: CsvColumn<T>[]): string {
  return buildSharedCsv(data, columns);
}

/**
 * Build the CSV body (preamble + header + rows). Pure: no DOM access.
 * Mirrors `src/lib/csv-export.ts` field-escaping rules exactly.
 */
export function buildCsvWithPreamble<T>(
  data: T[],
  columns: CsvColumn<T>[],
  preamble: ExportPreamble,
): string {
  return [formatPreambleCsv(preamble), ...buildCsvBody(data, columns)].join("\n");
}

/**
 * Trigger a browser download of a CSV string. BOM-prefixed so Excel
 * auto-detects UTF-8.
 */
function triggerCsvDownload(csv: string, filename: string): void {
  triggerFileDownload(
    ["﻿" + csv],
    "text/csv;charset=utf-8;",
    formatDatedExportFilename(filename, "csv"),
  );
}

/** Trigger a browser download of the CSV (no preamble). */
export function downloadCsv<T>(data: T[], columns: CsvColumn<T>[], filename: string): void {
  triggerCsvDownload(buildCsv(data, columns), filename);
}

/** Trigger a browser download of the CSV with an "as-of" preamble line. */
export function downloadCsvWithPreamble<T>(
  data: T[],
  columns: CsvColumn<T>[],
  filename: string,
  preamble: ExportPreamble,
): void {
  triggerCsvDownload(buildCsvWithPreamble(data, columns, preamble), filename);
}
