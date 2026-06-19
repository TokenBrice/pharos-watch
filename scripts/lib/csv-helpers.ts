/**
 * Server-safe CSV primitives shared by build-time dataset generators.
 *
 * The canonical browser version (`src/lib/exports/csv.ts`) cannot be imported
 * here because it pulls in DOM download helpers; these mirror only the
 * field-escaping rules and column shape needed by Node scripts so the logic
 * lives in one place instead of being copied per script.
 */

export interface CsvColumn<T> {
  header: string;
  accessor: (row: T) => string | number | null;
}

const SPREADSHEET_FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

function neutralizeSpreadsheetFormula(value: string): string {
  return SPREADSHEET_FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? neutralizeSpreadsheetFormula(value) : String(value);
  return str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}
