import type { ExportPreamble } from "./preamble";
import { formatPreambleCsv } from "./preamble";

export interface CsvColumn<T> {
  header: string;
  accessor: (row: T, index: number) => string | number | null;
}

const FORMULA_LEADING_CHARS = /^[\t\r ]*[=+\-@]/;

function neutralizeSpreadsheetFormula(value: string): string {
  return FORMULA_LEADING_CHARS.test(value) ? `'${value}` : value;
}

export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? neutralizeSpreadsheetFormula(value) : String(value);
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

/** Build the header + escaped data rows shared by both CSV builders. */
function buildCsvBody<T>(data: T[], columns: CsvColumn<T>[]): string[] {
  const header = columns.map((c) => c.header).join(",");
  const rows = data.map((row, rowIndex) =>
    columns.map((c) => escapeCsvField(c.accessor(row, rowIndex))).join(","),
  );
  return [header, ...rows];
}

/**
 * Build the CSV string (header + rows). Pure: no DOM access.
 * Mirrors `downloadCsv` field-escaping rules exactly.
 */
export function buildCsv<T>(data: T[], columns: CsvColumn<T>[]): string {
  return buildCsvBody(data, columns).join("\n");
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
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().split("T")[0]}.csv`;
    // a.click() requires a user-activation context; some browsers silently
    // suppress programmatic clicks, but the URL is still revoked below.
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
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
