import type { ExportPreamble } from "./preamble";
import { formatPreambleCsv } from "./preamble";

export interface CsvColumn<T> {
  header: string;
  accessor: (row: T, index: number) => string | number | null;
}

function escapeCsvField(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
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
  const preambleLine = formatPreambleCsv(preamble);
  const header = columns.map((c) => c.header).join(",");
  const rows = data.map((row, rowIndex) =>
    columns.map((c) => escapeCsvField(c.accessor(row, rowIndex))).join(","),
  );
  return [preambleLine, header, ...rows].join("\n");
}

/**
 * Trigger a browser download of the CSV. BOM-prefixed so Excel auto-detects
 * UTF-8 (matches the existing `src/lib/csv-export.ts` behavior).
 */
export function downloadCsvWithPreamble<T>(
  data: T[],
  columns: CsvColumn<T>[],
  filename: string,
  preamble: ExportPreamble,
): void {
  const csv = buildCsvWithPreamble(data, columns, preamble);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
